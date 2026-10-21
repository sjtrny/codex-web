from __future__ import annotations

import copy
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
from history import decode_cursor, read_history_chunk
from questions import read_pending_questions


class HistoryBackend:
    def __init__(self):
        self.calls = []
        self.turns = [
            {"id": "old", "status": "completed", "items": [
                {"id": "first", "type": "userMessage", "content": [{"type": "text", "text": "First"}]},
                {"id": "large", "type": "agentMessage", "text": '🦜你好\\\n"' * 150},
            ]},
            {"id": "empty", "status": "completed", "items": []},
            {"id": "recent", "status": "inProgress", "items": [
                {"id": "last", "type": "agentMessage", "text": "Newest"},
            ]},
        ]

    async def rpc(self, method, params):
        self.calls.append((method, params))
        if method == "initialize":
            return {}
        if method == "thread/turns/list":
            assert params["itemsView"] == "notLoaded"
            rows = [{**turn, "items": []} for turn in reversed(self.turns)]
        elif method == "thread/items/list":
            turn = next(turn for turn in self.turns if turn["id"] == params["turnId"])
            rows = [{"id": item["id"], "turnId": turn["id"], "item": item,
                     "startedAtMs": 1234567890123} for item in reversed(turn["items"])]
        else:
            raise AssertionError(f"Unexpected RPC: {method}")
        assert params["sortDirection"] == "desc"
        cursor = params.get("cursor")
        start = next((i + 1 for i, row in enumerate(rows) if row["id"] == cursor), 0)
        selected = rows[start:start + params["limit"]]
        return {"data": copy.deepcopy(selected), "nextCursor": (
            selected[-1]["id"] if start + len(selected) < len(rows) else None
        )}


class HistoryChunkTests(unittest.IsolatedAsyncioTestCase):
    async def test_per_turn_model_metadata_is_preserved_when_the_backend_supplies_it(self):
        backend = HistoryBackend()
        backend.turns[0]["model"] = "older-model"
        backend.turns[-1]["model"] = "newer-model"
        body, _, _ = await read_history_chunk(backend.rpc, decode_cursor("", "chat"), 20000)
        turns = [row["turn"] for row in map(json.loads, body.splitlines()) if "turn" in row]
        self.assertEqual([turn.get("model") for turn in turns], ["newer-model", None, "older-model"])

    async def test_every_byte_is_bounded_and_all_items_survive_unicode_splits(self):
        for limit in (1, 127, 1024, 20000):
            with self.subTest(limit=limit):
                backend = HistoryBackend()
                cursor = ""
                content = bytearray()
                for _ in range(10000):
                    body, cursor, reset = await read_history_chunk(
                        backend.rpc, decode_cursor(cursor, "chat"), limit,
                    )
                    self.assertLessEqual(len(body), limit)
                    self.assertFalse(reset)
                    content.extend(body)
                    if not cursor:
                        break
                else:
                    self.fail("Pagination did not terminate")
                records = [json.loads(line) for line in content.splitlines()]
                items = [record["item"] for record in records if "item" in record]
                self.assertEqual([item["id"] for item in items], ["last", "large", "first"])
                self.assertEqual(items[1]["text"], backend.turns[0]["items"][1]["text"])
                self.assertEqual(items[0]["startedAtMs"], 1234567890123)
                self.assertEqual([r["turn"]["id"] for r in records if "turn" in r],
                                 ["recent", "empty", "old"])

    async def test_new_turns_do_not_move_the_older_history_boundary(self):
        backend = HistoryBackend()
        body, cursor, _ = await read_history_chunk(backend.rpc, decode_cursor("", "chat"), 200)
        backend.turns.append({"id": "newer", "status": "inProgress", "items": []})
        content = bytearray(body)
        while cursor:
            body, cursor, _ = await read_history_chunk(backend.rpc, decode_cursor(cursor, "chat"), 500)
            content.extend(body)
        records = [json.loads(line) for line in content.splitlines()]
        self.assertEqual([r["turn"]["id"] for r in records if "turn" in r], ["recent", "empty", "old"])

    async def test_changed_partial_item_restarts_only_its_unfinished_record(self):
        backend = HistoryBackend()
        backend.turns = [backend.turns[0]]
        _, cursor, _ = await read_history_chunk(backend.rpc, decode_cursor("", "chat"), 128)
        body, cursor, _ = await read_history_chunk(backend.rpc, decode_cursor(cursor, "chat"), 128)
        self.assertTrue(body)
        self.assertGreater(decode_cursor(cursor, "chat")["offset"], 0)
        backend.turns[0]["items"][1]["text"] = "Changed " + "🐝" * 300
        body, cursor, reset = await read_history_chunk(backend.rpc, decode_cursor(cursor, "chat"), 128)
        self.assertTrue(reset)
        content = bytearray(body)
        while cursor:
            body, cursor, _ = await read_history_chunk(backend.rpc, decode_cursor(cursor, "chat"), 128)
            content.extend(body)
        records = [json.loads(line) for line in content.splitlines()]
        self.assertEqual(records[0]["item"]["text"], backend.turns[0]["items"][1]["text"])

    async def test_invalid_backend_page_does_not_silently_drop_history(self):
        async def bad_rpc(method, params):
            return {"data": [], "nextCursor": "repeated"}
        with self.assertRaises(ValueError):
            await read_history_chunk(bad_rpc, decode_cursor("", "chat"), 1024)


