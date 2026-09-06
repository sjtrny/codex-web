# Demo recorder

Creates `docs/sync-demo.gif` with fresh conversation state.
The recording shows the composer controls, sends a CLI prompt, and shows the
same response in both clients. The settings dialog stays closed.

```bash
./setup.sh
./record.sh
./record.sh --prompt "Your demo prompt"
```

Use `--output PATH`, `DEMO_PROMPT`, or `DEMO_OUTPUT` to override defaults.
Codex CLI must already be signed in. Temporary state is removed after recording.
