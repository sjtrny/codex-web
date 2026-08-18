from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from aiohttp import ClientSession, FormData, WSMsgType, web

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
codex_web = importlib.import_module("app")


class ProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.socket_path = str(Path(self.tempdir.name) / "fake-codex.sock")
        self.upload_path = Path(self.tempdir.name) / "uploads"
        self.old_env = {
            name: os.environ.get(name)
            for name in (
                "CODEX_APP_SERVER_SOCKET",
                "CODEX_APP_SERVER_URL",
                "CODEX_WORKSPACE_ROOT",
                "CODEX_UPLOAD_DIR",
                "CODEX_UPLOAD_HOST_DIR",
                "CODEX_UPLOAD_MAX_BYTES",
                "CODEX_UPLOAD_MAX_FILES",
                "CODEX_UPLOAD_TOTAL_BYTES",
            )
        }
        os.environ["CODEX_APP_SERVER_SOCKET"] = self.socket_path
        os.environ.pop("CODEX_APP_SERVER_URL", None)
        self.workspace_path = Path(self.tempdir.name) / "workspaces"
        self.workspace_path.mkdir()
        os.environ["CODEX_WORKSPACE_ROOT"] = str(self.workspace_path)
        os.environ["CODEX_UPLOAD_DIR"] = str(self.upload_path)
        os.environ["CODEX_UPLOAD_HOST_DIR"] = "/workspaces/codex-web/uploads"
        os.environ["CODEX_UPLOAD_MAX_BYTES"] = str(1024 * 1024)
        os.environ["CODEX_UPLOAD_MAX_FILES"] = "4"
        os.environ["CODEX_UPLOAD_TOTAL_BYTES"] = str(2 * 1024 * 1024)

        backend = web.Application()

        async def echo(request: web.Request) -> web.WebSocketResponse:
            socket = web.WebSocketResponse()
            await socket.prepare(request)
            async for message in socket:
                if message.type is WSMsgType.TEXT:
                    await socket.send_str(message.data)
            return socket

        backend.router.add_get("/", echo)
        self.backend_runner = web.AppRunner(backend)
        await self.backend_runner.setup()
        self.backend_site = web.UnixSite(self.backend_runner, self.socket_path)
        await self.backend_site.start()

        self.frontend_runner = web.AppRunner(codex_web.create_app())
        await self.frontend_runner.setup()
        self.frontend_site = web.TCPSite(self.frontend_runner, "127.0.0.1", 0)
        await self.frontend_site.start()
        socket = self.frontend_site._server.sockets[0]
        self.port = socket.getsockname()[1]

    async def asyncTearDown(self) -> None:
        await self.frontend_runner.cleanup()
        await self.backend_runner.cleanup()
        self.tempdir.cleanup()
        for name, value in self.old_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    async def test_proxies_json_over_unix_websocket(self) -> None:
        async with (
            ClientSession() as session,
            session.ws_connect(
                f"http://127.0.0.1:{self.port}/ws",
                headers={"Origin": "http://host.example:9999"},
            ) as socket,
        ):
            connected = json.loads((await socket.receive()).data)
            self.assertEqual(connected["method"], "codex-web/connected")
            payload = {"method": "initialize", "id": 1, "params": {}}
            await socket.send_json(payload)
            echoed = json.loads((await socket.receive()).data)
            self.assertEqual(echoed, payload)

    async def test_accepts_any_browser_origin_without_authentication(self) -> None:
        async with (
            ClientSession() as session,
            session.ws_connect(
                f"http://127.0.0.1:{self.port}/ws",
                headers={"Origin": "https://unrelated.example"},
            ) as socket,
        ):
            connected = json.loads((await socket.receive()).data)
            self.assertEqual(connected["method"], "codex-web/connected")

    async def test_index_requires_no_authentication(self) -> None:
        async with (
            ClientSession() as session,
            session.get(f"http://127.0.0.1:{self.port}/") as response,
        ):
            body = await response.text()
            self.assertEqual(response.status, 200)
            self.assertIn('id="menu"', body)
            self.assertIn('aria-controls="sidebar"', body)
            self.assertIn('id="settings-toggle"', body)
            self.assertIn('id="setting-model"', body)
            self.assertIn('id="setting-permissions"', body)
            self.assertIn('id="preferences-toggle"', body)
            self.assertIn('id="preferences-dialog"', body)
            self.assertIn('id="theme-system"', body)
            self.assertIn('id="theme-light"', body)
            self.assertIn('id="theme-dark"', body)
            self.assertNotIn('id="status"', body)
            self.assertNotIn('id="theme-toggle"', body)
            self.assertIn('id="jump-present"', body)
            self.assertIn("Jump to present", body)
            self.assertIn('id="thinking-indicator"', body)
            self.assertIn("Codex is thinking", body)
            self.assertIn('aria-busy="false"', body)
            self.assertIn("/static/vendor/markdown.css", body)
            self.assertIn("/static/vendor/markdown.js", body)
            self.assertIn("/static/theme.js", body)
            self.assertLess(
                body.index("/static/theme.js"),
                body.index("/static/style.css"),
            )
            self.assertNotIn("cdn.jsdelivr.net", body)
            self.assertIn("viewport-fit=cover", body)
            self.assertIn(
                "style-src 'self' 'unsafe-inline'",
                response.headers["Content-Security-Policy"],
            )
            self.assertIn(
                "script-src 'self'", response.headers["Content-Security-Policy"]
            )

    async def test_markdown_assets_are_self_hosted(self) -> None:
        async with ClientSession() as session:
            for asset, marker in (
                ("markdown.js", "CodexMarkdown"),
                ("markdown.css", ".katex"),
            ):
                async with session.get(
                    f"http://127.0.0.1:{self.port}/static/vendor/{asset}"
                ) as response:
                    body = await response.text()
                    self.assertEqual(response.status, 200)
                self.assertIn(marker, body)
                if asset == "markdown.js":
                    self.assertIn("Copy code to clipboard", body)

    async def test_theme_asset_is_self_hosted(self) -> None:
        async with (
            ClientSession() as session,
            session.get(f"http://127.0.0.1:{self.port}/static/theme.js") as response,
        ):
            body = await response.text()
            self.assertEqual(response.status, 200)
            self.assertIn("codex-web-theme-v1", body)
            self.assertIn("prefers-color-scheme", body)

    async def test_layout_constrains_large_message_history(self) -> None:
        async with (
            ClientSession() as session,
            session.get(f"http://127.0.0.1:{self.port}/static/style.css") as response,
        ):
            stylesheet = await response.text()
            self.assertEqual(response.status, 200)
            self.assertIn(
                "grid-template-rows: auto auto auto minmax(0, 1fr) auto auto",
                stylesheet,
            )
            self.assertIn(
                ".messages-region { grid-row: 4; position: relative;", stylesheet
            )
            self.assertIn(".messages { min-width: 0; min-height: 0;", stylesheet)
            self.assertIn(".jump-present {", stylesheet)
            self.assertIn(".thinking-indicator {", stylesheet)
            self.assertIn("@keyframes thinking-pulse", stylesheet)
            self.assertIn(".copy-code {", stylesheet)
            self.assertIn(".clipboard-buffer {", stylesheet)
            self.assertIn(
                ".message .body .code-block pre { margin: 0; padding-right: 54px; }",
                stylesheet,
            )
            self.assertNotIn(".code-block pre { padding-top:", stylesheet)
            self.assertIn(':root[data-theme="dark"] {', stylesheet)
            self.assertIn(".preferences-dialog {", stylesheet)
            self.assertIn(".settings-cog {", stylesheet)
            self.assertIn(".settings-panel { grid-row: 2;", stylesheet)
            self.assertIn(
                ".settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr));",
                stylesheet,
            )
            self.assertIn("height: 100dvh", stylesheet)
            self.assertIn(".sidebar.open { transform: translateX(0); }", stylesheet)
            self.assertIn(
                ".thread.running { border-left-color: var(--success); }", stylesheet
            )
            self.assertIn(
                'grid-template-areas: "attachments attachments" "prompt prompt" "attach send";',
                stylesheet,
            )
            self.assertIn(
                "grid-template-columns: auto minmax(0, 1fr);",
                stylesheet,
            )

    async def test_uploads_native_image_and_general_file(self) -> None:
        png = b"\x89PNG\r\n\x1a\n" + (b"\x00" * 32)
        form = FormData()
        form.add_field(
            "files",
            png,
            filename="../../screen shot.png",
            content_type="application/octet-stream",
        )
        form.add_field(
            "files",
            b"notes",
            filename="notes.txt",
            content_type="text/plain",
        )
        async with (
            ClientSession() as session,
            session.post(
                f"http://127.0.0.1:{self.port}/api/uploads", data=form
            ) as response,
        ):
            result = await response.json()
            self.assertEqual(response.status, 201, result)

        image, document = result["files"]
        self.assertTrue(image["image"])
        self.assertEqual(image["mime"], "image/png")
        self.assertFalse(document["image"])
        self.assertEqual(document["mime"], "text/plain")
        for uploaded in (image, document):
            self.assertTrue(
                uploaded["path"].startswith("/workspaces/codex-web/uploads/")
            )
            stored = self.upload_path / Path(uploaded["path"]).relative_to(
                "/workspaces/codex-web/uploads"
            )
            self.assertTrue(stored.is_file())
            self.assertEqual(stored.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("..", uploaded["storedName"])
            self.assertNotIn(" ", uploaded["storedName"])

    async def test_opens_regular_workspace_files_and_supports_download(self) -> None:
        document = self.workspace_path / "result file.txt"
        document.write_text("generated result\n", encoding="utf-8")
        async with ClientSession() as session:
            async with session.get(
                f"http://127.0.0.1:{self.port}/api/files",
                params={"path": f"{document}:23:4"},
            ) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(await response.text(), "generated result\n")
                self.assertEqual(response.content_type, "text/plain")
                self.assertTrue(
                    response.headers["Content-Disposition"].startswith("inline;")
                )
            async with session.get(
                f"http://127.0.0.1:{self.port}/api/files",
                params={"path": str(document), "download": "1"},
            ) as response:
                self.assertEqual(response.status, 200)
                self.assertTrue(
                    response.headers["Content-Disposition"].startswith("attachment;")
                )

    async def test_workspace_file_route_rejects_outside_and_non_files(self) -> None:
        outside = Path(self.tempdir.name) / "outside.txt"
        outside.write_text("not shared\n", encoding="utf-8")
        escaping_link = self.workspace_path / "escape.txt"
        escaping_link.symlink_to(outside)
        async with ClientSession() as session:
            for path, expected in (
                (str(outside), 403),
                (str(escaping_link), 403),
                (str(self.workspace_path), 400),
                (str(self.workspace_path / "missing.txt"), 404),
                ("relative.txt", 400),
            ):
                async with session.get(
                    f"http://127.0.0.1:{self.port}/api/files",
                    params={"path": path},
                ) as response:
                    self.assertEqual(response.status, expected, path)

    async def test_active_workspace_documents_are_download_only(self) -> None:
        document = self.workspace_path / "page.html"
        document.write_text("<h1>Generated</h1>\n", encoding="utf-8")
        async with (
            ClientSession() as session,
            session.get(
                f"http://127.0.0.1:{self.port}/api/files",
                params={"path": str(document)},
            ) as response,
        ):
            self.assertEqual(response.status, 200)
            self.assertTrue(
                response.headers["Content-Disposition"].startswith("attachment;")
            )

    async def test_rejects_oversized_upload_and_removes_partial_file(self) -> None:
        os.environ["CODEX_UPLOAD_MAX_BYTES"] = "4"
        form = FormData()
        form.add_field("files", b"12345", filename="large.bin")
        async with (
            ClientSession() as session,
            session.post(
                f"http://127.0.0.1:{self.port}/api/uploads", data=form
            ) as response,
        ):
            result = await response.json()
            self.assertEqual(response.status, 413)
            self.assertIn("per-file limit", result["error"])
        self.assertEqual(list(self.upload_path.iterdir()), [])

    async def test_health_reflects_socket(self) -> None:
        async with (
            ClientSession() as session,
            session.get(f"http://127.0.0.1:{self.port}/healthz") as response,
        ):
            self.assertEqual(response.status, 200)
            self.assertTrue((await response.json())["ok"])


if __name__ == "__main__":
    unittest.main()
