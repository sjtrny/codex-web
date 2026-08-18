"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeElement {
  constructor(tagName, fragment = false) {
    this.tagName = tagName;
    this.fragment = fragment;
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.hidden = false;
    this.open = false;
    this.disabled = false;
    this.value = "";
    this._textContent = "";
    this._scrollTop = 0;
    this._scrollHeight = null;
    this.clientHeight = 0;
    this.scrollWrites = 0;
    this.attributes = new Map();
    this.focusCount = 0;
    this.inert = false;
    this.classList = {
      add: (...names) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) classes.add(name);
        this.className = [...classes].join(" ");
      },
      remove: (...names) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) classes.delete(name);
        this.className = [...classes].join(" ");
      },
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(" ");
        return enabled;
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
    this.listeners = new Map();
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.fragment) {
        this.append(...node.children.splice(0));
      } else {
        node.parentNode = this;
        this.children.push(node);
      }
    }
  }

  insertBefore(node, reference) {
    const index = this.children.indexOf(reference);
    if (index < 0) throw new Error("Reference node is not a child");
    const nodes = node.fragment ? node.children.splice(0) : [node];
    for (const child of nodes) {
      if (child.parentNode) child.remove();
      child.parentNode = this;
    }
    this.children.splice(index, 0, ...nodes);
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  querySelector(selector) {
    const className = selector.startsWith(".") ? selector.slice(1) : null;
    for (const child of this.children) {
      if (className && child.className.split(/\s+/).includes(className)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(
      (child) => child !== this,
    );
    this.parentNode = null;
  }

  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  focus() {
    this.focusCount += 1;
  }

  showModal() {
    this.open = true;
    this.setAttribute("open", "");
  }

  close() {
    this.open = false;
    this.removeAttribute("open");
  }

  set textContent(value) {
    this._textContent = String(value);
  }

  get textContent() {
    return this._textContent;
  }

  get scrollHeight() {
    return this._scrollHeight ?? this.children.length;
  }

  set scrollTop(value) {
    this._scrollTop = value;
    this.scrollWrites += 1;
  }

  get scrollTop() {
    return this._scrollTop;
  }
}

const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  },
  createElement(tagName) {
    return new FakeElement(tagName);
  },
  createDocumentFragment() {
    return new FakeElement("fragment", true);
  },
};
globalThis.CODEX_WEB_TEST = true;

const script = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
vm.runInThisContext(script, { filename: "app.js" });

const {
  MAX_ACTIVITY_CHARS,
  PRESENT_THRESHOLD_PX,
  THREAD_CACHE_LIMIT,
  THREAD_LIST_PARAMS,
  beginNewThread,
  buildTurnInput,
  cacheItemUpdate,
  cacheThreadSnapshot,
  cacheTurnUpdate,
  cachedThread,
  handleNotification,
  handleMessagesScroll,
  inputText,
  jumpToPresent,
  normalizeChatSettings,
  pendingPromptText,
  promptKeydown,
  renderThreadHistory,
  renderThinkingIndicator,
  renderLocalPrompt,
  renderThemeControl,
  renderThreads,
  selectedThreadBusy,
  selectedTurnId,
  setThreadActivity,
  setSidebarOpen,
  setPreferencesOpen,
  sortThreadsByActivity,
  state,
  threadActivityTimestamp,
  threadSettingsParams,
  turnSettingsParams,
  ui,
  updateControls,
  upsertMessage,
} = globalThis.CodexWebTest;

globalThis.CodexTheme = {
  effectiveTheme: () => "dark",
  preference: () => "system",
};
renderThemeControl();
assert.equal(ui.themeSystem.getAttribute("aria-pressed"), "true");
assert.equal(ui.themeLight.getAttribute("aria-pressed"), "false");
assert.equal(ui.themeDark.getAttribute("aria-pressed"), "false");
assert.equal(ui.themeSummary.textContent, "Following the browser / OS setting (Dark).");

setPreferencesOpen(true);
assert.equal(ui.preferencesDialog.open, true);
assert.equal(ui.preferencesToggle.getAttribute("aria-expanded"), "true");
setPreferencesOpen(false);
assert.equal(ui.preferencesDialog.open, false);
assert.equal(ui.preferencesToggle.getAttribute("aria-expanded"), "false");
assert.equal(ui.preferencesToggle.focusCount, 1);

