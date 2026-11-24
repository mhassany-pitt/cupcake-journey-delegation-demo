"""Content pack for the demo delegated-journey provider.

A real 3rd-party provider would keep this in a database and could call an LLM.
For the demo the "dynamic" parts are generated deterministically from the
identity Cupcake asserts, so re-opening the same lesson as the same learner
gives a stable page, while a different learner (or different personalization
query parameters) gets different content.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# --------------------------------------------------------------------------
# Node helpers - these must match the shape Cupcake's metadata service emits.
# The web client relies on `isMarkdown`, `isDirectory`, `cleanName` and `title`.
# --------------------------------------------------------------------------


def _title_from_name(name: str) -> str:
    stem = name[:-3] if name.lower().endswith(".md") else name
    return stem.replace("-", " ").replace("_", " ").title()


def file_node(name: str, title: Optional[str] = None, **extra: Any) -> Dict[str, Any]:
    node: Dict[str, Any] = {
        "name": name,
        "cleanName": name,
        "title": title or _title_from_name(name),
        "isDirectory": False,
        "isFile": True,
        "isMarkdown": name.lower().endswith(".md"),
    }
    node.update(extra)
    return node


def dir_node(name: str, title: str, files: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "name": name,
        "cleanName": name,
        "title": title,
        "isDirectory": True,
        "isFile": False,
        "isMarkdown": False,
        "files": files,
    }


# --------------------------------------------------------------------------
# Personalization
# --------------------------------------------------------------------------

GOALS = [
    ("data", "analysing data with pandas and files"),
    ("web", "building small web apps with Flask"),
    ("automation", "automating repetitive tasks with scripts"),
    ("games", "writing small games and simulations"),
]


def seed_for(identity: Dict[str, Any]) -> str:
    """Stable per-learner seed used to pick deterministic personalization."""
    basis = "|".join(
        str(identity.get(key, ""))
        for key in ("sub", "role", "email", "name", "guestId")
    )
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def goal_for(identity: Dict[str, Any], goal_param: Optional[str]) -> Tuple[str, str]:
    """Return (goal_key, goal_description) honoring `?goal=` when present."""
    if goal_param:
        needle = goal_param.strip().lower()
        for key, description in GOALS:
            if needle == key or needle in description:
                return key, description
        return goal_param.strip(), goal_param.strip()
    index = int(seed_for(identity)[:6], 16) % len(GOALS)
    return GOALS[index]


def display_name(identity: Dict[str, Any]) -> str:
    name = (identity.get("name") or "").strip()
    if name:
        return name
    email = (identity.get("email") or "").strip()
    if email and "@" in email:
        return email.split("@", 1)[0]
    if identity.get("role") == "guest":
        guest_id = identity.get("guestId") or "guest"
        return f"guest {guest_id}"
    return "there"


def generated_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def _context(identity: Dict[str, Any], query: Dict[str, str]) -> Dict[str, str]:
    goal_key, goal_text = goal_for(identity, query.get("goal"))
    return {
        "name": display_name(identity),
        "role": str(identity.get("role", "guest")),
        "goal_key": goal_key,
        "goal_text": goal_text,
        "level": (query.get("level") or "beginner").strip(),
        "stamp": generated_stamp(),
    }


# --------------------------------------------------------------------------
# Static lessons
# --------------------------------------------------------------------------

INDEX_MD = """\
# Welcome to a *live* delegated journey

This lesson tree is not stored in Cupcake. Every page you open was requested
from a small external provider (this demo app) at the moment you clicked it.

Use the table of contents to explore:

- **Python Basics** — static lessons that are identical for everyone.
- **Personalized for You** — lessons generated on the fly for the signed-in
  learner, using the identity assertion Cupcake forwards.

![Provider logo](images/provider-logo.svg)

> Try it: sign out and open the journey as a guest, then sign back in. The
> personalized chapters change because the provider sees a different `sub`.
"""

ABOUT_MD = """\
# About this provider

This app implements the Cupcake delegated-journey contract:

| Cupcake requests | This provider serves |
| --- | --- |
| `GET /api/v1/journeys/:id` | the journey root + table of contents |
| `GET /api/v1/journeys/:id/<section>` | one lesson as Markdown |
| `GET /journeys/:id/<asset>` | media (images, etc.) |
| `GET`/`POST /api/v1/journeys/:id/consent` | research consent config + decisions |

