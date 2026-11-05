from __future__ import annotations

import io
import json
import os
import stat
import sys
import tempfile
import unittest
from http.cookies import SimpleCookie
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from aiohttp import ClientSession, CookieJar, web

import session_auth


class SessionAuthTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.now = [1_800_000_000.0]
        record = session_auth._password_record("password")
        self.credential = session_auth.Credential("user", record)
        self.credentials = session_auth.CredentialStore(
            {self.credential.user_id: self.credential}
        )
        self.settings = session_auth.SessionAuthSettings(
            credentials_path=self.root / "credentials.json",
            session_secret=b"s" * 32,
            database_path=self.root / "sessions.sqlite3",
            allowed_origins=frozenset({"http://codex.example.test"}),
            secure_cookie=False,
            session_ttl_seconds=30 * 24 * 60 * 60,
        )
        self.store = session_auth.SessionStore(
            self.settings.database_path,
            self.settings.session_ttl_seconds,
            clock=lambda: self.now[0],
        )
        application = session_auth.create_app(
            settings=self.settings,
            credentials=self.credentials,
            store=self.store,
        )
        self.runner = web.AppRunner(application)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        port = self.site._server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        self.client = ClientSession(cookie_jar=CookieJar(unsafe=True))

    async def asyncTearDown(self) -> None:
        await self.client.close()
        await self.runner.cleanup()
        self.tempdir.cleanup()

    async def login_csrf(self) -> str:
        async with self.client.get(f"{self.url}/login") as response:
            body = await response.text()
            self.assertEqual(response.status, 200)
            token = response.cookies[session_auth.LOGIN_CSRF_COOKIE_NAME].value
            self.assertIn(f'name="csrf_token" value="{token}"', body)
            return token

    async def sign_in(
        self,
        *,
        user: str = "user",
        password: str = "password",
        next_path: str = "/",
        origin: str = "http://codex.example.test",
    ) -> tuple[int, str, SimpleCookie]:
        csrf = await self.login_csrf()
        async with self.client.post(
            f"{self.url}/login",
            data={
                "username": user,
                "password": password,
                "csrf_token": csrf,
                "next": next_path,
            },
            headers={"Origin": origin},
            allow_redirects=False,
        ) as response:
            await response.read()
            return (
                response.status,
                response.headers.get("Location", ""),
                response.cookies,
            )

    async def test_login_issues_persistent_opaque_session(self) -> None:
        status, location, cookies = await self.sign_in(next_path="/?thread=private")
        self.assertEqual(status, 303)
        self.assertEqual(location, "/?thread=private")
        cookie = cookies[self.settings.cookie_name]
        self.assertRegex(cookie.value, session_auth.SESSION_TOKEN_PATTERN)
        self.assertEqual(int(cookie["max-age"]), self.settings.session_ttl_seconds)
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "Lax")

        async with self.client.get(f"{self.url}/auth/session") as response:
            payload = await response.json()
            self.assertEqual(response.status, 200)
            self.assertEqual(payload["user"], {"id": "user"})
            self.assertEqual(
                payload["expiresAt"],
                int(self.now[0]) + self.settings.session_ttl_seconds,
            )
            self.assertTrue(payload["csrfToken"])

    async def test_forward_auth_copies_identity_only_for_valid_session(self) -> None:
        async with self.client.get(
            f"{self.url}/auth/check",
            headers={
                "Accept": "application/json",
                "X-Forwarded-Method": "GET",
                "X-Forwarded-Uri": "/api/config",
            },
            allow_redirects=False,
        ) as response:
            self.assertEqual(response.status, 401)
            self.assertNotIn(self.settings.user_header, response.headers)

        await self.sign_in()
        async with self.client.get(f"{self.url}/auth/check") as response:
            self.assertEqual(response.status, 204)
            self.assertEqual(response.headers[self.settings.user_header], "user")

    async def test_unauthenticated_navigation_redirects_to_login_safely(self) -> None:
        async with self.client.get(
            f"{self.url}/auth/check",
            headers={
                "Accept": "text/html,application/xhtml+xml",
                "X-Forwarded-Method": "GET",
                "X-Forwarded-Uri": "/?thread=private",
            },
            allow_redirects=False,
        ) as response:
            self.assertEqual(response.status, 303)
            location = urlsplit(response.headers["Location"])
            self.assertEqual(location.path, "/login")
            self.assertEqual(parse_qs(location.query), {"next": ["/?thread=private"]})

        async with self.client.get(
            f"{self.url}/auth/check",
            headers={
                "Accept": "text/html",
                "X-Forwarded-Method": "GET",
                "X-Forwarded-Uri": "https://evil.example/steal",
            },
            allow_redirects=False,
        ) as response:
            self.assertEqual(response.headers["Location"], "/login")

    async def test_bad_password_and_cross_origin_login_create_no_session(self) -> None:
        status, _, cookies = await self.sign_in(password="wrong")
        self.assertEqual(status, 401)
        self.assertNotIn(self.settings.cookie_name, cookies)

    async def test_repeated_failed_logins_are_rate_limited(self) -> None:
        for _ in range(session_auth.MAX_FAILED_LOGINS):
            status, _, _ = await self.sign_in(password="wrong")
            self.assertEqual(status, 401)
        status, _, _ = await self.sign_in(password="wrong")
        self.assertEqual(status, 429)

        status, _, cookies = await self.sign_in(origin="http://evil.example")
        self.assertEqual(status, 403)
        self.assertNotIn(self.settings.cookie_name, cookies)

    async def test_login_rejects_missing_or_forged_csrf_token(self) -> None:
        await self.login_csrf()
        async with self.client.post(
            f"{self.url}/login",
            data={"username": "user", "password": "password", "csrf_token": "bad"},
            headers={"Origin": "http://codex.example.test"},
            allow_redirects=False,
        ) as response:
            self.assertEqual(response.status, 403)
            self.assertNotIn(self.settings.cookie_name, response.cookies)

    async def test_logout_requires_csrf_and_revokes_server_session(self) -> None:
        _, _, cookies = await self.sign_in()
        token = cookies[self.settings.cookie_name].value
        async with self.client.get(f"{self.url}/auth/session") as response:
            csrf = (await response.json())["csrfToken"]

        async with self.client.post(
            f"{self.url}/logout",
            data={"csrf_token": "wrong"},
            headers={"Origin": "http://codex.example.test"},
            allow_redirects=False,
        ) as response:
            self.assertEqual(response.status, 403)
        self.assertIsNotNone(self.store.lookup(token, self.credentials))

        async with self.client.post(
            f"{self.url}/logout",
            data={"csrf_token": csrf},
            headers={"Origin": "http://codex.example.test"},
            allow_redirects=False,
        ) as response:
            self.assertEqual(response.status, 303)
            self.assertEqual(response.headers["Location"], "/login")
            self.assertEqual(
                response.cookies[self.settings.cookie_name]["max-age"], "0"
            )
        self.assertIsNone(self.store.lookup(token, self.credentials))

    async def test_cross_origin_logout_is_rejected(self) -> None:
        _, _, cookies = await self.sign_in()
        token = cookies[self.settings.cookie_name].value
        async with self.client.get(f"{self.url}/auth/session") as response:
            csrf = (await response.json())["csrfToken"]
        async with self.client.post(
            f"{self.url}/logout",
            data={"csrf_token": csrf},
            headers={"Origin": "http://evil.example"},
            allow_redirects=False,
        ) as response:
            self.assertEqual(response.status, 403)
        self.assertIsNotNone(self.store.lookup(token, self.credentials))

    async def test_expired_session_fails_closed(self) -> None:
        _, _, cookies = await self.sign_in()
        token = cookies[self.settings.cookie_name].value
        self.now[0] += self.settings.session_ttl_seconds + 1
        async with self.client.get(f"{self.url}/auth/session") as response:
            self.assertEqual(response.status, 401)
        self.assertIsNone(self.store.lookup(token, self.credentials))

    async def test_sessions_survive_restart_and_password_change_revokes_them(
        self,
    ) -> None:
        token, expected = self.store.create(self.credential)
        reopened = session_auth.SessionStore(
            self.settings.database_path,
            self.settings.session_ttl_seconds,
            clock=lambda: self.now[0],
        )
        self.assertEqual(reopened.lookup(token, self.credentials), expected)
        replacement = session_auth.Credential(
            "user", session_auth._password_record("new-password")
        )
        changed_credentials = session_auth.CredentialStore({"user": replacement})
        self.assertIsNone(reopened.lookup(token, changed_credentials))

    async def test_second_login_rotates_the_existing_session(self) -> None:
        _, _, first_cookies = await self.sign_in()
        first = first_cookies[self.settings.cookie_name].value
        csrf = session_auth._new_login_csrf(self.settings)
        async with self.client.post(
            f"{self.url}/login",
            data={
                "username": "user",
                "password": "password",
                "csrf_token": csrf,
                "next": "/",
            },
            cookies={session_auth.LOGIN_CSRF_COOKIE_NAME: csrf},
            headers={"Origin": "http://codex.example.test"},
            allow_redirects=False,
        ) as response:
            await response.read()
            self.assertEqual(response.status, 303)
            second_cookies = response.cookies
        second = second_cookies[self.settings.cookie_name].value
        self.assertNotEqual(first, second)
        self.assertIsNone(self.store.lookup(first, self.credentials))
        self.assertIsNotNone(self.store.lookup(second, self.credentials))


