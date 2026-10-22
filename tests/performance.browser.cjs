"use strict";

// Repeatable cold/warm navigation with the real server and a synthetic backend.
// The fixture adds 150 ms of backend work per RPC. Chromium also throttles the
// browser's HTTP and WebSocket traffic. This asset check counts HTTP bytes;
// list-loading.browser.cjs measures both transports with a larger sidebar.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");

async function main() {
  const child = spawn(process.env.PYTHON || "python", ["-u", path.join(__dirname, "performance_fixture.py")]);
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  let browser;
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
        isMobile: true, hasTouch: true, deviceScaleFactor: 3, serviceWorkers: "block" });
      for (const cache of ["cold", "warm"]) {
        const page = await context.newPage();
        page.setDefaultTimeout(60000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.addInitScript(() => {
          const observer = new MutationObserver(() => {
            if (!window.chatVisibleAt && document.querySelector("#messages .message .body")?.textContent.includes("Ready to work")) {
              window.chatVisibleAt = performance.now();
            }
          });
          observer.observe(document, { childList: true, subtree: true });
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150,
          downloadThroughput: 500000 / 8, uploadThroughput: 128000 / 8, connectionType: "cellular3g" });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        const scenario = process.env.PERF_SCENARIO || "plain";
        await page.goto(url + (scenario === "empty" ? "" : `?thread=${scenario}`), { waitUntil: "load" });
        await page.waitForFunction(() => !document.getElementById("settings-toggle").disabled);
        if (scenario !== "empty") await page.waitForFunction(() => window.chatVisibleAt);
        if (scenario === "math") {
          await page.locator(".katex").first().waitFor();
          await page.evaluate(() => document.fonts.ready);
        }
        await page.waitForTimeout(400);
        const metrics = await page.evaluate(() => ({
          firstContentfulPaintMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
          conversationVisibleMs: window.chatVisibleAt,
          domContentLoadedMs: performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd,
          resources: [...performance.getEntriesByType("navigation"), ...performance.getEntriesByType("resource")]
            .filter((entry) => !entry.name.endsWith("/ws"))
            .map((entry) => ({ path: new URL(entry.name).pathname, transferBytes: entry.transferSize,
              encodedBytes: entry.encodedBodySize, decodedBytes: entry.decodedBodySize, durationMs: entry.duration })),
        }));
        metrics.transferBytes = metrics.resources.reduce((total, entry) => total + entry.transferBytes, 0);
        assert.deepEqual(errors, []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (process.env.PERF_CHECK_BUDGET) {
          assert.ok(metrics.transferBytes < (cache === "cold" ? 100000 : 20000), JSON.stringify(metrics));
          assert.ok(!metrics.resources.some((entry) => /math[-.]|fonts\//.test(entry.path)), "Ordinary chats must not fetch maths assets");
        }
        runs.push({ run: run + 1, cache, scenario, ...metrics });
        if (process.env.ARTIFACT_DIR && run === 0 && cache === "cold") {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${scenario}-mobile.png`) });
        }
        await page.close();
      }
      await context.close();
    }
    const report = { downloadKbps: 500, uploadKbps: 128, latencyMs: 150, cpuSlowdown: 4,
      backendRpcDelayMs: 150, viewport: "390x844", backend: "synthetic", runs };
    if (process.env.ARTIFACT_DIR) await fs.writeFile(path.join(process.env.ARTIFACT_DIR, "performance.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(runs.map(({ resources, ...summary }) => summary), null, 2));
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
