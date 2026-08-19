"""Tiny same-origin web proxy for a Codex app-server WebSocket."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import mimetypes
import os
import re
import shutil
import stat
import uuid
from collections.abc import Iterator
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import unquote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from aiohttp import (
    ClientError,
    ClientSession,
    ClientTimeout,
    UnixConnector,
    WSMsgType,
    web,
)
from aiohttp.helpers import content_disposition_header

APP_VERSION = "0.9.3"
ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
MAX_MESSAGE_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
DEFAULT_MAX_UPLOAD_TOTAL_BYTES = 200 * 1024 * 1024
DEFAULT_MAX_UPLOAD_FILES = 12
DEFAULT_SEARCH_LIMIT = 100
MAX_SEARCH_LIMIT = 200
MAX_SEARCH_QUERY_CHARS = 256
MAX_SEARCH_SNIPPET_CHARS = 480
SEARCH_THREAD_PAGE_SIZE = 100
SEARCH_TIMEOUT_SECONDS = 120
SEARCH_RPC_TIMEOUT_SECONDS = 20
CHAT_SOURCE_KINDS = ["cli", "vscode", "appServer"]
LOG = logging.getLogger("codex-web")
ACTIVE_DOCUMENT_MIMES = {
    "application/xhtml+xml",
    "application/xml",
    "image/svg+xml",
    "text/html",
    "text/xml",
}


class BackendRPCError(Exception):
    def __init__(self, message: str, code: object = None) -> None:
        super().__init__(message)
        self.code = code


class BackendProtocolError(Exception):
    pass


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def env_int(name: str, default: int) -> int:
    raw = env(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value < 1:
        raise RuntimeError(f"{name} must be positive")
    return value


def upload_limits() -> tuple[int, int, int]:
    return (
        env_int("CODEX_UPLOAD_MAX_BYTES", DEFAULT_MAX_UPLOAD_BYTES),
        env_int("CODEX_UPLOAD_TOTAL_BYTES", DEFAULT_MAX_UPLOAD_TOTAL_BYTES),
        env_int("CODEX_UPLOAD_MAX_FILES", DEFAULT_MAX_UPLOAD_FILES),
    )


def upload_roots() -> tuple[Path, Path]:
    storage = Path(env("CODEX_UPLOAD_DIR", "/uploads"))
    visible = Path(env("CODEX_UPLOAD_HOST_DIR", "/workspaces/codex-web/uploads"))
    if not storage.is_absolute() or not visible.is_absolute():
        raise RuntimeError("upload paths must be absolute")
    storage.mkdir(parents=True, mode=0o700, exist_ok=True)
    metadata = storage.lstat()
    if not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError("upload storage is not a directory")
    storage.chmod(0o700)
    return storage, visible


def workspace_root() -> Path:
    configured = Path(env("CODEX_WORKSPACE_ROOT", "/workspaces"))
    if not configured.is_absolute():
        raise RuntimeError("CODEX_WORKSPACE_ROOT must be absolute")
    try:
        resolved = configured.resolve(strict=True)
    except OSError as exc:
        raise RuntimeError(f"workspace root is unavailable: {configured}") from exc
    if not resolved.is_dir():
        raise RuntimeError(f"workspace root is not a directory: {resolved}")
    return resolved


def resolve_workspace_file(raw_path: str, root: Path) -> Path:
    if not raw_path or "\0" in raw_path:
        raise web.HTTPBadRequest(text="A workspace file path is required")

    requested = Path(raw_path)
    if not requested.is_absolute():
        raise web.HTTPBadRequest(text="Workspace file paths must be absolute")

    candidates = [requested]
    location_suffix = re.fullmatch(r"(.+?)(?::\d+){1,2}", raw_path)
    if location_suffix:
        candidates.append(Path(location_suffix.group(1)))

    for candidate in candidates:
        try:
            resolved = candidate.resolve(strict=True)
        except (FileNotFoundError, NotADirectoryError):
            continue
        except OSError as exc:
            raise web.HTTPBadRequest(text="Invalid workspace file path") from exc
        try:
            resolved.relative_to(root)
        except ValueError as exc:
            raise web.HTTPForbidden(
                text="The requested file is outside /workspaces"
            ) from exc
        try:
            metadata = resolved.stat()
        except OSError as exc:
            raise web.HTTPNotFound(text="Workspace file not found") from exc
        if not stat.S_ISREG(metadata.st_mode):
            raise web.HTTPBadRequest(text="Only regular workspace files can be opened")
        return resolved

    raise web.HTTPNotFound(text="Workspace file not found")


def workspace_file_disposition(path: Path, force_download: bool) -> str:
    mime, _ = mimetypes.guess_type(path.name)
    safe_inline = bool(
        mime
        and mime not in ACTIVE_DOCUMENT_MIMES
        and (
            mime.startswith(("audio/", "image/", "text/", "video/"))
            or mime in {"application/json", "application/pdf"}
        )
    )
    return "inline" if safe_inline and not force_download else "attachment"


def safe_upload_name(filename: str) -> str:
    basename = unquote(filename).replace("\\", "/").rsplit("/", 1)[-1]
    suffix = re.sub(r"[^A-Za-z0-9.]", "", Path(basename).suffix)[:16]
    stem = (
        basename[: -len(Path(basename).suffix)] if Path(basename).suffix else basename
    )
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._-")[:100]
    stem = re.sub(r"\.{2,}", "_", stem)
    return f"{stem or 'upload'}{suffix}"


def image_mime(header: bytes) -> str | None:
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(header) >= 12 and header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "image/webp"
    return None


class UploadRejected(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@web.middleware
async def security_headers(request: web.Request, handler):
    response = await handler(request)
    response.headers.update(
        {
            "Cache-Control": "no-store",
            "Content-Security-Policy": (
                "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; "
                "style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; "
                "frame-ancestors 'none'; form-action 'self'"
            ),
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
        }
    )
    return response


async def index(_: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC / "index.html")


async def app_config(_: web.Request) -> web.Response:
    max_bytes, max_total_bytes, max_files = upload_limits()
    return web.json_response(
        {
            "defaultCwd": env("CODEX_DEFAULT_CWD", "/workspaces"),
            "workspaceRoot": str(workspace_root()),
            "uploads": {
                "maxBytes": max_bytes,
                "maxFiles": max_files,
                "maxTotalBytes": max_total_bytes,
            },
            "version": APP_VERSION,
        }
    )


async def upload_files(request: web.Request) -> web.Response:
    if not request.content_type.startswith("multipart/"):
        raise web.HTTPUnsupportedMediaType(text="Expected multipart form data")

    max_bytes, max_total_bytes, max_files = upload_limits()
    storage_root, visible_root = upload_roots()
    batch_id = uuid.uuid4().hex
    batch_dir = storage_root / batch_id
    batch_dir.mkdir(mode=0o700)
    uploaded: list[dict[str, object]] = []
    total_bytes = 0

    try:
        reader = await request.multipart()
        while part := await reader.next():
            if part.name != "files" or not part.filename:
                continue
            if len(uploaded) >= max_files:
                raise UploadRejected(413, f"At most {max_files} files are allowed")

            display_name = (
                unquote(part.filename).replace("\\", "/").rsplit("/", 1)[-1][:200]
            )
            stored_name = f"{uuid.uuid4().hex[:12]}-{safe_upload_name(part.filename)}"
            destination = batch_dir / stored_name
            size = 0
            header = bytearray()
            descriptor = os.open(
                destination,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            with os.fdopen(descriptor, "wb") as output:
                while chunk := await part.read_chunk(64 * 1024):
                    size += len(chunk)
                    total_bytes += len(chunk)
                    if size > max_bytes:
                        raise UploadRejected(
                            413,
                            f"{display_name or 'File'} exceeds the per-file limit",
                        )
                    if total_bytes > max_total_bytes:
                        raise UploadRejected(413, "Upload request is too large")
                    if len(header) < 16:
                        header.extend(chunk[: 16 - len(header)])
                    output.write(chunk)

            mime = image_mime(bytes(header))
            uploaded.append(
                {
                    "image": mime is not None,
                    "mime": mime
                    or part.headers.get("Content-Type", "application/octet-stream"),
                    "name": display_name or stored_name,
                    "path": str(visible_root / batch_id / stored_name),
                    "size": size,
                    "storedName": stored_name,
                }
            )
    except UploadRejected as exc:
        shutil.rmtree(batch_dir)
        return web.json_response({"error": str(exc)}, status=exc.status)
    except BaseException:
        shutil.rmtree(batch_dir)
        raise

    if not uploaded:
        batch_dir.rmdir()
        raise web.HTTPBadRequest(text="No files were uploaded")
    return web.json_response({"files": uploaded}, status=201)


async def workspace_file(request: web.Request) -> web.FileResponse:
    try:
        root = workspace_root()
    except RuntimeError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc)) from exc

    path = resolve_workspace_file(request.query.get("path", ""), root)
    force_download = request.query.get("download", "").lower() in {
        "1",
        "true",
        "yes",
    }
    disposition = workspace_file_disposition(path, force_download)
    mime, encoding = mimetypes.guess_type(path.name)
    headers = {
        "Content-Disposition": content_disposition_header(
            disposition,
            filename=path.name,
        ),
    }
    if mime:
        headers["Content-Type"] = mime
    if encoding:
        headers["Content-Encoding"] = encoding
    return web.FileResponse(
        path,
        headers=headers,
    )


def socket_is_ready(path: str) -> bool:
    try:
        return stat.S_ISSOCK(os.stat(path).st_mode)
    except OSError:
        return False


async def health(_: web.Request) -> web.Response:
    socket_path = env("CODEX_APP_SERVER_SOCKET", "/run/codex/app.sock")
    websocket_url = env("CODEX_APP_SERVER_URL")
    ready = bool(websocket_url) or socket_is_ready(socket_path)
    return web.json_response(
        {
            "ok": ready,
            "backend": "websocket" if websocket_url else "unix",
        },
        status=200 if ready else 503,
    )


async def connect_backend() -> tuple[ClientSession, object, str]:
    websocket_url = env("CODEX_APP_SERVER_URL")
    token = env("CODEX_APP_SERVER_TOKEN")
    headers = {"Authorization": f"Bearer {token}"} if token else None
    timeout = ClientTimeout(total=None, connect=10, sock_connect=10)

    if websocket_url:
        if not websocket_url.startswith(("ws://", "wss://")):
            raise RuntimeError("CODEX_APP_SERVER_URL must begin with ws:// or wss://")
        session = ClientSession(timeout=timeout)
        transport = "websocket"
        target = websocket_url
    else:
        socket_path = env("CODEX_APP_SERVER_SOCKET", "/run/codex/app.sock")
        if not socket_is_ready(socket_path):
            raise RuntimeError(f"Codex socket is not ready: {socket_path}")
        session = ClientSession(
            connector=UnixConnector(path=socket_path), timeout=timeout
        )
        transport = "unix"
        target = "http://codex-app-server/"

    try:
        upstream = await session.ws_connect(
            target,
            headers=headers,
            heartbeat=30,
            max_msg_size=MAX_MESSAGE_BYTES,
            compress=0,
        )
    except BaseException:
        await session.close()
        raise

    return session, upstream, transport


async def backend_rpc(
    upstream: object,
    request_id: int,
    method: str,
    params: dict[str, object],
    timeout_seconds: float = SEARCH_RPC_TIMEOUT_SECONDS,
) -> object:
    await upstream.send_str(
        json.dumps(
            {"id": request_id, "method": method, "params": params},
            separators=(",", ":"),
        )
    )
    if timeout_seconds <= 0:
        raise TimeoutError
    async with asyncio.timeout(timeout_seconds):
        while True:
            message = await upstream.receive()
            if message.type is WSMsgType.TEXT:
                try:
                    payload = json.loads(message.data)
                except json.JSONDecodeError as exc:
                    raise BackendProtocolError(
                        "Codex backend returned invalid JSON"
                    ) from exc
                if not isinstance(payload, dict):
                    raise BackendProtocolError(
                        "Codex backend returned an invalid message"
                    )
                if payload.get("id") != request_id or payload.get("method"):
                    continue
                if "error" in payload:
                    error = payload.get("error")
                    if isinstance(error, dict):
                        detail = str(error.get("message") or "Codex request failed")
                        code = error.get("code")
                    else:
                        detail = "Codex request failed"
                        code = None
                    raise BackendRPCError(detail, code)
                return payload.get("result")
            if message.type in {
                WSMsgType.CLOSE,
                WSMsgType.CLOSED,
                WSMsgType.CLOSING,
                WSMsgType.ERROR,
            }:
                raise BackendProtocolError("Codex backend closed the search connection")


def parse_search_date(value: str, field: str) -> date | None:
    if not value:
        return None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError(f"{field} must use YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field} must be a valid date") from exc


def parse_search_limit(value: object) -> int:
    if value is None or value == "":
        return DEFAULT_SEARCH_LIMIT
    if isinstance(value, bool):
        raise ValueError("limit must be an integer")
    try:
        limit = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit must be an integer") from exc
    if not 1 <= limit <= MAX_SEARCH_LIMIT:
        raise ValueError(f"limit must be between 1 and {MAX_SEARCH_LIMIT}")
    return limit


def parse_search_timezone(value: str) -> ZoneInfo:
    name = value or "UTC"
    if len(name) > 128 or "\0" in name:
        raise ValueError("timezone must be a valid IANA time zone")
    try:
        return ZoneInfo(name)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise ValueError("timezone must be a valid IANA time zone") from exc


def numeric_timestamp(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    timestamp = float(value)
    return timestamp if math.isfinite(timestamp) else None


def iso_timestamp(timestamp: float) -> str:
    return (
        datetime.fromtimestamp(timestamp, timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def unicode_casefold_match(text: str, query: str) -> tuple[int, int] | None:
    folded_query = query.casefold()
    folded_start = text.casefold().find(folded_query)
    if folded_start < 0:
        return None

    folded_end = folded_start + len(folded_query)
    original_start: int | None = None
    folded_offset = 0
    for index, character in enumerate(text):
        next_offset = folded_offset + len(character.casefold())
        if original_start is None and next_offset > folded_start:
            original_start = index
        if original_start is not None and next_offset >= folded_end:
            return original_start, index + 1
        folded_offset = next_offset
    return None


def matched_excerpt(
    text: str,
    match_start: int,
    match_end: int,
    max_chars: int,
) -> tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False

    match_length = match_end - match_start
    if match_length >= max_chars:
        start = match_start
        end = min(len(text), start + max_chars)
    else:
        context = max_chars - match_length
        before = min(match_start, context // 2)
        after = min(len(text) - match_end, context - before)
        before = min(match_start, context - after)
        start = match_start - before
        end = match_end + after
    prefix = "…" if start else ""
    suffix = "…" if end < len(text) else ""
    excerpt = f"{prefix}{text[start:end]}{suffix}"
    if len(excerpt) > max_chars + 2:
        excerpt = excerpt[: max_chars + 1] + "…"
    return excerpt, True


def user_message_text(item: dict[str, object]) -> str:
    content = item.get("content")
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for part in content:
        if (
            isinstance(part, dict)
            and part.get("type") == "text"
            and isinstance(part.get("text"), str)
        ):
            parts.append(part["text"])
    return "\n".join(filter(None, parts))


def thread_title(thread: dict[str, object]) -> str:
    for key in ("name", "preview"):
        value = thread.get(key)
        if isinstance(value, str) and value.strip():
            title = value.strip()
            return title if len(title) <= 200 else f"{title[:199]}…"
    return "Untitled thread"


def thread_message_matches(
    thread: dict[str, object],
    query: str,
    from_date: date | None,
    to_date: date | None,
    filter_zone: ZoneInfo,
    sequence_start: int,
) -> Iterator[dict[str, object]]:
    thread_id = thread.get("id")
    turns = thread.get("turns")
    if not isinstance(thread_id, str) or not isinstance(turns, list):
        return

    fallback_timestamp = numeric_timestamp(thread.get("createdAt")) or 0.0
    title = thread_title(thread)
    sequence = sequence_start
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        turn_id = turn.get("id")
        if not isinstance(turn_id, str):
            continue
        started_at = numeric_timestamp(turn.get("startedAt"))
        completed_at = numeric_timestamp(turn.get("completedAt"))
        items = turn.get("items")
        if not isinstance(items, list):
            continue

        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                continue
            item_type = item.get("type")
            if item_type == "userMessage":
                role = "user"
                text = user_message_text(item)
                timestamp = started_at
            elif item_type == "agentMessage" and isinstance(item.get("text"), str):
                role = "assistant"
                text = item["text"]
                timestamp = completed_at if completed_at is not None else started_at
            else:
                continue

            match = unicode_casefold_match(text, query)
            if match is None:
                continue
            if timestamp is None and (from_date is not None or to_date is not None):
                continue
            # App-server exposes timestamps on turns, not individual items. Keep the
            # source explicit so clients do not present this as an exact message time.
            timestamp_source = "turn" if timestamp is not None else "thread"
            timestamp = timestamp if timestamp is not None else fallback_timestamp
            try:
                message_date = (
                    datetime.fromtimestamp(timestamp, timezone.utc)
                    .astimezone(filter_zone)
                    .date()
                )
                formatted_timestamp = iso_timestamp(timestamp)
            except (OSError, OverflowError, ValueError):
                continue
            if from_date is not None and message_date < from_date:
                continue
            if to_date is not None and message_date > to_date:
                continue

            snippet, _ = matched_excerpt(
                text,
                match[0],
                match[1],
                MAX_SEARCH_SNIPPET_CHARS,
            )
            item_id = item["id"]
            yield {
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "messageId": item_id,
                "threadTitle": title,
                "title": title,
                "role": role,
                "snippet": snippet,
                "matchedText": text[match[0] : match[1]],
                "timestamp": formatted_timestamp,
                "createdAt": formatted_timestamp,
                "timestampSource": timestamp_source,
                "dateSource": timestamp_source,
                "_timestamp": timestamp,
                "_sequence": sequence,
            }
            sequence += 1


def trim_search_matches(
    matches: list[dict[str, object]],
    sort_direction: str,
    limit: int,
) -> None:
    matches.sort(
        key=lambda result: (
            -result["_timestamp"] if sort_direction == "desc" else result["_timestamp"],
            result["_sequence"],
        )
    )
    del matches[limit:]


async def list_search_threads(rpc) -> list[dict[str, object]]:
    threads: list[dict[str, object]] = []
    thread_ids: set[str] = set()
    cursor: str | None = None
    seen_cursors: set[str] = set()
    while True:
        params: dict[str, object] = {
            "archived": False,
            "limit": SEARCH_THREAD_PAGE_SIZE,
            "sourceKinds": CHAT_SOURCE_KINDS,
            "sortKey": "created_at",
            "sortDirection": "desc",
        }
        if cursor is not None:
            params["cursor"] = cursor
        response = await rpc("thread/list", params)
        if not isinstance(response, dict) or not isinstance(response.get("data"), list):
            raise BackendProtocolError("Codex backend returned an invalid thread list")
        for thread in response["data"]:
            if not isinstance(thread, dict):
                continue
            thread_id = thread.get("id")
            if isinstance(thread_id, str) and thread_id not in thread_ids:
                thread_ids.add(thread_id)
                threads.append(thread)

        next_cursor = response.get("nextCursor")
        if next_cursor is None:
            break
        if not isinstance(next_cursor, str) or not next_cursor:
            raise BackendProtocolError(
                "Codex backend returned an invalid search cursor"
            )
        if next_cursor in seen_cursors:
            raise BackendProtocolError("Codex backend repeated a search cursor")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    return threads


async def search_backend_history(
    query: str,
    sort_direction: str,
    from_date: date | None,
    to_date: date | None,
    filter_zone: ZoneInfo,
    limit: int,
) -> tuple[list[dict[str, object]], int, int, bool]:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + SEARCH_TIMEOUT_SECONDS
    session: ClientSession | None = None
    upstream = None
    next_request_id = 0

    async def rpc(method: str, params: dict[str, object]) -> object:
        nonlocal next_request_id
        if upstream is None:
            raise BackendProtocolError("Codex backend search connection is unavailable")
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise TimeoutError
        next_request_id += 1
        return await backend_rpc(
            upstream,
            next_request_id,
            method,
            params,
            min(SEARCH_RPC_TIMEOUT_SECONDS, remaining),
        )

    async def close_connection() -> None:
        nonlocal session, upstream
        closing_upstream = upstream
        closing_session = session
        upstream = None
        session = None
        if closing_upstream is not None and not closing_upstream.closed:
            try:
                async with asyncio.timeout(1):
                    await closing_upstream.close()
            except (TimeoutError, ClientError, OSError, RuntimeError):
                pass
        if closing_session is not None:
            await closing_session.close()

    async def connect_search_backend() -> None:
        nonlocal session, upstream, next_request_id
        await close_connection()
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise TimeoutError
        async with asyncio.timeout(remaining):
            session, upstream, _ = await connect_backend()
        next_request_id = 0
        try:
            await rpc(
                "initialize",
                {
                    "clientInfo": {
                        "name": "codex_web_search",
                        "title": "Codex Web Search",
                        "version": APP_VERSION,
                    },
                    "capabilities": {"experimentalApi": True},
                },
            )
            await upstream.send_str(
                json.dumps(
                    {"method": "initialized", "params": {}},
                    separators=(",", ":"),
                )
            )
        except BaseException:
            await close_connection()
            raise

    try:
        await connect_search_backend()
        threads = await list_search_threads(rpc)
        thread_ids = [
            summary["id"] for summary in threads if isinstance(summary.get("id"), str)
        ]
        matches: list[dict[str, object]] = []
        matched_count = 0
        skipped_threads = 0
        timed_out = False
        for index, thread_id in enumerate(thread_ids):
            if loop.time() >= deadline:
                skipped_threads += len(thread_ids) - index
                timed_out = True
                break
            try:
                response = await rpc(
                    "thread/read",
                    {"threadId": thread_id, "includeTurns": True},
                )
                if not isinstance(response, dict) or not isinstance(
                    response.get("thread"), dict
                ):
                    raise BackendProtocolError(
                        "Codex backend returned an invalid thread"
                    )
            except BackendRPCError as exc:
                if exc.code == -32601:
                    raise
                skipped_threads += 1
                LOG.warning("could not read thread %s for search: %s", thread_id, exc)
                continue
            except (TimeoutError, BackendProtocolError, ClientError, OSError) as exc:
                skipped_threads += 1
                detail = "timed out" if isinstance(exc, TimeoutError) else str(exc)
                LOG.warning(
                    "could not read thread %s for search: %s", thread_id, detail
                )
                remaining_threads = len(thread_ids) - index - 1
                if loop.time() >= deadline:
                    skipped_threads += remaining_threads
                    timed_out = True
                    break
                if not remaining_threads:
                    continue
                try:
                    await connect_search_backend()
                except TimeoutError:
                    skipped_threads += remaining_threads
                    timed_out = loop.time() >= deadline
                    break
                except (
                    BackendRPCError,
                    BackendProtocolError,
                    ClientError,
                    OSError,
                    RuntimeError,
                ) as reconnect_error:
                    LOG.warning(
                        "could not restore chat history search connection: %s",
                        reconnect_error,
                    )
                    skipped_threads += remaining_threads
                    break
                continue
            for match in thread_message_matches(
                response["thread"],
                query,
                from_date,
                to_date,
                filter_zone,
                matched_count,
            ):
                matched_count += 1
                matches.append(match)
                if len(matches) >= max(limit * 2, 64):
                    trim_search_matches(matches, sort_direction, limit)
            trim_search_matches(matches, sort_direction, limit)

        for result in matches:
            result.pop("_timestamp", None)
            result.pop("_sequence", None)
        return matches, matched_count, skipped_threads, timed_out
    finally:
        await close_connection()


async def search_chat_history(request: web.Request) -> web.Response:
    try:
        params = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return web.json_response(
            {"error": "Expected a JSON search request"}, status=400
        )
    if not isinstance(params, dict):
        return web.json_response(
            {"error": "Search request must be an object"}, status=400
        )

    def string_param(name: str, default: str = "") -> str:
        value = params.get(name, default)
        if value is None:
            return default
        if not isinstance(value, str):
            raise ValueError(f"{name} must be a string")
        return value

    try:
        query = string_param("q").strip()
        sort_value = string_param("sort", "newest").lower()
        from_date = parse_search_date(string_param("from"), "from")
        to_date = parse_search_date(string_param("to"), "to")
        limit = parse_search_limit(params.get("limit", ""))
        filter_zone = parse_search_timezone(string_param("timezone"))
        if from_date is not None and to_date is not None and from_date > to_date:
            raise ValueError("from must not be after to")
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)

    if not query:
        return web.json_response({"error": "q is required"}, status=400)
    if len(query) > MAX_SEARCH_QUERY_CHARS:
        return web.json_response(
            {"error": f"q must be at most {MAX_SEARCH_QUERY_CHARS} characters"},
            status=400,
        )

    sort_directions = {
        "newest": "desc",
        "oldest": "asc",
        "desc": "desc",
        "asc": "asc",
    }
    if sort_value not in sort_directions:
        return web.json_response({"error": "sort must be newest or oldest"}, status=400)
    try:
        matches, total, skipped_threads, timed_out = await search_backend_history(
            query,
            sort_directions[sort_value],
            from_date,
            to_date,
            filter_zone,
            limit,
        )
    except TimeoutError:
        return web.json_response({"error": "Chat history search timed out"}, status=504)
    except RuntimeError as exc:
        LOG.warning("chat history search backend unavailable: %s", exc)
        return web.json_response({"error": "Codex backend is unavailable"}, status=503)
    except (BackendRPCError, BackendProtocolError, ClientError, OSError) as exc:
        LOG.warning("chat history search failed: %s", exc)
        return web.json_response({"error": "Could not search chat history"}, status=502)

    return web.json_response(
        {
            "results": matches,
            "total": total,
            "truncated": total > len(matches),
            "partial": skipped_threads > 0,
            "skippedThreads": skipped_threads,
            "timedOut": timed_out,
            "timezone": filter_zone.key,
        }
    )


def proxy_notice(method: str, **params: object) -> str:
    return json.dumps({"method": method, "params": params}, separators=(",", ":"))


async def websocket_proxy(request: web.Request) -> web.WebSocketResponse:
    browser = web.WebSocketResponse(
        heartbeat=30,
        max_msg_size=MAX_MESSAGE_BYTES,
        compress=False,
    )
    await browser.prepare(request)

    try:
        session, upstream, transport = await connect_backend()
    except (ClientError, OSError, RuntimeError, asyncio.TimeoutError) as exc:
        LOG.warning("backend connection failed: %s", exc)
        await browser.send_str(proxy_notice("codex-web/error", message=str(exc)))
        await browser.close(code=1011, message=b"Codex backend unavailable")
        return browser

    await browser.send_str(proxy_notice("codex-web/connected", transport=transport))

    async def browser_to_backend() -> None:
        async for message in browser:
            if message.type is WSMsgType.TEXT:
                try:
                    payload = json.loads(message.data)
                except json.JSONDecodeError:
                    await browser.send_str(
                        proxy_notice(
                            "codex-web/error", message="Client sent invalid JSON"
                        )
                    )
                    continue
                if not isinstance(payload, dict):
                    await browser.send_str(
                        proxy_notice(
                            "codex-web/error",
                            message="Client message must be an object",
                        )
                    )
                    continue
                await upstream.send_str(message.data)
            elif message.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR}:
                break

    async def backend_to_browser() -> None:
        async for message in upstream:
            if message.type is WSMsgType.TEXT:
                await browser.send_str(message.data)
            elif message.type is WSMsgType.BINARY:
                await browser.send_bytes(message.data)
            elif message.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR}:
                break

    tasks = {
        asyncio.create_task(browser_to_backend()),
        asyncio.create_task(backend_to_browser()),
    }
    try:
        _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        await upstream.close()
        await session.close()
        await browser.close()

    return browser


def create_app() -> web.Application:
    _, max_upload_request_bytes, _ = upload_limits()
    application = web.Application(
        middlewares=[security_headers],
        client_max_size=max(MAX_MESSAGE_BYTES, max_upload_request_bytes),
    )
    application.add_routes(
        [
            web.get("/", index),
            web.get("/api/config", app_config),
            web.get("/api/files", workspace_file),
            web.post("/api/search", search_chat_history),
            web.post("/api/uploads", upload_files),
            web.get("/healthz", health),
            web.get("/ws", websocket_proxy),
            web.static("/static", STATIC, show_index=False, append_version=True),
        ]
    )
    return application


if __name__ == "__main__":
    logging.basicConfig(
        level=env("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    web.run_app(
        create_app(),
        host=env("HOST", "0.0.0.0"),
        port=int(env("PORT", "8000")),
        access_log=LOG,
        handler_cancellation=True,
    )
