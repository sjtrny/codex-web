"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const question = (id = "question") => ({
  id, type: "agentMessage", phase: "final_answer", text: "Which colour?",
  questions: [{ title: "Which colour?", options: ["Blue", "Green"] }],
});
const answer = { id: "answer", type: "userMessage", content: [{ type: "text", text: "Blue" }] };

function fixture(t) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only",
  });
  const { window } = dom;
  window.CODEX_WEB_TEST = true;
  window.matchMedia = () => ({ matches: false });
  window.eval(fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8"));
  const api = window.CodexWebTest;
  const threads = [
    { id: "recent", name: "Recent chat", recencyAt: 400, status: { type: "idle" } },
    { id: "pinned", name: "Pinned chat", recencyAt: 300, status: { type: "idle" } },
    { id: "working", name: "Working chat", recencyAt: 200, status: { type: "active" } },
    { id: "older", name: "Older <chat>", recencyAt: 100, status: { type: "active" } },
  ];
  api.state.threadId = "recent";
  api.state.pinnedThreads.add("pinned");
  api.renderThreads(threads, true);
  const requests = [];
  window.fetch = (url, options) => {
    assert.equal(url, "/api/thread-questions");
    assert.equal(options.cache, "no-store");
    return new Promise((resolve) => requests.push({ method: "thread/questions", params: JSON.parse(options.body), resolve }));
  };
  api.state.ws = { readyState: window.WebSocket.OPEN, send(raw) { requests.push(JSON.parse(raw)); } };
  t.after(() => {
    api.state.ready = false;
    for (const id of api.state.pending.keys()) api.handleMessage({ id, error: { message: "Cleanup" } });
    window.close();
  });
  const link = (id) => api.ui.threads.querySelector(`a[href="${api.threadHref(id)}"]`);
  const badge = (id) => link(id).querySelector(".thread-question");
  const order = () => Array.from(api.ui.threads.querySelectorAll("a"), (node) => new URL(node.href).searchParams.get("thread"));
  const item = (id, value, method = "item/completed") => api.handleNotification(method, {
    threadId: id, turnId: `turn-${id}`, item: value,
  });
  const snapshot = (id, items = []) => ({
    ...threads.find((thread) => thread.id === id),
    turns: [{ id: `turn-${id}`, status: "inProgress", items }],
  });
  const reply = (request, result) => request.resolve
    ? request.resolve({ ok: true, json: async () => result })
    : api.handleMessage({ id: request.id, result });
  const latest = (method, id) => requests.findLast((request) => request.method === method
    && (!id || request.params.threadId === id));
  const refresh = async () => {
    const promise = api.refreshThreads();
    reply(latest("thread/list"), { data: threads, nextCursor: null });
    await promise;
    await tick();
  };
  return { ...api, window, threads, requests, link, badge, order, item, snapshot, reply, latest, refresh };
}

test("background questions show accessible badges and sort above pins without moving focus or drafts", (t) => {
  const app = fixture(t);
  app.ui.prompt.value = "Unsent draft";
  app.link("pinned").focus();
  const focused = app.window.document.activeElement;
  app.item("older", question(), "item/started");
  assert.deepEqual(app.order(), ["older", "pinned", "recent", "working"]);
  assert.equal(app.badge("older").hidden, false);
  assert.equal(app.badge("older").getAttribute("role"), "img");
  assert.equal(app.badge("older").getAttribute("aria-label"), "Question awaiting your reply");
  assert.equal(app.badge("older").title, "Question awaiting your reply");
  assert.equal(app.link("older").querySelector("strong").textContent, "Older <chat>");
  assert.equal(app.window.document.activeElement, focused);
  assert.equal(app.ui.prompt.value, "Unsent draft");
  assert.equal(app.state.threadId, "recent");
  assert.equal(app.ui.pendingQuestions.hidden, true);
  assert.equal(app.state.threadCache.size, 0, "unopened chats do not need full cached histories");

  app.item("working", question());
  assert.deepEqual(app.order(), ["working", "older", "pinned", "recent"]);
  app.setThreadPinned("older", true);
  assert.deepEqual(app.order(), ["older", "working", "pinned", "recent"]);
  assert.deepEqual(app.requests, []);
});

