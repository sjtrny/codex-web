"""Cookie-session authentication gateway for Codex Web.

The service is designed to sit behind Caddy's ``forward_auth`` directive. It
owns login and logout UI, keeps opaque session identifiers in an HttpOnly
cookie, and returns a trusted user header only after validating server-side
session state.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import getpass
import hashlib
import hmac
import html
import json
import logging
import os
import re
import secrets
import sqlite3
import stat
import sys
import time
from collections import defaultdict, deque
from collections.abc import Callable, Mapping
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from urllib.parse import urlencode, urlsplit

from aiohttp import web

LOG = logging.getLogger("codex-web-session-auth")

DEFAULT_COOKIE_NAME = "codex_web_session"
LOGIN_CSRF_COOKIE_NAME = "codex_web_login_csrf"
DEFAULT_USER_HEADER = "X-Codex-Web-User"
DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
LOGIN_CSRF_TTL_SECONDS = 10 * 60
MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024
MAX_PASSWORD_BYTES = 4096
MAX_SESSIONS_PER_USER = 256
MAX_FAILED_LOGINS = 5
FAILED_LOGIN_WINDOW_SECONDS = 60
SESSION_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{40,128}")
CSRF_NONCE_PATTERN = re.compile(r"[A-Za-z0-9_-]{24,128}")
HEADER_NAME_PATTERN = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
COOKIE_NAME_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,64}")


class ConfigurationError(RuntimeError):
    """Raised when session authentication configuration is unsafe."""


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _flag(name: str, default: bool = False) -> bool:
    raw = _env(name)
    if not raw:
        return default
    normalized = raw.lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ConfigurationError(f"{name} must be true or false")


def _integer(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = _env(name)
    try:
        value = int(raw) if raw else default
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return value


def _absolute_path(value: str, field: str) -> Path:
    if not value or "\0" in value:
        raise ConfigurationError(f"{field} must be a non-empty absolute path")
    path = Path(value)
    if not path.is_absolute() or os.path.normpath(value) != value:
        raise ConfigurationError(f"{field} must be an absolute normalized path")
    return path


def _read_private_file(path: Path, field: str, max_bytes: int) -> bytes:
    try:
        metadata = path.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise ConfigurationError(f"{field} must be a regular file")
        if metadata.st_mode & 0o022:
            raise ConfigurationError(f"{field} must not be group/world writable")
        if metadata.st_size > max_bytes:
            raise ConfigurationError(f"{field} exceeds {max_bytes} bytes")
        return path.read_bytes()
    except OSError as exc:
        raise ConfigurationError(f"could not read {field}: {path}") from exc


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64decode(value: object, field: str) -> bytes:
    if not isinstance(value, str) or not value or len(value) > 512:
        raise ConfigurationError(f"{field} must be base64url text")
    padding = "=" * (-len(value) % 4)
    try:
        return base64.b64decode(
            value + padding,
            altchars=b"-_",
            validate=True,
        )
    except (ValueError, binascii.Error) as exc:
        raise ConfigurationError(f"{field} must be valid base64url text") from exc


def _identity(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise ConfigurationError(f"{field} must be a string")
    identity = value.strip()
    if not identity or len(identity) > 512:
        raise ConfigurationError(f"{field} must contain 1 to 512 characters")
    if any(ord(character) < 32 or ord(character) == 127 for character in identity):
        raise ConfigurationError(f"{field} contains control characters")
    return identity


def _check_keys(value: Mapping[str, object], allowed: set[str], field: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ConfigurationError(
            f"{field} contains unknown fields: {', '.join(unknown)}"
        )


@dataclass(frozen=True)
class PasswordRecord:
    salt: bytes
    digest: bytes
    n: int
    r: int
    p: int
    dklen: int

    @classmethod
    def parse(cls, value: object, field: str) -> PasswordRecord:
        if not isinstance(value, dict):
            raise ConfigurationError(f"{field} must be an object")
        _check_keys(
            value,
            {"algorithm", "salt", "hash", "n", "r", "p", "dklen"},
            field,
        )
        if value.get("algorithm") != "scrypt":
            raise ConfigurationError(f"{field}.algorithm must be scrypt")
        integers: dict[str, int] = {}
        for name in ("n", "r", "p", "dklen"):
            item = value.get(name)
            if not isinstance(item, int) or isinstance(item, bool):
                raise ConfigurationError(f"{field}.{name} must be an integer")
            integers[name] = item
        n = integers["n"]
        r = integers["r"]
        p = integers["p"]
        dklen = integers["dklen"]
        if n < 2**14 or n > 2**20 or n & (n - 1):
            raise ConfigurationError(f"{field}.n must be a power of two from 16384")
        if not 1 <= r <= 32 or not 1 <= p <= 16 or not 32 <= dklen <= 64:
            raise ConfigurationError(f"{field} has unsafe scrypt parameters")
        if n * r > 2**20:
            raise ConfigurationError(f"{field} requests too much scrypt memory")
        salt = _b64decode(value.get("salt"), f"{field}.salt")
        digest = _b64decode(value.get("hash"), f"{field}.hash")
        if not 16 <= len(salt) <= 64:
            raise ConfigurationError(f"{field}.salt must contain 16 to 64 bytes")
        if len(digest) != dklen:
            raise ConfigurationError(f"{field}.hash length must equal dklen")
        return cls(salt=salt, digest=digest, n=n, r=r, p=p, dklen=dklen)

    @property
    def fingerprint(self) -> bytes:
        material = b"\0".join(
            (
                self.salt,
                self.digest,
                str(self.n).encode(),
                str(self.r).encode(),
                str(self.p).encode(),
                str(self.dklen).encode(),
            )
        )
        return hashlib.sha256(material).digest()

    def derive(self, password: bytes) -> bytes:
        maxmem = max(64 * 1024 * 1024, 256 * self.n * self.r)
        return hashlib.scrypt(
            password,
            salt=self.salt,
            n=self.n,
            r=self.r,
            p=self.p,
            maxmem=maxmem,
            dklen=self.dklen,
        )

    def document(self) -> dict[str, object]:
        return {
            "algorithm": "scrypt",
            "salt": _b64encode(self.salt),
            "hash": _b64encode(self.digest),
            "n": self.n,
            "r": self.r,
            "p": self.p,
            "dklen": self.dklen,
        }


@dataclass(frozen=True)
class Credential:
    user_id: str
    password: PasswordRecord


class CredentialStore:
    def __init__(self, users: Mapping[str, Credential]) -> None:
        if not users:
            raise ConfigurationError("credentials must contain at least one user")
        self.users = MappingProxyType(dict(users))
        template = next(iter(users.values())).password
        self._dummy = PasswordRecord(
            salt=secrets.token_bytes(len(template.salt)),
            digest=secrets.token_bytes(template.dklen),
            n=template.n,
            r=template.r,
            p=template.p,
            dklen=template.dklen,
        )

    @classmethod
    def load(cls, path: Path) -> CredentialStore:
        raw = _read_private_file(
            path,
            "CODEX_WEB_SESSION_CREDENTIALS_FILE",
            MAX_CREDENTIAL_FILE_BYTES,
        )
        try:
            document = json.loads(raw)
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise ConfigurationError(
                "session credentials contain invalid JSON"
            ) from exc
        if not isinstance(document, dict):
            raise ConfigurationError("session credentials must be an object")
        _check_keys(document, {"version", "users"}, "session credentials")
        if document.get("version") != 1:
            raise ConfigurationError("session credentials version must be 1")
        entries = document.get("users")
        if not isinstance(entries, list) or not entries:
            raise ConfigurationError(
                "session credentials users must be a non-empty array"
            )
        users: dict[str, Credential] = {}
        for index, entry in enumerate(entries):
            field = f"users[{index}]"
            if not isinstance(entry, dict):
                raise ConfigurationError(f"{field} must be an object")
            _check_keys(entry, {"id", "password"}, field)
            user_id = _identity(entry.get("id"), f"{field}.id")
            if user_id in users:
                raise ConfigurationError(f"duplicate credential user id: {user_id!r}")
            users[user_id] = Credential(
                user_id=user_id,
                password=PasswordRecord.parse(
                    entry.get("password"), f"{field}.password"
                ),
            )
        return cls(users)

    def verify(self, user_id: str, password: str) -> Credential | None:
        credential = self.users.get(user_id)
        record = credential.password if credential else self._dummy
        encoded = password.encode("utf-8", errors="surrogatepass")
        valid_size = len(encoded) <= MAX_PASSWORD_BYTES
        candidate = record.derive(encoded if valid_size else b"")
        valid = hmac.compare_digest(candidate, record.digest)
        return credential if credential is not None and valid and valid_size else None


@dataclass(frozen=True)
class SessionAuthSettings:
    credentials_path: Path
    session_secret: bytes
    database_path: Path
    allowed_origins: frozenset[str]
    secure_cookie: bool
    session_ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS
    cookie_name: str = DEFAULT_COOKIE_NAME
    user_header: str = DEFAULT_USER_HEADER

    @classmethod
    def from_env(cls) -> SessionAuthSettings:
        credentials_path = _absolute_path(
            _env("CODEX_WEB_SESSION_CREDENTIALS_FILE"),
            "CODEX_WEB_SESSION_CREDENTIALS_FILE",
        )
        secret_path = _absolute_path(
            _env("CODEX_WEB_SESSION_SECRET_FILE"),
            "CODEX_WEB_SESSION_SECRET_FILE",
        )
        secret_raw = _read_private_file(
            secret_path,
            "CODEX_WEB_SESSION_SECRET_FILE",
            4096,
        ).strip()
        if len(secret_raw) < 32:
            raise ConfigurationError(
                "CODEX_WEB_SESSION_SECRET_FILE must contain at least 32 bytes"
            )
        database_path = _absolute_path(
            _env("CODEX_WEB_SESSION_DB"), "CODEX_WEB_SESSION_DB"
        )
        if not database_path.parent.is_dir():
            raise ConfigurationError("CODEX_WEB_SESSION_DB parent must exist")

        allowed_origins: set[str] = set()
        schemes: set[str] = set()
        allow_insecure = _flag("CODEX_WEB_SESSION_ALLOW_INSECURE_HTTP")
        for candidate in _env("CODEX_WEB_SESSION_ALLOWED_ORIGINS").split(","):
            origin = candidate.strip().rstrip("/")
            if not origin:
                continue
            parsed = urlsplit(origin)
            try:
                parsed_port = parsed.port
            except ValueError as exc:
                raise ConfigurationError(
                    "CODEX_WEB_SESSION_ALLOWED_ORIGINS has an invalid port"
                ) from exc
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.netloc
                or parsed.username is not None
                or parsed.password is not None
                or parsed.path
                or parsed.query
                or parsed.fragment
                or (parsed_port is None and parsed.netloc.endswith(":"))
            ):
                raise ConfigurationError(
                    "CODEX_WEB_SESSION_ALLOWED_ORIGINS must contain HTTP(S) origins"
                )
            if (
                parsed.scheme == "http"
                and parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
                and not allow_insecure
            ):
                raise ConfigurationError(
                    "non-loopback session cookies require HTTPS unless "
                    "CODEX_WEB_SESSION_ALLOW_INSECURE_HTTP=true"
                )
            allowed_origins.add(origin)
            schemes.add(parsed.scheme)
        if not allowed_origins:
            raise ConfigurationError(
                "CODEX_WEB_SESSION_ALLOWED_ORIGINS must contain at least one origin"
            )
        if len(schemes) != 1:
            raise ConfigurationError(
                "CODEX_WEB_SESSION_ALLOWED_ORIGINS cannot mix HTTP and HTTPS"
            )

        cookie_name = _env("CODEX_WEB_SESSION_COOKIE_NAME", DEFAULT_COOKIE_NAME)
        if not COOKIE_NAME_PATTERN.fullmatch(cookie_name):
            raise ConfigurationError("CODEX_WEB_SESSION_COOKIE_NAME is invalid")
        user_header = _env("CODEX_WEB_AUTH_USER_HEADER", DEFAULT_USER_HEADER)
        if not HEADER_NAME_PATTERN.fullmatch(user_header):
            raise ConfigurationError("CODEX_WEB_AUTH_USER_HEADER is invalid")
        return cls(
            credentials_path=credentials_path,
            session_secret=secret_raw,
            database_path=database_path,
            allowed_origins=frozenset(allowed_origins),
            secure_cookie=schemes == {"https"},
            session_ttl_seconds=_integer(
                "CODEX_WEB_SESSION_TTL_SECONDS",
                DEFAULT_SESSION_TTL_SECONDS,
                5 * 60,
                365 * 24 * 60 * 60,
            ),
            cookie_name=cookie_name,
            user_header=user_header,
        )


@dataclass(frozen=True)
class Session:
    user_id: str
    expires_at: int


class SessionStore:
    def __init__(
        self,
        path: Path,
        ttl_seconds: int,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.path = path
        self.ttl_seconds = ttl_seconds
        self.clock = clock
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in {0, 1}:
                raise ConfigurationError(
                    f"unsupported session database schema version: {version}"
                )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash BLOB PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    credential_tag BLOB NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)"
            )
            connection.execute("PRAGMA user_version = 1")
        try:
            self.path.chmod(0o600)
        except OSError as exc:
            raise ConfigurationError("could not protect the session database") from exc

    @staticmethod
    def _token_hash(token: str) -> bytes:
        return hashlib.sha256(token.encode("ascii")).digest()

    def create(self, credential: Credential) -> tuple[str, Session]:
        now = int(self.clock())
        expires_at = now + self.ttl_seconds
        token = secrets.token_urlsafe(32)
        token_hash = self._token_hash(token)
        with closing(self._connect()) as connection, connection:
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            stale = connection.execute(
                """
                SELECT token_hash FROM sessions
                WHERE user_id = ? ORDER BY created_at DESC, rowid DESC
                LIMIT -1 OFFSET ?
                """,
                (credential.user_id, MAX_SESSIONS_PER_USER - 1),
            ).fetchall()
            connection.executemany("DELETE FROM sessions WHERE token_hash = ?", stale)
            connection.execute(
                """
                INSERT INTO sessions
                    (token_hash, user_id, credential_tag, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    token_hash,
                    credential.user_id,
                    credential.password.fingerprint,
                    now,
                    expires_at,
                ),
            )
        return token, Session(credential.user_id, expires_at)

    def lookup(self, token: str, credentials: CredentialStore) -> Session | None:
        if not SESSION_TOKEN_PATTERN.fullmatch(token):
            return None
        now = int(self.clock())
        token_hash = self._token_hash(token)
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                """
                SELECT user_id, credential_tag, expires_at
                FROM sessions WHERE token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
            if row is None:
                return None
            user_id, credential_tag, expires_at = row
            credential = credentials.users.get(user_id)
            if (
                expires_at <= now
                or credential is None
                or not hmac.compare_digest(
                    credential_tag, credential.password.fingerprint
                )
            ):
                connection.execute(
                    "DELETE FROM sessions WHERE token_hash = ?", (token_hash,)
                )
                return None
        return Session(user_id=user_id, expires_at=expires_at)

    def revoke(self, token: str) -> None:
        if not SESSION_TOKEN_PATTERN.fullmatch(token):
            return
        with closing(self._connect()) as connection, connection:
            connection.execute(
                "DELETE FROM sessions WHERE token_hash = ?", (self._token_hash(token),)
            )


class FailedLoginLimiter:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.failures: dict[str, deque[float]] = defaultdict(deque)

    def _recent(self, key: str) -> deque[float]:
        now = self.clock()
        failures = self.failures[key]
        while failures and failures[0] <= now - FAILED_LOGIN_WINDOW_SECONDS:
            failures.popleft()
        return failures

    def allowed(self, key: str) -> bool:
        return len(self._recent(key)) < MAX_FAILED_LOGINS

    def failed(self, key: str) -> None:
        self._recent(key).append(self.clock())

    def succeeded(self, key: str) -> None:
        self.failures.pop(key, None)


SETTINGS_KEY = web.AppKey("settings", SessionAuthSettings)
CREDENTIALS_KEY = web.AppKey("credentials", CredentialStore)
STORE_KEY = web.AppKey("session-store", SessionStore)
LIMITER_KEY = web.AppKey("login-limiter", FailedLoginLimiter)


def _safe_next(value: object) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        return "/"
    if not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/"
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        return "/"
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.fragment:
        return "/"
    if parsed.path in {"/login", "/logout"} or parsed.path.startswith("/auth/"):
        return "/"
    return value


def _login_location(next_path: str) -> str:
    safe = _safe_next(next_path)
    return "/login" if safe == "/" else f"/login?{urlencode({'next': safe})}"


def _redirect(location: str) -> web.Response:
    return web.Response(status=303, headers={"Location": location})


def _same_origin(request: web.Request) -> bool:
    allowed = request.app[SETTINGS_KEY].allowed_origins
    origin = request.headers.get("Origin", "").rstrip("/")
    if origin:
        return origin in allowed
    referer = request.headers.get("Referer", "")
    if not referer:
        return False
    parsed = urlsplit(referer)
    if not parsed.scheme or not parsed.netloc:
        return False
    return f"{parsed.scheme}://{parsed.netloc}" in allowed


def _session_token(request: web.Request) -> str:
    settings = request.app[SETTINGS_KEY]
    return request.cookies.get(settings.cookie_name, "")


def _current_session(request: web.Request) -> tuple[str, Session] | None:
    token = _session_token(request)
    session = request.app[STORE_KEY].lookup(token, request.app[CREDENTIALS_KEY])
    return (token, session) if session is not None else None


def _csrf_token(settings: SessionAuthSettings, session_token: str) -> str:
    digest = hmac.new(
        settings.session_secret,
        b"logout\0" + session_token.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return _b64encode(digest)


def _new_login_csrf(settings: SessionAuthSettings) -> str:
    nonce = secrets.token_urlsafe(24)
    signature = hmac.new(
        settings.session_secret,
        b"login\0" + nonce.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{nonce}.{_b64encode(signature)}"


def _valid_login_csrf(settings: SessionAuthSettings, value: str) -> bool:
    try:
        nonce, signature = value.split(".", 1)
    except ValueError:
        return False
    if not CSRF_NONCE_PATTERN.fullmatch(nonce):
        return False
    expected = _new_login_csrf_for_nonce(settings, nonce)
    return hmac.compare_digest(value, expected) and bool(signature)


def _new_login_csrf_for_nonce(settings: SessionAuthSettings, nonce: str) -> str:
    signature = hmac.new(
        settings.session_secret,
        b"login\0" + nonce.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{nonce}.{_b64encode(signature)}"


def _set_session_cookie(
    response: web.StreamResponse, settings: SessionAuthSettings, token: str
) -> None:
    response.set_cookie(
        settings.cookie_name,
        token,
        max_age=settings.session_ttl_seconds,
        path="/",
        secure=settings.secure_cookie,
        httponly=True,
        samesite="Lax",
    )


def _clear_session_cookie(
    response: web.StreamResponse, settings: SessionAuthSettings
) -> None:
    response.del_cookie(
        settings.cookie_name,
        path="/",
        secure=settings.secure_cookie,
        httponly=True,
        samesite="Lax",
    )


def _set_login_csrf_cookie(
    response: web.StreamResponse, settings: SessionAuthSettings, token: str
) -> None:
    response.set_cookie(
        LOGIN_CSRF_COOKIE_NAME,
        token,
        max_age=LOGIN_CSRF_TTL_SECONDS,
        path="/login",
        secure=settings.secure_cookie,
        httponly=True,
        samesite="Strict",
    )


def _clear_login_csrf_cookie(
    response: web.StreamResponse, settings: SessionAuthSettings
) -> None:
    response.del_cookie(
        LOGIN_CSRF_COOKIE_NAME,
        path="/login",
        secure=settings.secure_cookie,
        httponly=True,
        samesite="Strict",
    )


def _login_page(
    settings: SessionAuthSettings,
    next_path: str,
    *,
    username: str = "",
    error: str = "",
    status: int = 200,
) -> web.Response:
    csrf_token = _new_login_csrf(settings)
    error_html = (
        f'<p class="login-error" role="alert">{html.escape(error)}</p>' if error else ""
    )
    body = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="theme-color" content="#101112">
    <title>Sign in · Codex Web</title>
    <link rel="stylesheet" href="/auth/login.css">
  </head>
  <body class="login-page">
    <main class="login-card">
      <div class="login-brand" aria-hidden="true">C</div>
      <h1>Sign in to Codex Web</h1>
      <p class="login-intro">Use the shared website login to access the shared workspace.</p>
      {error_html}
      <form method="post" action="/login" class="login-form">
        <input type="hidden" name="csrf_token" value="{html.escape(csrf_token, quote=True)}">
        <input type="hidden" name="next" value="{html.escape(next_path, quote=True)}">
        <label>
          <span>Username</span>
          <input name="username" value="{html.escape(username, quote=True)}" autocomplete="username" maxlength="512" required autofocus>
        </label>
        <label>
          <span>Password</span>
          <input name="password" type="password" autocomplete="current-password" maxlength="4096" required>
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>
"""
    response = web.Response(
        text=body,
        status=status,
        content_type="text/html",
        charset="utf-8",
    )
    _set_login_csrf_cookie(response, settings, csrf_token)
    return response


