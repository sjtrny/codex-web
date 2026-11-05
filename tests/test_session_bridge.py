import base64
import tempfile
import unittest
from pathlib import Path

from aiohttp import ClientSession, web

import session_bridge
import session_auth


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.app = session_bridge.create_app(self.root, "team", "fixture-password", "https://codex.example.com")
        self.runner = web.AppRunner(self.app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        self.url = "http://127.0.0.1:" + str(self.site._server.sockets[0].getsockname()[1])
        self.client = ClientSession()
        self.basic = "Basic " + base64.b64encode(b"team:fixture-password").decode()

    async def asyncTearDown(self):
        await self.client.close()
        await self.runner.cleanup()
        self.tmp.cleanup()

    async def verify(self, **headers):
        async with self.client.get(self.url + "/internal/verify", headers=headers, allow_redirects=False) as response:
            await response.read()
            return response

    async def test_cached_basic_login_migrates_to_cookie(self):
        response = await self.verify(Authorization=self.basic)
        self.assertEqual(response.status, 204)
        cookie = response.cookies[session_bridge.COOKIE_NAME]
        self.assertTrue(cookie["secure"])
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["path"], "/")
        self.assertEqual(cookie["domain"], "")
        self.assertEqual(cookie["samesite"], "Lax")
        self.assertNotIn("WWW-Authenticate", response.headers)
        checked = await self.verify(Cookie=f"{session_bridge.COOKIE_NAME}={cookie.value}")
        self.assertEqual(checked.status, 204)
        self.assertEqual(checked.headers["Authorization"], self.basic)

    async def test_invalid_credentials_never_trigger_native_prompt(self):
        for presented in ("", "Bearer fake", "Basic invalid!", "Basic " + base64.b64encode(b"team:wrong").decode()):
            response = await self.verify(Authorization=presented, Accept="application/json")
            self.assertEqual(response.status, 401)
            self.assertNotIn("WWW-Authenticate", response.headers)
            self.assertNotIn("Authorization", response.headers)

    async def test_forged_cookie_and_identity_headers_do_not_authorize(self):
        response = await self.verify(Cookie=f"{session_bridge.COOKIE_NAME}=" + "x" * 43, **{"X-Codex-Web-User": "team"})
        self.assertEqual(response.status, 401)

    async def test_websocket_and_writes_require_exact_origin(self):
        for path, method in (("/ws", "GET"), ("/api/upload", "POST")):
            for origin in ("", "https://evil.example", "https://codex.example.com.evil.example"):
                response = await self.verify(Authorization=self.basic, Origin=origin, **{"X-Forwarded-Uri": path, "X-Forwarded-Method": method})
                self.assertEqual(response.status, 403)
        response = await self.verify(Authorization=self.basic, Origin="https://codex.example.com", **{"X-Forwarded-Uri": "/ws"})
        self.assertEqual(response.status, 204)

    async def test_session_survives_recreation_and_password_change_revokes_it(self):
        credential = self.app[session_auth.CREDENTIALS_KEY].users["team"]
        token, _ = self.app[session_auth.STORE_KEY].create(credential)
        restarted = session_bridge.create_app(self.root, "team", "fixture-password", "https://codex.example.com")
        self.assertIsNotNone(restarted[session_auth.STORE_KEY].lookup(token, restarted[session_auth.CREDENTIALS_KEY]))
        changed = session_bridge.create_app(self.root, "team", "new-fixture-password", "https://codex.example.com")
        self.assertIsNone(changed[session_auth.STORE_KEY].lookup(token, changed[session_auth.CREDENTIALS_KEY]))

    async def test_navigation_preserves_safe_destination(self):
        response = await self.verify(Accept="text/html", **{"X-Forwarded-Uri": "/?thread=fixture"})
        self.assertEqual(response.status, 303)
        self.assertIn("next=", response.headers["Location"])
        self.assertNotIn("WWW-Authenticate", response.headers)

    async def test_invalid_public_origin_is_rejected_before_writing_state(self):
        for origin in (
            "", "http://codex.example.com", "https://codex.example.com/",
            "https://codex.example.com/path", "https://user@codex.example.com",
            "https://codex.example.com?next=evil", "https://codex.example.com#fragment",
            "https://codex.example.com:", "https://codex.example.com:bad",
            "https://codex.example.com\n", "https://[broken",
        ):
            with self.subTest(origin=origin):
                state = self.root / "invalid"
                with self.assertRaises(session_auth.ConfigurationError):
                    session_bridge.create_app(state, "team", "fixture-password", origin)
                self.assertFalse(state.exists())

    async def test_valid_https_origin_with_port(self):
        app = session_bridge.create_app(
            self.root, "team", "fixture-password", "https://codex.example.com:8443",
        )
        self.assertEqual(
            app[session_auth.SETTINGS_KEY].allowed_origins,
            frozenset({"https://codex.example.com:8443"}),
        )


if __name__ == "__main__":
    unittest.main()