Every request carries an `Authorization: Bearer <assertion>` header: a short
lived HS256 JWT signed with the shared secret you configured in Cupcake. The
provider verifies the signature, then reads `sub`, `role` and `guestId` to
personalize what it sends back.
"""

VARIABLES_MD = """\
# Variables and types

A variable is a name bound to a value.

```python
students = 3
average = 12.5
course = "Python Basics"
is_enrolled = True
```

Python figures out the type for you, but the value always has one:

| Type | Example |
| --- | --- |
| `int` | `3` |
| `float` | `12.5` |
| `str` | `"Python Basics"` |
| `bool` | `True` |

You can inspect it with `type()`:

```python
type(course)   # <class 'str'>
```
"""

LOOPS_MD = """\
# Loops

`for` repeats once per item:

```python
for student in ["Ada", "Grace", "Alan"]:
    print(f"Hello, {student}!")
```

`while` repeats until a condition stops being true:

```python
countdown = 3
while countdown > 0:
    print(countdown)
    countdown -= 1
print("Liftoff!")
```

> Prefer `for` when you have a collection and `while` when you are waiting for
> a condition to change.
"""

FUNCTIONS_MD = """\
# Functions

Package reusable logic behind a name:

```python
def average(numbers):
    if not numbers:
        return 0
    return sum(numbers) / len(numbers)

print(average([10, 12, 14]))   # 12.0
```

Rules of thumb:

1. One job per function.
2. Name it after the job (`average`, not `do_stuff`).
3. Return a value rather than printing, so callers can reuse it.
"""


# --------------------------------------------------------------------------
# Dynamic lessons
# --------------------------------------------------------------------------


def _goals_markdown(ctx: Dict[str, str], identity: Dict[str, Any]) -> str:
    other_goals = ", ".join(f"`{key}`" for key, _ in GOALS if key != ctx["goal_key"])
    return f"""\
# Personalized for {ctx['name']}

_Generated live for `sub={identity.get('sub', 'unknown')}` at {ctx['stamp']}._

Cupcake told this provider that you are a **{ctx['role']}** working at a
**{ctx['level']}** level, so this chapter was assembled for you on the fly.

## Your focus: {ctx['goal_text']}

Here is a plan tuned to that goal:

1. **Week 1** — variables, types and input/output.
2. **Week 2** — loops and collections (`list`, `dict`, `set`).
3. **Week 3** — functions, then reading/writing files.
4. **Week 4** — a small capstone that matches your goal.

Want a different track? Re-open this lesson with a query parameter, for example
`?goal=web` or `?level=advanced`. The provider honours it and regenerates the
page. Other tracks: {other_goals}.
"""


def _recommendation_markdown(ctx: Dict[str, str], seed: str) -> str:
    snippets = {
        "data": """\
```python
import csv

with open("marks.csv") as handle:
    rows = list(csv.DictReader(handle))

best = max(rows, key=lambda row: float(row["score"]))
print(best["name"], best["score"])
```
""",
        "web": """\
```python
from flask import Flask

app = Flask(__name__)

@app.get("/")
def home():
    return "Hello from Flask!"

if __name__ == "__main__":
    app.run(debug=True)
```
""",
        "automation": """\
```python
from pathlib import Path

for report in Path("reports").glob("*.txt"):
    text = report.read_text()
    print(report.name, len(text.split()), "words")
```
""",
        "games": """\
```python
import random

secret = random.randint(1, 20)
guess = int(input("Guess my number (1-20): "))
print("Correct!" if guess == secret else f"Nope, it was {secret}.")
```
""",
    }
    snippet = snippets.get(ctx["goal_key"], snippets["data"])
    exercises = "\n".join(
        f"{i}. Exercise {i}: extend the snippet above (" +
        ["add input validation", "handle the empty case", "add a test"][i - 1] + ")."
        for i in range(1, 4)
    )
    return f"""\
# Recommended next step

_Picked for you from seed `{seed[:12]}…` at {ctx['stamp']}._

Because your goal is **{ctx['goal_text']}**, the provider suggests this snippet:

{snippet}
## Practice

{exercises}
"""


def _progress_markdown(ctx: Dict[str, str], identity: Dict[str, Any], query: Dict[str, str]) -> str:
    done = (query.get("done") or "0").strip()
    try:
        completed = max(0, min(6, int(done)))
    except ValueError:
        completed = 0
    total = 6
    filled = "█" * completed + "░" * (total - completed)
    return f"""\
