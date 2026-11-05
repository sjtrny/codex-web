"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");

async function main() {
  const child = spawn(process.env.PYTHON || "python", ["-u", path.join(__dirname, "performance_fixture.py")], {
    env: { ...process.env, PERF_RPC_DELAY: "0.02", PERF_SETTINGS_DELAY: "3" },
  });
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
    const errors = [];
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    page.on("pageerror", (error) => errors.push(error.message));
    const requests = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.goto(url + "?thread=plain");
    await page.locator(".message .body strong").waitFor({ timeout: 2000 });
    assert.match(await page.locator("#model-catalog-status").textContent(), /Refreshing models/,
      "Conversation must display while settings are still loading");
    assert.ok(!requests.some((name) => /math[-.]|fonts\//.test(name)));

    // A delayed optional script must not block navigation or normal Markdown.
    let releaseMath;
    await page.route("**/static/vendor/math-*.js", async (route) => {
      await new Promise((resolve) => { releaseMath = resolve; });
      await route.continue();
    });
    await page.evaluate(() => {
      for (const [id, source] of [["delayed-math", String.raw`Inline $x^2$ and \(y^2\).

\[E=mc^2\]

<img src=x onerror="window.injected=true">

\(\href{javascript:alert(1)}{unsafe}\)`], ["stale-math", "$z^2$"]]) {
        const node = document.createElement("div");
        node.id = id;
        node.append(CodexMarkdown.render(source));
        document.getElementById("messages").append(node);
      }
      document.getElementById("stale-math").replaceChildren(CodexMarkdown.render("**New streamed content**"));
    });
    await page.waitForFunction(() => document.querySelector('script[src*="/math-"]'));
    assert.equal(requests.filter((name) => /\/math-.*\.js$/.test(name)).length, 1);
    assert.match(await page.locator("#delayed-math").textContent(), /E=mc\^2/);
    await page.locator("#menu").click();
    assert.equal(await page.locator("#menu").getAttribute("aria-expanded"), "true");
    releaseMath();
    await page.locator("#delayed-math .katex-display").waitFor();
    assert.ok(await page.locator("#delayed-math .katex").count() >= 3);
    assert.equal((await page.locator("#stale-math").textContent()).trim(), "New streamed content");
    assert.equal(await page.locator("#stale-math .katex").count(), 0);
    assert.equal(await page.locator('#delayed-math [onerror], #delayed-math a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
    assert.equal(requests.filter((name) => /\/math-.*\.css$/.test(name)).length, 1);

    // Markdown images keep their links but offscreen previews don't all download.
    await page.evaluate(() => {
      const fragment = CodexMarkdown.render("![Preview](/workspaces/preview.png)");
      const image = fragment.querySelector("img");
      window.imageAttributes = { loading: image.loading, decoding: image.decoding,
        href: image.parentElement.getAttribute("href") };
    });
    assert.deepEqual(await page.evaluate(() => window.imageAttributes), {
      loading: "lazy", decoding: "async", href: "/api/files?path=%2Fworkspaces%2Fpreview.png",
    });

    // A failed download keeps readable text and the next render retries it.
    const retry = await browser.newPage({ serviceWorkers: "block" });
    retry.on("pageerror", (error) => errors.push(error.message));
    let attempts = 0;
    await retry.route("**/static/vendor/math-*.js", (route) => ++attempts === 1 ? route.abort() : route.continue());
    await retry.goto(url);
    const renderRetry = () => retry.evaluate(() => {
      const node = document.getElementById("retry-math") || document.createElement("div");
      node.id = "retry-math";
      node.replaceChildren(CodexMarkdown.render("Retry\n\n$\nx^2\n$\n"));
      document.getElementById("messages").append(node);
    });
    const failed = retry.waitForEvent("console", (message) => message.text().includes("Math rendering unavailable"));
    await renderRetry();
    await failed;
    assert.equal(await retry.locator("#retry-math").textContent(), "Retry\n\n$\nx^2\n$\n");
    await renderRetry();
    await retry.locator("#retry-math .katex").waitFor();
    assert.equal(attempts, 2);
    assert.deepEqual(errors, []);
    console.log("loading-browser=ok; slow settings, optional maths, single download, stale content, sanitization, retry, lazy images");
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
