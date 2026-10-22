"use strict";

// Loopback assets and simulated app-server traffic; no real tasks or service changes.
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
    response.writeHead(200, { "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream" });
    response.end(await fs.readFile(file));
  } catch {
    response.writeHead(404);
    response.end();
  }
});

const question = (id) => ({
  id, type: "agentMessage", phase: "final_answer", text: "Which colour should I use?",
  questions: [{ title: "Which colour should I use?", options: ["Blue", "Green"] }],
});
const threads = new Map([
  ["recent", { id: "recent", name: "Recent conversation", recencyAt: 1791432000, status: { type: "idle" }, turns: [] }],
  ["pinned", { id: "pinned", name: "Pinned reference notes", recencyAt: 1791345600, status: { type: "idle" }, turns: [] }],
  ["working", { id: "working", name: "Background task", recencyAt: 1791259200, status: { type: "active" }, turns: [{ id: "turn-working", status: "inProgress", items: [] }] }],
  ["older", { id: "older", name: "Website colours and typography with a long title", recencyAt: 1791172800, status: { type: "active" }, turns: [{ id: "turn-older", status: "inProgress", items: [question("initial")] }] }],
]);

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  let page;
  const errors = [];
  const received = [];
  let socket;
  let rejectReply = false;
  let connections = 0;
  const send = (method, params) => socket.send(JSON.stringify({ method, params }));
  const item = (id, value) => {
    threads.get(id).turns[0].items.push(value);
    send("item/completed", { threadId: id, turnId: `turn-${id}`, item: value });
  };
  async function setup(options = {}) {
    const context = await browser.newContext({ serviceWorkers: "block", ...options });
    context.setDefaultTimeout(7000);
    context.on("page", (tab) => tab.on("pageerror", (error) => errors.push(error.message)));
    await context.addInitScript(() => {
      if (location.protocol === "http:") localStorage.setItem("codex-web-pinned-threads-v1", '["pinned"]');
    });
    await context.route("**/api/config", (route) => route.fulfill({ json: { defaultCwd: "/workspaces", chatDefaults: {} } }));
    await context.route("**/api/thread-questions", (route) => {
      const threadId = route.request().postDataJSON().threadId;
      const turn = threads.get(threadId).turns.at(-1);
      let pending = false;
      if (turn?.status === "inProgress") for (const item of turn.items) {
        if (item.type === "userMessage") pending = false;
        if (item.type === "agentMessage") {
          if (item.questions?.length) pending = true;
          else if (item.phase === "final_answer") pending = false;
        }
      }
      return route.fulfill({ json: { threadId, turnId: turn?.id || null, pending } });
    });
    await context.routeWebSocket("**/ws", (ws) => {
      socket = ws;
      connections += 1;
      ws.onMessage((raw) => {
        const message = JSON.parse(raw);
        received.push(message);
        if (!message.method || message.id == null) return;
        let result;
        switch (message.method) {
          case "initialize": result = {}; break;
          case "account/rateLimits/read": result = {}; break;
          case "model/list":
          case "permissionProfile/list": result = { data: [] }; break;
          case "config/read": result = { config: {} }; break;
          case "configRequirements/read": result = { requirements: null }; break;
          case "thread/list": result = { data: [...threads.values()].map((thread) => ({ ...thread, turns: [] })), nextCursor: null }; break;
          case "thread/read":
            assert.equal(message.params.includeTurns, false);
            result = { thread: { ...threads.get(message.params.threadId), turns: [] } }; break;
          case "thread/resume": result = { thread: threads.get(message.params.threadId) }; break;
          case "turn/steer":
            if (rejectReply) {
              ws.send(JSON.stringify({ id: message.id, error: { message: "Simulated reply failure" } }));
              return;
            }
            item(message.params.threadId, { id: message.params.clientUserMessageId, type: "userMessage", content: message.params.input });
            result = {};
            break;
          default: errors.push(`Unexpected RPC: ${message.method}`); result = {};
        }
        ws.send(JSON.stringify({ id: message.id, result }));
      });
    });
    return context;
  }
  const row = (id) => page.locator(`#threads a[href="/?thread=${id}"]`);
  const badge = (id) => row(id).locator(".thread-question");
  async function expectOrder(expected) {
    await page.waitForFunction((ids) => JSON.stringify(Array.from(document.querySelectorAll("#threads a"), (link) => (
      new URL(link.href).searchParams.get("thread")
    ))) === JSON.stringify(ids), expected);
  }
  async function screenshot(name) {
    if (!process.env.ARTIFACT_DIR) return;
    await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${name}.png`), animations: "disabled" });
  }
  async function checkBadgeFits(id) {
    assert.equal(await badge(id).isVisible(), true);
    assert.match(await row(id).ariaSnapshot(), /Question awaiting your reply/);
    const layout = await row(id).evaluate((link) => {
      const badge = link.querySelector(".thread-question").getBoundingClientRect();
      const title = link.querySelector("strong").getBoundingClientRect();
      const bounds = link.getBoundingClientRect();
      const pin = link.parentElement.querySelector(".thread-pin").getBoundingClientRect();
      return { badgeLeft: badge.left, badgeRight: badge.right, titleRight: title.right, linkRight: bounds.right, pinLeft: pin.left, width: badge.width };
    });
    assert.ok(layout.width >= 18 && layout.badgeLeft >= layout.titleRight, JSON.stringify(layout));
    assert.ok(layout.badgeRight <= layout.linkRight && layout.badgeRight <= layout.pinLeft, JSON.stringify(layout));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  try {
    const context = await setup({ viewport: { width: 1280, height: 820 } });
    page = await context.newPage();
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/?thread=recent`);
    await expectOrder(["older", "pinned", "recent", "working"]);
    await checkBadgeFits("older");
    assert.ok(!received.some((message) => message.method === "thread/resume" && message.params.threadId === "older"));
    await page.locator("#prompt").fill("Keep my draft");
    await row("pinned").focus();
    item("working", question("background"));
    await expectOrder(["working", "older", "pinned", "recent"]);
    assert.equal(await row("pinned").evaluate((link) => link === document.activeElement), true);
    assert.equal(await page.locator("#prompt").inputValue(), "Keep my draft");
    await screenshot("desktop-questions-first");
    await page.evaluate(() => document.documentElement.dataset.theme = "dark");
    await screenshot("desktop-questions-first-dark");

    item("working", { id: "external-reply", type: "userMessage", content: [{ type: "text", text: "Blue" }] });
    await expectOrder(["older", "pinned", "recent", "working"]);
    assert.equal(await badge("working").isVisible(), false);
    await row("older").click();
    await page.locator("#pending-questions").waitFor({ state: "visible" });
    rejectReply = true;
    await page.locator("#prompt").fill("Blue");
    await page.locator("#send").click();
    await page.waitForFunction(() => document.getElementById("prompt").value === "Blue");
    assert.equal(await badge("older").isVisible(), true);
    rejectReply = false;
    await page.locator("#send").click();
    await expectOrder(["pinned", "recent", "working", "older"]);
    assert.equal(await badge("older").isVisible(), false);

    item("older", question("before-reload"));
    await page.reload();
    await expectOrder(["older", "pinned", "recent", "working"]);
    await row("recent").click();
    const beforeReconnect = connections;
    // A background question is answered while disconnected; stale cache must not win.
    threads.get("older").turns[0].items.push({ id: "offline-answer", type: "userMessage", content: [{ type: "text", text: "Green" }] });
    socket.close();
    await expectOrder(["pinned", "recent", "working", "older"]);
    assert.ok(connections > beforeReconnect);
    item("older", question("mobile-question"));
    await expectOrder(["older", "pinned", "recent", "working"]);
    await context.close();

    const mobile = await setup({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page = await mobile.newPage();
    await page.goto(`${base}/?thread=recent`);
    await expectOrder(["older", "pinned", "recent", "working"]);
    await page.locator("#menu").click();
    await checkBadgeFits("older");
    await screenshot("mobile-questions-first-390");
    await page.setViewportSize({ width: 320, height: 720 });
    await page.evaluate(() => document.documentElement.dataset.theme = "dark");
    await checkBadgeFits("older");
    await screenshot("mobile-questions-first-320-dark");
    threads.get("older").status = { type: "idle" };
    threads.get("older").turns[0].status = "completed";
    send("turn/completed", { threadId: "older", turn: threads.get("older").turns[0] });
    await expectOrder(["pinned", "recent", "working", "older"]);
    assert.equal(await badge("older").isVisible(), false);
    assert.deepEqual(errors, []);
    console.log("sidebar-question indicators, ordering, replies, reload, reconnect and desktop/mobile layouts: ok");
  } catch (error) {
    await screenshot("failure");
    throw error;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
