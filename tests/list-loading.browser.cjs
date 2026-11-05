"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");

async function main() {
  const child = spawn(process.env.PYTHON || "python", ["-u", path.join(__dirname, "list_loading_fixture.py")]);
  let stderr = "", browser;
  child.stderr.on("data", (data) => { stderr += data; });
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(stderr || "Fixture startup timed out")), 10000);
      readline.createInterface({ input: child.stdout }).once("line", (line) => {
        clearTimeout(timeout); resolve(JSON.parse(line).url);
      });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(stderr)); });
    });
    browser = await chromium.launch({ headless: true });
    const runs = [];
    for (let run = 0; run < Number(process.env.PERF_RUNS || 3); run++) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 },
        isMobile: true, hasTouch: true, serviceWorkers: "block" });
      for (const cache of ["cold", "warm"]) {
        const page = await context.newPage();
        page.setDefaultTimeout(30000);
        const errors = [], rpcMethods = new Map();
        let wsBytes = 0, listWsBytes = 0, listRpcCount = 0, listReplies = 0, listHttpCount = 0;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (new URL(request.url()).pathname === "/api/threads") listHttpCount++;
        });
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            const message = JSON.parse(payload.toString());
            if (message.id != null) rpcMethods.set(message.id, message.method);
            if (message.method === "thread/list") listRpcCount++;
          });
          socket.on("framereceived", ({ payload }) => {
            const raw = payload.toString();
            wsBytes += Buffer.byteLength(raw);
            const message = JSON.parse(raw);
            if (rpcMethods.get(message.id) === "thread/list") {
              listWsBytes += Buffer.byteLength(raw);
              listReplies++;
            }
          });
        });
        await page.addInitScript(() => {
          new MutationObserver(() => {
            if (!window.listVisibleAt && document.querySelector("#threads a")) window.listVisibleAt = performance.now();
            if (!window.chatVisibleAt && document.querySelector("#messages .message .body")?.textContent.includes("Ready to work")) {
              window.chatVisibleAt = performance.now();
            }
          }).observe(document, { childList: true, subtree: true });
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150,
          downloadThroughput: 500000 / 8, uploadThroughput: 128000 / 8, connectionType: "cellular3g" });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await page.goto(url + "?thread=chat-0000");
        await page.waitForFunction(() => window.listVisibleAt && window.chatVisibleAt);
        await page.waitForTimeout(2000); // Include redundant refreshes after opening the chat.
        const deadline = Date.now() + 15000;
        while (listReplies < listRpcCount && Date.now() < deadline) await page.waitForTimeout(50);
        assert.equal(listReplies, listRpcCount, "Measure all requested list responses, including duplicate downloads");
        const metrics = await page.evaluate(() => ({
          listVisibleMs: window.listVisibleAt, conversationVisibleMs: window.chatVisibleAt,
          rows: document.querySelectorAll("#threads a").length,
          resources: [...performance.getEntriesByType("navigation"), ...performance.getEntriesByType("resource")]
            .filter((entry) => !entry.name.endsWith("/ws"))
            .map((entry) => ({ path: new URL(entry.name).pathname, transferBytes: entry.transferSize,
              encodedBytes: entry.encodedBodySize, decodedBytes: entry.decodedBodySize, durationMs: entry.duration })),
        }));
        metrics.httpBytes = metrics.resources.reduce((total, entry) => total + entry.transferBytes, 0);
        metrics.listBytes = listWsBytes + metrics.resources.filter((entry) => entry.path === "/api/threads")
          .reduce((total, entry) => total + entry.encodedBytes, 0);
        assert.deepEqual(errors, []);
        assert.equal(metrics.rows, 50);
        if (process.env.PERF_CHECK_BUDGET) {
          assert.equal(listRpcCount, 0);
          assert.equal(listHttpCount, 1);
          assert.ok(metrics.listBytes < 10000, JSON.stringify(metrics));
          assert.ok(metrics.listVisibleMs < metrics.conversationVisibleMs);
        }
        const result = { run: run + 1, cache, ...metrics, wsBytes, listRpcCount, listHttpCount };
        runs.push(result);
        const { resources, ...summary } = result;
        console.log(JSON.stringify(summary));
        if (process.env.ARTIFACT_DIR && run === 0 && cache === "cold") {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          await page.locator("#menu").click();
          await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, "sidebar-mobile.png"), animations: "disabled" });
        }
        await page.close();
      }
      await context.close();
    }
    if (process.env.ARTIFACT_DIR) {
      await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.ARTIFACT_DIR, "list-loading.json"), JSON.stringify({
        downloadKbps: 500, latencyMs: 150, cpuSlowdown: 4,
        note: "Chromium throttles browser HTTP and WebSocket traffic. The synthetic backend adds 190 ms for thread/list and 1 ms for other RPCs. No additional simulated transport delay.", runs,
      }, null, 2) + "\n");
    }
    if (process.env.PERF_CHECK_BUDGET) {
      const isolated = await browser.newContext();
      let releaseInitialization, resumedThreadId;
      await isolated.routeWebSocket("**/ws", (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((raw) => {
          const message = JSON.parse(raw);
          if (message.method === "initialize") releaseInitialization = () => upstream.send(raw);
          else {
            if (message.method === "thread/resume") resumedThreadId = message.params.threadId;
            upstream.send(raw);
          }
        });
      });
      const page = await isolated.newPage();
      await page.goto(url);
      await page.waitForFunction(() => document.querySelectorAll("#threads a").length === 50);
      await page.locator('#threads a[href="/?thread=chat-0017"]').click();
      assert.match(page.url(), /thread=chat-0017/);
      assert.equal(resumedThreadId, undefined);
      releaseInitialization();
      await page.locator(".message .body").filter({ hasText: "Ready to work" }).waitFor();
      assert.equal(resumedThreadId, "chat-0017");
      await isolated.close();
      console.log("Sidebar loads and remembers a selection while the live connection is initializing: passed");

      const retry = await browser.newContext();
      let attempts = 0, releaseRetryInitialization;
      let sawInitialization;
      const initialized = new Promise((resolve) => { sawInitialization = resolve; });
      await retry.route("**/api/threads", (route) => ++attempts === 1
        ? route.fulfill({ status: 502, json: { error: "Temporary list failure" } }) : route.continue());
      await retry.routeWebSocket("**/ws", (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((raw) => {
          if (JSON.parse(raw).method === "initialize") {
            releaseRetryInitialization = () => upstream.send(raw);
            sawInitialization();
          } else upstream.send(raw);
        });
      });
      const retryPage = await retry.newPage();
      await retryPage.goto(url);
      await retryPage.locator("#notice").filter({ hasText: "Temporary list failure" }).waitFor();
      await initialized;
      releaseRetryInitialization();
      await retryPage.waitForFunction(() => document.querySelectorAll("#threads a").length === 50);
      assert.equal(attempts, 2);
      await retry.close();
      console.log("A failed early sidebar request is retried after connection: passed");
    }
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
