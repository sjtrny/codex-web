"use strict";

// Real HTTP streaming against a loopback UI, with simulated app-server traffic.
// No saved conversations, real Codex tasks, or running services are changed.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");

const staticRoot = path.resolve(process.env.CODEX_WEB_STATIC_ROOT || path.join(__dirname, "../static"));
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const searches = [];
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api/search" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const search = { response, params: JSON.parse(body), headers: request.headers, closed: false };
      response.on("close", () => { search.closed = true; });
      searches.push(search);
      return;
    }
    const file = path.resolve(staticRoot, url.pathname === "/" ? "index.html" : url.pathname.slice(8));
    if ((url.pathname !== "/" && !url.pathname.startsWith("/static/"))
      || !file.startsWith(staticRoot + path.sep)) throw new Error("Invalid path");
    response.writeHead(200, { "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream" });
    response.end(await fs.readFile(file));
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
  throw new Error("Timed out: " + label);
}

function result(id, timestamp = "2024-01-02T00:00:00Z") {
  return {
    threadId: id, turnId: "turn-" + id, itemId: "message-" + id,
    title: "Matching conversation " + id, snippet: "needle café — streaming preview",
    matchedText: "needle", timestamp, timestampSource: "turn",
  };
}

function snapshot(results, extra = {}) {
  return {
    results, total: results.length, scannedThreads: results.length,
    totalThreads: 10, done: false, ...extra,
  };
}

