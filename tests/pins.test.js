"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

function fixture(t, stored) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only",
  });
  const { window } = dom;
  window.CODEX_WEB_TEST = true;
  window.matchMedia = () => ({ matches: false });
  window.eval(fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8"));
  const api = window.CodexWebTest;
  if (stored !== undefined) window.localStorage.setItem(api.PINNED_THREADS_STORAGE_KEY, stored);
  const server = { storeId: "test-store", revision: 0, threadIds: Array.from(api.legacyPinnedThreads()) };
  api.applyPinnedThreads(server);
  window.localStorage.removeItem(api.PINNED_THREADS_STORAGE_KEY);
  const http = [];
  window.fetch = async (url, options = {}) => {
    http.push({ url, ...options });
    const body = options.body && JSON.parse(options.body);
    if (options.method === "PUT") {
      server.threadIds = server.threadIds.filter((id) => id !== body.threadId);
      if (body.pinned) server.threadIds.push(body.threadId);
      server.revision += 1;
    }
    if (options.method === "POST") {
      server.threadIds = [...new Set([...server.threadIds, ...body.threadIds])];
      server.revision += 1;
    }
    return { ok: true, json: async () => ({ ...server, threadIds: [...server.threadIds] }) };
  };
  const threads = [
    { id: "recent", name: "Recent chat", recencyAt: 300, status: { type: "idle" } },
    { id: "middle", name: "Active chat", recencyAt: 200, status: { type: "active" } },
    { id: "old", name: "Older <chat>", recencyAt: 100, status: { type: "idle" } },
  ];
  api.state.threadId = "recent";
  api.renderThreads(threads);
  const requests = [];
  api.state.ws = {
    readyState: window.WebSocket.OPEN,
    send(raw) { requests.push(JSON.parse(raw)); },
  };
  t.after(async () => {
    await tick();
    api.state.ready = false;
    for (const id of api.state.pending.keys()) api.handleMessage({ id, error: { message: "Test cleanup" } });
    window.close();
  });
  const link = (id) => api.ui.threads.querySelector(`a[href="${api.threadHref(id)}"]`);
  const pin = (id) => link(id).parentElement.querySelector("button");
  const order = () => Array.from(api.ui.threads.querySelectorAll("a"), (node) => (
    new URL(node.href).searchParams.get("thread")
  ));
  const reply = (index, result) => api.handleMessage({ id: requests[index].id, result });
  return { ...api, window, threads, requests, link, pin, order, reply, http, server };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("pin buttons reorder conversations without opening them or changing activity", async (t) => {
  const app = fixture(t);
  const original = JSON.stringify(app.threads);
  app.ui.prompt.value = "Keep my unsent draft";
  const button = app.pin("old");
  assert.equal(button.closest("a"), null, "buttons must be separate from conversation links");
  assert.equal(button.getAttribute("aria-label"), "Pin conversation: Older <chat>");
  button.click();
  assert.deepEqual(app.order(), ["old", "recent", "middle"]);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.getAttribute("aria-label"), "Unpin conversation: Older <chat>");
  assert.equal(app.link("recent").getAttribute("aria-current"), "page");
  assert.equal(app.link("middle").getAttribute("aria-busy"), "true");
  assert.equal(app.state.threadId, "recent");
  assert.equal(app.ui.prompt.value, "Keep my unsent draft");
  assert.deepEqual(app.requests, []);
  assert.equal(JSON.stringify(app.threads), original);
  await tick();
  button.click();
  assert.deepEqual(app.order(), ["recent", "middle", "old"]);
  assert.equal(button.getAttribute("aria-pressed"), "false");
});

test("both pinned and recent groups follow activity order and preserve focused controls", (t) => {
  const app = fixture(t);
  app.pin("old").focus();
  const focused = app.window.document.activeElement;
  focused.click();
  assert.equal(app.window.document.activeElement, focused);
  app.setThreadPinned("middle", true);
  assert.deepEqual(app.order(), ["middle", "old", "recent"]);
  app.renderThreads(app.threads.map((thread) => ({
    ...thread, recencyAt: thread.id === "old" ? 400 : thread.recencyAt,
  })));
  assert.deepEqual(app.order(), ["old", "middle", "recent"]);
  assert.equal(app.pin("old"), focused);
  assert.equal(app.window.document.activeElement, focused);
  app.state.threadId = "middle";
  app.renderThreads(app.state.threads);
  assert.equal(app.link("recent").hasAttribute("aria-current"), false);
  assert.equal(app.link("middle").getAttribute("aria-current"), "page");
});

test("pins save on the server and load in a fresh browser without local storage", async (t) => {
  const app = fixture(t);
  await app.setThreadPinned("old", true);
  assert.equal(app.window.localStorage.getItem(app.PINNED_THREADS_STORAGE_KEY), null);
  assert.deepEqual(app.server.threadIds, ["old"]);
  const reloaded = fixture(t);
  reloaded.window.fetch = app.window.fetch;
  await reloaded.loadPinnedThreads();
  assert.deepEqual(reloaded.order(), ["old", "recent", "middle"]);
  assert.equal(reloaded.pin("old").getAttribute("aria-pressed"), "true");
});

