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
  attachmentDownloadUrl,
  attachmentPreviewUrl,
  beginNewThread,
  buildTurnInput,
  cacheItemUpdate,
  cacheThreadSnapshot,
  cacheTurnUpdate,
  cachedThread,
  mergeOrderedById,
  mergeProvisionalThreads,
  mergeThreadSnapshot,
  handleNotification,
  handleServerRequest,
  handleMessagesScroll,
  handleMessagesTouchEnd,
  handleMessagesTouchMove,
  handleMessagesTouchStart,
  handleMessagesWheel,
  handlePromptInput,
  inputText,
  splitAttachedFileReferences,
  userMessagePresentation,
  isSearchSelectionCurrent,
  jumpToPresent,
  normalizeSearchResponse,
  defaultChatSettingOption,
  disconnectRequests,
  effectiveChatSettings,
  normalizeChatSettings,
  openThread,
  parseSearchDate,
  pendingPromptText,
  renderSearchResults,
  renderedItemKey,
  promptKeydown,
  renderThreadHistory,
  renderThinkingIndicator,
  renderRequests,
  renderLocalPrompt,
  renderChatSettings,
  renderThemeControl,
  renderThreads,
  selectedThreadBusy,
  selectedTurnId,
  submitPrompt,
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
  showStartedThread,
  sidebarMaxWidth,
  startSidebarResize,
  startSidebarSwipe,
  syncSidebarBreakpoint,
  syncSidebarVisibility,
  toggleSidebar,
  setSearchOpen,
  setSettingsOpen,
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
const command = state.items.get(renderedItemKey("command", "history-thread", "turn"));
assert.ok(command.body.textContent.includes("characters omitted"));
assert.ok(command.body.textContent.length < MAX_ACTIVITY_CHARS + 100);

const previousMarkdown = globalThis.CodexMarkdown;
const markdownInputs = [];
globalThis.CodexMarkdown = {
  render(value) {
    markdownInputs.push(value);
    const fragment = document.createDocumentFragment();
    const heading = document.createElement("h1");
    heading.textContent = value;
    fragment.append(heading);
    return fragment;
  },
};
const literalUserText = "# config comment\nkey: `literal`\n<div>not HTML</div>";
upsertMessage("plain-user", "user", literalUserText, false, "plain-thread", "plain-turn");
const plainUser = state.items.get(renderedItemKey(
  "plain-user",
  "plain-thread",
  "plain-turn",
));
assert.equal(plainUser.body.textContent, literalUserText);
assert.equal(plainUser.body.classList.contains("plain-text"), true);
assert.equal(plainUser.body.children.length, 0, "user text must not create Markdown elements");
assert.deepEqual(markdownInputs, [], "user messages must bypass the Markdown renderer");

upsertMessage("markdown-agent", "agent", "# Agent heading", false, "plain-thread", "plain-turn");
const markdownAgent = state.items.get(renderedItemKey(
  "markdown-agent",
  "plain-thread",
  "plain-turn",
));
assert.deepEqual(markdownInputs, ["# Agent heading"]);
assert.equal(markdownAgent.body.classList.contains("plain-text"), false);
assert.equal(markdownAgent.body.children[0].tagName, "h1");
globalThis.CodexMarkdown = previousMarkdown;

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

const resistedScrollWrites = ui.messages.scrollWrites;
handleMessagesWheel({ deltaY: -4 });
assert.equal(state.followPresent, false, "an upward wheel gesture immediately stops following");
upsertMessage("live-agent", "agent", " while the wheel gesture is pending", true);
assert.equal(
  ui.messages.scrollWrites,
  resistedScrollWrites,
  "streaming output must not cancel an upward gesture before its scroll event",
);
assert.equal(ui.jumpPresent.hidden, false);
ui.messages._scrollTop = 790;
handleMessagesScroll();
assert.equal(
  state.followPresent,
  false,
  "upward movement inside the near-bottom threshold must stay detached",
);
ui.messages._scrollTop = 800;
handleMessagesScroll();
assert.equal(state.followPresent, true, "moving back toward the bottom resumes following");
assert.equal(ui.jumpPresent.hidden, true);

const queuedScrollWrites = ui.messages.scrollWrites;
ui.messages._scrollTop = 790;
upsertMessage("live-agent", "agent", " before the queued scroll event", true);
assert.equal(state.followPresent, false, "incoming output detects upward movement before scroll fires");
assert.equal(
  ui.messages.scrollWrites,
  queuedScrollWrites,
  "a queued upward scroll must not be overwritten by streaming output",
);

ui.messages._scrollTop = 700;
handleMessagesScroll();
ui.messages._scrollTop = 790;
upsertMessage("live-agent", "agent", " while returning to the present", true);
assert.equal(state.followPresent, false, "streaming does not preempt a queued downward scroll");
handleMessagesScroll();
assert.equal(state.followPresent, true, "the queued downward scroll resumes following near the bottom");
jumpToPresent();

handleMessagesTouchStart({ touches: [{ clientY: 100 }] });
handleMessagesTouchMove({ touches: [{ clientY: 112 }] });
assert.equal(state.followPresent, false, "a downward touch gesture immediately stops following");
handleMessagesTouchEnd();
assert.equal(state.messagesTouchY, null);
jumpToPresent();

ui.messages._scrollHeight = 1200;
ui.messages._scrollTop = 1200 - ui.messages.clientHeight - PRESENT_THRESHOLD_PX + 1;
handleMessagesScroll();
assert.equal(state.followPresent, true, "the near-bottom threshold keeps following active");
upsertMessage("live-agent", "agent", " and more", true);
assert.equal(ui.messages.scrollTop, ui.messages.scrollHeight, "near-bottom output follows the present");
assert.equal(ui.jumpPresent.hidden, true);

ui.messages._scrollHeight = 1400;
ui.messages._scrollTop = 1199;
const typingScrollWrites = ui.messages.scrollWrites;
ui.prompt.value = "typing at the present";
handlePromptInput();
assert.equal(
  ui.messages.scrollTop,
  ui.messages.scrollHeight,
  "typing must keep followed history pinned to the present",
);
assert.equal(ui.messages.scrollWrites, typingScrollWrites + 1);

state.followPresent = false;
ui.messages._scrollTop = 300;
const readingScrollWrites = ui.messages.scrollWrites;
ui.prompt.value = "typing while reading history";
handlePromptInput();
assert.equal(ui.messages.scrollTop, 300, "typing must preserve an older reading position");
assert.equal(ui.messages.scrollWrites, readingScrollWrites);
state.followPresent = true;

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
assert.ok(turnInput[0].text.includes(attachments[0].path));
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
  pendingPromptText("Inspect these"),
  "Inspect these",
);
assert.equal(
  attachmentDownloadUrl(attachments[1]),
  "/api/attachments?path=%2Fworkspaces%2Fcodex-web%2Fuploads%2Fbatch%2Fnotes.txt&name=notes.txt",
);
assert.equal(
  attachmentPreviewUrl(attachments[0]),
  "/api/attachments?path=%2Fworkspaces%2Fcodex-web%2Fuploads%2Fbatch%2Fscreen.png&preview=1&name=screen.png",
);
assert.deepEqual(
  splitAttachedFileReferences(turnInput[0].text),
  {
    text: "Inspect these",
    attachments: attachments.map(({ image: _image, name, path }) => ({
      image: false,
      name,
      path,
    })),
  },
);
assert.deepEqual(userMessagePresentation(turnInput), {
  text: "Inspect these",
  attachments: attachments.map(({ image, name, path }) => ({ image, name, path })),
});
const legacyAttachmentPath = [
  "/workspaces/codex-web/uploads/0123456789abcdef0123456789abcdef",
  "abcdef123456-screen_shot.png",
].join("/");
assert.deepEqual(
  userMessagePresentation([{
    type: "localImage",
    path: legacyAttachmentPath,
  }]),
  {
    text: "",
    attachments: [{
      image: true,
      name: "screen_shot.png",
      path: legacyAttachmentPath,
    }],
  },
  "older image-only turns should gain download metadata from their stored path",
);
assert.deepEqual(
  userMessagePresentation(buildTurnInput("", [attachments[0]])),
  {
    text: "",
    attachments: [{ image: true, name: "screen.png", path: attachments[0].path }],
  },
  "attachment-only turns should render the file without synthetic prompt text",
);

