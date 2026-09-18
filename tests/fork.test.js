"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

function fixture(t) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8"), {
    url: "http://localhost/?thread=source",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.CODEX_WEB_TEST = true;
  window.matchMedia = () => ({ matches: false });
  window.eval(fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8"));
  const api = window.CodexWebTest;
  const { state, ui } = api;
  const source = {
    id: "source", name: "Original chat", cwd: "/workspaces/project",
    status: { type: "idle" }, createdAt: 1,
    turns: [
      {
        id: "turn-one", status: "completed", items: [
          { id: "user-one", type: "userMessage", content: [{ type: "text", text: "First question" }] },
          { id: "commentary-one", type: "agentMessage", phase: "commentary", text: "Working on it" },
          { id: "answer-one", type: "agentMessage", phase: "final_answer", text: "First answer" },
        ],
      },
      {
        id: "turn-two", status: "completed", items: [
          { id: "user-two", type: "userMessage", content: [{ type: "text", text: "Second question" }] },
          { id: "answer-two", type: "agentMessage", phase: "final_answer", text: "Second answer" },
        ],
      },
    ],
  };
  const threads = new Map([[source.id, source]]);
  const calls = [];
  state.ws = {
    readyState: window.WebSocket.OPEN,
    send(raw) {
      const message = JSON.parse(raw);
      calls.push(message);
      if (message.method === "thread/fork") return;
      const result = message.method === "thread/resume"
        ? { thread: structuredClone(threads.get(message.params.threadId)) }
        : { data: message.method === "thread/list" ? [...threads.values()] : [] };
      queueMicrotask(() => api.handleMessage({ id: message.id, result }));
    },
  };
  state.ready = true;
  state.threadId = source.id;
  state.composerKey = api.threadComposerKey(source.id);
  api.cacheThreadSnapshot(structuredClone(source));
  api.renderThreads([source]);
  api.renderThreadHistory(source);

  const entry = (itemId, turnId, threadId = "source") => (
    state.items.get(api.renderedItemKey(itemId, threadId, turnId))
  );
  function completeFork(id = `fork-${threads.size}`) {
    const request = calls.findLast((call) => call.method === "thread/fork");
    const sourceThread = threads.get(request.params.threadId);
    const index = sourceThread.turns.findIndex((turn) => turn.id === request.params.lastTurnId);
    const thread = {
      ...structuredClone(sourceThread), id, forkedFromId: request.params.threadId,
      turns: structuredClone(sourceThread.turns.slice(0, index + 1)), status: { type: "idle" },
    };
    threads.set(id, thread);
    api.handleMessage({ id: request.id, result: { thread } });
    return thread;
  }
  return { ...api, calls, completeFork, entry, source, threads, window, ui };
}

test("only final Codex responses get an accessible toolbar below the response", (t) => {
  const app = fixture(t);
  const users = [
    app.entry("user-one", "turn-one"),
    app.entry("user-two", "turn-two"),
  ];
  const commentary = app.entry("commentary-one", "turn-one");
  const finalResponses = [
    app.entry("answer-one", "turn-one"),
    app.entry("answer-two", "turn-two"),
  ];

  assert.ok(users.every((entry) => entry && entry.forkButton === null));
  assert.equal(commentary.phase, "commentary");
  assert.equal(commentary.forkButton, null);
  assert.equal(commentary.node.querySelector(".message-toolbar"), null);
  assert.equal(app.ui.messages.querySelectorAll(".message.user .message-toolbar").length, 0);
  assert.equal(app.ui.messages.querySelectorAll(".message-toolbar").length, 2);
  for (const entry of finalResponses) {
    assert.equal(entry.phase, "final_answer");
    assert.ok(entry?.responseToolbar && !entry.responseToolbar.hidden);
    assert.equal(entry.responseToolbar.getAttribute("role"), "toolbar");
    assert.equal(entry.responseToolbar.getAttribute("aria-label"), "Codex response actions");
    assert.equal(entry.forkButton.getAttribute("aria-label"), "Fork from this Codex response");
    assert.equal(entry.forkButtonLabel.textContent, "Fork");
    assert.ok(entry.forkButton.querySelector("svg"));
    assert.equal(entry.node.lastElementChild, entry.responseToolbar);
  }
  assert.equal(app.ui.title.parentElement.querySelector("#fork-thread"), null);
});

