/**
 * Inline Lesson Editor — delegated-journey demo plugin
 * ====================================================
 *
 * A sample journey plugin for the **delegated journey** demo. It owns its own UI
 * — a right-click menu over selected lesson text — and demonstrates the
 * plugin-host contract:
 *
 *   • the host gives the plugin a small surface: where the content is
 *     (`host.content.getRoot()`), a way to freeze repaints while editing in
 *     place (`lockRender`/`unlockRender`), and a way to swap the page from
 *     Markdown (`replaceLesson`/`refresh`);
 *   • everything else — the menu, the edits, the animation and persistence — is
 *     the plugin's own responsibility. The host does not build UI and never
 *     writes upstream on the plugin's behalf.
 *
 * It contributes three actions on a text selection:
 *
 *   • Edit text inline        the selected text itself becomes editable, with a
 *                             tiny ✕/✓ pair floating at its corner. Saving
 *                             rewrites the Markdown and persists it.
 *   • Explain selection       mimics an LLM round-trip (a visible "thinking"
 *                             state) and inserts an explanation callout after the
 *                             block. The callout carries its own ✕ so the learner
 *                             can remove it again; both actions persist.
 *   • Summarize selection     mimics an LLM round-trip and replaces the block
 *                             with a shorter summary, then persists.
 *
 * Everything is done **in place**: the plugin mutates the live DOM under the
 * render lock and does not ask the host to repaint. Persisting the new Markdown
 * to the provider is what makes the change survive a refresh.
 *
 * How persistence works: the plugin POSTs the edited Markdown straight to
 * Cupcake's
 *   POST /api/v1/journeys/:id/personalization
 * with the learner's credentials. For a delegated journey Cupcake relays the
 * full Markdown to the *external provider* (this demo server) with the learner's
 * signed identity. The provider stores it in memory and replays it on the next
 * visit — so every change survives a refresh, without Cupcake ever owning the
 * content.
 *
 * This plugin only activates for delegated journeys, because persisting a change
 * upstream is the whole point.
 *
 * ---------------------------------------------------------------------------
 * How to add it
 * ---------------------------------------------------------------------------
 * This is a *marketplace* plugin: a single JavaScript bundle, not a module.
 * Publish it once, then attach it to the delegated journey:
 *
 *   1. In Cupcake, open a journey as an instructor and open the cog → Plugins.
 *   2. Open plugin library → Publish → paste the entire contents of this file as
 *      the "Plugin JavaScript". Set a title such as "Inline Lesson Editor" and
 *      pick a visibility. Submit for review.
 *   3. As a Cupcake admin, approve it under /admin/plugins (Review).
 *   4. Back on the delegated journey, open the plugin library and "Add" it, then
 *      save runtime settings.
 *
 * The bundle must call the global `registerJourneyPlugin(...)` (the host injects
 * it before evaluating the code); that is the one contract it has with Cupcake.
 */
registerJourneyPlugin({
  id: 'inline-lesson-editor',
  name: 'Inline Lesson Editor',
  description:
    'Edit, explain or summarize lesson text inline; changes are persisted to a delegated provider.',
  version: '0.4.0',
  apiVersion: 1,

  // Available everywhere, but only activates where there is an upstream
  // provider to persist to (i.e. delegated journeys).
  alwaysOn: true,
  match: function (context) {
    return context.delegated;
  },

  setup: function (host) {
    return activate(host);
  },
});

/* ------------------------------------------------------------------------- *
 * Tunables — the "LLM" is faked; these keep the flow observable.
 * ------------------------------------------------------------------------- */

var THINK_DURATION = 2600; // ms spent in the visible "thinking" state (slow on purpose)
var COMMIT_DELAY = 500; // ms to let the learner see the result before we persist

/** The single class prefix so every injected node is easy to spot/clean up. */
var NS = 'jie';

/* ------------------------------------------------------------------------- *
 * Activation
 * ------------------------------------------------------------------------- */