# Your progress card

_Assembled for {ctx['name']} at {ctx['stamp']}._

```
[{filled}] {completed}/{total} lessons
```

Cupcake keeps your real progress in its own database; this page simply asks the
provider to render a summary from the `done` query parameter, so you can see how
a provider can build bespoke widgets:

- Open with `?done=0` for a fresh start card.
- Open with `?done=6` for a completion card.

**Role seen by the provider:** `{identity.get('role', 'guest')}`
**Guest id:** `{identity.get('guestId') or '—'}`
"""


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

DYNAMIC_SECTIONS = {
    "personalized/your-goals",
    "personalized/recommendation",
    "personalized/progress",
}

STATIC_SECTIONS = {
    "00-index": INDEX_MD,
    "about": ABOUT_MD,
    "basics/variables": VARIABLES_MD,
    "basics/loops": LOOPS_MD,
    "basics/functions": FUNCTIONS_MD,
}


# --------------------------------------------------------------------------
# Learner edits (plugin personalization)
# --------------------------------------------------------------------------
#
# When a journey plugin rewrites a lesson, Cupcake forwards the full Markdown
# of the edited page to ``POST /api/v1/journeys/<id>/personalization``. For the
# demo we keep those edits in memory, keyed by learner and lesson, and replay
# them on the next visit — which is what makes an edit survive a browser
# refresh. A production provider would persist this in its own database.
#
# The store lives on the module so ``app.py`` and ``selftest.py`` can reach it
# without threading extra objects around.

# {journey_id: {learner_key: {lesson_key: markdown}}}
LEARNER_EDITS: Dict[str, Dict[str, Dict[str, str]]] = {}


def learner_key(identity: Dict[str, Any]) -> str:
    """A stable per-request learner identity for isolating demo edits."""
    subject = identity.get("sub")
    if subject and subject != "anonymous":
        return str(subject)
    guest_id = identity.get("guestId")
    if guest_id:
        return f"guest:{guest_id}"
    return "anonymous"


def normalize_lesson_key(value: str) -> str:
    """Reduce a lesson identifier to the key the store uses.

    Accepts the provider-relative section path (``basics/variables``), the same
    path with ``.md``, or Cupcake's full module path
    (``live-python-demo/basics/variables.md``), and returns ``basics/variables``.
    """
    key = (value or "").strip().strip("/")
    if key.lower().endswith(".md"):
        key = key[:-3]
    # Cupcake prefixes the journey directory; drop it when present.
    if "/" in key and not any(
        key == known or key.startswith(known + "/")
        for known in (DYNAMIC_SECTIONS | set(STATIC_SECTIONS))
    ):
        # Unknown prefix: assume the first segment is the journey directory.
        key = key.split("/", 1)[1]
    return key


def store_edit(journey_id: str, identity: Dict[str, Any], lesson: str, markdown: str) -> str:
    lesson_key = normalize_lesson_key(lesson)
    LEARNER_EDITS.setdefault(journey_id, {}).setdefault(
        learner_key(identity), {}
    )[lesson_key] = markdown
    return lesson_key


def edited_section(
    journey_id: str,
    identity: Dict[str, Any],
    sub_path: str,
) -> Optional[str]:
    """Return the learner's stored edit for a section, if any."""
    lesson_key = normalize_lesson_key(sub_path)
    return (
        LEARNER_EDITS.get(journey_id, {})
        .get(learner_key(identity), {})
        .get(lesson_key)
    )


def clear_edits(journey_id: str, identity: Dict[str, Any]) -> int:
    learner = learner_key(identity)
    edits = LEARNER_EDITS.get(journey_id, {}).pop(learner, {})
    return len(edits)


def edit_count(journey_id: str, identity: Dict[str, Any]) -> int:
    return len(LEARNER_EDITS.get(journey_id, {}).get(learner_key(identity), {}))


def edits_summary(journey_id: str, identity: Dict[str, Any]) -> Dict[str, Any]:
    """Introspection payload for the demo UI/console."""
    store = LEARNER_EDITS.get(journey_id, {}).get(learner_key(identity), {})
    return {
        "learner": learner_key(identity),
        "count": len(store),
        "lessons": [
            {"lesson": lesson, "chars": len(markdown)}
            for lesson, markdown in sorted(store.items())
        ],
    }