test("live commentary never gains a toolbar and a late final phase does", (t) => {
  const app = fixture(t);
  app.cacheTurnUpdate("source", { id: "live-turn", status: "inProgress", items: [] });

  app.handleNotification("item/started", {
    threadId: "source",
    turnId: "live-turn",
    item: { id: "live-commentary", type: "agentMessage", phase: "commentary", text: "" },
  });
  app.handleNotification("item/agentMessage/delta", {
    threadId: "source", turnId: "live-turn", itemId: "live-commentary", delta: "Still working",
  });
  const commentary = app.entry("live-commentary", "live-turn");
  assert.equal(commentary.text, "Still working");
  assert.equal(commentary.forkButton, null);
  assert.equal(commentary.node.querySelector(".message-toolbar"), null);

  app.handleNotification("item/agentMessage/delta", {
    threadId: "source", turnId: "live-turn", itemId: "late-final", delta: "Final",
  });
  const finalResponse = app.entry("late-final", "live-turn");
  assert.equal(finalResponse.forkButton, null);
  app.handleNotification("item/completed", {
    threadId: "source",
    turnId: "live-turn",
    item: { id: "late-final", type: "agentMessage", phase: "final_answer", text: "Final answer" },
  });
  assert.equal(finalResponse.phase, "final_answer");
  assert.ok(finalResponse.responseToolbar);
  assert.equal(finalResponse.node.lastElementChild, finalResponse.responseToolbar);
  assert.equal(finalResponse.forkButton.disabled, true);
});

test("a response fork opens a separate chat and preserves the original draft", async (t) => {
  const app = fixture(t);
  const { state, ui, calls } = app;
  const sourceHistory = JSON.stringify(app.cachedThread("source").thread);
  state.settingsByThread.set("source", { model: "test-model", effort: "high", cwd: "/workspaces/next" });
  ui.prompt.value = "Unsent original draft";
  state.attachments = [{ name: "notes.txt", path: "/uploads/unsent.txt", size: 24 }];
  const entry = app.entry("answer-two", "turn-two");

  const pending = app.forkFromResponse(entry);
  assert.equal(entry.forkButton.disabled, true);
  assert.equal(entry.forkButtonLabel.textContent, "Forking…");
  assert.equal(entry.forkButton.getAttribute("aria-busy"), "true");
  assert.equal(ui.send.disabled, true);
  await app.forkFromResponse(entry);
  assert.equal(calls.filter((call) => call.method === "thread/fork").length, 1);
  assert.deepEqual(calls[0].params, {
    threadId: "source", lastTurnId: "turn-two", deferGoalContinuation: true,
  });
  ui.prompt.value = "Still editing the original draft";
  const fork = app.completeFork("response-fork");
  await pending;

  assert.deepEqual(fork.turns.map((turn) => turn.id), ["turn-one", "turn-two"]);
  assert.equal(state.threadId, "response-fork");
  assert.equal(app.window.location.search, "?thread=response-fork");
  assert.equal(ui.prompt.value, "");
  assert.equal(state.attachments.length, 0);
  assert.equal(ui.title.textContent, "Fork: Original chat");
  assert.equal(ui.cwd.value, "/workspaces/next");
  assert.notEqual(state.settingsByThread.get("source"), state.settingsByThread.get("response-fork"));
  assert.equal(JSON.stringify(app.cachedThread("source").thread), sourceHistory);
  assert.ok(calls.every((call) => ["thread/fork", "thread/resume", "thread/list", "permissionProfile/list"].includes(call.method)));
  assert.equal(state.forkingThreads.size, 0);
  await app.openThread("source");
  assert.equal(ui.prompt.value, "Still editing the original draft");
  assert.equal(state.attachments[0].path, "/uploads/unsent.txt");
});