const items = Array.from({ length: 400 }, (_, index) => ({
  id: `reasoning-${index}`,
  type: "reasoning",
  summary: [],
}));
items.push(
  {
    id: "user",
    type: "userMessage",
    content: [{ type: "text", text: "hello" }],
  },
  {
    id: "command",
    type: "commandExecution",
    command: "large-output",
    status: "completed",
    aggregatedOutput: "x".repeat(MAX_ACTIVITY_CHARS * 4),
  },
  { id: "agent", type: "agentMessage", text: "done" },
);

renderThreadHistory({
  id: "history-thread",
  status: { type: "idle" },
  turns: [{ id: "turn", status: "completed", items }],
});

assert.equal(state.items.size, 3, "empty reasoning entries should be omitted");
assert.equal(ui.messages.children.length, 4, "history should contain useful entries and the indicator");
assert.equal(ui.messages.children.at(-1), ui.thinkingIndicator, "indicator stays after chat history");
assert.equal(ui.thinkingIndicator.hidden, true, "idle history should not show thinking");
assert.equal(ui.messages.getAttribute("aria-busy"), "false");
assert.equal(ui.messages.scrollWrites, 1, "history should trigger one final scroll");
assert.equal(ui.jumpPresent.hidden, true, "history starts at the present");
const command = state.items.get("command");
assert.ok(command.body.textContent.includes("characters omitted"));
assert.ok(command.body.textContent.length < MAX_ACTIVITY_CHARS + 100);

ui.messages._scrollHeight = 1000;
ui.messages.clientHeight = 200;
ui.messages._scrollTop = 240;
handleMessagesScroll();
assert.equal(state.followPresent, false, "scrolling up disables automatic following");
const scrolledTop = ui.messages.scrollTop;
const scrolledWrites = ui.messages.scrollWrites;
upsertMessage("live-agent", "agent", "new output below the viewport");
assert.equal(ui.messages.scrollTop, scrolledTop, "new output must preserve reader position");
assert.equal(ui.messages.scrollWrites, scrolledWrites, "new output must not write scrollTop");
assert.equal(ui.jumpPresent.hidden, false, "new off-screen output shows the jump control");

const localPrompt = renderLocalPrompt(
  "local-user",
  "my newly submitted prompt",
  state.threadId,
  state.selectionId,
);
assert.equal(state.followPresent, true, "a local prompt should return to the present");
assert.equal(ui.messages.scrollTop, ui.messages.scrollHeight);
assert.equal(ui.jumpPresent.hidden, true);
assert.equal(state.pendingUser.node, localPrompt);
localPrompt.remove();
state.items.delete("local-user");
state.pendingUser = null;

jumpToPresent();
assert.equal(state.followPresent, true);
assert.equal(ui.messages.scrollTop, ui.messages.scrollHeight);
assert.equal(ui.jumpPresent.hidden, true);

ui.messages._scrollHeight = 1200;
ui.messages._scrollTop = 1200 - ui.messages.clientHeight - PRESENT_THRESHOLD_PX + 1;
handleMessagesScroll();
assert.equal(state.followPresent, true, "the near-bottom threshold keeps following active");
upsertMessage("live-agent", "agent", " and more", true);
assert.equal(ui.messages.scrollTop, ui.messages.scrollHeight, "near-bottom output follows the present");
assert.equal(ui.jumpPresent.hidden, true);

ui.messages._scrollHeight = null;
ui.messages.clientHeight = 0;

let submitCount = 0;
let preventCount = 0;
ui.composer.requestSubmit = () => {
  submitCount += 1;
};
const keyEvent = (overrides = {}) => ({
  key: "Enter",
  shiftKey: false,
  isComposing: false,
  preventDefault() {
    preventCount += 1;
  },
  ...overrides,
});
promptKeydown(keyEvent());
assert.equal(submitCount, 1, "Enter should submit");
assert.equal(preventCount, 1, "Enter should suppress the textarea newline");
promptKeydown(keyEvent({ shiftKey: true }));
assert.equal(submitCount, 1, "Shift+Enter should not submit");
assert.equal(preventCount, 1, "Shift+Enter should preserve the textarea newline");
promptKeydown(keyEvent({ isComposing: true }));
assert.equal(submitCount, 1, "IME composition Enter should not submit");

const attachments = [
  {
    image: true,
    name: "screen.png",
    path: "/workspaces/codex-web/uploads/batch/screen.png",
    size: 100,
  },
  {
    image: false,
    name: "notes.txt",
    path: "/workspaces/codex-web/uploads/batch/notes.txt",
    size: 20,
  },
];
const turnInput = buildTurnInput("Inspect these", attachments);
assert.equal(turnInput.length, 2);
assert.equal(turnInput[0].type, "text");
assert.ok(turnInput[0].text.includes(attachments[1].path));
assert.deepEqual(turnInput[1], {
  type: "localImage",
  path: attachments[0].path,
});
assert.equal(
  inputText([turnInput[1]]),
  "[Image: screen.png]",
  "local image history should remain visible",
);
assert.equal(
  pendingPromptText("Inspect these", attachments),
  "Inspect these\n[Image: screen.png]\n[File: notes.txt]",
);

