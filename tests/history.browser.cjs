"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");

async function main() {
  const child = spawn(process.env.PYTHON || "python", ["-u", path.join(__dirname, "history_fixture.py")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  let browser;
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Fixture did not start: ${stderr}`)), 10000);
      readline.createInterface({ input: child.stdout }).once("line", (line) => {
        clearTimeout(timeout);
        resolve(JSON.parse(line).url);
      });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(stderr)); });
    });
    browser = await chromium.launch({ headless: true });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
      const page = await browser.newPage({ viewport, serviceWorkers: "block" });
      page.setDefaultTimeout(8000);
      const errors = [];
      const downloads = [];
      const bodies = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        if (new URL(response.url()).pathname !== "/api/history") return;
        downloads.push(response);
        bodies.push(response.body().then((body) => {
          assert.ok(body.length <= 4096, `Chunk exceeded byte limit: ${body.length}`);
        }).catch((error) => errors.push(error.message)));
      });
      await page.goto(`${url}?thread=a`);
      await page.locator("#thread-title").filter({ hasText: "History a" }).waitFor();
      await page.locator(".message").first().waitFor();
      await page.waitForTimeout(100);
      assert.equal(downloads.length, 1, "Initial selection must fetch one chunk");
      const initialCount = await page.locator(".message").count();
      assert.ok(initialCount > 0 && initialCount < 48);
      assert.match(await page.locator(".message").last().innerText(), /Message 5-7/);

      // A real upward wheel scroll reaches the unloaded boundary. Hold the
      // response so the original top message's screen position can be checked.
      let release;
      await page.route("**/api/history", async (route) => {
        if (!release) await new Promise((resolve) => { release = resolve; });
        await route.continue();
      });
      await page.locator("#messages").hover();
      await page.mouse.wheel(0, -10000);
      await page.waitForFunction(() => document.querySelector(".history-control")?.disabled);
      const anchor = await page.locator(".message").first().evaluate((node) => ({
        text: node.querySelector(".body")?.textContent || node.textContent,
        top: node.getBoundingClientRect().top,
      }));
      if (process.env.ARTIFACT_DIR) {
        await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `history-loading-${viewport.width}.png`) });
      }
      release();
      await page.waitForFunction((count) => document.querySelectorAll(".message").length > count, initialCount);
      const anchorTop = await page.locator(".message").evaluateAll((nodes, text) => {
        const node = nodes.find((node) => (node.querySelector(".body")?.textContent || node.textContent) === text);
        return node.getBoundingClientRect().top;
      }, anchor.text);
      assert.ok(Math.abs(anchorTop - anchor.top) < 3, `Reading position moved ${anchorTop - anchor.top}px`);
      await page.unroute("**/api/history");

      // Each click is one additional chunk, including a record larger than
      // the budget. Finish the history and check exact order and duplicates.
      for (let i = 0; i < 50 && await page.locator(".history-control").count(); i += 1) {
        const before = downloads.length;
        await page.locator(".history-control").click();
        await page.waitForFunction(() => !document.querySelector(".history-control")?.disabled);
        assert.equal(downloads.length, before + 1, "One action must fetch one chunk");
      }
      assert.equal(await page.locator(".history-control").count(), 0);
      assert.equal(await page.locator(".message").count(), 48);
      const labels = await page.locator(".message").allTextContents();
      const order = labels.map((text) => text.match(/Message (\d+-\d+)/)[1]);
      assert.deepEqual(order, Array.from({ length: 48 }, (_, i) => `${Math.floor(i / 8)}-${i % 8}`));
      assert.equal(labels.find((text) => text.includes("Message 2-4")).match(/🦜/gu).length, 2500);
      assert.equal(await page.locator(".message-timestamp[datetime]").count(), 48);
      await page.locator("#prompt").fill("Preserve this draft");
      if (viewport.width < 600) await page.locator("#menu").click();
      await page.locator('#threads a[href="/?thread=b"]').click();
      await page.locator("#thread-title").filter({ hasText: "History b" }).waitFor();
      assert.equal(await page.locator(".message").count(), initialCount);
      if (viewport.width < 600) await page.locator("#menu").click();
      const returning = page.waitForResponse((response) => (
        new URL(response.url()).pathname === "/api/history"
        && response.request().postDataJSON().threadId === "a"
      ));
      await page.locator('#threads a[href="/?thread=a"]').click();
      await (await returning).finished();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.locator("#thread-title").filter({ hasText: "History a" }).waitFor();
      assert.equal(await page.locator("#prompt").inputValue(), "Preserve this draft");

      if (process.env.ARTIFACT_DIR) {
        await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `history-${viewport.width}.png`) });
      }
      await Promise.all(bodies);
      assert.deepEqual(errors, []);
      console.log(`history-browser=${viewport.width} ok; downloads=${downloads.length}; initialMessages=${initialCount}`);
      await page.close();
    }
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