@web.middleware
async def security_headers(request: web.Request, handler):
    try:
        response = await handler(request)
    except web.HTTPException as exc:
        response = web.Response(status=exc.status, reason=exc.reason, text=exc.text)
        for name, value in exc.headers.items():
            if name.lower() not in {"content-length", "content-type"}:
                response.headers[name] = value
    response.headers.update(
        {
            "Cache-Control": "no-store",
            "Content-Security-Policy": (
                "default-src 'none'; style-src 'self'; form-action 'self'; "
                "base-uri 'none'; frame-ancestors 'none'"
            ),
            "Referrer-Policy": "same-origin",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
        }
    )
    return response


async def login_form(request: web.Request) -> web.Response:
    next_path = _safe_next(request.query.get("next", "/"))
    if _current_session(request) is not None:
        return _redirect(next_path)
    return _login_page(request.app[SETTINGS_KEY], next_path)


def _login_key(request: web.Request, user_id: str) -> str:
    forwarded = request.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
    peer = request.transport.get_extra_info("peername") if request.transport else None
    address = forwarded or (str(peer[0]) if peer else "unknown")
    return f"{address[:128]}\0{user_id[:512]}"


async def login(request: web.Request) -> web.Response:
    settings = request.app[SETTINGS_KEY]
    if not _same_origin(request):
        return web.json_response({"error": "Origin not allowed"}, status=403)
    if request.content_type != "application/x-www-form-urlencoded":
        return web.json_response({"error": "Form data required"}, status=415)
    form = await request.post()
    next_path = _safe_next(form.get("next", "/"))
    user_id = str(form.get("username", ""))
    password = str(form.get("password", ""))
    presented_csrf = str(form.get("csrf_token", ""))
    cookie_csrf = request.cookies.get(LOGIN_CSRF_COOKIE_NAME, "")
    if (
        not presented_csrf
        or not hmac.compare_digest(presented_csrf, cookie_csrf)
        or not _valid_login_csrf(settings, presented_csrf)
    ):
        return _login_page(
            settings,
            next_path,
            username=user_id,
            error="The sign-in form expired. Please try again.",
            status=403,
        )

    key = _login_key(request, user_id)
    limiter = request.app[LIMITER_KEY]
    if not limiter.allowed(key):
        return _login_page(
            settings,
            next_path,
            username=user_id,
            error="Too many attempts. Wait a minute and try again.",
            status=429,
        )
    credential = await asyncio.to_thread(
        request.app[CREDENTIALS_KEY].verify, user_id, password
    )
    if credential is None:
        limiter.failed(key)
        LOG.warning("failed website login")
        return _login_page(
            settings,
            next_path,
            username=user_id,
            error="The username or password is incorrect.",
            status=401,
        )

    limiter.succeeded(key)
    old_token = _session_token(request)
    if old_token:
        request.app[STORE_KEY].revoke(old_token)
    token, _ = request.app[STORE_KEY].create(credential)
    response = _redirect(next_path)
    _set_session_cookie(response, settings, token)
    _clear_login_csrf_cookie(response, settings)
    LOG.info("created session for %r", credential.user_id)
    return response