test("sparse question updates survive progress, and replies, final answers and task endings clear badges", (t) => {
  for (const ending of ["reply", "final", "complete", "idle"]) {
    const app = fixture(t);
    app.item("older", question());
    app.item("older", { id: "question", type: "agentMessage", text: "Which colour?" });
    app.item("older", { id: "progress", type: "agentMessage", phase: "commentary", text: "Still working." });
    assert.equal(app.badge("older").hidden, false);
    app.renderThreads(app.threads, true);
    assert.equal(app.badge("older").hidden, false, "list refreshes cannot discard live questions");
    if (ending === "reply") app.item("older", answer);
    if (ending === "final") app.item("older", { id: "final", type: "agentMessage", phase: "final_answer", text: "Done." });
    if (ending === "complete") app.handleNotification("turn/completed", { threadId: "older", turn: { id: "turn-older", status: "completed" } });
    if (ending === "idle") app.handleNotification("thread/status/changed", { threadId: "older", status: { type: "idle" } });
    assert.equal(app.badge("older").hidden, true, ending);
    assert.deepEqual(app.order(), ["pinned", "recent", "working", "older"]);
  }
});

test("failed replies retain badges; accepted replies clear only questions present when sent", async (t) => {
  const app = fixture(t);
  app.cacheThreadSnapshot(app.snapshot("older", [question()]));
  app.state.threadId = "older";
  app.state.composerKey = app.threadComposerKey("older");
  app.renderThreadHistory(app.cachedThread("older").thread);
  app.state.ready = true;
  app.ui.prompt.value = "Blue";
  let submission = app.submitPrompt({ preventDefault() {} });
  app.handleMessage({ id: app.latest("turn/steer").id, error: { message: "Try again" } });
  await submission;
  assert.equal(app.badge("older").hidden, false);
  assert.equal(app.ui.prompt.value, "Blue");
  app.reply(app.latest("thread/resume"), { thread: app.snapshot("older", [question()]) });
  await tick();
  submission = app.submitPrompt({ preventDefault() {} });
  app.item("older", question("new-question"));
  app.reply(app.latest("turn/steer"), { turnId: "turn-older" });
  await submission;
  assert.equal(app.badge("older").hidden, false, "a new question during submission still needs an answer");
  assert.equal(app.ui.pendingQuestionsList.children.length, 1);
  app.reply(app.latest("thread/resume"), { thread: app.snapshot("older", [question(), question("new-question")]) });
  await tick();
  app.ui.prompt.value = "Green";
  submission = app.submitPrompt({ preventDefault() {} });
  app.reply(app.latest("turn/steer"), { turnId: "turn-older" });
  await submission;
  assert.equal(app.badge("older").hidden, true, "accepted replies clear without waiting for the echo");
  assert.deepEqual(app.order(), ["pinned", "recent", "working", "older"]);
  app.reply(app.latest("thread/resume"), { thread: app.snapshot("older", [question(), question("new-question"), answer]) });
  await tick();
});

test("native background requests stay marked until all questions are answered", async (t) => {
  const app = fixture(t);
  app.handleServerRequest({ id: "native", method: "item/tool/requestUserInput", params: {
    threadId: "older", turnId: "turn-older", isBlocking: false,
    questions: [{ id: "one", question: "Which colour?" }, { id: "two", question: "Which size?" }],
  } });
  assert.equal(app.badge("older").hidden, false);
  assert.equal(app.order()[0], "older");
  app.state.threadId = "older";
  app.state.ready = true;
  app.ui.prompt.value = "Blue";
  await app.submitPrompt({ preventDefault() {} });
  assert.equal(app.badge("older").hidden, false);
  app.state.ws.send = () => { throw new Error("Offline"); };
  app.ui.prompt.value = "Large";
  await app.submitPrompt({ preventDefault() {} });
  assert.equal(app.badge("older").hidden, false);
  app.state.ws.send = (raw) => app.requests.push(JSON.parse(raw));
  await app.submitPrompt({ preventDefault() {} });
  assert.equal(app.badge("older").hidden, true);
  assert.deepEqual(app.requests.at(-1).result.answers, { one: { answers: ["Blue"] }, two: { answers: ["Large"] } });
});

test("list waiting flags work before histories load and approval flags do not mark questions", (t) => {
  const app = fixture(t);
  app.threads[2].status.activeFlags = ["waitingOnApproval"];
  app.threads[3].status.activeFlags = ["waitingOnUserInput"];
  app.renderThreads(app.threads, true);
  assert.equal(app.badge("older").hidden, false);
  assert.equal(app.badge("working").hidden, true);
  assert.equal(app.order()[0], "older");
  app.handleNotification("thread/status/changed", { threadId: "older", status: { type: "idle" } });
  app.renderThreads(app.threads, true);
  assert.equal(app.badge("older").hidden, true, "a stale list cannot restore a completed question");
});

