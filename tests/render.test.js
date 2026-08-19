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
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this._textContent = "";
    this._scrollTop = 0;
    this._scrollHeight = null;
    this.clientHeight = 0;
    this.scrollWrites = 0;
    this.attributes = new Map();
    this.focusCount = 0;
    this.inert = false;
    this.title = "";
    this._left = 0;
    this.pointerCaptures = new Set();
    const styles = new Map();
    this.style = {
      setProperty: (name, value) => styles.set(name, String(value)),
      getPropertyValue: (name) => styles.get(name) ?? "",
      removeProperty: (name) => styles.delete(name),
    };
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

  contains(node) {
    if (this === node) return true;
    return this.children.some((child) => child.contains(node));
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
    globalThis.document.activeElement = this;
  }

  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  getBoundingClientRect() {
    return { left: this._left };
  }

  setPointerCapture(pointerId) {
    this.pointerCaptures.add(pointerId);
  }

  releasePointerCapture(pointerId) {
    this.pointerCaptures.delete(pointerId);
  }

  hasPointerCapture(pointerId) {
    return this.pointerCaptures.has(pointerId);
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
let mobileViewport = false;
const storedValues = new Map();
globalThis.document = {
  activeElement: null,
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
globalThis.window = {
  innerWidth: 1280,
  matchMedia() {
    return { matches: mobileViewport };
  },
  setTimeout,
  clearTimeout,
};
globalThis.localStorage = {
  getItem(key) {
    return storedValues.get(key) ?? null;
  },
  setItem(key, value) {
    storedValues.set(key, String(value));
  },
  removeItem(key) {
    storedValues.delete(key);
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
  DEFAULT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  SIDEBAR_SWIPE_OPEN_DISTANCE,
  THREAD_QUERY_PARAM,
  beginNewThread,
  buildTurnInput,
  cacheItemUpdate,
  cacheThreadSnapshot,
  cacheTurnUpdate,
  cachedThread,
  mergeOrderedById,
  mergeThreadSnapshot,
  handleNotification,
  handleMessagesScroll,
  handlePromptInput,
  inputText,
  isSearchSelectionCurrent,
  jumpToPresent,
  normalizeSearchResponse,
  normalizeChatSettings,
  parseSearchDate,
  pendingPromptText,
  renderSearchResults,
  promptKeydown,
  renderThreadHistory,
  renderThinkingIndicator,
  renderLocalPrompt,
  renderThemeControl,
  renderThreads,
  selectedThreadBusy,
  selectedTurnId,
  applyPreferredSidebarWidth,
  cancelSidebarSwipe,
  cancelSidebarResize,
  clampSidebarWidth,
  finishSidebarResize,
  finishSidebarSwipe,
  handleSidebarCaptureLoss,
  handleSidebarScrimClick,
  handleSidebarScrimPointerDown,
  handleSidebarSwipeCaptureLoss,
  initializeSidebarLayout,
  moveSidebarResize,
  moveSidebarSwipe,
  resizeSidebarFromKeyboard,
  setSidebarCollapsed,
  setThreadActivity,
  setSidebarOpen,
  setSidebarWidth,
  setThreadPromptHistory,
  sidebarMaxWidth,
  startSidebarResize,
  startSidebarSwipe,
  syncSidebarBreakpoint,
  syncSidebarVisibility,
  toggleSidebar,
  setSearchOpen,
  setPreferencesOpen,
  sortThreadsByActivity,
  state,
  threadActivityTimestamp,
  threadComposerKey,
  threadHref,
  threadIdFromSearch,
  threadSettingsParams,
  turnSettingsParams,
  ui,
  updateControls,
  upsertMessage,
  validateSearchDates,
  restoreComposerDraft,
  saveComposerDraft,
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

state.selectionId = 10;
state.threadId = "history-a";
state.composerKey = threadComposerKey(state.threadId, state.selectionId);
setThreadPromptHistory({
  id: "history-a",
  turns: [
    {
      items: [
        {
          id: "history-a-first",
          type: "userMessage",
          content: [{ type: "text", text: "first prompt" }],
        },
        { id: "history-a-agent", type: "agentMessage", text: "answer" },
        {
          id: "history-a-second",
          type: "userMessage",
          content: [{ type: "text", text: "second prompt" }],
        },
      ],
    },
  ],
});
ui.prompt.value = "unfinished draft";
ui.prompt.setSelectionRange(ui.prompt.value.length, ui.prompt.value.length);
handlePromptInput();
let historyPreventCount = 0;
const historyKeyEvent = (key, overrides = {}) => ({
  key,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  preventDefault() {
    historyPreventCount += 1;
  },
  ...overrides,
});
promptKeydown(historyKeyEvent("ArrowUp"));
assert.equal(ui.prompt.value, "second prompt", "Up should recall the newest prompt in this chat");
promptKeydown(historyKeyEvent("ArrowUp"));
assert.equal(ui.prompt.value, "first prompt", "repeated Up should move backward through prompts");
promptKeydown(historyKeyEvent("ArrowUp"));
assert.equal(ui.prompt.value, "first prompt", "history should stop at the oldest prompt");
promptKeydown(historyKeyEvent("ArrowDown"));
assert.equal(ui.prompt.value, "second prompt", "Down should move toward newer prompts");
promptKeydown(historyKeyEvent("ArrowDown"));
assert.equal(ui.prompt.value, "unfinished draft", "Down past the newest prompt should restore the draft");
assert.equal(historyPreventCount, 5);
promptKeydown(historyKeyEvent("ArrowDown"));
assert.equal(historyPreventCount, 5, "Down should be untouched outside history navigation");

ui.prompt.value = "first line\nsecond line";
ui.prompt.setSelectionRange(ui.prompt.value.length, ui.prompt.value.length);
handlePromptInput();
promptKeydown(historyKeyEvent("ArrowUp"));
assert.equal(ui.prompt.value, "first line\nsecond line", "Up should retain normal textarea behavior below the first line");
assert.equal(historyPreventCount, 5);
ui.prompt.setSelectionRange(0, 0);
promptKeydown(historyKeyEvent("ArrowUp"));
assert.equal(ui.prompt.value, "second prompt", "Up on the first line should enter prompt history");
assert.equal(historyPreventCount, 6);

ui.prompt.value = "draft for chat A";
handlePromptInput();
saveComposerDraft();
state.threadId = "history-b";
state.composerKey = threadComposerKey(state.threadId, state.selectionId);
restoreComposerDraft();
assert.equal(ui.prompt.value, "", "a different chat should start with its own empty draft");
ui.prompt.value = "draft for chat B";
handlePromptInput();
state.threadId = "history-a";
state.composerKey = threadComposerKey(state.threadId, state.selectionId);
restoreComposerDraft();
assert.equal(ui.prompt.value, "draft for chat A", "switching back should restore the original chat draft");
state.threadId = "history-b";
state.composerKey = threadComposerKey(state.threadId, state.selectionId);
restoreComposerDraft();
assert.equal(ui.prompt.value, "draft for chat B", "each chat should retain an independent draft");

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

assert.equal(DEFAULT_SIDEBAR_WIDTH, 260);
assert.equal(clampSidebarWidth(100, 1280), MIN_SIDEBAR_WIDTH);
assert.equal(clampSidebarWidth(999, 1280), MAX_SIDEBAR_WIDTH);
assert.equal(sidebarMaxWidth(761), 321, "desktop width must leave room for chat");
assert.equal(clampSidebarWidth(500, 761), 321);

setSidebarWidth(320, true);
assert.equal(state.sidebarWidth, 320);
assert.equal(ui.shell.style.getPropertyValue("--sidebar-width"), "320px");
assert.equal(ui.sidebarResizer.getAttribute("aria-valuenow"), "320");
assert.equal(ui.sidebarResizer.getAttribute("aria-valuetext"), "320 pixels");
assert.equal(storedValues.get(SIDEBAR_WIDTH_STORAGE_KEY), "320");

setSidebarCollapsed(true, false);
assert.equal(state.sidebarCollapsed, true);
assert.equal(ui.shell.classList.contains("sidebar-collapsed"), true);
assert.equal(ui.sidebar.inert, false);
assert.equal(ui.sidebar.getAttribute("aria-hidden"), null);
assert.equal(ui.sidebarContent.hidden, true);
assert.equal(ui.sidebarContent.inert, true);
assert.equal(ui.sidebarContent.getAttribute("aria-hidden"), "true");
assert.equal(ui.sidebarResizer.hidden, true);
assert.equal(ui.sidebarToggle.hidden, false);
assert.equal(ui.sidebarToggle.getAttribute("aria-expanded"), "false");
assert.equal(
  ui.sidebarToggle.getAttribute("aria-label"),
  "Expand conversations sidebar",
);
assert.equal(ui.sidebarToggle.title, "Expand conversations sidebar");
assert.equal(ui.menu.hidden, true);
assert.equal(ui.menu.textContent, "Chats");
setSidebarCollapsed(false, false);
assert.equal(ui.shell.classList.contains("sidebar-collapsed"), false);
assert.equal(ui.sidebar.inert, false);
assert.equal(ui.sidebar.getAttribute("aria-hidden"), null);
assert.equal(ui.sidebarContent.hidden, false);
assert.equal(ui.sidebarContent.inert, false);
assert.equal(ui.sidebarContent.getAttribute("aria-hidden"), null);
assert.equal(ui.sidebarResizer.hidden, false);
assert.equal(ui.sidebarToggle.getAttribute("aria-expanded"), "true");
assert.equal(
  ui.sidebarToggle.getAttribute("aria-label"),
  "Collapse conversations sidebar",
);
assert.equal(ui.sidebarToggle.title, "Collapse conversations sidebar");
assert.equal(ui.menu.hidden, true);

ui.searchChats.focus();
const toggleFocusBeforeContentCollapse = ui.sidebarToggle.focusCount;
setSidebarCollapsed(true, false);
assert.equal(
  ui.sidebarToggle.focusCount,
  toggleFocusBeforeContentCollapse + 1,
  "collapsing must move focus out of the hidden conversation content",
);
setSidebarCollapsed(false, false);

ui.sidebarResizer.focus();
const toggleFocusBeforeResizerCollapse = ui.sidebarToggle.focusCount;
setSidebarCollapsed(true, false);
assert.equal(
  ui.sidebarToggle.focusCount,
  toggleFocusBeforeResizerCollapse + 1,
  "collapsing must move focus off the hidden resize separator",
);
setSidebarCollapsed(false, false);

setSearchOpen(true, false);
const searchChatsFocusBeforeClose = ui.searchChats.focusCount;
setSearchOpen(false);
assert.equal(ui.searchChats.focusCount, searchChatsFocusBeforeClose + 1);
setSidebarCollapsed(true, false);
setSearchOpen(true, false);
const railFocusBeforeSearchClose = ui.sidebarToggle.focusCount;
setSearchOpen(false);
assert.equal(ui.sidebarToggle.focusCount, railFocusBeforeSearchClose + 1);
setSidebarCollapsed(false, false);

let prevented = false;
resizeSidebarFromKeyboard({
  key: "ArrowRight",
  preventDefault: () => { prevented = true; },
});
assert.equal(prevented, true);
assert.equal(state.sidebarWidth, 336);
resizeSidebarFromKeyboard({ key: "Home", preventDefault() {} });
assert.equal(state.sidebarWidth, MIN_SIDEBAR_WIDTH);
resizeSidebarFromKeyboard({ key: "End", preventDefault() {} });
assert.equal(state.sidebarWidth, MAX_SIDEBAR_WIDTH);

ui.shell._left = 20;
let pointerPrevented = false;
startSidebarResize({
  button: 0,
  clientX: 360,
  pointerId: 7,
  preventDefault: () => { pointerPrevented = true; },
});
assert.equal(pointerPrevented, true);
assert.equal(state.sidebarWidth, 340);
assert.equal(ui.shell.classList.contains("sidebar-resizing"), true);
assert.equal(ui.sidebarResizer.pointerCaptures.has(7), true);
moveSidebarResize({ clientX: 400, pointerId: 7, preventDefault() {} });
assert.equal(state.sidebarWidth, 380);
finishSidebarResize({ clientX: 410, pointerId: 7, type: "pointerup" });
assert.equal(state.sidebarWidth, 390);
assert.equal(ui.shell.classList.contains("sidebar-resizing"), false);
assert.equal(ui.sidebarResizer.pointerCaptures.has(7), false);
assert.equal(storedValues.get(SIDEBAR_WIDTH_STORAGE_KEY), "390");

startSidebarResize({ button: 0, clientX: 400, pointerId: 8, preventDefault() {} });
cancelSidebarResize();
assert.equal(state.sidebarResizePointerId, null);
assert.equal(ui.shell.classList.contains("sidebar-resizing"), false);
assert.equal(ui.sidebarResizer.pointerCaptures.has(8), false);

startSidebarResize({ button: 0, clientX: 400, pointerId: 9, preventDefault() {} });
ui.sidebarResizer.pointerCaptures.delete(9);
handleSidebarCaptureLoss({ pointerId: 9 });
assert.equal(state.sidebarResizePointerId, null);
assert.equal(ui.shell.classList.contains("sidebar-resizing"), false);
assert.equal(
  storedValues.get(SIDEBAR_WIDTH_STORAGE_KEY),
  String(state.sidebarPreferredWidth),
  "losing capture must clean up and persist the last usable width",
);

setSidebarCollapsed(true);
assert.equal(storedValues.get(SIDEBAR_COLLAPSED_STORAGE_KEY), "true");
toggleSidebar();
assert.equal(state.sidebarCollapsed, false);
assert.equal(storedValues.get(SIDEBAR_COLLAPSED_STORAGE_KEY), "false");

globalThis.window.innerWidth = 1280;
setSidebarWidth(500, true);
setSidebarCollapsed(true, false);
mobileViewport = true;
globalThis.window.innerWidth = 390;
syncSidebarBreakpoint();
assert.equal(state.sidebarWidth, MIN_SIDEBAR_WIDTH);
assert.equal(state.sidebarPreferredWidth, 500);
assert.equal(storedValues.get(SIDEBAR_WIDTH_STORAGE_KEY), "500");
assert.equal(ui.sidebarResizer.hidden, true);
assert.equal(ui.sidebarToggle.hidden, true);
assert.equal(ui.menu.hidden, false);
assert.equal(ui.sidebarContent.hidden, false);
assert.equal(ui.sidebarSwipeEdge.hidden, false);
setSidebarOpen(true);
assert.equal(state.sidebarOpen, true);
assert.equal(ui.sidebar.classList.contains("open"), true);
assert.equal(ui.sidebarScrim.hidden, false);
assert.equal(ui.sidebarSwipeEdge.hidden, true);
assert.equal(ui.chat.inert, true);
assert.equal(ui.menu.getAttribute("aria-expanded"), "true");
assert.equal(ui.menu.textContent, "Chats");
assert.equal(ui.closeSidebar.focusCount, 1);
const sidebarToggleFocusBeforeBreakpoint = ui.sidebarToggle.focusCount;
mobileViewport = false;
globalThis.window.innerWidth = 1280;
syncSidebarBreakpoint();
assert.equal(state.sidebarOpen, false);
assert.equal(ui.sidebar.classList.contains("open"), false);
assert.equal(ui.sidebarScrim.hidden, true);
assert.equal(ui.sidebarSwipeEdge.hidden, true);
assert.equal(ui.chat.inert, false);
assert.equal(state.sidebarWidth, 500);
assert.equal(state.sidebarPreferredWidth, 500);
assert.equal(
  ui.sidebarToggle.focusCount,
  sidebarToggleFocusBeforeBreakpoint + 1,
);
assert.equal(ui.sidebarToggle.hidden, false);
assert.equal(ui.menu.hidden, true);
assert.equal(
  ui.shell.classList.contains("sidebar-collapsed"),
  true,
  "the desktop collapse preference must survive a mobile drawer session",
);
setSidebarCollapsed(false, false);

ui.sidebarToggle.focus();
const menuFocusBeforeMobile = ui.menu.focusCount;
mobileViewport = true;
globalThis.window.innerWidth = 390;
syncSidebarBreakpoint();
assert.equal(ui.menu.focusCount, menuFocusBeforeMobile + 1);
assert.equal(ui.sidebarResizer.hidden, true);
setSidebarOpen(true);
setSidebarOpen(false);
assert.equal(ui.menu.getAttribute("aria-expanded"), "false");
assert.equal(ui.menu.focusCount, menuFocusBeforeMobile + 2);

startSidebarSwipe({
  button: 0,
  clientX: 4,
  clientY: 100,
  isPrimary: false,
  pointerId: 19,
});
assert.equal(state.sidebarSwipePointerId, null, "secondary pointers must be ignored");

startSidebarSwipe({ button: 0, clientX: 4, clientY: 100, pointerId: 20 });
assert.equal(state.sidebarSwipePointerId, 20);
assert.equal(ui.sidebarSwipeEdge.pointerCaptures.has(20), true);
finishSidebarSwipe({
  clientX: 4 + SIDEBAR_SWIPE_OPEN_DISTANCE - 1,
  clientY: 100,
  pointerId: 20,
  type: "pointerup",
});
assert.equal(state.sidebarOpen, false, "a short edge drag must not open the drawer");
assert.equal(state.sidebarSwipePointerId, null);
assert.equal(ui.sidebarSwipeEdge.pointerCaptures.has(20), false);

startSidebarSwipe({ button: 0, clientX: 4, clientY: 100, pointerId: 21 });
finishSidebarSwipe({
  clientX: 4 + SIDEBAR_SWIPE_OPEN_DISTANCE + 20,
  clientY: 170,
  pointerId: 21,
  type: "pointerup",
});
assert.equal(
  state.sidebarOpen,
  false,
  "a mostly vertical edge gesture must not open the drawer",
);

const closeFocusBeforeSwipe = ui.closeSidebar.focusCount;
let swipePrevented = false;
startSidebarSwipe({ button: 0, clientX: 4, clientY: 100, pointerId: 22 });
moveSidebarSwipe({
  clientX: 24,
  clientY: 104,
  pointerId: 22,
  preventDefault() { swipePrevented = true; },
});
assert.equal(swipePrevented, true);
assert.equal(state.sidebarOpen, false, "the drawer must not pop open during a drag");
assert.equal(state.sidebarSwipeDragging, true);
assert.equal(ui.sidebar.classList.contains("sidebar-swiping"), true);
assert.equal(ui.sidebarScrim.classList.contains("sidebar-swiping"), true);
assert.equal(ui.sidebarScrim.hidden, false);
assert.equal(ui.sidebarScrim.inert, true);
const earlySwipeTranslate = Number.parseFloat(
  ui.sidebar.style.getPropertyValue("--sidebar-swipe-translate"),
);
const earlyScrimOpacity = Number.parseFloat(
  ui.sidebarScrim.style.getPropertyValue("--sidebar-swipe-opacity"),
);

moveSidebarSwipe({
  clientX: 4 + SIDEBAR_SWIPE_OPEN_DISTANCE,
  clientY: 108,
  pointerId: 22,
  preventDefault() {},
});
assert.equal(state.sidebarOpen, false, "crossing the threshold should still track the drag");
assert.ok(
  Number.parseFloat(ui.sidebar.style.getPropertyValue("--sidebar-swipe-translate"))
    > earlySwipeTranslate,
  "the drawer should move right with the pointer",
);
assert.ok(
  Number.parseFloat(ui.sidebarScrim.style.getPropertyValue("--sidebar-swipe-opacity"))
    > earlyScrimOpacity,
  "the scrim should fade in with the pointer",
);
finishSidebarSwipe({
  clientX: 4 + SIDEBAR_SWIPE_OPEN_DISTANCE,
  clientY: 108,
  pointerId: 22,
  type: "pointerup",
  preventDefault() {},
});
assert.equal(state.sidebarOpen, true, "release should settle a completed swipe open");
assert.equal(state.sidebarSwipePointerId, null);
assert.equal(ui.sidebarSwipeEdge.pointerCaptures.has(22), false);
assert.equal(ui.sidebarSwipeEdge.hidden, true);
assert.equal(ui.sidebar.classList.contains("sidebar-swiping"), false);
assert.equal(ui.sidebarScrim.classList.contains("sidebar-swiping"), false);
assert.equal(ui.sidebar.style.getPropertyValue("--sidebar-swipe-translate"), "");
assert.equal(ui.sidebarScrim.style.getPropertyValue("--sidebar-swipe-opacity"), "");
assert.equal(ui.closeSidebar.focusCount, closeFocusBeforeSwipe + 1);

const menuFocusBeforeScrimClick = ui.menu.focusCount;
let scrimClickPrevented = false;
handleSidebarScrimPointerDown({
  button: 0,
  isPrimary: true,
  preventDefault() { scrimClickPrevented = true; },
});
assert.equal(scrimClickPrevented, true);
assert.equal(state.sidebarOpen, false, "the first outside pointerdown should close it");
assert.equal(ui.sidebarScrim.hidden, true);
assert.equal(ui.sidebarSwipeEdge.hidden, false);
assert.equal(ui.menu.focusCount, menuFocusBeforeScrimClick + 1);
handleSidebarScrimClick({ preventDefault() {} });
assert.equal(
  ui.menu.focusCount,
  menuFocusBeforeScrimClick + 1,
  "a follow-up click must not trigger a second close",
);

startSidebarSwipe({ button: 0, clientX: 4, clientY: 100, pointerId: 23 });
moveSidebarSwipe({
  clientX: 30,
  clientY: 102,
  pointerId: 23,
  preventDefault() {},
});
finishSidebarSwipe({
  clientX: 4 + SIDEBAR_SWIPE_OPEN_DISTANCE + 10,
  clientY: 100,
  pointerId: 23,
  type: "pointercancel",
});
assert.equal(state.sidebarOpen, false, "a cancelled swipe must not open the drawer");
assert.equal(ui.sidebar.classList.contains("sidebar-swiping"), false);
assert.equal(ui.sidebarScrim.hidden, true);

startSidebarSwipe({ button: 0, clientX: 4, clientY: 100, pointerId: 24 });
ui.sidebarSwipeEdge.pointerCaptures.delete(24);
handleSidebarSwipeCaptureLoss({ pointerId: 24 });
assert.equal(state.sidebarSwipePointerId, null);
cancelSidebarSwipe();

ui.searchMenu.focus();
state.searchOpen = true;
const railFocusBeforeSearchBreakpoint = ui.sidebarToggle.focusCount;
mobileViewport = false;
globalThis.window.innerWidth = 1280;
syncSidebarBreakpoint();
assert.equal(
  ui.sidebarToggle.focusCount,
  railFocusBeforeSearchBreakpoint + 1,
  "a mobile Chats control must not retain focus when it becomes hidden",
);
state.searchOpen = false;
mobileViewport = true;
globalThis.window.innerWidth = 390;
syncSidebarBreakpoint();

setSidebarOpen(true, false);
setPreferencesOpen(true, false);
ui.preferencesClose.focus();
setSidebarOpen(false, false);
const menuFocusBeforeMobilePreferencesClose = ui.menu.focusCount;
const preferencesFocusBeforeMobileClose = ui.preferencesToggle.focusCount;
setPreferencesOpen(false);
assert.equal(ui.menu.focusCount, menuFocusBeforeMobilePreferencesClose + 1);
assert.equal(
  ui.preferencesToggle.focusCount,
  preferencesFocusBeforeMobileClose,
  "closing settings must not restore focus inside a closed mobile drawer",
);

mobileViewport = false;
globalThis.window.innerWidth = 1280;
syncSidebarBreakpoint();
assert.equal(state.sidebarWidth, 500);
assert.equal(ui.shell.classList.contains("sidebar-collapsed"), false);

storedValues.set(SIDEBAR_WIDTH_STORAGE_KEY, "not-a-width");
storedValues.set(SIDEBAR_COLLAPSED_STORAGE_KEY, "true");
initializeSidebarLayout();
assert.equal(state.sidebarWidth, DEFAULT_SIDEBAR_WIDTH);
assert.equal(state.sidebarCollapsed, true);
setSidebarCollapsed(false, false);

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
  sourceKinds: ["cli", "vscode", "appServer"],
  sortKey: "recency_at",
  sortDirection: "desc",
});
assert.equal(THREAD_QUERY_PARAM, "thread");
assert.equal(threadHref("thread/with spaces"), "/?thread=thread%2Fwith+spaces");
assert.equal(threadIdFromSearch("?thread=thread%2Fwith+spaces"), "thread/with spaces");
assert.equal(threadIdFromSearch("?thread=%20%20"), null);
assert.equal(ui.threads.children[0].classList.contains("running"), true);
assert.equal(ui.threads.children[0].getAttribute("aria-busy"), "true");
assert.equal(ui.threads.children[1].classList.contains("active"), true);
assert.equal(ui.threads.children[0].tagName, "a", "sidebar chats should be browser links");
assert.equal(ui.threads.children[0].getAttribute("href"), "/?thread=thread-a");
assert.equal(ui.threads.children[1].getAttribute("aria-current"), "page");
let modifiedClickPrevented = false;
ui.threads.children[0].listeners.get("click")({
  button: 0,
  ctrlKey: true,
  preventDefault() { modifiedClickPrevented = true; },
});
assert.equal(modifiedClickPrevented, false, "modified clicks must retain native new-window behavior");

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

assert.deepEqual(
  mergeOrderedById(
    [{ id: "user" }, { id: "commentary" }, { id: "final" }],
    [{ id: "command" }, { id: "final" }],
  ).map((item) => item.id),
  ["user", "commentary", "command", "final"],
  "an authoritative prefix should be inserted before already streamed items",
);

cacheThreadSnapshot({
  id: "reconcile-thread",
  cwd: "/workspaces",
  status: { type: "idle" },
  turns: [{
    id: "reconcile-turn",
    status: "completed",
    items: [
      {
        id: "reconcile-command",
        type: "commandExecution",
        command: "inspect",
        status: "completed",
        aggregatedOutput: "done",
      },
      { id: "reconcile-final", type: "agentMessage", text: "answer" },
    ],
  }],
});
const reconciled = mergeThreadSnapshot({
  id: "reconcile-thread",
  cwd: "/workspaces",
  status: { type: "idle" },
  turns: [{
    id: "reconcile-turn",
    status: "completed",
    items: [
      {
        id: "reconcile-user",
        type: "userMessage",
        content: [{ type: "text", text: "the missing prompt" }],
      },
      { id: "reconcile-commentary", type: "agentMessage", text: "starting" },
      { id: "reconcile-final", type: "agentMessage", text: "answer" },
    ],
  }],
});
assert.deepEqual(
  reconciled.thread.turns[0].items.map((item) => item.id),
  [
    "reconcile-user",
    "reconcile-commentary",
    "reconcile-command",
    "reconcile-final",
  ],
  "snapshot reconciliation must restore a missed user-message prefix without losing live commands",
);
state.threadId = "reconcile-thread";
renderThreadHistory(reconciled.thread);
assert.ok(
  ui.messages.children.indexOf(state.items.get("reconcile-user").node)
    < ui.messages.children.indexOf(state.items.get("reconcile-command").node),
  "the repaired user message should render before the command that followed it",
);

const pendingNode = renderLocalPrompt(
  "pending-correlation",
  "optimistic prompt",
  "reconcile-thread",
  state.selectionId,
);
state.ready = false;
handleNotification("item/started", {
  threadId: "reconcile-thread",
  turnId: "unrelated-turn",
  item: {
    id: "unrelated-user",
    type: "userMessage",
    content: [{ type: "text", text: "a different prompt" }],
  },
});
assert.equal(
  state.pendingUser.id,
  "pending-correlation",
  "an unrelated user item must not clear a newer optimistic prompt",
);
handleNotification("turn/started", {
  threadId: "reconcile-thread",
  turn: { id: "correlation-turn", status: "inProgress" },
});
assert.equal(state.pendingUser.turnId, "correlation-turn");
handleNotification("item/started", {
  threadId: "reconcile-thread",
  turnId: "correlation-turn",
  item: {
    id: "canonical-correlation-user",
    type: "userMessage",
    content: [{ type: "text", text: "optimistic prompt" }],
  },
});
assert.equal(state.pendingUser, null, "the canonical item should replace its correlated optimistic prompt");
assert.equal(pendingNode.parentNode, null);
assert.equal(state.items.has("pending-correlation"), false);
assert.equal(state.items.has("canonical-correlation-user"), true);

for (let index = 0; index < THREAD_CACHE_LIMIT + 2; index += 1) {
  cacheThreadSnapshot({ id: `lru-${index}`, turns: [] });
}
assert.ok(state.threadCache.size <= THREAD_CACHE_LIMIT, "thread cache should remain bounded");

setSearchOpen(true);
assert.equal(state.searchOpen, true);
assert.equal(ui.searchView.hidden, false);
assert.equal(ui.chat.classList.contains("search-active"), true);
assert.equal(ui.searchChats.getAttribute("aria-pressed"), "true");
assert.equal(ui.searchQuery.focusCount, 1);
setSearchOpen(false, false);
assert.equal(ui.searchView.hidden, true);
assert.equal(ui.chat.classList.contains("search-active"), false);

const searchSelectionSnapshot = { threadId: state.threadId, selectionId: state.selectionId };
state.threadId = "search-thread";
state.selectionId = 41;
assert.equal(isSearchSelectionCurrent("search-thread", 41), true);
state.selectionId = 42;
assert.equal(
  isSearchSelectionCurrent("search-thread", 41),
  false,
  "a search-result jump must become stale when the user selects another view",
);
state.threadId = searchSelectionSnapshot.threadId;
state.selectionId = searchSelectionSnapshot.selectionId;

assert.equal(parseSearchDate(1704153600).toISOString(), "2024-01-02T00:00:00.000Z");
assert.equal(parseSearchDate("not-a-date"), null);
const normalizedSearch = normalizeSearchResponse({
  results: [{
    thread_id: "search-thread",
    turn_id: "search-turn",
    message_id: "search-item",
    thread_title: "Search result title",
    role: "agent",
    snippet: "A Straße in chat history",
    matched_text: "Straße",
    timestamp: "2024-01-02T00:00:00Z",
    timestamp_source: "message",
  }],
  total: 3,
  truncated: true,
  partial: true,
  skipped_threads: 2,
});
assert.equal(normalizedSearch.results.length, 1);
assert.equal(normalizedSearch.results[0].threadId, "search-thread");
assert.equal(normalizedSearch.results[0].itemId, "search-item");
assert.equal(normalizedSearch.results[0].role, "assistant");
assert.equal(normalizedSearch.results[0].date.toISOString(), "2024-01-02T00:00:00.000Z");
assert.equal(normalizedSearch.total, 3);
assert.equal(normalizedSearch.truncated, true);
assert.equal(normalizedSearch.partial, true);
assert.equal(normalizedSearch.skippedThreads, 2);

ui.searchFrom.value = "2024-02-10";
ui.searchTo.value = "2024-02-09";
assert.equal(validateSearchDates(), false);
assert.equal(ui.searchFrom.getAttribute("aria-invalid"), "true");
assert.match(ui.searchStatus.textContent, /start date/i);
ui.searchTo.value = "2024-02-10";
assert.equal(validateSearchDates(), true);
assert.equal(ui.searchFrom.getAttribute("aria-invalid"), null);

renderSearchResults(normalizedSearch, "STRASSE");
assert.equal(ui.searchResults.children.length, 1);
assert.match(ui.searchStatus.textContent, /Showing 1 of 3 matches/);
assert.match(ui.searchStatus.textContent, /2 conversations could not be searched/);
const searchResultButton = ui.searchResults.children[0].children[0];
assert.equal(searchResultButton.disabled, false);
assert.equal(searchResultButton.children[0].children[0].textContent, "Search result title");
assert.equal(searchResultButton.children[0].children[1].textContent, "Codex");
const highlightedSnippet = searchResultButton.children[1];
const highlight = highlightedSnippet.children.find((child) => child.tagName === "mark");
assert.equal(highlight.textContent, "Straße", "search highlighting should safely preserve Unicode matches");
assert.equal(searchResultButton.children[2].children[0].tagName, "time");

const fallbackDateSearch = normalizeSearchResponse({
  results: [
    {
      threadId: "turn-date-thread",
      itemId: "turn-date-item",
      threadTitle: "Turn timestamp",
      snippet: "turn fallback",
      timestamp: "2024-01-03T00:00:00Z",
      dateSource: "turn",
    },
    {
      threadId: "thread-date-thread",
      itemId: "thread-date-item",
      threadTitle: "Thread timestamp",
      snippet: "thread fallback",
      timestamp: "2024-01-02T00:00:00Z",
      dateSource: "thread",
    },
  ],
  total: 2,
});
renderSearchResults(fallbackDateSearch, "fallback");
const turnTimeFallback = ui.searchResults.children[0].children[0].children[2].children[1];
assert.equal(turnTimeFallback.textContent, " · turn time");
assert.match(turnTimeFallback.title, /matching turn's timestamp/);
const threadDateFallback = ui.searchResults.children[1].children[0].children[2].children[1];
assert.equal(threadDateFallback.textContent, " · conversation date");
assert.match(threadDateFallback.title, /conversation's timestamp/);

const originalFetch = globalThis.fetch;
let capturedSearchRequest;
globalThis.fetch = async (url, options) => {
  capturedSearchRequest = { url, options };
  return {
    ok: true,
    status: 200,
    async json() {
      return { results: [], total: 0, truncated: false, partial: false };
    },
  };
};
ui.searchQuery.value = "needle";
ui.searchFrom.value = "2024-01-01";
ui.searchTo.value = "2024-01-31";
ui.searchSort.value = "oldest";
performSearch({ preventDefault() {} }).then(async () => {
  globalThis.fetch = originalFetch;
  assert.equal(capturedSearchRequest.url, "/api/search");
  assert.equal(capturedSearchRequest.options.method, "POST");
  assert.equal(capturedSearchRequest.options.headers["Content-Type"], "application/json");
  const requestBody = JSON.parse(capturedSearchRequest.options.body);
  assert.equal(requestBody.q, "needle");
  assert.equal(requestBody.from, "2024-01-01");
  assert.equal(requestBody.to, "2024-01-31");
  assert.equal(requestBody.sort, "oldest");
  assert.equal(typeof requestBody.timezone, "string");

  const originalSocket = state.ws;
  const originalReady = state.ready;
  const originalWebSocket = globalThis.WebSocket;
  const rpcMessages = [];
  globalThis.WebSocket = { OPEN: 1 };
  state.ws = {
    readyState: 1,
    send(payload) {
      rpcMessages.push(JSON.parse(payload));
    },
  };
  state.ready = true;
  cacheThreadSnapshot({
    id: "rpc-reconcile-thread",
    status: { type: "active", activeFlags: [] },
    turns: [{ id: "rpc-reconcile-turn", status: "inProgress", items: [] }],
  });
  handleNotification("item/started", {
    threadId: "rpc-reconcile-thread",
    turnId: "rpc-reconcile-turn",
    item: {
      id: "rpc-reconcile-command",
      type: "commandExecution",
      command: "inspect",
      status: "inProgress",
      aggregatedOutput: "",
    },
  });
  const resumeRequest = rpcMessages.find((message) => message.method === "thread/resume");
  assert.ok(resumeRequest, "a later item should repair a turn whose user-message prefix is missing");
  assert.equal(resumeRequest.params.threadId, "rpc-reconcile-thread");
  const pendingResume = state.pending.get(resumeRequest.id);
  window.clearTimeout(pendingResume.timer);
  state.pending.delete(resumeRequest.id);
  pendingResume.resolve({
    thread: {
      id: "rpc-reconcile-thread",
      status: { type: "active", activeFlags: [] },
      turns: [{
        id: "rpc-reconcile-turn",
        status: "inProgress",
        items: [{
          id: "rpc-reconcile-user",
          type: "userMessage",
          content: [{ type: "text", text: "restored over RPC" }],
        }],
      }],
    },
  });
  await state.threadReconciliations.get("rpc-reconcile-thread").promise;
  assert.deepEqual(
    cachedThread("rpc-reconcile-thread").thread.turns[0].items.map((item) => item.id),
    ["rpc-reconcile-user", "rpc-reconcile-command"],
  );
  state.ws = originalSocket;
  state.ready = originalReady;
  if (originalWebSocket === undefined) delete globalThis.WebSocket;
  else globalThis.WebSocket = originalWebSocket;

  console.log("render-and-settings=ok");
}).catch((error) => {
  globalThis.fetch = originalFetch;
  console.error(error);
  process.exitCode = 1;
});
