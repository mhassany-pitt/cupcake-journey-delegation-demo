#!/usr/bin/env python3
"""Demo 3rd-party provider for Cupcake *delegated journeys*.

This is a dependency-free reference implementation of the provider contract
described in ``cupcake-api/src/journey/DELEGATION.md``. Point a delegated
journey at this server and Cupcake will forward every content, asset and consent
request here, signed with a short-lived HS256 identity assertion.

Endpoints (what Cupcake calls upstream):

    GET  /api/v1/journeys/<id>            -> journey root + table of contents
    GET  /api/v1/journeys/<id>/<section>  -> one lesson as Markdown
    GET  /api/v1/journeys/<id>/consent    -> consent configuration
    POST /api/v1/journeys/<id>/consent    -> a recorded consent decision
    GET  /journeys/<id>/<asset>           -> media bytes

Everything is generated in-process from the asserted identity, so no database
and no third-party packages are required.

Run:
    CUPCAKE_SHARED_SECRET=... python3 app.py --port 8099
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import logging
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Tuple
from urllib.parse import parse_qs, unquote, urlsplit

import content

LOG = logging.getLogger("delegated-provider")

JSON_LIMIT = 2 * 1024 * 1024
ASSERTION_MAX_SKEW_SECONDS = 5


# --------------------------------------------------------------------------
# Identity assertion (HS256 JWT) verification
# --------------------------------------------------------------------------


class AssertionFailure(Exception):
    """Raised when the incoming identity assertion is not trustworthy."""


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def verify_assertion(token: str, secret: str, expected_aud: str) -> Dict[str, Any]:
    """Verify signature, expiry and audience, then return the claims."""
    parts = token.split(".")
    if len(parts) != 3:
        raise AssertionFailure("assertion is not a JWT")
    header_b64, payload_b64, signature_b64 = parts

    try:
        header = json.loads(_b64url_decode(header_b64))
        claims = json.loads(_b64url_decode(payload_b64))
    except (ValueError, json.JSONDecodeError) as error:
        raise AssertionFailure(f"assertion is malformed: {error}") from error

    if header.get("alg") != "HS256":
        raise AssertionFailure(f"unsupported algorithm: {header.get('alg')!r}")

    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    try:
        provided = _b64url_decode(signature_b64)
    except ValueError as error:
        raise AssertionFailure("assertion signature is malformed") from error

    if not hmac.compare_digest(expected, provided):
        raise AssertionFailure("assertion signature is invalid")

    now = int(time.time())
    expires_at = claims.get("exp")
    if not isinstance(expires_at, (int, float)):
        raise AssertionFailure("assertion has no expiry")
    if now > expires_at + ASSERTION_MAX_SKEW_SECONDS:
        raise AssertionFailure("assertion has expired")

    audience = claims.get("aud")
    if expected_aud and audience and audience != expected_aud:
        raise AssertionFailure(
            f"assertion audience {audience!r} does not match this journey"
        )

    return claims


def identity_from_claims(claims: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "sub": claims.get("sub"),
        "role": claims.get("role", "guest"),
        "email": claims.get("email"),
        "name": claims.get("name"),
        "guestId": claims.get("guestId"),
    }


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------


class ProviderHandler(BaseHTTPRequestHandler):
    server_version = "DelegatedDemoProvider/1.0"
    server: "ProviderServer"

    # --- dispatch -----------------------------------------------------------

    def do_OPTIONS(self) -> None:  # noqa: N802 - http.server API
        self.send_response(204)
        self._send_cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def _handle(self, method: str) -> None:
        split = urlsplit(self.path)
        segments = [unquote(part) for part in split.path.strip("/").split("/") if part]
        query = {key: values[-1] for key, values in parse_qs(split.query).items() if values}

        # The landing page and health check are unauthenticated conveniences.
        if not segments:
            self._send_html(INDEX_PAGE.format(
                journey=self.server.journey_id or "(any)",
                secret="configured" if self.server.shared_secret else "MISSING",
                allow_unsigned=self.server.allow_unsigned,
            ))
            return
        if segments == ["healthz"]:
            self._send_json({"status": "ok", "journeyId": self.server.journey_id or None})
            return

        try:
            identity = self._authenticate()
        except AssertionFailure as error:
            LOG.warning("rejected %s %s: %s", method, split.path, error)
            self._send_json({"error": str(error)}, status=401)
            return

        LOG.info(
            "%s %s  sub=%s role=%s guest=%s query=%s",
            method,
            split.path,
            identity.get("sub"),
            identity.get("role"),
            identity.get("guestId", "-"),
            split.query or "-",
        )

        if segments[:3] == ["api", "v1", "journeys"]:
            _, _, _, *tail = segments
            if not tail:
                self._send_json({"error": "journey id required"}, status=400)
                return
            journey_id, rest = tail[0], tail[1:]
            if not self._journey_matches(journey_id):
                self._send_json({"error": "unknown journey"}, status=404)
                return
            if rest == ["personalization"] and method == "POST":
                self._serve_personalization_post(journey_id, identity)
                return
            if method == "GET":
                self._serve_journey_json(journey_id, rest, identity, query)
            else:
                self._serve_consent_post(journey_id, identity)
            return

        if segments[0] == "journeys" and method == "GET":
            self._serve_asset(segments[1:])
            return

        self._send_json({"error": "not found"}, status=404)

    # --- auth ---------------------------------------------------------------

    def _authenticate(self) -> Dict[str, Any]:
        header = self.headers.get("Authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""

        if not self.server.shared_secret:
            if self.server.allow_unsigned:
                LOG.warning("no shared secret; ALLOW_UNSIGNED is on, serving as guest")
                return {"sub": "anonymous", "role": "guest"}
            raise AssertionFailure(
                "provider has no shared secret configured; set CUPCAKE_SHARED_SECRET"
            )

        if not token:
            if self.server.allow_unsigned:
                LOG.warning("no assertion; ALLOW_UNSIGNED is on, serving as guest")
                return {"sub": "anonymous", "role": "guest"}
            raise AssertionFailure("missing bearer assertion")

        expected_aud = self.headers.get("X-Cupcake-Journey") or self.server.journey_id
        return identity_from_claims(
            verify_assertion(token, self.server.shared_secret, expected_aud)
        )

    def _journey_matches(self, journey_id: str) -> bool:
        configured = self.server.journey_id
        return not configured or configured == journey_id

    # --- GET routes ---------------------------------------------------------

    def _serve_journey_json(
        self,
        journey_id: str,
        rest: List[str],
        identity: Dict[str, Any],
        query: Dict[str, str],
    ) -> None:
        if not rest:
            root = content.build_root(identity)
            edits = content.edit_count(journey_id, identity)
            if edits:
                root["description"] = (
                    f"{root['description']} "
                    f"({edits} lesson{'s' if edits != 1 else ''} personalized by a plugin.)"
                )
            self._send_json(root)
            return

        if rest == ["consent"]:
            self._send_json(content.consent_config())
            return

        if rest == ["personalization"]:
            # Demo introspection: show which lessons this learner has edited.
            self._send_json(content.edits_summary(journey_id, identity))
            return

        sub_path = "/".join(rest)
        markdown = content.section_markdown(sub_path, identity, query, journey_id)
        if markdown is None:
            self._send_json({"error": "section not found"}, status=404)
            return

        self._send_json({"name": rest[-1], "isFile": True, "content": markdown})

    def _serve_asset(self, segments: List[str]) -> None:
        if len(segments) < 2:
            self._send_json({"error": "asset not found"}, status=404)
            return
        _journey_id, *asset_path = segments
        asset = content.get_asset("/".join(asset_path))
        if asset is None:
            self._send_json({"error": "asset not found"}, status=404)
            return
        content_type, body = asset
        self._send_bytes(body, content_type)

    # --- POST routes --------------------------------------------------------

    def _serve_personalization_post(
        self,
        journey_id: str,
        identity: Dict[str, Any],
    ) -> None:
        """Remember a plugin-applied lesson edit for this learner.

        Cupcake posts the full Markdown of the edited lesson here after a plugin
        changes the page, so the provider can serve the edited version on the
        learner's next visit. The demo keeps it in memory; a real provider would
        store it in its own database.
        """
        try:
            body = self._read_json_body()
        except ValueError as error:
            self._send_json({"error": str(error)}, status=400)
            return

        markdown = body.get("markdown")
        lesson = body.get("lessonPath") or body.get("target") or ""
        if not isinstance(markdown, str) or not markdown.strip():
            self._send_json(
                {"error": "a non-empty 'markdown' field is required"}, status=400
            )
            return

        lesson_key = content.store_edit(journey_id, identity, str(lesson), markdown)
        LOG.info(
            "personalization stored: journey=%s sub=%s lesson=%s patches=%s plugin=%s",
            journey_id,
            identity.get("sub"),
            lesson_key,
            content.edit_count(journey_id, identity),
            body.get("pluginId", "-"),
        )
        count = content.edit_count(journey_id, identity)
        self._send_json(
            {
                "ok": True,
                "journeyId": journey_id,
                "lesson": lesson_key,
                "patches": count,
            }
        )

    def _serve_consent_post(self, journey_id: str, identity: Dict[str, Any]) -> None:
        try:
            body = self._read_json_body()
        except ValueError as error:
            self._send_json({"error": str(error)}, status=400)
            return
        LOG.info(
            "consent recorded: journey=%s sub=%s choice=%s telemetry=%s guest=%s",
            journey_id,
            identity.get("sub"),
            body.get("choiceId"),
            body.get("telemetryEnabled"),
            body.get("guestId", "-"),
        )
        self._send_json(
            {"ok": True, "journeyId": journey_id, "received": body}
        )

    def _read_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > JSON_LIMIT:
            raise ValueError("request body too large")
        raw = self.rfile.read(length)
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"invalid JSON body: {error}") from error
        return parsed if isinstance(parsed, dict) else {}

    # --- responses ----------------------------------------------------------

    def _send_json(self, payload: Any, status: int = 200) -> None:
        self._send_bytes(
            json.dumps(payload).encode("utf-8"),
            "application/json; charset=utf-8",
            status=status,
        )

    def _send_html(self, body: str) -> None:
        self._send_bytes(body.encode("utf-8"), "text/html; charset=utf-8")

    def _send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._send_cors_headers()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        LOG.debug("%s - %s", self.address_string(), fmt % args)


class ProviderServer(ThreadingHTTPServer):
    shared_secret: str = ""
    journey_id: str = ""
    allow_unsigned: bool = False


INDEX_PAGE = """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Delegated Journey Demo Provider</title>
<body style="font-family: ui-monospace, monospace; max-width: 46rem; margin: 3rem auto; line-height: 1.6">
  <h1>Delegated Journey Demo Provider</h1>
  <p>This server is a stand-in for a 3rd-party content provider.</p>
  <p>Journey id: <code>{journey}</code><br>
     Shared secret: <code>{secret}</code><br>
     Accept unsigned requests: <code>{allow_unsigned}</code></p>
  <h2>Contract</h2>
  <ul>
    <li><code>GET /api/v1/journeys/&lt;id&gt;</code> — root + table of contents</li>
    <li><code>GET /api/v1/journeys/&lt;id&gt;/&lt;section&gt;</code> — Markdown lesson</li>
    <li><code>GET /api/v1/journeys/&lt;id&gt;/consent</code> — consent config</li>
    <li><code>POST /api/v1/journeys/&lt;id&gt;/consent</code> — consent decision</li>
    <li><code>GET /journeys/&lt;id&gt;/&lt;asset&gt;</code> — media bytes</li>
  </ul>
  <p>Requests must carry <code>Authorization: Bearer &lt;HS256 assertion&gt;</code>
     signed with the shared secret.</p>
