"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");

async function main() {
  const fixture = spawn(process.env.PYTHON || "python3", [path.join(__dirname, "pins_fixture.py")],
    { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: fixture.stdout })[Symbol.asyncIterator]();
  const browser = await chromium.launch({ headless: true });
  try {
    const firstLine = await lines.next();
    assert.equal(firstLine.done, false, "fixture must start");
    const { url } = JSON.parse(firstLine.value);
    const errors = [];
    async function context(options = {}) {
      const ctx = await browser.newContext({ serviceWorkers: "block", ...options });
      ctx.setDefaultTimeout(10000);
      ctx.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
      return ctx;
    }
    const desktop = await context({ viewport: { width: 1280, height: 800 } });
    const mobile = await context({ viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true });
    const first = await desktop.newPage();
    const second = await mobile.newPage();
    async function expectPin(page, id, value) {
      await page.waitForFunction(({ id, value }) => {
        const pin = document.querySelector(`#threads a[href="/?thread=${id}"]`)?.parentElement.querySelector(".thread-pin");
        return pin && !pin.disabled && pin.getAttribute("aria-pressed") === String(value)
          && pin.getAttribute("aria-busy") === "false";
      }, { id, value });
    }
    async function clickPin(page, id) {
      const row = page.locator(`#threads a[href="/?thread=${id}"]`);
      await row.hover();
      await row.locator("..").locator(".thread-pin").click();
    }
    await first.goto(url);
    await expectPin(first, "old", false);
    await first.evaluate(() => localStorage.setItem("codex-web-pinned-threads-v1", '["old"]'));
    await first.reload();
    await expectPin(first, "old", true);
    assert.equal(await first.evaluate(() => localStorage.getItem("codex-web-pinned-threads-v1")), null);
    await second.goto(url);
    await expectPin(second, "old", true);
    assert.equal(await second.evaluate(() => localStorage.getItem("codex-web-pinned-threads-v1")), null,
      "fresh browser receives server pins without a local pin list");
    await second.locator("#menu").click();
    await clickPin(second, "middle");
    await expectPin(first, "middle", true);
    await expectPin(second, "middle", true);
    await clickPin(first, "old");
    await expectPin(first, "old", false);
    await expectPin(second, "old", false);

    // A third device still has pre-upgrade pins. Its import must not undo unpin.
    const stale = await context();
    const third = await stale.newPage();
    await third.goto(url);
    await expectPin(third, "old", false);
    await third.evaluate(() => localStorage.setItem("codex-web-pinned-threads-v1", '["old","recent"]'));
    await third.reload();
    await expectPin(third, "old", false);
    await expectPin(first, "recent", true);
    await expectPin(second, "recent", true);

    // Simulate a rejected write, then a lost response after the database commit.
    await first.route("**/api/pins", (route) => route.request().method() === "PUT"
      ? route.fulfill({ status: 503, json: { error: "Unavailable" } }) : route.continue());
    await clickPin(first, "middle");
    await first.waitForFunction(() => document.getElementById("notice").textContent.includes("Unable to save pinned chat"));
    await expectPin(first, "middle", true);
    await expectPin(second, "middle", true);
    await first.unroute("**/api/pins");
    await first.route("**/api/pins", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      await route.fetch();
      await route.abort();
    });
    await clickPin(first, "old");
    await expectPin(second, "old", true);
    await expectPin(first, "old", true);
    await first.unroute("**/api/pins");

    await first.evaluate(() => localStorage.clear());
    await first.reload();
    await expectPin(first, "old", true);
    fixture.stdin.write("restart\n");
    assert.equal(JSON.parse((await lines.next()).value).restarted, true);
    await first.reload();
    await second.reload();
    for (const page of [first, second]) {
      await expectPin(page, "old", true);
      await expectPin(page, "middle", true);
      await expectPin(page, "recent", true);
    }
    fixture.stdin.write("archive\n");
    await first.waitForFunction(() => !document.querySelector('#threads a[href="/?thread=old"]'));
    const saved = await (await desktop.request.get(`${url}api/pins`)).json();
    assert.deepEqual(saved.threadIds, ["middle", "recent"]);
    assert.deepEqual(errors, []);
    console.log("server-pins-browser=ok (separate desktop/mobile storage, migration, stale-device unpins, broadcast, failures, cleared storage, server restart, archive)");
  } finally {
    await browser.close();
    fixture.stdin.write("stop\n");
    await new Promise((resolve) => fixture.once("exit", resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