renderThreadHistory({
  id: "attachment-history",
  status: { type: "idle" },
  turns: [{
    id: "attachment-turn",
    status: "completed",
    items: [{ id: "attachment-user", type: "userMessage", content: turnInput }],
  }],
});
const attachmentMessage = state.items.get(
  renderedItemKey("attachment-user", "attachment-history", "attachment-turn"),
);
assert.equal(attachmentMessage.body.textContent, "Inspect these");
assert.equal(attachmentMessage.attachmentList.hidden, false);
assert.equal(attachmentMessage.attachmentList.children.length, 2);
assert.equal(
  attachmentMessage.attachmentList.children[0].getAttribute("href"),
  attachmentDownloadUrl(attachments[0]),
);
assert.equal(
  attachmentMessage.attachmentList.children[0]
    .querySelector(".attachment-preview")
    .getAttribute("src"),
  attachmentPreviewUrl(attachments[0]),
  "historical local images should render an inline preview",
);
assert.equal(
  attachmentMessage.attachmentList.children[1].getAttribute("download"),
  "notes.txt",
);

const historicalClimateImage = {
  image: true,
  name: "image.png",
  path: [
    "/workspaces/codex-web/uploads/b31c7575ed934bc2941859e800dc7572",
    "4051acc115e8-image.png",
  ].join("/"),
};
renderThreadHistory({
  id: "historical-climate-chat",
  status: { type: "idle" },
  turns: [{
    id: "historical-climate-turn",
    status: "completed",
    items: [{
      id: "historical-climate-message",
      type: "userMessage",
      content: [
        {
          type: "text",
          text: "How do I make the proxy climate entity modal show the set point temperature even when off? Compare image attached.",
        },
        { type: "localImage", path: historicalClimateImage.path },
      ],
    }],
  }],
});
const historicalClimateMessage = state.items.get(renderedItemKey(
  "historical-climate-message",
  "historical-climate-chat",
  "historical-climate-turn",
));
assert.equal(historicalClimateMessage.attachmentList.children.length, 1);
assert.equal(
  historicalClimateMessage.attachmentList.children[0].getAttribute("href"),
  attachmentDownloadUrl(historicalClimateImage),
);
assert.equal(
  historicalClimateMessage.attachmentList.children[0]
    .querySelector(".attachment-preview")
    .getAttribute("src"),
  attachmentPreviewUrl(historicalClimateImage),
  "the reported historical climate screenshot should render from its localImage path",
);

const chatSettings = normalizeChatSettings({
  cwd: "  /workspaces/my project  ",
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
  cwd: "/workspaces/my project",
  model: "gpt-5.5",
  effort: "high",
  serviceTier: "priority",
  personality: "friendly",
  summary: "detailed",
  approvalPolicy: "on-request",
  permissions: ":workspace",
});
assert.deepEqual(threadSettingsParams(chatSettings), {
  cwd: "/workspaces/my project",
  model: "gpt-5.5",
  serviceTier: "priority",
  personality: "friendly",
  approvalPolicy: "on-request",
  permissions: ":workspace",
});
assert.deepEqual(turnSettingsParams(normalizeChatSettings(null)), {});

state.chatDefaults = normalizeChatSettings({
  model: "gpt-5.6-sol",
  effort: "max",
  serviceTier: "priority",
  personality: "none",
  summary: "auto",
  approvalPolicy: "never",
  permissions: ":danger-full-access",
});
const effectiveSettings = effectiveChatSettings(normalizeChatSettings({
  cwd: "/workspaces/selected-project",
  effort: "high",
  summary: "detailed",
}));
assert.deepEqual(effectiveSettings, {
  cwd: "/workspaces/selected-project",
  model: "gpt-5.6-sol",
  effort: "high",
  serviceTier: "priority",
  personality: "none",
  summary: "detailed",
  approvalPolicy: "never",
  permissions: ":danger-full-access",
});
assert.deepEqual(turnSettingsParams(effectiveSettings), effectiveSettings);

state.models = [{
  model: "gpt-5.6-sol",
  displayName: "GPT-5.6-Sol",
  isDefault: true,
  supportedReasoningEfforts: [
    { reasoningEffort: "medium" },
    { reasoningEffort: "high" },
    { reasoningEffort: "max" },
  ],
  serviceTiers: [{ id: "priority", name: "Fast" }],
  supportsPersonality: true,
}];
state.modelsLoaded = true;
state.permissionProfiles = [
  { id: ":workspace", allowed: true },
  { id: ":danger-full-access", allowed: true },
];
state.permissionProfilesLoaded = true;
state.configRequirements = {
  allowedApprovalPolicies: ["on-request", "never"],
};
state.settingsByThread.set(state.threadId, normalizeChatSettings({}));
renderChatSettings();
assert.equal(defaultChatSettingOption("model").label, "Instance default — GPT-5.6-Sol");
assert.equal(ui.settingModel.children[0].textContent, "Instance default — GPT-5.6-Sol");
assert.equal(ui.settingEffort.children[0].textContent, "Instance default — max");
assert.equal(ui.settingServiceTier.children[0].textContent, "Instance default — Fast");
assert.equal(ui.settingApproval.children[0].textContent, "Instance default — Never ask");
assert.equal(ui.settingPermissions.children[0].textContent, "Instance default — Full access");
for (const select of [
  ui.settingModel,
  ui.settingEffort,
  ui.settingServiceTier,
  ui.settingPersonality,
  ui.settingSummary,
  ui.settingApproval,
  ui.settingPermissions,
]) {
  assert.equal(
    select.children.some((option) => option.textContent.includes("Inherit current thread")),
    false,
  );
}
assert.match(ui.settingsNote.textContent, /Instance defaults apply wherever Default is selected/);

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
ui.prompt.value = "";
state.attachments = [];
ui.messages._scrollHeight = 1000;
ui.messages.clientHeight = 200;
ui.messages._scrollTop = 240;
handleMessagesScroll();
const thinkingScrollTop = ui.messages.scrollTop;
const thinkingScrollWrites = ui.messages.scrollWrites;
setThreadActivity("thread-a", "turn-a");
assert.equal(selectedThreadBusy(), true, "selected active thread should be busy");
assert.equal(selectedTurnId(), "turn-a");
assert.equal(ui.send.disabled, false, "a known active turn can be stopped from the composer");
assert.equal(ui.send.textContent, "Stop");
assert.equal(ui.send.type, "button", "empty text-box submission must not interrupt a task");
ui.prompt.value = "A reply";
handlePromptInput();
assert.equal(ui.send.textContent, "Reply");
assert.equal(ui.send.type, "submit");
ui.prompt.value = "   ";
handlePromptInput();
assert.equal(ui.send.textContent, "Stop", "whitespace is not a reply");
assert.equal(ui.thinkingIndicator.hidden, false, "selected active turn should show thinking");
assert.equal(ui.messages.getAttribute("aria-busy"), "true");
assert.equal(ui.messages.children.at(-1), ui.thinkingIndicator, "visible indicator stays last");
assert.equal(ui.messages.scrollTop, thinkingScrollTop, "thinking must not pull a reader to the bottom");
assert.equal(ui.messages.scrollWrites, thinkingScrollWrites, "thinking must not write scrollTop while reading history");
assert.equal(ui.jumpPresent.hidden, false, "off-screen thinking should offer Jump to present");
upsertMessage("busy-agent", "agent", "response started");
assert.equal(ui.messages.children.at(-1), ui.thinkingIndicator, "streaming output stays before thinking");
assert.equal(ui.messages.scrollTop, thinkingScrollTop, "streaming beside thinking preserves reader position");

setThreadActivity("thread-a", null);
assert.equal(ui.send.disabled, true, "a busy thread without a known turn id cannot be steered safely");
setThreadActivity("thread-a", "turn-a");
state.submittingThreads.add("thread-a");
updateControls();
assert.equal(ui.send.disabled, true, "a reply in flight must prevent duplicate submission");
state.submittingThreads.delete("thread-a");
updateControls();
assert.equal(ui.send.disabled, false);