</body>
</html>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Demo delegated-journey provider")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8099")))
    parser.add_argument(
        "--secret",
        default=os.environ.get("CUPCAKE_SHARED_SECRET", ""),
        help="Shared secret used to verify Cupcake's HS256 assertion.",
    )
    parser.add_argument(
        "--journey-id",
        default=os.environ.get("JOURNEY_ID", ""),
        help="Optional: reject requests for any other journey id.",
    )
    parser.add_argument(
        "--allow-unsigned",
        action="store_true",
        default=os.environ.get("ALLOW_UNSIGNED", "").lower() in {"1", "true", "yes"},
        help="Demo/debug only: serve requests without verifying an assertion.",
    )
    parser.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "INFO"))
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    server = ProviderServer((args.host, args.port), ProviderHandler)
    server.shared_secret = args.secret
    server.journey_id = args.journey_id
    server.allow_unsigned = args.allow_unsigned

    LOG.info("listening on http://%s:%s", args.host, args.port)
    LOG.info("journey id: %s", args.journey_id or "(accept any)")
    if not args.secret:
        LOG.warning(
            "CUPCAKE_SHARED_SECRET is not set; assertions cannot be verified%s",
            "" if args.allow_unsigned else " (use --allow-unsigned to test)",
        )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOG.info("shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
