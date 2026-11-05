"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

function fixture(t) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.CODEX_WEB_TEST = true;
  window.matchMedia = () => ({ matches: false });
  window.eval(fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8"));
  const app = window.CodexWebTest;
  const calls = [];
  let reply = () => ({});
  app.state.ws = {
    readyState: window.WebSocket.OPEN,
    send(raw) {
      const message = JSON.parse(raw);
      calls.push(message);
      Promise.resolve().then(() => reply(message)).then(
        (result) => app.handleMessage({ id: message.id, result }),
        (error) => app.handleMessage({ id: message.id, error: { message: error.message } }),
      );
    },
  };
  return { ...app, window, calls, replyWith(fn) { reply = fn; } };
}

const exhausted = (resetsAt = Math.floor(Date.now() / 1000) + 3600) => ({
  accountId: "test-account", ordinaryUsageAllowed: false,
  rateLimits: { primary: { usedPercent: 100, resetsAt }, credits: { hasCredits: false, unlimited: false } },
});
const visible = (app) => !app.ui.usageLimitWarning.hidden;

test("account warning survives ordinary notices and switching to a new chat", (t) => {
  const app = fixture(t);
  app.applyUsageLimits(exhausted());
  assert.ok(visible(app));
  assert.match(app.ui.usageLimitDetail.textContent, /Expected reset:/);
  app.notice("Network request failed");
  app.beginNewThread();
  app.notice("");
  assert.ok(visible(app));
  assert.equal(app.ui.notice.hidden, true);
  assert.equal(app.ui.usageLimitWarning.closest(".messages"), null);
});

test("reload and cross-tab events preserve and clear the account warning", (t) => {
  const app = fixture(t);
  app.applyUsageLimits(exhausted());
  const reloaded = fixture(t);
  const key = app.USAGE_LIMIT_STORAGE_KEY;
  reloaded.window.localStorage.setItem(key, app.window.localStorage.getItem(key));
  reloaded.loadUsageLimitWarning();
  assert.ok(visible(reloaded));
  app.applyUsageLimits({ accountId: "test-account", ordinaryUsageAllowed: true });
  reloaded.window.localStorage.setItem(key, app.window.localStorage.getItem(key));
  reloaded.handleUsageLimitStorage({ key });
  assert.equal(visible(reloaded), false);
});

test("sparse updates, credit balance and reset times cannot infer recovery", (t) => {
  const app = fixture(t);
  app.applyUsageLimits(exhausted(100));
  for (const snapshot of [{}, { rateLimits: {} }, { ordinaryUsageAllowed: null, rateLimits: {
    primary: { usedPercent: 0 }, credits: { hasCredits: true, unlimited: true }, spendControlReached: false,
  } }]) app.applyUsageLimits(snapshot);
  assert.ok(visible(app));
  assert.match(app.ui.usageLimitDetail.textContent, /reset time has passed/);
  app.applyUsageLimits({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 100 } } });
  assert.equal(visible(app), false, "explicit backend availability overrides rounded percentages");
});

test("only exhausted limits warn; empty purchased credits and temporary errors do not", (t) => {
  const app = fixture(t);
  app.applyUsageLimits({ rateLimits: { primary: { usedPercent: 99 }, credits: { hasCredits: false, unlimited: false } } });
  for (const codexErrorInfo of ["rateLimitExceeded", "contextWindowExceeded", "sessionBudgetExceeded", "serverOverloaded"]) {
    app.observeUsageLimitError({ codexErrorInfo, message: "Limit reached" });
  }
  assert.equal(visible(app), false);
  app.applyUsageLimits({ rateLimits: {}, rateLimitsByLimitId: { other: {
    limitName: "Weekly usage", secondary: { usedPercent: 100, resetsAt: 2000000000 },
  } } });
  assert.ok(visible(app));
  assert.match(app.ui.usageLimitDetail.textContent, /Weekly usage/);
});

test("backend spend controls and workspace credit exhaustion show the warning", (t) => {
  const app = fixture(t);
  for (const rateLimits of [
    { spendControlReached: true },
    { rateLimitReachedType: "workspace_member_credits_depleted" },
    { individualLimit: { remainingPercent: 0, resetsAt: 2000000000 } },
  ]) {
    app.applyUsageLimits({ ordinaryUsageAllowed: true });
    app.applyUsageLimits({ rateLimits });
    assert.ok(visible(app));
  }
});

