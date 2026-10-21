"""Isolated browser fixture: real proxy and pagination, synthetic Codex backend."""

import asyncio
import json
import os
import tempfile

from aiohttp import web
from aiohttp.test_utils import TestServer

from test_history import HistoryBackend, app


async def main():
    backend = HistoryBackend()
    backend.turns = [
        {"id": f"turn-{turn}", "status": "completed", "items": [
            {"id": f"item-{turn}-{item}", "type": "agentMessage", "phase": "final_answer",
             "text": f"Message {turn}-{item}\n\n" + ("A readable history paragraph. " * 24)
             + ("🦜" * 2500 if (turn, item) == (2, 4) else "")}
            for item in range(8)
        ]}
        for turn in range(6)
    ]
    threads = [{"id": key, "name": f"History {key}", "cwd": "/workspaces",
                "status": {"type": "idle"}, "turns": []} for key in ("a", "b")]

    async def websocket(request):
        socket = web.WebSocketResponse()
        await socket.prepare(request)
        async for message in socket:
            payload = message.json()
            if "id" not in payload:
                continue
            method = payload["method"]
            if method in {"initialize", "thread/turns/list", "thread/items/list"}:
                result = await backend.rpc(method, payload["params"])
            elif method == "thread/list":
                result = {"data": threads, "nextCursor": None}
            elif method == "thread/resume":
                assert payload["params"]["excludeTurns"] is True
                result = {"thread": next(thread for thread in threads if thread["id"] == payload["params"]["threadId"])}
            elif method == "config/read":
                result = {"config": {}}
            elif method == "configRequirements/read":
                result = {"requirements": None}
            elif method == "account/rateLimits/read":
                result = {}
            elif method in {"model/list", "permissionProfile/list"}:
                result = {"data": []}
            else:
                raise AssertionError(f"Unexpected RPC: {method}")
            await socket.send_json({"id": payload["id"], "result": result})
        return socket

    upstream = web.Application()
    upstream.router.add_get("/", websocket)
    async with TestServer(upstream) as backend_server:
        with tempfile.TemporaryDirectory() as workspace:
            os.environ.update(
                CODEX_APP_SERVER_URL=str(backend_server.make_url("/")).replace("http:", "ws:"),
                CODEX_WORKSPACE_ROOT=workspace,
                CODEX_WEB_HISTORY_CHUNK_BYTES="4096",
            )
            async with TestServer(app.create_app()) as frontend:
                print(json.dumps({"url": str(frontend.make_url("/"))}), flush=True)
                await asyncio.Event().wait()


asyncio.run(main())
