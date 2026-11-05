"""Real web app and pin database with synthetic conversations for browser checks."""

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


async def main():
    threads = [{"id": key, "name": key.title(), "recencyAt": 300 - index,
                "cwd": "/workspaces", "status": {"type": "idle"}, "turns": []}
               for index, key in enumerate(("recent", "middle", "old"))]
    sockets = set()

    async def websocket(request):
        socket = web.WebSocketResponse()
        await socket.prepare(request)
        sockets.add(socket)
        try:
            async for message in socket:
                payload = message.json()
                if "id" not in payload:
                    continue
                method = payload["method"]
                if method in {"initialize", "account/rateLimits/read", "account/read"}:
                    result = {}
                elif method == "thread/list":
                    result = {"data": threads, "nextCursor": None}
                elif method == "config/read":
                    result = {"config": {}}
                elif method == "configRequirements/read":
                    result = {"requirements": None}
                elif method in {"model/list", "permissionProfile/list"}:
                    result = {"data": []}
                else:
                    raise AssertionError(f"Unexpected RPC: {method}")
                await socket.send_json({"id": payload["id"], "result": result})
        finally:
            sockets.discard(socket)
        return socket

    upstream = web.Application()
    upstream.router.add_get("/", websocket)
    async with TestServer(upstream) as backend:
        with tempfile.TemporaryDirectory() as directory:
            os.environ.update(CODEX_APP_SERVER_URL=str(backend.make_url("/")).replace("http:", "ws:"),
                              CODEX_WORKSPACE_ROOT=directory, CODEX_WEB_STATE_DIR=directory + "/state")
            frontend = TestServer(app.create_app())
            await frontend.start_server()
            print(json.dumps({"url": str(frontend.make_url("/"))}), flush=True)
            try:
                while line := await asyncio.to_thread(sys.stdin.readline):
                    if line.strip() == "restart":
                        port = frontend.port
                        for socket in tuple(frontend.app[app.PIN_CLIENTS]):
                            await socket.close()
                        await frontend.close()
                        frontend = TestServer(app.create_app(), port=port)
                        await frontend.start_server()
                        print(json.dumps({"restarted": True}), flush=True)
                    elif line.strip() == "archive":
                        threads[:] = [thread for thread in threads if thread["id"] != "old"]
                        for socket in tuple(sockets):
                            await socket.send_json({"method": "thread/archived", "params": {"threadId": "old"}})
                    elif line.strip() == "stop":
                        break
            finally:
                for socket in tuple(frontend.app[app.PIN_CLIENTS]):
                    await socket.close()
                await frontend.close()


asyncio.run(main())