const chatSettings = normalizeChatSettings({
  model: "gpt-5.5",
  effort: "high",
  serviceTier: "priority",
  personality: "friendly",
  summary: "detailed",
  approvalPolicy: "on-request",
  permissions: ":workspace",
  ignored: "not-a-protocol-field",
});
assert.deepEqual(turnSettingsParams(chatSettings), {
  model: "gpt-5.5",
  effort: "high",
  serviceTier: "priority",
  personality: "friendly",
  summary: "detailed",
  approvalPolicy: "on-request",
  permissions: ":workspace",
});
assert.deepEqual(threadSettingsParams(chatSettings), {
  model: "gpt-5.5",
  serviceTier: "priority",
  personality: "friendly",
  approvalPolicy: "on-request",
  permissions: ":workspace",
});
assert.deepEqual(turnSettingsParams(normalizeChatSettings(null)), {});

setSidebarOpen(true);
assert.equal(state.sidebarOpen, true);
assert.equal(ui.sidebar.classList.contains("open"), true);
assert.equal(ui.sidebarScrim.hidden, false);
assert.equal(ui.menu.getAttribute("aria-expanded"), "true");
assert.equal(ui.closeSidebar.focusCount, 1);
setSidebarOpen(false);
assert.equal(ui.sidebar.classList.contains("open"), false);
assert.equal(ui.sidebarScrim.hidden, true);
assert.equal(ui.menu.getAttribute("aria-expanded"), "false");
assert.equal(ui.menu.focusCount, 1);

state.ready = true;
state.threadId = "thread-a";
ui.messages._scrollHeight = 1000;
ui.messages.clientHeight = 200;
ui.messages._scrollTop = 240;
handleMessagesScroll();
const thinkingScrollTop = ui.messages.scrollTop;
const thinkingScrollWrites = ui.messages.scrollWrites;
setThreadActivity("thread-a", "turn-a");
assert.equal(selectedThreadBusy(), true, "selected active thread should be busy");
assert.equal(selectedTurnId(), "turn-a");
assert.equal(ui.send.disabled, true);
assert.equal(ui.stop.disabled, false);
assert.equal(ui.thinkingIndicator.hidden, false, "selected active turn should show thinking");
assert.equal(ui.messages.getAttribute("aria-busy"), "true");
assert.equal(ui.messages.children.at(-1), ui.thinkingIndicator, "visible indicator stays last");
assert.equal(ui.messages.scrollTop, thinkingScrollTop, "thinking must not pull a reader to the bottom");
assert.equal(ui.messages.scrollWrites, thinkingScrollWrites, "thinking must not write scrollTop while reading history");
assert.equal(ui.jumpPresent.hidden, false, "off-screen thinking should offer Jump to present");
upsertMessage("busy-agent", "agent", "response started");
assert.equal(ui.messages.children.at(-1), ui.thinkingIndicator, "streaming output stays before thinking");
assert.equal(ui.messages.scrollTop, thinkingScrollTop, "streaming beside thinking preserves reader position");

state.threadId = "thread-b";
updateControls();
assert.equal(selectedThreadBusy(), false, "background activity must not block another thread");
assert.equal(selectedTurnId(), null);
assert.equal(ui.send.disabled, false, "an idle selected thread can start a turn");
assert.equal(ui.stop.disabled, true, "Stop only targets the selected active thread");
assert.equal(ui.thinkingIndicator.hidden, true, "background work must not mark the selected thread as thinking");
assert.equal(ui.messages.getAttribute("aria-busy"), "false");
ui.messages._scrollHeight = null;
ui.messages.clientHeight = 0;
renderThinkingIndicator();

