from __future__ import annotations

import gzip
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


class ConversationListTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.result = {"data": [{
            "id": "chat", "name": "Saved name", "preview": "Original preview",
            "forkedFromId": "parent", "cwd": "/workspaces", "model": "model-a",
            "createdAt": 1, "updatedAt": 2, "recencyAt": 3, "ephemeral": False,
            "status": {"type": "active", "activeFlags": ["waitingOnUserInput"]},
            "turns": [{"items": [{"text": "Private history" * 10000}]}],
            "path": "/private/session/path", "extra": {"large": "x" * 100000},
        }], "nextCursor": "next"}
        self.error = None

        async def websocket(request):
            socket = web.WebSocketResponse()
            await socket.prepare(request)
            async for message in socket:
                payload = message.json()
                if "id" not in payload:
                    continue
                method = payload["method"]
                self.calls.append((method, payload["params"]))
                assert method in {"initialize", "thread/list"}, method
                if method == "thread/list" and self.error:
                    await socket.send_json({"id": payload["id"], "error": self.error})
                else:
                    await socket.send_json({"id": payload["id"], "result": {} if method == "initialize" else self.result})
            return socket

        backend = web.Application()
        backend.router.add_get("/", websocket)
        upstream = TestServer(backend)
        await upstream.start_server()
        self.addAsyncCleanup(upstream.close)
        self.enterContext(patch.dict(os.environ, {
            "CODEX_APP_SERVER_URL": str(upstream.make_url("/")).replace("http:", "ws:"),
            "CODEX_WORKSPACE_ROOT": str(Path(__file__).resolve().parents[1]),
        }))
        self.server = TestServer(app.create_app())
        await self.server.start_server()
        self.addAsyncCleanup(self.server.close)
        self.client = ClientSession()
        self.addAsyncCleanup(self.client.close)

    async def test_compact_compressed_private_summary_retains_sidebar_fields(self):
        async with self.client.post(self.server.make_url("/api/threads"), json={},
                                    headers={"Accept-Encoding": "gzip"}, auto_decompress=False) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(response.headers["Vary"], "Accept-Encoding")
            self.assertEqual(response.headers["Content-Encoding"], "gzip")
            raw = await response.read()
            data = json.loads(gzip.decompress(raw))
            self.assertLess(len(raw), 400)
            expected = {key: value for key, value in self.result["data"][0].items()
                        if key not in {"turns", "path", "extra"}}
            self.assertEqual(data, {"data": [expected], "nextCursor": "next"})
        self.assertEqual([method for method, _ in self.calls], ["initialize", "thread/list"])
        self.assertEqual(self.calls[-1][1], {"limit": 50, "sourceKinds": ["cli", "vscode", "appServer"],
                                           "sortKey": "recency_at", "sortDirection": "desc", "cursor": None})
        async with self.client.get(self.server.make_url("/api/config")) as response:
            self.assertTrue((await response.json())["threadListHttp"])

    async def test_pagination_preserves_cursor_and_empty_final_page(self):
        self.result = {"data": [], "nextCursor": None}
        async with self.client.post(self.server.make_url("/api/threads"), json={"cursor": "older-page"}) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), self.result)
        self.assertEqual(self.calls[-1][1]["cursor"], "older-page")

    async def test_bad_requests_and_backend_failures_cannot_retire_pins(self):
        for params in ([], {"cursor": 1}, {"cursor": ""}, {"cursor": "x" * 16385}):
            async with self.client.post(self.server.make_url("/api/threads"), json=params) as response:
                self.assertEqual(response.status, 400)
        self.assertEqual(self.calls, [])
        for result in ({}, {"data": [None]}, {"data": [{"id": ""}]},
                       {"data": [], "nextCursor": "next"},
                       {"data": [{"id": "chat"}], "nextCursor": "same"},
                       {"data": [{"id": str(n)} for n in range(51)]}):
            self.result = result
            async with self.client.post(self.server.make_url("/api/threads"), json={"cursor": "same"}) as response:
                self.assertEqual(response.status, 502, result)
        self.error = {"message": "Unavailable"}
        async with self.client.post(self.server.make_url("/api/threads"), json={}) as response:
            self.assertEqual(response.status, 502)
        with patch("app.backend_rpc", side_effect=TimeoutError):
            async with self.client.post(self.server.make_url("/api/threads"), json={}) as response:
                self.assertEqual(response.status, 504)
