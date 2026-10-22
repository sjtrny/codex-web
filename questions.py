"""Read a compact question status without transferring history to the browser."""

from history import history_page


async def read_pending_questions(rpc, thread_id):
    turns, _ = history_page(await rpc("thread/turns/list", {
        "threadId": thread_id, "itemsView": "notLoaded", "sortDirection": "desc",
        "limit": 1, "cursor": None,
    }), None)
    turn = turns[0] if turns else None
    if turn is not None and (not isinstance(turn, dict) or not isinstance(turn.get("id"), str)
                             or not turn["id"]):
        raise ValueError("Invalid question turn")
    result = {"threadId": thread_id, "turnId": turn["id"] if turn else None, "pending": False}
    if not turn or turn.get("status") != "inProgress":
        return result
    cursor = None
    seen = set()
    while True:
        rows, next_cursor = history_page(await rpc("thread/items/list", {
            "threadId": thread_id, "turnId": turn["id"], "sortDirection": "desc",
            "limit": 1, "cursor": cursor,
        }), cursor)
        for row in rows:
            if not isinstance(row, dict) or row.get("turnId") != turn["id"]:
                raise ValueError("Invalid question item turn")
            item = row.get("item")
            if not isinstance(item, dict):
                raise ValueError("Invalid question item")
            # Newest first: a reply or final answer clears all older questions.
            if item.get("type") == "userMessage":
                return result
            if item.get("type") == "agentMessage":
                if isinstance(item.get("questions"), list) and item["questions"]:
                    return {**result, "pending": True}
                if item.get("phase") == "final_answer":
                    return result
        if not next_cursor:
            return result
        if next_cursor in seen:
            raise ValueError("Repeated question cursor")
        seen.add(next_cursor)
        cursor = next_cursor
