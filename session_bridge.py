"""Cookie authentication in front of an existing Basic Auth gateway.

Only Traefik may route /internal/verify: its Authorization response header is an
upstream credential, never a public response. The file-provider configuration
exposes only the exact public login/session paths, strips response credentials,
and keeps the existing Caddy Origin checks and Codex services intact.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import os
import secrets
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import web

import session_auth as auth

BRIDGE_KEY = web.AppKey("upstream-basic-auth", str)
COOKIE_NAME = "__Host-codex_web_session"


def credential_record(username: str, password: str, secret: bytes) -> auth.Credential:
    # Stable per-installation salt preserves sessions across service restarts.
    salt = hmac.digest(secret, b"password-salt\0" + username.encode(), "sha256")[:16]
    template = auth.PasswordRecord(salt, b"\0" * 32, 2**14, 8, 1, 32)
    record = auth.PasswordRecord(salt, template.derive(password.encode()), 2**14, 8, 1, 32)
    return auth.Credential(username, record)


def valid_basic(presented: str, expected: str) -> bool:
    if len(presented) > 8192:
        return False
    try:
        scheme, encoded = presented.split(" ", 1)
        if scheme.lower() != "basic":
            return False
        value = base64.b64decode(encoded, validate=True)
        correct = base64.b64decode(expected.split(" ", 1)[1], validate=True)
        return hmac.compare_digest(value, correct)
    except (ValueError, binascii.Error):
        return False


async def verify(request: web.Request) -> web.Response:
    settings = request.app[auth.SETTINGS_KEY]
    # Defense in depth: forwarded fields are overwritten by Traefik, not trusted
    # from the public request. Caddy independently enforces the same Origin rule.
    method = request.headers.get("X-Forwarded-Method", "GET").upper()
    path = urlsplit(request.headers.get("X-Forwarded-Uri", "/")).path
    if path == "/ws" or method not in {"GET", "HEAD", "OPTIONS"}:
        if request.headers.get("Origin", "") not in settings.allowed_origins:
            return web.json_response({"error": "Origin not allowed"}, status=403)

    current = auth._current_session(request)
    if current is not None:
        return web.Response(status=204, headers={"Authorization": request.app[BRIDGE_KEY]})

    # Keep working desktop tabs and API clients connected during migration.
    # Never challenge the browser with WWW-Authenticate.
    if valid_basic(request.headers.get("Authorization", ""), request.app[BRIDGE_KEY]):
        credential = next(iter(request.app[auth.CREDENTIALS_KEY].users.values()))
        token, _ = request.app[auth.STORE_KEY].create(credential)
        response = web.Response(status=204, headers={"Authorization": request.app[BRIDGE_KEY]})
        auth._set_session_cookie(response, settings, token)
        return response
    return await auth.auth_check(request)


@web.middleware
async def bridge(request: web.Request, handler):
    if request.path == "/internal/verify":
        return await verify(request)
    return await handler(request)


def create_app(state_dir: Path, username: str, password: str, origin: str) -> web.Application:
    if (
        not username or not password or ":" in username
        or len(username) > 512
        or any(ord(char) < 32 or ord(char) == 127 for char in username)
        or len(password.encode("utf-8")) > auth.MAX_PASSWORD_BYTES
    ):
        raise auth.ConfigurationError("A valid website username and password are required")
    try:
        parsed = urlsplit(origin)
        port = parsed.port
        valid_origin = (
            parsed.scheme == "https" and bool(parsed.hostname)
            and not parsed.path and not parsed.query and not parsed.fragment
            and parsed.username is None and parsed.password is None
            and not any(char.isspace() or ord(char) < 32 for char in origin)
            and (port is not None or not parsed.netloc.endswith(":"))
        )
    except ValueError:
        valid_origin = False
    if not valid_origin:
        raise auth.ConfigurationError("Website origin must be an HTTPS origin without a path")
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    secret_path = state_dir / "session-secret"
    try:
        fd = os.open(secret_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "wb") as handle:
            handle.write(secrets.token_bytes(64))
    secret = secret_path.read_bytes()
    if len(secret) != 64:
        raise auth.ConfigurationError("Invalid session secret")
    credential = credential_record(username, password, secret)
    settings = auth.SessionAuthSettings(
        credentials_path=state_dir / "unused-credentials.json",
        session_secret=secret,
        database_path=state_dir / "sessions.sqlite3",
        allowed_origins=frozenset({origin}),
        secure_cookie=True,
        cookie_name=COOKIE_NAME,
    )
    app = auth.create_app(settings=settings, credentials=auth.CredentialStore({username: credential}))
    app[BRIDGE_KEY] = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()
    app.middlewares.append(bridge)
    app.router.add_get("/internal/verify", verify)
    return app


if __name__ == "__main__":
    os.umask(0o077)
    application = create_app(
        Path(os.environ.get("CODEX_WEB_LOGIN_STATE", "/state")),
        os.environ["CODEX_WEB_LOGIN_USERNAME"],
        os.environ["CODEX_WEB_LOGIN_PASSWORD"],
        os.environ["CODEX_WEB_LOGIN_ORIGIN"],
    )
    # No access log: passwords, cookies and upstream headers must not be logged.
    web.run_app(application, host="0.0.0.0", port=8000, access_log=None, print=None)
