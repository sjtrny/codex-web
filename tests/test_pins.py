from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
from pins import PinStore


class PinTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / "state"
        self.enterContext(patch.dict(os.environ, {"CODEX_WEB_STATE_DIR": str(self.directory)}))
        self.clients = []
        self.client = await self.new_client()

    async def new_client(self):
        client = TestClient(TestServer(app.create_app()))
        await client.start_server()
        self.clients.append(client)
        return client

    async def asyncTearDown(self):
        for client in self.clients:
            await client.close()

    async def update(self, thread_id, pinned, client=None):
        response = await (client or self.client).put(
            "/api/pins", json={"threadId": thread_id, "pinned": pinned},
        )
        self.assertEqual(response.status, 200, await response.text())
        return await response.json()

    async def test_pins_survive_application_restart_and_browser_changes(self):
        initial = await (await self.client.get("/api/pins")).json()
        self.assertEqual(initial["threadIds"], [])
        saved = await self.update("first", True)
        self.assertGreater(saved["revision"], initial["revision"])
        await self.client.close()
        self.client = await self.new_client()
        response = await self.client.get("/api/pins")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(await response.json(), saved)
        self.assertEqual((self.directory / "pins.sqlite3").stat().st_mode & 0o777, 0o600)
        self.assertEqual((await self.update("first", False))["threadIds"], [])

    async def test_migration_merges_devices_and_never_resurrects_unpins(self):
        await self.update("shared", True)
        await self.update("removed", False)
        for _ in range(2):
            response = await self.client.post("/api/pins/migrate", json={
                "threadIds": ["legacy", "shared", "removed", "legacy"],
            })
            self.assertEqual(response.status, 200)
            self.assertEqual((await response.json())["threadIds"], ["legacy", "shared"])
        before = await self.update("legacy", False)
        response = await self.client.post("/api/pins/migrate", json={"threadIds": ["legacy"]})
        self.assertEqual(await response.json(), before)
        self.assertEqual((await self.update("legacy", True))["threadIds"], ["legacy", "shared"])

    async def test_concurrent_browsers_and_workers_do_not_replace_other_pins(self):
        second = await self.new_client()
        await asyncio.gather(*(self.update(str(i), True, self.client if i % 2 else second)
                               for i in range(20)))
        response = await self.client.get("/api/pins")
        self.assertEqual(set((await response.json())["threadIds"]), {str(i) for i in range(20)})
        await asyncio.gather(self.update("1", False), self.update("new", True, second))
        saved = await (await second.get("/api/pins")).json()
        self.assertNotIn("1", saved["threadIds"])
        self.assertIn("new", saved["threadIds"])
        self.assertEqual(len(saved["threadIds"]), 20)

    async def test_invalid_and_cross_origin_form_writes_are_rejected(self):
        saved = await self.update("safe", True)
        for body in ([], None, {}, {"threadId": "", "pinned": True},
                     {"threadId": "safe", "pinned": 1}, {"threadId": "x\0", "pinned": False},
                     {"threadId": "x" * 257, "pinned": True}):
            response = await self.client.put("/api/pins", data=json.dumps(body),
                                             headers={"Content-Type": "application/json"})
            self.assertEqual(response.status, 400)
        for ids in ("safe", [None], ["x"] * 10001):
            response = await self.client.post("/api/pins/migrate", json={"threadIds": ids})
            self.assertEqual(response.status, 400)
        response = await self.client.post("/api/pins/migrate", data={"threadIds": "safe"})
        self.assertEqual(response.status, 415)
        response = await self.client.put("/api/pins", data="{", headers={"Content-Type": "application/json"})
        self.assertEqual(response.status, 400)
        response = await self.client.put("/api/pins", data=" " * (1024 * 1024 + 1),
                                         headers={"Content-Type": "application/json"})
        self.assertEqual(response.status, 413)
        self.assertEqual(await (await self.client.get("/api/pins")).json(), saved)

    async def test_storage_failure_does_not_acknowledge_or_replace_saved_pins(self):
        saved = await self.update("safe", True)
        with patch.object(PinStore, "snapshot", side_effect=sqlite3.OperationalError("read only")):
            with self.assertLogs("codex-web", level="ERROR"):
                response = await self.client.put("/api/pins", json={"threadId": "safe", "pinned": False})
            self.assertEqual(response.status, 503)
        self.assertEqual(await (await self.client.get("/api/pins")).json(), saved)
        database = self.directory / "pins.sqlite3"
        database.write_bytes(b"corrupt database")
        with self.assertLogs("codex-web", level="ERROR"):
            response = await self.client.get("/api/pins")
        self.assertEqual(response.status, 503)
        self.assertEqual(database.read_bytes(), b"corrupt database")

    async def test_websocket_clients_receive_updates_and_archive_cleanup(self):
        sockets = []

        async def backend(request):
            socket = web.WebSocketResponse()
            await socket.prepare(request)
            sockets.append(socket)
            async for message in socket:
                payload = message.json()
                await socket.send_json({"id": payload["id"], "result": {}})
            return socket

        upstream = web.Application()
        upstream.router.add_get("/", backend)
        async with TestServer(upstream) as server:
            with patch.dict(os.environ, {"CODEX_APP_SERVER_URL": str(server.make_url("/")).replace("http:", "ws:")}):
                first = await self.client.ws_connect("/ws")
                second = await self.client.ws_connect("/ws")
                for socket in (first, second):
                    self.assertEqual((await socket.receive_json(timeout=3))["method"], "codex-web/connected")
                saved = await self.update("shared", True)
                for socket in (first, second):
                    event = await socket.receive_json(timeout=3)
                    self.assertEqual(event, {"method": "codex-web/pins/updated", "params": saved})
                for method in ("thread/archived", "thread/deleted"):
                    await sockets[0].send_json({"method": method, "params": {"threadId": "shared"}})
                    for socket in (first, second):
                        event = await socket.receive_json(timeout=3)
                        self.assertEqual(event["params"]["threadIds"], [])
                    self.assertEqual((await first.receive_json(timeout=3))["method"], method)
                response = await self.client.post("/api/pins/migrate", json={"threadIds": ["shared"]})
                self.assertEqual((await response.json())["threadIds"], [])
                await first.close()
                await second.close()


if __name__ == "__main__":
    unittest.main()