state.threadId = "thread-b";
updateControls();
assert.equal(selectedThreadBusy(), false, "background activity must not block another thread");
assert.equal(selectedTurnId(), null);
assert.equal(ui.send.disabled, false, "an idle selected thread can start a turn");
assert.equal(ui.send.textContent, "Send", "Stop only targets the selected active thread");
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
state.threadId = "thread-b";
setSettingsOpen(true, false);
openThread("thread-a");
assert.equal(state.settingsOpen, false, "switching chats should close chat settings");
assert.equal(ui.settingsDialog.open, false);
assert.equal(ui.settingsToggle.getAttribute("aria-expanded"), "false");
setSettingsOpen(true, false);
openThread("thread-b");
assert.equal(state.settingsOpen, true, "reopening the selected chat should preserve chat settings");
setSettingsOpen(false, false);

setSettingsOpen(true);
assert.equal(ui.settingsDialog.open, true, "chat settings open as a dialog");
assert.equal(document.activeElement, ui.cwd);
setSettingsOpen(false);
assert.equal(ui.settingsDialog.open, false);
assert.equal(document.activeElement, ui.settingsToggle, "closing returns focus to the composer settings button");

const startedThread = {
  id: "thread-new",
  name: "Instantly visible",
  createdAt: 600,
  updatedAt: 600,
  recencyAt: 600,
  status: { type: "idle" },
};
const selectedThreadBeforeStart = state.threadId;
state.threadId = startedThread.id;
state.submittingThreads.add(startedThread.id);
assert.equal(showStartedThread(startedThread), true);
assert.equal(state.threads[0].id, startedThread.id);
assert.equal(ui.threads.children[0].getAttribute("href"), "/?thread=thread-new");
assert.equal(ui.threads.children[0].classList.contains("active"), true);
assert.equal(ui.threads.children[0].classList.contains("running"), true);
assert.equal(state.provisionalThreads.get(startedThread.id), startedThread);

const staleListMerge = mergeProvisionalThreads(unsortedThreads);
assert.equal(
  staleListMerge.some((thread) => thread.id === startedThread.id),
  true,
  "a stale thread/list response must not remove a locally started thread",
);
assert.equal(state.provisionalThreads.has(startedThread.id), true);
const confirmedThread = { ...startedThread, name: "Confirmed by server" };
const confirmedListMerge = mergeProvisionalThreads([confirmedThread, ...unsortedThreads]);
assert.equal(
  confirmedListMerge.filter((thread) => thread.id === startedThread.id).length,
  1,
  "server confirmation must not duplicate the optimistic thread",
);
assert.equal(
  confirmedListMerge.find((thread) => thread.id === startedThread.id).name,
  "Confirmed by server",
);
assert.equal(state.provisionalThreads.has(startedThread.id), false);
state.submittingThreads.delete(startedThread.id);
state.threadId = selectedThreadBeforeStart;
renderThreads(unsortedThreads);

state.ready = false;
const sidebarBeforeSystemThread = state.threads.map((thread) => thread.id);
const temporarySystemThread = {
  id: "thread-system-temporary",
  ephemeral: true,
  source: "vscode",
  threadSource: "system",
  preview: "",
  name: null,
  createdAt: 700,
  updatedAt: 700,
  status: { type: "idle" },
};
handleNotification("thread/started", { thread: temporarySystemThread });
assert.deepEqual(
  state.threads.map((thread) => thread.id),
  sidebarBeforeSystemThread,
  "temporary system threads must not appear in the chat sidebar",
);
assert.equal(
  state.provisionalThreads.has(temporarySystemThread.id),
  false,
  "temporary threads must not survive saved-chat refreshes as provisional chats",
);
assert.equal(
  mergeProvisionalThreads(unsortedThreads).some((thread) => thread.id === temporarySystemThread.id),
  false,
);
const untitledChat = {
  ...temporarySystemThread,
  id: "thread-real-untitled",
  ephemeral: false,
  threadSource: "user",
};
handleNotification("thread/started", { thread: untitledChat });
assert.equal(state.threads[0].id, untitledChat.id, "real untitled chats must still appear immediately");
assert.equal(state.provisionalThreads.has(untitledChat.id), true);
assert.equal(
  mergeProvisionalThreads(unsortedThreads).some((thread) => thread.id === untitledChat.id),
  true,
  "real chats must survive a delayed saved-chat response",
);
state.provisionalThreads.delete(untitledChat.id);
renderThreads(unsortedThreads);

handleNotification("turn/started", {
  threadId: "thread-b",
  turn: { id: "turn-b", status: "inProgress" },
});
assert.equal(state.activeTurns.get("thread-b"), "turn-b");
assert.equal(ui.thinkingIndicator.hidden, false, "turn start should show thinking for the selected thread");
assert.equal(ui.threads.children[1].classList.contains("running"), true,
  "turn start must update the sidebar before the saved-chat request finishes");
assert.equal(ui.threads.children[1].getAttribute("aria-busy"), "true");
assert.match(ui.threads.children[1].children[1].textContent, / · active$/);
renderThreads(unsortedThreads, true);
assert.equal(state.activeTurns.get("thread-b"), "turn-b",
  "a stale idle saved-chat snapshot must not clear a live turn");
assert.equal(ui.threads.children[1].classList.contains("running"), true);
handleNotification("turn/completed", {
  threadId: "thread-b",
  turn: { id: "turn-b", status: "completed" },
});
assert.equal(state.activeTurns.has("thread-b"), false);
assert.equal(ui.thinkingIndicator.hidden, true, "turn completion should hide thinking");
assert.equal(state.activeTurns.get("thread-a"), "turn-a", "other active turns must be preserved");
assert.equal(ui.threads.children[1].classList.contains("running"), false,
  "completion must update the sidebar without waiting for the saved-chat request");
assert.match(ui.threads.children[1].children[1].textContent, / · idle$/);
const staleActiveThreads = unsortedThreads.map((thread) => thread.id === "thread-b"
  ? { ...thread, status: { type: "active", activeFlags: [] } } : thread);
renderThreads(staleActiveThreads, true);
assert.equal(state.activeTurns.has("thread-b"), false,
  "a stale active saved-chat snapshot must not resurrect completed work");
assert.equal(ui.threads.children[1].getAttribute("aria-busy"), "false");
renderThreadHistory({
  id: "thread-b", status: { type: "active", activeFlags: [] },
  turns: [{ id: "turn-b", status: "inProgress", items: [] }],
});
assert.equal(state.activeTurns.has("thread-b"), false,
  "a delayed history render must respect live completion too");
assert.equal(ui.thinkingIndicator.hidden, true);

handleNotification("thread/status/changed", {
  threadId: "thread-b", status: { type: "active", activeFlags: ["waitingOnUserInput"] },
});
assert.equal(ui.threads.children[1].classList.contains("running"), true,
  "status-only activity must immediately update the sidebar");
renderThreads(unsortedThreads, true);
assert.equal(state.activeTurns.has("thread-b"), true,
  "stale idle snapshots must preserve activity even before its turn id is known");
assert.equal(ui.threads.children[1].getAttribute("aria-busy"), "true");
assert.equal(ui.thinkingLabel.textContent, "Waiting for your answer");
handleNotification("thread/status/changed", {
  threadId: "thread-b", status: { type: "idle" },
});
assert.equal(ui.threads.children[1].classList.contains("running"), false);
assert.equal(ui.thinkingIndicator.hidden, true);
handleNotification("thread/status/changed", {
  threadId: "thread-c", status: { type: "active", activeFlags: [] },
});
assert.equal(ui.threads.children[2].classList.contains("running"), true,
  "background status changes must update their own sidebar row immediately");
assert.equal(ui.thinkingIndicator.hidden, true, "background events must not activate the selected chat");
handleNotification("thread/status/changed", {
  threadId: "thread-c", status: { type: "systemError" },
});
assert.equal(ui.threads.children[2].getAttribute("aria-busy"), "false");
assert.match(ui.threads.children[2].children[1].textContent, / · systemError$/);

state.threadId = "thread-a";
const previousSelection = state.selectionId;
setSettingsOpen(true, false);
beginNewThread();
assert.equal(state.selectionId, previousSelection + 1);
assert.equal(state.threadId, null, "New thread must be available during background work");
assert.equal(state.settingsOpen, false, "starting a new chat should close chat settings");
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

