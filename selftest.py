#!/usr/bin/env python3
"""End-to-end smoke test for the demo delegated-journey provider.

Starts the provider on an ephemeral port, signs a real HS256 identity assertion
the same way Cupcake does, and checks every route in the contract.

Run:
    python3 selftest.py
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple

import app as provider

SECRET = "demo-shared-secret-value-1234"
JOURNEY_ID = "journey-abc-123"

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  PASS  {name}")
    else:
        failures.append(name)
        print(f"  FAIL  {name}  {detail}")


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def sign_assertion(
    secret: str,
    journey_id: str,
    sub: str,
    role: str,
    *,
    guest_id: Optional[str] = None,
    name: Optional[str] = None,
    email: Optional[str] = None,
    ttl: int = 60,
) -> str:
    header = {"alg": "HS256", "typ": "JWT", "kid": journey_id}
    now = int(time.time())
    payload: Dict[str, Any] = {
        "iss": "http://localhost:3000",
        "aud": journey_id,
        "sub": sub,
        "role": role,
        "iat": now,
        "exp": now + ttl,
        "jti": "test-jti",
    }
    if guest_id:
        payload["guestId"] = guest_id
    if name:
        payload["name"] = name
    if email:
        payload["email"] = email
    signing_input = f"{b64url(json.dumps(header).encode())}.{b64url(json.dumps(payload).encode())}"
    signature = hmac.new(
        secret.encode(), signing_input.encode("ascii"), hashlib.sha256
    ).digest()
    return f"{signing_input}.{b64url(signature)}"


def request(
    base: str,
    path: str,
    token: Optional[str] = None,
    method: str = "GET",
    body: Optional[Dict[str, Any]] = None,
) -> Tuple[int, Any]:
    url = f"{base}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("X-Cupcake-Journey", JOURNEY_ID)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            raw = response.read()
            content_type = response.headers.get("Content-Type", "")
            if "json" in content_type:
                return response.status, json.loads(raw)
            return response.status, raw
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, raw


def main() -> int:
    server = provider.ProviderServer(("127.0.0.1", 0), provider.ProviderHandler)
    server.shared_secret = SECRET
    server.journey_id = JOURNEY_ID
    server.allow_unsigned = False
    port = server.server_address[1]
    base = f"http://127.0.0.1:{port}"

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    print(f"provider listening on {base}\n")

    student_token = sign_assertion(
        SECRET, JOURNEY_ID, "user-42", "student", name="Ada Lovelace", email="ada@example.com"
    )
    guest_token = sign_assertion(
        SECRET, JOURNEY_ID, "guest:g-7", "guest", guest_id="g-7"
    )

    print("auth:")
    status, body = request(base, f"/api/v1/journeys/{JOURNEY_ID}")
    check("rejects request with no assertion", status == 401, f"status={status}")

    bad = sign_assertion("wrong-secret", JOURNEY_ID, "user-42", "student")
    status, _ = request(base, f"/api/v1/journeys/{JOURNEY_ID}", bad)
    check("rejects assertion signed with the wrong secret", status == 401, f"status={status}")

    expired = sign_assertion(SECRET, JOURNEY_ID, "user-42", "student", ttl=-120)
    status, _ = request(base, f"/api/v1/journeys/{JOURNEY_ID}", expired)
    check("rejects an expired assertion", status == 401, f"status={status}")

    other_aud = sign_assertion(SECRET, "some-other-journey", "user-42", "student")
    status, _ = request(base, f"/api/v1/journeys/{JOURNEY_ID}", other_aud)
    check("rejects an assertion for another journey", status == 401, f"status={status}")

    print("\nroot document:")
    status, root = request(base, f"/api/v1/journeys/{JOURNEY_ID}", student_token)
    check("root returns 200", status == 200, f"status={status}")
    check("root has a title", isinstance(root.get("title"), str) and bool(root["title"]))
    check("root has path/description/author", all(k in root for k in ("path", "description", "author")))
    files = root.get("files", [])
    check("root files[] is a non-empty list", isinstance(files, list) and len(files) > 0)
    names = [node.get("name") for node in files]
    check("root TOC includes 00-index.md", "00-index.md" in names, f"names={names}")
    personalized = next((n for n in files if n.get("name") == "personalized"), None)
    check("root TOC has a personalized directory", personalized is not None)
    check("personalized dir is marked isDirectory", bool(personalized and personalized.get("isDirectory")))
    check(
        "personalized dir exposes child files[]",
        bool(personalized and isinstance(personalized.get("files"), list) and personalized["files"]),
    )
    first_file = files[0] if files else {}
    check(
        "leaf nodes carry isMarkdown/cleanName/title (client contract)",
        first_file.get("isMarkdown") is True
        and first_file.get("cleanName") == first_file.get("name")
        and isinstance(first_file.get("title"), str),
        f"node={first_file}",
    )

    personal_title = (personalized or {}).get("title", "")
    check(
        "TOC is personalized with the learner's name",
        "Ada" in personal_title,
        f"title={personal_title!r}",
    )

    print("\nsections:")
    status, section = request(
        base, f"/api/v1/journeys/{JOURNEY_ID}/basics/variables", student_token
    )
    check("static section returns 200", status == 200, f"status={status}")
    check(
        "section shape is {name,isFile,content}",
        section.get("isFile") is True
        and isinstance(section.get("content"), str)
        and section.get("name") == "variables",
        f"section={str(section)[:120]}",
    )

    status, dynamic = request(
        base, f"/api/v1/journeys/{JOURNEY_ID}/personalized/your-goals", student_token
    )
    check("dynamic section returns 200", status == 200, f"status={status}")
    check(
        "dynamic section is personalized to the student",
        "Ada" in dynamic.get("content", ""),
        f"content={dynamic.get('content','')[:80]!r}",
    )

    status, guest_dynamic = request(
        base, f"/api/v1/journeys/{JOURNEY_ID}/personalized/your-goals", guest_token
    )
    check(
        "guest gets different personalization than the student",
        guest_dynamic.get("content") != dynamic.get("content"),
    )

    status, goal_section = request(
        base,
        f"/api/v1/journeys/{JOURNEY_ID}/personalized/recommendation?goal=web",
        student_token,
    )
    check("query string is honored (?goal=web)", "Flask" in goal_section.get("content", ""))

    status, _ = request(
        base, f"/api/v1/journeys/{JOURNEY_ID}/basics/nope", student_token
    )
    check("unknown section returns 404", status == 404, f"status={status}")

    print("\nassets:")
    status, png = request(base, f"/journeys/{JOURNEY_ID}/images/provider-logo.svg", student_token)
    check("asset returns 200", status == 200, f"status={status}")
    check("asset bytes look like SVG", isinstance(png, bytes) and b"<svg" in png)

    status, _ = request(base, f"/journeys/{JOURNEY_ID}/images/missing.png", student_token)
    check("unknown asset returns 404", status == 404, f"status={status}")

    print("\nconsent:")
    status, config = request(base, f"/api/v1/journeys/{JOURNEY_ID}/consent", student_token)
    check("consent config returns 200", status == 200, f"status={status}")
    check("consent hasConsent is true", config.get("hasConsent") is True)
    check(
        "consent exposes options with telemetry flags",
        isinstance(config.get("options"), list)
        and all("telemetry" in option for option in config["options"]),
    )
    check(
        "consent exposes required requirements",
        isinstance(config.get("requirements"), list)
        and all("required" in requirement for requirement in config["requirements"]),
    )

    status, recorded = request(
        base,
        f"/api/v1/journeys/{JOURNEY_ID}/consent",
        student_token,
        method="POST",
        body={"choiceId": "participate", "telemetryEnabled": True, "requirementsConfirmed": ["voluntary"]},
    )
    check("POST consent returns 200", status == 200, f"status={status}")
    check(
        "POST consent echoes the decision",
        recorded.get("received", {}).get("choiceId") == "participate",
        f"body={recorded}",
    )

    print("\nplugin personalization (in-memory store):")
    edited_md = "# Variables and types\n\n*Edited by the learner in place.*\n"
    status, stored = request(
        base,
        f"/api/v1/journeys/{JOURNEY_ID}/personalization",
        student_token,
        method="POST",
        body={
            "lessonPath": "basics/variables",
            "markdown": edited_md,
            "pluginId": "inline-lesson-editor",
            "target": ".prose",
        },
    )
    check("POST personalization returns 200", status == 200, f"status={status}")
    check("personalization store reports one patch", stored.get("patches") == 1, f"body={stored}")

    status, edited = request(
        base, f"/api/v1/journeys/{JOURNEY_ID}/basics/variables", student_token
    )
    check("edited section replays the stored markdown", edited.get("content") == edited_md)

    status, guest_view = request(
        base, f"/api/v1/journeys/{JOURNEY_ID}/basics/variables", guest_token
    )
    check(
        "edits are isolated per learner",
        guest_view.get("content") != edited_md and "Edited by the learner" not in guest_view.get("content", ""),
    )

    status, summary = request(
        base, f"/api/v1/journeys/{JOURNEY_ID}/personalization", student_token
    )
    check(
        "personalization summary lists the edited lesson",
        summary.get("count") == 1
        and any(item.get("lesson") == "basics/variables" for item in summary.get("lessons", [])),
        f"summary={summary}",
    )

    status, _ = request(
        base,
        f"/api/v1/journeys/{JOURNEY_ID}/personalization",
        student_token,
        method="POST",
        body={"lessonPath": "basics/variables"},
    )
    check("personalization without markdown is rejected", status == 400, f"status={status}")

    status, reset_view = request(
        base, f"/api/v1/journeys/{JOURNEY_ID}/basics/variables?reset=1", student_token
    )
    check("?reset=1 serves the pristine lesson", reset_view.get("content") != edited_md)

    status, after_reset = request(
        base, f"/api/v1/journeys/{JOURNEY_ID}/basics/variables", student_token
    )
    check("reset cleared the stored edit", after_reset.get("content") != edited_md)

    print("\nhealth:")
    status, health = request(base, "/healthz")
    check("healthz is unauthenticated and 200", status == 200 and health.get("status") == "ok")

    server.shutdown()
    server.server_close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
