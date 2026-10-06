"use strict";

// Isolated browser check: temporary static server and simulated app-server only.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");

const staticRoot = path.resolve(__dirname, "../static");
const artifacts = path.resolve(process.env.ARTIFACT_DIR || path.join(__dirname, "../../artifacts/message-timestamps"));
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/" && !url.pathname.startsWith("/static/")) throw new Error("Invalid path");
    const file = path.resolve(staticRoot, url.pathname === "/" ? "index.html" : url.pathname.slice(8));
    if (!file.startsWith(`${staticRoot}${path.sep}`)) throw new Error("Invalid path");
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
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const thread = {
      id: "chat", name: "Message timestamps", cwd: "/workspaces",
      createdAt: 1704067200, updatedAt: 1704153660, status: { type: "idle" },
      turns: [{ id: "saved-turn", startedAt: 1704153600, completedAt: 1704153660, status: "completed", items: [
        { id: "saved-user", type: "userMessage", createdAt: "2024-01-02T00:00:00Z", content: [{ type: "text", text: "Show timestamps when the exact time is known." }] },
        { id: "saved-progress", type: "agentMessage", phase: "commentary", text: "I’m checking how saved messages carry their times." },
        { id: "saved-plan", type: "plan", text: "Display local times and preserve live timestamps across reloads." },
        { id: "saved-command", type: "commandExecution", createdAt: 1704153640, command: "node --test tests/timestamps.test.js", status: "completed", aggregatedOutput: "All timestamp checks passed." },
        { id: "saved-final", type: "agentMessage", phase: "final_answer", text: "Messages without an exact timestamp show no time information." },
      ] }],
    };
    const errors = [];
    const contexts = [];
    const report = { checks: [], layouts: [], errors };
    const origin = `http://127.0.0.1:${server.address().port}`;
    const pending = [];
    let socket;
    let liveTurn;
    let clock = Date.parse("2026-10-06T12:34:56Z");
    const notify = (method, params) => socket.send(JSON.stringify({ method, params }));
    const respond = (message, result) => socket.send(JSON.stringify({ id: message.id, result }));
    async function newPage(timezoneId, locale) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId, locale, serviceWorkers: "block" });
      contexts.push(context);
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript((now) => {
        window.timestampClock = now;
        Date.now = () => window.timestampClock;
      }, clock);
      await page.route("**/api/config", (route) => route.fulfill({ json: {
        defaultCwd: "/workspaces", workspaceRoot: "/workspaces", chatDefaults: {}, showToolActivity: true,
      } }));
      await page.routeWebSocket("**/ws", (ws) => {
        socket = ws;
        ws.onMessage((data) => {
          const message = JSON.parse(data);
          if (!message.method || message.id == null) return;
          if (["turn/start", "turn/steer"].includes(message.method)) {
            pending.push(message);
            return;
          }
          const results = {
            initialize: { userAgent: "timestamp-browser-check" },
            "model/list": { data: [] }, "permissionProfile/list": { data: [] },
            "config/read": { config: {} }, "configRequirements/read": { requirements: null },
            "thread/list": { data: [thread], nextCursor: null }, "thread/resume": { thread },
          };
          respond(message, results[message.method] || {});
        });
      });
      await page.goto(`${origin}/?thread=chat`);
      await eventually(async () => await page.locator(".message.user").count() >= 1 && await page.locator("#send").isEnabled(), "history loaded");
      return page;
    }
    const page = await newPage("Australia/Sydney", "en-AU");
    const stamp = (text) => page.locator(".message").filter({ hasText: text }).locator("time");
    const saved = page.locator(".message.user time").first();
    assert.match(await saved.textContent(), /^2 Jan 2024.*11:00:00/);
    assert.equal(await saved.getAttribute("datetime"), "2024-01-02T00:00:00.000Z");
    assert.match(await saved.getAttribute("aria-label"), /Message time.*(AEDT|GMT\+11)/);
    assert.equal(await page.locator(".activity time:visible").count(), 1);
    assert.equal(await page.locator(".message.agent time:visible").count(), 0);
    assert.equal(await page.locator("time[hidden][title], time[hidden][aria-label], time[hidden][datetime]").count(), 0);
    assert.doesNotMatch(await page.locator("#messages").textContent(), /≈|Time unavailable/);
    report.checks.push("only exact per-message timestamps appear; missing task/conversation times and labels are omitted");

    await page.locator("#prompt").fill("Add timestamps while I type.");
    await page.locator("#send").click();
    await eventually(() => pending.length === 1, "turn start intercepted");
    assert.equal(await stamp("Add timestamps while I type.").isVisible(), false);
    assert.equal(await stamp("Add timestamps while I type.").getAttribute("datetime"), null);
    const localTime = new Date(clock).toISOString();
    const start = pending.shift();
    liveTurn = { id: "live-turn", startedAt: clock / 1000, status: "inProgress", items: [
      { id: "canonical-user", type: "userMessage", createdAt: localTime, content: start.params.input },
    ] };
    thread.turns.push(liveTurn);
    thread.status = { type: "active", activeFlags: [] };
    notify("turn/started", { threadId: "chat", turn: liveTurn });
    notify("item/completed", { threadId: "chat", turnId: liveTurn.id, item: liveTurn.items[0] });
    respond(start, { turn: liveTurn });
    await eventually(async () => await page.locator("#send").textContent() === "Stop", "active turn accepted");
    assert.equal(await stamp("Add timestamps while I type.").getAttribute("datetime"), localTime);

    clock += 5000;
    await page.evaluate((now) => { window.timestampClock = now; }, clock);
    await page.locator("#prompt").fill("Keep those times after a reload.");
    await page.locator("#send").click();
    await eventually(() => pending.length === 1, "reply intercepted");
    assert.equal(await stamp("Keep those times after a reload.").isVisible(), false);
    const replyTime = new Date(clock).toISOString();
    const reply = pending.shift();
    const replyItem = { id: "canonical-reply", type: "userMessage", createdAt: replyTime, content: reply.params.input };
    liveTurn.items.push(replyItem);
    notify("item/completed", { threadId: "chat", turnId: liveTurn.id, item: replyItem });
    respond(reply, { turnId: liveTurn.id });
    await eventually(async () => await page.locator("#send").textContent() === "Stop", "reply accepted");
    assert.equal(await stamp("Keep those times after a reload.").getAttribute("datetime"), replyTime);
    report.checks.push("optimistic sends and mid-task replies show times only after exact backend timestamps arrive");

    clock += 10000;
    await page.evaluate((now) => { window.timestampClock = now; }, clock);
    const live = { id: "stream-id", type: "agentMessage", createdAt: new Date(clock - 3000).toISOString(), phase: "final_answer", text: "" };
    notify("item/started", { threadId: "chat", turnId: liveTurn.id, item: live });
    await eventually(async () => await page.locator(".message.agent").count() === 3, "stream started");
    const liveTime = await page.locator(".message.agent time").last().getAttribute("datetime");
    assert.equal(liveTime, live.createdAt);
    clock += 60000;
    await page.evaluate((now) => { window.timestampClock = now; }, clock);
    live.text = "Each message now keeps its original timestamp through streaming and reloads.";
    liveTurn.items.push({ ...live, id: "canonical-agent" });
    notify("item/agentMessage/delta", { threadId: "chat", turnId: liveTurn.id, itemId: live.id, delta: live.text });
    notify("item/completed", { threadId: "chat", turnId: liveTurn.id, item: live });
    liveTurn.status = "completed";
    liveTurn.completedAt = clock / 1000;
    thread.status = { type: "idle" };
    notify("turn/completed", { threadId: "chat", turn: liveTurn });
    await eventually(async () => await page.locator("#send").textContent() === "Send", "stream finished");
    assert.equal(await stamp(live.text).getAttribute("datetime"), liveTime);
    await page.reload();
    await eventually(async () => await page.locator(".message.agent").count() === 3, "reloaded history");
    assert.equal(await stamp(live.text).getAttribute("datetime"), liveTime);
    assert.equal(await stamp(live.text).getAttribute("data-timestamp-source"), "message");
    assert.equal(await stamp("Add timestamps while I type.").getAttribute("datetime"), localTime);
    assert.equal(await stamp("Keep those times after a reload.").getAttribute("datetime"), replyTime);
    report.checks.push("streaming, completion, canonical history IDs, and full page reload preserve live timestamps");

    await fs.mkdir(artifacts, { recursive: true });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (width < 760) {
        await page.waitForFunction(() => document.getElementById("sidebar").getBoundingClientRect().right <= 0);
      }
      const layout = await page.evaluate(() => ({
        width: window.innerWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        clipped: [...document.querySelectorAll(".message time:not([hidden]), .activity time:not([hidden])")].filter((time) => {
          const bounds = time.getBoundingClientRect();
          const parent = time.closest(".message, .activity").getBoundingClientRect();
          return bounds.left < parent.left - 1 || bounds.right > parent.right + 1 || bounds.right > window.innerWidth;
        }).length,
      }));
      assert.equal(layout.overflow, false);
      assert.equal(layout.clipped, 0);
      report.layouts.push(layout);
      await page.screenshot({ path: path.join(artifacts, `timestamps-${width}.png`) });
    }
    const otherZone = await newPage("America/Los_Angeles", "en-US");
    const otherTime = await otherZone.locator(".message.user time").first().textContent();
    assert.match(otherTime, /^Jan 1, 2024.*04:00:00 PM/);
    report.checks.push("desktop and 390/320px layouts; timestamps follow the browser's local date across midnight");
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(artifacts, "browser-report.json"), JSON.stringify(report, null, 2));
    for (const context of contexts) await context.close();
    console.log(`message-timestamps-browser=ok; artifacts=${artifacts}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; server.close(); });