const completionOrderThreadId = "completion-order-thread";
const completionOrderTurnId = "completion-order-turn";
const completionSnapshotItems = [
  {
    id: "completion-user",
    type: "userMessage",
    content: [{ type: "text", text: "Commit and push" }],
  },
  {
    id: "completion-reasoning-before",
    type: "reasoning",
    summary: [{ text: "Prepare changes\nInspect status" }],
  },
  {
    id: "completion-commentary",
    type: "agentMessage",
    phase: "commentary",
    text: "I will commit and push.",
  },
  {
    id: "completion-reasoning-after",
    type: "reasoning",
    summary: [{ text: "Push main branch\nVerify clean status" }],
  },
  {
    id: "completion-final",
    type: "agentMessage",
    phase: "final_answer",
    text: "Committed and pushed.",
  },
];
cacheThreadSnapshot({
  id: completionOrderThreadId,
  status: { type: "active", activeFlags: [] },
  turns: [{
    id: completionOrderTurnId,
    status: "inProgress",
    items: [
      {
        id: "live-completion-user",
        type: "userMessage",
        content: [{ type: "text", text: "Commit and push" }],
      },
      {
        id: "live-completion-reasoning-before",
        type: "reasoning",
        summary: [{ text: "Prepare changes\nInspect status" }],
      },
      {
        id: "live-completion-commentary",
        type: "agentMessage",
        phase: "commentary",
        text: "I will commit and push.",
      },
      {
        id: "live-completion-command-commit",
        type: "commandExecution",
        command: "git commit",
        status: "completed",
      },
      {
        id: "live-completion-reasoning-after",
        type: "reasoning",
        summary: [{ text: "Push main branch" }],
      },
      {
        id: "live-completion-command-push",
        type: "commandExecution",
        command: "git push",
        status: "completed",
      },
    ],
  }],
});
state.ready = false;
handleNotification("turn/completed", {
  threadId: completionOrderThreadId,
  turn: {
    id: completionOrderTurnId,
    status: "completed",
    items: completionSnapshotItems,
  },
});
assert.deepEqual(
  cachedThread(completionOrderThreadId).thread.turns[0].items.map((item) => item.id),
  [
    "live-completion-user",
    "live-completion-reasoning-before",
    "live-completion-commentary",
    "live-completion-command-commit",
    "live-completion-reasoning-after",
    "live-completion-command-push",
  ],
  "turn completion must preserve the item notification order",
);
const completionOrderReconciled = mergeThreadSnapshot({
  id: completionOrderThreadId,
  status: { type: "idle" },
  turns: [{
    id: completionOrderTurnId,
    status: "completed",
    items: completionSnapshotItems,
  }],
});
assert.deepEqual(
  completionOrderReconciled.thread.turns[0].items.map((item) => item.id),
  [
    "completion-user",
    "completion-reasoning-before",
    "completion-commentary",
    "live-completion-command-commit",
    "completion-reasoning-after",
    "live-completion-command-push",
    "completion-final",
  ],
  "reconciliation must keep live-only commands before the final answer",
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
  ui.messages.children.indexOf(
    state.items.get(renderedItemKey("reconcile-user", "reconcile-thread", "reconcile-turn")).node,
  ) < ui.messages.children.indexOf(
    state.items.get(renderedItemKey("reconcile-command", "reconcile-thread", "reconcile-turn")).node,
  ),
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
    id: "steering-before-original-echo",
    type: "userMessage",
    content: [{ type: "text", text: "A later steering reply in this turn" }],
  },
});
assert.equal(state.pendingUser.id, "pending-correlation",
  "a steering reply in the same turn must not consume the original optimistic prompt");
assert.notEqual(pendingNode.parentNode, null);
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
assert.equal(
  state.items.has(renderedItemKey(
    "canonical-correlation-user",
    "reconcile-thread",
    "correlation-turn",
  )),
  true,
);

cacheThreadSnapshot({
  id: "aliased-items-thread",
  status: { type: "active", activeFlags: [] },
  turns: [{
    id: "aliased-items-turn",
    status: "inProgress",
    items: [
      {
        id: "client-user-uuid",
        type: "userMessage",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        id: "msg-streamed-id",
        type: "agentMessage",
        phase: "final_answer",
        text: "Hello! What would you like to work on?",
      },
    ],
  }],
});
const aliasedItems = mergeThreadSnapshot({
  id: "aliased-items-thread",
  status: { type: "idle" },
  turns: [{
    id: "aliased-items-turn",
    status: "completed",
    items: [
      {
        id: "item-1",
        type: "userMessage",
        content: [{ type: "text", text: "Hello", text_elements: [] }],
      },
      {
        id: "item-2",
        type: "agentMessage",
        phase: "final_answer",
        text: "Hello! What would you like to work on?",
      },
    ],
  }],
});
assert.deepEqual(
  aliasedItems.thread.turns[0].items.map((item) => item.id),
  ["item-1", "item-2"],
  "snapshot IDs must replace equivalent streamed IDs without duplicating the messages",
);
state.threadId = "aliased-items-thread";
renderThreadHistory(aliasedItems.thread);
assert.equal(state.items.size, 2, "reconciled aliases should render one user/agent pair");
handleNotification("item/completed", {
  threadId: "aliased-items-thread",
  turnId: "aliased-items-turn",
  item: {
    id: "msg-streamed-id",
    type: "agentMessage",
    phase: "final_answer",
    text: "Hello! What would you like to work on?",
  },
});
assert.deepEqual(
  cachedThread("aliased-items-thread").thread.turns[0].items.map((item) => item.id),
  ["item-1", "item-2"],
  "later notifications using a streamed alias must update the canonical item",
);
assert.equal(state.items.size, 2, "an aliased completion must not append another message node");

const reusedIdsThread = {
  id: "reused-ids-thread",
  status: { type: "active", activeFlags: [] },
  turns: [
    {
      id: "old-turn",
      status: "completed",
      items: [
        {
          id: "item-1",
          type: "userMessage",
          content: [{ type: "text", text: "old prompt" }],
        },
        { id: "item-2", type: "agentMessage", text: "old response" },
      ],
    },
    { id: "new-turn", status: "inProgress", items: [] },
  ],
};
cacheThreadSnapshot(reusedIdsThread);
state.threadId = reusedIdsThread.id;
renderThreadHistory(reusedIdsThread);
const oldUserKey = renderedItemKey("item-1", reusedIdsThread.id, "old-turn");
const oldAgentKey = renderedItemKey("item-2", reusedIdsThread.id, "old-turn");
handleNotification("item/started", {
  threadId: reusedIdsThread.id,
  turnId: "new-turn",
  item: {
    id: "item-1",
    type: "userMessage",
    content: [{ type: "text", text: "new prompt" }],
  },
});
handleNotification("item/completed", {
  threadId: reusedIdsThread.id,
  turnId: "new-turn",
  item: { id: "item-2", type: "agentMessage", text: "new response" },
});
const newUserKey = renderedItemKey("item-1", reusedIdsThread.id, "new-turn");
const newAgentKey = renderedItemKey("item-2", reusedIdsThread.id, "new-turn");
assert.equal(state.items.size, 4, "item IDs reused in a later turn must create distinct nodes");
assert.equal(state.items.get(oldUserKey).body.textContent, "old prompt");
assert.equal(state.items.get(oldAgentKey).body.textContent, "old response");
assert.equal(state.items.get(newUserKey).body.textContent, "new prompt");
assert.equal(state.items.get(newAgentKey).body.textContent, "new response");
assert.ok(
  ui.messages.children.indexOf(state.items.get(oldAgentKey).node)
    < ui.messages.children.indexOf(state.items.get(newUserKey).node),
  "a reused item ID must not move a later turn into an older node's position",
);

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
assert.match(ui.searchStatus.textContent, /Showing 1 of 3 matching conversations/);
assert.match(ui.searchStatus.textContent, /2 conversations could not be searched/);
const searchResultLink = ui.searchResults.children[0].children[0];
assert.equal(searchResultLink.tagName, "a", "search results should be browser links");
assert.equal(searchResultLink.getAttribute("href"), "/?thread=search-thread");
assert.equal(searchResultLink.getAttribute("aria-disabled"), null);
assert.equal(searchResultLink.children[0].children[0].textContent, "Search result title");
assert.equal(searchResultLink.children[0].children.length, 1, "search results should not show a per-message role");
const highlightedSnippet = searchResultLink.children[1];
const highlight = highlightedSnippet.children.find((child) => child.tagName === "mark");
assert.equal(highlight.textContent, "Straße", "search highlighting should safely preserve Unicode matches");
assert.equal(searchResultLink.children[2].children[0].tagName, "time");
let searchModifiedClickPrevented = false;
searchResultLink.listeners.get("click")({
  button: 0,
  ctrlKey: true,
  preventDefault() { searchModifiedClickPrevented = true; },
});
assert.equal(
  searchModifiedClickPrevented,
  false,
  "modified search-result clicks must retain native new-window behavior",
);

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

