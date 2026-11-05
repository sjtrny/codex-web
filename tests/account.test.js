"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const html = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "../static/account.js"), "utf8");
const device = (id = "login-1") => ({
  type: "chatgptDeviceCode", loginId: id, userCode: "TEST-CODE1",
  verificationUrl: "https://auth.openai.com/codex/device",
});
const signedOut = { account: null, requiresOpenaiAuth: true };
const signedIn = (email) => ({ account: { type: "chatgpt", email, planType: "pro" }, requiresOpenaiAuth: true });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, storage) {
  const dom = new JSDOM(html, { url: "https://codex.example/", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.eval(source);
  const calls = [];
  let reply = (method) => method === "account/read" ? signedOut : {};
  let completed = 0, opened = 0;
  const controls = window.CodexAccount.create({
    rpc: async (method, params) => { calls.push({ method, params }); return reply(method, params); },
    openSettings: () => { opened += 1; },
    onSignedIn: () => { completed += 1; },
    ...(storage ? { storage } : {}),
  });
  return {
    window, controls, calls, el: (name) => window.document.getElementById(`account-${name}`),
    replyWith(fn) { reply = fn; }, get completed() { return completed; }, get opened() { return opened; },
    async connect() { controls.connectionChanged(true); await tick(); },
  };
}

test("signed-out recovery uses account RPCs and never needs inference or logout", async (t) => {
  const app = fixture(t);
  await app.connect();
  assert.equal(app.el("banner").hidden, false);
  app.el("banner-open").click();
  assert.equal(app.opened, 1);
  app.replyWith((method) => method === "account/login/start" ? device() : signedOut);
  await app.controls.start();
  assert.equal(app.el("code").textContent, "TEST-CODE1");
  assert.equal(app.el("login-link").href, device().verificationUrl);
  assert.equal(app.el("sign-in").disabled, true);
  assert.deepEqual(app.calls.map((call) => call.method), ["account/read", "account/login/start"]);
  assert.equal(app.calls[1].params.type, "chatgptDeviceCode");
  assert.equal(app.window.localStorage.length, 0);
  assert.equal(app.window.sessionStorage.length, 1);
  app.replyWith((method) => method === "account/read" ? signedIn("replacement@example.com") : {});
  app.controls.notification("account/login/completed", { loginId: "login-1", success: true });
  app.controls.notification("account/updated", { authMode: "chatgpt" });
  await tick();
  assert.match(app.el("status").textContent, /Connected as replacement@example.com/);
  assert.match(app.el("message").textContent, /Sign-in complete/);
  assert.equal(app.el("banner").hidden, true);
  assert.equal(app.window.sessionStorage.length, 0);
  assert.ok(app.completed >= 1);
  assert.ok(app.calls.every((call) => call.method.startsWith("account/") && call.method !== "account/logout"));
});

test("cached account identity cannot hide a failed token refresh", async (t) => {
  const app = fixture(t);
  app.replyWith((method) => {
    if (method === "account/read") return signedIn("old@example.com");
    throw new Error("Your access token could not be refreshed. Please sign in again.");
  });
  await app.connect();
  assert.equal(app.el("status").textContent, "Sign-in required");
  assert.equal(app.el("banner").hidden, false);
  assert.equal(app.el("sign-in").disabled, false);
  assert.equal(app.completed, 0);
});

test("cancel only targets this pending login and preserves the current account", async (t) => {
  const app = fixture(t);
  app.replyWith((method) => method === "account/read" ? signedIn("old@example.com")
    : method === "account/login/start" ? device() : {});
  await app.connect();
  assert.equal(app.el("sign-in").textContent, "Switch account");
  await app.controls.start();
  await app.controls.cancel();
  assert.equal(app.calls.at(-1).method, "account/login/cancel");
  assert.equal(app.calls.at(-1).params.loginId, "login-1");
  assert.equal(app.el("login").hidden, true);
  assert.match(app.el("status").textContent, /old@example.com/);
  assert.equal(app.window.sessionStorage.length, 0);
});

test("failure and unsupported device login leave a retry available", async (t) => {
  const app = fixture(t);
  await app.connect();
  app.replyWith(() => device());
  await app.controls.start();
  app.controls.notification("account/login/completed", { loginId: "another-login", success: false });
  assert.equal(app.el("login").hidden, false);
  app.controls.notification("account/login/completed", { loginId: "login-1", success: false, error: "Device code expired" });
  assert.equal(app.el("login").hidden, true);
  assert.match(app.el("message").textContent, /expired/);
  app.replyWith(() => { throw new Error("unknown variant chatgptDeviceCode"); });
  await app.controls.start();
  assert.match(app.el("message").textContent, /Update Codex/);
  assert.equal(app.el("sign-in").disabled, false);
});

test("completion before the login response is not lost", async (t) => {
  const app = fixture(t);
  await app.connect();
  app.replyWith((method) => {
    if (method === "account/login/start") {
      app.controls.notification("account/login/completed", { loginId: "login-1", success: true });
      return device();
    }
    return method === "account/read" ? signedIn("new@example.com") : {};
  });
  await app.controls.start();
  await tick();
  assert.equal(app.el("login").hidden, true);
  assert.match(app.el("status").textContent, /new@example.com/);
  assert.match(app.el("message").textContent, /Sign-in complete/);
});

test("a delayed pre-login read cannot replace the verified new account", async (t) => {
  const app = fixture(t);
  await app.connect();
  let resolveOld;
  app.replyWith(() => new Promise((resolve) => { resolveOld = resolve; }));
  const stale = app.controls.refresh();
  app.replyWith((method) => method === "account/login/start" ? device()
    : method === "account/read" ? signedIn("new@example.com") : {});
  await app.controls.start();
  app.controls.notification("account/login/completed", { loginId: "login-1", success: true });
  await tick();
  resolveOld(signedOut);
  await stale;
  assert.match(app.el("status").textContent, /new@example.com/);
  assert.equal(app.el("banner").hidden, true);
});

test("pending codes survive a tab reload and completion during disconnection", async (t) => {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
  const first = fixture(t, storage);
  await first.connect();
  first.replyWith(() => device());
  await first.controls.start();
  first.controls.connectionChanged(false);
  assert.equal(first.el("sign-in").disabled, true);
  assert.match(first.el("message").textContent, /Connection lost/);
  const second = fixture(t, storage);
  assert.equal(second.el("code").textContent, "TEST-CODE1");
  second.replyWith((method) => method === "account/read" ? signedIn("new@example.com") : {});
  await second.connect();
  assert.equal(second.el("login").hidden, true);
  assert.match(second.el("status").textContent, /new@example.com/);
  assert.equal(data.size, 0);
});

test("expired stored codes and unsafe sign-in links are discarded", async (t) => {
  const old = JSON.stringify({ loginId: "old", userCode: "OLD-CODE1", verificationUrl: device().verificationUrl, expiresAt: Date.now() - 1 });
  const app = fixture(t, { getItem: () => old, removeItem() {} });
  assert.equal(app.el("login").hidden, true);
  await app.connect();
  app.replyWith(() => ({ ...device(), verificationUrl: "javascript:alert(1)" }));
  await app.controls.start();
  assert.equal(app.el("login-link").hasAttribute("href"), false);
  assert.match(app.el("message").textContent, /valid device sign-in code/);
});

test("live auth errors persist across reconnect and unrelated connector errors are ignored", async (t) => {
  const app = fixture(t);
  app.replyWith((method) => method === "account/read" ? signedIn("old@example.com") : {});
  await app.connect();
  app.controls.observeError({ message: "Unauthorized" }, "mcpServer/tool/call");
  assert.equal(app.el("banner").hidden, true);
  app.controls.notification("turn/completed", { turn: { error: { codexErrorInfo: "unauthorized" } } });
  assert.equal(app.el("banner").hidden, false);
  app.controls.connectionChanged(false);
  app.replyWith(() => { throw new Error("Backend unavailable"); });
  await app.connect();
  assert.equal(app.el("banner").hidden, false);
  assert.equal(app.el("sign-in").disabled, false);
});