async def auth_check(request: web.Request) -> web.Response:
    current = _current_session(request)
    if current is not None:
        _, session = current
        return web.Response(
            status=204,
            headers={request.app[SETTINGS_KEY].user_header: session.user_id},
        )

    method = request.headers.get("X-Forwarded-Method", "GET").upper()
    original_uri = _safe_next(request.headers.get("X-Forwarded-Uri", "/"))
    accepts_html = "text/html" in request.headers.get("Accept", "").lower()
    if method in {"GET", "HEAD"} and accepts_html:
        response = _redirect(_login_location(original_uri))
    else:
        response = web.json_response({"error": "Authentication required"}, status=401)
    if _session_token(request):
        _clear_session_cookie(response, request.app[SETTINGS_KEY])
    return response


async def session_info(request: web.Request) -> web.Response:
    current = _current_session(request)
    if current is None:
        return web.json_response({"error": "Authentication required"}, status=401)
    token, session = current
    return web.json_response(
        {
            "user": {"id": session.user_id},
            "expiresAt": session.expires_at,
            "csrfToken": _csrf_token(request.app[SETTINGS_KEY], token),
            "logoutPath": "/logout",
        }
    )


async def logout(request: web.Request) -> web.Response:
    settings = request.app[SETTINGS_KEY]
    if not _same_origin(request):
        return web.json_response({"error": "Origin not allowed"}, status=403)
    if request.content_type != "application/x-www-form-urlencoded":
        return web.json_response({"error": "Form data required"}, status=415)
    current = _current_session(request)
    if current is None:
        response = _redirect("/login")
        _clear_session_cookie(response, settings)
        return response
    token, _ = current
    form = await request.post()
    presented_csrf = str(form.get("csrf_token", ""))
    if not hmac.compare_digest(presented_csrf, _csrf_token(settings, token)):
        return web.json_response({"error": "Invalid CSRF token"}, status=403)
    request.app[STORE_KEY].revoke(token)
    response = _redirect("/login")
    _clear_session_cookie(response, settings)
    LOG.info("revoked session")
    return response