function descendants(node, predicate) {
  return node.children.flatMap((child) => [
    ...(predicate(child) ? [child] : []),
    ...descendants(child, predicate),
  ]);
}

// Minimal fixtures from the real asynchronous-question protocol. These are
// agentMessage items, not item/tool/requestUserInput server requests.
function asyncQuestionTurn(topic) {
  const sky = topic === "sky";
  const title = sky
    ? "How should I explain why the sky is blue?"
    : "Where should a tiny fictional adventure take place?";
  const options = sky
    ? ["One simple sentence", "A short scientific explanation"]
    : ["An abandoned space station", "A village inside a giant tree"];
  return {
    id: `${topic}-turn`,
    status: "completed",
    items: [
      { id: `${topic}-prompt`, type: "userMessage", content: [{ type: "text", text: "Ask me a question." }] },
      {
        id: `${topic}-question`,
        type: "agentMessage",
        phase: "final_answer",
        text: `${title}\n${options.map((option) => `- ${option}`).join("\n")}`,
        questions: [{ title, options }],
      },
      { id: `${topic}-sleep`, type: "sleep" },
      { id: `${topic}-reply`, type: "userMessage", content: [{ type: "text", text: sky ? "One simple sentence" : "A village" }] },
      {
        id: `${topic}-answer`,
        type: "agentMessage",
        phase: "final_answer",
        text: sky ? "Air scatters blue sunlight more than other colors." : "The village lit its lanterns.",
        questions: null,
      },
    ],
  };
}

function assertRenderedItemOrder(threadId, turnId, items) {
  const positions = items.map((item) => {
    const entry = state.items.get(renderedItemKey(item.id, threadId, turnId));
    assert.ok(entry, `${item.id} should be rendered`);
    return ui.messages.children.indexOf(entry.node);
  });
  assert.ok(positions.every((position, index) => index === 0 || positions[index - 1] < position),
    `conversation items must stay chronological: ${items.map((item) => item.id).join(" → ")}`);
}

async function checkAsyncQuestionMessages({ selectActiveThread, notify, settle, latestSteer }) {
  const sky = asyncQuestionTurn("sky");
  const adventure = asyncQuestionTurn("adventure");
  const completed = mergeThreadSnapshot({
    id: "async-question-history",
    status: { type: "idle" },
    turns: [sky, adventure],
  }).thread;
  state.threadId = completed.id;
  renderThreadHistory(completed);
  for (const [index, turn] of [sky, adventure].entries()) {
    assert.deepEqual(completed.turns[index].items.map((item) => item.id), turn.items.map((item) => item.id),
      "a question marked final_answer must remain before its user reply and response");
    assertRenderedItemOrder(completed.id, turn.id, turn.items);
  }
  assert.equal(ui.thinkingIndicator.hidden, true, "answered historical questions must not show a waiting indicator");

  const activeTurn = { ...sky, status: "inProgress", items: sky.items.slice(0, 3) };
  const reconnected = mergeThreadSnapshot({
    id: "async-question-reconnect",
    status: { type: "active", activeFlags: [] },
    turns: [activeTurn],
  }).thread;
  state.threadId = reconnected.id;
  renderThreadHistory(reconnected);
  assertRenderedItemOrder(reconnected.id, sky.id, activeTurn.items);
  assert.equal(ui.thinkingIndicator.hidden, false);
  assert.equal(ui.thinkingLabel.textContent, "Waiting for your answer",
    "an active snapshot must restore waiting from the question even without waiting flags");
  assert.equal(ui.messages.getAttribute("aria-busy"), "false");
  assert.equal(ui.thinkingIndicator.classList.contains("waiting"), true);

  const answeredReconnect = mergeThreadSnapshot({
    ...reconnected,
    turns: [{ ...activeTurn, items: sky.items.slice(0, 4) }],
  }).thread;
  renderThreadHistory(answeredReconnect);
  assert.equal(ui.thinkingLabel.textContent, "Codex is thinking",
    "a user reply in an active snapshot must clear the question's waiting state");
  assert.equal(ui.messages.getAttribute("aria-busy"), "true");

  const laterTurn = {
    id: "later-turn",
    status: "inProgress",
    items: [{ id: "later-prompt", type: "userMessage", content: [{ type: "text", text: "Continue." }] }],
  };
  const historicalQuestion = { ...adventure, items: adventure.items.slice(0, 3) };
  const laterThread = mergeThreadSnapshot({
    id: "async-question-later-turn",
    status: { type: "active", activeFlags: [] },
    turns: [historicalQuestion, laterTurn],
  }).thread;
  state.threadId = laterThread.id;
  renderThreadHistory(laterThread);
  assert.equal(ui.thinkingLabel.textContent, "Codex is thinking",
    "even an unanswered question in a completed turn must not mark a later turn as waiting");

  // A previous answer is not the terminal answer once the user adds a reply.
  const continuedItems = [sky.items[0], sky.items[4], sky.items[3], adventure.items[4]];
  const continued = mergeThreadSnapshot({
    id: "async-question-continued",
    status: { type: "idle" },
    turns: [{ id: "continued-turn", status: "completed", items: continuedItems }],
  }).thread;
  assert.deepEqual(continued.turns[0].items.map((item) => item.id), continuedItems.map((item) => item.id),
    "an earlier final answer must remain before the later user reply");

  selectActiveThread("async-question-live", sky.id);
  ui.prompt.value = "";
  handlePromptInput();
  const sendItem = (item, method = "item/completed") => handleNotification(method, {
    threadId: "async-question-live", turnId: sky.id, item,
  });
  sendItem(sky.items[1], "item/started");
  assert.equal(ui.thinkingLabel.textContent, "Waiting for your answer",
    "a live agentMessage.questions event must update the status immediately");
  assert.equal(ui.messages.getAttribute("aria-busy"), "false");
  assert.equal(ui.send.disabled, false, "the composer must accept the asynchronous answer");
  assert.equal(ui.send.textContent, "Stop");
  sendItem({ id: "async-wait-commentary", type: "agentMessage", phase: "commentary", text: "I'll wait for your answer.", questions: null });
  sendItem(sky.items[2]);
  assert.equal(ui.thinkingLabel.textContent, "Waiting for your answer",
    "commentary and sleep after the question must not restore the thinking label");

  handleNotification("item/agentMessage/delta", {
    threadId: "async-question-live", turnId: sky.id, itemId: sky.items[1].id, delta: "\nChoose one.",
  });
  sendItem({ id: sky.items[1].id, type: "agentMessage", text: `${sky.items[1].text}\nChoose one.` });
  const cachedQuestion = cachedThread("async-question-live").thread.turns[0].items.find((item) => item.id === sky.items[1].id);
  assert.deepEqual(cachedQuestion.questions, sky.items[1].questions,
    "text-only updates must preserve question choices when phase and questions are omitted");
  assert.equal(cachedQuestion.phase, "final_answer");
  assert.equal(ui.thinkingLabel.textContent, "Waiting for your answer");

  const withoutMetadata = mergeThreadSnapshot({
    id: "async-question-live",
    status: { type: "active", activeFlags: [] },
    turns: [{
      id: sky.id,
      status: "inProgress",
      items: cachedThread("async-question-live").thread.turns[0].items.map((item) => (
        item.id === sky.items[1].id ? { ...item, questions: null } : item
      )),
    }],
  }).thread;
  assert.deepEqual(withoutMetadata.turns[0].items.find((item) => item.id === sky.items[1].id).questions, sky.items[1].questions,
    "a snapshot without question metadata must preserve known live choices");
  renderThreadHistory(withoutMetadata);
  assert.equal(ui.thinkingLabel.textContent, "Waiting for your answer");

  selectActiveThread("async-question-unrelated", "async-other-turn");
  assert.equal(ui.thinkingLabel.textContent, "Codex is thinking", "an asynchronous question must remain scoped to its conversation");
  state.threadId = "async-question-live";
  state.composerKey = threadComposerKey(state.threadId, state.selectionId);
  renderThreadHistory(cachedThread(state.threadId).thread);
  sendItem(sky.items[3]);
  assert.equal(ui.thinkingLabel.textContent, "Codex is thinking",
    "a user-message event must clear waiting even when the reply comes from another client");
  assert.equal(ui.thinkingIndicator.classList.contains("waiting"), false);
  sendItem(sky.items[4]);
  assertRenderedItemOrder("async-question-live", sky.id, sky.items.slice(1));

  // Failed replies keep the question pending; accepted replies clear it before
  // the canonical user-message echo arrives from the server.
  sendItem({ ...adventure.items[1], id: "async-next-question" });
  ui.prompt.value = "A village";
  const failedReply = submitPrompt({ preventDefault() {} });
  settle(latestSteer(), null, "Connection lost");
  await failedReply;
  assert.equal(ui.thinkingLabel.textContent, "Waiting for your answer");
  assert.equal(ui.prompt.value, "A village", "a rejected answer must be available for retry");
  const acceptedReply = submitPrompt({ preventDefault() {} });
  settle(latestSteer(), { turnId: sky.id });
  await acceptedReply;
  assert.equal(ui.thinkingLabel.textContent, "Codex is thinking",
    "an accepted answer must clear waiting without waiting for the user-message echo");
  assert.equal(ui.messages.getAttribute("aria-busy"), "true");

  notify("turn/completed", {
    threadId: "async-question-live", turn: { id: sky.id, status: "completed", items: [] },
  });
  assert.equal(ui.thinkingIndicator.hidden, true);
}

