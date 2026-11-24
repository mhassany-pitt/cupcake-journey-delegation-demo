# Cupcake Delegated Journey — Demo Provider

A tiny, dependency-free Python server that acts as a **3rd-party content provider**
for a Cupcake *delegated journey*. Point a delegated journey at it and Cupcake
will forward every content, asset and consent request here, signed with a
short-lived HS256 identity assertion.

The point of the demo is to show that the journey is **not stored in Cupcake**:
the table of contents and several lessons are assembled per learner, at request
time, from the identity Cupcake asserts.

```
Cupcake (auth + progress)  ──signed assertion──▶  this provider (content)
        ▲                                                │
        └──────────────── markdown / media ──────────────┘
```

## What's in the box

| File | Purpose |
| --- | --- |
| `app.py` | The HTTP provider: routing, assertion verification, logging. |
| `content.py` | The content pack: static lessons + the generators for dynamic ones. |
| `selftest.py` | Signs real assertions and exercises every route in the contract. |
| `inline-lesson-editor.plugin.js` | The companion journey plugin bundle (publish + add manually). |

No `pip install` needed — everything runs on the standard library.

## Quick start

```bash
cd cupcake-journey-delegation-demo

# 1. Start the provider (choose your own shared secret)
CUPCAKE_SHARED_SECRET='a-very-long-shared-secret-value' python3 app.py --port 8099
```

Cupcake refuses `http:` and private/loopback addresses for provider URLs **in
production**. In development it relaxes the loopback rule (see
`docs/delegated-journeys.md` → *Testing a provider locally*), so you can point a
journey straight at `http://localhost:8099` with no tunnel.

If your Cupcake API is running with `NODE_ENV=production` (or you want to test
through an HTTPS origin), use a tunnel instead. `cloudflared` is handy:

```bash
cloudflared tunnel --url http://localhost:8099
# -> prints something like https://random-words-1234.trycloudflare.com
```

Then, in the Cupcake web app as an instructor, **Add Journey → External
provider** and enter:

| Field | Value |
| --- | --- |
| Provider base URL | `http://localhost:8099` in dev, or the `https://…trycloudflare.com` URL |
| Shared secret | the same value as `CUPCAKE_SHARED_SECRET` |
| Title / description | anything, or leave blank |
| Timeout (ms) | `10000` |
| Allow guests | on, so signed-out visitors still get content |

Cupcake probes the provider before creating the journey. If the probe fails,
check the provider's console — it logs the reason (missing assertion, bad
signature, wrong journey, expired).

Alternatively, seed directly from the API repo:

```bash
cd ../api
node scripts/seed-delegated-journey.mjs \
  --slug live-python \
  --provider https://random-words-1234.trycloudflare.com \
  --secret 'a-very-long-shared-secret-value' \
  --owner you@example.com \
  --title 'Live Personalized Python'
```

## The provider contract

| Cupcake requests upstream | This server serves |
| --- | --- |
| `GET {base}/api/v1/journeys/<id>` | journey root + table of contents |
| `GET {base}/api/v1/journeys/<id>/<section>` | one lesson as Markdown |
| `GET {base}/api/v1/journeys/<id>/consent` | consent configuration |
| `POST {base}/api/v1/journeys/<id>/consent` | a recorded consent decision |
| `POST {base}/api/v1/journeys/<id>/personalization` | a plugin's edit to a lesson (stored in memory) |
| `GET {base}/api/v1/journeys/<id>/personalization` | *demo extra:* which lessons this learner edited |
| `GET {base}/journeys/<id>/<asset>` | media bytes |

Every request carries:

```
Authorization: Bearer <HS256 assertion>
X-Cupcake-Journey: <journeyId>
```

The provider verifies the signature with the shared secret, checks `exp` and
`aud`, and then reads `sub`, `role`, `guestId`, `email` and `name`.

Response shapes (enforced by the smoke test):

- **Root** — `{ path, title, description, author, files[] }`. Each `files[]` node
  must carry `name`, `cleanName`, `title`, `isDirectory`, `isFile` and
  `isMarkdown`; directories nest a child `files[]`. Cupcake overwrites `id`,
  `status`, `visibility`, `ownerName` and runtime fields.
- **Section** — `{ name, isFile: true, content }` where `content` is Markdown.
- **Consent** — `{ hasConsent, title?, markdown?, options[], requirements[] }`
  with `options[].telemetry` and `requirements[].required` as booleans.
- **Asset** — raw bytes with a permitted `Content-Type` (`image/*`, `audio/*`,
  `video/*`, `font/*`, or a small inert allowlist).

## What is dynamic vs. static

The demo deliberately mixes both so you can see the difference:

| Lesson | Behaviour |
| --- | --- |
| `00-index.md` | static |
| `basics/variables.md` | static |
| `basics/loops.md` | static |
| `basics/functions.md` | static |
| `about.md` | static |
| `personalized/your-goals.md` | **dynamic** — greeting, role, level and a learning plan chosen from the learner's asserted identity |
| `personalized/recommendation.md` | **dynamic** — picks a code snippet from a per-learner seed |
| `personalized/progress.md` | **dynamic** — renders a progress card from the `?done=` query parameter |

The table of contents itself is dynamic too: the `personalized` directory title
addresses the learner by name, so signing in as a different user changes the
sidebar.

Cupcake forwards query strings unchanged, so the provider can read
personalization parameters:

```
…/personalized/recommendation?goal=web
…/personalized/recommendation?goal=data&level=advanced
…/personalized/progress?done=4
```

## Plugin personalization (edits that survive a refresh)

