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
  const api = window.CodexWebTest;
  const calls = [];
  const downloads = [];
  const threads = new Map(["a", "b"].map((id) => [id, {
    id, name: `Chat ${id}`, cwd: "/workspaces", status: { type: "idle" }, turns: [],
  }]));
  api.state.ws = { readyState: window.WebSocket.OPEN, send(raw) {
    const message = JSON.parse(raw);
    calls.push(message);
    const result = message.method === "thread/resume"
      ? { thread: structuredClone(threads.get(message.params.threadId)) }
      : { data: message.method === "thread/list" ? [...threads.values()] : [] };
    queueMicrotask(() => api.handleMessage({ id: message.id, result }));
  } };
  api.state.ready = true;
  api.state.connectionGeneration = 1;
  api.state.historyChunkBytes = 1024;
  window.fetch = async (_url, options) => new Promise((resolve) => {
    const request = JSON.parse(options.body);
    downloads.push({ ...request, finish(page, error = "") {
      resolve({ ok: !error, status: error ? 502 : 200,
        json: async () => ({ error }), text: async () => page.text,
        headers: { get(name) { return name === "X-Codex-History-Cursor" ? page.cursor
          : name === "X-Codex-History-Reset" && page.reset ? "1" : "0"; } },
      });
    } });
  });
  return { ...api, window, threads, calls, downloads };
}

const turn = (id = "turn") => ({ turn: { id, status: "completed" } });
const item = (id, text = id, turnId = "turn") => ({
  turnId, item: { id, type: "agentMessage", phase: "final_answer", text },
});
const page = (records, cursor = "") => ({ text: records.map(JSON.stringify).join("\n") + "\n", cursor });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const ids = (entry) => Array.from(entry.thread.turns.flatMap((turn) => turn.items.map((item) => item.id)));

async function open(app, id = "a", records = [turn(), item("latest")], cursor = "older") {
  const promise = app.openThread(id);
  await tick();
  app.downloads.at(-1).finish(page(records, cursor));
  await promise;
  return app.cachedThread(id);
}

test("opening and switching request metadata and just one recent chunk", async (t) => {
  const app = fixture(t);
  await open(app);
  await open(app, "b");
  app.ui.prompt.value = "Keep my draft";
  await open(app);
  assert.equal(app.downloads.length, 3);
  assert.ok(app.calls.filter((call) => call.method === "thread/resume")
    .every((call) => call.params.excludeTurns === true));
  assert.equal(app.state.composerDrafts.get("thread:b"), "Keep my draft");
  assert.deepEqual(ids(app.cachedThread("a")), ["latest"]);
});

test("upward scroll fetches one older page, with no duplicate requests or saved messages", async (t) => {
  const app = fixture(t);
  await open(app, "a", [turn(), item("latest", "Repeated")]);
  app.state.lastMessagesScrollTop = 400;
  app.handleMessagesScroll();
  app.handleMessagesWheel({ deltaY: -200 });
  await tick();
  assert.equal(app.downloads.length, 2);
  assert.equal(app.downloads[1].cursor, "older");
  app.downloads[1].finish(page([item("middle", "Repeated"), item("oldest")], ""));
  await tick();
  assert.deepEqual(ids(app.cachedThread("a")), ["oldest", "middle", "latest"]);
  assert.equal(app.ui.messages.querySelector(".history-control"), null);
  assert.equal(await app.loadOlderHistory(), false);
  assert.equal(app.downloads.length, 2);
});

test("oversized Unicode records assemble across chunks and end-of-history stops loading", async (t) => {
  const app = fixture(t);
  const record = JSON.stringify(item("large", "🦜你好".repeat(100))) + "\n";
  await open(app, "a", [turn()], "large-1");
  let loading = app.loadOlderHistory();
  app.downloads.at(-1).finish({ text: record.slice(0, 101), cursor: "large-2" });
  await loading;
  assert.deepEqual(ids(app.cachedThread("a")), []);
  loading = app.loadOlderHistory();
  app.downloads.at(-1).finish({ text: record.slice(101), cursor: "" });
  await loading;
  assert.deepEqual(ids(app.cachedThread("a")), ["large"]);
  assert.equal(app.cachedThread("a").thread.turns[0].items[0].text, "🦜你好".repeat(100));
});

test("failed and malformed older downloads keep their cursor and can be retried", async (t) => {
  const app = fixture(t);
  await open(app);
  for (const response of [null, { text: "invalid\n", cursor: "" }]) {
    const loading = app.loadOlderHistory();
    app.downloads.at(-1).finish(response, response ? "" : "Temporarily unavailable");
    assert.equal(await loading, false);
    assert.equal(app.cachedThread("a").history.cursor, "older");
    assert.deepEqual(ids(app.cachedThread("a")), ["latest"]);
    assert.match(app.ui.messages.querySelector(".history-control").textContent, /Retry/);
  }
  const retry = app.loadOlderHistory();
  app.downloads.at(-1).finish(page([item("old")], ""));
  assert.equal(await retry, true);
  assert.deepEqual(ids(app.cachedThread("a")), ["old", "latest"]);
});