test("background and terminal turn errors trigger a global warning", (t) => {
  const app = fixture(t);
  app.state.threadId = "selected-chat";
  app.handleNotification("error", { threadId: "background-chat", error: {
    codexErrorInfo: "usageLimitExceeded", message: "Usage is unavailable",
  } });
  assert.ok(visible(app));
  app.applyUsageLimits({ ordinaryUsageAllowed: true });
  app.handleNotification("turn/completed", { threadId: "background-chat", turn: {
    id: "failed-turn", status: "failed", items: [], error: { codexErrorInfo: "usageLimitExceeded", message: "Limit reached" },
  } });
  assert.ok(visible(app));
});

test("RPC errors preserve structured usage-limit information", (t) => {
  const app = fixture(t);
  let rejected;
  app.state.pending.set(42, { method: "turn/start", reject: (error) => { rejected = error; } });
  app.handleMessage({ id: 42, error: { message: "Account exhausted", data: { codexErrorInfo: "usageLimitExceeded" } } });
  assert.equal(rejected.message, "Account exhausted");
  assert.ok(visible(app));
});

test("legacy usage-limit text is recognized without treating arbitrary limits as quota", (t) => {
  const app = fixture(t);
  for (const message of ["Request rate limit exceeded", "Context window exceeded", "Attachment limit reached"]) {
    assert.equal(app.observeUsageLimitError({ message }), false);
  }
  assert.equal(app.observeUsageLimitError({ message: "You've hit your usage limit. Try again later." }), true);
  assert.ok(visible(app));
});

test("failed account reads keep the warning and do not affect ordinary notices", async (t) => {
  const app = fixture(t);
  app.applyUsageLimits(exhausted());
  app.state.ready = true;
  app.replyWith(() => { throw new Error("Not available"); });
  await app.refreshUsageLimits();
  assert.ok(visible(app));
  assert.equal(app.ui.notice.hidden, true);
  assert.equal(app.calls[0].method, "account/rateLimits/read");
  assert.equal(app.calls[0].params.excludeResetCreditDetails, true);
});

test("an older account read cannot clear a more recent usage-limit event", async (t) => {
  const app = fixture(t);
  app.state.ready = true;
  let finish;
  app.replyWith(() => new Promise((resolve) => { finish = resolve; }));
  const request = app.refreshUsageLimits();
  await Promise.resolve();
  app.handleNotification("error", { error: { codexErrorInfo: "usageLimitExceeded", message: "Exhausted" } });
  finish({ ordinaryUsageAllowed: true });
  await request;
  assert.ok(visible(app));
  app.replyWith(() => ({ ordinaryUsageAllowed: true }));
  await app.refreshUsageLimits();
  assert.equal(visible(app), false);
});

test("account changes discard old warnings and old connections cannot clear new warnings", async (t) => {
  const app = fixture(t);
  app.applyUsageLimits(exhausted());
  app.applyUsageLimits({ accountId: "different-account", ordinaryUsageAllowed: true });
  assert.equal(visible(app), false);
  app.applyUsageLimits(exhausted());
  app.handleNotification("account/updated", { authMode: "chatgpt" });
  assert.ok(visible(app), "a plan update must not dismiss an exhausted account warning");
  app.handleNotification("account/updated", { authMode: null });
  assert.equal(visible(app), false);
  app.state.ready = true;
  let finish;
  app.replyWith(() => new Promise((resolve) => { finish = resolve; }));
  const request = app.refreshUsageLimits();
  await Promise.resolve();
  app.state.ws = null;
  app.applyUsageLimits(exhausted());
  finish({ ordinaryUsageAllowed: true });
  await request;
  assert.ok(visible(app));
});

test("duplicate limit snapshots do not defeat an authoritative recovery read", async (t) => {
  const app = fixture(t);
  const snapshot = exhausted();
  app.applyUsageLimits(snapshot);
  app.state.ready = true;
  let finish;
  app.replyWith(() => new Promise((resolve) => { finish = resolve; }));
  const request = app.refreshUsageLimits();
  await Promise.resolve();
  app.handleNotification("account/rateLimits/updated", { rateLimits: snapshot.rateLimits });
  finish({ ordinaryUsageAllowed: true });
  await request;
  assert.equal(visible(app), false);
});

test("malformed or unavailable storage never prevents an in-memory warning", (t) => {
  const app = fixture(t);
  app.window.localStorage.setItem(app.USAGE_LIMIT_STORAGE_KEY, "invalid JSON");
  app.loadUsageLimitWarning();
  Object.defineProperty(app.window, "localStorage", { get() { throw new Error("Storage disabled"); } });
  app.applyUsageLimits(exhausted());
  assert.ok(visible(app));
  app.notice("");
  assert.ok(visible(app));
});