test("a final response forks at its completed turn boundary", async (t) => {
  const app = fixture(t);
  const commentary = app.entry("commentary-one", "turn-one");
  await app.forkFromResponse(commentary);
  assert.equal(app.calls.length, 0);
  const pending = app.forkFromResponse(app.entry("answer-one", "turn-one"));
  assert.deepEqual(app.calls[0].params, {
    threadId: "source", lastTurnId: "turn-one", deferGoalContinuation: true,
  });
  const fork = app.completeFork("answer-fork");
  await pending;
  assert.deepEqual(fork.turns.map((turn) => turn.id), ["turn-one"]);
  assert.deepEqual(
    fork.turns[0].items.map((item) => item.id),
    ["user-one", "commentary-one", "answer-one"],
    "app-server forks at the containing turn boundary",
  );
});

test("a failed response fork preserves the chat and can be retried", async (t) => {
  const app = fixture(t);
  const entry = app.entry("answer-two", "turn-two");
  app.ui.prompt.value = "Keep this draft";
  const pending = app.forkFromResponse(entry);
  app.handleMessage({ id: app.calls[0].id, error: { message: "Fork unavailable" } });
  await pending;
  assert.equal(app.state.threadId, "source");
  assert.equal(app.ui.prompt.value, "Keep this draft");
  assert.match(app.ui.notice.textContent, /Unable to fork from response: Fork unavailable/);
  assert.equal(entry.forkButton.disabled, false);
  assert.equal(entry.forkButtonLabel.textContent, "Fork");
  const retry = app.forkFromResponse(entry);
  app.completeFork("retry-fork");
  await retry;
  assert.equal(app.state.threadId, "retry-fork");
});

test("a late response fork stays in the sidebar without replacing another draft", async (t) => {
  const app = fixture(t);
  const pending = app.forkFromResponse(app.entry("answer-two", "turn-two"));
  app.beginNewThread();
  app.ui.prompt.value = "New unrelated draft";
  app.completeFork("late-fork");
  await pending;
  assert.equal(app.state.threadId, null);
  assert.equal(app.ui.prompt.value, "New unrelated draft");
  assert.ok(app.state.threads.some((thread) => thread.id === "late-fork"));
});

test("an active turn shows only a disabled Codex response fork", async (t) => {
  const app = fixture(t);
  const activeSource = structuredClone(app.source);
  activeSource.status = { type: "active" };
  activeSource.turns[1].status = "inProgress";
  app.threads.set("source", activeSource);
  app.cacheThreadSnapshot(activeSource);
  app.renderThreadHistory(activeSource);
  const user = app.entry("user-two", "turn-two");
  const response = app.entry("answer-two", "turn-two");

  assert.equal(user.forkButton, null);
  assert.equal(user.node.querySelector(".message-toolbar"), null);
  assert.equal(response.responseToolbar.hidden, false);
  assert.equal(response.forkButton.disabled, true);
  assert.match(response.forkButton.title, /finishes this turn/);
  await app.forkFromResponse(user);
  await app.forkFromResponse(response);
  assert.equal(app.calls.length, 0);
});

test("response forking is unavailable for ephemeral, unloaded, offline, uploading, or submitting chats", async (t) => {
  const app = fixture(t);
  const entry = app.entry("answer-two", "turn-two");
  for (const condition of ["offline", "uploading", "submitting", "unloaded", "ephemeral"]) {
    app.state.ready = condition !== "offline";
    app.state.uploading = condition === "uploading";
    app.state.submittingThreads.clear();
    if (condition === "submitting") app.state.submittingThreads.add("source");
    app.state.threadId = condition === "unloaded" ? "unloaded" : "source";
    app.cachedThread("source").thread.ephemeral = condition === "ephemeral";
    app.updateControls();
    assert.equal(entry.forkButton.disabled, true, condition);
    await app.forkFromResponse(entry);
  }
  assert.equal(app.calls.length, 0);
});