function activate(host) {
  var menu = null; // the open context menu, if any
  var editor = null; // the open inline editor, if any
  var lastSelection = null; // { text, block } captured at right-click time
  var busy = false; // true while explain/summarize is mid-flight
  var editing = false; // true while the inline editor is open
  /**
   * Bumped whenever the lesson changes or teardown runs. A slow action captures
   * it on start and re-checks before it persists anything, so an in-flight
   * transformation can never land on the lesson the learner moved to.
   */
  var actionToken = 0;

  /** The lesson path our floating UI was opened against, if any. */
  function openLessonPath() {
    if (editor) return editor.lessonPath;
    if (lastSelection) return lastSelection.lessonPath;
    return null;
  }

  /**
   * The Markdown we currently believe the provider holds. We track it ourselves
   * because the host's `getMarkdown()` always returns the *pristine* lesson: our
   * edits live in the DOM and upstream, not in the host. Re-initialised whenever
   * the lesson changes.
   */
  var state = { lessonPath: null, markdown: '' };

  injectStyles();

  function currentMarkdown() {
    var ctx = host.getContext();
    if (state.lessonPath !== ctx.lessonPath) {
      state.lessonPath = ctx.lessonPath;
      state.markdown = host.content.getMarkdown() || '';
    }
    return state.markdown;
  }

  function closeMenu() {
    if (menu) {
      menu.remove();
      menu = null;
    }
  }

  function closeEditor(commit) {
    if (!editor) return;
    var ed = editor;
    editor = null;
    editing = false;
    ed.toolbar.remove();
    window.removeEventListener('scroll', ed.reposition, true);
    window.removeEventListener('resize', ed.reposition);
    ed.wrap.removeEventListener('input', ed.reposition);
    ed.wrap.removeEventListener('keydown', ed.onKeyDown);

    if (!commit) {
      // Restore exactly what was on screen before the edit began.
      ed.block.innerHTML = ed.originalHtml;
      host.content.unlockRender();
      return;
    }

    var edited = (ed.wrap.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+$/, '');
    unwrap(ed.wrap); // drop the contenteditable wrapper, keep the typed text
    pruneEmptyInline(ed.block); // drop inline elements emptied by the edit
    host.content.unlockRender();

    var trimmed = edited.replace(/^\s+|\s+$/g, '');
    if (!trimmed) {
      ed.block.innerHTML = ed.originalHtml;
      return;
    }
    if (trimmed === ed.originalText.replace(/^\s+|\s+$/g, '')) return; // nothing changed

    var md = currentMarkdown();

    // A table cell is not a Markdown block of its own. Map it structurally,
    // otherwise a short cell value ("3") could match inside an unrelated block.
    if (ed.isCell) {
      var tableBlock = locateTableBlock(md, ed.headerTexts);
      var newBlock =
        tableBlock && replaceTableCell(tableBlock.text, ed.cellIndex, edited);
      if (!tableBlock || newBlock == null) {
        ed.block.innerHTML = ed.originalHtml;
        logFail('edit', 'could not locate the selected table cell in the Markdown');
        return;
      }
      var tableNext = md.slice(0, tableBlock.start) + newBlock + md.slice(tableBlock.end);
      state.markdown = tableNext;
      // Flash the cell so the learner sees the saved value land.
      highlightElement(ed.block, 'edit');
      persist(host, tableNext, 'edit');
      return;
    }

    var located = locateBlock(md, ed.anchorBlock, ed.anchorSelection);
    if (!located) {
      // Roll the DOM back so what is on screen always matches what is stored.
      ed.block.innerHTML = ed.originalHtml;
      logFail('edit', 'could not locate the selected block in the Markdown');
      return;
    }

    var replacement;
    if (ed.wholeBlock) {
      replacement = edited;
    } else {
      replacement = replaceSelectionInSource(
        located.text,
        ed.anchorSelection,
        edited,
        ed.occurrence,
      );
      if (replacement == null) {
        replacement = replaceByNormalizedIndex(
          located.text,
          ed.anchorSelection,
          edited,
          ed.occurrence,
        );
      }
    }
    if (replacement == null) {
      ed.block.innerHTML = ed.originalHtml;
      logFail('edit', 'could not match the selection inside its Markdown block');
      return;
    }

    var next = md.slice(0, located.start) + replacement + md.slice(located.end);
    state.markdown = next;
    // Flash what was just written so the change is visible, then persist.
    highlightText(ed.block, edited, 'edit');
    persist(host, next, 'edit');
  }

  function teardown() {
    actionToken += 1; // abort any in-flight action
    closeMenu();
    closeEditor(false);
    clearFlashes(host.content.getRoot());
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.removeEventListener('mousedown', onDocumentMouseDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('scroll', closeMenu, true);
    host.content.unlockRender();
  }

  function onDocumentMouseDown(event) {
    // Any click outside our own floating UI dismisses it.
    if (menu && !menu.contains(event.target)) closeMenu();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    closeMenu();
    if (editor) closeEditor(false);
  }

  /**
   * Delegated click handler for the ✕ on an explanation callout. Delegation means
   * it keeps working after a lesson repaint without any re-attachment step.
   */
  function onDocumentClick(event) {
    var target = event.target;
    var removeBtn = target && target.closest ? target.closest('.jie-remove') : null;
    if (!removeBtn) return;
    event.preventDefault();
    event.stopPropagation();
    var callout = removeBtn.closest('.jie-explain');
    if (!callout) return;
    removeExplanation(callout);
  }

  function removeExplanation(callout) {
    var id = callout.getAttribute('data-jie') || '';
    var md = currentMarkdown();
    var next = removeExplanationSource(md, id);
    callout.remove();
    state.markdown = next;
    persist(host, next, 'remove-explanation');
  }

  /**
   * Right-click on a text selection inside the lesson body opens our own menu.
   * Event delegation on `document` survives lesson re-renders, so we attach the
   * listener once and resolve the live content root on demand.
   */
  function onContextMenu(event) {
    if (busy) return; // never open mid-transformation
    if (editing) return; // let the native menu handle copy/paste inside the editor
    var root = host.content.getRoot();
    if (!root) return;
    var selection = currentSelection(root);
    if (!selection) return; // no selection, or it is outside the lesson

    event.preventDefault();
    closeMenu();
    clearFlashes(root); // a stale highlight must not become the next selection
    lastSelection = selection;
    lastSelection.lessonPath = host.getContext().lessonPath;

    menu = buildMenu([
      {
        label: 'Edit text inline',
        hint: 'Rewrite the selected text and save it to the provider',
        icon: ICON_EDIT,
        run: function () {
          openEditor(lastSelection);
        },
      },
      {
        label: 'Explain selection',
        hint: 'Add a plain-language explanation below (removable)',
        icon: ICON_EXPLAIN,
        run: function () {
          runWithBusy('explain', lastSelection);
        },
      },
      {
        label: 'Summarize selection',
        hint: 'Replace this block with a shorter summary',
        icon: ICON_SUMMARIZE,
        run: function () {
          runWithBusy('summarize', lastSelection);
        },
      },
    ]);
    document.body.appendChild(menu);
    positionMenu(menu, event.clientX, event.clientY);
  }

  /** Run an explain/summarize action, guaranteeing `busy` is always released. */
  function runWithBusy(mode, selection) {
    if (busy) return;
    busy = true;
    try {
      // runAction always returns a promise, so there is nothing to guard for in
      // the happy path; the try/catch covers a synchronous throw anyway so the
      // menu can never get stuck in the busy state.
      runAction(mode, selection).then(release, release);
    } catch (e) {
      logFail(mode, String((e && e.message) || e));
      release();
    }
    function release() {
      busy = false;
    }
  }

  /* ----------------------------------------------------------------------- *
   * Explain / summarize — shared in-place flow
   * ----------------------------------------------------------------------- */

  function runAction(mode, selection) {
    return new Promise(function (resolve) {
      var block = selection && selection.block;
      if (!block || !block.parentNode) {
        // The captured node may have been detached by an earlier edit; try to
        // find the same text again in the live DOM before giving up.
        block = findLiveBlock(host.content.getRoot(), selection && selection.text);
      }
      if (!block || !block.parentNode) {
        resolve();
        return;
      }

      // A cell is not a block of its own: placing a callout inside a <tr> is
      // invalid HTML and has no Markdown block to map to. Anchor these actions to
      // the whole table so both the DOM and the source stay consistent.
      var owningTable = block.closest ? block.closest('table') : null;
      var tableHeaders = owningTable ? tableHeaderTexts(owningTable) : null;
      if (owningTable) block = owningTable;

      // Capture the live selection now: after the (deliberately slow) thinking
      // state the browser may have collapsed it, and summarize needs to know
      // exactly which run of text it is replacing. Clamp it to the resolved
      // block so a selection that spilled into a neighbouring element is
      // reduced to the part actually inside the target.
      var liveSel = window.getSelection && window.getSelection();
      var liveRange = liveSel && liveSel.rangeCount ? liveSel.getRangeAt(0) : null;
      var clampedLive =
        liveRange && !liveRange.collapsed && liveSel.toString().trim()
          ? clampRangeToBlock(liveRange, block)
          : null;
      var inlineRange =
        clampedLive && clampedLive.toString().trim() ? clampedLive : null;

      // The text these actions operate on: the clamped live selection when there
      // is one, otherwise the block's own text. Never the whole lesson.
      var liveText = clampedLive ? collapse(clampedLive.toString()) : '';
      var actionText = liveText || collapse((selection && selection.text) || block.textContent || '');

      // Which occurrence of the selected text the learner picked, so a repeated
      // token is summarized in place rather than at the first match.
      var occurrence = 0;
      if (inlineRange) {
        var upTo = liveRange.cloneRange();
        upTo.selectNodeContents(block);
        upTo.setEnd(inlineRange.startContainer, inlineRange.startOffset);
        occurrence = countOccurrences(collapse(upTo.toString()), actionText);
      }

      host.content.lockRender();
      var bubble = insertThinking(block, mode === 'explain' ? 'Explaining' : 'Summarizing');
      var token = actionToken;

      wait(THINK_DURATION)
        .then(function () {
          bubble.remove();

          // The learner navigated away while we were "thinking": the lesson on
          // screen is no longer the one this action targeted, so abort instead of
          // painting into (and persisting onto) the wrong lesson.
          if (token !== actionToken) {
            host.content.unlockRender();
            return;
          }

          if (mode === 'explain') {
            var md = currentMarkdown();
            var located = tableHeaders
              ? locateTableBlock(md, tableHeaders)
              : locateBlock(md, block.textContent || '', actionText);
            var id = uniqueId();
            var text = collapse(actionText || block.textContent || '');

            // Flash the selected run so the learner sees what got explained.
            if (inlineRange) highlightRange(inlineRange, 'explain');

            // Paint the callout in place, then persist the Markdown that would
            // reproduce it on the next visit. When the block sits inside a list
            // or blockquote, insert after the whole container so the callout is
            // not nested inside it — matching where the Markdown records it.
            var callout = explainElement(id, text);
            var anchorEl = (block.closest && block.closest('ol, ul, blockquote')) || block;
            anchorEl.parentNode.insertBefore(callout, anchorEl.nextSibling);
            animateIn(callout);

            var source = explainSource(id, text);
            var next = located
              ? md.slice(0, located.end) + '\n\n' + source + md.slice(located.end)
              : md + '\n\n' + source;
            state.markdown = next;
            return wait(COMMIT_DELAY).then(function () {
              host.content.unlockRender();
              if (token !== actionToken) return; // navigated away mid-commit
              persist(host, next, 'explain');
            });
          }

          // Summarize: swap the selected run for a shorter version, in the DOM
          // and in the Markdown, so the two stay in step.
          var summary = summarize(actionText || block.textContent || '');
          var mdd = currentMarkdown();
          var loc = tableHeaders
            ? locateTableBlock(mdd, tableHeaders)
            : locateBlock(mdd, block.textContent || '', actionText);

          if (!loc) {
            logFail('summarize', 'could not locate the selected block in the Markdown');
            return wait(COMMIT_DELAY).then(function () {
              host.content.unlockRender();
            });
          }

          var segment = replaceSelectionInSource(loc.text, actionText, summary, occurrence);
          if (segment == null) {
            segment = replaceByNormalizedIndex(loc.text, actionText, summary, occurrence);
          }
          if (segment == null) {
            // Could not map the selection: leave the block untouched rather than
            // overwriting it wholesale.
            logFail('summarize', 'could not match the selection inside its Markdown block');
            return wait(COMMIT_DELAY).then(function () {
              host.content.unlockRender();
            });
          }

          // The Markdown mapping succeeded, so apply the same change to the DOM,
          // then flash the changed run so the learner sees exactly what moved.
          var resultNode = document.createTextNode(summary);
          if (inlineRange) {
            inlineRange.deleteContents();
            inlineRange.insertNode(resultNode);
          } else {
            block.textContent = '';
            block.appendChild(resultNode);
          }
          animateIn(block);
          var flashRange = document.createRange();
          flashRange.setStartBefore(resultNode);
          flashRange.setEndAfter(resultNode);
          highlightRange(flashRange, 'summarize');

          var newMd = mdd.slice(0, loc.start) + segment + mdd.slice(loc.end);
          state.markdown = newMd;
          return wait(COMMIT_DELAY).then(function () {
            host.content.unlockRender();
            if (token !== actionToken) return; // navigated away during the delay
            persist(host, newMd, 'summarize');
          });
        })
        .catch(function (err) {
          bubble.remove();
          host.content.unlockRender();
          logFail(mode, String((err && err.message) || err));
        })
        .then(resolve);
    });
  }

  /* ----------------------------------------------------------------------- *
   * Inline editor — minimal in-place editing of the selection itself
   * ----------------------------------------------------------------------- */

  function openEditor(selection) {
    if (!selection) return;
    var block = selection.block;
    if (!block || !block.parentNode) {
      block = findLiveBlock(host.content.getRoot(), selection.text);
    }
    if (!block || !block.parentNode) return;

    closeMenu();
    host.content.lockRender();

    var originalHtml = block.innerHTML;
    var originalText = block.textContent || '';

    var sel = window.getSelection && window.getSelection();
    var range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    var target = range && !range.collapsed ? clampRangeToBlock(range, block) : null;
    var targetText = target ? collapse(target.toString()) : '';
    var inline = !!(target && targetText);

    // How many times `targetText` appears in the block before the selection, so a
    // repeated token is mapped to the occurrence the learner actually picked.
    var occurrence = 0;
    if (inline) {
      var upTo = range.cloneRange();
      upTo.selectNodeContents(block);
      upTo.setEnd(target.startContainer, target.startOffset);
      var before = upTo.toString();
      occurrence = countOccurrences(collapse(before), targetText);
    }

    var wrap = document.createElement('span');
    wrap.className = NS + '-inline-edit';
    wrap.setAttribute('contenteditable', 'true');
    wrap.spellcheck = false;

    if (inline) {
      // Wrap the (possibly clamped) selection itself, in place.
      wrap.appendChild(target.extractContents());
      target.insertNode(wrap);
    } else {
      // No live range: edit the whole block instead.
      while (block.firstChild) wrap.appendChild(block.firstChild);
      block.appendChild(wrap);
    }

    var toolbar = buildToolbar();
    document.body.appendChild(toolbar);

    // A table cell needs structural mapping (its short value is ambiguous), so
    // capture where it lives while the DOM is still intact.
    var cell = block.closest ? block.closest('td, th') : null;
    var table = cell ? cell.closest('table') : null;

    var ed = {
      wrap: wrap,
      toolbar: toolbar,
      block: block,
      originalHtml: originalHtml,
      originalText: originalText,
      anchorBlock: collapse(originalText),
      anchorSelection: inline ? targetText : selection.text,
      occurrence: occurrence,
      lessonPath: host.getContext().lessonPath,
      wholeBlock: !inline,
      isCell: !!cell,
      cellIndex: cell && table
        ? Array.prototype.indexOf.call(table.querySelectorAll('td, th'), cell)
        : -1,
      headerTexts: table ? tableHeaderTexts(table) : null,
    };

    ed.reposition = function () {
      var rect = wrap.getBoundingClientRect();
      var top = rect.top - toolbar.offsetHeight - 4;
      if (top < 4) top = rect.bottom + 4;
      var left = rect.right - toolbar.offsetWidth;
      if (left < 4) left = rect.left;
      toolbar.style.top = top + 'px';
      toolbar.style.left = left + 'px';
      toolbar.style.visibility = 'visible';
    };

    ed.onKeyDown = function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        closeEditor(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeEditor(false);
      }
    };

    wrap.addEventListener('keydown', ed.onKeyDown);
    wrap.addEventListener('input', ed.reposition);
    window.addEventListener('scroll', ed.reposition, true);
    window.addEventListener('resize', ed.reposition);
    toolbar.addEventListener('mousedown', function (event) {
      event.preventDefault(); // keep the caret in the editable element
    });
    toolbar.querySelector('.jie-save').addEventListener('click', function () {
      closeEditor(true);
    });
    toolbar.querySelector('.jie-cancel').addEventListener('click', function () {
      closeEditor(false);
    });

    editor = ed;
    editing = true;

    // Focus the field and select everything so typing replaces the selection.
    try {
      var focusRange = document.createRange();
      focusRange.selectNodeContents(wrap);
      sel.removeAllRanges();
      sel.addRange(focusRange);
      wrap.focus();
    } catch (e) {
      wrap.focus();
    }
    // Position now (the wrap is already in the DOM, so layout is measurable) so
    // the toolbar is never left hidden waiting on a frame.
    ed.reposition();
  }

  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('mousedown', onDocumentMouseDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('scroll', closeMenu, true);

  // Leaving a lesson (or a repaint of it) must not leave our floating UI behind
  // or let a slow action land on the wrong lesson. The host fires this with the
  // lesson that just rendered, so compare it with the one we opened on.
  var offLessonRendered = host.on('lesson:rendered', function (payload) {
    var renderedPath = payload && payload.lessonPath;
    var openPath = openLessonPath();
    if (!openPath || !renderedPath || renderedPath === openPath) return;
    // The page has moved on: discard the editor/selection and abort any pending
    // action so it cannot persist onto the lesson now on screen.
    actionToken += 1;
    busy = false;
    if (editor) closeEditor(false);
    closeMenu();
    state.lessonPath = null;
    lastSelection = null;
  });

  host.log('journeyPluginReady', { pluginId: 'inline-lesson-editor' });

  teardown = (function (base) {
    return function () {
      offLessonRendered();
      base();
    };
  })(teardown);
  return teardown;
}

/* ------------------------------------------------------------------------- *
 * Selection capture
 * ------------------------------------------------------------------------- */

/**
 * Block-level elements whose rendered text maps onto a Markdown block.
 * `code` is deliberately excluded: an inline `<code>` belongs to its enclosing
 * paragraph, and a fenced block belongs to its `<pre>`.
 */
var BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre';

/**
 * Resolve the one block element a selection belongs to, always scoped to `root`.
 * The block that *contains the start* of the selection wins (so a selection that
 * runs from a paragraph into a table or code block is treated as the paragraph —
 * the first element type). If the start sits on inter-block whitespace, the first
 * block the range intersects is used. Returns null when nothing inside `root` is
 * actually selected, so chrome outside the lesson is never editable.
 */
function resolveSelectionBlock(root, range) {
  if (!root || !range) return null;

  var startNode = range.startContainer;
  if (startNode && startNode.nodeType === 3 /* TEXT_NODE */) startNode = startNode.parentElement;
  // A transient flash wrapper is not a real block: treat the text inside it as
  // belonging to the enclosing block.
  if (startNode && startNode.classList && startNode.classList.contains('jie-flash')) {
    startNode = startNode.parentElement;
  }
  var startBlock = startNode && startNode.closest ? startNode.closest(BLOCK_SELECTOR) : null;
  if (startBlock && root.contains(startBlock)) return startBlock;

  // The start is not inside a block (e.g. on the whitespace between blocks):
  // fall back to the first block, in document order, that the selection touches.
  var candidates = root.querySelectorAll(BLOCK_SELECTOR);
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (range.intersectsNode(candidates[i])) return candidates[i];
    } catch (e) {
      /* a detached range cannot intersect; keep looking */
    }
  }
  return null;
}

