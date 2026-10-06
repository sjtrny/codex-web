"use strict";

// Loopback assets and simulated app-server traffic; real conversations remain untouched.
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

async function eventually(check, label) {
  const deadline = Date.now() + 7000;
  do {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  let page;
  async function screenshot(name, target = page) {
    if (!target || !process.env.ARTIFACT_DIR) return;
    await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
    await target.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${name}.png`), animations: "disabled" });
  }
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, serviceWorkers: "block" });
    context.setDefaultTimeout(7000);
    const errors = [];
    context.on("page", (tab) => tab.on("pageerror", (error) => errors.push(error.message)));
    await context.route("**/api/config", (route) => route.fulfill({
      json: { defaultCwd: "/workspaces", workspaceRoot: "/workspaces", chatDefaults: {} },
    }));
    const threads = new Map([
      ["recent", { id: "recent", name: "Recent conversation", recencyAt: 1791244800, status: { type: "idle" }, turns: [] }],
      ["middle", { id: "middle", name: "Background project", recencyAt: 1791158400, status: { type: "active" }, turns: [] }],
      ["old", { id: "old", name: "Reference conversation", recencyAt: 1791072000, status: { type: "idle" }, turns: [] }],
    ]);
    const received = [];
    const sockets = new Set();
    let connections = 0;
    let fullList = true;
    let holdOlderPage = false;
    let heldPage;
    let latestSocket;
    await context.routeWebSocket("**/ws", (socket) => {
      connections += 1;
      sockets.add(socket);
      latestSocket = socket;
      socket.onClose(() => sockets.delete(socket));
      socket.onMessage((raw) => {
        const message = JSON.parse(raw);
        received.push(message);
        if (!message.method || message.id == null) return;
        let result;
        switch (message.method) {
          case "initialize": result = {}; break;
          case "model/list":
          case "permissionProfile/list": result = { data: [] }; break;
          case "config/read": result = { config: {} }; break;
          case "configRequirements/read": result = { requirements: null }; break;
          case "thread/resume": result = { thread: threads.get(message.params.threadId) }; break;
          case "thread/list":
            if (message.params.cursor) {
              assert.equal(message.params.cursor, "older-page");
              result = { data: threads.has("old") ? [threads.get("old")] : [], nextCursor: null };
              if (holdOlderPage) {
                heldPage = () => socket.send(JSON.stringify({ id: message.id, result }));
                return;
              }
            } else {
              result = {
                data: [...threads.values()].filter((thread) => fullList || thread.id !== "old"),
                nextCursor: fullList ? null : "older-page",
              };
            }
            break;
          default:
            errors.push(`Unexpected RPC: ${message.method}`);
            socket.send(JSON.stringify({ id: message.id, error: { message: "Unexpected RPC" } }));
            return;
        }
        socket.send(JSON.stringify({ id: message.id, result }));
      });
    });
    function broadcast(method, params) {
      for (const socket of sockets) socket.send(JSON.stringify({ method, params }));
    }
    const row = (tab, id) => tab.locator(`#threads a[href="/?thread=${id}"]`);
    const pin = (tab, id) => row(tab, id).locator("..").locator("button.thread-pin");
    async function clickPin(tab, id) {
      await row(tab, id).hover();
      await pin(tab, id).click();
    }
    async function expectOrder(tab, ids) {
      await tab.waitForFunction((expected) => {
        const actual = Array.from(document.querySelectorAll("#threads a"), (link) => (
          new URL(link.href).searchParams.get("thread")
        ));
        return JSON.stringify(actual) === JSON.stringify(expected);
      }, ids);
    }
    const base = `http://127.0.0.1:${server.address().port}`;
    page = await context.newPage();
    await page.goto(`${base}/?thread=recent`);
    await page.waitForFunction(() => document.getElementById("thread-title").textContent === "Recent conversation");
    await expectOrder(page, ["recent", "middle", "old"]);
    await page.locator("#prompt").fill("Keep this unsent draft");
    const originalURL = page.url();
    const resumeCount = received.filter((message) => message.method === "thread/resume").length;
    const pinStyle = (id) => pin(page, id).evaluate((button) => ({
      opacity: getComputedStyle(button).opacity, pointerEvents: getComputedStyle(button).pointerEvents,
    }));
    await page.mouse.move(800, 400);
    assert.deepEqual(await pinStyle("old"), { opacity: "0", pointerEvents: "none" });
    await row(page, "old").hover();
    assert.deepEqual(await pinStyle("old"), { opacity: "1", pointerEvents: "auto" });
    await row(page, "middle").hover();
    assert.deepEqual(await pinStyle("old"), { opacity: "0", pointerEvents: "none" });
    await page.mouse.move(800, 400);
    await row(page, "old").focus();
    await page.keyboard.press("Tab");
    assert.equal(await pin(page, "old").evaluate((button) => button === document.activeElement), true);
    assert.deepEqual(await pinStyle("old"), { opacity: "1", pointerEvents: "auto" });
    await page.keyboard.press("Enter");
    await expectOrder(page, ["old", "recent", "middle"]);
    assert.equal(await pin(page, "old").getAttribute("aria-pressed"), "true");
    assert.equal(await pin(page, "old").evaluate((button) => button === document.activeElement), true);
    await page.keyboard.press("Space");
    await expectOrder(page, ["recent", "middle", "old"]);
    assert.equal(await pin(page, "old").getAttribute("aria-pressed"), "false");
    await clickPin(page, "old");
    await clickPin(page, "middle");
    await expectOrder(page, ["middle", "old", "recent"]);
    assert.equal(await row(page, "middle").getAttribute("aria-busy"), "true");
    assert.equal(await row(page, "recent").getAttribute("aria-current"), "page");
    assert.equal(page.url(), originalURL);
    assert.equal(await page.locator("#prompt").inputValue(), "Keep this unsent draft");
    assert.equal(received.filter((message) => message.method === "thread/resume").length, resumeCount);

    await pin(page, "old").focus();
    threads.get("old").recencyAt = 1791331200;
    threads.get("old").name = "Research notes <and links> with a long conversation title";
    broadcast("thread/name/updated", { threadId: "old", name: threads.get("old").name });
    await expectOrder(page, ["old", "middle", "recent"]);
    assert.equal(await pin(page, "old").evaluate((button) => button === document.activeElement), true);
    assert.equal(await row(page, "old").locator("strong").textContent(), threads.get("old").name);
    await page.mouse.move(800, 400);
    assert.deepEqual(await pinStyle("old"), { opacity: "1", pointerEvents: "auto" });
    assert.deepEqual(await pinStyle("recent"), { opacity: "0", pointerEvents: "none" });
    await screenshot("desktop-sidebar-no-hover", page.locator("#sidebar"));
    await row(page, "recent").hover();
    assert.deepEqual(await pinStyle("recent"), { opacity: "1", pointerEvents: "auto" });
    await screenshot("desktop-sidebar-hover-pin", page.locator("#sidebar"));
    await page.mouse.move(800, 400);
    await screenshot("desktop-pinned-conversations");

    fullList = false;
    holdOlderPage = true;
    await page.reload();
    await expectOrder(page, ["middle", "recent"]);
    await eventually(() => heldPage, "older history request");
    holdOlderPage = false;
    heldPage();
    await expectOrder(page, ["old", "middle", "recent"]);
    assert.equal(await pin(page, "old").getAttribute("aria-pressed"), "true");
    const beforeReconnect = connections;
    latestSocket.close();
    await pin(page, "old").waitFor();
    await eventually(() => connections > beforeReconnect, "reconnection");
    await expectOrder(page, ["old", "middle", "recent"]);

    const secondTab = await context.newPage();
    await secondTab.goto(base);
    await expectOrder(secondTab, ["old", "middle", "recent"]);
    await clickPin(secondTab, "old");
    await expectOrder(page, ["middle", "recent"]);
    await clickPin(page, "middle");
    await expectOrder(secondTab, ["recent", "middle"]);
    fullList = true;
    broadcast("thread/name/updated", { threadId: "recent", name: "Recent conversation" });
    await expectOrder(page, ["old", "recent", "middle"]);
    await clickPin(page, "middle");
    await clickPin(page, "old");
    await expectOrder(secondTab, ["old", "middle", "recent"]);
    await secondTab.close();

    await page.locator("#prompt").fill("Mobile draft stays here");
    for (const [width, theme] of [[390, "light"], [320, "dark"]]) {
      await page.setViewportSize({ width, height: 740 });
      await page.evaluate((value) => globalThis.CodexTheme.setPreference(value), theme);
      await page.locator("#menu").click();
      const button = pin(page, "recent");
      await row(page, "recent").hover();
      const bounds = await button.boundingBox();
      assert.ok(bounds.width >= 44 && bounds.height >= 44, "mobile pin targets must be at least 44px");
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, "pin controls must fit narrow screens");
      await button.click();
      await expectOrder(page, ["old", "recent", "middle"]);
      assert.equal(await page.locator("#sidebar").evaluate((node) => node.classList.contains("open")), true);
      assert.equal(page.url(), originalURL);
      assert.equal(await page.locator("#prompt").inputValue(), "Mobile draft stays here");
      await button.click();
      await expectOrder(page, ["old", "middle", "recent"]);
      await screenshot(`mobile-pinned-conversations-${width}-${theme}`);
      await page.locator("#close-sidebar").click();
    }

    threads.delete("old");
    broadcast("thread/archived", { threadId: "old" });
    await expectOrder(page, ["middle", "recent"]);
    const pins = await page.evaluate(() => JSON.parse(localStorage.getItem("codex-web-pinned-threads-v1")));
    assert.deepEqual(pins, ["middle"]);
    assert.ok(!received.some((message) => message.method?.startsWith("turn/")));
    assert.deepEqual(errors, []);

    const touchContext = await browser.newContext({
      viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: true, serviceWorkers: "block",
    });
    // Render with the existing fixture API to check actual touch media queries and taps.
    await touchContext.addInitScript(() => { globalThis.CODEX_WEB_TEST = true; });
    const touchPage = await touchContext.newPage();
    await touchPage.goto(base);
    await touchPage.evaluate(() => {
      const app = globalThis.CodexWebTest;
      app.initializeSidebarLayout();
      app.renderThreads([{ id: "touch", name: "Touch conversation", recencyAt: 1791244800, status: { type: "idle" } }]);
      app.setSidebarOpen(true, false);
    });
    for (const width of [390, 320]) {
      await touchPage.setViewportSize({ width, height: 740 });
      const button = touchPage.locator(".thread-pin");
      assert.equal(await button.evaluate((node) => getComputedStyle(node).opacity), "1");
      assert.equal(await button.evaluate((node) => getComputedStyle(node).pointerEvents), "auto");
      await button.tap();
      assert.equal(await button.getAttribute("aria-pressed"), "true");
      await button.tap();
      assert.equal(await button.getAttribute("aria-pressed"), "false");
      assert.equal(await button.evaluate((node) => getComputedStyle(node).opacity), "1");
    }
    await touchContext.close();
    console.log("pins-browser=ok (hover, pointer hit testing, keyboard, touch, activity, drafts, reload, older pins, reconnect, tabs, archive, 390/320px)");
  } catch (error) {
    await screenshot("failure");
    throw error;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