async def login_stylesheet(_: web.Request) -> web.FileResponse:
    return web.FileResponse(Path(__file__).parent / "static" / "login.css")


async def health(_: web.Request) -> web.Response:
    return web.json_response({"ok": True})


def create_app(
    settings: SessionAuthSettings | None = None,
    credentials: CredentialStore | None = None,
    store: SessionStore | None = None,
    limiter: FailedLoginLimiter | None = None,
) -> web.Application:
    settings = settings or SessionAuthSettings.from_env()
    credentials = credentials or CredentialStore.load(settings.credentials_path)
    store = store or SessionStore(settings.database_path, settings.session_ttl_seconds)
    application = web.Application(middlewares=[security_headers], client_max_size=16384)
    application[SETTINGS_KEY] = settings
    application[CREDENTIALS_KEY] = credentials
    application[STORE_KEY] = store
    application[LIMITER_KEY] = limiter or FailedLoginLimiter()
    application.add_routes(
        [
            web.get("/login", login_form),
            web.post("/login", login),
            web.post("/logout", logout),
            web.get("/auth/check", auth_check),
            web.get("/auth/session", session_info),
            web.get("/auth/login.css", login_stylesheet),
            web.get("/healthz", health),
        ]
    )
    return application


def _password_record(password: str) -> PasswordRecord:
    encoded = password.encode("utf-8", errors="surrogatepass")
    if not encoded or len(encoded) > MAX_PASSWORD_BYTES:
        raise ConfigurationError(
            f"password must contain 1 to {MAX_PASSWORD_BYTES} UTF-8 bytes"
        )
    salt = secrets.token_bytes(16)
    template = PasswordRecord(
        salt=salt,
        digest=b"\0" * 32,
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    )
    return PasswordRecord(
        salt=salt,
        digest=template.derive(encoded),
        n=template.n,
        r=template.r,
        p=template.p,
        dklen=template.dklen,
    )