class QuestionStatusTests(unittest.IsolatedAsyncioTestCase):
    async def test_latest_relevant_item_determines_status_without_reading_older_turns(self):
        question = {"id": "question", "type": "agentMessage", "phase": "final_answer",
                    "questions": [{"title": "Private question"}]}
        reply = {"id": "reply", "type": "userMessage"}
        final = {"id": "final", "type": "agentMessage", "phase": "final_answer"}
        progress = {"id": "progress", "type": "commandExecution", "output": "x" * 1000000}
        for items, pending in [([question, progress], True), ([question, reply, progress], False),
                               ([question, final], False), ([reply, question], True), ([], False)]:
            with self.subTest(pending=pending, ids=[item["id"] for item in items]):
                backend = HistoryBackend()
                backend.turns[-1]["items"] = items
                result = await read_pending_questions(backend.rpc, "chat")
                self.assertEqual(result, {"threadId": "chat", "turnId": "recent", "pending": pending})
                self.assertLess(len(json.dumps(result)), 100)
                self.assertTrue(all(params["turnId"] == "recent" for method, params in backend.calls
                                    if method == "thread/items/list"))

    async def test_completed_or_empty_chats_do_not_read_items(self):
        for empty in (False, True):
            backend = HistoryBackend()
            backend.turns[-1]["status"] = "completed"
            if empty:
                backend.turns = []
            self.assertFalse((await read_pending_questions(backend.rpc, "chat"))["pending"])
            self.assertEqual(len(backend.calls), 1)

    async def test_invalid_rows_and_cyclic_cursors_are_rejected(self):
        for mode in ("wrong-turn", "invalid-item", "cycle"):
            backend = HistoryBackend()
            calls = 0

            async def rpc(method, params):
                nonlocal calls
                if method == "thread/turns/list":
                    return await backend.rpc(method, params)
                calls += 1
                row = {"turnId": "wrong" if mode == "wrong-turn" else "recent",
                       "item": None if mode == "invalid-item" else {"type": "commandExecution"}}
                return {"data": [row], "nextCursor": "a" if calls % 2 else "b"}

            with self.subTest(mode=mode), self.assertRaises(ValueError):
                await read_pending_questions(rpc, "chat")
            self.assertLessEqual(calls, 3)


class HistoryHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.backend = HistoryBackend()

        async def websocket(request):
            socket = web.WebSocketResponse()
            await socket.prepare(request)
            async for message in socket:
                payload = message.json()
                if "id" not in payload:
                    continue
                result = await self.backend.rpc(payload["method"], payload["params"])
                await socket.send_json({"id": payload["id"], "result": result})
            return socket

        application = web.Application()
        application.router.add_get("/", websocket)
        self.upstream = TestServer(application)
        await self.upstream.start_server()
        self.addAsyncCleanup(self.upstream.close)
        self.enterContext(patch.dict(os.environ, {
            "CODEX_APP_SERVER_URL": str(self.upstream.make_url("/")).replace("http:", "ws:"),
            "CODEX_WORKSPACE_ROOT": str(Path(__file__).resolve().parents[1]),
            "CODEX_WEB_HISTORY_CHUNK_BYTES": "1024",
        }))
        self.server = TestServer(app.create_app())
        await self.server.start_server()
        self.addAsyncCleanup(self.server.close)
        self.client = ClientSession()
        self.addAsyncCleanup(self.client.close)

    async def test_http_downloads_are_bounded_and_configuration_is_exposed(self):
        async with self.client.get(self.server.make_url("/api/config")) as response:
            self.assertEqual((await response.json())["historyChunkBytes"], 1024)
        cursor = ""
        chunks = []
        while True:
            async with self.client.post(self.server.make_url("/api/history"), json={
                "threadId": "chat", "cursor": cursor,
            }) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                data = await response.read()
                self.assertLessEqual(len(data), 1024)
                chunks.append(data)
                cursor = response.headers["X-Codex-History-Cursor"]
            if not cursor:
                break
        records = [json.loads(line) for line in b"".join(chunks).splitlines()]
        self.assertEqual(len([r for r in records if "item" in r]), 3)
        self.assertGreater(len(chunks), 2)
        self.assertTrue(all(method in {"initialize", "thread/turns/list", "thread/items/list"}
                            for method, _ in self.backend.calls))

    async def test_compression_preserves_history_bytes_cursor_and_privacy(self):
        results = {}
        for encoding in ("identity", "gzip"):
            async with self.client.post(self.server.make_url("/api/history"),
                                        json={"threadId": "chat"},
                                        headers={"Accept-Encoding": encoding},
                                        auto_decompress=False) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertEqual(response.headers["Vary"], "Accept-Encoding")
                results[encoding] = (await response.read(), response.headers["X-Codex-History-Cursor"])
                if encoding == "gzip":
                    self.assertEqual(response.headers["Content-Encoding"], "gzip")
        self.assertEqual(gzip.decompress(results["gzip"][0]), results["identity"][0])
        self.assertLess(len(results["gzip"][0]), len(results["identity"][0]))
        self.assertEqual(results["gzip"][1], results["identity"][1])
        self.assertLessEqual(len(results["identity"][0]), 1024)

    async def test_bad_request_and_cross_thread_cursor_are_rejected(self):
        _, cursor, _ = await read_history_chunk(self.backend.rpc, decode_cursor("", "chat"), 1)
        for payload in ([], {}, {"threadId": "chat", "cursor": "invalid"},
                        {"threadId": "another-chat", "cursor": cursor}):
            async with self.client.post(self.server.make_url("/api/history"), json=payload) as response:
                self.assertEqual(response.status, 400)

    async def test_question_summary_is_small_private_and_uses_only_paginated_reads(self):
        self.backend.turns[-1]["items"] = [
            {"id": "question", "type": "agentMessage", "questions": [{"title": "Private question"}]},
            {"id": "tool", "type": "commandExecution", "output": "x" * 1000000},
        ]
        async with self.client.post(self.server.make_url("/api/thread-questions"), json={"threadId": "chat"}) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertLess(len(await response.read()), 100)
            self.assertEqual(await response.json(), {"threadId": "chat", "turnId": "recent", "pending": True})
        self.assertEqual([method for method, _ in self.backend.calls],
                         ["initialize", "thread/turns/list", "thread/items/list", "thread/items/list"])

    async def test_question_summary_rejects_bad_requests_and_reports_failures(self):
        for payload in ([], {}, {"threadId": 42}, {"threadId": ""}):
            async with self.client.post(self.server.make_url("/api/thread-questions"), json=payload) as response:
                self.assertEqual(response.status, 400)
        for error, status in [(ValueError("Invalid page"), 502), (TimeoutError(), 504)]:
            with patch("app.read_pending_questions", side_effect=error):
                async with self.client.post(self.server.make_url("/api/thread-questions"), json={"threadId": "chat"}) as response:
                    self.assertEqual(response.status, status)


class HistorySettingTests(unittest.TestCase):
    def test_default_empty_explicit_and_invalid_environment_values(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(app.history_chunk_limit(), 1_000_000)
            os.environ["CODEX_WEB_HISTORY_CHUNK_BYTES"] = ""
            self.assertEqual(app.history_chunk_limit(), 1_000_000)
            os.environ["CODEX_WEB_HISTORY_CHUNK_BYTES"] = " 2048 "
            self.assertEqual(app.history_chunk_limit(), 2048)
            for value in ("0", "-1", "1.5", "one MiB"):
                os.environ["CODEX_WEB_HISTORY_CHUNK_BYTES"] = value
                with self.assertRaisesRegex(RuntimeError, "CODEX_WEB_HISTORY_CHUNK_BYTES"):
                    app.create_app()
