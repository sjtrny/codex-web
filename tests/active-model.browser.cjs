"use strict";

// Conversation traffic is simulated, including when checking deployed assets.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");
const root = path.resolve(__dirname, "../static");
const artifacts = process.env.ARTIFACT_DIR;
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, pathname === "/" ? "index.html" : pathname.replace(/^\/static\//, ""));
    if (!file.startsWith(root + path.sep)) throw new Error("Invalid path");
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
const names = { "gpt-5.6-sol": "GPT-5.6-Sol", "gpt-6-sol": "GPT-6-Sol", "gpt-6-astra": "GPT-6-Astra" };
const models = Object.entries(names).map(([model, displayName]) => ({
  id: model, model, displayName, description: `${displayName} model`,
  defaultReasoningEffort: "max", supportedReasoningEfforts: [{ reasoningEffort: "max" }, { reasoningEffort: "ultra" }],
  serviceTiers: [{ id: "priority", name: "Fast" }], supportsPersonality: false,
}));
const first = { id: "synthetic-active-model", name: "Active and selected models", model: "gpt-5.6-sol", reasoningEffort: "max",
  cwd: "/workspaces", status: { type: "active", activeFlags: [] },
  turns: [{ id: "legacy-turn", status: "completed", items: [] },
    { id: "first-turn", status: "inProgress", items: [] }] };
const second = { id: "synthetic-other-model", name: "Other conversation", model: "gpt-6-sol", reasoningEffort: "max",
  cwd: "/workspaces", status: { type: "active", activeFlags: [] },
  turns: [{ id: "other-turn", status: "inProgress", items: [] }] };
const threads = new Map([[first.id, first], [second.id, second]]);

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = process.env.CODEX_WEB_BASE_URL || `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const errors = [], calls = [], widths = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    await context.addInitScript(({ id }) => {
      if (localStorage.getItem("codex-web-chat-settings-v1")) return;
      localStorage.setItem("codex-web-chat-settings-v1", JSON.stringify({ threads: { [id]: { model: "gpt-6-astra", effort: "ultra" } } }));
    }, { id: first.id });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/config", (route) => route.fulfill({ json: {
        defaultCwd: "/workspaces", workspaceRoot: "/workspaces", historyChunkBytes: 1_000_000,
        showToolActivity: false, chatDefaults: { model: "gpt-5.6-sol", effort: "max", serviceTier: "priority" },
    } }));
    await page.route("**/api/history", (route) => {
      const { threadId } = route.request().postDataJSON();
      assert.ok(threads.has(threadId), "only synthetic threads may be read");
      const turns = threads.get(threadId).turns;
      return route.fulfill({ contentType: "application/x-ndjson", headers: {
        "X-Codex-History-Cursor": "", "X-Codex-History-Reset": "0",
      }, body: [...turns].reverse().flatMap((turn) => [
        { turn: { id: turn.id, status: turn.status } },
        { turnId: turn.id, item: { id: `${turn.id}-message`, type: "agentMessage",
          phase: turn.status === "completed" ? "final_answer" : "commentary",
          completedAtMs: Date.parse("2026-10-20T03:00:00Z"),
          text: turn.status === "completed" ? `Completed ${turn.id}.`
            : "I’m working on your request. You can select a different model for the next turn." } },
      ]).map(JSON.stringify).join("\n") + "\n" });
    });
    let socket;
    await page.routeWebSocket("**/ws", (ws) => {
      socket = ws;
      ws.onMessage((raw) => {
        const request = JSON.parse(raw);
        calls.push(request);
        if (request.id == null) return;
        if (request.params?.threadId) assert.ok(threads.has(request.params.threadId));
        let result = {};
        switch (request.method) {
          case "account/rateLimits/read": result = {}; break;
          case "initialize": case "config/read": case "configRequirements/read": break;
          case "model/list": result = { data: models }; break;
          case "permissionProfile/list": result = { data: [] }; break;
          case "thread/list": result = { data: [...threads.values()].map((thread) => ({ ...thread, turns: [] })) }; break;
          case "thread/read":
            assert.equal(request.params.includeTurns, false);
            result = { thread: { ...threads.get(request.params.threadId), turns: [] } };
            break;
          case "thread/resume":
            assert.equal(request.params.excludeTurns, true);
            result = { thread: { ...threads.get(request.params.threadId), turns: [] } };
            break;
          case "turn/steer": break;
          case "turn/start":
            first.model = request.params.model;
            first.reasoningEffort = request.params.effort;
            first.status = { type: "active", activeFlags: [] };
            first.turns.push({ id: "next-turn", status: "inProgress", items: [] });
            result = { turn: first.turns.at(-1) };
            break;
          default: throw new Error(`Unexpected request: ${request.method}`);
        }
        ws.send(JSON.stringify({ id: request.id, result }));
      });
    });
    const expectLabel = (id, text) => page.waitForFunction(
      ({ id, text }) => document.getElementById(id)?.textContent === text, { id, text },
    );
    const expectCompletionModel = (turn, model) => page.waitForFunction(({ turn, model }) => {
      const message = [...document.querySelectorAll(".message.agent")]
        .find((node) => node.querySelector(".body")?.textContent.trim() === `Completed ${turn}.`);
      return message?.querySelector(".message-model")?.textContent === model
        && message.querySelector("time")?.dateTime === "2026-10-20T03:00:00.000Z";
    }, { turn, model });
    const emit = (method, params) => socket.send(JSON.stringify({ method, params }));
    const finish = () => {
      const turn = first.turns.at(-1);
      const item = { id: `${turn.id}-message`, type: "agentMessage", phase: "final_answer",
        completedAtMs: Date.parse("2026-10-20T03:00:00Z"), text: `Completed ${turn.id}.` };
      turn.items = [item];
      turn.status = "completed";
      first.status = { type: "idle" };
      emit("item/completed", { threadId: first.id, turnId: turn.id, item });
      emit("turn/completed", { threadId: first.id, turn });
    };
    await page.goto(`${base}/?thread=${first.id}`, { waitUntil: "networkidle" });
    await expectLabel("active-model", names["gpt-5.6-sol"]);
    await expectLabel("selected-model", names["gpt-6-astra"]);
    await expectLabel("active-reasoning", "max");
    await expectLabel("selected-reasoning", "ultra");
    assert.equal(await page.locator("#thinking-indicator #active-model").count(), 1);
    assert.equal(await page.locator("#composer #active-model").count(), 0);
    await page.locator("#settings-toggle").click();
    await expectLabel("settings-active-model", `${names["gpt-5.6-sol"]} · max reasoning`);
    assert.equal(await page.locator("#setting-model").inputValue(), "gpt-6-astra");
    await page.locator("#setting-model").selectOption("gpt-6-sol");
    await expectLabel("active-model", names["gpt-5.6-sol"]);
    await expectLabel("selected-model", names["gpt-6-sol"]);
    await page.locator("#setting-effort").selectOption("max");
    await expectLabel("selected-reasoning", "max");
    await expectLabel("active-reasoning", "max");
    await page.locator("#setting-effort").selectOption("ultra");
    await expectLabel("selected-reasoning", "ultra");
    await expectLabel("active-reasoning", "max");
    await page.locator("#settings-close").click();
    await page.locator("#prompt").fill("Keep working");
    await page.locator("#prompt").press("Enter");
    await page.waitForFunction(() => document.getElementById("prompt").value === "");
    assert.equal(calls.filter((call) => call.method === "turn/steer").length, 1);
    assert.equal(calls.find((call) => call.method === "turn/steer").params.model, undefined);
    assert.equal(calls.find((call) => call.method === "turn/steer").params.effort, undefined);
    assert.equal(calls.filter((call) => call.method === "turn/start").length, 0);
    await expectLabel("active-model", names["gpt-5.6-sol"]);
    finish();
    await expectLabel("active-model", "No active turn");
    await expectCompletionModel("first-turn", names["gpt-5.6-sol"]);
    assert.equal(await page.locator("#thinking-indicator").isVisible(), false);
    await page.locator("#prompt").fill("Start the next task");
    await page.locator("#prompt").press("Enter");
    await expectLabel("active-model", names["gpt-6-sol"]);
    await expectLabel("active-reasoning", "ultra");
    assert.equal(calls.find((call) => call.method === "turn/start").params.model, "gpt-6-sol");
    assert.equal(calls.find((call) => call.method === "turn/start").params.effort, "ultra");
    finish();
    await expectCompletionModel("next-turn", names["gpt-6-sol"]);
    first.model = "gpt-5.6-sol";
    first.reasoningEffort = "max";
    first.status = { type: "active", activeFlags: [] };
    first.turns.push({ id: "external-turn", status: "inProgress", items: [] });
    emit("turn/started", { threadId: first.id, turn: first.turns.at(-1) });
    await expectLabel("active-model", names["gpt-5.6-sol"]);
    await expectLabel("selected-model", names["gpt-6-sol"]);
    await page.locator(`#threads a[href="/?thread=${second.id}"]`).click();
    await expectLabel("active-model", names["gpt-6-sol"]);
    await expectLabel("selected-model", names["gpt-5.6-sol"]);
    await page.locator(`#threads a[href="/?thread=${first.id}"]`).click();
    await expectLabel("active-model", names["gpt-5.6-sol"]);
    await page.locator("#settings-toggle").click();
    await page.locator("#setting-model").selectOption("gpt-6-astra");
    await page.locator("#settings-close").click();
    await page.reload({ waitUntil: "networkidle" });
    await expectLabel("active-model", names["gpt-5.6-sol"]);
    await expectLabel("selected-model", names["gpt-6-astra"]);
    await expectLabel("active-reasoning", "max");
    await expectLabel("selected-reasoning", "ultra");
    await expectCompletionModel("first-turn", names["gpt-5.6-sol"]);
    await expectCompletionModel("next-turn", names["gpt-6-sol"]);
    await expectCompletionModel("legacy-turn", "Model unavailable");
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 740 });
      await page.emulateMedia({ colorScheme: width === 320 ? "dark" : "light" });
      assert.ok(await page.locator("#active-model").isVisible());
      assert.ok(await page.locator("#selected-model").isVisible());
      const lines = await page.evaluate(() => {
        const centers = (ids) => ids.map((id) => {
          const r = document.getElementById(id).getBoundingClientRect();
          return r.top + r.height / 2;
        });
        const singleLine = (ids) => {
          const values = centers(ids);
          return Math.max(...values) - Math.min(...values) < 1;
        };
        return {
          active: singleLine(["thinking-label", "active-model", "active-reasoning"]),
          selected: singleLine(["selected-model", "selected-reasoning"]),
          activeUnclipped: ["thinking-label", "active-model", "active-reasoning"].every((id) => {
            const el = document.getElementById(id);
            return el.scrollWidth <= el.clientWidth;
          }),
          selectedHeight: document.getElementById("selected-model-status").getBoundingClientRect().height,
        };
      });
      assert.ok(lines.active && lines.activeUnclipped, `Active status must fit one line at ${width}px`);
      assert.ok(lines.selected && lines.selectedHeight < 24, `Selected status must fit one line at ${width}px`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await page.locator(".message-model").evaluateAll((nodes) => nodes.every((node) => {
        const bounds = node.getBoundingClientRect();
        const parent = node.closest(".message").getBoundingClientRect();
        return bounds.left >= parent.left && bounds.right <= parent.right && bounds.right <= innerWidth;
      })), `Completion models must fit at ${width}px`);
      if (artifacts) {
        await fs.mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: path.join(artifacts, `active-model-${width}.png`) });
      }
      await page.locator("#settings-toggle").click();
      await expectLabel("settings-active-model", `${names["gpt-5.6-sol"]} · max reasoning`);
      assert.ok(await page.locator("#settings-dialog").evaluate((el) => el.scrollWidth <= el.clientWidth));
      if (artifacts) await page.screenshot({ path: path.join(artifacts, `model-settings-${width}.png`) });
      await page.locator("#settings-close").click();
      widths.push(width);
    }
    assert.deepEqual(errors, []);
    const report = { activeAndSelectedDiffer: true, replyKeepsActiveModel: true, nextTurnUsesSelection: true,
      externalTurnRefresh: true, chatSwitching: true, reload: true, widths, pageErrors: errors,
      realConversationRequests: 0, reasoningLevels: true, singleLineStatus: true,
      completionModels: true, completionModelPersistence: true, unknownHistoricalModels: true,
      metadataReads: calls.filter((call) => call.method === "thread/read").length };
    if (artifacts) await fs.writeFile(path.join(artifacts, "browser.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