def _atomic_private_write(path: Path, content: bytes, *, replace: bool = True) -> None:
    if not path.is_absolute() or not path.parent.is_dir():
        raise ConfigurationError("output parent must be an existing absolute path")
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            try:
                os.link(temporary, path)
            except FileExistsError as exc:
                raise ConfigurationError(
                    f"output already exists (use --force to replace it): {path}"
                ) from exc
            temporary.unlink()
        path.chmod(0o600)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _write_credentials(args: argparse.Namespace) -> None:
    user_id = _identity(args.user, "--user")
    if args.password_stdin:
        password = sys.stdin.readline(MAX_PASSWORD_BYTES + 2).rstrip("\r\n")
    else:
        password = getpass.getpass("Password: ")
        confirmation = getpass.getpass("Confirm password: ")
        if not hmac.compare_digest(password, confirmation):
            raise ConfigurationError("passwords do not match")
    record = _password_record(password)
    path = Path(args.output)
    users: dict[str, Credential] = {}
    if path.exists():
        users.update(CredentialStore.load(path).users)
    users[user_id] = Credential(user_id=user_id, password=record)
    document = {
        "version": 1,
        "users": [
            {"id": credential.user_id, "password": credential.password.document()}
            for credential in users.values()
        ],
    }
    content = (json.dumps(document, indent=2) + "\n").encode()
    _atomic_private_write(path, content)