test("reload discovers unopened async questions with read-only requests and retains them after cache eviction", async (t) => {
  const app = fixture(t);
  app.state.ready = true;
  await app.refresh();
  app.reply(app.latest("thread/questions", "working"), { threadId: "working", turnId: "turn-working", pending: false });
  await tick();
  const read = app.latest("thread/questions", "older");
  assert.deepEqual(read.params, { threadId: "older" });
  app.reply(read, { threadId: "older", turnId: "turn-older", pending: true });
  await tick();
  assert.equal(app.badge("older").hidden, false);
  assert.equal(app.order()[0], "older");
  assert.equal(app.state.threadCache.size, 0);
  const count = app.requests.filter((request) => request.method === "thread/questions").length;
  await app.refresh();
  assert.equal(app.requests.filter((request) => request.method === "thread/questions").length, count);
  assert.equal(app.requests.some((request) => request.method === "thread/resume"), false);
  app.cacheThreadSnapshot(app.snapshot("older", [question()]));
  app.state.threadCache.delete("older");
  app.renderThreads(app.threads);
  assert.equal(app.badge("older").hidden, false);
});

test("stale status reads cannot replace newer questions or resurrect finished tasks", async (t) => {
  for (const completed of [false, true]) {
    const app = fixture(t);
    app.state.ready = true;
    await app.refresh();
    const read = app.latest("thread/questions", "working");
    app.item("working", question());
    if (completed) app.handleNotification("turn/completed", { threadId: "working", turn: { id: "turn-working", status: "completed" } });
    app.reply(read, { threadId: "working", turnId: "turn-working", pending: completed });
    await tick();
    assert.equal(app.badge("working").hidden, completed);
  }
});

test("reconnect replaces cached background questions answered while offline", async (t) => {
  const app = fixture(t);
  app.cacheThreadSnapshot(app.snapshot("working", [question()]));
  app.renderThreads(app.threads);
  assert.equal(app.badge("working").hidden, false);
  app.state.connectionGeneration += 1;
  app.state.activeTurns.clear();
  app.state.liveThreadStatuses.clear();
  app.state.ready = true;
  await app.refresh();
  app.reply(app.latest("thread/questions", "working"), { threadId: "working", turnId: "turn-working", pending: false });
  await tick();
  assert.equal(app.badge("working").hidden, true);
  assert.deepEqual(app.order(), ["pinned", "recent", "working", "older"]);
});

test("reconnect clears native background requests for tasks that ended offline", async (t) => {
  const app = fixture(t);
  app.handleServerRequest({ id: "offline", method: "item/tool/requestUserInput", params: {
    threadId: "older", turnId: "turn-older", questions: [{ id: "colour", question: "Which colour?" }],
  } });
  app.disconnectRequests();
  app.state.activeTurns.clear();
  app.state.liveThreadStatuses.clear();
  app.state.connectionGeneration += 1;
  app.threads[3].status = { type: "idle" };
  app.state.ready = true;
  await app.refresh();
  assert.equal(app.badge("older").hidden, true);
  assert.equal(app.state.requestCards.size, 0);
});

test("repeated turn-start snapshots preserve live questions in an unopened chat", (t) => {
  const app = fixture(t);
  app.item("older", question());
  app.handleNotification("turn/started", { threadId: "older", turn: { id: "turn-older", status: "inProgress", items: [] } });
  assert.equal(app.badge("older").hidden, false);
  assert.equal(app.order()[0], "older");
  app.handleNotification("turn/started", { threadId: "older", turn: { id: "next-turn", status: "inProgress", items: [] } });
  assert.equal(app.badge("older").hidden, true);
});

test("compact badges survive metadata-only loading and clear on live replies", async (t) => {
  const app = fixture(t);
  app.state.ready = true;
  await app.refresh();
  app.reply(app.latest("thread/questions", "working"), { threadId: "working", turnId: "turn-working", pending: true });
  await tick();
  app.state.historyChunkBytes = 1000;
  app.cacheThreadSnapshot({ id: "working", status: { type: "active" }, turns: [] });
  app.handleNotification("turn/started", { threadId: "working", turn: { id: "turn-working", status: "inProgress", items: [] } });
  assert.equal(app.badge("working").hidden, false);
  app.item("working", answer);
  assert.equal(app.badge("working").hidden, true);
});

test("failed summary requests preserve known badges and can be retried", async (t) => {
  const app = fixture(t);
  app.cacheThreadSnapshot(app.snapshot("working", [question()]));
  app.state.connectionGeneration += 1;
  app.state.ready = true;
  await app.refresh();
  app.latest("thread/questions", "working").resolve({ ok: false });
  await tick();
  assert.equal(app.badge("working").hidden, false);
  await app.refresh();
  assert.equal(app.requests.filter((request) => request.method === "thread/questions" && request.params.threadId === "working").length, 2);
});
