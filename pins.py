"""Persistent shared pins. Explicit unpins also prevent stale browser imports."""

from __future__ import annotations

import sqlite3
import uuid
from contextlib import closing
from pathlib import Path


class PinStore:
    def __init__(self, directory: Path) -> None:
        if not directory.is_absolute():
            raise RuntimeError("CODEX_WEB_STATE_DIR must be absolute")
        self.directory = directory
        self.path = directory / "pins.sqlite3"

    def snapshot(self, *, changes: dict[str, bool] | None = None,
                 imports: list[str] | None = None) -> dict:
        self.directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        with closing(sqlite3.connect(self.path, timeout=10)) as connection:
            self.path.chmod(0o600)
            # Each request has its own connection; the transaction also protects
            # concurrent workers and imports from different browsers.
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS metadata "
                    "(id INTEGER PRIMARY KEY CHECK (id = 1), store_id TEXT, revision INTEGER)"
                )
                connection.execute(
                    "INSERT OR IGNORE INTO metadata VALUES (1, ?, 0)", (uuid.uuid4().hex,)
                )
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS pins "
                    "(thread_id TEXT PRIMARY KEY, pinned INTEGER NOT NULL)"
                )
                before = connection.total_changes
                for thread_id in imports or []:
                    # Never overwrite a server decision, including an unpin.
                    connection.execute(
                        "INSERT OR IGNORE INTO pins VALUES (?, 1)", (thread_id,)
                    )
                for thread_id, pinned in (changes or {}).items():
                    connection.execute(
                        "INSERT INTO pins VALUES (?, ?) ON CONFLICT(thread_id) "
                        "DO UPDATE SET pinned = excluded.pinned WHERE pinned != excluded.pinned",
                        (thread_id, int(pinned)),
                    )
                if connection.total_changes > before:
                    connection.execute("UPDATE metadata SET revision = revision + 1")
                store_id, revision = connection.execute(
                    "SELECT store_id, revision FROM metadata WHERE id = 1"
                ).fetchone()
                thread_ids = [row[0] for row in connection.execute(
                    "SELECT thread_id FROM pins WHERE pinned = 1 ORDER BY thread_id"
                )]
                return {"storeId": store_id, "revision": revision, "threadIds": thread_ids}