def _write_secret(args: argparse.Namespace) -> None:
    _atomic_private_write(
        Path(args.output),
        (secrets.token_hex(32) + "\n").encode(),
        replace=args.force,
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    credential = commands.add_parser(
        "set-password",
        aliases=["hash-password"],
        description="Add or update a user in a version 1 scrypt credential file",
    )
    credential.add_argument("--user", required=True)
    credential.add_argument("--output", required=True)
    credential.add_argument("--password-stdin", action="store_true")
    secret = commands.add_parser(
        "generate-secret", description="Create a random session secret file"
    )
    secret.add_argument("--output", required=True)
    secret.add_argument("--force", action="store_true")
    return parser


def main() -> None:
    if len(sys.argv) > 1:
        args = _parser().parse_args()
        try:
            if args.command in {"set-password", "hash-password"}:
                _write_credentials(args)
            else:
                _write_secret(args)
        except ConfigurationError as exc:
            raise SystemExit(str(exc)) from exc
        return

    logging.basicConfig(level=logging.INFO)
    try:
        application = create_app()
    except ConfigurationError as exc:
        raise SystemExit(
            f"Invalid session authentication configuration: {exc}"
        ) from exc
    web.run_app(
        application,
        host=_env("CODEX_WEB_SESSION_HOST", "0.0.0.0"),
        port=_integer("CODEX_WEB_SESSION_PORT", 9000, 1, 65535),
    )


if __name__ == "__main__":
    main()