test("invalid saved pins and unavailable browser storage do not break server pins", async (t) => {
  for (const stored of ["invalid-json", "null", "{}", '"old"']) {
    const app = fixture(t, stored);
    assert.deepEqual(app.order(), ["recent", "middle", "old"]);
  }
  const app = fixture(t, '[null,1,"","  ","old","old"]');
  assert.deepEqual(Array.from(app.state.pinnedThreads), ["old"]);
  Object.defineProperty(app.window, "localStorage", { get() { throw new Error("Storage disabled"); } });
  await app.loadPinnedThreads();
  await app.setThreadPinned("middle", true);
  assert.deepEqual(app.order(), ["middle", "old", "recent"]);
});

test("server notifications synchronize pins and stale responses cannot undo changes", (t) => {
  const app = fixture(t);
  app.handleNotification("codex-web/pins/updated", { storeId: "test-store", revision: 2, threadIds: ["old"] });
  assert.deepEqual(app.order(), ["old", "recent", "middle"]);
  app.applyPinnedThreads({ storeId: "test-store", revision: 1, threadIds: [] });
  assert.deepEqual(app.order(), ["old", "recent", "middle"]);
  app.handleNotification("codex-web/pins/updated", { storeId: "test-store", revision: 3, threadIds: [] });
  assert.deepEqual(app.order(), ["recent", "middle", "old"]);
});

test("history pagination retains older pins without adding other old chats", async (t) => {
  const app = fixture(t, '["old"]');
  app.state.ready = true;
  const refresh = app.refreshThreads();
  app.reply(0, { data: [app.threads[0]], nextCursor: "page-2" });
  await tick();
  assert.deepEqual(app.order(), ["old", "recent"], "cached pins stay visible while history loads");
  assert.equal(app.requests[1].params.cursor, "page-2");
  app.reply(1, { data: [app.threads[1]], nextCursor: "page-3" });
  await tick();
  app.reply(2, { data: [{ ...app.threads[2], name: "Updated pinned title" }], nextCursor: "page-4" });
  await refresh;
  assert.deepEqual(app.order(), ["old", "recent"]);
  assert.equal(app.link("old").querySelector("strong").textContent, "Updated pinned title");
  assert.equal(app.requests.length, 3, "stop scanning once all pins are found");
});

test("failed or malformed history pages preserve pins, and repeated cursors stop scanning", async (t) => {
  for (const failure of ["error", "malformed", "cursor"]) {
    const app = fixture(t, '["old"]');
    app.state.ready = true;
    const refresh = app.refreshThreads();
    app.reply(0, { data: [app.threads[0]], nextCursor: "page-2" });
    await tick();
    if (failure === "error") {
      app.handleMessage({ id: app.requests[1].id, error: { message: "History unavailable" } });
    } else if (failure === "malformed") {
      app.reply(1, {});
    } else {
      app.reply(1, { data: [], nextCursor: "page-2" });
    }
    await refresh;
    assert.equal(app.state.pinnedThreads.has("old"), true);
    assert.deepEqual(app.order(), ["old", "recent"]);
    assert.equal(app.ui.notice.hidden, false);
    assert.equal(app.requests.length, 2);
  }
  const app = fixture(t, '["old"]');
  app.state.ready = true;
  const refresh = app.refreshThreads();
  app.reply(0, {});
  await refresh;
  assert.equal(app.state.pinnedThreads.has("old"), true);
});

test("a history scan never deletes shared pins absent from a stale listing", async (t) => {
  const app = fixture(t, '["missing","old"]');
  app.showStartedThread({ id: "new-chat", name: "New chat", recencyAt: 500 });
  await app.setThreadPinned("new-chat", true);
  await tick();
  app.state.ready = true;
  const refresh = app.refreshThreads();
  app.reply(0, { data: [app.threads[0]], nextCursor: "page-2" });
  await tick();
  app.reply(1, { data: [app.threads[2]], nextCursor: null });
  await refresh;
  assert.deepEqual(app.order(), ["new-chat", "old", "recent"]);
  assert.equal(app.state.pinnedThreads.has("missing"), true);
  assert.equal(app.state.pinnedThreads.has("new-chat"), true);
});

test("a stale history page cannot overwrite a newer refresh or remove pins", async (t) => {
  const app = fixture(t, '["old"]');
  app.state.ready = true;
  const older = app.refreshThreads();
  app.reply(0, { data: [app.threads[0]], nextCursor: "page-2" });
  await tick();
  const newer = app.refreshThreads();
  app.reply(2, { data: app.threads, nextCursor: null });
  await newer;
  app.reply(1, { data: [], nextCursor: null });
  await older;
  assert.deepEqual(app.order(), ["old", "recent", "middle"]);
  assert.equal(app.state.pinnedThreads.has("old"), true);
});

