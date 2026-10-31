"use strict";

// The real page runs against a simulated backend. No real account is changed.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");
const root = path.resolve(__dirname, "../static");
const artifacts = process.env.ARTIFACT_DIR;
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, pathname === "/" ? "index.html" : pathname.replace(/^\/static\//, ""));
    if (!file.startsWith(root + path.sep)) throw new Error("Invalid path");
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], calls = [], sockets = new Set();
    let email = "previous@example.com", authorized = false, loginId = null, counter = 0;
    const notify = (method, params) => {
      for (const ws of sockets) ws.send(JSON.stringify({ method, params }));
    };
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/api/config", (route) => route.fulfill({ json: {
      defaultCwd: "/workspaces", workspaceRoot: "/workspaces", showToolActivity: false,
      chatDefaults: { model: "test-model", effort: "medium" },
    } }));
    await context.routeWebSocket("**/ws", (ws) => {
      sockets.add(ws);
      ws.onClose(() => sockets.delete(ws));
      ws.onMessage((raw) => {
        const message = JSON.parse(raw);
        calls.push(message);
        if (message.id === undefined) return;
        let result = {};
        switch (message.method) {
          case "account/read": result = { account: { type: "chatgpt", email, planType: "pro" }, requiresOpenaiAuth: true }; break;
          case "account/rateLimits/read":
            if (!authorized) {
              ws.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Your access token could not be refreshed. Please sign in again." } }));
              return;
            }
            result = { rateLimits: { primary: { usedPercent: 1 } } }; break;
          case "account/login/start":
            loginId = `login-${++counter}`;
            result = { type: "chatgptDeviceCode", loginId, verificationUrl: "https://auth.openai.com/codex/device", userCode: "DEMO-CODE1" };
            break;
          case "account/login/cancel":
            assert.equal(message.params.loginId, loginId); loginId = null; result = { status: "canceled" }; break;
          case "model/list": result = { data: [{ id: "test-model", model: "test-model", displayName: "Test model", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }; break;
          case "thread/list": result = { data: [] }; break;
          case "thread/start": result = { thread: { id: "test-chat", cwd: "/workspaces", turns: [], status: { type: "idle" } } }; break;
          case "turn/start": result = { turn: { id: "test-turn", status: "completed", items: [] } }; break;
          case "initialize": case "config/read": case "configRequirements/read": case "permissionProfile/list": break;
          default: throw new Error(`Unexpected request: ${message.method}`);
        }
        ws.send(JSON.stringify({ id: message.id, result }));
      });
    });
    await page.goto(process.env.CODEX_WEB_BASE_URL || `http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
    await page.locator("#account-banner").waitFor({ state: "visible" });
    await page.locator("#prompt").fill("Keep my draft while signing in");
    await page.locator("#account-banner-open").click();
    await page.locator("#account-sign-in").click();
    await page.locator("#account-code").filter({ hasText: "DEMO-CODE1" }).waitFor();
    assert.equal(await page.locator("#account-login-link").getAttribute("href"), "https://auth.openai.com/codex/device");
    assert.equal(calls.some((call) => /^(thread|turn)\/start$/.test(call.method)), false);
    if (artifacts) await fs.mkdir(artifacts, { recursive: true });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.locator("#account-code").isVisible());
      assert.ok(await page.locator("#account-login-link").isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await page.locator("#preferences-dialog").evaluate((el) => el.scrollWidth <= el.clientWidth));
      if (artifacts) await page.screenshot({ path: path.join(artifacts, `sign-in-${width}.png`) });
    }
    await page.emulateMedia({ colorScheme: "dark" });
    if (artifacts) await page.screenshot({ path: path.join(artifacts, "sign-in-dark-320.png") });
    await page.locator("#account-cancel").click();
    await page.locator("#account-login").waitFor({ state: "hidden" });
    await page.locator("#account-sign-in").click();
    await page.locator("#account-login").waitFor({ state: "visible" });
    const failedId = loginId;
    notify("account/login/completed", { loginId: failedId, success: false, error: "The code expired. Please try again." });
    await page.locator("#account-login").waitFor({ state: "hidden" });
    assert.match(await page.locator("#account-message").textContent(), /expired/);
    await page.locator("#account-sign-in").click();
    await page.locator("#account-login").waitFor({ state: "visible" });
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#account-banner-open").click();
    assert.equal(await page.locator("#account-code").textContent(), "DEMO-CODE1");
    // Another browser also receives the account change, with no copied tokens.
    const other = await context.newPage();
    other.on("pageerror", (error) => errors.push(error.message));
    await other.goto(page.url(), { waitUntil: "networkidle" });
    await other.locator("#account-banner").waitFor({ state: "visible" });
    email = "replacement@example.com"; authorized = true;
    notify("account/login/completed", { loginId, success: true });
    notify("account/updated", { authMode: "chatgpt", planType: "pro" });
    await page.waitForFunction(() => document.querySelector("#account-status").textContent.includes("replacement@example.com"));
    await other.waitForFunction(() => document.querySelector("#account-status").textContent.includes("replacement@example.com"));
    assert.equal(await page.locator("#account-login").isVisible(), false);
    assert.equal(await page.locator("#account-banner").isVisible(), false);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("codex-web-device-login-v1")), null);
    assert.match(await page.locator("#account-message").textContent(), /Sign-in complete/);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, "signed-in-320.png") });
    await page.locator("#preferences-close").click();
    await page.locator("#prompt").fill("Synthetic request after sign-in");
    await page.locator("#send").click();
    await page.waitForFunction(() => document.querySelector("#prompt").value === "");
    assert.ok(calls.some((call) => call.method === "turn/start"));
    assert.ok(!calls.some((call) => call.method === "account/logout"));
    assert.deepEqual(errors, []);
    const report = { expiredAuthRecovery: true, cancellation: true, retryAfterExpiry: true, pendingLoginReload: true, sharedAccountUpdate: true, sendAfterLogin: true, widths: [1280, 390, 320], pageErrors: errors, realAuthenticationChanges: 0 };
    if (artifacts) await fs.writeFile(path.join(artifacts, "browser.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
