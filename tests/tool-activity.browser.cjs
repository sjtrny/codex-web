"use strict";

// Real Python configuration + Chromium; all app-server traffic is simulated.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");

const root = path.resolve(__dirname, "..");
const artifacts = path.resolve(process.env.ARTIFACT_DIR || path.join(root, "../artifacts/tool-activity"));
const python = process.env.PYTHON || "python3";
const launcher = `
import asyncio
from aiohttp import web
import app
async def main():
    runner = web.AppRunner(app.create_app())
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    print(site._server.sockets[0].getsockname()[1], flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()
asyncio.run(main())
`;

async function eventually(check) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Expected browser state did not arrive");
}

async function checkMode(browser, value) {
  const shown = value !== "false";
  const name = value === undefined ? "default" : shown ? "shown" : "hidden";
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codex-web-tools-"));
  const environment = {
    ...process.env, CODEX_WORKSPACE_ROOT: root,
    CODEX_APP_SERVER_SOCKET: path.join(temporary, "unused.sock"),
    CODEX_UPLOAD_DIR: path.join(temporary, "uploads"),
  };
  delete environment.CODEX_APP_SERVER_URL;
  delete environment.CODEX_WEB_SHOW_TOOL_ACTIVITY;
  if (value !== undefined) environment.CODEX_WEB_SHOW_TOOL_ACTIVITY = value;
  const server = spawn(python, ["-u", "-c", launcher], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let serverErrors = "";
  server.stderr.on("data", (data) => { serverErrors += data; });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: "block" });
  try {
    const lines = createInterface({ input: server.stdout });
    const timeout = AbortSignal.timeout(10000);
    const [port] = await Promise.race([
      once(lines, "line", { signal: timeout }),
      once(server, "exit", { signal: timeout }).then(() => { throw new Error(serverErrors || "Python server exited early"); }),
    ]);
    lines.close();
    const baseUrl = `http://127.0.0.1:${Number(port)}`;
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const config = await (await context.request.get(`${baseUrl}/api/config`)).json();
    assert.equal(config.showToolActivity, shown);
    assert.equal(Object.hasOwn(config.chatDefaults, "showToolActivity"), false);

    const tools = [
      { id: "command", type: "commandExecution", command: "example command", aggregatedOutput: "command output", status: "completed" },
      { id: "files", type: "fileChange", status: "completed", changes: [] },
      { id: "mcp", type: "mcpToolCall", server: "example", tool: "lookup", status: "completed", result: { answer: 42 } },
      { id: "dynamic", type: "dynamicToolCall", tool: "example_tool", status: "completed", contentItems: [] },
      { id: "search", type: "webSearch", query: "example search" },
      { id: "image", type: "imageView", path: "/workspaces/example.png" },
      { id: "collab", type: "collabToolCall", tool: "example_agent", status: "completed" },
    ];
    const initialItems = [
      { id: "user", type: "userMessage", content: [{ type: "text", text: "Check this example." }] },
      { id: "progress", type: "agentMessage", phase: "commentary", text: "I’ll check the example and report the result." },
      ...tools,
      { id: "plan", type: "plan", text: "Inspect the example, then report the result." },
      { id: "reasoning", type: "reasoning", summary: ["A separately controlled reasoning summary."] },
      { id: "answer", type: "agentMessage", phase: "final_answer", text: "The example is ready." },
    ];
    const thread = {
      id: "visibility", name: "Tool activity visibility", cwd: root,
      createdAt: 1789682400, updatedAt: 1789682400, status: { type: "idle" },
      turns: [{ id: "history", status: "completed", items: initialItems }],
    };
    const otherThread = { ...structuredClone(thread), id: "other-visibility", name: "Other conversation" };
    const threads = new Map([[thread.id, thread], [otherThread.id, otherThread]]);
    const received = [];
    let socket;
    await page.routeWebSocket("**/ws", (ws) => {
      socket = ws;
      ws.onMessage((data) => {
        const message = JSON.parse(data);
        received.push(message);
        if (!message.method || message.id == null) return;
        let result;
        switch (message.method) {
          case "initialize": result = { userAgent: "tool-activity-browser-check" }; break;
          case "model/list": result = { data: [] }; break;
          case "permissionProfile/list": result = { data: [] }; break;
          case "config/read": result = { config: {} }; break;
          case "configRequirements/read": result = { requirements: null }; break;
          case "thread/list": result = { data: [...threads.values()], nextCursor: null }; break;
          case "thread/resume": result = { thread: threads.get(message.params.threadId) }; break;
          case "thread/start": {
            const created = { ...structuredClone(otherThread), id: "new-visibility", name: "New conversation", turns: [] };
            threads.set(created.id, created);
            result = { thread: created };
            break;
          }
          case "turn/start": {
            const createdTurn = { id: "new-turn", status: "inProgress", items: [] };
            threads.get(message.params.threadId).turns.push(createdTurn);
            result = { turn: createdTurn };
            break;
          }
          default: errors.push(`Unexpected RPC: ${message.method}`); result = {};
        }
        ws.send(JSON.stringify({ id: message.id, result }));
      });
    });
    const notify = (method, params) => socket.send(JSON.stringify({ method, params }));
    const activities = page.locator("#messages details.activity:visible");
    const allTools = page.locator("#messages details.tool-activity");
    const toolControl = page.getByLabel("Tool activity", { exact: true });
    const activityCount = (toolCount) => shown ? toolCount + 2 : 2;
    await page.goto(`${baseUrl}/?thread=visibility`);
    await eventually(async () => await page.locator("#messages .message").count() === 3);
    assert.equal(await activities.count(), activityCount(tools.length));
    assert.match(await page.locator("#messages").textContent(), /I’ll check the example/);
    assert.match(await page.locator("#messages").textContent(), /The example is ready/);
    if (!shown) assert.deepEqual(await activities.locator("summary").allTextContents(), ["plan", "reasoning summary"]);

    const turn = { id: "live", status: "inProgress", items: [
      { id: "live-user", type: "userMessage", content: [{ type: "text", text: "Run the next check." }] },
    ] };
    thread.turns.push(turn);
    thread.status = { type: "active", activeFlags: [] };
    notify("turn/started", { threadId: thread.id, turn });
    notify("item/commandExecution/outputDelta", {
      threadId: thread.id, turnId: turn.id, itemId: "live-command", delta: "early streamed output",
    });
    for (const tool of tools) {
      const item = { ...tool, id: `live-${tool.id}` };
      turn.items.push(item);
      notify("item/started", { threadId: thread.id, turnId: turn.id, item: { ...item, status: "inProgress" } });
      notify("item/completed", { threadId: thread.id, turnId: turn.id, item });
    }
    notify("item/commandExecution/outputDelta", {
      threadId: thread.id, turnId: turn.id, itemId: "late-command", delta: "later streamed output",
    });
    const progress = { id: "live-progress", type: "agentMessage", phase: "commentary", text: "The next check is running." };
    turn.items.push(progress);
    notify("item/completed", { threadId: thread.id, turnId: turn.id, item: progress });
    await eventually(async () => (await page.locator("#messages").textContent()).includes(progress.text));
    assert.equal(await activities.count(), activityCount(tools.length * 2 + 1));
    assert.equal(await page.locator("#thinking-indicator").isVisible(), true);
    if (!shown) assert.equal(await page.locator("#messages details.tool-activity:visible").count(), 0);

    socket.send(JSON.stringify({ id: "approval", method: "item/commandExecution/requestApproval", params: {
      threadId: thread.id, turnId: turn.id, itemId: "live-command", command: "example approval command",
    } }));
    const approval = page.locator("#requests .request");
    await approval.waitFor({ state: "visible" });
    await approval.getByRole("button", { name: "Decline", exact: true }).click();
    await eventually(() => received.some((message) => message.id === "approval" && message.result?.decision === "decline"));

    socket.send(JSON.stringify({ id: "question", method: "item/tool/requestUserInput", params: {
      threadId: thread.id, turnId: turn.id, itemId: "live-dynamic", isBlocking: true,
      questions: [{ id: "choice", header: "Example", question: "Which example should I use?", options: null }],
    } }));
    await page.locator("#pending-questions").waitFor({ state: "visible" });
    assert.match(await page.locator("#pending-questions").textContent(), /Which example should I use/);
    await page.locator("#prompt").fill("Use the first example.");
    await page.locator("#send").click();
    await eventually(() => received.some((message) => message.id === "question" && message.result?.answers?.choice));

    await fs.mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, `${name}-desktop.png`), fullPage: true, animations: "disabled" });

    // Display choices apply immediately, retain existing DOM/disclosures/drafts,
    // and do not resume or change the running task.
    await page.locator("#prompt").fill("Keep this unsent draft.");
    await page.locator("#settings-toggle").click();
    assert.equal(await toolControl.inputValue(), "");
    assert.equal(await toolControl.locator("option:checked").textContent(), `Instance default — ${shown ? "Show" : "Hide"}`);
    assert.deepEqual(await toolControl.locator("option").allTextContents(), [`Instance default — ${shown ? "Show" : "Hide"}`, "Show", "Hide"]);
    await page.locator("#settings-dialog").screenshot({ path: path.join(artifacts, `${name}-options-desktop.png`) });
    const resumesBefore = received.filter((message) => message.method === "thread/resume").length;
    await toolControl.selectOption("show");
    assert.equal(await activities.count(), tools.length * 2 + 3);
    await page.locator("#settings-close").click();
    const firstTool = allTools.first();
    await firstTool.locator("summary").click();
    const preservedTool = await firstTool.elementHandle();
    await page.locator("#settings-toggle").click();
    await toolControl.selectOption("hide");
    assert.equal(await activities.count(), 2);
    assert.equal(await preservedTool.evaluate((node) => node.isConnected && node.open && node.hidden), true);
    notify("item/commandExecution/outputDelta", {
      threadId: thread.id, turnId: turn.id, itemId: "live-command", delta: " output received while hidden",
    });
    await eventually(async () => (await allTools.allTextContents()).some((text) => text.includes("output received while hidden")));
    assert.equal(await activities.count(), 2);
    await toolControl.selectOption("show");
    assert.equal(await activities.count(), tools.length * 2 + 3);
    assert.equal(await preservedTool.evaluate((node) => node.isConnected && node.open && !node.hidden), true);
    await toolControl.selectOption("hide");
    await page.locator("#settings-close").click();
    assert.equal(await page.locator("#prompt").inputValue(), "Keep this unsent draft.");
    assert.equal(received.filter((message) => message.method === "thread/resume").length, resumesBefore);
    assert.equal(received.some((message) => ["turn/start", "turn/steer", "turn/interrupt", "thread/start"].includes(message.method)), false);
    await page.locator("#prompt").fill("");

    await page.reload();
    await eventually(async () => (await page.locator("#messages").textContent()).includes(progress.text));
    assert.equal(await activities.count(), 2, "Hide override survives reloading");
    await page.locator("#settings-toggle").click();
    assert.equal(await toolControl.inputValue(), "hide");
    await page.locator("#settings-close").click();

    await page.locator('#threads a[href*="thread=other-visibility"]').click();
    await eventually(async () => await page.locator("#thread-title").textContent() === otherThread.name);
    assert.equal(await activities.count(), activityCount(tools.length), "another conversation still uses the environment default");
    await page.locator("#settings-toggle").click();
    assert.equal(await toolControl.inputValue(), "");
    await toolControl.selectOption("show");
    await page.locator("#settings-close").click();
    await page.locator('#threads a[href*="thread=visibility"]').click();
    await eventually(async () => await page.locator("#thread-title").textContent() === thread.name);
    assert.equal(await activities.count(), 2);
    await page.locator("#settings-toggle").click();
    assert.equal(await toolControl.inputValue(), "hide");
    await toolControl.selectOption("");
    await page.locator("#settings-close").click();
    assert.equal(await activities.count(), activityCount(tools.length * 2), "resetting the override restores the instance default");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("codex-web-chat-settings-v1")));
    assert.equal(stored.threads.visibility.toolActivity, "");
    assert.equal(stored.threads["other-visibility"].toolActivity, "show");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector("#sidebar").getAttribute("aria-hidden") === "true");
    await page.reload();
    await eventually(async () => (await page.locator("#messages").textContent()).includes(progress.text));
    assert.equal(await activities.count(), activityCount(tools.length * 2));
    await page.screenshot({ path: path.join(artifacts, `${name}-mobile.png`), fullPage: true, animations: "disabled" });
    await page.locator("#settings-toggle").click();
    await toolControl.selectOption("hide");
    assert.equal(await activities.count(), 2);
    await page.locator("#settings-dialog").screenshot({ path: path.join(artifacts, `${name}-options-mobile.png`) });
    await page.locator("#settings-close").click();

    // The new-conversation preference is copied locally, never sent to Codex.
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.locator("#new-thread").click();
    await page.locator("#settings-toggle").click();
    assert.equal(await toolControl.inputValue(), "");
    await toolControl.selectOption("hide");
    await page.locator("#settings-close").click();
    await page.locator("#prompt").fill("Create the simulated conversation.");
    await page.locator("#send").click();
    await eventually(() => received.some((message) => message.method === "turn/start"));
    for (const message of received.filter((entry) => ["thread/start", "turn/start"].includes(entry.method))) {
      assert.equal(Object.hasOwn(message.params, "toolActivity"), false);
      assert.equal(Object.hasOwn(message.params, "showToolActivity"), false);
    }
    await page.locator("#settings-toggle").click();
    assert.equal(await toolControl.inputValue(), "hide");
    assert.deepEqual(errors, []);
    return { mode: name, configFlag: config.showToolActivity, historyToolCount: tools.length,
      liveToolCount: tools.length + 1, approvalsWork: true, questionsWork: true, reloadChecked: true,
      immediateOverrides: true, threadIsolation: true, draftsAndDisclosurePreserved: true,
      displaySettingExcludedFromRpc: true, newConversationOverride: true, browserErrors: errors };
  } finally {
    await context.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const reports = [];
    for (const value of [undefined, "false", "true"]) reports.push(await checkMode(browser, value));
    await fs.writeFile(path.join(artifacts, "browser-report.json"), JSON.stringify(reports, null, 2) + "\n");
    console.log(JSON.stringify(reports));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
