# Codex Web

Unofficial, self-hosted mobile web UI for an always-on Codex host. It targets
the headless-host use case in [openai/codex#23200](https://github.com/openai/codex/issues/23200): use Codex from a phone browser without keeping a desktop app online.

No devcontainer is required. The host may be Linux, macOS, WSL, a VM/VPS, or a
container. This is an independent client, not ChatGPT-mobile integration;
OpenAI's experimental managed-client path is [`codex remote-control`](https://developers.openai.com/codex/developer-commands#codex-remote-control).

```text
phone/browser :8765 → Codex Web → private Unix socket → codex app-server
```

## Run

Requires Python 3.12+ and an authenticated Codex CLI. From this repository:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
mkdir -p runtime uploads && chmod 700 runtime uploads
rm -f runtime/app.sock
codex app-server --listen "unix://$PWD/runtime/app.sock"
```

In another terminal:

```bash
ROOT=/absolute/path/to/projects
CODEX_APP_SERVER_SOCKET="$PWD/runtime/app.sock" \
CODEX_DEFAULT_CWD="$ROOT" CODEX_WORKSPACE_ROOT="$ROOT" \
CODEX_UPLOAD_DIR="$PWD/uploads" CODEX_UPLOAD_HOST_DIR="$PWD/uploads" \
HOST=0.0.0.0 PORT=8765 .venv/bin/python app.py
```

Open `http://HOST_IP:8765`. Use systemd, Supervisor, or another service manager
for restart/reboot persistence. [App-server is experimental](https://developers.openai.com/codex/app-server).

## Docker web process

The Compose service runs Codex Web only; start app-server separately as above.

```bash
ROOT=/absolute/path/to/projects
CODEX_WEB_UID="$(id -u)" CODEX_WEB_GID="$(id -g)" \
CODEX_WORKSPACE_HOST_PATH="$ROOT" CODEX_WORKSPACE_ROOT="$ROOT" \
CODEX_DEFAULT_CWD="$ROOT" CODEX_UPLOAD_HOST_DIR="$PWD/uploads" \
docker compose up --build -d
```

For a containerized Codex host, share the socket directory and expose workspace
files at the same absolute paths.

## Security

There is no login or Origin check, and the web server binds all interfaces.
Anyone with access can operate Codex and read `CODEX_WORKSPACE_ROOT`. Use a VPN
or firewall; never expose it directly to the internet.

## Operate / test

```bash
docker compose ps
docker compose logs -f codex-web
docker compose restart codex-web
docker compose down

npm ci && npm run build
npm run test:markdown && npm run test:links
npm run test:copy && npm run test:theme
node tests/render.test.js && node --check static/app.js
.venv/bin/python -m unittest discover -s tests -v
docker compose config --quiet
```
