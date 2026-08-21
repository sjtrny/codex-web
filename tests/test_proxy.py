from __future__ import annotations

import asyncio
import base64
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aiohttp import ClientSession, FormData, WSMsgType, web

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
codex_web = importlib.import_module("app")


class SearchHelperTests(unittest.TestCase):
    def test_bounded_search_sort_preserves_message_order_for_equal_dates(self) -> None:
        matches = [
            {"itemId": "first", "_timestamp": 20.0, "_sequence": 0},
            {"itemId": "second", "_timestamp": 20.0, "_sequence": 1},
            {"itemId": "older", "_timestamp": 10.0, "_sequence": 2},
        ]
        codex_web.trim_search_matches(matches, "desc", 2)
        self.assertEqual(
            [match["itemId"] for match in matches],
            ["first", "second"],
        )

        matches.append({"itemId": "older", "_timestamp": 10.0, "_sequence": 2})
        codex_web.trim_search_matches(matches, "asc", 2)
        self.assertEqual(
            [match["itemId"] for match in matches],
            ["older", "first"],
        )

    def test_search_uses_containing_turn_times_across_midnight(self) -> None:
        thread = {
            "id": "midnight-thread",
            "createdAt": 1704150000,
            "turns": [
                {
                    "id": "midnight-turn",
                    "startedAt": 1704153590,
                    "completedAt": 1704153610,
                    "items": [
                        {
                            "id": "midnight-user",
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "needle before"}],
                        },
                        {
                            "id": "midnight-agent",
                            "type": "agentMessage",
                            "text": "needle after",
                        },
                    ],
                }
            ],
        }

        january_first = list(
            codex_web.thread_message_matches(
                thread,
                "needle",
                codex_web.date(2024, 1, 1),
                codex_web.date(2024, 1, 1),
                codex_web.ZoneInfo("UTC"),
                0,
            )
        )
        january_second = list(
            codex_web.thread_message_matches(
                thread,
                "needle",
                codex_web.date(2024, 1, 2),
                codex_web.date(2024, 1, 2),
                codex_web.ZoneInfo("UTC"),
                0,
            )
        )

        self.assertEqual(
            [match["itemId"] for match in january_first], ["midnight-user"]
        )
        self.assertEqual(
            [match["itemId"] for match in january_second], ["midnight-agent"]
        )
        self.assertTrue(
            all(
                match["timestampSource"] == "turn"
                for match in january_first + january_second
            )
        )


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
                "CODEX_DEFAULT_MODEL",
                "CODEX_DEFAULT_REASONING_EFFORT",
                "CODEX_DEFAULT_SERVICE_TIER",
                "CODEX_DEFAULT_PERSONALITY",
                "CODEX_DEFAULT_REASONING_SUMMARY",
                "CODEX_DEFAULT_APPROVAL_POLICY",
                "CODEX_DEFAULT_PERMISSION_PROFILE",
                "CODEX_UPLOAD_DIR",
                "CODEX_UPLOAD_HOST_DIR",
                "CODEX_UPLOAD_MAX_BYTES",
                "CODEX_UPLOAD_MAX_FILES",
                "CODEX_UPLOAD_TOTAL_BYTES",
            )
        }
        for name in codex_web.CHAT_SETTING_ENV_VARS.values():
            os.environ.pop(name, None)
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
        self.backend_messages = []
        self.search_list_pages = None
        self.search_thread_reads = {}
        self.search_thread_behaviors = {}
        self.host_image_reads = {}

        backend = web.Application()

        async def echo(request: web.Request) -> web.WebSocketResponse:
            socket = web.WebSocketResponse()
            await socket.prepare(request)
            host_image_client = False
            async for message in socket:
                if message.type is WSMsgType.TEXT:
                    payload = json.loads(message.data)
                    self.backend_messages.append(payload)
                    method = payload.get("method")
                    if method == "initialize" and (
                        payload.get("params", {}).get("clientInfo", {}).get("name")
                        == "codex_web_host_image"
                    ):
                        host_image_client = True
                        await socket.send_json(
                            {"id": payload["id"], "result": {"userAgent": "test"}}
                        )
                        continue
                    if host_image_client and method == "initialized":
                        continue
                    if host_image_client and method == "fs/readFile":
                        result = self.host_image_reads.get(payload["params"]["path"])
                        if isinstance(result, dict) and "error" in result:
                            await socket.send_json(
                                {"id": payload["id"], "error": result["error"]}
                            )
                        elif isinstance(result, bytes):
                            await socket.send_json(
                                {
                                    "id": payload["id"],
                                    "result": {
                                        "dataBase64": base64.b64encode(result).decode()
                                    },
                                }
                            )
                        else:
                            await socket.send_json(
                                {
                                    "id": payload["id"],
                                    "error": {
                                        "code": -32603,
                                        "message": "No such file",
                                    },
                                }
                            )
                        continue
                    if self.search_list_pages is not None:
                        if method == "initialize":
                            await socket.send_json(
                                {
                                    "method": "thread/status/changed",
                                    "params": {"threadId": "notification-only"},
                                }
                            )
                            await socket.send_json(
                                {"id": payload["id"], "result": {"userAgent": "test"}}
                            )
                            continue
                        if method == "initialized":
                            continue
                        if method == "thread/list":
                            key = (
                                bool(payload["params"].get("archived")),
                                payload["params"].get("cursor"),
                            )
                            result = self.search_list_pages.get(
                                key, {"data": [], "nextCursor": None}
                            )
                            await socket.send_json(
                                {"id": payload["id"], "result": result}
                            )
                            continue
                        if method == "thread/read":
                            thread_id = payload["params"]["threadId"]
                            behavior = self.search_thread_behaviors.get(thread_id, {})
                            if behavior.get("close"):
                                await socket.close()
                                break
                            if delay := behavior.get("delay"):
                                await asyncio.sleep(delay)
                                if socket.closed:
                                    break
                            result = self.search_thread_reads[thread_id]
                            try:
                                if "error" in result:
                                    await socket.send_json(
                                        {
                                            "id": payload["id"],
                                            "error": result["error"],
                                        }
                                    )
                                else:
                                    await socket.send_json(
                                        {"id": payload["id"], "result": result}
                                    )
                            except ConnectionResetError:
                                break
                            continue
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
            self.assertIn('id="shell"', body)
            self.assertIn('id="menu"', body)
            self.assertIn('aria-controls="sidebar"', body)
            self.assertIn('id="sidebar-toggle"', body)
            self.assertIn('aria-controls="sidebar-content"', body)
            self.assertIn('class="sidebar-toggle-icon"', body)
            self.assertIn('id="sidebar-content"', body)
            self.assertIn('id="sidebar-resizer"', body)
            self.assertIn('id="sidebar-swipe-edge"', body)
            self.assertIn('role="separator"', body)
            self.assertIn('aria-orientation="vertical"', body)
            self.assertIn('<a class="brand-home" href="/"><strong>Codex</strong></a>', body)
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
            self.assertIn('id="search-chats"', body)
            self.assertIn('id="search-view"', body)
            self.assertIn('id="search-query"', body)
            self.assertIn('maxlength="256"', body)
            self.assertIn('id="search-from"', body)
            self.assertIn('id="search-to"', body)
            self.assertIn('id="search-sort"', body)
            self.assertNotIn('id="search-close"', body)
            self.assertIn('class="search-date-filter"', body)
            self.assertIn('class="search-submit"', body)
            self.assertIn('aria-live="polite"', body)
            self.assertIn("Jump to present", body)
            self.assertIn('id="thinking-indicator"', body)
            self.assertIn("Codex is thinking", body)
            self.assertIn('aria-busy="false"', body)
            self.assertIn("/static/vendor/markdown.css", body)
            self.assertIn("/static/vendor/markdown.js", body)
            self.assertIn("/static/theme.js", body)
            self.assertIn('rel="manifest" href="/manifest.webmanifest"', body)
            self.assertIn('name="mobile-web-app-capable" content="yes"', body)
            self.assertIn('name="apple-mobile-web-app-capable" content="yes"', body)
            self.assertIn('name="apple-mobile-web-app-title" content="Codex Web"', body)
            self.assertIn('rel="apple-touch-icon" sizes="180x180"', body)
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

    async def test_config_exposes_workspace_root(self) -> None:
        async with (
            ClientSession() as session,
            session.get(f"http://127.0.0.1:{self.port}/api/config") as response,
        ):
            config = await response.json()
            self.assertEqual(response.status, 200)
            self.assertEqual(config["workspaceRoot"], str(self.workspace_path))
            self.assertEqual(config["version"], "0.9.3")
            self.assertEqual(config["chatDefaults"], codex_web.DEFAULT_CHAT_SETTINGS)

    async def test_config_exposes_chat_default_environment_overrides(self) -> None:
        configured = {
            "CODEX_DEFAULT_MODEL": "gpt-5.6-sol",
            "CODEX_DEFAULT_REASONING_EFFORT": "max",
            "CODEX_DEFAULT_SERVICE_TIER": "priority",
            "CODEX_DEFAULT_PERSONALITY": "friendly",
            "CODEX_DEFAULT_REASONING_SUMMARY": "detailed",
            "CODEX_DEFAULT_APPROVAL_POLICY": "never",
            "CODEX_DEFAULT_PERMISSION_PROFILE": ":danger-full-access",
        }
        with patch.dict(os.environ, configured):
            async with (
                ClientSession() as session,
                session.get(f"http://127.0.0.1:{self.port}/api/config") as response,
            ):
                config = await response.json()

        self.assertEqual(response.status, 200)
        self.assertEqual(
            config["chatDefaults"],
            {
                "model": "gpt-5.6-sol",
                "effort": "max",
                "serviceTier": "priority",
                "personality": "friendly",
                "summary": "detailed",
                "approvalPolicy": "never",
                "permissions": ":danger-full-access",
            },
        )

    async def test_searches_all_thread_pages_and_filters_message_dates(self) -> None:
        self.search_list_pages = {
            (False, None): {
                "data": [{"id": "alpha"}, {"id": "outside-range"}],
                "nextCursor": "active-page-2",
            },
            (False, "active-page-2"): {
                "data": [
                    {"id": "late"},
                    {"id": "middle"},
                    {"id": "undated"},
                ],
                "nextCursor": None,
            },
        }
        self.search_thread_reads = {
            "alpha": {
                "thread": {
                    "id": "alpha",
                    "name": "Alpha chat",
                    "preview": "ignored preview",
                    "createdAt": 1704067200,
                    "turns": [
                        {
                            "id": "turn-alpha",
                            "startedAt": 1704153600,
                            "completedAt": 1704153660,
                            "items": [
                                {
                                    "id": "message-alpha",
                                    "type": "userMessage",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "The Straße and STRASSE both match.",
                                        },
                                        {"type": "localImage", "path": "/image.png"},
                                    ],
                                },
                                {
                                    "id": "answer-alpha",
                                    "type": "agentMessage",
                                    "text": "No result in this answer.",
                                },
                            ],
                        },
                        {
                            "id": "turn-alpha-later",
                            "startedAt": 1704240000,
                            "completedAt": 1704240060,
                            "items": [
                                {
                                    "id": "answer-alpha-later",
                                    "type": "agentMessage",
                                    "text": "Another STRASSE hit in Alpha.",
                                }
                            ],
                        },
                    ],
                }
            },
            "outside-range": {
                "thread": {
                    "id": "outside-range",
                    "preview": "Old chat",
                    "createdAt": 1704067200,
                    "turns": [
                        {
                            "id": "turn-old",
                            "startedAt": 1704067200,
                            "completedAt": 1704067260,
                            "items": [
                                {
                                    "id": "message-old",
                                    "type": "userMessage",
                                    "content": [
                                        {"type": "text", "text": "STRASSE before range"}
                                    ],
                                }
                            ],
                        }
                    ],
                }
            },
            "late": {
                "thread": {
                    "id": "late",
                    "preview": "Late preview title",
                    "createdAt": 1704240000,
                    "turns": [
                        {
                            "id": "turn-late",
                            "startedAt": 1704240000,
                            "completedAt": 1704326399,
                            "items": [
                                {
                                    "id": "answer-late",
                                    "type": "agentMessage",
                                    "text": "A late strasse response",
                                }
                            ],
                        }
                    ],
                }
            },
            "middle": {
                "thread": {
                    "id": "middle",
                    "preview": "Middle preview",
                    "createdAt": 1704283200,
                    "turns": [
                        {
                            "id": "turn-middle",
                            "startedAt": 1704283200,
                            "completedAt": None,
                            "items": [
                                {
                                    "id": "answer-middle",
                                    "type": "agentMessage",
                                    "text": "Middle STRASSE response",
                                }
                            ],
                        }
                    ],
                }
            },
            "undated": {
                "thread": {
                    "id": "undated",
                    "preview": "Undated preview",
                    "createdAt": 1704286800,
                    "turns": [
                        {
                            "id": "turn-undated",
                            "startedAt": None,
                            "completedAt": None,
                            "items": [
                                {
                                    "id": "answer-undated",
                                    "type": "agentMessage",
                                    "text": "Undated STRASSE response",
                                }
                            ],
                        }
                    ],
                }
            },
        }

        async with (
            ClientSession() as session,
            session.post(
                f"http://127.0.0.1:{self.port}/api/search",
                json={
                    "q": "STRASSE",
                    "sort": "oldest",
                    "from": "2024-01-02",
                    "to": "2024-01-03",
                    "limit": "2",
                },
            ) as response,
        ):
            result = await response.json()

        self.assertEqual(response.status, 200, result)
        self.assertEqual(result["total"], 3)
        self.assertTrue(result["truncated"])
        self.assertFalse(result["partial"])
        self.assertEqual(result["skippedThreads"], 0)
        self.assertEqual(result["timezone"], "UTC")
        self.assertEqual(
            [match["itemId"] for match in result["results"]],
            ["message-alpha", "answer-middle"],
        )
        self.assertEqual(
            len({match["threadId"] for match in result["results"]}),
            len(result["results"]),
        )
        first, middle = result["results"]
        self.assertEqual(first["messageId"], "message-alpha")
        self.assertEqual(first["threadTitle"], "Alpha chat")
        self.assertEqual(first["title"], "Alpha chat")
        self.assertEqual(first["role"], "user")
        self.assertNotIn("text", first)
        self.assertNotIn("_timestamp", first)
        self.assertNotIn("_sequence", first)
        self.assertIn("Straße", first["snippet"])
        self.assertEqual(first["matchedText"], "Straße")
        self.assertEqual(first["timestamp"], "2024-01-02T00:00:00Z")
        self.assertEqual(first["createdAt"], first["timestamp"])
        self.assertEqual(first["timestampSource"], "turn")
        self.assertEqual(middle["threadId"], "middle")
        self.assertEqual(middle["timestampSource"], "turn")
        self.assertEqual(middle["dateSource"], "turn")

        list_requests = [
            message
            for message in self.backend_messages
            if message.get("method") == "thread/list"
        ]
        self.assertEqual(len(list_requests), 2)
        self.assertEqual(list_requests[1]["params"]["cursor"], "active-page-2")
        self.assertTrue(
            all(not request["params"]["archived"] for request in list_requests)
        )
        self.assertTrue(
            all(
                request["params"]["sourceKinds"] == ["cli", "vscode", "appServer"]
                for request in list_requests
            )
        )
        read_requests = [
            message
            for message in self.backend_messages
            if message.get("method") == "thread/read"
        ]
        self.assertEqual(len(read_requests), 5)
        self.assertTrue(
            all(request["params"]["includeTurns"] for request in read_requests)
        )
        methods = [message.get("method") for message in self.backend_messages]
        self.assertLess(methods.index("initialize"), methods.index("initialized"))
        self.assertLess(methods.index("initialized"), methods.index("thread/list"))

    async def test_search_date_range_uses_the_requested_time_zone(self) -> None:
        self.search_list_pages = {
            (False, None): {
                "data": [{"id": "timezone-thread"}],
                "nextCursor": None,
            }
        }
        self.search_thread_reads = {
            "timezone-thread": {
                "thread": {
                    "id": "timezone-thread",
                    "preview": "Time zone chat",
                    "createdAt": 1704151800,
                    "turns": [
                        {
                            "id": "timezone-turn",
                            "startedAt": 1704151800,
                            "completedAt": 1704151860,
                            "items": [
                                {
                                    "id": "timezone-message",
                                    "type": "userMessage",
                                    "content": [
                                        {"type": "text", "text": "timezone match"}
                                    ],
                                }
                            ],
                        }
                    ],
                }
            }
        }
        async with (
            ClientSession() as session,
            session.post(
                f"http://127.0.0.1:{self.port}/api/search",
                json={
                    "q": "timezone",
                    "from": "2024-01-02",
                    "to": "2024-01-02",
                    "timezone": "Asia/Tokyo",
                },
            ) as response,
        ):
            result = await response.json()

        self.assertEqual(response.status, 200, result)
        self.assertEqual(result["timezone"], "Asia/Tokyo")
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["results"][0]["timestamp"], "2024-01-01T23:30:00Z")

    async def test_search_reports_partial_results_when_a_thread_cannot_be_read(
        self,
    ) -> None:
        self.search_list_pages = {
            (False, None): {
                "data": [{"id": "available"}, {"id": "unreadable"}],
                "nextCursor": None,
            },
        }
        self.search_thread_reads = {
            "available": {
                "thread": {
                    "id": "available",
                    "preview": "Available",
                    "createdAt": 1704153600,
                    "turns": [
                        {
                            "id": "turn-available",
                            "startedAt": 1704153600,
                            "completedAt": 1704153660,
                            "items": [
                                {
                                    "id": "answer-available",
                                    "type": "agentMessage",
                                    "text": "find this text",
                                }
                            ],
                        }
                    ],
                }
            },
            "unreadable": {"error": {"code": -32000, "message": "corrupt history"}},
        }
        async with (
            ClientSession() as session,
            session.post(
                f"http://127.0.0.1:{self.port}/api/search",
                json={"q": "find"},
            ) as response,
        ):
            result = await response.json()

        self.assertEqual(response.status, 200, result)
        self.assertEqual(result["total"], 1)
        self.assertTrue(result["partial"])
        self.assertEqual(result["skippedThreads"], 1)

    async def test_search_reconnects_after_closed_timed_out_and_oversized_reads(
        self,
    ) -> None:
        thread_ids = [
            "before",
            "closed",
            "slow",
            "oversized",
            "after",
        ]
        self.search_list_pages = {
            (False, None): {
                "data": [{"id": thread_id} for thread_id in thread_ids],
                "nextCursor": None,
            }
        }

        def thread_result(thread_id: str, text: str) -> dict[str, object]:
            return {
                "thread": {
                    "id": thread_id,
                    "createdAt": 1704153600,
                    "turns": [
                        {
                            "id": f"turn-{thread_id}",
                            "startedAt": 1704153600,
                            "completedAt": 1704153660,
                            "items": [
                                {
                                    "id": f"message-{thread_id}",
                                    "type": "agentMessage",
                                    "text": text,
                                }
                            ],
                        }
                    ],
                }
            }

        self.search_thread_reads = {
            "before": thread_result("before", "needle before failures"),
            "closed": thread_result("closed", "needle on a closed connection"),
            "slow": thread_result("slow", "needle in a slow response"),
            "oversized": thread_result(
                "oversized", f"needle in oversized response {'x' * 4096}"
            ),
            "after": thread_result("after", "needle after failures"),
        }
        self.search_thread_behaviors = {
            "closed": {"close": True},
            "slow": {"delay": 0.08},
        }
        old_message_bytes = codex_web.MAX_MESSAGE_BYTES
        old_rpc_timeout = codex_web.SEARCH_RPC_TIMEOUT_SECONDS
        codex_web.MAX_MESSAGE_BYTES = 1024
        codex_web.SEARCH_RPC_TIMEOUT_SECONDS = 0.02
        try:
            async with (
                ClientSession() as session,
                session.post(
                    f"http://127.0.0.1:{self.port}/api/search",
                    json={"q": "needle", "limit": 10},
                ) as response,
            ):
                result = await response.json()
        finally:
            codex_web.MAX_MESSAGE_BYTES = old_message_bytes
            codex_web.SEARCH_RPC_TIMEOUT_SECONDS = old_rpc_timeout

        self.assertEqual(response.status, 200, result)
        self.assertEqual(result["total"], 2)
        self.assertTrue(result["partial"])
        self.assertFalse(result["timedOut"])
        self.assertEqual(result["skippedThreads"], 3)
        self.assertEqual(
            {match["threadId"] for match in result["results"]},
            {"before", "after"},
        )
        initialize_requests = [
            message
            for message in self.backend_messages
            if message.get("method") == "initialize"
        ]
        self.assertEqual(len(initialize_requests), 4)

    async def test_global_search_deadline_returns_matches_already_found(self) -> None:
        self.search_list_pages = {
            (False, None): {
                "data": [
                    {"id": "before-deadline"},
                    {"id": "at-deadline"},
                    {"id": "after-deadline"},
                ],
                "nextCursor": None,
            }
        }

        def thread_result(thread_id: str) -> dict[str, object]:
            return {
                "thread": {
                    "id": thread_id,
                    "createdAt": 1704153600,
                    "turns": [
                        {
                            "id": f"turn-{thread_id}",
                            "startedAt": 1704153600,
                            "completedAt": 1704153660,
                            "items": [
                                {
                                    "id": f"message-{thread_id}",
                                    "type": "agentMessage",
                                    "text": f"deadline needle {thread_id}",
                                }
                            ],
                        }
                    ],
                }
            }

        self.search_thread_reads = {
            thread_id: thread_result(thread_id)
            for thread_id in ("before-deadline", "at-deadline", "after-deadline")
        }
        self.search_thread_behaviors = {"at-deadline": {"delay": 0.25}}
        old_search_timeout = codex_web.SEARCH_TIMEOUT_SECONDS
        old_rpc_timeout = codex_web.SEARCH_RPC_TIMEOUT_SECONDS
        codex_web.SEARCH_TIMEOUT_SECONDS = 0.1
        codex_web.SEARCH_RPC_TIMEOUT_SECONDS = 1
        try:
            async with (
                ClientSession() as session,
                session.post(
                    f"http://127.0.0.1:{self.port}/api/search",
                    json={"q": "deadline needle", "limit": 10},
                ) as response,
            ):
                result = await response.json()
        finally:
            codex_web.SEARCH_TIMEOUT_SECONDS = old_search_timeout
            codex_web.SEARCH_RPC_TIMEOUT_SECONDS = old_rpc_timeout

        self.assertEqual(response.status, 200, result)
        self.assertEqual(result["total"], 1)
        self.assertTrue(result["partial"])
        self.assertTrue(result["timedOut"])
        self.assertEqual(result["skippedThreads"], 2)
        self.assertEqual(result["results"][0]["threadId"], "before-deadline")
        read_thread_ids = [
            message["params"]["threadId"]
            for message in self.backend_messages
            if message.get("method") == "thread/read"
        ]
        self.assertNotIn("after-deadline", read_thread_ids)

    async def test_search_validates_query_sort_dates_and_limit(self) -> None:
        cases = (
            ({}, "q is required"),
            ({"q": "x", "sort": "sideways"}, "sort must be"),
            ({"q": "x", "from": "01/02/2024"}, "YYYY-MM-DD"),
            ({"q": "x", "to": "2024-02-30"}, "valid date"),
            (
                {"q": "x", "from": "2024-01-03", "to": "2024-01-02"},
                "must not be after",
            ),
            ({"q": "x", "limit": "0"}, "between 1"),
            ({"q": "x", "limit": "201"}, "between 1"),
            ({"q": "x", "limit": "many"}, "integer"),
            ({"q": "x", "limit": []}, "integer"),
            ({"q": "x", "timezone": "Mars/Olympus_Mons"}, "IANA time zone"),
            ({"q": "x" * 257}, "at most 256"),
            ({"q": 123}, "q must be a string"),
        )
        async with ClientSession() as session:
            for params, expected_error in cases:
                with self.subTest(params=params):
                    async with session.post(
                        f"http://127.0.0.1:{self.port}/api/search",
                        json=params,
                    ) as response:
                        result = await response.json()
                    self.assertEqual(response.status, 400, result)
                    self.assertIn(expected_error, result["error"])
        self.assertEqual(self.backend_messages, [])

    async def test_search_query_is_not_accepted_in_the_access_log_url(self) -> None:
        async with ClientSession() as session:
            async with session.get(
                f"http://127.0.0.1:{self.port}/api/search",
                params={"q": "private search terms"},
            ) as response:
                self.assertEqual(response.status, 405)
            async with session.post(
                f"http://127.0.0.1:{self.port}/api/search",
                data="not-json",
                headers={"Content-Type": "application/json"},
            ) as response:
                result = await response.json()
                self.assertEqual(response.status, 400)
                self.assertIn("JSON", result["error"])

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

    async def test_pwa_manifest_worker_and_icons_are_self_hosted(self) -> None:
        async with ClientSession() as session:
            async with session.get(
                f"http://127.0.0.1:{self.port}/manifest.webmanifest"
            ) as response:
                manifest = await response.json()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.content_type, "application/manifest+json")
            self.assertEqual(manifest["id"], "/")
            self.assertEqual(manifest["start_url"], "/")
            self.assertEqual(manifest["scope"], "/")
            self.assertEqual(manifest["display"], "standalone")
            self.assertEqual(
                [icon["sizes"] for icon in manifest["icons"]],
                ["192x192", "512x512"],
            )

            async with session.get(
                f"http://127.0.0.1:{self.port}/service-worker.js"
            ) as response:
                worker = await response.text()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.content_type, "text/javascript")
                self.assertEqual(response.headers["Service-Worker-Allowed"], "/")
            self.assertIn('self.addEventListener("install"', worker)
            self.assertIn("self.skipWaiting()", worker)
            self.assertIn("self.clients.claim()", worker)
            self.assertNotIn("caches.open", worker)

            async with session.get(
                f"http://127.0.0.1:{self.port}/static/app.js"
            ) as response:
                app_script = await response.text()
                self.assertEqual(response.status, 200)
            self.assertIn(
                'navigator.serviceWorker?.register("/service-worker.js"',
                app_script,
            )

            for icon_path, expected_size in (
                ("apple-touch-icon.png", 180),
                ("icon-192.png", 192),
                ("icon-512.png", 512),
            ):
                async with session.get(
                    f"http://127.0.0.1:{self.port}/static/icons/{icon_path}"
                ) as response:
                    icon = await response.read()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.content_type, "image/png")
                self.assertEqual(icon[:8], b"\x89PNG\r\n\x1a\n")
                self.assertEqual(int.from_bytes(icon[16:20]), expected_size)
                self.assertEqual(int.from_bytes(icon[20:24]), expected_size)

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
            self.assertIn(".message-attachments { display: flex;", stylesheet)
            self.assertIn(".message-attachment:focus-visible {", stylesheet)
            self.assertNotIn(".code-block pre { padding-top:", stylesheet)
            self.assertIn(':root[data-theme="dark"] {', stylesheet)
            self.assertIn(".preferences-dialog {", stylesheet)
            self.assertIn(".search-view {", stylesheet)
            self.assertIn(".search-results {", stylesheet)
            self.assertIn(".search-submit {", stylesheet)
            self.assertIn(".search-date-filter { grid-column: 1 / -1; }", stylesheet)
            self.assertIn('input[type="date"]', stylesheet)
            self.assertIn(".message.search-match {", stylesheet)
            self.assertIn(".settings-cog {", stylesheet)
            self.assertIn(".settings-panel { grid-row: 2;", stylesheet)
            self.assertIn(
                ".settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr));",
                stylesheet,
            )
            self.assertIn("height: 100dvh", stylesheet)
            self.assertIn("--sidebar-width: 260px", stylesheet)
            self.assertIn("--sidebar-rail-width: 64px", stylesheet)
            self.assertIn(".sidebar-resizer {", stylesheet)
            self.assertIn(".shell.sidebar-collapsed", stylesheet)
            self.assertIn(
                "grid-template-columns: var(--sidebar-rail-width) minmax(0, 1fr)",
                stylesheet,
            )
            self.assertIn(".sidebar-content[hidden] { display: none; }", stylesheet)
            self.assertIn("cursor: col-resize", stylesheet)
            self.assertIn(".sidebar.open { transform: translateX(0); }", stylesheet)
            self.assertIn(".sidebar-swipe-edge {", stylesheet)
            self.assertIn("touch-action: pan-y", stylesheet)
            self.assertIn(".sidebar.sidebar-swiping {", stylesheet)
            self.assertIn(".sidebar-scrim.sidebar-swiping {", stylesheet)
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

        manifest_path = (
            next(self.upload_path.iterdir()) / codex_web.UPLOAD_MANIFEST_NAME
        )
        self.assertEqual(manifest_path.stat().st_mode & 0o777, 0o600)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(
            manifest["files"][image["storedName"]]["name"],
            "screen shot.png",
        )

        async with (
            ClientSession() as session,
            session.get(
                f"http://127.0.0.1:{self.port}/api/attachments",
                params={"path": image["path"], "name": "wrong-name.bin"},
            ) as response,
        ):
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.read(), png)
            self.assertEqual(response.content_type, "image/png")
            self.assertIn(
                'filename="screen%20shot.png"',
                response.headers["Content-Disposition"],
            )

        async with (
            ClientSession() as session,
            session.get(
                f"http://127.0.0.1:{self.port}/api/attachments",
                params={"path": image["path"], "preview": "1"},
            ) as response,
        ):
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.read(), png)
            self.assertEqual(response.content_type, "image/png")
            self.assertTrue(
                response.headers["Content-Disposition"].startswith("inline;")
            )

        async with (
            ClientSession() as session,
            session.get(
                f"http://127.0.0.1:{self.port}/api/attachments",
                params={"path": document["path"], "preview": "1"},
            ) as response,
        ):
            self.assertEqual(response.status, 415)

        manifest_path.unlink()
        async with (
            ClientSession() as session,
            session.get(
                f"http://127.0.0.1:{self.port}/api/attachments",
                params={"path": document["path"], "name": document["name"]},
            ) as response,
        ):
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.read(), b"notes")
            self.assertIn(
                'filename="notes.txt"',
                response.headers["Content-Disposition"],
            )

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
            async with session.get(
                f"http://127.0.0.1:{self.port}/api/attachments",
                params={"path": str(document), "name": "original name.txt"},
            ) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(await response.text(), "generated result\n")
                self.assertIn(
                    'filename="original%20name.txt"',
                    response.headers["Content-Disposition"],
                )

    async def test_reads_host_images_through_the_app_server(self) -> None:
        path = "/tmp/freelens-illumination/synthetic_comparison.png"
        png = b"\x89PNG\r\n\x1a\n" + (b"\x00" * 32)
        self.host_image_reads[path] = png

        async with (
            ClientSession() as session,
            session.get(
                f"http://127.0.0.1:{self.port}/api/host-images",
                params={"path": path},
            ) as response,
        ):
            self.assertEqual(response.status, 200)
            self.assertEqual(response.content_type, "image/png")
            self.assertEqual(await response.read(), png)
            self.assertTrue(
                response.headers["Content-Disposition"].startswith("inline;")
            )
            self.assertEqual(response.headers["Cache-Control"], "no-store")

        image_requests = [
            message
            for message in self.backend_messages
            if message.get("method") in {"initialize", "initialized", "fs/readFile"}
        ]
        self.assertEqual(
            [message["method"] for message in image_requests],
            ["initialize", "initialized", "fs/readFile"],
        )
        self.assertTrue(
            image_requests[0]["params"]["capabilities"]["experimentalApi"]
        )
        self.assertEqual(image_requests[2]["params"], {"path": path})

    async def test_host_image_route_rejects_invalid_or_non_image_content(self) -> None:
        text_path = "/tmp/freelens-illumination/not-really.png"
        self.host_image_reads[text_path] = b"not an image"
        async with ClientSession() as session:
            for path, expected in (
                ("relative.png", 400),
                ("/tmp/../etc/secret.png", 400),
                ("//remote.example/image.png", 400),
                ("/tmp/notes.txt", 415),
                (text_path, 415),
                ("/tmp/freelens-illumination/missing.png", 404),
            ):
                async with session.get(
                    f"http://127.0.0.1:{self.port}/api/host-images",
                    params={"path": path},
                ) as response:
                    self.assertEqual(response.status, expected, path)

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

            async with session.get(
                f"http://127.0.0.1:{self.port}/api/attachments",
                params={"path": "/workspaces/codex-web/uploads/not-a-batch/file.txt"},
            ) as response:
                self.assertEqual(response.status, 404)

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
