"""Real proxy with a realistic sidebar and large, synthetic conversation history."""

import asyncio
import json
import os
import random
import sys
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestServer

sys.path.insert(0, os.environ.get("PERF_SOURCE", str(Path(__file__).resolve().parents[1])))
import app


async def main():
    rng = random.Random(42)
    vocabulary = [f"word{n:04d}" for n in range(2000)]
    threads = [{
        "id": f"chat-{n:04d}", "sessionId": f"session-{n:04d}", "forkedFromId": None,
        "parentThreadId": None, "preview": " ".join(rng.choices(vocabulary, k=27)),
        "ephemeral": False, "section": None, "sectionEnteredAt": None,
        "projectId": None, "historyMode": "persistent", "modelProvider": "openai",
        "model": "test-model", "reasoningEffort": "medium", "createdAt": 1791432000-n,
        "updatedAt": 1791432000-n, "recencyAt": 1791432000-n, "status": {"type": "idle"},
        "path": "/workspace/runtime/sessions/2026/10/22/" + f"synthetic-session-{n:04d}-" * 4,
        "cwd": "/workspaces", "cliVersion": "0.159.1", "originator": "codex-web",
        "source": "appServer", "threadSource": None, "agentNickname": None,
        "agentRole": None, "gitInfo": None, "name": None, "daybreakEnabled": False,
        "canAcceptDirectInput": None, "environments": [{"cwd": "/workspaces"}],
        "extra": {}, "turns": [],
    } for n in range(50)]
    items = [{"id": "prompt", "type": "userMessage", "content": [{"type": "text", "text": "A synthetic task"}]}]
    items.extend({"id": f"tool-{n}", "type": "commandExecution", "status": "completed",
                  "command": "synthetic command", "aggregatedOutput": " ".join(rng.choices(vocabulary, k=450))}
                 for n in range(275))
    items.append({"id": "answer", "type": "agentMessage", "phase": "final_answer", "text": "Ready to work"})

    async def websocket(request):
        socket = web.WebSocketResponse()
        await socket.prepare(request)
        tasks = set()

        async def respond(payload):
            method, params = payload["method"], payload.get("params", {})
            await asyncio.sleep(0.19 if method == "thread/list" else 0.001)
            if method == "thread/list":
                result = {"data": threads, "nextCursor": None}
            elif method in {"thread/read", "thread/resume"}:
                result = {"thread": next(row for row in threads if row["id"] == params["threadId"])}
            elif method == "thread/turns/list":
                result = {"data": [{"id": "turn", "status": "completed", "items": []}], "nextCursor": None}
            elif method == "thread/items/list":
                rows = list(reversed(items))
                start = int(params.get("cursor") or 0)
                selected = rows[start:start+params["limit"]]
                next_index = start + len(selected)
                result = {"data": [{"id": item["id"], "turnId": "turn", "item": item} for item in selected],
                          "nextCursor": str(next_index) if next_index < len(rows) else None}
            elif method == "model/list":
                result = {"data": [{"id": "test-model", "model": "test-model", "supportedReasoningEfforts": []}]}
            elif method == "permissionProfile/list":
                result = {"data": []}
            elif method in {"initialize", "config/read", "configRequirements/read", "account/rateLimits/read"}:
                result = {}
            else:
                raise AssertionError(f"Unexpected RPC: {method}")
            raw = json.dumps({"id": payload["id"], "result": result}, separators=(",", ":"))
            if not socket.closed:
                await socket.send_str(raw)

        async for message in socket:
            payload = message.json()
            if "id" in payload:
                task = asyncio.create_task(respond(payload))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
        await asyncio.gather(*tasks, return_exceptions=True)
        return socket

    backend = web.Application()
    backend.router.add_get("/", websocket)
    async with TestServer(backend) as upstream:
        os.environ.update(CODEX_APP_SERVER_URL=str(upstream.make_url("/")).replace("http:", "ws:"),
                          CODEX_WEB_HISTORY_CHUNK_BYTES="1000000", CODEX_WEB_SHOW_TOOL_ACTIVITY="false")
        async with TestServer(app.create_app()) as frontend:
            print(json.dumps({"url": str(frontend.make_url("/"))}), flush=True)
            await asyncio.Event().wait()


asyncio.run(main())
