# Shared model policy

This optional native Codex patch lets an administrator restrict models,
reasoning levels and service tiers for a shared instance. Web clients and
terminals attached to the same app-server use the same policy. The checks also
cover requests from subagents. ChatGPT sign-in remains available.

This is a custom patch to OpenAI Codex `rust-v0.159.1`, commit
`8e68a98ef03cdde76d2e6800791ebdf1b3b95b24`. It is not a setting in the stock Codex
release. The existing Codex Web frontend can use the patched backend without
an application change. Updating the web image alone does not install the patch.

## How it works

The backend checks the actual model, reasoning effort and service tier before
it sends a Responses request over HTTP or WebSocket. Missing effort and tier
values are made explicit. Requests outside the allowed settings fail with an
`Instance model policy: ...` error. Explicit forbidden choices are not silently
changed. The check covers settings inherited from saved conversations too.

The patch also filters the app-server's `model/list` response, which supplies
the web and attached-terminal model pickers. Catalog filtering helps users
choose permitted settings; the outbound request check enforces the policy.

## Environment settings

Set all three variables on the process that runs the patched app-server:

| Variable | Example | Meaning |
| --- | --- | --- |
| `CODEX_ALLOWED_MODELS` | `gpt-6-luna` | Exact model IDs, separated by commas |
| `CODEX_ALLOWED_REASONING_EFFORTS` | `low,medium` | Allowed named reasoning levels |
| `CODEX_ALLOWED_SERVICE_TIERS` | `default` | Standard service only |

All three are required when any one is present. Empty entries, partial settings
and malformed lists stop app-server startup. Wildcards, numeric reasoning
budgets and the `auto` service tier are not accepted. With all three variables
absent, the patch leaves the upstream behavior unchanged.

The first allowed model becomes the backend default. The backend prefers
Medium reasoning and Standard service when permitted; otherwise it uses the
first configured effort or tier. Model IDs must be available to the signed-in
account. The patch does not grant access to additional models.

The policy is read once per process and is separate from user and project
configuration. Change the environment and restart the backend to apply new
limits. Set the web service's `CODEX_DEFAULT_MODEL`,
`CODEX_DEFAULT_REASONING_EFFORT` and `CODEX_DEFAULT_SERVICE_TIER` to allowed
values as well. Those three variables set the web defaults; they do not enforce
limits by themselves.

## Run the backend

Follow [BUILD.md](BUILD.md) to build the patched executable. Run it in the
environment where Codex should access files and tools, with the normal Codex
home and authentication for that environment. Choose the executable location,
runtime user, process manager and socket path to suit your deployment.

For example, start an app-server with Luna, Low/Medium reasoning and Standard
service available:

```bash
mkdir -p /absolute/shared/path
chmod 700 /absolute/shared/path

CODEX_ALLOWED_MODELS=gpt-6-luna \
CODEX_ALLOWED_REASONING_EFFORTS=low,medium \
CODEX_ALLOWED_SERVICE_TIERS=default \
  /absolute/path/to/patched/codex app-server \
  --listen unix:///absolute/shared/path/app.sock
```

The values are examples; select models and settings appropriate to your
instance. [.env.example](.env.example) lists both backend policy and web-default
variables. Apply each group to the corresponding process using your usual
configuration mechanism. The example file is not loaded automatically.

## Connect clients

Point Codex Web at the app-server socket through `CODEX_APP_SERVER_SOCKET` and
set its `CODEX_DEFAULT_*` variables to permitted values. Use a socket path
visible to the web process. See the main [setup guide](../../README.md#setup)
for the web configuration options.

Attach a terminal to the same backend:

```bash
codex --remote unix:///absolute/shared/path/app.sock
```

This command can also run in an editor's integrated terminal if it can access
the socket. An editor extension that starts its own backend must be configured
separately.

After starting the backend, refresh the web UI and start a new chat. The model
picker should reflect the allowed settings supported by the account.

Local commands that use the patched binary and policy environment also get
the outbound request checks. Use `--remote` to share live conversations with
the web UI. A stock CLI connected to the patched app-server is governed by
that server's policy; an independent stock CLI process is not.

## Limits and compatibility

- This controls requests from the configured engine. A user with unrestricted
  shell access and readable account credentials can run another binary or
  clear its environment. This is not an account-wide spending boundary, token
  limit or monetary budget.
- A saved conversation with a forbidden reasoning update fails and asks the
  user to start a new chat. The patch does not rewrite conversation history.
- Native image generation/editing, realtime voice and background memory
  summarization are disabled while the policy is enabled. Those endpoints
  cannot express the complete model, effort and tier policy. External tools
  with their own credentials are outside this policy.
- Subagent requests are checked before inference. Internal subagent tool
  descriptions can still list a model that the policy later rejects.
- The patch is pinned to Codex 0.159.1. Review and rebuild it when upgrading
  Codex. The build instructions describe Linux x86-64; other targets need
  their own build and runtime checks.

## Disable or remove the policy

To disable the policy, remove all three `CODEX_ALLOWED_*` variables from the
backend process environment and restart it. To remove the custom engine,
switch the app-server executable back to the stock Codex release. Retain the
same Codex home and workspace paths to keep login and conversation data.
Adjust the web defaults if needed.

## Source

[model-policy.patch](model-policy.patch) contains the implementation, unit
tests and app-server integration test against the pinned upstream commit.
[SHA256SUMS](SHA256SUMS) identifies that source patch. It adds no Cargo
dependency or app-server protocol field. Compiled binaries and deployment
credentials are not included in this directory.

The diff identifies the modified upstream files. The upstream Apache 2.0
[LICENSE](LICENSE) and attribution [NOTICE](NOTICE) are included. This is a
project-maintained modification, not an official OpenAI Codex release.
