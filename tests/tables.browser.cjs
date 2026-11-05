"use strict";

// Exercise the actual chat, Markdown bundle and stream handlers. All backend
// traffic is synthetic, including when checking deployed assets on a live URL.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");
const root = path.resolve(__dirname, "../static");
const artifacts = process.env.ARTIFACT_DIR;
const source = [
  "Here are the options, with their benefits and limitations.", "",
  "| Option | Main benefit | Effort | Limitation | Cost | Score |",
  "| --- | --- | :---: | --- | ---: | --- |",
  "| Readable columns | Keeps words intact and makes comparisons easy to scan. | Small | Wide tables need horizontal scrolling on a phone. | $24.50 | 92 |",
  "| Expanded view | Gives larger comparisons more room on desktop. | Medium | Open a separate view to read the full comparison. | $150.00 | 85 |",
  "| Stacked cards | Makes descriptive entries comfortable to read on a phone. | Medium | Comparing the same field across several rows takes more effort. | $8.00 | 70 |",
].join("\n");
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, pathname === "/" ? "vendor/index.html" : pathname.replace(/^\/static\//, ""));
    if (!file.startsWith(root + path.sep)) throw new Error("Invalid path");
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" })[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});

async function main() {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = process.env.CODEX_WEB_BASE_URL || `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const errors = [], metrics = [], requests = [];
  let socket;
  const thread = { id: "table-fixture", name: "Readable chat tables", cwd: "/workspaces", model: "test-model", status: { type: "idle" }, turns: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true, reducedMotion: "reduce", serviceWorkers: "block" });
    page.setDefaultTimeout(7000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/config") return route.fulfill({ json: { defaultCwd: "/workspaces", workspaceRoot: "/workspaces", historyChunkBytes: 1000000, chatDefaults: {} } });
      if (pathname === "/api/pins") return route.fulfill({ json: { storeId: "table-fixture", revision: 0, threadIds: [] } });
      if (pathname === "/api/history") return route.fulfill({ contentType: "application/x-ndjson", headers: { "X-Codex-History-Cursor": "", "X-Codex-History-Reset": "0" }, body: [
        { turn: { id: "turn-table", status: "completed" } },
        { turnId: "turn-table", item: { id: "table-answer", type: "agentMessage", phase: "final_answer", text: source } },
      ].map(JSON.stringify).join("\n") + "\n" });
      errors.push(`Unexpected HTTP request: ${pathname}`);
      return route.abort();
    });
    await page.routeWebSocket("**/ws", ws => {
      socket = ws;
      ws.onMessage(raw => {
        const request = JSON.parse(raw);
        if (request.id == null) return;
        requests.push(request.method);
        let result = {};
        switch (request.method) {
          case "initialize": case "config/read": case "configRequirements/read": case "account/rateLimits/read": case "account/read": break;
          case "model/list": case "permissionProfile/list": result = { data: [] }; break;
          case "thread/list": result = { data: [thread] }; break;
          case "thread/resume": case "thread/read": result = { thread }; break;
          default: errors.push(`Unexpected RPC: ${request.method}`);
        }
        ws.send(JSON.stringify({ id: request.id, result }));
      });
    });
    await page.goto(`${base}/?thread=table-fixture`);
    await page.locator("#messages .chat-table").waitFor();
    const panel = page.locator("#messages .chat-table").first();
    const scroller = panel.locator(".table-scroll");
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const screenshot = async name => {
      if (!artifacts) return;
      await fs.mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: path.join(artifacts, name + ".png") });
    };
    for (const width of [1920, 1440, 1024, 768, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await frame();
      const measured = await panel.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const body = node.closest(".body").getBoundingClientRect();
        const messages = document.getElementById("messages");
        const scroll = node.querySelector(".table-scroll");
        return { viewport: innerWidth, panelWidth: rect.width, proseWidth: body.width,
          left: rect.left, right: rect.right, messageLeft: messages.getBoundingClientRect().left,
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          chatOverflow: messages.scrollWidth > messages.clientWidth,
          tableOverflow: scroll.scrollWidth > scroll.clientWidth,
          widths: [...node.querySelector("tr").cells].map(cell => cell.getBoundingClientRect().width),
          fontSize: getComputedStyle(node.querySelector("td")).fontSize };
      });
      metrics.push(measured);
      assert.equal(measured.pageOverflow, false, JSON.stringify(measured));
      assert.equal(measured.chatOverflow, false, JSON.stringify(measured));
      assert.ok(measured.left >= measured.messageLeft, JSON.stringify(measured));
      assert.ok(measured.right <= width, JSON.stringify(measured));
      assert.ok(measured.widths[1] > 200, "Prose columns must keep a useful reading width");
      assert.equal(measured.fontSize, "16px", "Table text must not shrink to fit");
      if (width >= 1440) assert.ok(measured.panelWidth > measured.proseWidth + 150, "Wide tables use the available chat width");
      if (width <= 390) {
        assert.ok(measured.widths.every(value => value <= width - 40), "Individual cells reflow within the phone viewport");
        assert.equal(measured.tableOverflow, true);
        assert.equal(await panel.locator(".table-scroll-hint").isVisible(), true);
        assert.equal(await scroller.getAttribute("tabindex"), "0");
      }
      if ([1440, 390].includes(width)) await screenshot(`tables-${width}-light`);
    }
    await page.evaluate(() => document.documentElement.dataset.theme = "dark");
    await screenshot("tables-320-dark");
    assert.equal(await panel.locator("tbody td").nth(4).evaluate(el => getComputedStyle(el).textAlign), "right");
    assert.equal(await panel.locator("tbody td").nth(5).evaluate(el => getComputedStyle(el).textAlign), "end");
    assert.equal(await panel.locator("th").nth(2).evaluate(el => getComputedStyle(el).textAlign), "center");
    assert.equal(await panel.locator('th:not([scope="col"])').count(), 0);

    await scroller.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector("#messages .table-scroll").scrollLeft > 0);
    await page.waitForTimeout(250); // Let the browser finish its native key-scroll animation.
    await scroller.evaluate(el => { el.scrollLeft = 200; });
    await frame();
    assert.equal(await panel.locator(".table-viewport").evaluate(el => el.classList.contains("has-start")), true);
    socket.send(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: "turn-table", itemId: "table-answer", delta: "\n| Streaming update | Additional rows stay readable as the answer arrives. | Small | Keeps the horizontal reading position. | $12.00 | 95 |" } }));
    await page.getByRole("cell", { name: "Streaming update", exact: true }).waitFor();
    assert.equal(await scroller.evaluate(el => el.scrollLeft), 200, "Streamed content preserves horizontal position");
    assert.equal(await scroller.evaluate(el => el === document.activeElement), true, "Streamed content preserves keyboard focus");

    const position = await page.locator("#messages").evaluate(el => el.scrollTop);
    await panel.getByRole("button", { name: "Expand table" }).click();
    const dialog = page.getByRole("dialog", { name: "Expanded table" });
    await dialog.waitFor();
    assert.equal(await dialog.locator(".table-scroll").evaluate(el => el.scrollLeft), 200);
    await screenshot("expanded-320-dark");
    socket.send(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: "turn-table", itemId: "table-answer", delta: "\n| Expanded update | New content appears in the expanded table too. | Small | The reader stays in the expanded view. | $10.00 | 96 |" } }));
    await dialog.getByRole("cell", { name: "Expanded update", exact: true }).waitFor();
    assert.equal(await dialog.locator(".table-scroll").evaluate(el => el.scrollLeft), 200);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector("#messages .table-expand") === document.activeElement);
    assert.equal(await panel.locator(".table-expand").evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator("#messages").evaluate(el => el.scrollTop), position);

    // Long prose, links, code, empty cells, narrow tables, and maths.
    await page.evaluate(() => {
      const node = document.createElement("article");
      node.className = "message agent";
      node.id = "table-cases";
      const body = document.createElement("div");
      body.className = "body";
      node.append(body);
      document.getElementById("messages").append(node);
      const token = "a".repeat(160);
      CodexMarkdown.renderInto(body, [
        "| Key | Value |", "| --- | --- |", "| A | 1 |", "| B | 2 |", "",
        "| Description | Path | URL | Formula |", "| --- | --- | --- | --- |",
        `| ${"A long explanation. ".repeat(25)} | \u0060/workspaces/${token}.py\u0060 | [${token}](https://example.com/) | $x^2$ |`,
        String.raw`| | | | $\frac{xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx}{y}$ |`, "",
        "| Label | Notes |", "| --- | --- |", ...Array.from({ length: 45 }, (_, index) => `| Row ${index} | A row of the longer table. |`),
      ].join("\n"));
    });
    await page.locator("#table-cases .katex").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await frame();
    const cases = page.locator("#table-cases .chat-table");
    assert.equal(await cases.count(), 3);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await frame();
      const size = await cases.nth(0).evaluate(panel => ({
        prose: panel.closest(".body").getBoundingClientRect().width,
        panel: panel.getBoundingClientRect().width,
        viewport: panel.querySelector(".table-scroll").clientWidth,
        table: panel.querySelector("table").getBoundingClientRect().width,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
      }));
      assert.ok(Math.abs(size.panel - size.prose) <= 1,
        `Short tables fill the message width at ${width}px: ${JSON.stringify(size)}`);
      assert.ok(Math.abs(size.table - size.viewport) <= 1,
        `Cells fill the table panel at ${width}px: ${JSON.stringify(size)}`);
      assert.equal(size.pageOverflow, false);
    }
    assert.equal(await cases.nth(0).locator(".table-scroll-hint").isVisible(), false, "Small tables should fit without scroll hints");
    assert.equal(await cases.nth(1).locator("tbody td").evaluateAll(cells => cells.every(cell => cell.scrollWidth <= cell.clientWidth + 1)), true, "Long URLs and code must stay within their cells");
    assert.equal(await cases.nth(1).locator("a").getAttribute("target"), "_blank");
    assert.equal(await cases.nth(1).locator(".katex").last().getAttribute("tabindex"), "0", "Long formulae can be scrolled with the keyboard");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => document.documentElement.dataset.theme = "light");
    await cases.nth(2).getByRole("button", { name: "Expand table" }).click();
    await dialog.waitFor();
    const expandedScroll = dialog.locator(".table-scroll");
    await expandedScroll.evaluate(el => { el.scrollTop = 250; });
    await frame();
    assert.equal(await expandedScroll.getAttribute("tabindex"), "0", "A vertically scrolling table is keyboard accessible");
    const sticky = await expandedScroll.evaluate(el => ({ viewport: el.getBoundingClientRect().top, header: el.querySelector("th").getBoundingClientRect().top }));
    assert.ok(Math.abs(sticky.viewport - sticky.header) <= 1, JSON.stringify(sticky));
    await screenshot("expanded-1440-light");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.locator("#messages").evaluate(el => { el.scrollTop = 0; });
    await panel.getByRole("button", { name: "Expand table" }).click();
    await screenshot("comparison-expanded-1440-light");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    // An expanding answer must not scroll the background chat away while the
    // reader is in the dialog, even if the chat was following the live answer.
    await page.reload();
    await panel.waitFor();
    await panel.getByRole("button", { name: "Expand table" }).click();
    const backgroundTop = await page.locator("#messages").evaluate(el => el.scrollTop);
    socket.send(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: "turn-table", itemId: "table-answer",
      delta: Array.from({ length: 30 }, (_, index) => `\n| Live row ${index} | More live content while the reader is in the expanded view. | Small | Keep the original chat position. | $1.00 | 1 |`).join("") } }));
    await dialog.getByRole("cell", { name: "Live row 29", exact: true }).waitFor();
    assert.equal(await page.locator("#messages").evaluate(el => el.scrollTop), backgroundTop, "Streaming must not move the background chat");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    assert.ok(requests.every(method => !["turn/start", "turn/steer", "thread/start"].includes(method)));
    const report = { metrics, keyboardScroll: true, streamingScrollAndFocus: true, expandedStreaming: true,
      escapeRestoresFocusAndPosition: true, explicitAlignment: true, numericAlignment: true,
      longTokensContained: true, math: true, stickyHeader: true, backgroundPositionDuringStream: true,
      shortTablesFillMessage: true, pageErrors: errors, realConversationRequests: 0 };
    if (artifacts) await fs.writeFile(path.join(artifacts, "browser.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
