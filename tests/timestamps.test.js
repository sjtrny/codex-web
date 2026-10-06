"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

const storageKey = "codex-web-message-times-v1";
const receivedAt = Date.parse("2026-10-06T12:34:56Z");
const user = (id, text = "Question") => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const agent = (id, text = "Answer", phase = "commentary") => ({ id, type: "agentMessage", text, phase });

function assertNoTime(timestamp) {
  assert.equal(timestamp.hidden, true);
  assert.equal(timestamp.textContent, "");
  for (const attribute of ["datetime", "data-timestamp-source", "title", "aria-label"]) {
    assert.equal(timestamp.hasAttribute(attribute), false);
  }
}

function fixture(t, { stored = null, blockedStorage = false } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  if (stored !== null) window.localStorage.setItem(storageKey, stored);
  if (blockedStorage) Object.defineProperty(window, "localStorage", { get() { throw new Error("Storage disabled"); } });
  let now = receivedAt;
  window.Date.now = () => now;
  window.matchMedia = () => ({ matches: false });
  window.CODEX_WEB_TEST = true;
  window.eval(fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8"));
  const api = window.CodexWebTest;
  const thread = {
    id: "chat", createdAt: 1704067200, cwd: "/workspaces", status: { type: "idle" },
    turns: [{ id: "turn", startedAt: 1704153600, completedAt: 1704153660, status: "completed", items: [] }],
  };
  api.state.threadId = thread.id;
  api.cacheThreadSnapshot(thread);
  const entry = (id, turnId = "turn", threadId = "chat") => api.state.items.get(api.renderedItemKey(id, threadId, turnId));
  const timestamp = (id, turnId, threadId) => entry(id, turnId, threadId).timestamp;
  const notify = (item, method = "item/completed", turnId = "turn", threadId = "chat") => api.handleNotification(method, { item, turnId, threadId });
  return { ...api, thread, window, entry, timestamp, notify, setNow(value) { now = value; } };
}

test("saved messages and activities show only exact per-item times", (t) => {
  const app = fixture(t);
  app.thread.turns[0].items = [
    user("question"), agent("progress"), agent("final", "Done", "final_answer"),
    { ...agent("exact"), createdAt: "2024-01-02T00:00:10Z" },
    { ...user("seconds"), timestamp: 1704153620 },
    { ...agent("milliseconds"), startedAt: 1704153630000 },
    { id: "plan", type: "plan", text: "One step" },
    { id: "reasoning", type: "reasoning", summary: ["Considering the request"] },
    { id: "command", type: "commandExecution", createdAt: 1704153640, command: "pwd", status: "completed", aggregatedOutput: "/workspaces" },
  ];
  app.renderThreadHistory(app.thread);
  assert.equal(app.ui.messages.querySelectorAll("time").length, 9);
  assert.equal(app.ui.messages.querySelectorAll("time:not([hidden])").length, 4);
  for (const id of ["question", "progress", "final", "plan", "reasoning"]) {
    assertNoTime(app.timestamp(id));
  }
  for (const [id, seconds] of [["exact", "10"], ["seconds", "20"], ["milliseconds", "30"], ["command", "40"]]) {
    assert.equal(app.timestamp(id).dateTime, `2024-01-02T00:00:${seconds}.000Z`);
    assert.equal(app.timestamp(id).dataset.timestampSource, "message");
    assert.doesNotMatch(app.timestamp(id).textContent, /≈/);
  }
  assert.equal(app.state.messageTimes.size, 0, "rendering saved history does not create browser timestamps");
});

test("missing, invalid, approximate, and timezone-less timestamps show no time information", (t) => {
  const app = fixture(t);
  const turn = app.thread.turns[0];
  turn.startedAt = "invalid";
  turn.completedAt = Infinity;
  turn.items = [
    { ...agent("invalid"), createdAt: true, timestamp: "invalid" },
    { ...agent("date-only"), createdAt: "2024-01-02" },
    { ...agent("no-zone"), createdAt: "2024-01-02T00:00:10" },
    { ...agent("approximate"), timestamp: 1704153600, timestampSource: "turn" },
  ];
  app.renderThreadHistory(app.thread);
  for (const item of turn.items) assertNoTime(app.timestamp(item.id));
  delete app.thread.createdAt;
  app.renderThreadHistory(app.thread);
  assertNoTime(app.timestamp("invalid"));
});

test("streaming times survive completion, canonical IDs, and a fresh page", (t) => {
  const app = fixture(t);
  app.notify({ ...agent("stream", ""), createdAt: "2026-10-06T12:30:00Z" }, "item/started");
  const original = app.timestamp("stream").dateTime;
  assert.equal(original, "2026-10-06T12:30:00.000Z");
  app.setNow(receivedAt + 60000);
  app.handleNotification("item/agentMessage/delta", { threadId: "chat", turnId: "turn", itemId: "stream", delta: "Hello" });
  app.notify(agent("stream", "Hello"));
  assert.equal(app.timestamp("stream").dateTime, original);
  const snapshot = { ...app.thread, turns: [{ ...app.thread.turns[0], items: [agent("canonical", "Hello")] }] };
  const merged = app.mergeThreadSnapshot(snapshot);
  app.renderThreadHistory(merged.thread);
  assert.equal(app.timestamp("canonical").dateTime, original);
  assert.equal(app.timestamp("canonical").dataset.timestampSource, "message");
  const reloaded = fixture(t, { stored: app.window.localStorage.getItem(storageKey) });
  reloaded.setNow(receivedAt + 3600000);
  reloaded.renderThreadHistory(snapshot);
  assert.equal(reloaded.timestamp("canonical").dateTime, original);
});

test("exact timestamps are scoped to each chat and turn; delta-only starts do not invent times", (t) => {
  const app = fixture(t);
  app.notify({ ...agent("same"), createdAt: receivedAt });
  const original = app.timestamp("same").dateTime;
  app.setNow(receivedAt + 10000);
  app.handleNotification("item/agentMessage/delta", { threadId: "chat", turnId: "next-turn", itemId: "same", delta: "Later" });
  assertNoTime(app.timestamp("same", "next-turn"));
  assert.equal(app.timestamp("same").dateTime, original);
  app.notify({ ...agent("same", "Later"), createdAt: receivedAt + 10000 }, "item/completed", "next-turn");
  assert.equal(app.timestamp("same", "next-turn").dateTime, new Date(receivedAt + 10000).toISOString());
  app.setNow(receivedAt + 20000);
  app.notify({ ...agent("same"), createdAt: receivedAt + 20000 }, "item/completed", "turn", "background-chat");
  const background = { ...app.thread, id: "background-chat", turns: [{ id: "turn", status: "completed", items: [agent("same")] }] };
  app.renderThreadHistory(background);
  assert.equal(app.timestamp("same", "turn", "background-chat").dateTime, new Date(receivedAt + 20000).toISOString());
});

test("optimistic prompts remain without times until an exact backend timestamp is recovered", (t) => {
  for (const snapshotOnly of [false, true]) {
    const app = fixture(t);
    app.renderLocalPrompt("local", "Question", "chat", app.state.selectionId);
    assertNoTime(app.state.pendingUser.node.querySelector("time"));
    app.handleNotification("turn/started", { threadId: "chat", turn: { id: "turn", status: "inProgress" } });
    app.setNow(receivedAt + 30000);
    const echoed = { ...user("canonical-user"), createdAt: receivedAt + 25000 };
    if (snapshotOnly) {
      const merged = app.mergeThreadSnapshot({ ...app.thread, turns: [{ ...app.thread.turns[0], items: [echoed] }] });
      app.renderThreadHistory(merged.thread);
    } else {
      app.notify(echoed);
    }
    assert.equal(app.timestamp("canonical-user").dateTime, new Date(echoed.createdAt).toISOString());
    assert.equal(app.timestamp("canonical-user").dataset.timestampSource, "message");
    assert.equal(app.ui.messages.querySelectorAll(".message.user").length, 1);
  }
});

test("mid-task replies do not substitute their local send time for a missing message timestamp", (t) => {
  for (const snapshotOnly of [false, true]) {
    const app = fixture(t);
    const input = user("reply", "Continue").content;
    app.state.pendingSteers.set("reply", {
      id: "reply", threadId: "chat", turnId: "turn", input, text: "Continue", attachments: [],
      knownUserIds: new Set(),
    });
    if (snapshotOnly) {
      const merged = app.mergeThreadSnapshot({ ...app.thread, turns: [{ ...app.thread.turns[0], items: [user("canonical-reply", "Continue")] }] });
      app.renderThreadHistory(merged.thread);
    } else {
      app.notify(user("canonical-reply", "Continue"));
    }
    assertNoTime(app.timestamp("canonical-reply"));
    assert.equal(app.state.pendingSteers.size, 0);
  }
});

test("storage preserves only exact recovered times and tolerates legacy or unavailable storage", (t) => {
  const records = Array.from({ length: 2001 }, (_, index) => [`old-${index}`, receivedAt, "message"]);
  const app = fixture(t, { stored: JSON.stringify(records) });
  assert.equal(app.state.messageTimes.size, 2000);
  app.notify({ ...agent("new"), createdAt: receivedAt });
  assert.equal(app.state.messageTimes.size, 2000);
  assert.equal(app.state.messageTimes.has("old-1"), false);
  assert.equal(JSON.parse(app.window.localStorage.getItem(storageKey)).length, 2000);
  for (const source of ["sent", "received", "turn", "thread"]) {
    const legacy = fixture(t, { stored: JSON.stringify([[JSON.stringify(["chat", "turn", "legacy"]), receivedAt, source]]) });
    legacy.notify(agent("legacy"));
    assertNoTime(legacy.timestamp("legacy"));
  }
  for (const options of [{ stored: "broken json" }, { stored: '{"bad":true}' }, { blockedStorage: true }]) {
    const damaged = fixture(t, options);
    damaged.notify({ ...agent("new"), createdAt: receivedAt });
    assert.equal(damaged.timestamp("new").dateTime, new Date(receivedAt).toISOString());
  }
});