def build_root(identity: Dict[str, Any]) -> Dict[str, Any]:
    """The journey root: metadata plus the table of contents."""
    ctx = _context(identity, {})
    return {
        "path": "live-python-demo",
        "title": "Live Personalized Python",
        "description": (
            "A delegated journey served by an external provider. The table of "
            "contents and the personalized chapter are generated per learner."
        ),
        "author": "Demo Provider",
        "files": [
            file_node("00-index.md", "Start here"),
            dir_node(
                "basics",
                "1. Python Basics",
                [
                    file_node("variables.md", "Variables and types"),
                    file_node("loops.md", "Loops"),
                    file_node("functions.md", "Functions"),
                ],
            ),
            dir_node(
                "personalized",
                f"2. Personalized for {ctx['name']}",
                [
                    file_node("your-goals.md", "Your goals"),
                    file_node("recommendation.md", "Recommended next step"),
                    file_node("progress.md", "Your progress card"),
                ],
            ),
            file_node("about.md", "About this provider"),
        ],
    }


def section_markdown(
    sub_path: str,
    identity: Dict[str, Any],
    query: Dict[str, str],
    journey_id: str = "",
) -> Optional[str]:
    """Return Markdown for a section, or None when it does not exist.

    A learner's stored edit (if any) takes precedence over generated content, so
    a plugin's change replays on the next visit. ``?reset=1`` drops the edit and
    serves the pristine page, giving the plugin a revert path.
    """
    key = normalize_lesson_key(sub_path)
    if query.get("reset") in {"1", "true", "yes"} and journey_id:
        clear_edits_for_lesson(journey_id, identity, key)
    if journey_id:
        stored = edited_section(journey_id, identity, key)
        if stored is not None:
            return stored

    ctx = _context(identity, query)
    if key in STATIC_SECTIONS:
        return STATIC_SECTIONS[key]
    if key in DYNAMIC_SECTIONS:
        if key == "personalized/your-goals":
            return _goals_markdown(ctx, identity)
        if key == "personalized/recommendation":
            return _recommendation_markdown(ctx, seed_for(identity))
        return _progress_markdown(ctx, identity, query)
    return None


def clear_edits_for_lesson(journey_id: str, identity: Dict[str, Any], lesson_key: str) -> bool:
    learner = learner_key(identity)
    store = LEARNER_EDITS.get(journey_id, {}).get(learner)
    if not store or lesson_key not in store:
        return False
    del store[lesson_key]
    return True


def consent_config() -> Dict[str, Any]:
    return {
        "hasConsent": True,
        "title": "Research participation (demo)",
        "markdown": (
            "This demo journey shows how a delegated provider can supply its own "
            "consent form. Cupcake still records your choice in its own database "
            "and forwards the decision here."
        ),
        "options": [
            {
                "id": "participate",
                "label": "Participate",
                "description": "Share anonymous usage telemetry while learning.",
                "telemetry": True,
            },
            {
                "id": "decline",
                "label": "Decline",
                "description": "Learn without sharing telemetry.",
                "telemetry": False,
            },
        ],
        "requirements": [
            {
                "id": "voluntary",
                "label": "I understand participation is voluntary and I can stop at any time.",
                "required": True,
            }
        ],
        "consentSha": "demo-consent-v1",
    }


# --------------------------------------------------------------------------
# Assets
# --------------------------------------------------------------------------

PROVIDER_LOGO_SVG = b"""\
<svg xmlns="http://www.w3.org/2000/svg" width="220" height="72" viewBox="0 0 220 72" role="img" aria-label="Demo Provider">
  <rect width="220" height="72" rx="12" fill="#111827"/>
  <circle cx="40" cy="36" r="16" fill="#ef4444"/>
  <text x="40" y="42" font-family="monospace" font-size="16" font-weight="700" fill="#fff" text-anchor="middle">DP</text>
  <text x="68" y="33" font-family="monospace" font-size="13" font-weight="700" fill="#f9fafb">Demo Provider</text>
  <text x="68" y="50" font-family="monospace" font-size="10" fill="#9ca3af">live delegated content</text>
</svg>
"""

ASSETS: Dict[str, Tuple[str, bytes]] = {
    "images/provider-logo.svg": ("image/svg+xml", PROVIDER_LOGO_SVG),
}


def get_asset(sub_path: str) -> Optional[Tuple[str, bytes]]:
    return ASSETS.get(sub_path.strip("/"))
