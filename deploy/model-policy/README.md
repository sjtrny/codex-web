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

## Install through Dokploy

These steps assume an existing Compose deployment with a `workspace` service
running the app-server as `node`, a `codex-web` service, and persistent home,
workspace and socket volumes. Rename the service references for your setup.

1. Follow [BUILD.md](BUILD.md) to build the engine. Copy the executable to the
   Docker host, outside the shared workspace. The example host path is
   `/opt/codex-policy/0.159.1-1/codex`. Keep it owned by the administrator and
   executable by the workspace user. Building and copying the file do not
   activate it.
2. In the application's **Environment** tab, add the six entries from
   [.env.example](.env.example) and save. The example allows Luna, Low/Medium
   reasoning and Standard speed, with Medium as the default.
3. In the Compose editor, merge [compose.fragment.yaml](compose.fragment.yaml)
   into the existing services. Add the three `CODEX_ALLOWED_*` entries under
   `workspace.environment`, the binary mount under `workspace.volumes`, and the
   three `CODEX_DEFAULT_*` entries under `codex-web.environment`. Use the actual
   host path from step 1 for the mount source. Preserve existing environment
   entries, volumes, networks and startup commands.
4. In `workspace.build.dockerfile_inline`, immediately after
   `RUN npm install -g @openai/codex@0.159.1` and before `USER node`, add:

   ```dockerfile
   RUN ln -sf /opt/codex-policy/codex /usr/local/bin/codex
   ```

   This selects the mounted engine for the `codex` command, including the
   app-server startup command. If you use a separate Dockerfile, add the line
   there instead. The original npm package remains available for rollback.
5. Save and deploy. Rebuild the workspace image and recreate the services so
   the new binary and environment are used. If your Dokploy app has a custom
   Compose run command, retain its project/file options and include
   `up -d --build --remove-orphans --force-recreate`. Dokploy adds the `docker`
   prefix. Existing persistent volumes retain login and conversation data.
6. Refresh the website and start a new chat. The example should show Luna,
   Low/Medium reasoning and Standard speed. Attach a workspace terminal to the
   same backend with:

   ```bash
   codex --remote unix:///run/codex/app.sock
   ```

Use the actual socket path if it differs. The same command can run in a VS Code
Remote-SSH terminal after SSH access is configured. The desktop Codex extension
is a separate client and is not configured by these steps.

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

## Roll back

Remove the added Dockerfile symlink line, binary mount and the three
`CODEX_ALLOWED_*` service environment entries. Rebuild and redeploy. The
existing pinned npm installation becomes the `codex` command again. Restore
previous web defaults if needed. Keep the persistent volumes.

## Source

[model-policy.patch](model-policy.patch) contains the implementation, unit
tests and app-server integration test against the pinned upstream commit.
[SHA256SUMS](SHA256SUMS) identifies that source patch. It adds no Cargo
dependency or app-server protocol field. Compiled binaries and deployment
credentials are not included in this directory.

The diff identifies the modified upstream files. The upstream Apache 2.0
[LICENSE](LICENSE) and attribution [NOTICE](NOTICE) are included. This is a
project-maintained modification, not an official OpenAI Codex release.