function send(search, payload) {
  if (!search.response.headersSent) {
    search.response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
  }
  search.response.write(JSON.stringify(payload) + "\n");
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  let page;
  const errors = [];
  async function screenshot(name) {
    if (!process.env.ARTIFACT_DIR || !page) return;
    await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, name + ".png"), fullPage: true });
  }
  try {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(7000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/config", (route) => route.fulfill({
      json: { defaultCwd: "/workspaces", workspaceRoot: "/workspaces", chatDefaults: {} },
    }));
    const thread = (id) => ({
      id, name: "Matching conversation " + id, cwd: "/workspaces",
      createdAt: 1704153600, updatedAt: 1704153600, status: { type: "idle" },
      turns: [{ id: "turn-" + id, status: "completed", items: [{
        id: "message-" + id, type: "agentMessage", text: "needle café — streaming preview",
      }] }],
    });
    await page.routeWebSocket("**/ws", (ws) => {
      ws.onMessage((raw) => {
        const message = JSON.parse(raw);
        if (message.id == null) return;
        let value;
        switch (message.method) {
          case "initialize": value = { userAgent: "search-browser-test" }; break;
          case "model/list":
          case "permissionProfile/list": value = { data: [] }; break;
          case "config/read": value = { config: {} }; break;
          case "configRequirements/read": value = { requirements: null }; break;
          case "thread/list": value = { data: [thread("early")], nextCursor: null }; break;
          case "thread/resume": value = { thread: thread(message.params.threadId) }; break;
          default: errors.push("Unexpected RPC: " + message.method); value = {};
        }
        ws.send(JSON.stringify({ id: message.id, result: value }));
      });
    });
    await page.goto("http://127.0.0.1:" + server.address().port);
    await eventually(async () => await page.locator("#threads a").count() === 1, "initial connection");
    await page.locator("#search-chats").click();
    const rows = page.locator("#search-results .search-result-button");
    const status = page.locator("#search-status");
    const busy = () => page.locator("#search-results").getAttribute("aria-busy");

    async function start(query = "needle") {
      const before = searches.length;
      await page.locator("#search-query").fill(query);
      await page.locator("#search-submit").click();
      await eventually(() => searches.length > before, "search request");
      return searches.at(-1);
    }
    async function expectRows(ids) {
      await eventually(async () => JSON.stringify(await rows.evaluateAll((nodes) => nodes.map(
        (node) => new URL(node.href).searchParams.get("thread"),
      ))) === JSON.stringify(ids), "visible results " + ids.join(", "));
    }

    const first = await start();
    assert.equal(first.params.q, "needle");
    assert.equal(typeof first.params.timezone, "string");
    send(first, snapshot([]));
    await eventually(async () => (await status.textContent()).includes("Checked 0 of 10"), "initial progress");
    assert.doesNotMatch(await status.textContent(), /No conversations/);
    send(first, snapshot([result("early")]));
    await expectRows(["early"]);
    assert.match(first.headers.accept, /application\/x-ndjson/);
    assert.equal(first.response.writableEnded, false, "results must render before HTTP completion");
    assert.equal(await busy(), "true");
    assert.match(await rows.first().textContent(), /needle café/);
    assert.equal(await rows.first().locator("mark").textContent(), "needle");
    await rows.first().focus();
    await rows.first().evaluate((node) => { window.firstSearchLink = node; });
    send(first, snapshot([result("newer", "2024-01-03T00:00:00Z"), result("early")]));
    await expectRows(["newer", "early"]);
    assert.equal(await rows.nth(1).evaluate((node) => node === window.firstSearchLink
      && document.activeElement === node), true, "live updates retain focused links");
    await screenshot("desktop-streaming");

    // Filters replace the active request and cancel the HTTP stream.
    const beforeFilter = searches.length;
    await page.locator("#search-sort").selectOption("oldest");
    await eventually(() => searches.length > beforeFilter && first.closed, "sort cancels earlier stream");
    const sorted = searches.at(-1);
    assert.equal(sorted.params.sort, "oldest");
    await expectRows([]);
    send(sorted, snapshot([result("early")]));
    send(sorted, snapshot([result("early"), result("newer")], { done: true }));
    sorted.response.end();
    await expectRows(["early", "newer"]);
    await eventually(async () => await busy() === "false", "sort completion");
    assert.match(await status.textContent(), /2 matching conversations found/);

    const cleared = await start();
    send(cleared, snapshot([result("clear-me")]));
    await expectRows(["clear-me"]);
    await page.locator("#search-clear").click();
    await eventually(() => cleared.closed, "clear cancels stream");
    await expectRows([]);
    assert.equal(await busy(), "false");
    assert.equal(await page.locator("#search-query").inputValue(), "");

    // A clean EOF without a terminal record must not look like a successful search.
    const interrupted = await start();
    send(interrupted, snapshot([result("kept")]));
    await expectRows(["kept"]);
    interrupted.response.end();
    await eventually(async () => await busy() === "false", "interrupted stream");
    await expectRows(["kept"]);
    assert.match(await status.textContent(), /ended before all conversations/);
    assert.match(await status.textContent(), /Results found so far/);

    const failed = await start();
    send(failed, snapshot([result("kept")]));
    send(failed, { error: "Could not search chat history", done: true });
    failed.response.end();
    await eventually(async () => await busy() === "false", "stream error");
    await expectRows(["kept"]);
    assert.match(await status.textContent(), /Could not search chat history/);

    // A non-streaming server still works during rolling updates.
    const legacy = await start();
    legacy.response.writeHead(200, { "Content-Type": "application/json" });
    legacy.response.end(JSON.stringify(snapshot([result("legacy")], { done: true })));
    await expectRows(["legacy"]);
    await eventually(async () => await busy() === "false", "legacy completion");

    await page.setViewportSize({ width: 390, height: 844 });
    await eventually(async () => await page.locator("#sidebar").evaluate(
      (node) => node.getBoundingClientRect().right <= 0,
    ), "mobile sidebar transition");
    const mobile = await start();
    send(mobile, snapshot([result("early")]));
    await expectRows(["early"]);
    await screenshot("mobile-streaming");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await rows.first().click();
    await eventually(() => mobile.closed, "opening a result cancels remaining search");
    assert.equal(await page.locator("#search-view").isVisible(), false);
    await eventually(async () => await page.locator("#thread-title").textContent()
      === "Matching conversation early", "open an early result");
    await eventually(async () => await page.locator(".message.search-match").count() === 1, "matching message focus");
    assert.deepEqual(errors, []);
    console.log("search-browser=ok (incremental HTTP, progress, stable focus, sort, cancellation, errors, legacy, mobile, early navigation)");
  } catch (error) {
    await screenshot("failure");
    throw error;
  } finally {
    await browser.close();
    for (const search of searches) search.response.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