test("late history responses never replace the selected chat or a new connection's window", async (t) => {
  const app = fixture(t);
  await open(app);
  const old = app.loadOlderHistory();
  const request = app.downloads.at(-1);
  await open(app, "b");
  request.finish(page([item("old")], ""));
  await old;
  assert.equal(app.state.threadId, "b");
  assert.equal(app.ui.title.textContent, "Chat b");
  assert.deepEqual(ids(app.cachedThread("a")), ["old", "latest"]);

  app.state.connectionGeneration += 1;
  await open(app, "a", [turn("new-turn"), item("new", "new", "new-turn")], "new-cursor");
  assert.deepEqual(ids(app.cachedThread("a")), ["new"]);
  assert.equal(app.cachedThread("a").history.cursor, "new-cursor");
});

test("live updates during initial history survive and latest reconciliation stays chronological", async (t) => {
  const app = fixture(t);
  const opening = app.openThread("a");
  await tick();
  app.handleNotification("item/agentMessage/delta", {
    threadId: "a", turnId: "turn", itemId: "streamed", delta: "A live answer with more text",
  });
  app.downloads.at(-1).finish(page([turn(), item("saved", "A live answer with more")], "older"));
  await opening;
  assert.deepEqual(ids(app.cachedThread("a")), ["saved"]);
  assert.equal(app.cachedThread("a").thread.turns[0].items[0].text, "A live answer with more text");

  const older = app.loadOlderHistory();
  app.downloads.at(-1).finish(page([item("early")], "earlier"));
  await older;
  const refresh = app.refreshPagedHistory("a");
  await tick();
  app.downloads.at(-1).finish(page([turn("next"), item("next-answer", "Next", "next")], "latest-cursor"));
  await refresh;
  assert.deepEqual(ids(app.cachedThread("a")), ["early", "saved", "next-answer"]);
  assert.equal(app.cachedThread("a").history.cursor, "earlier");
});

test("fragment reset discards an outdated partial live message", async (t) => {
  const app = fixture(t);
  await open(app, "a", [turn()], "partial");
  const partial = app.loadOlderHistory();
  app.downloads.at(-1).finish({ text: '{"turnId":"tur', cursor: "continued" });
  await partial;
  const complete = app.loadOlderHistory();
  app.downloads.at(-1).finish({ ...page([item("changed")]), reset: true });
  await complete;
  assert.deepEqual(ids(app.cachedThread("a")), ["changed"]);
});

test("initial history failure exposes a working retry and does not fall back to full history", async (t) => {
  const app = fixture(t);
  const opening = app.openThread("a");
  await tick();
  app.downloads.at(-1).finish(null, "History temporarily unavailable");
  await opening;
  const retry = app.ui.messages.querySelector(".history-control");
  assert.equal(retry.disabled, false);
  assert.match(retry.textContent, /Retry/);
  retry.click();
  await tick();
  app.downloads.at(-1).finish(page([turn(), item("recovered")], ""));
  await tick();
  assert.deepEqual(ids(app.cachedThread("a")), ["recovered"]);
  assert.equal(app.ui.notice.textContent, "");
  assert.equal(app.ui.messages.querySelector(".history-control"), null);
  assert.ok(app.calls.filter((call) => call.method === "thread/resume")
    .every((call) => call.params.excludeTurns === true));
});

test("old downloads after reconnect and duplicate live-prefix events are ignored", async (t) => {
  const app = fixture(t);
  await open(app);
  const old = app.loadOlderHistory();
  const stale = app.downloads.at(-1);
  app.state.connectionGeneration += 1;
  await open(app, "a", [turn("new"), item("new-answer", "new", "new")], "newer-cursor");
  stale.finish(page([item("stale")], "stale-cursor"));
  await old;
  assert.deepEqual(ids(app.cachedThread("a")), ["new-answer"]);
  assert.equal(app.cachedThread("a").history.cursor, "newer-cursor");
  const before = app.downloads.length;
  for (let i = 0; i < 4; i += 1) {
    app.handleNotification("item/started", {
      threadId: "a", turnId: "new", item: { id: `tool-${i}`, type: "commandExecution", command: "example" },
    });
  }
  await tick();
  assert.equal(app.downloads.length, before);
});

test("messages and turns arriving after a history request stay after that snapshot", async (t) => {
  const app = fixture(t);
  const opening = app.openThread("a");
  await tick();
  app.handleNotification("item/agentMessage/delta", {
    threadId: "a", turnId: "turn", itemId: "live-later", delta: "Arrived during download",
  });
  app.handleNotification("item/agentMessage/delta", {
    threadId: "a", turnId: "next-turn", itemId: "new-turn-live", delta: "A later turn",
  });
  app.downloads.at(-1).finish(page([turn(), item("saved-earlier")], "older"));
  await opening;
  assert.deepEqual(ids(app.cachedThread("a")), ["saved-earlier", "live-later", "new-turn-live"]);
});

test("a failed latest refresh can retry even after all older history is loaded", async (t) => {
  const app = fixture(t);
  await open(app, "a", [turn(), item("saved")], "");
  const failed = app.refreshPagedHistory("a");
  await tick();
  app.downloads.at(-1).finish(null, "Refresh failed");
  await assert.rejects(failed, /Refresh failed/);
  app.ui.messages.querySelector(".history-control").click();
  await tick();
  app.downloads.at(-1).finish(page([turn(), item("newest"), item("saved")], ""));
  await tick();
  assert.deepEqual(ids(app.cachedThread("a")), ["saved", "newest"]);
  assert.equal(app.ui.messages.querySelector(".history-control"), null);
});
