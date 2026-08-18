# Codex Web

A deliberately small browser client for a Codex app-server running in a VS
Code devcontainer.

```text
browser → any-host-interface:8765 → Python container → shared Unix socket
        → Supervisor bridge → private Codex Unix socket → app-server
```

The Codex app-server itself remains off TCP. The bridge socket is
`runtime/app.sock`, mode `0600`, and both containers use UID/GID `1000`.

## Start it

Run this from a host terminal, outside the VS Code devcontainer:

```bash
cd /path/to/codex-web
docker compose up --build -d
```

Open <http://localhost:8765>, or `http://HOST_IP:8765` from another device. No
login is required. Press **Enter** to send; use **Shift+Enter** for a new line.
On a phone, use **Chats** to open the conversation drawer. Active conversations
have a green marker and continue in the background while you switch threads or
start another one. Conversations are ordered by their most recent activity,
newest first.

The interface follows the browser or OS light/dark preference by default. Open
the settings cog beside **Codex** to choose System, Light, or Dark. Explicit
Light or Dark choices are remembered in that browser.

Incoming output follows the bottom only while you are already near it. If you
scroll back through history, new output leaves the viewport in place and shows
**Jump to present** at the bottom of the chat.

Sending your own message always returns the view to the present so that the
message cannot land below the visible area. Switching among recently opened
conversations uses an eight-thread, in-memory browser-tab cache: chat history
and its scroll position appear immediately without another full
`thread/resume`. Streaming notifications keep cached background conversations
current. A page reload or new tab starts with an empty cache, and a WebSocket
reconnect shows cached content immediately before revalidating it with the
app-server.

While the selected conversation has a response in progress, an animated
**Codex is thinking** indicator appears after the latest chat item.

Use **Tune** to set per-chat model, reasoning effort, service tier,
personality, reasoning summary, approval policy, and permission profile. The
model catalog and compatible effort/service options come from the running
app-server. **Inherit current thread** sends no override; explicit choices
apply to the next message and stay selected for that conversation.

## Rich text

Chat messages render Markdown locally, including headings, lists, tables,
quotes, links, inline code, and fenced code blocks. Each fenced code block has
a compact top-right copy control. Inline `$...$` or `\(...\)`
and block `$$...$$` or `\[...\]` expressions render with KaTeX. Multiline
block delimiters should be on their own lines.

The browser bundle uses Marked, KaTeX, and DOMPurify. It is served entirely
from this container—there are no runtime CDN requests. Raw HTML is displayed
as text, rendered output is sanitized before insertion, and non-fragment links
open in a new tab.

Absolute Markdown links under `/workspaces/` open through the web app, including
Codex links with `:line` or `:line:column` suffixes. Compose mounts the parent
workspaces directory read-only, so the web container can read but cannot change
those files. Images, PDFs, source, and ordinary text open in the browser;
active document formats such as HTML and SVG download instead. Add
`&download=1` to a file URL to force a download.

## Attachments

Use **Attach**, drag files onto the composer, or paste an image from the
clipboard. Multiple files can be sent with one message.

- PNG, JPEG, GIF, and WebP files are sent as native Codex `localImage` inputs.
- Other files are stored under `/workspaces/codex-web/uploads/` and included in
  the prompt as local paths for Codex to inspect.
- The defaults allow 12 files, 50 MiB per file, and 200 MiB total per upload.
  Set `CODEX_UPLOAD_MAX_FILES`, `CODEX_UPLOAD_MAX_BYTES`, or
  `CODEX_UPLOAD_TOTAL_BYTES` in `compose.yaml` to change them.
- Uploads persist so resumed threads retain valid paths. Remove old batches
  manually from `uploads/` when they are no longer needed.

The Compose port always binds to all host IPv4 interfaces (`0.0.0.0`). To
override the port:

```bash
CODEX_WEB_PORT=9000 docker compose up --build -d
```

## Operate it

On the host:

```bash
docker compose ps
docker compose logs -f codex-web
docker compose restart codex-web
docker compose down
```

Inside the VS Code devcontainer:

```bash
sudo supervisorctl -c /etc/supervisor/supervisord.conf status \
  codex-app-server codex-app-server-bridge
stat -Lc '%F %a %U:%G %n' \
  "$HOME/.local/run/codex/app.sock" \
  /workspaces/codex-web/runtime/app.sock
```

## Notes

- The web container stores no OpenAI credential. Authentication stays in the
  devcontainer's Codex app-server process.
- The official app-server protocol has a native local-image input but no
  general local-file input. Non-image uploads are therefore passed as local
  workspace paths.
- The UI can approve commands and file changes. It intentionally has no login
  or WebSocket Origin restriction. Anyone who can reach port `8765` can operate
  Codex with the devcontainer user's permissions. Do not expose it to the
  internet; use a firewall or trusted network boundary.
- The web container has read-only access to the entire host workspaces parent
  directory so local file links work. Consequently, anyone who can reach the
  unauthenticated service can download any regular file readable beneath
  `/workspaces` if they know its path. Paths outside that root, directories,
  special files, and symlinks escaping it are rejected.
- This is a compact text client. It handles threads, streaming messages,
  commands, file changes, interruption, approvals, and ordinary user-input
  requests. Unrecognized server requests are shown and can be rejected.
- Codex app-server and its WebSocket transports are experimental, so a future
  Codex release may require corresponding client updates. The settings panel
  intentionally uses `model/list` rather than embedding a fixed model list.

## Local checks

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm ci
npm run build
npm run test:markdown
npm run test:links
npm run test:theme
.venv/bin/python -m unittest discover -s tests -v
node tests/render.test.js
node --check static/app.js
docker compose config --quiet
```
