"""Runs inside the disposable Traefik/Caddy fixture, using synthetic credentials."""
import asyncio
import base64
import json
from pathlib import Path

from aiohttp import ClientSession, CookieJar

ORIGIN = "https://codex.example.com"
URL = "https://session-login-edge:8443"
COOKIE = "__Host-codex_web_session"
BASIC = "Basic " + base64.b64encode(b"team:fixture-password").decode()


async def main():
    checks = []
    headers = {"Host": "codex.example.com", "Origin": ORIGIN}
    async with ClientSession(headers=headers, cookie_jar=CookieJar(unsafe=True)) as client:
        for _ in range(100):
            try:
                old = await client.ws_connect(URL + "/ws", headers={"Authorization": BASIC}, ssl=False)
                break
            except Exception:
                await asyncio.sleep(.1)
        else:
            raise AssertionError("Old route unavailable")
        await old.send_str("before-cutover")
        assert (await old.receive(timeout=3)).data == "before-cutover"
        Path("/tmp/connection-ready").touch()
        for _ in range(200):
            if Path("/tmp/config-switched").exists():
                break
            await asyncio.sleep(.1)
        else:
            raise AssertionError("No route switch")
        for _ in range(100):
            async with client.get(URL + "/healthz", ssl=False, allow_redirects=False) as response:
                if response.headers.get("X-Codex-Session-Login") == "1":
                    break
            await asyncio.sleep(.1)
        else:
            raise AssertionError("New route unavailable")
        await old.send_str("after-cutover")
        assert (await old.receive(timeout=3)).data == "after-cutover"
        checks.append("Existing authenticated WebSocket survives Traefik route replacement and exchanges data")

        async with client.get(URL + "/", headers={"Accept": "text/html"}, ssl=False, allow_redirects=False) as response:
            assert response.status == 303
            assert response.headers["Location"] == "/login"
            assert "WWW-Authenticate" not in response.headers
        checks.append("Unauthenticated navigation opens normal login without browser challenge")
        async with client.get(URL + "/ws", ssl=False, allow_redirects=False) as response:
            assert response.status == 401
            assert "WWW-Authenticate" not in response.headers
        checks.append("Unauthenticated WebSocket denied without repeated password prompt")

        async def login(password="fixture-password", origin=ORIGIN, csrf_ok=True):
            async with client.get(URL + "/login", ssl=False) as response:
                assert response.status == 200
                assert "shared website login" in await response.text()
                csrf = response.cookies["codex_web_login_csrf"].value
            data = {"username": "team", "password": password, "csrf_token": csrf if csrf_ok else "wrong", "next": "/healthz"}
            async with client.post(URL + "/login", data=data, headers={"Origin": origin}, ssl=False, allow_redirects=False) as response:
                await response.read()
                return response

        assert (await login("wrong")).status == 401
        assert (await login(csrf_ok=False)).status == 403
        assert (await login(origin="https://evil.example")).status == 403
        checks.append("Wrong password, forged CSRF and cross-origin login rejected")
        response = await login()
        assert response.status == 303
        cookie = response.cookies[COOKIE]
        assert cookie["secure"] and cookie["httponly"] and cookie["samesite"] == "Lax" and cookie["path"] == "/" and not cookie["domain"]
        checks.append("Normal login issues Secure HttpOnly host-only session cookie")

        async with client.get(URL + "/healthz", ssl=False) as response:
            assert response.status == 200, response.status
            payload = await response.json()
            assert not payload["authorization_reached_backend"]
            assert "Authorization" not in response.headers
        checks.append("Cookie authorizes existing gateway; upstream credential never reaches browser or Codex backend")
        for _ in range(3):
            async with client.ws_connect(URL + "/ws", ssl=False) as socket:
                await socket.send_str("cookie-only")
                assert (await socket.receive(timeout=3)).data == "cookie-only"
        checks.append("Three cookie-only WebSocket reconnects exchange data without Basic Auth")
        async with client.get(URL + "/ws", headers={"Origin": "https://evil.example"}, ssl=False, allow_redirects=False) as response:
            assert response.status == 403
        checks.append("Cross-origin WebSocket rejected even with valid session")
        async with client.post(URL + "/upload", data=b"x" * (1024 * 1024), ssl=False) as response:
            assert response.status == 200
            assert (await response.json())["body_bytes"] == 1024 * 1024
        checks.append("Uploads pass through unchanged without auth middleware buffering the body")
        for path in ("/internal/verify", "/auth/check", "/auth/login.css/../check"):
            async with client.get(URL + path, ssl=False, allow_redirects=False) as response:
                assert response.status == 404
                assert "Authorization" not in response.headers
                assert BASIC not in await response.text()
        checks.append("Internal credential bridge is not publicly routed")

        async with client.get(URL + "/auth/session", ssl=False) as response:
            session = await response.json()
        async with client.post(URL + "/logout", data={"csrf_token": session["csrfToken"]}, ssl=False, allow_redirects=False) as response:
            assert response.status == 303
        async with client.get(URL + "/healthz", ssl=False, allow_redirects=False) as response:
            assert response.status == 401
        checks.append("Logout revokes session without revoking any other browser session")

        async with client.get(URL + "/healthz", headers={"Authorization": BASIC}, ssl=False) as response:
            assert response.status == 200
            assert COOKIE in response.cookies
            assert "Authorization" not in response.headers
        async with client.ws_connect(URL + "/ws", ssl=False) as socket:
            await socket.send_str("migrated")
            assert (await socket.receive(timeout=3)).data == "migrated"
        checks.append("Existing Basic Auth client obtains a cookie and can subsequently connect without credentials")
        await old.send_str("still-connected-after-tests")
        assert (await old.receive(timeout=3)).data == "still-connected-after-tests"
        await old.close()
    print(json.dumps({"checks_passed": len(checks), "checks": checks}, indent=2), flush=True)


asyncio.run(main())
