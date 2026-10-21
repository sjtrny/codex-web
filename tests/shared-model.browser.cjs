"use strict";

// Independent browser storage with a shared synthetic app-server. Live checks
// use deployed static assets but intercept all conversation and settings traffic.
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
const modelIds = ["gpt-5.6-sol", "gpt-6-sol", "gpt-6-astra"];
const models = modelIds.map((model) => ({ id: model, model, displayName: model,
  supportedReasoningEfforts: [{ reasoningEffort: "max" }], defaultReasoningEffort: "max", serviceTiers: [] }));

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = process.env.CODEX_WEB_BASE_URL || `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const threads = new Map(["shared", "other"].map((id) => [id, { id, name: `${id} chat`, cwd: "/workspaces",
    model: id === "shared" ? "gpt-6-sol" : "gpt-5.6-sol", reasoningEffort: "max", status: { type: "idle" }, turns: [] }]));
  const errors = [], starts = [];
  try {
    async function device(name, width, stale = false) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
      if (stale) await context.addInitScript(() => {
        if (!localStorage.getItem("codex-web-chat-settings-v1")) localStorage.setItem("codex-web-chat-settings-v1",
          JSON.stringify({ threads: { shared: { model: "gpt-5.6-sol", effort: "max" } } }));
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/config", (route) => route.fulfill({ json: { defaultCwd: "/workspaces", workspaceRoot: "/workspaces",
        historyChunkBytes: 1_000_000, chatDefaults: { model: "gpt-6-astra", effort: "max" } } }));
      await page.route("**/api/history", (route) => {
        const { threadId } = route.request().postDataJSON();
        assert.ok(threads.has(threadId));
        const records = [...threads.get(threadId).turns].reverse().flatMap((turn) => [
          { turn: { id: turn.id, status: turn.status } },
          ...[...turn.items].reverse().map((item) => ({ turnId: turn.id, item })),
        ]);
        return route.fulfill({ contentType: "application/x-ndjson", headers: { "X-Codex-History-Cursor": "", "X-Codex-History-Reset": "0" },
          body: records.map(JSON.stringify).join("\n") + (records.length ? "\n" : "") });
      });
      await page.routeWebSocket("**/ws", (ws) => ws.onMessage((raw) => {
        const request = JSON.parse(raw);
        if (request.id == null) return;
        const thread = threads.get(request.params?.threadId);
        if (request.params?.threadId) assert.ok(thread);
        let result = {};
        switch (request.method) {
          case "initialize": case "config/read": case "configRequirements/read": case "account/rateLimits/read": break;
          case "permissionProfile/list": result = { data: [] }; break;
          case "model/list": result = { data: models }; break;
          case "thread/list": result = { data: [...threads.values()].map((row) => ({ ...row, turns: [] })) }; break;
          case "thread/resume":
            assert.equal(request.params.model, undefined, "Opening a chat must not change its model");
            assert.equal(request.params.excludeTurns, true);
            result = { thread: { ...thread, turns: [] }, model: thread.model };
            break;
          case "thread/read":
            assert.equal(request.params.includeTurns, false);
            result = { thread: { ...thread, turns: [] } };
            break;
          case "turn/start": {
            if (request.params.model) thread.model = request.params.model;
            starts.push({ device: name, model: thread.model, override: request.params.model ?? null });
            const turn = { id: `turn-${starts.length}`, status: "inProgress", items: [] };
            thread.turns.push(turn);
            thread.status = { type: "active", activeFlags: [] };
            result = { turn };
            setTimeout(() => {
              const item = { id: `${turn.id}-answer`, type: "agentMessage", phase: "final_answer",
                text: `This turn used ${thread.model}.`, completedAtMs: Date.now() };
              turn.items.push(item);
              turn.status = "completed";
              thread.status = { type: "idle" };
              ws.send(JSON.stringify({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } }));
              ws.send(JSON.stringify({ method: "turn/completed", params: { threadId: thread.id, turn } }));
            }, 50);
            break;
          }
          default: throw new Error(`Unexpected request: ${request.method}`);
        }
        ws.send(JSON.stringify({ id: request.id, result }));
      }));
      await page.goto(`${base}/?thread=shared`, { waitUntil: "networkidle" });
      return page;
    }
    const expectModel = (page, model) => page.waitForFunction((value) => document.getElementById("selected-model").textContent === value, model);
    const choose = async (page, model) => {
      await page.locator("#settings-toggle").click();
      await page.locator("#setting-model").selectOption(model);
      await page.locator("#settings-close").click();
    };
    const send = async (page) => {
      const before = starts.length;
      await page.locator("#prompt").fill("Continue this chat");
      await page.locator("#send").click();
      await page.waitForFunction(() => document.getElementById("prompt").value === ""
        && document.getElementById("send").textContent === "Send");
      assert.equal(starts.length, before + 1);
    };
    const desktop = await device("desktop", 1280, true);
    const mobile = await device("mobile", 390);
    await expectModel(desktop, "gpt-6-sol");
    await expectModel(mobile, "gpt-6-sol");
    await choose(desktop, "gpt-5.6-sol");
    await send(desktop);
    assert.deepEqual(starts.at(-1), { device: "desktop", model: "gpt-5.6-sol", override: "gpt-5.6-sol" });
    await mobile.reload({ waitUntil: "networkidle" });
    await expectModel(mobile, "gpt-5.6-sol");
    await choose(mobile, "gpt-6-astra");
    await send(mobile);
    await expectModel(desktop, "gpt-5.6-sol"); // The already-open device still has its older view.
    await send(desktop);
    assert.deepEqual(starts.at(-1), { device: "desktop", model: "gpt-6-astra", override: null });
    await expectModel(desktop, "gpt-6-astra");
    await choose(mobile, "gpt-6-sol");
    await send(mobile);
    await desktop.reload({ waitUntil: "networkidle" });
    await expectModel(desktop, "gpt-6-sol");
    await desktop.locator('#threads a[href="/?thread=other"]').click();
    await expectModel(desktop, "gpt-5.6-sol");
    await desktop.locator('#threads a[href="/?thread=shared"]').click();
    await expectModel(desktop, "gpt-6-sol");
    await choose(mobile, "gpt-5.6-sol");
    await mobile.reload({ waitUntil: "networkidle" });
    await expectModel(mobile, "gpt-6-sol");
    for (const [page, width] of [[desktop, 1280], [mobile, 390], [mobile, 320]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator("#settings-toggle").click();
      assert.equal(await page.locator("#setting-model").inputValue(), "");
      assert.equal(await page.locator("#setting-model option:checked").textContent(), "Chat model — gpt-6-sol");
      assert.doesNotMatch(await page.locator("#model-help").textContent(), /unavailable/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (artifacts) {
        await fs.mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: path.join(artifacts, `shared-model-${width}.png`) });
      }
      await page.locator("#settings-close").click();
    }
    await desktop.locator("#new-thread").click();
    await expectModel(desktop, "gpt-6-astra");
    assert.deepEqual(errors, []);
    const report = { independentDevices: true, staleBrowserPreferenceIgnored: true, serverPersistsExplicitChoice: true,
      staleOpenDeviceInheritsLatest: true, chatSwitching: true, reload: true, newChatDefaults: true,
      unsentChoiceDoesNotOverrideAfterReload: true, widths: [1280, 390, 320], starts, pageErrors: errors, realConversationRequests: 0 };
    if (artifacts) await fs.writeFile(path.join(artifacts, "browser.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
