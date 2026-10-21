"""Real HTTP/proxy stack with synthetic conversations for mobile load checks."""

import asyncio
import json
import os
import sys
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestServer

sys.path.insert(0, os.environ.get("PERF_SOURCE", str(Path(__file__).resolve().parents[1])))
import app


async def main():
    threads = [{"id": name, "name": f"Performance {name}", "cwd": "/workspaces",
                "model": "test-model", "status": {"type": "idle"}, "turns": []}
               for name in ("plain", "math")]

    async def websocket(request):
        socket = web.WebSocketResponse()
        await socket.prepare(request)
        tasks = set()

        async def respond(payload):
            method, params = payload["method"], payload.get("params", {})
            await asyncio.sleep(float(os.environ.get("PERF_RPC_DELAY", "0.15")))
            if method == "config/read":
                await asyncio.sleep(float(os.environ.get("PERF_SETTINGS_DELAY", "0")))
            if method == "thread/list":
                result = {"data": threads, "nextCursor": None}
            elif method in {"thread/read", "thread/resume"}:
                result = {"thread": next(row for row in threads if row["id"] == params["threadId"])}
            elif method == "thread/turns/list":
                result = {"data": [{"id": "turn", "status": "completed", "items": []}], "nextCursor": None}
            elif method == "thread/items/list":
                text = "## Ready to work\n\nThis is a **readable conversation** on a slow mobile connection.\n\n" + "A short paragraph of ordinary Markdown. " * 12
                if params["threadId"] == "math":
                    text += "\n\nInline $x^2$ and \\(y^2\\).\n\n\\[E=mc^2\\]\n"
                item = {"id": "answer", "type": "agentMessage", "phase": "final_answer", "text": text}
                result = {"data": [{"id": "answer", "turnId": "turn", "item": item}], "nextCursor": None}
            elif method == "model/list":
                result = {"data": [{"id": "test-model", "model": "test-model", "displayName": "Test model",
                                    "supportedReasoningEfforts": [], "serviceTiers": []}]}
            elif method == "permissionProfile/list":
                result = {"data": []}
            elif method in {"initialize", "config/read", "configRequirements/read", "account/rateLimits/read"}:
                result = {}
            else:
                await socket.send_json({"id": payload["id"], "error": {"message": f"Unexpected RPC: {method}"}})
                return
            if not socket.closed:
                await socket.send_json({"id": payload["id"], "result": result})

        async for message in socket:
            payload = message.json()
            if "id" in payload:
                task = asyncio.create_task(respond(payload))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
        await asyncio.gather(*tasks, return_exceptions=True)
        return socket

    upstream = web.Application()
    upstream.router.add_get("/", websocket)
    async with TestServer(upstream) as backend:
        os.environ["CODEX_APP_SERVER_URL"] = str(backend.make_url("/")).replace("http:", "ws:")
        os.environ["CODEX_WEB_HISTORY_CHUNK_BYTES"] = "1000000"
        async with TestServer(app.create_app()) as frontend:
            print(json.dumps({"url": str(frontend.make_url("/"))}), flush=True)
            await asyncio.Event().wait()


asyncio.run(main())