test("failed imports preserve browser pins for a retry", async (t) => {
  const app = fixture(t);
  app.window.localStorage.setItem(app.PINNED_THREADS_STORAGE_KEY, '["old"]');
  const fetch = app.window.fetch;
  app.window.fetch = async () => ({ ok: false, status: 503 });
  assert.equal(await app.loadPinnedThreads(), false);
  assert.equal(app.window.localStorage.getItem(app.PINNED_THREADS_STORAGE_KEY), '["old"]');
  app.window.fetch = fetch;
  assert.equal(await app.loadPinnedThreads(), true);
  assert.equal(app.window.localStorage.getItem(app.PINNED_THREADS_STORAGE_KEY), null);
  assert.deepEqual(app.server.threadIds, ["old"]);
});

test("failed saves roll back only the failed pin and keep remote changes", async (t) => {
  const app = fixture(t, '["old"]');
  let respond;
  app.window.fetch = () => new Promise((resolve) => { respond = resolve; });
  const save = app.setThreadPinned("old", false);
  assert.equal(app.pin("old").getAttribute("aria-pressed"), "false");
  assert.equal(app.pin("old").getAttribute("aria-busy"), "true");
  app.handleNotification("codex-web/pins/updated", { storeId: "test-store", revision: 5, threadIds: ["old", "middle"] });
  respond({ ok: false, status: 503 });
  await save;
  assert.deepEqual(app.order(), ["middle", "old", "recent"]);
  assert.match(app.ui.notice.textContent, /Unable to save pinned chat/);
  respond({ ok: true, json: async () => ({ storeId: "test-store", revision: 5, threadIds: ["old", "middle"] }) });
  await tick();
});

test("pins stay unavailable until the first successful server response", async (t) => {
  const app = fixture(t);
  app.state.pinsLoaded = false;
  app.renderThreads(app.threads);
  assert.equal(app.pin("old").disabled, true);
  await app.setThreadPinned("old", true);
  assert.equal(app.http.length, 0);
  await app.loadPinnedThreads();
  assert.equal(app.pin("old").disabled, false);
});

test("pending writes preserve their intent until acknowledged, then accept a newer remote decision", async (t) => {
  const app = fixture(t);
  let respond;
  app.window.fetch = () => new Promise((resolve) => { respond = resolve; });
  const save = app.setThreadPinned("old", true);
  app.handleNotification("codex-web/pins/updated", { storeId: "test-store", revision: 3, threadIds: [] });
  assert.equal(app.state.pinnedThreads.has("old"), true);
  respond({ ok: true, json: async () => ({ storeId: "test-store", revision: 2, threadIds: ["old"] }) });
  await save;
  assert.equal(app.state.pinnedThreads.has("old"), false);
  respond({ ok: true, json: async () => ({ storeId: "test-store", revision: 3, threadIds: [] }) });
  await tick();
});

test("HTTP sidebar loads before the live connection and preserves older pinned chats", async (t) => {
  const app = fixture(t, '["old"]');
  app.state.threadListHttp = true;
  const calls = [];
  app.window.fetch = async (url, options) => {
    assert.equal(url, "/api/threads");
    assert.equal(options.cache, "no-store");
    assert.equal(options.priority, "high");
    const params = JSON.parse(options.body);
    calls.push(params);
    return { ok: true, json: async () => params.cursor
      ? { data: [app.threads[2]], nextCursor: null }
      : { data: [app.threads[0]], nextCursor: "older" } };
  };
  await app.refreshThreads();
  assert.deepEqual(calls, [{ cursor: null }, { cursor: "older" }]);
  assert.deepEqual(app.order(), ["old", "recent"]);
  assert.equal(app.requests.length, 0, "the sidebar does not wait for or use the live socket");
});

test("failed HTTP sidebar refresh keeps existing rows and pins", async (t) => {
  const app = fixture(t, '["old"]');
  app.state.threadListHttp = true;
  app.window.fetch = async () => ({ ok: false, json: async () => ({ error: "List unavailable" }) });
  assert.equal(await app.refreshThreads(), false, "startup can retry a failed prefetch after connection");
  assert.equal(app.state.pinnedThreads.has("old"), true);
  assert.equal(app.order().length, 3);
  assert.match(app.ui.notice.textContent, /List unavailable/);
});

test("a sidebar selection made before connection is retained for startup", async (t) => {
  const app = fixture(t);
  app.state.threadListHttp = true;
  await app.openThread("old");
  assert.equal(app.state.threadId, "old");
  assert.equal(app.link("old").getAttribute("aria-current"), "page");
  assert.equal(new URL(app.window.location.href).searchParams.get("thread"), "old");
  assert.equal(app.requests.length, 0);
  assert.match(app.ui.messages.textContent, /Loading conversation/);
});
