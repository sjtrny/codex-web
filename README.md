# Codex Web

Use Codex from a terminal, this web UI, or both. Clients connected to the same
app-server share conversations.

![Codex CLI and Codex Web share an app-server and workspace through a Unix socket.](docs/architecture.png)

![Codex Web in a browser window receives the same conversation updates as Codex CLI in a terminal window.](docs/sync-demo.gif)

## Setup

### 1. App server

Run the app-server where Codex should access files and tools: the host OS, a VS 
Codedevelopment container, or another container. That environment is where Codex
does the work.

Install and sign in to [Codex CLI](https://developers.openai.com/codex/cli) in
the work environment. App-server is included with the CLI.

```bash
mkdir -p /absolute/shared/path
chmod 700 /absolute/shared/path
rm -f /absolute/shared/path/app.sock
codex app-server --listen unix:///absolute/shared/path/app.sock
```

Keep it running with a service manager. The socket directory must be visible to
each client. [`codex app-server` is experimental and unsupported for production
workloads.](https://developers.openai.com/codex/app-server)

### 2. Terminal (optional)

Connect from any shell:

```bash
codex --remote unix:///absolute/shared/path/app.sock
```

So that codex CLI connects to the socket, add this to `~/.bashrc`:

```bash
export CODEX_APP_SERVER_SOCKET=/absolute/shared/path/app.sock
source /absolute/path/to/codex-web/codex-remote.bash
```

`codex`, `resume`, `fork`, `archive`, `delete`, and `unarchive` use app-server.
Other subcommands and `codex-local` use the local executable.

### 3. Web (optional)

A minimal `compose.yaml` using the published image is:

```yaml
services:
  codex-web:
    image: ghcr.io/sjtrny/codex-web:latest
    user: "${CODEX_WEB_UID:-1000}:${CODEX_WEB_GID:-1000}"
    environment:
      CODEX_DEFAULT_CWD: /absolute/path/to/projects
      CODEX_WORKSPACE_ROOT: /absolute/path/to/projects
      CODEX_UPLOAD_HOST_DIR: /absolute/path/to/codex-web/uploads
    ports:
      - "8765:8000"
    volumes:
      - /absolute/shared/path:/run/codex:ro
      - /absolute/path/to/projects:/absolute/path/to/projects:ro
      - ./uploads:/uploads
```

Start it with the host user's UID and GID so the container can access the
app-server socket and upload directory:

```bash
CODEX_WEB_UID="$(id -u)" CODEX_WEB_GID="$(id -g)" docker compose up -d
```

See the provided [`compose.yaml`](compose.yaml) for all configuration options;
[`.env.example`](.env.example) lists the corresponding environment values.

Open `http://HOST_IP:8765`.

### Agent instructions

Codex Web bundles [`codex-web-instructions.md`](codex-web-instructions.md) in
the application image and adds it to `thread/start`, `thread/resume`, and
`thread/fork` requests as app-server developer instructions. These instructions
teach Codex how to retrieve a referenced previous conversation without
resuming it and how this UI renders links to local files and inline local
images.

The bundled file is stored under `/app` in the image. The normal workspace bind
mount targets `/workspaces`, so mounting a user's projects does not replace the
instructions. Project-level `AGENTS.md` files remain separate and are still
discovered by the app-server from each thread's working directory.

Without Docker:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
mkdir -p uploads && chmod 700 uploads
ROOT=/absolute/path/to/projects
CODEX_APP_SERVER_SOCKET=/absolute/shared/path/app.sock \
CODEX_DEFAULT_CWD="$ROOT" CODEX_WORKSPACE_ROOT="$ROOT" \
CODEX_UPLOAD_DIR="$PWD/uploads" CODEX_UPLOAD_HOST_DIR="$PWD/uploads" \
HOST=0.0.0.0 PORT=8765 .venv/bin/python app.py
```

### Reply while Codex works

During an active task, the composer button shows **Stop** when the text box is
empty. Type a message or attach a file to switch it to **Reply**. Send an answer,
correction, or additional instruction without stopping the task. Pressing Enter
in an empty text box does not stop the task.

Open **Model and chat settings** beside the paperclip (**Attach**) to change the model,
reasoning, and other chat options in a modal. Changes are saved for the chat and
apply to the next new turn. Replies use the current task's settings.

**Working folder** is the folder on the Codex server where commands start and
project files are found. It replaces the old `cwd` header input. The field shows
the current path, uses the chat's folder by default, and keeps your changes with
that chat. Clear it to return to the chat's default folder. Changing it does not
move files or affect a task already running.

Settings, Attach, and Send/Reply/Stop are stacked vertically to the right of the text box.

Unanswered questions are grouped in a persistent area just above the message
box, so they stay visible while Codex continues working or you scroll through
the conversation. Collapse the area to its question count when you need more
space; new questions expand it again. Long question lists scroll separately.
The original messages stay in chronological order in the conversation.

Answer using the same text box and **Reply** button; there are no separate
answer controls. Accepted replies clear the pending questions. Failed replies
keep both the questions and your draft. Questions are scoped to the current
chat, restored when reconnecting, and cleared when the task ends.
The status distinguishes **Waiting for your answer** from **Working — question
pending**. For a native structured request with several questions, the area
shows all remaining questions; answer question 1 in the text box, then continue
with the next question. Chat drafts survive chat switching and temporary
disconnections.

If a task ends before a reply is accepted, the reply remains a draft for you to
send again. Codex Web does not automatically start a new task. Mid-task replies
require an app-server that supports `turn/steer`.

For an isolated desktop/mobile browser check, install the demo's Playwright
dependencies and Chromium with `demo/setup.sh`, then run
`npm run test:browser:questions`. This check uses simulated app-server events
and does not start Codex tasks or change the running service.

Run `npm run test:browser:sidebar` with the same browser dependencies to check
sidebar activity with delayed history responses, background tasks, and reconnects.

### Fork a chat

Each saved final **Codex** response has a compact action toolbar below it. Select
**Fork** to open a separate chat that includes the response's completed turn and
omits later turns. The new chat is labelled **Fork:** in the chat list. There is
no fork action on user messages or Codex commentary and progress messages.

App-server stores fork boundaries by turn, not by individual response item. The
fork button on a final response remains visible but disabled until that turn
finishes. The original conversation, unsent draft, and attachments stay on the
original chat. Chat settings are copied and can then be changed separately.

A fork does not send a message, start a task, or stop work in the original chat.
Any copied goal waits for your next message. Both chats use the same working
folder and files; this does not create a Git branch or copy the workspace. This
requires an app-server that supports `thread/fork`, `lastTurnId`, and
`deferGoalContinuation`.

Run `npm run test:browser:fork` with the demo's Playwright dependencies for an
isolated desktop/mobile check.

### Embedded images

Select a workspace or host image embedded in a Codex message to open the
rendered image in a new browser tab or window. An image with an explicit
Markdown link keeps that link.
Run `npm run test:browser:images` for an isolated Chromium check of this behavior.

### Search chat history

Open **Search chats** to find matching messages. Conversations appear as the
search checks your history, with a running count. You can open a result before
the search finishes. Date filters and oldest/newest sorting still apply.

Submit another query, change a filter, or select **Clear** to cancel the previous
search. Opening a conversation also stops the remaining scan. If the search is
interrupted, results already found stay visible.

The browser requests newline-delimited JSON from `POST /api/search` using
`Accept: application/x-ndjson`. Each record contains a bounded, sorted result
snapshot and progress; the final record has `done: true`. Clients that request
ordinary JSON still receive one complete response.

Run `npm run test:browser:search` with the demo's Playwright dependencies for an
isolated desktop/mobile streaming check.

### Chat settings defaults

Unset chat settings use these instance defaults. Set them in `.env` for Docker
Compose, or export them when running directly.

| Environment variable | Built-in default |
| --- | --- |
| `CODEX_DEFAULT_MODEL` | `gpt-6-astra` |
| `CODEX_DEFAULT_REASONING_EFFORT` | `medium` |
| `CODEX_DEFAULT_SERVICE_TIER` | empty (standard service) |
| `CODEX_DEFAULT_PERSONALITY` | `none` |
| `CODEX_DEFAULT_REASONING_SUMMARY` | `auto` |
| `CODEX_DEFAULT_APPROVAL_POLICY` | `on-request` |
| `CODEX_DEFAULT_PERMISSION_PROFILE` | `:workspace` |

Example: Sol, max reasoning, Fast, never ask, and full access:

```dotenv
CODEX_DEFAULT_MODEL=gpt-5.6-sol
CODEX_DEFAULT_REASONING_EFFORT=max
CODEX_DEFAULT_SERVICE_TIER=priority
CODEX_DEFAULT_APPROVAL_POLICY=never
CODEX_DEFAULT_PERMISSION_PROFILE=:danger-full-access
```

Values are app-server protocol IDs. Restart the web service after changing them.
The model picker is populated by the app-server's `model/list` response, so keep
Codex CLI current to make newly available models selectable.

### Tool activity visibility

Set `CODEX_WEB_SHOW_TOOL_ACTIVITY=false` in `.env` for Docker Compose, or export
it when running directly, to hide the grey tool-activity boxes:

```dotenv
CODEX_WEB_SHOW_TOOL_ACTIVITY=false
```

The default is `true` (visible). Boolean values are case-insensitive: `true`,
`1`, `yes`, and `on` show activity; `false`, `0`, `no`, and `off` hide it.
An unset or empty value uses the default. Other values are rejected.

This instance-wide display default applies to live updates and loaded history.
It hides commands and their output, file changes, tool calls, searches, and
other execution details. It does not stop tool use or remove saved history.
Chat messages (including progress updates), plans, reasoning summaries,
questions, approvals, and the thinking indicator are unaffected. Reasoning
summaries have their own `CODEX_DEFAULT_REASONING_SUMMARY` setting.

In each conversation's **Model and chat settings** modal, **Tool activity** offers
**Instance default**, **Show**, and **Hide**. The default option shows the
effective instance value and follows `CODEX_WEB_SHOW_TOOL_ACTIVITY`; an explicit
choice overrides it for that conversation. The choice is saved in this browser,
like the other per-chat settings, and survives reloads and conversation switches.
Existing conversations without an override use the instance default. You can
also set the choice on **New thread** before sending its first message; that
new-thread preference is retained, like the other new-thread settings.

Visibility changes immediately, including during an active turn. Showing tools
again restores existing tool details; it does not rerun them or send a model
setting to the app-server. Other conversations' choices remain unchanged.

Recreate the web service after changing its Compose environment, then reload
open browser tabs to fetch the new default. Explicit per-chat choices remain.

Run `npm run test:browser:tools` with the demo's Playwright installation and a
Python environment containing `requirements.txt`. Set `PLAYWRIGHT_MODULE` or
`PYTHON` to use installations outside this checkout. The check starts temporary
loopback web servers and uses simulated app-server traffic; it changes no saved
conversation or running service.

## Attachment retention

Uploaded files remain in `CODEX_UPLOAD_STORAGE_DIR` (Docker Compose) or
`CODEX_UPLOAD_DIR` (direct runs), and each attachment in chat history links back
to that retained copy. Retained images also render as inline previews that link
to the original download. Keep this directory when upgrading or recreating the
web service if historical downloads and previews should remain available.

## Security

The UI is unauthenticated and listens on all interfaces. Keep it behind a VPN
or firewall.

## Development

Use Python 3.12 and Node 22 (22.13 or later). CI uses these release lines.
Other supported Node versions are listed in `package.json`.

```bash
npm ci
npm test
npm run build
.venv/bin/python -m unittest discover --start-directory tests --pattern "test_*.py"
```

Install Python dependencies in a virtual environment as shown above. The DOM
tests use jsdom and the real page markup; the browser checks described above cover
layout, focus, and interaction in Chromium.
