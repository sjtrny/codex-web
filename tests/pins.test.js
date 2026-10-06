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
  api.loadPinnedThreads();
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
  t.after(() => {
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
  return { ...api, window, threads, requests, link, pin, order, reply };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("pin buttons reorder conversations without opening them or changing activity", (t) => {
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

test("pins persist as IDs and restore when the browser reloads", (t) => {
  const app = fixture(t);
  app.setThreadPinned("old", true);
  const saved = app.window.localStorage.getItem(app.PINNED_THREADS_STORAGE_KEY);
  assert.deepEqual(JSON.parse(saved), ["old"]);
  const reloaded = fixture(t, saved);
  assert.deepEqual(reloaded.order(), ["old", "recent", "middle"]);
  assert.equal(reloaded.pin("old").getAttribute("aria-pressed"), "true");
});

test("invalid saved pins and unavailable browser storage do not break the sidebar", (t) => {
  for (const stored of ["invalid-json", "null", "{}", '"old"']) {
    const app = fixture(t, stored);
    assert.deepEqual(app.order(), ["recent", "middle", "old"]);
  }
  const app = fixture(t, '[null,1,"","  ","old","old"]');
  assert.deepEqual(Array.from(app.state.pinnedThreads), ["old"]);
  Object.defineProperty(app.window, "localStorage", { get() { throw new Error("Storage disabled"); } });
  app.loadPinnedThreads();
  app.setThreadPinned("middle", true);
  assert.deepEqual(app.order(), ["middle", "recent", "old"]);
});

test("storage events update pins between tabs and ignore unrelated settings", (t) => {
  const app = fixture(t);
  app.window.localStorage.setItem(app.PINNED_THREADS_STORAGE_KEY, '["old"]');
  app.handlePinnedThreadsStorage({ key: "unrelated-setting" });
  assert.deepEqual(app.order(), ["recent", "middle", "old"]);
  app.handlePinnedThreadsStorage({ key: app.PINNED_THREADS_STORAGE_KEY });
  assert.deepEqual(app.order(), ["old", "recent", "middle"]);
  app.window.localStorage.clear();
  app.handlePinnedThreadsStorage({ key: null });
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

test("a complete history scan retires missing pins without dropping a new provisional chat", async (t) => {
  const app = fixture(t, '["missing","old"]');
  app.showStartedThread({ id: "new-chat", name: "New chat", recencyAt: 500 });
  app.setThreadPinned("new-chat", true);
  app.state.ready = true;
  const refresh = app.refreshThreads();
  app.reply(0, { data: [app.threads[0]], nextCursor: "page-2" });
  await tick();
  app.reply(1, { data: [app.threads[2]], nextCursor: null });
  await refresh;
  assert.deepEqual(app.order(), ["new-chat", "old", "recent"]);
  assert.equal(app.state.pinnedThreads.has("missing"), false);
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

test("archiving and deletion remove only the affected pin", (t) => {
  for (const method of ["thread/archived", "thread/deleted"]) {
    const app = fixture(t, '["old","middle"]');
    app.handleNotification(method, { threadId: "old" });
    assert.equal(app.state.pinnedThreads.has("old"), false);
    assert.deepEqual(JSON.parse(app.window.localStorage.getItem(app.PINNED_THREADS_STORAGE_KEY)), ["middle"]);
  }
});