async function checkMidTurnInteractions(rpcMessages) {
  function settle(message, result, error = null) {
    assert.ok(message, "the expected RPC must have been sent");
    const pending = state.pending.get(message.id);
    assert.ok(pending, "the RPC must still await its response");
    window.clearTimeout(pending.timer);
    state.pending.delete(message.id);
    if (error) pending.reject(new Error(error));
    else pending.resolve(result);
  }

  function selectActiveThread(threadId, turnId) {
    state.ready = true;
    state.selectionId += 1;
    state.threadId = threadId;
    state.composerKey = threadComposerKey(threadId, state.selectionId);
    state.attachments = [];
    state.pendingUser = null;
    state.submittingThreads.clear();
    state.submittingViews.clear();
    const thread = {
      id: threadId,
      status: { type: "active", activeFlags: [] },
      turns: [{
        id: turnId,
        status: "inProgress",
        items: [{
          id: `${threadId}-original-prompt`,
          type: "userMessage",
          content: [{ type: "text", text: "Original task" }],
        }],
      }],
    };
    cacheThreadSnapshot(thread);
    renderThreadHistory(thread);
    setThreadActivity(threadId, turnId);
  }

  function latestSteer() {
    return rpcMessages.findLast((message) => message.method === "turn/steer");
  }

  function notifyWithoutBackgroundRpc(method, params) {
    state.ready = false;
    handleNotification(method, params);
    state.ready = true;
    updateControls();
  }

  selectActiveThread("steer-thread", "steer-turn");
  setThreadActivity("steer-thread", null);
  ui.prompt.value = "Wait for the active turn id";
  const beforeUnknownTurn = rpcMessages.length;
  await submitPrompt({ preventDefault() {} });
  assert.equal(rpcMessages.length, beforeUnknownTurn, "an unknown active turn must not fall back to turn/start");
  assert.equal(ui.prompt.value, "Wait for the active turn id");
  setThreadActivity("steer-thread", "steer-turn");
  ui.prompt.value = "Keep it running; deploy separately";
  handlePromptInput();
  const beforeSteer = rpcMessages.length;
  const submission = submitPrompt({ preventDefault() {} });
  const steer = latestSteer();
  assert.ok(steer, "replying during work must send turn/steer");
  assert.deepEqual(steer.params.input, [{ type: "text", text: "Keep it running; deploy separately" }]);
  assert.equal(steer.params.threadId, "steer-thread");
  assert.equal(steer.params.expectedTurnId, "steer-turn");
  assert.equal(typeof steer.params.clientUserMessageId, "string");
  assert.ok(steer.params.clientUserMessageId.length > 0);
  assert.equal(
    rpcMessages.slice(beforeSteer).some((message) => ["thread/start", "turn/start", "turn/interrupt"].includes(message.method)),
    false,
    "steering must not start another turn or interrupt current work",
  );
  assert.equal(ui.send.disabled, true);
  assert.equal(ui.prompt.value, "", "the submitted draft should leave the composer");
  const optimistic = state.pendingSteers.get(steer.params.clientUserMessageId);
  assert.ok(optimistic, "the reply should be visible while the server accepts it");
  assert.equal(optimistic.turnId, "steer-turn");
  ui.prompt.value = "Duplicate click";
  await submitPrompt({ preventDefault() {} });
  assert.equal(rpcMessages.filter((message) => message.method === "turn/steer").length, 1);
  ui.prompt.value = "";
  settle(steer, { turnId: "steer-turn" });
  await submission;
  assert.equal(state.activeTurns.get("steer-thread"), "steer-turn");
  assert.equal(ui.send.disabled, false, "a delivered reply must not block later steering");

  ui.prompt.value = "Use the existing deployment settings";
  const secondSubmission = submitPrompt({ preventDefault() {} });
  const secondSteer = latestSteer();
  settle(secondSteer, { turnId: "steer-turn" });
  await secondSubmission;
  assert.equal(state.pendingSteers.has(steer.params.clientUserMessageId), true);
  assert.equal(state.pendingSteers.has(secondSteer.params.clientUserMessageId), true);

  notifyWithoutBackgroundRpc("item/completed", {
    threadId: "steer-thread",
    turnId: "steer-turn",
    item: {
      id: "steer-thread-original-prompt",
      type: "userMessage",
      content: [{ type: "text", text: "Original task" }],
    },
  });
  assert.equal(state.pendingSteers.has(steer.params.clientUserMessageId), true, "the original prompt in the same turn must not consume a steering reply");

  notifyWithoutBackgroundRpc("item/started", {
    threadId: "steer-thread",
    turnId: "steer-turn",
    item: {
      id: "unrelated-user-reply",
      type: "userMessage",
      content: [{ type: "text", text: "Another client's message" }],
    },
  });
  assert.equal(state.pendingSteers.has(steer.params.clientUserMessageId), true);
  notifyWithoutBackgroundRpc("item/started", {
    threadId: "steer-thread",
    turnId: "steer-turn",
    item: {
      id: steer.params.clientUserMessageId,
      type: "userMessage",
      content: steer.params.input,
    },
  });
  assert.equal(state.pendingSteers.has(steer.params.clientUserMessageId), false);
  assert.equal(state.pendingSteers.has(secondSteer.params.clientUserMessageId), true, "one echo must not consume another pending reply");
  assert.equal(
    [...state.items.values()].filter((entry) => entry.body?.textContent === "Keep it running; deploy separately").length,
    1,
    "the server echo must replace the optimistic reply without duplication",
  );
  notifyWithoutBackgroundRpc("item/started", {
    threadId: "steer-thread",
    turnId: "steer-turn",
    item: {
      id: secondSteer.params.clientUserMessageId,
      type: "userMessage",
      content: secondSteer.params.input,
    },
  });
  assert.equal(state.pendingSteers.has(secondSteer.params.clientUserMessageId), false);

  ui.prompt.value = "  Preserve this reply after a failed steer  ";
  state.attachments = [attachments[1]];
  handlePromptInput();
  const failedSubmission = submitPrompt({ preventDefault() {} });
  const failedSteer = latestSteer();
  assert.notEqual(failedSteer.id, steer.id);
  assert.deepEqual(failedSteer.params.input, buildTurnInput("Preserve this reply after a failed steer", [attachments[1]]));
  settle(failedSteer, null, "The active turn changed");
  await failedSubmission;
  assert.equal(ui.prompt.value, "  Preserve this reply after a failed steer  ");
  assert.deepEqual(state.attachments, [attachments[1]], "failed steering must retain attachments for retry");
  assert.equal(state.pendingSteers.has(failedSteer.params.clientUserMessageId), false);
  assert.equal(state.activeTurns.get("steer-thread"), "steer-turn", "a rejected reply must not stop work");
  assert.match(ui.notice.textContent, /active turn changed/);

  selectActiveThread("canonical-steer-thread", "canonical-steer-turn");
  ui.prompt.value = "Original task";
  const canonicalSubmission = submitPrompt({ preventDefault() {} });
  const canonicalSteer = latestSteer();
  settle(canonicalSteer, { turnId: "canonical-steer-turn" });
  await canonicalSubmission;
  const originalCanonicalItem = {
    id: "canonical-original-user",
    type: "userMessage",
    content: [{ text_elements: [], text: "Original task", type: "text" }],
  };
  const canonicalSnapshot = {
    id: "canonical-steer-thread",
    status: { type: "active", activeFlags: [] },
    turns: [{ id: "canonical-steer-turn", status: "inProgress", items: [originalCanonicalItem] }],
  };
  const canonicalResume = rpcMessages.findLast((message) => message.method === "thread/resume"
    && message.params.threadId === "canonical-steer-thread");
  const canonicalReconciliation = state.threadReconciliations.get("canonical-steer-thread").promise;
  settle(canonicalResume, { thread: canonicalSnapshot });
  await canonicalReconciliation;
  assert.equal(state.pendingSteers.has(canonicalSteer.params.clientUserMessageId), true,
    "renaming the original user item must not consume a same-text steering reply");
  const withCanonicalReply = mergeThreadSnapshot({
    ...canonicalSnapshot,
    turns: [{
      ...canonicalSnapshot.turns[0],
      items: [originalCanonicalItem, { ...originalCanonicalItem, id: "canonical-reply-user" }],
    }],
  });
  renderThreadHistory(withCanonicalReply.thread);
  assert.equal(state.pendingSteers.has(canonicalSteer.params.clientUserMessageId), false,
    "a resumed canonical reply must reconcile despite default text_elements and property order");
  assert.equal([...state.items.values()].filter((entry) => entry.body?.textContent === "Original task").length, 2,
    "history must contain the original prompt and one reply, with no optimistic duplicate");

  const identicalSteers = [];
  for (let index = 0; index < 2; index += 1) {
    ui.prompt.value = "Repeat this instruction";
    const repeatedSubmission = submitPrompt({ preventDefault() {} });
    const repeatedSteer = latestSteer();
    settle(repeatedSteer, { turnId: "canonical-steer-turn" });
    await repeatedSubmission;
    identicalSteers.push(repeatedSteer.params.clientUserMessageId);
  }
  const repeatedEcho = {
    threadId: "canonical-steer-thread",
    turnId: "canonical-steer-turn",
    item: {
      id: "first-identical-echo",
      type: "userMessage",
      content: [{ text_elements: [], text: "Repeat this instruction", type: "text" }],
    },
  };
  notifyWithoutBackgroundRpc("item/started", repeatedEcho);
  assert.equal(state.pendingSteers.has(identicalSteers[0]), false);
  assert.equal(state.pendingSteers.has(identicalSteers[1]), true);
  notifyWithoutBackgroundRpc("item/completed", repeatedEcho);
  assert.equal(state.pendingSteers.has(identicalSteers[1]), true,
    "started/completed notifications for one reply must not consume two identical pending replies");
  notifyWithoutBackgroundRpc("item/completed", {
    ...repeatedEcho,
    item: { ...repeatedEcho.item, id: "second-identical-echo" },
  });
  assert.equal(state.pendingSteers.has(identicalSteers[1]), false);
  assert.equal([...state.items.values()].filter((entry) => entry.body?.textContent === "Repeat this instruction").length, 2);

  selectActiveThread("late-steer-thread", "late-steer-turn");
  ui.prompt.value = "A reply just before completion";
  const lateSubmission = submitPrompt({ preventDefault() {} });
  const lateSteer = latestSteer();
  notifyWithoutBackgroundRpc("turn/completed", {
    threadId: "late-steer-thread",
    turn: { id: "late-steer-turn", status: "completed", items: [] },
  });
  assert.equal(state.activeTurns.has("late-steer-thread"), false);
  settle(lateSteer, { turnId: "late-steer-turn" });
  await lateSubmission;
  assert.equal(state.activeTurns.has("late-steer-thread"), false, "a late steer response must not resurrect completed work");
  assert.equal(ui.thinkingIndicator.hidden, true);

  selectActiveThread("background-failure-thread", "background-failure-turn");
  const failedComposerKey = state.composerKey;
  ui.prompt.value = "Keep this background reply";
  state.attachments = [attachments[1]];
  const backgroundSubmission = submitPrompt({ preventDefault() {} });
  const backgroundSteer = latestSteer();
  selectActiveThread("other-open-thread", "other-open-turn");
  ui.prompt.value = "Do not overwrite this other chat's draft";
  handlePromptInput();
  settle(backgroundSteer, null, "Connection lost");
  await backgroundSubmission;
  assert.equal(ui.prompt.value, "Do not overwrite this other chat's draft");
  assert.deepEqual(state.attachments, []);
  state.threadId = "background-failure-thread";
  state.composerKey = failedComposerKey;
  restoreComposerDraft();
  assert.equal(ui.prompt.value, "Keep this background reply");
  assert.deepEqual(state.attachments, [attachments[1]], "a background failure must retain its own reply attachments");

  await checkAsyncQuestionMessages({
    selectActiveThread,
    notify: notifyWithoutBackgroundRpc,
    settle,
    latestSteer,
  });

  selectActiveThread("questions-thread", "questions-turn");
  await checkQuestionsInComposer(rpcMessages);

  // Drain background refreshes without leaving 60-second RPC timers behind.
  state.ready = false;
  for (const message of rpcMessages) {
    if (message.method === "thread/list" && state.pending.has(message.id)) {
      settle(message, { data: [] });
    }
    if (message.method === "thread/resume" && state.pending.has(message.id)) {
      settle(message, { thread: cachedThread(message.params.threadId)?.thread });
    }
  }
  await Promise.all([...state.threadReconciliations.values()].map((entry) => entry.promise));
}