/**
 * Return `range` restricted to `block`: a selection that spans several blocks is
 * clamped to the part that lies inside `block`, so an edit stays within a single
 * Markdown block instead of wrapping (and persisting) several at once.
 */
function clampRangeToBlock(range, block) {
  if (!range) return null;
  if (block.contains(range.startContainer) && block.contains(range.endContainer)) {
    return range;
  }
  var clamped = range.cloneRange();
  if (!block.contains(clamped.startContainer)) clamped.setStart(block, 0);
  if (!block.contains(clamped.endContainer)) {
    clamped.setEnd(block, block.childNodes.length);
  }
  return clamped;
}

/**
 * Resolve the user's current text selection *within the lesson body*, plus the
 * block element that contains it. Returns null when there is no usable selection
 * fully inside `root` — so the plugin can never touch chrome outside the lesson.
 */
function currentSelection(root) {
  var selection = window.getSelection && window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  var text = selection.toString().trim();
  if (!text) return null;

  var range = selection.getRangeAt(0);
  // Both ends must lie inside the lesson. A selection that starts in the lesson
  // but drags out into the surrounding page (sidebar, TOC, header) is rejected
  // rather than silently clamped, which would edit content the user did not
  // intend to touch.
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  // Never edit our own injected chrome (callouts, the thinking chip, the editor).
  // A `.jie-flash` highlight is transparent here: it briefly wraps real lesson
  // text during its animation, so it must not block editing what it covers.
  var startEl = range.startContainer;
  if (startEl && startEl.nodeType === 3) startEl = startEl.parentElement;
  var chrome = startEl && startEl.closest ? startEl.closest('[class^="jie-"], [class*=" jie-"]') : null;
  if (chrome && !chrome.classList.contains('jie-flash')) return null;

  var block = resolveSelectionBlock(root, range);
  if (!block) return null; // nothing inside the lesson is actually selected

  // Never fall back to the container root itself: editing it would wrap the
  // whole lesson. Require a real block, or bail out.
  if (block === root || !block.parentNode) return null;

  return { text: text, block: block };
}

