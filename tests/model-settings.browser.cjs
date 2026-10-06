"use strict";

// Only simulated conversations are used. Optionally check deployed assets with CODEX_WEB_BASE_URL.
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
const fast = { id: "priority", name: "Fast", description: "Faster responses, increased usage" };
const ultra = { id: "ultrafast", name: "Ultrafast", description: "Highest speed, increased usage" };
function model(id, tiers = [fast], efforts = ["medium", "high", "max", "ultra"]) {
  return {
    id, model: id, displayName: id, description: `About ${id}`,
    defaultReasoningEffort: "medium", supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort, description: `${reasoningEffort} reasoning`,
    })), serviceTiers: tiers, supportsPersonality: false,
  };
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = process.env.CODEX_WEB_BASE_URL || `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], calls = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/config", (route) => route.fulfill({ json: {
      defaultCwd: "/workspaces", workspaceRoot: "/workspaces", showToolActivity: false,
      chatDefaults: { model: "gpt-5.6-sol", effort: "max", serviceTier: "priority", summary: "none" },
    } }));
    let failRefresh = false;
    await page.routeWebSocket("**/ws", (ws) => ws.onMessage((raw) => {
      const message = JSON.parse(raw);
      calls.push(message);
      if (message.id === undefined) return;
      let result = {};
      switch (message.method) {
        case "model/list":
          if (failRefresh && message.params.cursor) {
            ws.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Catalog temporarily unavailable" } }));
            return;
          }
          result = message.params.cursor
            ? { data: [model("gpt-6.1-sol"), model("gpt-6-astra", [fast, ultra]), model("gpt-6-luna", [fast], ["medium", "max"])], nextCursor: null }
            : { data: [model("gpt-5.6-sol"), model("gpt-6-sol")], nextCursor: "second-page" };
          break;
        case "thread/list": result = { data: [] }; break;
        case "thread/start": result = { thread: { id: "synthetic-model-check", cwd: "/workspaces", turns: [], status: { type: "idle" } } }; break;
        case "turn/start": result = { turn: { id: "synthetic-turn", status: "completed", items: [] } }; break;
        case "initialize": case "config/read": case "configRequirements/read": case "permissionProfile/list": break;
        default: throw new Error(`Unexpected request: ${message.method}`);
      }
      ws.send(JSON.stringify({ id: message.id, result }));
    }));
    const open = async () => {
      await page.locator("#settings-toggle").click();
      await page.locator('#setting-model option[value="gpt-6.1-sol"]').waitFor({ state: "attached" });
    };
    await page.goto(base, { waitUntil: "networkidle" });
    await open();
    assert.match(await page.locator("#setting-model option:checked").textContent(), /Instance default.*gpt-5.6-sol/);
    await page.locator("#setting-model").selectOption("gpt-6-astra");
    await page.locator("#setting-service-tier").selectOption("ultrafast");
    assert.match(await page.locator("#service-tier-help").textContent(), /Highest speed/);
    await page.reload({ waitUntil: "networkidle" });
    await open();
    assert.equal(await page.locator("#setting-model").inputValue(), "gpt-6-astra");
    assert.equal(await page.locator("#setting-service-tier").inputValue(), "ultrafast");
    failRefresh = true;
    await page.locator("#refresh-models").click();
    await page.waitForFunction(() => document.querySelector("#model-catalog-status").textContent.includes("Could not refresh"));
    assert.equal(await page.locator("#setting-service-tier").inputValue(), "ultrafast");
    failRefresh = false;
    await page.locator("#refresh-models").click();
    await page.waitForFunction(() => document.querySelector("#model-catalog-status").textContent.startsWith("5 models"));
    await page.locator("#setting-model").selectOption("gpt-6-sol");
    assert.equal(await page.locator('#setting-service-tier option[value="ultrafast"]').count(), 0);
    assert.equal(await page.locator("#setting-service-tier").inputValue(), "");
    await page.locator("#setting-service-tier").selectOption("default");
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.locator("#setting-service-tier").isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await page.locator("#settings-dialog").evaluate((el) => el.scrollWidth <= el.clientWidth));
      if (artifacts) {
        await fs.mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: path.join(artifacts, `models-${width}.png`) });
      }
    }
    await page.locator("#settings-close").click();
    await page.locator("#prompt").fill("Synthetic settings check");
    await page.locator("#prompt").press("Enter");
    await page.waitForFunction(() => document.querySelector("#prompt").value === "");
    for (const method of ["thread/start", "turn/start"]) {
      const call = calls.find((entry) => entry.method === method);
      assert.ok(call, method);
      assert.equal(call.params.model, "gpt-6-sol");
      assert.equal(call.params.serviceTier, "default");
    }
    assert.equal(calls.find((entry) => entry.method === "turn/start").params.effort, "max");
    assert.deepEqual(errors, []);
    const report = { catalogPagination: true, refreshFailurePreservesSettings: true, speedPersistence: true, modelSpecificTiers: true, standardOverrideSent: true, widths: [1280,390,320], realConversationRequests: 0, pageErrors: errors };
    if (artifacts) await fs.writeFile(path.join(artifacts, "browser.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
