"""Byte-bounded, newest-first history using app-server's read-only pagination."""

from __future__ import annotations

import base64
import hashlib
import json


def encode_cursor(cursor: dict | None) -> str:
    if cursor is None:
        return ""
    return base64.urlsafe_b64encode(
        json.dumps(cursor, separators=(",", ":")).encode()
    ).decode()


def decode_cursor(value: str, thread_id: str) -> dict:
    if not value:
        return {
            "threadId": thread_id, "turn": None, "turnCursor": None,
            "stage": "turn", "itemCursor": None, "offset": 0,
        }
    try:
        cursor = json.loads(base64.b64decode(value, altchars=b"-_", validate=True))
        if not isinstance(cursor, dict) or cursor.get("threadId") != thread_id:
            raise ValueError
        if not {"turn", "turnCursor", "itemCursor", "offset", "stage"}.issubset(cursor):
            raise ValueError
        if cursor.get("stage") not in {"turn", "items"}:
            raise ValueError
        if type(cursor.get("offset")) is not int or cursor["offset"] < 0:
            raise ValueError
        for key in ("turnCursor", "itemCursor", "digest"):
            if cursor.get(key) is not None and not isinstance(cursor[key], str):
                raise ValueError
        turn = cursor.get("turn")
        if turn is not None and (
            not isinstance(turn, dict) or not isinstance(turn.get("id"), str)
            or not isinstance(turn.get("status"), str)
        ):
            raise ValueError
        if cursor["offset"] and not cursor.get("digest"):
            raise ValueError
        if turn is None and (cursor["stage"] != "turn" or cursor["offset"]):
            raise ValueError
        return cursor
    except (ValueError, TypeError, KeyError) as exc:
        raise ValueError("Invalid history cursor") from exc


def history_page(response: object, cursor: str | None) -> tuple[list, str | None]:
    if not isinstance(response, dict) or not isinstance(response.get("data"), list):
        raise ValueError("Invalid history page from Codex backend")
    next_cursor = response.get("nextCursor")
    if next_cursor is not None and (
        not isinstance(next_cursor, str) or not next_cursor or next_cursor == cursor
    ):
        raise ValueError("Invalid history continuation from Codex backend")
    if not response["data"] and next_cursor is not None:
        raise ValueError("Empty history page has a continuation")
    return response["data"], next_cursor


async def read_history_chunk(rpc, cursor: dict, limit: int) -> tuple[bytes, str, bool]:
    """Return at most limit bytes, a continuation, and a fragment-reset flag.

    NDJSON records are ordered newest first, including within each turn. A
    record larger than the budget spans requests. The browser retains its
    unfinished line until the next chunk; no message content is truncated.
    Only turn metadata and backend cursors travel in the continuation header.
    """
    cursor = dict(cursor)
    output = bytearray()
    reset_fragment = False
    while cursor is not None and len(output) < limit:
        if cursor["turn"] is None:
            response = await rpc("thread/turns/list", {
                "threadId": cursor["threadId"], "limit": 1,
                "itemsView": "notLoaded", "sortDirection": "desc",
                "cursor": cursor["turnCursor"],
            })
            turns, next_turn = history_page(response, cursor["turnCursor"])
            if not turns:
                cursor = None
                break
            turn = turns[0]
            if not isinstance(turn, dict) or not turn.get("id") or not turn.get("status"):
                raise ValueError("Invalid history turn from Codex backend")
            cursor.update(
                turn={key: turn[key] for key in (
                    "id", "status", "startedAt", "completedAt", "durationMs",
                ) if key in turn},
                turnCursor=next_turn, stage="turn", itemCursor=None,
            )

        if cursor["stage"] == "turn":
            record = {"turn": cursor["turn"]}
            following = {**cursor, "stage": "items", "offset": 0}
        else:
            response = await rpc("thread/items/list", {
                "threadId": cursor["threadId"], "turnId": cursor["turn"]["id"],
                "limit": 1, "sortDirection": "desc", "cursor": cursor["itemCursor"],
            })
            items, next_item = history_page(response, cursor["itemCursor"])
            if items:
                row = items[0]
                if not isinstance(row, dict) or not isinstance(row.get("item"), dict):
                    raise ValueError("Invalid history item from Codex backend")
                if row.get("turnId") != cursor["turn"]["id"]:
                    raise ValueError("History item belongs to another turn")
                item = dict(row["item"])
                for field in ("startedAtMs", "completedAtMs"):
                    if row.get(field) is not None:
                        item[field] = row[field]
                record = {"turnId": row["turnId"], "item": item}
            following = {**cursor, "itemCursor": next_item, "offset": 0}
            if next_item is None:
                following = (
                    {**following, "turn": None, "stage": "turn"}
                    if cursor["turnCursor"] is not None else None
                )
            if not items:
                if cursor["offset"]:
                    reset_fragment = True
                cursor = following
                continue

        # ASCII escapes make even one-byte budgets and splits inside Unicode
        # lossless. The limit counts the actual uncompressed response body.
        encoded = (json.dumps(record, separators=(",", ":"), ensure_ascii=True) + "\n").encode()
        offset = cursor["offset"]
        digest = hashlib.sha256(encoded).hexdigest()
        if offset and cursor.get("digest") != digest:
            # A running item can grow between requests. Restart just this
            # unfinished record instead of combining two incompatible versions.
            offset = 0
            reset_fragment = True
        remaining = limit - len(output)
        if len(encoded) - offset > remaining and output:
            break  # Keep ordinary records whole when they fit in a fresh chunk.
        part = encoded[offset:offset + remaining]
        output.extend(part)
        offset += len(part)
        if offset < len(encoded):
            cursor.update(offset=offset, digest=digest)
            break
        cursor = following
        if cursor is not None:
            cursor.pop("digest", None)
    return bytes(output), encode_cursor(cursor), reset_fragment