async function checkQuestionsInComposer(rpcMessages) {
  function updateStatus(threadId, activeFlags) {
    state.ready = false;
    handleNotification("thread/status/changed", {
      threadId, status: { type: "active", activeFlags },
    });
    state.ready = true;
    updateControls();
  }
  async function answer(text) {
    ui.prompt.value = text;
    handlePromptInput();
    await submitPrompt({ preventDefault() {} });
  }
  const responseTo = (id) => rpcMessages.findLast((message) => message.id === id && !message.method);
  const question = {
    id: "question-options", method: "item/tool/requestUserInput",
    params: {
      threadId: "questions-thread", turnId: "questions-turn", isBlocking: true,
      questions: [{ id: "deployment", header: "Deployment", question: "How should I deploy?",
        options: [
          { label: "Keep running", description: "Deploy separately" },
          { label: "Finish safely", description: "Then update" },
        ],
      }],
    },
  };

  updateStatus("questions-thread", ["waitingOnUserInput"]);
  assert.equal(ui.thinkingLabel.textContent, "Waiting for your answer");
  assert.equal(ui.messages.getAttribute("aria-busy"), "false");
  updateStatus("questions-thread", ["waitingOnApproval"]);
  assert.equal(ui.thinkingLabel.textContent, "Waiting for approval");
  updateStatus("questions-thread", []);
  updateStatus("other-open-thread", ["waitingOnUserInput"]);
  assert.equal(ui.thinkingLabel.textContent, "Codex is thinking");

  handleServerRequest(question);
  const request = state.requestCards.get(question.id);
  assert.equal(request.parentNode, null, "a user-input request must not create a card or form");
  assert.equal(ui.requests.children.length, 0);
  const prompt = [...state.items.values()].find((item) => item.text?.startsWith("How should I deploy?"));
  assert.ok(prompt, "native questions must appear as ordinary conversation messages");
  assert.match(prompt.text, /Keep running — Deploy separately/);
  assert.equal(ui.send.disabled, false);
  assert.equal(ui.send.textContent, "Stop");
  assert.equal(responseTo(question.id), undefined, "showing options must never submit an answer");
  await answer("   ");
  assert.equal(responseTo(question.id), undefined);

  state.ws.readyState = 3;
  await answer("Deploy tomorrow after the recording finishes");
  assert.equal(responseTo(question.id), undefined);
  assert.equal(ui.prompt.value, "Deploy tomorrow after the recording finishes");
  assert.match(ui.notice.textContent, /still in the text box/);
  assert.equal(state.requestCards.get(question.id), request);
  state.ws.readyState = 1;
  await answer(ui.prompt.value);
  assert.deepEqual(responseTo(question.id).result, {
    answers: { deployment: { answers: ["Deploy tomorrow after the recording finishes"] } },
  });
  assert.equal(ui.prompt.value, "");
  assert.equal(state.requestCards.has(question.id), false);
  assert.equal(ui.requests.children.length, 0);
  const localReply = [...state.items.values()].find((item) => item.text === "Deploy tomorrow after the recording finishes");
  assert.ok(localReply);
  assert.ok(ui.messages.children.indexOf(prompt.node) < ui.messages.children.indexOf(localReply.node));

  const several = {
    ...question, id: "several-questions", params: {
      ...question.params, questions: [
        { id: "place", question: "Where should it happen?", options: [{ label: "A village" }] },
        { id: "hero", question: "Who is the hero?" },
      ],
    },
  };
  handleServerRequest(several);
  await answer("A village");
  assert.equal(responseTo(several.id), undefined, "collect all native answers before returning the tool result");
  assert.equal(state.requestCards.get(several.id).inputIndex, 1);
  assert.ok([...state.items.values()].some((item) => item.text === "Question 2 of 2\n\nWho is the hero?"));
  await answer("An octopus");
  assert.deepEqual(responseTo(several.id).result, {
    answers: { place: { answers: ["A village"] }, hero: { answers: ["An octopus"] } },
  });

  handleServerRequest({ ...question, id: "secret-question", params: {
    ...question.params, questions: [{ id: "secret", question: "Enter the value", isSecret: true }],
  } });
  await answer("private value");
  assert.deepEqual(responseTo("secret-question").result, { answers: { secret: { answers: ["private value"] } } });
  assert.equal([...state.items.values()].some((item) => item.text === "private value"), false);

  const reconnectQuestion = { ...question, id: "old-id", params: {
    ...question.params, itemId: "persistent-question-call", isBlocking: false,
  } };
  handleServerRequest(reconnectQuestion);
  assert.equal(ui.thinkingLabel.textContent, "Working — question pending");
  const reconnectRequest = state.requestCards.get("old-id");
  ui.prompt.value = "Keep my answer across reconnects";
  handlePromptInput();
  handleServerRequest(reconnectQuestion);
  assert.equal(state.requestCards.get("old-id"), reconnectRequest);
  state.ready = false;
  disconnectRequests();
  state.ready = true;
  updateControls();
  assert.equal(ui.send.disabled, true, "a native request must not answer a stale connection ID");
  await answer(ui.prompt.value);
  assert.equal(responseTo("old-id"), undefined);
  handleServerRequest({ ...reconnectQuestion, id: "new-id" });
  assert.equal(ui.send.disabled, false);
  assert.equal(ui.prompt.value, "Keep my answer across reconnects");
  assert.equal(state.requestCards.get("new-id"), reconnectRequest);
  await answer(ui.prompt.value);
  assert.deepEqual(responseTo("new-id").result, {
    answers: { deployment: { answers: ["Keep my answer across reconnects"] } },
  });

  // An unrelated request may reuse an ID after reconnect, without replacing
  // the saved native question that must still be answered in its own thread.
  handleServerRequest({ ...reconnectQuestion, id: 1 });
  const oldRequest = state.requestCards.get("1");
  disconnectRequests();
  handleServerRequest({ ...question, id: 1, params: {
    ...question.params, threadId: "other-input-thread", turnId: "other-input-turn", itemId: "other-call",
  } });
  assert.notEqual(state.requestCards.get("1"), oldRequest);
  handleServerRequest({ ...reconnectQuestion, id: 2 });
  assert.equal(state.requestCards.get("2"), oldRequest);
  handleNotification("serverRequest/resolved", { requestId: 1 });
  assert.equal(state.requestCards.get("2"), oldRequest);
  await answer("Preserve the original recording");
  assert.deepEqual(responseTo(2).result, { answers: { deployment: { answers: ["Preserve the original recording"] } } });

  handleServerRequest({ ...question, id: "completed-offline-question" });
  state.requestCards.get("completed-offline-question").requestDisconnected = true;
  mergeThreadSnapshot({
    id: "questions-thread", status: { type: "idle" },
    turns: [{ id: "questions-turn", status: "completed", items: [] }],
  });
  assert.equal(state.requestCards.has("completed-offline-question"), false);

  // Question controls are removed; existing command approvals are unaffected.
  handleServerRequest({ id: "approval-stays", method: "item/commandExecution/requestApproval", params: {
    threadId: state.threadId, turnId: "approval-turn", command: "example command",
  } });
  const approval = state.requestCards.get("approval-stays");
  assert.equal(approval.parentNode, ui.requests);
  const decline = descendants(approval, (node) => node.tagName === "button" && node.textContent === "Decline")[0];
  decline.listeners.get("click")();
  assert.deepEqual(responseTo("approval-stays").result, { decision: "decline" });
  assert.equal(ui.requests.children.length, 0);
}

