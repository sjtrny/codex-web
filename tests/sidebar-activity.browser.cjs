"use strict";

// A loopback UI with simulated WebSocket traffic: no real Codex tasks or service changes.
// Use PLAYWRIGHT_MODULE for an existing installation and ARTIFACT_DIR for screenshots.
// CODEX_WEB_BASE_URL checks served assets; its API and WebSocket traffic is still simulated.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");

const staticRoot = path.resolve(process.env.CODEX_WEB_STATIC_ROOT || path.join(__dirname, "../static"));
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const file = path.resolve(staticRoot, url.pathname === "/" ? "index.html" : url.pathname.slice(8));
    if ((url.pathname !== "/" && !url.pathname.startsWith("/static/"))
      || !file.startsWith(`${staticRoot}${path.sep}`)) throw new Error("Invalid path");
    const body = await fs.readFile(file);
    response.writeHead(200, { "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

async function eventually(check, label) {
  const deadline = Date.now() + 7000;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  let page;
  async function screenshot(name) {
    if (!process.env.ARTIFACT_DIR || !page) return;
    await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${name}.png`), fullPage: true });
  }
  try {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/config", (route) => route.fulfill({
      json: { defaultCwd: "/workspaces", workspaceRoot: "/workspaces", chatDefaults: {} },
    }));
    const idle = { type: "idle" };
    const active = { type: "active", activeFlags: [] };
    const threads = ["a", "b"].map((id) => ({
      id, name: id === "a" ? "Selected chat" : "Background chat", cwd: "/workspaces",
      createdAt: 1789084800, updatedAt: 1789084800, status: idle, turns: [],
    }));
    let listed = structuredClone(threads);
    let holdLists = false;
    let socket;
    let connections = 0;
    const pendingLists = [];
    const pendingStarts = [];
    const send = (message) => socket.send(JSON.stringify(message));
    const notification = (method, params) => send({ method, params });
    const settle = () => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const flushLists = async (fail = false) => {
      // Respond newest first, so older overlapping responses arrive last.
      for (const request of pendingLists.splice(0).reverse()) {
        send(fail ? { id: request.id, error: { message: "History unavailable" } }
          : { id: request.id, result: request.result });
      }
      await settle();
    };
    await page.routeWebSocket("**/ws", (ws) => {
      socket = ws;
      connections += 1;
      ws.onMessage((payload) => {
        const message = JSON.parse(payload);
        if (!message.method || message.id == null) return;
        let result;
        switch (message.method) {
          case "initialize": result = { userAgent: "sidebar-browser-test" }; break;
          case "model/list":
          case "permissionProfile/list": result = { data: [] }; break;
          case "config/read": result = { config: {} }; break;
          case "configRequirements/read": result = { requirements: null }; break;
          case "thread/list":
            result = { data: structuredClone(listed), nextCursor: null };
            if (holdLists) { pendingLists.push({ id: message.id, result }); return; }
            break;
          case "thread/resume": result = { thread: threads.find((thread) => thread.id === message.params.threadId) }; break;
          case "turn/start": pendingStarts.push(message); return;
          default: errors.push(`Unexpected RPC: ${message.method}`); result = {};
        }
        ws.send(JSON.stringify({ id: message.id, result }));
      });
    });
    const row = (id) => page.locator(`#threads a[href="/?thread=${id}"]`);
    async function expectRow(id, running) {
      await eventually(async () => await row(id).getAttribute("aria-busy") === String(running),
        `${id} sidebar ${running ? "active" : "idle"}`);
      assert.equal(await row(id).evaluate((node) => node.classList.contains("running")), running);
      assert.match(await row(id).locator("small").textContent(), running ? / · active$/ : / · idle$/);
    }
    async function expectComposer(text, enabled = true) {
      await eventually(async () => await page.locator("#send").textContent() === text
        && await page.locator("#send").isEnabled() === enabled, `composer ${text}`);
    }
    const baseUrl = process.env.CODEX_WEB_BASE_URL || `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${baseUrl}/?thread=a`);
    await expectRow("a", false);
    await expectComposer("Send");
    await eventually(async () => await page.locator("#thread-title").textContent() === "Selected chat", "history loaded");
    await settle();

    holdLists = true;
    threads[0].status = active;
    threads[0].turns = [{ id: "turn-a", status: "inProgress", items: [] }];
    notification("thread/status/changed", { threadId: "a", status: active });
    await eventually(() => pendingLists.length > 0, "status refresh held");
    await expectRow("a", true);
    notification("turn/started", { threadId: "a", turn: threads[0].turns[0] });
    await expectComposer("Stop");
    await eventually(() => pendingLists.length >= 2, "turn refresh held");
    await flushLists();
    await expectRow("a", true);
    await expectComposer("Stop");
    assert.equal(await page.locator("#thinking-indicator").isVisible(), true);
    await screenshot("active-after-stale-idle-list");

    listed[0].status = active;
    threads[0].status = idle;
    threads[0].turns[0].status = "completed";
    notification("turn/completed", { threadId: "a", turn: threads[0].turns[0] });
    await expectRow("a", false);
    await expectComposer("Send");
    await eventually(() => pendingLists.length > 0, "completion refresh held");
    await flushLists();
    await expectRow("a", false);
    await expectComposer("Send");

    listed = structuredClone(threads);
    notification("thread/status/changed", { threadId: "b", status: active });
    await expectRow("b", true);
    await expectRow("a", false);
    await expectComposer("Send");
    await eventually(() => pendingLists.length > 0, "background refresh held");
    await flushLists();
    await expectRow("b", true);
    notification("turn/started", { threadId: "b", turn: { id: "turn-b", status: "inProgress" } });
    await eventually(() => pendingLists.length > 0, "background turn refresh held");
    await flushLists(true);
    await expectRow("b", true);
    await expectComposer("Send");
    listed[1].status = active;
    notification("thread/status/changed", { threadId: "b", status: idle });
    await expectRow("b", false);
    await eventually(() => pendingLists.length > 0, "idle status refresh held");
    await flushLists();
    await expectRow("b", false);

    listed = structuredClone(threads);
    await page.locator("#prompt").fill("Simulated task");
    await page.locator("#send").click();
    await eventually(() => pendingStarts.length > 0, "local turn request held");
    await expectRow("a", true);
    send({ id: pendingStarts.shift().id, error: { message: "Simulated start failure" } });
    await expectRow("a", false);
    await expectComposer("Send");
    assert.equal(await page.locator("#prompt").inputValue(), "Simulated task");
    await page.locator("#send").click();
    await eventually(() => pendingStarts.length > 0, "retry turn request held");
    const retryTurn = { id: "turn-retry", status: "inProgress", items: [] };
    threads[0].status = active;
    threads[0].turns.push(retryTurn);
    send({ id: pendingStarts.shift().id, result: { turn: retryTurn } });
    await expectRow("a", true);
    await expectComposer("Stop");
    await eventually(() => pendingLists.length > 0, "RPC-only activity refresh held");
    await flushLists();
    await expectRow("a", true);
    await expectComposer("Stop");

    // Completion was missed while disconnected. Fresh snapshots must replace live overrides.
    holdLists = false;
    threads[0].status = idle;
    retryTurn.status = "completed";
    listed = structuredClone(threads);
    const previousConnections = connections;
    socket.close();
    await eventually(() => connections > previousConnections, "reconnected");
    await expectRow("a", false);
    await expectComposer("Send");
    listed[1].status = active;
    const beforeActiveReconnect = connections;
    socket.close();
    await eventually(() => connections > beforeActiveReconnect, "reconnected with background work");
    await expectRow("b", true);
    await expectComposer("Send");
    assert.deepEqual(errors, []);
    await screenshot("background-active-after-reconnect");
    console.log("sidebar-activity-browser=ok (live events, stale/out-of-order/failed lists, submission, completion, reconnect)");
  } catch (error) {
    await screenshot("failure");
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => server.close());