class SessionAuthConfigurationTests(unittest.TestCase):
    def test_credential_file_uses_scrypt_and_requires_safe_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credentials.json"
            record = session_auth._password_record("password")
            path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "users": [{"id": "user", "password": record.document()}],
                    }
                ),
                encoding="utf-8",
            )
            path.chmod(0o600)
            credentials = session_auth.CredentialStore.load(path)
            self.assertIsNotNone(credentials.verify("user", "password"))
            self.assertIsNone(credentials.verify("user", "wrong"))
            self.assertIsNone(credentials.verify("unknown", "password"))
            path.chmod(0o622)
            with self.assertRaisesRegex(
                session_auth.ConfigurationError, "group/world writable"
            ):
                session_auth.CredentialStore.load(path)

    def test_secure_cookie_attribute_is_set_for_https(self) -> None:
        settings = session_auth.SessionAuthSettings(
            credentials_path=Path("/credentials"),
            session_secret=b"s" * 32,
            database_path=Path("/sessions"),
            allowed_origins=frozenset({"https://codex.example.test"}),
            secure_cookie=True,
        )
        response = web.Response()
        session_auth._set_session_cookie(response, settings, "t" * 43)
        self.assertTrue(response.cookies[settings.cookie_name]["secure"])

    def test_session_database_is_owner_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sessions.sqlite3"
            session_auth.SessionStore(path, 600)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_password_cli_adds_users_without_replacing_existing_accounts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credentials.json"
            for user_id, password in (("alice", "first"), ("bob", "second")):
                args = SimpleNamespace(
                    user=user_id,
                    output=str(path),
                    password_stdin=True,
                )
                with mock.patch.object(sys, "stdin", io.StringIO(f"{password}\n")):
                    session_auth._write_credentials(args)
            credentials = session_auth.CredentialStore.load(path)
            self.assertEqual(set(credentials.users), {"alice", "bob"})
            self.assertIsNotNone(credentials.verify("alice", "first"))
            self.assertIsNotNone(credentials.verify("bob", "second"))

    def test_secret_cli_refuses_accidental_rotation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session-secret"
            args = SimpleNamespace(output=str(path), force=False)
            session_auth._write_secret(args)
            original = path.read_bytes()
            with self.assertRaisesRegex(session_auth.ConfigurationError, "--force"):
                session_auth._write_secret(args)
            self.assertEqual(path.read_bytes(), original)
            session_auth._write_secret(SimpleNamespace(output=str(path), force=True))
            self.assertNotEqual(path.read_bytes(), original)

    def test_environment_requires_https_or_explicit_insecure_opt_in(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            credentials = root / "credentials.json"
            credentials.write_text("{}", encoding="utf-8")
            credentials.chmod(0o600)
            secret = root / "secret"
            secret.write_bytes(b"s" * 32)
            secret.chmod(0o600)
            environment = {
                "CODEX_WEB_SESSION_CREDENTIALS_FILE": str(credentials),
                "CODEX_WEB_SESSION_SECRET_FILE": str(secret),
                "CODEX_WEB_SESSION_DB": str(root / "sessions.sqlite3"),
                "CODEX_WEB_SESSION_ALLOWED_ORIGINS": "http://192.0.2.10:8876",
            }
            with mock.patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(
                    session_auth.ConfigurationError, "require HTTPS"
                ):
                    session_auth.SessionAuthSettings.from_env()
                os.environ["CODEX_WEB_SESSION_ALLOW_INSECURE_HTTP"] = "true"
                settings = session_auth.SessionAuthSettings.from_env()
            self.assertFalse(settings.secure_cookie)

    def test_environment_rejects_mixed_http_and_https_origins(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            credentials = root / "credentials.json"
            credentials.write_text("{}", encoding="utf-8")
            credentials.chmod(0o600)
            secret = root / "secret"
            secret.write_bytes(b"s" * 32)
            secret.chmod(0o600)
            environment = {
                "CODEX_WEB_SESSION_CREDENTIALS_FILE": str(credentials),
                "CODEX_WEB_SESSION_SECRET_FILE": str(secret),
                "CODEX_WEB_SESSION_DB": str(root / "sessions.sqlite3"),
                "CODEX_WEB_SESSION_ALLOWED_ORIGINS": (
                    "https://codex.example.test,http://localhost:8876"
                ),
                "CODEX_WEB_SESSION_ALLOW_INSECURE_HTTP": "true",
            }
            with (
                mock.patch.dict(os.environ, environment, clear=True),
                self.assertRaisesRegex(
                    session_auth.ConfigurationError, "cannot mix HTTP and HTTPS"
                ),
            ):
                session_auth.SessionAuthSettings.from_env()


if __name__ == "__main__":
    unittest.main()
