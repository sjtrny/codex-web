"""Tiny same-origin web proxy for a Codex app-server WebSocket."""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import os
import re
import shutil
import stat
import uuid
from pathlib import Path
from urllib.parse import unquote

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
LOG = logging.getLogger("codex-web")
ACTIVE_DOCUMENT_MIMES = {
    "application/xhtml+xml",
    "application/xml",
    "image/svg+xml",
    "text/html",
    "text/xml",
}


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
    )
