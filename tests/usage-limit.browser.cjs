"use strict";

// All account and conversation traffic is simulated, including against a deployment.
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

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = process.env.CODEX_WEB_BASE_URL || `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const errors = [], calls = [], sockets = new Map();
    const threads = ["first", "second"].map((id) => ({
      id, name: `Example ${id} chat`, cwd: "/workspaces", status: { type: "idle" },
      turns: [{ id: `turn-${id}`, status: "completed", items: [{ id: `message-${id}`, type: "agentMessage", phase: "final_answer",
        text: Array.from({ length: 55 }, (_, i) => `Example conversation paragraph ${i + 1}.`).join("\n\n") }] }],
    }));
    let usage = { accountId: "synthetic-account", ordinaryUsageAllowed: true, rateLimits: {} };
    let failReads = false;
    await context.route("**/api/config", (route) => route.fulfill({ json: {
      defaultCwd: "/workspaces", workspaceRoot: "/workspaces", showToolActivity: false,
      chatDefaults: { model: "gpt-6-astra", effort: "max", serviceTier: "priority" },
    } }));
    const makePage = async () => {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.routeWebSocket("**/ws", (socket) => {
        sockets.set(page, socket);
        socket.onMessage((raw) => {
          const request = JSON.parse(raw);
          calls.push(request);
          if (request.id === undefined) return;
          let result = {};
          switch (request.method) {
            case "initialize": case "config/read": case "configRequirements/read": break;
            case "permissionProfile/list": result = { data: [] }; break;
            case "account/rateLimits/read":
              if (failReads) {
                socket.send(JSON.stringify({ id: request.id, error: { message: "Usage check unavailable" } }));
                return;
              }
              result = usage;
              break;
            case "model/list": result = { data: [{ id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6-Astra",
              defaultReasoningEffort: "max", supportedReasoningEfforts: [{ reasoningEffort: "max" }] }] }; break;
            case "thread/list": result = { data: threads }; break;
            case "thread/resume":
              assert.ok(threads.some((thread) => thread.id === request.params.threadId));
              result = { thread: threads.find((thread) => thread.id === request.params.threadId) };
              break;
            default: throw new Error(`Unexpected request: ${request.method}`);
          }
          socket.send(JSON.stringify({ id: request.id, result }));
        });
      });
      await page.goto(base, { waitUntil: "networkidle" });
      await page.waitForFunction(() => !document.querySelector("#settings-toggle").disabled);
      return page;
    };
    const page = await makePage();
    const banner = page.locator("#usage-limit-warning");
    assert.equal(await banner.isVisible(), false);
    await page.locator('a.thread[href*="first"]').click();
    await page.locator("#thread-title").filter({ hasText: "Example first chat" }).waitFor();
    usage = { accountId: "synthetic-account", ordinaryUsageAllowed: false, rateLimits: {
      primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
    } };
    sockets.get(page).send(JSON.stringify({ method: "error", params: { threadId: "second", error: {
      codexErrorInfo: "usageLimitExceeded", message: "You've hit your usage limit.",
    } } }));
    await banner.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#usage-limit-detail").textContent.includes("Expected reset:"));
    await page.locator('a.thread[href*="second"]').click();
    await page.locator("#thread-title").filter({ hasText: "Example second chat" }).waitFor();
    assert.ok(await banner.isVisible());
    const beforeScroll = await banner.boundingBox();
    await page.locator("#messages").evaluate((el) => { el.scrollTop = 0; });
    const afterScroll = await banner.boundingBox();
    assert.equal(afterScroll.y, beforeScroll.y);
    await page.locator("#new-thread").click();
    assert.ok(await banner.isVisible());
    assert.equal(await page.locator("#notice").isVisible(), false);

    failReads = true;
    await page.reload({ waitUntil: "networkidle" });
    assert.ok(await banner.isVisible(), "warning survives reload when usage read fails");
    const oldSocket = sockets.get(page);
    oldSocket.close();
    await page.waitForFunction(() => !document.querySelector("#settings-toggle").disabled);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.notEqual(sockets.get(page), oldSocket);
    assert.ok(await banner.isVisible(), "warning survives reconnect");

    const secondPage = await makePage();
    assert.ok(await secondPage.locator("#usage-limit-warning").isVisible());
    for (const [width, theme] of [[1280, "light"], [390, "light"], [320, "dark"]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
      assert.ok(await banner.isVisible());
      const dimensions = await page.evaluate(() => ({
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        warningBottom: document.querySelector("#usage-limit-warning").getBoundingClientRect().bottom,
        messagesTop: document.querySelector(".messages-region").getBoundingClientRect().top,
        composerBottom: document.querySelector("#composer").getBoundingClientRect().bottom,
        height: innerHeight,
      }));
      assert.ok(dimensions.scrollWidth <= dimensions.width);
      assert.ok(dimensions.warningBottom <= dimensions.messagesTop);
      assert.ok(dimensions.composerBottom <= dimensions.height);
      if (artifacts) {
        await fs.mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: path.join(artifacts, `usage-limit-${width}-${theme}.png`), animations: "disabled" });
      }
    }
    failReads = false;
    usage = { accountId: "synthetic-account", ordinaryUsageAllowed: true, rateLimits: {} };
    await page.clock.install();
    // Install before a focus read so its next polling timer uses this clock.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await banner.waitFor({ state: "hidden" });
    await secondPage.locator("#usage-limit-warning").waitFor({ state: "hidden" });
    usage = { accountId: "synthetic-account", ordinaryUsageAllowed: false, rateLimits: {} };
    const readCount = calls.filter((call) => call.method === "account/rateLimits/read").length;
    await page.clock.fastForward(31000);
    await banner.waitFor({ state: "visible" });
    assert.ok(calls.filter((call) => call.method === "account/rateLimits/read").length > readCount);
    await secondPage.locator("#usage-limit-warning").waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
    assert.equal(calls.some((call) => ["turn/start", "turn/steer", "turn/interrupt"].includes(call.method)), false);
    const report = { backgroundError: true, persistsAcrossChats: true, pinnedWhileScrolling: true,
      reloadWithFailedRead: true, reconnect: true, crossTabWarningAndRecovery: true, automaticPolling: true,
      widths: [1280, 390, 320], pageErrors: errors, realAccountOrConversationRequests: 0 };
    if (artifacts) await fs.writeFile(path.join(artifacts, "browser.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