/** Find a live block in `root` whose text contains `text` (post-render relookup). */
function findLiveBlock(root, text) {
  if (!root || !text) return null;
  var candidates = root.querySelectorAll(
    'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre',
  );
  for (var i = 0; i < candidates.length; i++) {
    if ((candidates[i].textContent || '').indexOf(text) !== -1) return candidates[i];
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * In-place animations
 * ------------------------------------------------------------------------- */

/** A slow, pulsing "thinking" chip inserted after the selected block. */
function insertThinking(block, label) {
  var el = document.createElement('div');
  el.className = 'jie-thinking';
  Object.assign(el.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    margin: '8px 0',
    padding: '5px 12px',
    borderRadius: '9999px',
    fontSize: '11px',
    fontWeight: '700',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: '#7c2d12',
    background: '#ffedd5',
    border: '1px solid #fdba74',
  });

  var dots = document.createElement('span');
  dots.textContent = '● ● ●';
  Object.assign(dots.style, { letterSpacing: '2px', color: '#ea580c' });
  var text = document.createElement('span');
  text.textContent = label + '…';

  el.append(dots, text);
  // Anchor past a list/blockquote container (as the callout later does) so the
  // transient bubble is never placed directly inside an <ol>/<blockquote>.
  var anchor = (block.closest && block.closest('ol, ul, blockquote')) || block;
  anchor.parentNode.insertBefore(el, anchor.nextSibling);

  // A slow, looping pulse the learner can actually follow.
  if (typeof dots.animate === 'function') {
    dots.animate([{ opacity: 0.2 }, { opacity: 1 }, { opacity: 0.2 }], {
      duration: 1800,
      iterations: Infinity,
      easing: 'ease-in-out',
    });
    el.animate(
      [
        { transform: 'translateY(-2px)', opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 },
      ],
      { duration: 600, easing: 'ease-out', fill: 'both' },
    );
  }
  return el;
}

/** A slow fade-in for a freshly inserted result. */
function animateIn(el) {
  if (el && typeof el.animate === 'function') {
    el.animate(
      [
        { opacity: 0, transform: 'translateY(-4px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 650, easing: 'ease-out', fill: 'both' },
    );
  }
}

/**
 * Wrap the just-transformed text in a highlight span so the learner can *see*
 * what changed: it flashes a warm sweep, a soft halo, then fades back to plain
 * text. The wrapper is always unwrapped again, so it leaves no trace in the DOM
 * (or in what gets persisted).
 */
function highlightRange(range, tone) {
  if (!range || range.collapsed || typeof document.createElement !== 'function') return null;
  var span = document.createElement('span');
  span.className = 'jie-flash' + (tone === 'edit' ? ' jie-flash-edit' : '');
  try {
    span.appendChild(range.extractContents());
    range.insertNode(span);
  } catch (e) {
    return null; // a selection that cannot be wrapped is simply left alone
  }
  animateFlash(span, tone);
  return span;
}

/** Wrap an element's whole contents in a flash highlight. */
function highlightElement(el, tone) {
  if (!el || !el.parentNode) return null;
  var range = document.createRange();
  range.selectNodeContents(el);
  return highlightRange(range, tone);
}

/** Immediately finish any in-flight highlight so its wrapper never lingers. */
function clearFlashes(root) {
  var scope = root || document;
  var spans = scope.querySelectorAll ? scope.querySelectorAll('.jie-flash') : [];
  for (var i = 0; i < spans.length; i++) {
    if (spans[i].parentNode) unwrap(spans[i]);
  }
}

/** Flash the first run of `text` found inside `root` (falls back to the element). */
function highlightText(root, text, tone) {  var needle = String(text == null ? '' : text);
  if (!root || !needle) return highlightElement(root, tone);
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  var node = walker.nextNode();
  while (node) {
    var at = node.nodeValue.indexOf(needle);
    if (at !== -1) {
      var range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      return highlightRange(range, tone);
    }
    node = walker.nextNode();
  }
  return highlightElement(root, tone);
}

/**
 * Play the flash animation on `span`, then unwrap it. The Web Animations API is
 * preferred; a CSS class fallback keeps it working where `animate` is missing.
 */
function animateFlash(span, tone) {
  var duration = tone === 'edit' ? 1000 : 1150;
  var done = function () {
    if (span && span.parentNode) unwrap(span);
  };
  if (typeof span.animate !== 'function') {
    // CSS keyframes (see injectStyles) provide the visual; clean up after them.
    setTimeout(done, duration);
    return;
  }
  try {
    var anim = span.animate(
      [
        { backgroundColor: 'rgba(250,204,21,.55)', boxShadow: '0 0 0 2px rgba(250,204,21,.55)' },
        { backgroundColor: 'rgba(250,204,21,.30)', boxShadow: '0 0 0 6px rgba(250,204,21,.18)', offset: 0.4 },
        { backgroundColor: 'rgba(250,204,21,0)', boxShadow: '0 0 0 0 rgba(250,204,21,0)' },
      ],
      { duration: duration, easing: 'ease-out', fill: 'both' },
    );
    if (anim && typeof anim.finished === 'object' && typeof anim.finished.then === 'function') {
      anim.finished.then(done, done);
    } else {
      setTimeout(done, duration);
    }
  } catch (e) {
    done();
  }
}

/* ------------------------------------------------------------------------- *
 * "LLM" stand-ins (no network: deterministic, illustrative text)
 * ------------------------------------------------------------------------- */

function summarize(text) {
  var clean = collapse(stripMarkdown(text));
  var words = clean.split(' ').filter(Boolean);
  var summary = words.slice(0, 14).join(' ');
  if (words.length > 14) summary += '…';
  return summary || clean;
}

function collapse(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function uniqueId() {
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Remove inline formatting elements whose text was fully replaced away. */
function pruneEmptyInline(root) {
  if (!root || !root.querySelectorAll) return;
  var empties = root.querySelectorAll('code, strong, em, b, i, del, s');
  for (var i = 0; i < empties.length; i++) {
    var el = empties[i];
    if (!(el.textContent || '').trim() && !el.querySelector('img')) el.remove();
  }
}

/* ------------------------------------------------------------------------- *
 * Explanation callouts (stored as raw HTML so they survive a reload)
 * ------------------------------------------------------------------------- */

var REMOVE_BTN_HTML =
  '<button class="jie-remove" type="button" title="Remove explanation" ' +
  'aria-label="Remove explanation">' +
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="3" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M6 6l12 12"></path><path d="M18 6L6 18"></path></svg></button>';

/**
 * The persisted source of an explanation. It is a single raw-HTML line so it maps
 * 1:1 to a Markdown "block": easy to locate, insert and remove without touching
 * neighbouring content. The `data-jie` id gives removal an exact target.
 */
function explainSource(id, text) {
  return (
    '<aside class="jie-explain" data-jie="' +
    id +
    '"><strong>Explanation.</strong> ' +
    escapeHtml(collapse(text)) +
    ' ' +
    REMOVE_BTN_HTML +
    '</aside>'
  );
}

/** The same callout as a live DOM node, for the in-place preview. */
function explainElement(id, text) {
  var el = document.createElement('aside');
  el.className = 'jie-explain';
  el.setAttribute('data-jie', id);
  el.innerHTML =
    '<strong>Explanation.</strong> ' + escapeHtml(collapse(text)) + ' ' + REMOVE_BTN_HTML;
  return el;
}

/** Drop the callout with `id` (its whole line) from the Markdown. */
function removeExplanationSource(markdown, id) {
  if (!markdown || !id) return markdown;
  var token = 'data-jie="' + id + '"';
  var lines = markdown.split('\n');
  var kept = lines.filter(function (line) {
    return line.indexOf(token) === -1;
  });
  if (kept.length === lines.length) return markdown;
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

/* ------------------------------------------------------------------------- *
 * Markdown helpers — locate a rendered block inside its source, then patch it
 * ------------------------------------------------------------------------- */

/** Split Markdown into blank-line separated blocks, remembering source offsets. */
function splitMarkdownBlocks(markdown) {
  var blocks = [];
  var lines = String(markdown || '').split('\n');
  var fence = false;
  var pos = 0;
  var current = [];
  var start = 0;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var lineLength = line.length + 1; // include the newline we split on
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;

    if (!fence && line.trim() === '') {
      if (current.length) {
        var text = current.join('\n');
        blocks.push({ start: start, end: start + text.length, text: text });
        current = [];
      }
      start = pos + lineLength;
    } else {
      if (!current.length) start = pos;
      current.push(line);
    }
    pos += lineLength;
  }
  if (current.length) {
    var tail = current.join('\n');
    blocks.push({ start: start, end: start + tail.length, text: tail });
  }
  return blocks;
}

/** Strip the Markdown syntax a browser would not render as text. */
function stripMarkdown(text) {
  var s = String(text == null ? '' : text);
  // Keep the *contents* of fenced code: a code block is a real block of the
  // lesson, and dropping it entirely would make its Markdown impossible to
  // locate (so an edit inside a code block could never be mapped back).
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1');
  s = s.replace(/~~~[^\n]*\n?([\s\S]*?)~~~/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '');
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1');
  s = s.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '$1');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  return s;
}

/** Case- and whitespace-insensitive key used to compare DOM text with Markdown. */
function looseKey(text) {
  return collapse(stripMarkdown(text)).toLowerCase();
}

/**
 * Find the Markdown block that produced `blockText`. Falls back to matching the
 * user's selection when the block itself cannot be matched verbatim (common when
 * the block contains inline formatting the DOM stripped away).
 */
function locateBlock(markdown, blockText, selectionText) {
  var blocks = splitMarkdownBlocks(markdown);
  if (!blocks.length) return null;

  var blockKey = looseKey(blockText);
  var selectionKey = looseKey(selectionText);

  if (blockKey) {
    var exact = blocks.filter(function (b) {
      return looseKey(b.text) === blockKey;
    });
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      if (selectionKey) {
        var withSelection = exact.filter(function (b) {
          return looseKey(b.text).indexOf(selectionKey) !== -1;
        });
        if (withSelection.length === 1) return withSelection[0];
      }
      return closestByLength(exact, blockKey);
    }
  }

  if (selectionKey) {
    var containing = blocks.filter(function (b) {
      return looseKey(b.text).indexOf(selectionKey) !== -1;
    });
    if (containing.length === 1) return containing[0];
    if (containing.length > 1) return closestByLength(containing, selectionKey);
  }

  if (blockKey && blockKey.length >= 8) {
    var prefix = blockKey.slice(0, 40);
    var byPrefix = blocks.filter(function (b) {
      return looseKey(b.text).indexOf(prefix) === 0;
    });
    if (byPrefix.length === 1) return byPrefix[0];
  }
  return null;
}

function closestByLength(blocks, key) {
  var best = blocks[0];
  var bestDiff = Infinity;
  for (var i = 0; i < blocks.length; i++) {
    var diff = Math.abs(looseKey(blocks[i].text).length - key.length);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = blocks[i];
    }
  }
  return best;
}

/** Replace the selection verbatim, tolerating collapsed runs of whitespace. */
function replaceSelectionInSource(source, selectionText, replacement, occurrence) {
  if (!selectionText) return null;
  // `occurrence` is 0-based (0 = the first match); the helpers below are 1-based.
  var nth = (occurrence || 0) + 1;
  var index = source.indexOf(selectionText);
  if (index !== -1) {
    // Honor the occurrence the learner actually selected so a repeated token
    // ("numbers" twice in a snippet) is edited in place, not the first match.
    var useIndex = nthIndexOf(source, selectionText, nth);
    if (useIndex === -1) return null;
    return source.slice(0, useIndex) + replacement + source.slice(useIndex + selectionText.length);
  }
  try {
    var pattern = new RegExp(escapeRegExp(selectionText).replace(/\s+/g, '\\s+'), 'g');
    var match = nthMatch(pattern, source, nth);
    if (match) {
      return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
    }
  } catch (e) {
    /* fall through */
  }
  return null;
}

/** Index of the `nth` (1-based) literal occurrence of `needle`, or -1. */
function nthIndexOf(haystack, needle, nth) {
  var from = 0;
  var found = -1;
  for (var i = 0; i < nth; i++) {
    found = haystack.indexOf(needle, from);
    if (found === -1) return -1;
    from = found + 1;
  }
  return found;
}

/** The `nth` (1-based) match of a global regex, or null. */
function nthMatch(pattern, text, nth) {
  pattern.lastIndex = 0;
  var match = null;
  for (var i = 0; i < nth; i++) {
    match = pattern.exec(text);
    if (!match) return null;
  }
  return match;
}

/** How many times `needle` occurs in `haystack` (non-overlapping). */
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  var count = 0;
  var from = 0;
  var found = haystack.indexOf(needle, from);
  while (found !== -1) {
    count += 1;
    from = found + needle.length;
    found = haystack.indexOf(needle, from);
  }
  return count;
}

/** Markdown tokens skipped (whole) by the loose view; group 1–3 keep inner text. */
var LOOSE_TOKEN = new RegExp(
  [
    '(```|~~~)[^\\n]*\\n?([\\s\\S]*?)\\1', // fenced code → its contents
    '`([^`]*)`', // `code` → inner text
    '!\\[([^\\]]*)\\]\\([^)]*\\)', // ![alt](src) → alt
    '\\[([^\\]]+)\\]\\([^)]*\\)', // [text](href) → text
    '<\\/?[a-zA-Z][^>]*>', // raw html → dropped
    '^\\s{0,3}#{1,6}\\s+', // heading marker
    '^\\s{0,3}>\\s?', // blockquote marker
    '^\\s{0,3}(?:[-*+]|\\d+\\.)\\s+', // list marker
    '(\\*\\*|__|~~)', // strong / strikethrough marker
    '(?<![\\w*])\\*(?=\\S)', // single-* emphasis opener
    '(?<=\\S)\\*(?![\\w*])', // single-* emphasis closer
    '(?<![\\w_])_(?=\\S)', // single-_ emphasis opener (so my_var stays literal)
    '(?<=\\S)_(?![\\w_])', // single-_ emphasis closer
  ].join('|'),
  'gm',
);

/**
 * Build a lower-cased, whitespace-collapsed view of the source containing only
 * the characters a browser would render as text, plus a map from each view index
 * back to its index in the source. Formatting markers (`**`, backticks, link
 * syntax, tags…) are skipped, so a selection that *spans* inline markup still
 * matches — while a replacement written through the map preserves the original
 * surrounding syntax.
 */
function buildLooseView(source) {
  var view = '';
  var map = [];

  function push(ch, index) {
    if (/\s/.test(ch)) {
      if (!view || view.charAt(view.length - 1) === ' ') return;
      view += ' ';
      map.push(index);
      return;
    }
    view += ch.toLowerCase();
    map.push(index);
  }

  var last = 0;
  var m;
  LOOSE_TOKEN.lastIndex = 0;
  while ((m = LOOSE_TOKEN.exec(source)) !== null) {
    if (m[0] === '') {
      LOOSE_TOKEN.lastIndex += 1;
      continue;
    }
    for (var i = last; i < m.index; i++) push(source.charAt(i), i);
    // Group 2/3/4/5 hold the visible text of a fence, inline code, image alt and
    // link label respectively; the other alternatives contribute nothing.
    var visible =
      m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : null;
    if (visible) {
      var at = m[0].indexOf(visible);
      for (var j = 0; j < visible.length; j++) push(visible.charAt(j), m.index + at + j);
    }
    last = LOOSE_TOKEN.lastIndex;
  }
  for (var k = last; k < source.length; k++) push(source.charAt(k), k);

  return { view: view, map: map };
}

/**
 * Map the selection onto the source ignoring formatting markers and whitespace:
 * find the stripped selection in the loose view, then splice the replacement in
 * at the mapped *visible* positions. Only the characters the learner could see
 * are removed, so any Markdown markers that bound the matched runs survive — a
 * selection crossing `**bold**` and plain text yields `**new text**` rather than
 * an orphaned, unbalanced `**`.
 */
function replaceByNormalizedIndex(source, selectionText, replacement, occurrence) {
  var key = looseKey(selectionText);
  if (!key) return null;

  var loose = buildLooseView(source);
  var at = loose.view.indexOf(key, 0);
  // Walk to the occurrence the learner actually selected; otherwise a repeated
  // token would be replaced at its first match while the DOM changed another.
  var nth = Math.max(0, occurrence || 0);
  for (var s = 0; s < nth && at !== -1; s++) {
    at = loose.view.indexOf(key, at + 1);
  }
  if (at === -1) return null;

  var anchor = loose.map[at];
  if (anchor == null) return null;

  var kill = {};
  for (var k = 0; k < key.length; k++) {
    var idx = loose.map[at + k];
    if (idx == null) return null;
    kill[idx] = true;
  }

  var out = '';
  for (var i = 0; i < source.length; i++) {
    if (i === anchor) out += replacement;
    if (kill[i]) continue;
    out += source.charAt(i);
  }
  return rebalanceInline(out);
}

/**
 * Keep inline markup balanced after a splice. Replacing text that *crosses* an
 * inline span (``with `type()` ``) can strip the span's inner text while leaving
 * a delimiter behind, e.g. `` using type()` ``. Empty code spans are dropped,
 * and if the text is left holding an odd number of backticks we remove the lone
 * one (the character with a non-word neighbour) so the source stays renderable.
 */
function rebalanceInline(text) {
  var s = String(text == null ? '' : text);
  s = s.replace(/`\s*`/g, ''); // an emptied inline-code span
  var ticks = (s.match(/`/g) || []).length;
  if (ticks % 2 === 1) {
    var idx = -1;
    for (var i = 0; i < s.length; i++) {
      if (s.charAt(i) !== '`') continue;
      var prev = i > 0 ? s.charAt(i - 1) : ' ';
      var next = i + 1 < s.length ? s.charAt(i + 1) : ' ';
      if (!/\w/.test(prev) || !/\w/.test(next)) {
        idx = i;
        break;
      }
    }
    if (idx === -1) idx = s.indexOf('`');
    if (idx !== -1) s = s.slice(0, idx) + s.slice(idx + 1);
  }
  return s;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------------- *
 * Tables — a cell is not a Markdown block, so it needs its own mapping
 * ------------------------------------------------------------------------- */

/** Split a Markdown table row into its raw cell strings, or null if not a row. */
function tableRowCells(line) {
  var t = String(line || '').trim();
  if (t.indexOf('|') === -1) return null;
  var parts = t.split('|');
  if (parts.length && parts[0].trim() === '') parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
  return parts;
}

/** True for the `| --- | --- |` alignment row between header and body. */
function isSeparatorRow(cells) {
  if (!cells || !cells.length) return false;
  return cells.every(function (c) {
    return /^[\s:|-]*$/.test(c) && c.indexOf('-') !== -1;
  });
}

/** The rendered column headers of a table, used to find its Markdown. */
function tableHeaderTexts(table) {
  var firstRow = table && table.rows && table.rows[0];
  if (!firstRow) return [];
  return Array.prototype.map.call(firstRow.cells, function (c) {
    return c.textContent || '';
  });
}

/** Locate the Markdown block whose header row matches `headerTexts`. */
function locateTableBlock(markdown, headerTexts) {
  if (!headerTexts || !headerTexts.length) return null;
  var want = headerTexts.map(looseKey);
  var blocks = splitMarkdownBlocks(markdown);
  for (var i = 0; i < blocks.length; i++) {
    var lines = blocks[i].text.split('\n');
    if (lines.length < 2) continue;
    var row0 = tableRowCells(lines[0]);
    var row1 = tableRowCells(lines[1]);
    if (!row0 || !row1 || !isSeparatorRow(row1)) continue;
    if (row0.length !== want.length) continue;
    var matches = true;
    for (var c = 0; c < want.length; c++) {
      if (looseKey(row0[c]) !== want[c]) {
        matches = false;
        break;
      }
    }
    if (matches) return blocks[i];
  }
  return null;
}

/**
 * Replace the content of the `cellIndex`-th cell (counting header + body cells
 * in document order) inside a Markdown table block.
 */
function replaceTableCell(blockText, cellIndex, replacement) {
  var lines = blockText.split('\n');
  var count = 0;
  for (var i = 0; i < lines.length; i++) {
    var cells = tableRowCells(lines[i]);
    if (!cells || isSeparatorRow(cells)) continue;
    for (var c = 0; c < cells.length; c++) {
      if (count === cellIndex) {
        cells[c] = ' ' + replacement + ' ';
        lines[i] = '|' + cells.join('|') + '|';
        return lines.join('\n');
      }
      count += 1;
    }
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Commit + persist (plugin-owned)
 * ------------------------------------------------------------------------- */

function persist(host, markdown, action) {
  var context = host.getContext();
  if (!context.journeyId || !context.lessonPath) return Promise.resolve();

  var headers = { 'Content-Type': 'application/json' };
  var guestId = readGuestId();
  if (guestId) headers['X-Guest-Id'] = guestId;

  return fetch(
    context.apiBase +
      '/api/v1/journeys/' +
      encodeURIComponent(context.journeyId) +
      '/personalization',
    {
      method: 'POST',
      credentials: 'include',
      headers: headers,
      body: JSON.stringify({
        lessonPath: context.lessonPath,
        pluginId: 'inline-lesson-editor',
        description: 'inline ' + action,
        markdown: markdown,
      }),
    },
  )
    .then(function (res) {
      host.log('journeyPluginPersisted', {
        pluginId: 'inline-lesson-editor',
        action: action,
        ok: res.ok,
        status: res.status,
      });
    })
    .catch(function (err) {
      host.log('journeyPluginPersistFailed', {
        pluginId: 'inline-lesson-editor',
        action: action,
        error: String((err && err.message) || err),
      });
    });
}

/** The learner's guest id, matching what Cupcake's own requests attach. */
function readGuestId() {
  try {
    return localStorage.getItem('cupcake.guestId') || '';
  } catch (e) {
    return '';
  }
}

/* ------------------------------------------------------------------------- *
 * Context menu (plugin-owned UI)
 * ------------------------------------------------------------------------- */

function buildMenu(items) {
  var menu = document.createElement('div');
  menu.className = 'jie-menu';
  Object.assign(menu.style, {
    position: 'fixed',
    zIndex: '60',
    minWidth: '240px',
    padding: '4px',
    borderRadius: '10px',
    border: '1px solid #e5e7eb',
    background: '#fff',
    boxShadow: '0 20px 45px -20px rgba(15,23,42,0.45)',
  });

  items.forEach(function (item) {
    var row = document.createElement('button');
    row.type = 'button';
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      padding: '7px 8px',
      borderRadius: '7px',
      border: 'none',
      background: 'transparent',
      textAlign: 'left',
      cursor: 'pointer',
      fontSize: '12.5px',
      color: '#1f2937',
    });
    row.addEventListener('mouseenter', function () {
      row.style.background = '#fef2f2';
    });
    row.addEventListener('mouseleave', function () {
      row.style.background = 'transparent';
    });

    var icon = document.createElement('span');
    icon.innerHTML = item.icon || '';
    Object.assign(icon.style, { display: 'inline-flex', color: '#dc2626', flex: '0 0 auto' });

    var text = document.createElement('span');
    text.textContent = item.label;
    Object.assign(text.style, { display: 'flex', flexDirection: 'column', gap: '1px' });
    if (item.hint) {
      var hint = document.createElement('span');
      hint.textContent = item.hint;
      Object.assign(hint.style, { fontSize: '10.5px', color: '#6b7280' });
      text.appendChild(hint);
    }

    row.append(icon, text);
    row.addEventListener('click', function () {
      menu.remove();
      item.run();
    });
    menu.appendChild(row);
  });

  return menu;
}

function positionMenu(menu, x, y) {
  // Keep the menu on-screen: flip near the viewport edges.
  var rect = menu.getBoundingClientRect();
  var left = Math.min(x, window.innerWidth - rect.width - 8);
  var top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, top) + 'px';
}

/* ------------------------------------------------------------------------- *
 * Inline editor toolbar
 * ------------------------------------------------------------------------- */

function buildToolbar() {
  var bar = document.createElement('div');
  bar.className = 'jie-toolbar';
  bar.style.visibility = 'hidden'; // positioned before it is shown
  bar.innerHTML =
    '<button class="jie-cancel" type="button" title="Cancel (Esc)" aria-label="Cancel edit">' +
    ICON_CANCEL +
    '</button>' +
    '<button class="jie-save" type="button" title="Save (Enter)" aria-label="Save edit">' +
    ICON_SAVE +
    '</button>';
  return bar;
}

/** Replace an element with its children, dropping the wrapper itself. */
function unwrap(el) {
  var parent = el && el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/* ------------------------------------------------------------------------- *
 * Styles (injected once; also styles callouts rendered from persisted Markdown)
 * ------------------------------------------------------------------------- */

function injectStyles() {
  if (document.getElementById('jie-plugin-styles')) return;
  var style = document.createElement('style');
  style.id = 'jie-plugin-styles';
  style.textContent = [
    '.jie-explain{position:relative;margin:10px 0;padding:8px 32px 8px 12px;',
    'border-left:3px solid #dc2626;background:rgba(220,38,38,.06);border-radius:8px;',
    'font-size:12.5px;line-height:1.55;animation:jie-pop .55s ease-out both}',
    '.dark .jie-explain{background:rgba(220,38,38,.14);color:#e5e7eb}',
    '.jie-remove{position:absolute;top:4px;right:6px;width:18px;height:18px;display:flex;',
    'align-items:center;justify-content:center;border:1px solid transparent;border-radius:6px;',
    'background:transparent;color:#9ca3af;cursor:pointer;padding:0}',
    '.jie-remove:hover{background:rgba(220,38,38,.12);color:#dc2626}',
    '.jie-inline-edit{outline:2px solid #fca5a5;outline-offset:1px;border-radius:3px;',
    'background:rgba(220,38,38,.05);caret-color:#dc2626}',
    '.jie-toolbar{position:fixed;z-index:80;display:flex;gap:2px;padding:2px;background:#fff;',
    'border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 8px 22px -10px rgba(15,23,42,.45)}',
    '.dark .jie-toolbar{background:#1f2937;border-color:#374151}',
    '.jie-toolbar button{width:22px;height:22px;display:flex;align-items:center;',
    'justify-content:center;border:none;border-radius:6px;background:transparent;cursor:pointer;padding:0}',
    '.jie-toolbar .jie-save{color:#16a34a}',
    '.jie-toolbar .jie-save:hover{background:rgba(22,163,74,.14)}',
    '.jie-toolbar .jie-cancel{color:#dc2626}',
    '.jie-toolbar .jie-cancel:hover{background:rgba(220,38,38,.14)}',
    // Highlight that flashes the just-changed text, then fades away.
    '.jie-flash{border-radius:3px;animation:jie-flash 1.15s ease-out both}',
    '.jie-flash-edit{animation-duration:1s}',
    '@keyframes jie-pop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}',
    '@keyframes jie-flash{0%{background-color:rgba(250,204,21,.55);box-shadow:0 0 0 2px rgba(250,204,21,.55)}',
    '40%{background-color:rgba(250,204,21,.3);box-shadow:0 0 0 6px rgba(250,204,21,.18)}',
    '100%{background-color:rgba(250,204,21,0);box-shadow:0 0 0 0 rgba(250,204,21,0)}}',
  ].join('');
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------------- *
 * Misc
 * ------------------------------------------------------------------------- */

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function logFail(action, message) {
  try {
    console.warn('[inline-lesson-editor] ' + action + ': ' + message);
  } catch (e) {
    /* ignore */
  }
}

var ICON_CANCEL =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="3" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M6 6l12 12"></path><path d="M18 6L6 18"></path></svg>';

var ICON_SAVE =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M20 6L9 17l-5-5"></path></svg>';

var ICON_EDIT =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';

var ICON_EXPLAIN =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';

var ICON_SUMMARIZE =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 6h16M4 12h16M4 18h10"/></svg>';