async function checkStreamingSearch() {
  const encoder = new TextEncoder();
  const requests = [];
  globalThis.fetch = async () => {
    const request = {};
    requests.push(request);
    return new Response(new ReadableStream({
      start(controller) { request.controller = controller; },
      cancel() { request.cancelled = true; },
    }), { headers: { "Content-Type": "application/x-ndjson" } });
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  async function send(request, payload) {
    request.controller.enqueue(encoder.encode(JSON.stringify(payload) + "\n"));
    await settle();
  }
  const row = (id) => ({ threadId: id, itemId: id, title: id, snippet: "needle café" });
  const progress = (id, done = false) => ({ results: [row(id)], total: 1, done });

  ui.searchQuery.value = "needle";
  const oldSearch = performSearch();
  await send(requests[0], { results: [], total: 0, scannedThreads: 0, totalThreads: 3, done: false });
  assert.match(ui.searchStatus.textContent, /Searching/);
  assert.doesNotMatch(ui.searchStatus.textContent, /No conversations/);
  const encoded = encoder.encode(JSON.stringify(progress("early")) + "\n");
  const split = encoded.indexOf(0xc3) + 1; // Split café inside its UTF-8 character.
  requests[0].controller.enqueue(encoded.slice(0, split));
  await settle();
  assert.equal(state.searchResults.length, 0, "an incomplete record must not render");
  requests[0].controller.enqueue(encoded.slice(split));
  await settle();
  assert.equal(state.searchResults[0].snippet, "needle café");
  assert.equal(ui.searchResults.getAttribute("aria-busy"), "true");
  const earlyLink = ui.searchResults.children[0].children[0];
  await send(requests[0], progress("early"));
  assert.equal(ui.searchResults.children[0].children[0], earlyLink, "progress preserves existing links");

  // Deliberately ignore fetch's AbortSignal to deliver an already-buffered stale record.
  ui.searchQuery.value = "replacement";
  const newSearch = performSearch();
  await send(requests[0], progress("stale", true));
  await oldSearch;
  assert.equal(state.searchResults.length, 0);
  assert.equal(ui.searchResults.getAttribute("aria-busy"), "true", "old completion cannot clear new busy state");
  await send(requests[1], progress("current", true));
  await newSearch;
  assert.equal(state.searchResults[0].threadId, "current");
  assert.equal(ui.searchResults.getAttribute("aria-busy"), "false");

  const clearedSearch = performSearch();
  clearSearch();
  await send(requests[2], progress("after-clear", true));
  await clearedSearch;
  assert.equal(state.searchResults.length, 0);
  assert.equal(ui.searchResults.children.length, 0);

  ui.searchQuery.value = "needle";
  const interruptedSearch = performSearch();
  await send(requests[3], progress("kept"));
  requests[3].controller.close();
  await interruptedSearch;
  assert.equal(state.searchResults[0].threadId, "kept");
  assert.match(ui.searchStatus.textContent, /ended before all conversations/);
  assert.match(ui.searchStatus.textContent, /Results found so far/);
  assert.equal(ui.searchResults.getAttribute("aria-busy"), "false");
  assert.ok(requests.slice(0, 3).every((request) => request.cancelled));
  clearSearch();
}

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
  assert.match(capturedSearchRequest.options.headers.Accept, /application\/x-ndjson/);
  const requestBody = JSON.parse(capturedSearchRequest.options.body);
  assert.equal(requestBody.q, "needle");
  assert.equal(requestBody.from, "2024-01-01");
  assert.equal(requestBody.to, "2024-01-31");
  assert.equal(requestBody.sort, "oldest");
  assert.equal(typeof requestBody.timezone, "string");
  await checkStreamingSearch();
  globalThis.fetch = originalFetch;

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
  await checkMidTurnInteractions(rpcMessages);
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