const unsortedThreads = [
  {
    id: "thread-b",
    name: "Selected work",
    createdAt: 300,
    updatedAt: 400,
    recencyAt: 400,
    status: { type: "idle" },
  },
  {
    id: "thread-a",
    name: "Background work",
    createdAt: 100,
    updatedAt: 350,
    recencyAt: 500,
    status: { type: "idle" },
  },
  {
    id: "thread-c",
    name: "Fallback work",
    createdAt: 200,
    updatedAt: 300,
    status: { type: "idle" },
  },
];
renderThreads(unsortedThreads);
assert.deepEqual(
  state.threads.map((thread) => thread.id),
  ["thread-a", "thread-b", "thread-c"],
  "sidebar threads should be ordered by recent activity",
);
assert.deepEqual(
  unsortedThreads.map((thread) => thread.id),
  ["thread-b", "thread-a", "thread-c"],
  "rendering must not mutate the server response",
);
assert.equal(threadActivityTimestamp(unsortedThreads[1]), 500);
assert.equal(threadActivityTimestamp(unsortedThreads[2]), 300);
assert.deepEqual(sortThreadsByActivity(null), []);
assert.deepEqual(THREAD_LIST_PARAMS, {
  limit: 50,
  sortKey: "recency_at",
  sortDirection: "desc",
});
assert.equal(ui.threads.children[0].classList.contains("running"), true);
assert.equal(ui.threads.children[0].getAttribute("aria-busy"), "true");
assert.equal(ui.threads.children[1].classList.contains("active"), true);

state.ready = false;
handleNotification("turn/started", {
  threadId: "thread-b",
  turn: { id: "turn-b", status: "inProgress" },
});
assert.equal(state.activeTurns.get("thread-b"), "turn-b");
assert.equal(ui.thinkingIndicator.hidden, false, "turn start should show thinking for the selected thread");
handleNotification("turn/completed", {
  threadId: "thread-b",
  turn: { id: "turn-b", status: "completed" },
});
assert.equal(state.activeTurns.has("thread-b"), false);
assert.equal(ui.thinkingIndicator.hidden, true, "turn completion should hide thinking");
assert.equal(state.activeTurns.get("thread-a"), "turn-a", "other active turns must be preserved");

state.threadId = "thread-a";
const previousSelection = state.selectionId;
beginNewThread();
assert.equal(state.selectionId, previousSelection + 1);
assert.equal(state.threadId, null, "New thread must be available during background work");
assert.equal(state.activeTurns.get("thread-a"), "turn-a", "background turn must keep running");
assert.equal(ui.notice.textContent, "", "no stop-before-switch warning should be shown");

state.ready = true;
state.submittingViews.add(state.selectionId);
updateControls();
assert.equal(ui.send.disabled, true, "the view currently starting a turn stays locked");
assert.equal(ui.thinkingIndicator.hidden, false, "submission should show thinking before a turn id exists");
state.selectionId += 1;
updateControls();
assert.equal(ui.send.disabled, false, "a different view is not locked by the submission");
assert.equal(ui.thinkingIndicator.hidden, true, "switching views should hide another view's submission");
state.submittingViews.clear();

state.connectionGeneration = 3;
const cacheEntry = cacheThreadSnapshot({
  id: "cached-thread",
  cwd: "/workspaces/example-project",
  status: { type: "idle" },
  turns: [],
});
assert.equal(cacheEntry.generation, 3);
cacheTurnUpdate("cached-thread", {
  id: "cached-turn",
  status: "inProgress",
  items: [],
});
cacheItemUpdate({
  threadId: "cached-thread",
  turnId: "cached-turn",
  item: {
    id: "cached-user",
    type: "userMessage",
    content: [{ type: "text", text: "cached prompt" }],
  },
});
cacheItemUpdate({
  threadId: "cached-thread",
  turnId: "cached-turn",
  item: { id: "cached-agent", type: "agentMessage", text: "cached answer" },
});
handleNotification("item/agentMessage/delta", {
  threadId: "cached-thread",
  turnId: "cached-turn",
  itemId: "cached-agent",
  delta: " streamed",
});
assert.deepEqual(
  cachedThread("cached-thread").thread.turns[0].items.map((item) => item.id),
  ["cached-user", "cached-agent"],
);
assert.equal(
  cachedThread("cached-thread").thread.turns[0].items[1].text,
  "cached answer streamed",
  "background deltas should update cached threads",
);
cacheTurnUpdate("cached-thread", {
  id: "cached-turn",
  status: "completed",
  items: [],
});
assert.equal(
  cachedThread("cached-thread").thread.turns[0].items.length,
  2,
  "a sparse turn completion must not discard cached streamed items",
);
for (let index = 0; index < THREAD_CACHE_LIMIT + 2; index += 1) {
  cacheThreadSnapshot({ id: `lru-${index}`, turns: [] });
}
assert.ok(state.threadCache.size <= THREAD_CACHE_LIMIT, "thread cache should remain bounded");
console.log("render-and-settings=ok");