The demo also shows the *plugin* half of the delegation story. The bundle in
[`inline-lesson-editor.plugin.js`](./inline-lesson-editor.plugin.js) is a
right-click menu over selected lesson text with three actions:

| Action | What it does |
| --- | --- |
| **Edit text inline** | Turns the selected text *itself* into an editable field with a tiny ✕/✓ pair at its corner. ✓ (or Enter) rewrites that run in the Markdown and persists it; ✕ (or Esc) restores it. Works for paragraphs, headings, list items, blockquotes, code blocks and table cells. |
| **Explain selection** | Mimics an LLM round-trip (a visible "thinking" state) and inserts an explanation callout after the block. The callout carries its own ✕ so the learner can remove it again. |
| **Summarize selection** | Mimics an LLM round-trip and swaps the selected run for a short summary. |

Two rules keep those actions predictable:

- **Only the first element type.** If a selection runs from a paragraph into the
  next code block or table, the action applies to the *paragraph* — the block the
  selection starts in — and never spans element types. (A table cell or list item
  is anchored to its whole table/list so the callout is not nested where Markdown
  cannot express it.)
- **Only inside the lesson.** A selection that reaches outside the lesson body
  (sidebar, table of contents, header) is ignored, and the lesson's own
  container is never used as an edit target, so a stray drag can't rewrite the
  whole page.

Everything happens `in place`: the plugin mutates the live page under the render
lock and never asks the host to repaint. The explanation is stored as a single
raw-HTML line in the Markdown, so removing it (via its ✕) is an exact edit rather
than a re-render. When the plugin saves, Cupcake forwards the edited Markdown
here:

```
POST /api/v1/journeys/<id>/personalization
{ "lessonPath": "basics/variables", "markdown": "# …", "pluginId": "inline-lesson-editor" }
```

Unlike a bundled plugin, this one is **not** shipped inside Cupcake. It is a
marketplace plugin: a single JavaScript bundle that is uploaded once and added to
a journey manually. To wire it up:

1. Start Cupcake and the provider (see *Quick start* above).
2. As an instructor, open the delegated journey → cog → **Plugins** → **Open
   plugin library** → **Publish**, and paste the whole contents of
   `inline-lesson-editor.plugin.js` into the *Plugin JavaScript* box. Give it a
   title (e.g. "Inline Lesson Editor") and submit for review.
3. As a Cupcake admin, approve it under **Review** on `/admin/plugins` (the
   standalone admin page).
4. Back on the delegated journey, **Add** the plugin and save the runtime
   settings. It activates only when `context.delegated` is true, so it stays
   dormant on every other journey.

The provider keeps those edits **in memory**, keyed by learner and lesson, and
serves the edited Markdown on the learner's next visit — so a browser refresh
shows the change. Edits are isolated per learner, and `?reset=1` on a section
drops the stored edit and serves the pristine page.

`GET /api/v1/journeys/<id>/personalization` (a demo extra, not part of the
contract) lists what has been stored for the current learner, which is handy
while exploring. Nothing is persisted to disk: restart the provider and the
edits are gone.

## CLI options

| Flag | Env var | Default | Notes |
| --- | --- | --- | --- |
| `--host` | `HOST` | `127.0.0.1` | |
| `--port` | `PORT` | `8099` | |
| `--secret` | `CUPCAKE_SHARED_SECRET` | *(empty)* | Required to verify assertions. |
| `--journey-id` | `JOURNEY_ID` | *(empty)* | Optional. When set, requests for any other journey id are rejected. Leave empty when creating the journey through the instructor UI, because Cupcake generates the id. |
| `--allow-unsigned` | `ALLOW_UNSIGNED` | off | **Debug only.** Serves content without verifying an assertion. |
| `--log-level` | `LOG_LEVEL` | `INFO` | |

## Verifying it works

```bash
python3 selftest.py
```

This starts the provider on an ephemeral port, signs assertions exactly the way
Cupcake does, and asserts:

- missing / wrong-secret / expired / wrong-audience assertions are all rejected
  with `401`;
- the root document and its nested table of contents are well formed and
  personalized;
- static and dynamic sections return the correct shape;
- a guest gets *different* personalization than a signed-in student;
- `?goal=` is honoured;
- unknown sections and assets return `404`;
- the consent config and `POST` decision round-trip;
- `/healthz` is unauthenticated.

## Browsing the raw output

The provider logs one line per request, which is the nicest way to watch Cupcake
call it:

```
14:32:07 INFO    GET /api/v1/journeys/1f0c…/basics/loops  sub=user-42 role=student guest=- query=-
14:32:07 INFO    GET /api/v1/journeys/1f0c…/personalized/your-goals  sub=user-42 role=student guest=- query=-
```

You can also curl it yourself if you mint an assertion (see `selftest.py`), or
just open the provider root in a browser — it renders a short contract summary.
`GET /healthz` needs no assertion.

## Notes and limitations

- **HTTPS is mandatory in production.** Cupcake rejects `http:` and any host
  resolving to a private, loopback, link-local or CGNAT address. In development
  a loopback provider (`http://localhost:8099`) is allowed directly; otherwise
  use a tunnel.
- **No persistence.** Consent decisions are logged and echoed, not stored.
  Plugin personalization is stored, but only **in memory** (per learner and
  lesson); restarting the provider clears it.
- **Assets are in-memory** (`provider-logo.svg`). Swap in real files or a
  database for anything more ambitious.
- **This is a demo.** It serves generated Markdown; treat the personalization as
  illustrative rather than as a security boundary. A production provider should
  also rate-limit, validate `aud` against its own registry, and rotate secrets.
