# Codex Web

Minimal, mobile-friendly browser UI for a Codex app-server.

```text
browser :8765 → Python proxy → runtime/app.sock → Codex app-server
```

## Run

Requires the devcontainer's private Codex socket to be bridged to
`runtime/app.sock` (UID/GID `1000`, mode `0600`).

```bash
docker compose up --build -d
```

Open <http://localhost:8765> or `http://HOST_IP:8765`. Enter sends;
Shift+Enter inserts a newline.

Common overrides:

```bash
CODEX_DEFAULT_CWD=/workspaces/project CODEX_WEB_PORT=9000 \
  docker compose up --build -d
```

Upload limits: `CODEX_UPLOAD_MAX_FILES`, `CODEX_UPLOAD_MAX_BYTES`, and
`CODEX_UPLOAD_TOTAL_BYTES`.

Features: concurrent threads, streaming, approvals, uploads, workspace-file
links, Markdown/KaTeX, themes, per-chat tuning, and an eight-thread tab cache.

## Security

There is no login or Origin check, and Compose binds `0.0.0.0`. Any client can
operate Codex and read files under the read-only `/workspaces` mount. Use only
on a trusted network; never expose it to the internet.

Uploads persist in `uploads/`. Images are native Codex inputs; other files are
passed as local paths. Codex app-server is experimental.

## Operate

```bash
docker compose ps
docker compose logs -f codex-web
docker compose restart codex-web
docker compose down
```

## Test

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm ci && npm run build
npm run test:markdown && npm run test:links
npm run test:copy && npm run test:theme
node tests/render.test.js && node --check static/app.js
.venv/bin/python -m unittest discover -s tests -v
docker compose config --quiet
```
