# Codex Web

Self-hosted mobile web UI for [Codex app-server](https://developers.openai.com/codex/app-server), inspired by [openai/codex#23200](https://github.com/openai/codex/issues/23200).

```text
browser → Codex Web → Unix socket → codex app-server
```

## Codex

Run app-server as your normal Codex user:

```bash
cd /absolute/path/to/codex-web
export CODEX_APP_SERVER_SOCKET="$PWD/runtime/app.sock"
install -d -m 700 "${CODEX_APP_SERVER_SOCKET%/*}"
rm -f "$CODEX_APP_SERVER_SOCKET"
"$(readlink -f "$(type -P codex)")" app-server \
  --listen "unix://$CODEX_APP_SERVER_SOCKET"
```

Keep it running with a service manager. To use the same server from Bash, add
to `~/.bashrc`:

```bash
export CODEX_APP_SERVER_SOCKET=/absolute/path/to/codex-web/runtime/app.sock
source /absolute/path/to/codex-web/codex-remote.bash
```

`codex`, `resume`, `fork`, `archive`, `delete`, and `unarchive` use app-server.
Other subcommands and `codex-local` use the local executable. App-server is
[experimental](https://developers.openai.com/codex/developer-commands).

## Web

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
mkdir -p runtime uploads && chmod 700 runtime uploads
```

Then:

```bash
ROOT=/absolute/path/to/projects
CODEX_APP_SERVER_SOCKET="$PWD/runtime/app.sock" \
CODEX_DEFAULT_CWD="$ROOT" CODEX_WORKSPACE_ROOT="$ROOT" \
CODEX_UPLOAD_DIR="$PWD/uploads" CODEX_UPLOAD_HOST_DIR="$PWD/uploads" \
HOST=0.0.0.0 PORT=8765 .venv/bin/python app.py
```

Open `http://HOST_IP:8765`. Use a service manager for persistence.

Alternatively, configure the same socket and paths in Compose, then run:

```bash
docker compose up --build -d
```

## Security

The UI is unauthenticated and listens on all interfaces. Keep it behind a VPN
or firewall.

## Test

```bash
npm ci && npm run build
npm run test:markdown && npm run test:links
npm run test:copy && npm run test:theme
node tests/render.test.js && node --check static/app.js
.venv/bin/python -m unittest discover -s tests -v
docker compose config --quiet
```
