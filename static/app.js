"use strict";

const APP_VERSION = "0.9.3";
const MAX_ACTIVITY_CHARS = 32 * 1024;
const PRESENT_THRESHOLD_PX = 72;
const THREAD_CACHE_LIMIT = 8;
const THREAD_LIST_PARAMS = Object.freeze({
  limit: 50,
  sourceKinds: ["cli", "vscode", "appServer"],
  sortKey: "recency_at",
  sortDirection: "desc",
});
const CHAT_SETTINGS_STORAGE_KEY = "codex-web-chat-settings-v1";
const THREAD_QUERY_PARAM = "thread";
const SEARCH_MATCH_HIGHLIGHT_MS = 4000;
const SIDEBAR_WIDTH_STORAGE_KEY = "codex-web-sidebar-width-v1";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "codex-web-sidebar-collapsed-v1";
const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;
const MIN_CHAT_WIDTH = 440;
const SIDEBAR_KEYBOARD_STEP = 16;
const CHAT_SETTING_FIELDS = [
  "model",
  "effort",
  "serviceTier",
  "personality",
  "summary",
  "approvalPolicy",
  "permissions",
];

function emptyChatSettings() {
  return Object.fromEntries(CHAT_SETTING_FIELDS.map((field) => [field, ""]));
}

const el = (id) => document.getElementById(id);
const ui = {
  shell: el("shell"),
  chat: el("chat"),
  sidebar: el("sidebar"),
  sidebarResizer: el("sidebar-resizer"),
  sidebarScrim: el("sidebar-scrim"),
  menu: el("menu"),
  closeSidebar: el("close-sidebar"),
  threads: el("threads"),
  newThread: el("new-thread"),
  searchChats: el("search-chats"),
  searchView: el("search-view"),
  searchMenu: el("search-menu"),
  searchForm: el("search-form"),
  searchQuery: el("search-query"),
  searchFrom: el("search-from"),
  searchTo: el("search-to"),
  searchSort: el("search-sort"),
  searchClear: el("search-clear"),
  searchSubmit: el("search-submit"),
  searchStatus: el("search-status"),
  searchResults: el("search-results"),
  preferencesToggle: el("preferences-toggle"),
  preferencesDialog: el("preferences-dialog"),
  preferencesClose: el("preferences-close"),
  themeSystem: el("theme-system"),
  themeLight: el("theme-light"),
  themeDark: el("theme-dark"),
  themeSummary: el("theme-summary"),
  title: el("thread-title"),
  cwd: el("cwd"),
  settingsToggle: el("settings-toggle"),
  settingsPanel: el("settings-panel"),
  settingsFields: el("settings-fields"),
  settingModel: el("setting-model"),
  settingEffort: el("setting-effort"),
  settingServiceTier: el("setting-service-tier"),
  settingPersonality: el("setting-personality"),
  settingSummary: el("setting-summary"),
  settingApproval: el("setting-approval"),
  settingPermissions: el("setting-permissions"),
  settingsNote: el("settings-note"),
  stop: el("stop"),
  notice: el("notice"),
  messages: el("messages"),
  thinkingIndicator: el("thinking-indicator"),
  jumpPresent: el("jump-present"),
  requests: el("requests"),
  attachments: el("attachments"),
  composer: el("composer"),
  fileInput: el("file-input"),
  prompt: el("prompt"),
  send: el("send"),
};

const state = {
  ws: null,
  ready: false,
  nextId: 1,
  pending: new Map(),
  threadId: null,
  activeTurns: new Map(),
  submittingThreads: new Set(),
  submittingViews: new Set(),
  selectionId: 0,
  threads: [],
  threadRefreshId: 0,
  threadCache: new Map(),
  connectionGeneration: 0,
  models: [],
  modelsLoaded: false,
  configDefaults: {},
  configRequirements: null,
  permissionProfiles: [],
  permissionProfilesLoaded: false,
  settingsByThread: new Map(),
  newThreadSettings: emptyChatSettings(),
  settingsOpen: false,
  composerDrafts: new Map(),
  composerKey: "new:0",
  promptHistoryByThread: new Map(),
  promptHistoryIndexesByThread: new Map(),
  promptHistoryIndex: null,
  promptHistoryDraft: "",
  items: new Map(),
  requestCards: new Map(),
  reconnectTimer: null,
  defaultCwd: "/workspaces",
  attachments: [],
  pendingUser: null,
  renderTarget: null,
  uploading: false,
  uploadLimits: null,
  sidebarOpen: false,
  sidebarCollapsed: false,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  sidebarPreferredWidth: DEFAULT_SIDEBAR_WIDTH,
  sidebarResizePointerId: null,
  searchOpen: false,
  searchRequestId: 0,
  searchAbortController: null,
  searchResults: [],
  followPresent: true,
  connectionStatus: "offline",
};

function setStatus(_text, kind) {
  state.connectionStatus = kind;
}

function themeName(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : "System";
}

function renderThemeControl() {
  const theme = globalThis.CodexTheme;
  const options = [
    ["system", ui.themeSystem],
    ["light", ui.themeLight],
    ["dark", ui.themeDark],
  ];
  if (!theme) {
    for (const [, button] of options) button.disabled = true;
    ui.themeSummary.textContent = "Theme controls are unavailable.";
    return;
  }
  const preference = theme.preference();
  const effective = theme.effectiveTheme();
  for (const [value, button] of options) {
    const selected = preference === value;
    button.disabled = false;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  ui.themeSummary.textContent = preference === "system"
    ? `Following the browser / OS setting (${themeName(effective)}).`
    : `Using ${themeName(preference)} mode on this browser.`;
}

function setPreferencesOpen(open, moveFocus = true) {
  if (open) {
    renderThemeControl();
    ui.preferencesToggle.setAttribute("aria-expanded", "true");
    if (!ui.preferencesDialog.open) {
      if (typeof ui.preferencesDialog.showModal === "function") {
        ui.preferencesDialog.showModal();
      } else {
        ui.preferencesDialog.setAttribute("open", "");
      }
    }
    return;
  }
  ui.preferencesToggle.setAttribute("aria-expanded", "false");
  if (ui.preferencesDialog.open && typeof ui.preferencesDialog.close === "function") {
    ui.preferencesDialog.close();
  } else {
    ui.preferencesDialog.removeAttribute("open");
  }
  if (moveFocus) ui.preferencesToggle.focus();
}

function notice(text = "") {
  ui.notice.textContent = text;
  ui.notice.hidden = !text;
}

function updateControls() {
  const busy = selectedThreadBusy();
  const turnId = selectedTurnId();
  ui.send.disabled = !state.ready || busy || state.uploading;
  ui.fileInput.disabled = busy || state.uploading;
  ui.stop.disabled = !state.ready || !state.threadId || !turnId;
  ui.settingsToggle.disabled = !state.ready;
  ui.settingsFields.disabled = !state.ready;
  renderThinkingIndicator(busy);
}

function selectedTurnId() {
  return state.threadId ? (state.activeTurns.get(state.threadId) || null) : null;
}

function selectedThreadBusy() {
  if (state.submittingViews.has(state.selectionId)) return true;
  if (!state.threadId) return false;
  return state.submittingThreads.has(state.threadId)
    || state.activeTurns.has(state.threadId);
}

function renderThinkingIndicator(busy = selectedThreadBusy()) {
  const visible = Boolean(busy);
  ui.messages.setAttribute("aria-busy", String(visible));
  if (ui.thinkingIndicator.hidden === !visible) return;
  const shouldFollow = state.followPresent && messagesAtPresent();
  ui.thinkingIndicator.hidden = !visible;
  presentContentChanged(shouldFollow);
}

function setThreadActivity(threadId, turnId = null) {
  if (!threadId) return;
  state.submittingThreads.delete(threadId);
  state.activeTurns.set(threadId, turnId || null);
  updateControls();
}

function clearThreadActivity(threadId) {
  if (!threadId) return;
  state.submittingThreads.delete(threadId);
  state.activeTurns.delete(threadId);
  updateControls();
}

function pruneThreadCache() {
  while (state.threadCache.size > THREAD_CACHE_LIMIT) {
    const oldest = [...state.threadCache.entries()]
      .sort((left, right) => left[1].lastAccess - right[1].lastAccess);
    const candidate = oldest
      .filter(([threadId]) => (
        threadId !== state.threadId
        && !state.activeTurns.has(threadId)
        && !state.submittingThreads.has(threadId)
      ))[0]
      || oldest.find(([threadId]) => threadId !== state.threadId)
      || oldest[0];
    if (!candidate) return;
    state.threadCache.delete(candidate[0]);
  }
}

function cacheThreadSnapshot(thread) {
  if (!thread?.id) return null;
  const previous = state.threadCache.get(thread.id);
  const entry = {
    thread,
    generation: state.connectionGeneration,
    lastAccess: Date.now(),
    scrollTop: previous?.scrollTop || 0,
    followPresent: previous?.followPresent ?? true,
    pendingUser: previous?.pendingUser || null,
  };
  state.threadCache.set(thread.id, entry);
  pruneThreadCache();
  return entry;
}

function cachedThread(threadId, touch = true) {
  const entry = state.threadCache.get(threadId) || null;
  if (entry && touch) entry.lastAccess = Date.now();
  return entry;
}

function saveCurrentThreadView() {
  if (!state.threadId) return;
  const entry = cachedThread(state.threadId, false);
  if (!entry) return;
  entry.scrollTop = ui.messages.scrollTop;
  entry.followPresent = state.followPresent;
}

function threadComposerKey(threadId, selectionId = state.selectionId) {
  return threadId ? `thread:${threadId}` : `new:${selectionId}`;
}

function resetPromptHistoryNavigation() {
  state.promptHistoryIndex = null;
  state.promptHistoryDraft = "";
}

function saveComposerDraft(key = state.composerKey) {
  if (ui.prompt.value) state.composerDrafts.set(key, ui.prompt.value);
  else state.composerDrafts.delete(key);
}

function restoreComposerDraft(key = state.composerKey) {
  ui.prompt.value = state.composerDrafts.get(key) || "";
  ui.prompt.setSelectionRange?.(ui.prompt.value.length, ui.prompt.value.length);
  resetPromptHistoryNavigation();
}

function clearComposerDraft(key = state.composerKey) {
  state.composerDrafts.delete(key);
  if (key === state.composerKey) ui.prompt.value = "";
  resetPromptHistoryNavigation();
}

function moveComposerDraft(fromKey, toKey) {
  if (fromKey === toKey || !state.composerDrafts.has(fromKey)) return;
  state.composerDrafts.set(toKey, state.composerDrafts.get(fromKey));
  state.composerDrafts.delete(fromKey);
}

function handlePromptInput() {
  resetPromptHistoryNavigation();
  saveComposerDraft();
}

function findCachedTurn(entry, turnId) {
  const turns = entry?.thread?.turns || [];
  if (turnId) return turns.find((turn) => turn.id === turnId) || null;
  return turns.at(-1) || null;
}

function cacheTurnUpdate(threadId, turn, fallbackStatus = "inProgress") {
  const entry = cachedThread(threadId, false);
  if (!entry || !turn?.id) return null;
  if (!Array.isArray(entry.thread.turns)) entry.thread.turns = [];
  let cached = findCachedTurn(entry, turn.id);
  if (!cached) {
    cached = {
      ...turn,
      status: turn.status || fallbackStatus,
      items: Array.isArray(turn.items) ? [...turn.items] : [],
    };
    entry.thread.turns.push(cached);
  } else {
    const items = Array.isArray(cached.items) ? cached.items : [];
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      const existing = items.find((candidate) => candidate.id === item.id);
      if (existing) Object.assign(existing, item);
      else items.push({ ...item });
    }
    Object.assign(cached, turn);
    cached.items = items;
  }
  entry.lastAccess = Date.now();
  return cached;
}

function cacheItemUpdate(params) {
  const entry = cachedThread(params.threadId, false);
  const item = params.item;
  if (!entry || !item?.id) return;
  let turn = findCachedTurn(entry, params.turnId);
  if (!turn && params.turnId) {
    turn = cacheTurnUpdate(params.threadId, {
      id: params.turnId,
      status: "inProgress",
      items: [],
    });
  }
  if (!turn) return;
  if (!Array.isArray(turn.items)) turn.items = [];
  const index = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) Object.assign(turn.items[index], item);
  else turn.items.push({ ...item });
  if (item.type === "userMessage") entry.pendingUser = null;
}

function cachedItem(threadId, turnId, itemId, type) {
  const entry = cachedThread(threadId, false);
  if (!entry) return null;
  let turn = findCachedTurn(entry, turnId);
  if (!turn && turnId) {
    turn = cacheTurnUpdate(threadId, {
      id: turnId,
      status: "inProgress",
      items: [],
    });
  }
  if (!turn) return null;
  if (!Array.isArray(turn.items)) turn.items = [];
  let item = turn.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    item = { id: itemId, type };
    turn.items.push(item);
  }
  return item;
}

function appendCachedText(params, type, field = "text") {
  const item = cachedItem(params.threadId, params.turnId, params.itemId, type);
  if (!item) return;
  item[field] = `${item[field] || ""}${params.delta || ""}`;
}

function appendCachedReasoning(params) {
  const item = cachedItem(
    params.threadId,
    params.turnId,
    params.itemId,
    "reasoning",
  );
  if (!item) return;
  if (!Array.isArray(item.summary)) item.summary = [];
  const last = item.summary.at(-1);
  if (last && typeof last === "object") {
    last.text = `${last.text || ""}${params.delta || ""}`;
  } else {
    item.summary.push({ text: params.delta || "" });
  }
}

function setCachedPendingUser(threadId, pending) {
  const entry = cachedThread(threadId, false);
  if (entry) entry.pendingUser = pending;
}

function normalizeChatSettings(value = {}) {
  if (!value || typeof value !== "object") value = {};
  const normalized = emptyChatSettings();
  for (const field of CHAT_SETTING_FIELDS) {
    if (typeof value[field] === "string") normalized[field] = value[field];
  }
  return normalized;
}

function currentChatSettings() {
  if (!state.threadId) return state.newThreadSettings;
  if (!state.settingsByThread.has(state.threadId)) {
    state.settingsByThread.set(state.threadId, emptyChatSettings());
  }
  return state.settingsByThread.get(state.threadId);
}

function loadStoredChatSettings() {
  if (globalThis.CODEX_WEB_TEST) return;
  try {
    const stored = JSON.parse(localStorage.getItem(CHAT_SETTINGS_STORAGE_KEY) || "{}");
    state.newThreadSettings = normalizeChatSettings(stored.newThread);
    for (const [threadId, settings] of Object.entries(stored.threads || {})) {
      state.settingsByThread.set(threadId, normalizeChatSettings(settings));
    }
  } catch {
    state.newThreadSettings = emptyChatSettings();
    state.settingsByThread.clear();
  }
}

function persistChatSettings() {
  if (globalThis.CODEX_WEB_TEST) return;
  try {
    const threads = Object.fromEntries([...state.settingsByThread.entries()].slice(-200));
    localStorage.setItem(CHAT_SETTINGS_STORAGE_KEY, JSON.stringify({
      newThread: state.newThreadSettings,
      threads,
    }));
  } catch {
    // Browser storage can be disabled; server-side sticky settings still work.
  }
}

function modelForSettings(settings) {
  const modelId = settings.model
    || state.configDefaults.model
    || state.models.find((model) => model.isDefault)?.model;
  return state.models.find((model) => model.model === modelId || model.id === modelId) || null;
}

function fillSelect(select, options, selectedValue) {
  select.replaceChildren();
  for (const entry of options) {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label;
    option.disabled = Boolean(entry.disabled);
    if (entry.description) option.title = entry.description;
    select.append(option);
  }
  select.value = options.some((entry) => entry.value === selectedValue) ? selectedValue : "";
}

function approvalOptions() {
  const labels = {
    untrusted: "Only untrusted commands",
    "on-request": "Ask when needed",
    never: "Never ask",
  };
  const allowed = state.configRequirements?.allowedApprovalPolicies;
  const values = Array.isArray(allowed)
    ? allowed.filter((value) => typeof value === "string")
    : Object.keys(labels);
  return [
    { value: "", label: "Inherit current thread" },
    ...values.map((value) => ({ value, label: labels[value] || value })),
  ];
}

function permissionOptions() {
  const labels = {
    ":read-only": "Read only",
    ":workspace": "Workspace access",
    ":danger-full-access": "Full access",
  };
  return [
    { value: "", label: "Inherit current thread" },
    ...state.permissionProfiles.map((profile) => ({
      value: profile.id,
      label: labels[profile.id] || profile.id,
      description: profile.description,
      disabled: !profile.allowed,
    })),
  ];
}

function renderChatSettings() {
  const settings = currentChatSettings();
  if (
    state.modelsLoaded
    && settings.model
    && !state.models.some((model) => model.model === settings.model)
  ) {
    settings.model = "";
  }
  const modelOptions = [
    { value: "", label: "Inherit current thread" },
    ...state.models.map((model) => ({
      value: model.model,
      label: model.displayName,
      description: model.description,
    })),
  ];
  fillSelect(ui.settingModel, modelOptions, settings.model);

  const model = modelForSettings(settings);
  const efforts = model?.supportedReasoningEfforts || [];
  const effortOptions = [
    { value: "", label: "Inherit current thread" },
    ...efforts.map((entry) => ({
      value: entry.reasoningEffort,
      label: entry.reasoningEffort,
      description: entry.description,
    })),
  ];
  if (
    model
    && settings.effort
    && !efforts.some((entry) => entry.reasoningEffort === settings.effort)
  ) {
    settings.effort = "";
  }
  fillSelect(ui.settingEffort, effortOptions, settings.effort);

  const tiers = model?.serviceTiers || [];
  if (model && settings.serviceTier && !tiers.some((tier) => tier.id === settings.serviceTier)) {
    settings.serviceTier = "";
  }
  fillSelect(ui.settingServiceTier, [
    { value: "", label: "Inherit current thread" },
    ...tiers.map((tier) => ({ value: tier.id, label: tier.name, description: tier.description })),
  ], settings.serviceTier);
  ui.settingServiceTier.disabled = tiers.length === 0;

  const personalitySupported = !model || model.supportsPersonality !== false;
  if (!personalitySupported) settings.personality = "";
  fillSelect(ui.settingPersonality, [
    { value: "", label: "Inherit current thread" },
    { value: "none", label: "None" },
    { value: "friendly", label: "Friendly" },
    { value: "pragmatic", label: "Pragmatic" },
  ], settings.personality);
  ui.settingPersonality.disabled = !personalitySupported;

  fillSelect(ui.settingSummary, [
    { value: "", label: "Inherit current thread" },
    { value: "auto", label: "Automatic" },
    { value: "concise", label: "Concise" },
    { value: "detailed", label: "Detailed" },
    { value: "none", label: "Off" },
  ], settings.summary);
  fillSelect(ui.settingApproval, approvalOptions(), settings.approvalPolicy);
  if (
    state.permissionProfilesLoaded
    && settings.permissions
    && !state.permissionProfiles.some(
      (profile) => profile.id === settings.permissions && profile.allowed,
    )
  ) {
    settings.permissions = "";
  }
  fillSelect(ui.settingPermissions, permissionOptions(), settings.permissions);

  const count = CHAT_SETTING_FIELDS.filter((field) => settings[field]).length;
  const unavailable = !personalitySupported ? " Personality is unavailable for this model." : "";
  ui.settingsNote.textContent = `${count || "No"} override${count === 1 ? "" : "s"} set. Changes apply to the next message and remain with this thread.${unavailable}`;
  persistChatSettings();
}

function saveChatSettingsFromControls() {
  const settings = currentChatSettings();
  settings.model = ui.settingModel.value;
  settings.effort = ui.settingEffort.value;
  settings.serviceTier = ui.settingServiceTier.value;
  settings.personality = ui.settingPersonality.value;
  settings.summary = ui.settingSummary.value;
  settings.approvalPolicy = ui.settingApproval.value;
  settings.permissions = ui.settingPermissions.value;
  renderChatSettings();
}

function turnSettingsParams(settings) {
  const params = {};
  if (settings.model) params.model = settings.model;
  if (settings.effort) params.effort = settings.effort;
  if (settings.serviceTier) params.serviceTier = settings.serviceTier;
  if (settings.personality) params.personality = settings.personality;
  if (settings.summary) params.summary = settings.summary;
  if (settings.approvalPolicy) params.approvalPolicy = settings.approvalPolicy;
  if (settings.permissions) params.permissions = settings.permissions;
  return params;
}

function threadSettingsParams(settings) {
  const params = turnSettingsParams(settings);
  delete params.effort;
  delete params.summary;
  return params;
}

function setSettingsOpen(open, moveFocus = true) {
  state.settingsOpen = Boolean(open);
  ui.settingsPanel.hidden = !state.settingsOpen;
  ui.settingsToggle.setAttribute("aria-expanded", String(state.settingsOpen));
  if (moveFocus) (state.settingsOpen ? ui.settingModel : ui.settingsToggle).focus();
}

async function refreshPermissionProfiles() {
  if (!state.ready) return;
  try {
    const result = await rpc("permissionProfile/list", {
      cwd: ui.cwd.value || state.defaultCwd,
    });
    state.permissionProfiles = result?.data || [];
    state.permissionProfilesLoaded = true;
    renderChatSettings();
  } catch (error) {
    notice(`Permission settings unavailable: ${error.message}`);
  }
}

async function loadChatSettingsCatalog() {
  const [models, config, requirements, profiles] = await Promise.allSettled([
    rpc("model/list", { limit: 100, includeHidden: false }),
    rpc("config/read", { includeLayers: false }),
    rpc("configRequirements/read", {}),
    rpc("permissionProfile/list", { cwd: ui.cwd.value || state.defaultCwd }),
  ]);
  if (models.status === "fulfilled") {
    state.models = models.value?.data || [];
    state.modelsLoaded = true;
  }
  if (config.status === "fulfilled") state.configDefaults = config.value?.config || {};
  if (requirements.status === "fulfilled") {
    state.configRequirements = requirements.value?.requirements || null;
  }
  if (profiles.status === "fulfilled") {
    state.permissionProfiles = profiles.value?.data || [];
    state.permissionProfilesLoaded = true;
  }
  renderChatSettings();
  if (!state.models.length && models.status === "rejected") {
    notice(`Model settings unavailable: ${models.reason.message}`);
  }
}

function sidebarIsMobile() {
  return Boolean(
    globalThis.window?.matchMedia?.("(max-width: 760px)")?.matches,
  );
}

function sidebarViewportWidth() {
  const width = Number(globalThis.window?.innerWidth);
  return Number.isFinite(width) && width > 0 ? width : 1280;
}

function sidebarMaxWidth(viewportWidth = sidebarViewportWidth()) {
  const available = Number(viewportWidth) - MIN_CHAT_WIDTH;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, available));
}

function clampSidebarWidth(value, viewportWidth = sidebarViewportWidth()) {
  const parsed = Number(value);
  const width = Number.isFinite(parsed) ? parsed : DEFAULT_SIDEBAR_WIDTH;
  return Math.round(
    Math.max(MIN_SIDEBAR_WIDTH, Math.min(sidebarMaxWidth(viewportWidth), width)),
  );
}

function normalizeSidebarPreferredWidth(value) {
  const parsed = Number(value);
  const width = Number.isFinite(parsed) ? parsed : DEFAULT_SIDEBAR_WIDTH;
  return Math.round(
    Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width)),
  );
}

function sidebarStorageGet(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function sidebarStorageSet(key, value) {
  try {
    globalThis.localStorage?.setItem(key, String(value));
  } catch {
    // Layout controls still work when storage is unavailable.
  }
}

function renderSidebarWidth(width) {
  state.sidebarWidth = width;
  ui.shell.style.setProperty("--sidebar-width", `${width}px`);
  ui.sidebarResizer.setAttribute("aria-valuenow", String(width));
  ui.sidebarResizer.setAttribute("aria-valuemax", String(sidebarMaxWidth()));
  return width;
}

function setSidebarWidth(value, persist = false) {
  const width = clampSidebarWidth(value);
  state.sidebarPreferredWidth = width;
  renderSidebarWidth(width);
  if (persist) sidebarStorageSet(SIDEBAR_WIDTH_STORAGE_KEY, width);
  return width;
}

function applyPreferredSidebarWidth() {
  return renderSidebarWidth(clampSidebarWidth(state.sidebarPreferredWidth));
}

function syncSidebarVisibility() {
  const mobile = sidebarIsMobile();
  const expanded = mobile ? state.sidebarOpen : !state.sidebarCollapsed;
  ui.sidebar.classList.toggle("open", mobile && state.sidebarOpen);
  ui.shell.classList.toggle(
    "sidebar-collapsed",
    !mobile && state.sidebarCollapsed,
  );
  ui.sidebarScrim.hidden = !(mobile && state.sidebarOpen);
  ui.sidebar.inert = !expanded;
  ui.chat.inert = mobile && state.sidebarOpen;
  if (expanded) ui.sidebar.removeAttribute("aria-hidden");
  else ui.sidebar.setAttribute("aria-hidden", "true");
  ui.sidebarResizer.hidden = mobile || state.sidebarCollapsed;
  ui.sidebarResizer.setAttribute("aria-hidden", String(ui.sidebarResizer.hidden));
  ui.sidebarResizer.setAttribute(
    "tabindex",
    ui.sidebarResizer.hidden ? "-1" : "0",
  );
  for (const button of [ui.menu, ui.searchMenu]) {
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute(
      "aria-label",
      expanded ? "Hide conversations" : "Show conversations",
    );
    button.title = expanded ? "Hide conversations" : "Show conversations";
    button.textContent = mobile
      ? "Chats"
      : (expanded ? "Hide chats" : "Show chats");
  }
}

function setSidebarOpen(open, moveFocus = true) {
  state.sidebarOpen = Boolean(open);
  syncSidebarVisibility();
  if (moveFocus && sidebarIsMobile()) {
    const returnTarget = state.searchOpen ? ui.searchMenu : ui.menu;
    (state.sidebarOpen ? ui.closeSidebar : returnTarget).focus();
  }
}

function setSidebarCollapsed(collapsed, persist = true) {
  state.sidebarCollapsed = Boolean(collapsed);
  if (persist) {
    sidebarStorageSet(SIDEBAR_COLLAPSED_STORAGE_KEY, state.sidebarCollapsed);
  }
  syncSidebarVisibility();
}

function toggleSidebar() {
  if (sidebarIsMobile()) {
    setSidebarOpen(!state.sidebarOpen);
  } else {
    setSidebarCollapsed(!state.sidebarCollapsed);
  }
}

function sidebarPointerWidth(event) {
  const left = ui.shell.getBoundingClientRect?.().left || 0;
  return Number(event.clientX) - left;
}

function startSidebarResize(event) {
  if (
    sidebarIsMobile()
    || state.sidebarCollapsed
    || (event.button !== undefined && event.button !== 0)
  ) {
    return;
  }
  event.preventDefault?.();
  state.sidebarResizePointerId = event.pointerId ?? 1;
  ui.shell.classList.add("sidebar-resizing");
  if (event.pointerId !== undefined) {
    ui.sidebarResizer.setPointerCapture?.(event.pointerId);
  }
  setSidebarWidth(sidebarPointerWidth(event));
}

function moveSidebarResize(event) {
  if (
    state.sidebarResizePointerId === null
    || (event.pointerId ?? 1) !== state.sidebarResizePointerId
  ) {
    return;
  }
  event.preventDefault?.();
  setSidebarWidth(sidebarPointerWidth(event));
}

function finishSidebarResize(event) {
  if (
    state.sidebarResizePointerId === null
    || (event.pointerId ?? 1) !== state.sidebarResizePointerId
  ) {
    return;
  }
  if (event.type !== "pointercancel") {
    setSidebarWidth(sidebarPointerWidth(event));
  }
  cancelSidebarResize(true);
}

function cancelSidebarResize(persist = false) {
  if (state.sidebarResizePointerId === null) return;
  const pointerId = state.sidebarResizePointerId;
  state.sidebarResizePointerId = null;
  ui.shell.classList.remove("sidebar-resizing");
  try {
    if (
      typeof ui.sidebarResizer.hasPointerCapture !== "function"
      || ui.sidebarResizer.hasPointerCapture(pointerId)
    ) {
      ui.sidebarResizer.releasePointerCapture?.(pointerId);
    }
  } catch {
    // Capture may already be gone when the browser dispatches lostpointercapture.
  }
  if (persist) {
    sidebarStorageSet(SIDEBAR_WIDTH_STORAGE_KEY, state.sidebarPreferredWidth);
  }
}

function handleSidebarCaptureLoss(event) {
  if (
    state.sidebarResizePointerId !== null
    && (event.pointerId ?? 1) === state.sidebarResizePointerId
  ) {
    cancelSidebarResize(true);
  }
}

function resizeSidebarFromKeyboard(event) {
  if (sidebarIsMobile() || state.sidebarCollapsed) return;
  const widths = {
    ArrowLeft: state.sidebarWidth - SIDEBAR_KEYBOARD_STEP,
    ArrowRight: state.sidebarWidth + SIDEBAR_KEYBOARD_STEP,
    Home: MIN_SIDEBAR_WIDTH,
    End: sidebarMaxWidth(),
  };
  if (!(event.key in widths)) return;
  event.preventDefault?.();
  setSidebarWidth(widths[event.key], true);
}

function initializeSidebarLayout() {
  const savedWidth = sidebarStorageGet(SIDEBAR_WIDTH_STORAGE_KEY);
  state.sidebarPreferredWidth = normalizeSidebarPreferredWidth(
    savedWidth ?? DEFAULT_SIDEBAR_WIDTH,
  );
  applyPreferredSidebarWidth();
  state.sidebarCollapsed = (
    sidebarStorageGet(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"
  );
  syncSidebarVisibility();
}

function syncSidebarBreakpoint() {
  const activeElement = globalThis.document?.activeElement;
  const moveFocus = Boolean(
    activeElement
    && (
      activeElement === ui.sidebarResizer
      || activeElement === ui.closeSidebar
      || ui.sidebar.contains(activeElement)
    )
  );
  cancelSidebarResize(true);
  state.sidebarOpen = false;
  applyPreferredSidebarWidth();
  syncSidebarVisibility();
  if (moveFocus) (state.searchOpen ? ui.searchMenu : ui.menu).focus();
}

function setSearchOpen(open, moveFocus = true) {
  state.searchOpen = Boolean(open);
  ui.chat.classList.toggle("search-active", state.searchOpen);
  ui.searchView.hidden = !state.searchOpen;
  ui.searchChats.setAttribute("aria-pressed", String(state.searchOpen));
  if (state.searchOpen && state.settingsOpen) setSettingsOpen(false, false);
  if (!moveFocus) return;
  if (state.searchOpen) {
    ui.searchQuery.focus();
    return;
  }
  const mobile = sidebarIsMobile();
  (mobile || state.sidebarCollapsed ? ui.menu : ui.searchChats).focus();
}

function setSearchStatus(text, kind = "") {
  ui.searchStatus.textContent = text;
  ui.searchStatus.className = `search-status${kind ? ` ${kind}` : ""}`;
}

function setSearchBusy(busy) {
  ui.searchResults.setAttribute("aria-busy", String(Boolean(busy)));
  ui.searchSubmit.disabled = Boolean(busy);
  ui.searchSubmit.textContent = busy ? "Searching…" : "Search";
}

function searchValue(objects, keys) {
  for (const object of objects) {
    if (!object || typeof object !== "object") continue;
    for (const key of keys) {
      const value = object[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return null;
}

function searchText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return inputText(value);
  if (value && typeof value === "object") {
    return searchText(value.text ?? value.content ?? value.value ?? "");
  }
  return value === undefined || value === null ? "" : String(value);
}

function parseSearchDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  let parsed;
  if (typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    parsed = new Date(Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric);
  } else if (typeof value === "string" && value.trim()) {
    parsed = new Date(value);
  } else {
    return null;
  }
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeSearchRole(value) {
  const role = String(value || "").toLowerCase();
  if (["user", "human", "you"].includes(role)) return "user";
  if (["assistant", "agent", "codex"].includes(role)) return "assistant";
  return role || "message";
}

function normalizeSearchResult(raw) {
  const message = raw?.message && typeof raw.message === "object" ? raw.message : null;
  const thread = raw?.thread && typeof raw.thread === "object" ? raw.thread : null;
  const objects = [raw, message];
  const threadId = searchValue([raw, message, thread], ["threadId", "thread_id"])
    ?? searchValue([thread], ["id"]);
  const itemId = searchValue(objects, [
    "itemId",
    "item_id",
    "messageId",
    "message_id",
  ]) ?? searchValue([message], ["id"]);
  const turnId = searchValue(objects, ["turnId", "turn_id"]);
  const title = searchText(searchValue([raw, thread], [
    "threadTitle",
    "thread_title",
    "title",
    "name",
    "preview",
  ])) || "Untitled thread";
  const role = normalizeSearchRole(searchValue(objects, [
    "role",
    "messageRole",
    "message_role",
    "author",
  ]));
  const text = searchText(searchValue(objects, ["text", "content", "body"]));
  const snippet = searchText(searchValue(objects, [
    "snippet",
    "excerpt",
    "preview",
  ])) || text || "No preview available.";
  const matchedText = searchText(searchValue(objects, [
    "matchedText",
    "matched_text",
  ]));

  let dateSource = String(searchValue([raw], [
    "timestampSource",
    "timestamp_source",
    "dateSource",
    "date_source",
  ]) || "").toLowerCase();
  let dateValue = searchValue([message, raw], [
    "messageCreatedAt",
    "message_created_at",
    "messageTimestamp",
    "message_timestamp",
  ]);
  if (dateValue === null) {
    dateValue = searchValue([message, raw], ["timestamp", "createdAt", "created_at", "date"]);
  }
  if (dateValue === null) {
    dateValue = searchValue([raw, thread], [
      "threadUpdatedAt",
      "thread_updated_at",
      "updatedAt",
      "updated_at",
      "threadCreatedAt",
      "thread_created_at",
      "createdAt",
      "created_at",
    ]);
    dateSource = "thread";
  }
  if (!dateSource) dateSource = "message";

  return {
    raw,
    threadId: threadId === null ? "" : String(threadId),
    itemId: itemId === null ? "" : String(itemId),
    turnId: turnId === null ? "" : String(turnId),
    title,
    role,
    text,
    snippet,
    matchedText,
    date: parseSearchDate(dateValue),
    dateSource: dateSource.includes("thread") || dateSource.includes("turn")
      ? dateSource
      : "message",
  };
}

function normalizeSearchResponse(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.results)
      ? payload.results
      : (Array.isArray(payload?.data?.results) ? payload.data.results : (payload?.data || [])));
  const results = Array.isArray(rows)
    ? rows.filter((row) => row && typeof row === "object").map(normalizeSearchResult)
    : [];
  const totalValue = Array.isArray(payload)
    ? results.length
    : searchValue([payload], ["total", "totalCount", "total_count", "count"]);
  const numericTotal = Number(totalValue);
  const total = Number.isFinite(numericTotal) && numericTotal >= 0
    ? Math.max(numericTotal, results.length)
    : results.length;
  const truncated = !Array.isArray(payload) && Boolean(
    payload?.truncated
    || payload?.hasMore
    || payload?.has_more
    || total > results.length,
  );
  const skippedValue = Array.isArray(payload?.skippedThreads)
    ? payload.skippedThreads.length
    : Number(payload?.skippedThreads ?? payload?.skipped_threads ?? 0);
  const skippedThreads = Number.isFinite(skippedValue) && skippedValue > 0 ? skippedValue : 0;
  const partial = !Array.isArray(payload) && Boolean(payload?.partial || skippedThreads);
  return { results, total, truncated, partial, skippedThreads };
}

function formatSearchDate(date) {
  if (!date) return "Date unavailable";
  try {
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return date.toLocaleString();
  }
}

function appendHighlightedText(container, text, query) {
  const source = String(text || "");
  const needle = String(query || "").trim();
  if (!needle) {
    container.textContent = source;
    return;
  }
  const exactMatch = source.includes(needle);
  const foldedSource = exactMatch ? source : source.toLocaleLowerCase();
  const foldedNeedle = exactMatch ? needle : needle.toLocaleLowerCase();
  let cursor = 0;
  let marks = 0;
  while (cursor < source.length && marks < 50) {
    const match = foldedSource.indexOf(foldedNeedle, cursor);
    if (match < 0) break;
    if (match > cursor) {
      const before = document.createElement("span");
      before.textContent = source.slice(cursor, match);
      container.append(before);
    }
    const mark = document.createElement("mark");
    mark.textContent = source.slice(match, match + needle.length);
    container.append(mark);
    cursor = match + needle.length;
    marks += 1;
  }
  if (cursor < source.length) {
    const after = document.createElement("span");
    after.textContent = source.slice(cursor);
    container.append(after);
  }
}

function searchRoleLabel(role) {
  if (role === "user") return "You";
  if (role === "assistant") return "Codex";
  return role === "message" ? "Message" : `${role[0]?.toUpperCase() || ""}${role.slice(1)}`;
}

function searchItemText(item) {
  if (!item) return "";
  if (item.type === "userMessage") return inputText(item.content);
  return searchText(item.text ?? item.content ?? "");
}

function locateSearchItem(result, query) {
  if (result.itemId && state.items.has(result.itemId)) {
    return { itemId: result.itemId, exact: true };
  }
  const entry = cachedThread(result.threadId, false);
  if (!entry) return null;
  let turns = entry.thread?.turns || [];
  if (result.turnId) {
    const matchingTurn = turns.find((turn) => String(turn.id) === result.turnId);
    if (matchingTurn) turns = [matchingTurn];
  }
  let candidates = turns.flatMap((turn) => turn.items || []).filter((item) => (
    item?.id && state.items.has(item.id) && ["userMessage", "agentMessage"].includes(item.type)
  ));
  const type = result.role === "user"
    ? "userMessage"
    : (result.role === "assistant" ? "agentMessage" : "");
  const roleCandidates = type ? candidates.filter((item) => item.type === type) : [];
  if (roleCandidates.length) candidates = roleCandidates;
  const needle = String(query || "").trim().toLocaleLowerCase();
  const textMatch = needle
    ? candidates.find((item) => searchItemText(item).toLocaleLowerCase().includes(needle))
    : null;
  const selected = textMatch || candidates[0];
  return selected ? { itemId: String(selected.id), exact: false } : null;
}

function focusSearchItem(itemId) {
  const node = state.items.get(itemId)?.node;
  if (!node) return false;
  node.setAttribute("tabindex", "-1");
  node.classList.add("search-match");
  node.scrollIntoView?.({ behavior: "smooth", block: "center" });
  node.focus({ preventScroll: true });
  window.setTimeout(() => {
    node.classList.remove("search-match");
    node.removeAttribute("tabindex");
  }, SEARCH_MATCH_HIGHLIGHT_MS);
  return true;
}

function isSearchSelectionCurrent(threadId, selectionId) {
  return state.threadId === threadId && state.selectionId === selectionId;
}

async function openSearchResult(result, query, button) {
  if (!state.ready) {
    setSearchStatus("Chats are reconnecting. Try opening this result again in a moment.", "error");
    return;
  }
  button.disabled = true;
  let selectionId = null;
  try {
    setSearchOpen(false, false);
    setSidebarOpen(false, false);
    const opening = openThread(result.threadId);
    selectionId = state.selectionId;
    await opening;
    if (!isSearchSelectionCurrent(result.threadId, selectionId)) return;
    if (!cachedThread(result.threadId, false)) {
      if (!ui.notice.textContent) notice("Unable to load this conversation.");
      return;
    }
    const match = locateSearchItem(result, query);
    if (match && focusSearchItem(match.itemId)) {
      notice(match.exact ? "" : "Opened the matching turn; the exact message position was unavailable.");
    } else {
      notice("Opened the conversation; the exact matching message could not be positioned.");
    }
  } catch (error) {
    if (selectionId !== null && !isSearchSelectionCurrent(result.threadId, selectionId)) return;
    notice(error.message || "Unable to open this search result.");
  } finally {
    button.disabled = !result.threadId;
  }
}

function renderSearchResults(response, query) {
  state.searchResults = response.results;
  ui.searchResults.replaceChildren();
  if (!response.results.length) {
    let summary = `No messages found for “${query}”.`;
    if (response.partial) {
      const skipped = response.skippedThreads
        ? `${response.skippedThreads.toLocaleString()} conversation${response.skippedThreads === 1 ? "" : "s"}`
        : "Some conversations";
      summary += ` ${skipped} could not be searched.`;
    }
    setSearchStatus(summary, response.partial ? "error" : "empty");
    return;
  }

  const shown = response.results.length;
  let summary;
  if (response.truncated || response.total > shown) {
    summary = `Showing ${shown.toLocaleString()} of ${response.total.toLocaleString()} matches. Refine your search or date range to narrow the results.`;
  } else {
    summary = `${response.total.toLocaleString()} match${response.total === 1 ? "" : "es"} found.`;
  }
  if (response.partial) {
    const skipped = response.skippedThreads
      ? `${response.skippedThreads.toLocaleString()} conversation${response.skippedThreads === 1 ? "" : "s"}`
      : "Some conversations";
    summary += ` ${skipped} could not be searched.`;
  }
  setSearchStatus(summary, response.partial ? "error" : "");

  for (const result of response.results) {
    const item = document.createElement("li");
    item.className = "search-result";
    const button = document.createElement("button");
    button.className = "search-result-button";
    button.type = "button";
    button.disabled = !result.threadId;

    const heading = document.createElement("span");
    heading.className = "search-result-heading";
    const title = document.createElement("strong");
    title.className = "search-result-title";
    title.textContent = result.title;
    const role = document.createElement("span");
    role.className = "search-result-role";
    role.textContent = searchRoleLabel(result.role);
    heading.append(title, role);

    const snippet = document.createElement("span");
    snippet.className = "search-result-snippet";
    appendHighlightedText(snippet, result.snippet, result.matchedText || query);

    const meta = document.createElement("span");
    meta.className = "search-result-meta";
    if (result.date) {
      const time = document.createElement("time");
      time.setAttribute("datetime", result.date.toISOString());
      time.textContent = formatSearchDate(result.date);
      meta.append(time);
    } else {
      meta.textContent = "Date unavailable";
    }
    if (result.dateSource !== "message") {
      const fallback = document.createElement("span");
      const turnTime = result.dateSource.includes("turn");
      fallback.className = "search-result-fallback";
      fallback.textContent = turnTime ? " · turn time" : " · conversation date";
      fallback.title = turnTime
        ? "An exact message timestamp was unavailable; this is the matching turn's timestamp."
        : "An exact message timestamp was unavailable; this is the conversation's timestamp.";
      meta.append(fallback);
    }
    if (!result.threadId) meta.textContent += " · conversation unavailable";

    button.append(heading, snippet, meta);
    button.addEventListener("click", () => openSearchResult(result, query, button));
    item.append(button);
    ui.searchResults.append(item);
  }
}

function validateSearchDates() {
  ui.searchFrom.removeAttribute("aria-invalid");
  ui.searchTo.removeAttribute("aria-invalid");
  if (!ui.searchFrom.value || !ui.searchTo.value || ui.searchFrom.value <= ui.searchTo.value) {
    return true;
  }
  ui.searchFrom.setAttribute("aria-invalid", "true");
  ui.searchTo.setAttribute("aria-invalid", "true");
  ui.searchResults.replaceChildren();
  setSearchStatus("The start date must be on or before the end date.", "error");
  return false;
}

async function performSearch(event) {
  event?.preventDefault?.();
  state.searchAbortController?.abort();
  state.searchAbortController = null;
  const requestId = ++state.searchRequestId;
  const query = ui.searchQuery.value.trim();
  if (!query) {
    setSearchBusy(false);
    ui.searchResults.replaceChildren();
    setSearchStatus("Enter a word or phrase to search your chat history.");
    ui.searchQuery.focus();
    return;
  }
  if (!validateSearchDates()) {
    setSearchBusy(false);
    return;
  }

  const controller = new AbortController();
  state.searchAbortController = controller;
  setSearchBusy(true);
  ui.searchResults.replaceChildren();
  setSearchStatus(`Searching for “${query}”…`, "loading");

  const params = { q: query, sort: ui.searchSort.value || "newest" };
  if (ui.searchFrom.value) params.from = ui.searchFrom.value;
  if (ui.searchTo.value) params.to = ui.searchTo.value;
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone) params.timezone = timezone;
  } catch {
    // Date filtering remains available in environments without an IANA time zone.
  }
  try {
    const response = await fetch("/api/search", {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const errorMessage = typeof payload.error === "string"
        ? payload.error
        : (payload.error?.message || payload.message);
      throw new Error(errorMessage || `Search failed (${response.status})`);
    }
    if (requestId !== state.searchRequestId) return;
    renderSearchResults(normalizeSearchResponse(payload), query);
  } catch (error) {
    if (error.name === "AbortError" || requestId !== state.searchRequestId) return;
    ui.searchResults.replaceChildren();
    setSearchStatus(error.message || "Search is temporarily unavailable.", "error");
  } finally {
    if (requestId === state.searchRequestId) {
      state.searchAbortController = null;
      setSearchBusy(false);
    }
  }
}

function clearSearch() {
  state.searchAbortController?.abort();
  state.searchAbortController = null;
  state.searchRequestId += 1;
  state.searchResults = [];
  ui.searchQuery.value = "";
  ui.searchFrom.value = "";
  ui.searchTo.value = "";
  ui.searchSort.value = "newest";
  ui.searchFrom.removeAttribute("aria-invalid");
  ui.searchTo.removeAttribute("aria-invalid");
  ui.searchResults.replaceChildren();
  setSearchBusy(false);
  setSearchStatus("Enter a word or phrase to search your chat history.");
  ui.searchQuery.focus();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderAttachments() {
  ui.attachments.replaceChildren();
  ui.attachments.hidden = state.attachments.length === 0;
  state.attachments.forEach((attachment, index) => {
    const chip = document.createElement("span");
    chip.className = "attachment";
    chip.title = attachment.path;
    const kind = document.createElement("span");
    kind.className = "attachment-kind";
    kind.textContent = attachment.image ? "image" : "file";
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = `${attachment.name} · ${formatBytes(attachment.size)}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${attachment.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    });
    chip.append(kind, name, remove);
    ui.attachments.append(chip);
  });
}

async function uploadFiles(fileList) {
  const files = [...fileList].filter((file) => file.size >= 0);
  if (!files.length || selectedThreadBusy() || state.uploading) return;

  const limits = state.uploadLimits;
  if (limits && state.attachments.length + files.length > limits.maxFiles) {
    notice(`At most ${limits.maxFiles} attachments are allowed.`);
    return;
  }
  const oversized = limits && files.find((file) => file.size > limits.maxBytes);
  if (oversized) {
    notice(`${oversized.name} exceeds the ${formatBytes(limits.maxBytes)} limit.`);
    return;
  }
  const totalBytes = [
    ...state.attachments.map((attachment) => attachment.size),
    ...files.map((file) => file.size),
  ].reduce((total, size) => total + size, 0);
  if (limits && totalBytes > limits.maxTotalBytes) {
    notice(`Attachments exceed the ${formatBytes(limits.maxTotalBytes)} total limit.`);
    return;
  }

  state.uploading = true;
  updateControls();
  notice(`Uploading ${files.length} file${files.length === 1 ? "" : "s"}…`);
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);

  try {
    const response = await fetch("/api/uploads", { method: "POST", body: form });
    let result;
    try {
      result = await response.json();
    } catch {
      result = {};
    }
    if (!response.ok) throw new Error(result.error || `Upload failed (${response.status})`);
    state.attachments.push(...(result.files || []));
    renderAttachments();
    notice("");
  } catch (error) {
    notice(error.message);
  } finally {
    state.uploading = false;
    ui.fileInput.value = "";
    updateControls();
  }
}

function buildTurnInput(text, attachments) {
  const files = attachments.filter((attachment) => !attachment.image);
  let prompt = text.trim();
  if (files.length) {
    const references = files
      .map((attachment) => `- ${attachment.name}: ${attachment.path}`)
      .join("\n");
    const heading = "Attached files are available locally at these paths:";
    prompt = prompt
      ? `${prompt}\n\n${heading}\n${references}`
      : `Please inspect the attached file${files.length === 1 ? "" : "s"}.\n\n${heading}\n${references}`;
  }

  const input = [];
  if (prompt) input.push({ type: "text", text: prompt });
  for (const attachment of attachments) {
    if (attachment.image) input.push({ type: "localImage", path: attachment.path });
  }
  return input;
}

function pendingPromptText(text, attachments) {
  const labels = attachments.map(
    (attachment) => `[${attachment.image ? "Image" : "File"}: ${attachment.name}]`,
  );
  return [text.trim(), ...labels].filter(Boolean).join("\n");
}

function send(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    throw new Error("Codex connection is not open");
  }
  state.ws.send(JSON.stringify(message));
}

function rpc(method, params = {}, timeoutMs = 60000) {
  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    state.pending.set(id, { resolve, reject, timer, method });
    try {
      send({ method, id, params });
    } catch (error) {
      window.clearTimeout(timer);
      state.pending.delete(id);
      reject(error);
    }
  });
}

function notify(method, params = {}) {
  send({ method, params });
}

function respond(id, result = null, error = null) {
  send(error ? { id, error } : { id, result });
}

function failPending(message) {
  for (const pending of state.pending.values()) {
    window.clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  state.pending.clear();
}

async function connect() {
  window.clearTimeout(state.reconnectTimer);
  setStatus("connecting", "connecting");
  state.ready = false;
  updateControls();

  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${scheme}//${location.host}/ws`);
  state.ws = socket;

  socket.addEventListener("open", async () => {
    try {
      await rpc("initialize", {
        clientInfo: {
          name: "codex_web",
          title: "Codex Web",
          version: APP_VERSION,
        },
        capabilities: { experimentalApi: true },
      });
      notify("initialized", {});
      state.connectionGeneration += 1;
      state.ready = true;
      setStatus("connected", "online");
      notice("");
      updateControls();
      await loadChatSettingsCatalog();
      await refreshThreads();
      if (state.threadId) await openThread(state.threadId, false);
    } catch (error) {
      notice(error.message);
      socket.close();
    }
  });

  socket.addEventListener("message", (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (error) {
      notice(`Bad server message: ${error.message}`);
    }
  });

  socket.addEventListener("close", () => {
    if (state.ws !== socket) return;
    state.ready = false;
    state.activeTurns.clear();
    state.submittingThreads.clear();
    state.submittingViews.clear();
    failPending("Connection closed");
    setStatus("offline", "offline");
    updateControls();
    state.reconnectTimer = window.setTimeout(connect, 1800);
  });

  socket.addEventListener("error", () => {
    notice("Unable to reach the Codex backend");
  });
}

function handleMessage(message) {
  if (Object.hasOwn(message, "id") && !message.method) {
    const pending = state.pending.get(message.id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    state.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || "Codex request failed"));
    else pending.resolve(message.result);
    return;
  }

  if (!message.method) return;
  if (Object.hasOwn(message, "id")) {
    handleServerRequest(message);
  } else {
    handleNotification(message.method, message.params || {});
  }
}

function handleNotification(method, params) {
  switch (method) {
    case "codex-web/connected":
      return;
    case "codex-web/error":
      notice(params.message || "Proxy error");
      return;
    case "thread/started":
      refreshThreads();
      return;
    case "thread/name/updated":
      if (cachedThread(params.threadId, false) && params.name) {
        cachedThread(params.threadId, false).thread.name = params.name;
      }
      refreshThreads();
      return;
    case "thread/archived":
      refreshThreads();
      return;
    case "thread/deleted":
      state.threadCache.delete(params.threadId);
      state.composerDrafts.delete(threadComposerKey(params.threadId));
      state.promptHistoryByThread.delete(params.threadId);
      state.promptHistoryIndexesByThread.delete(params.threadId);
      refreshThreads();
      return;
    case "thread/status/changed":
      if (cachedThread(params.threadId, false)) {
        cachedThread(params.threadId, false).thread.status = params.status;
      }
      if (params.status?.type === "active") {
        if (!state.activeTurns.has(params.threadId)) {
          state.activeTurns.set(params.threadId, null);
        }
      } else {
        state.activeTurns.delete(params.threadId);
      }
      updateControls();
      refreshThreads();
      return;
    case "turn/started":
      cacheTurnUpdate(params.threadId, params.turn || {});
      if (cachedThread(params.threadId, false)) {
        cachedThread(params.threadId, false).thread.status = {
          type: "active",
          activeFlags: [],
        };
      }
      setThreadActivity(params.threadId, params.turn?.id);
      refreshThreads();
      return;
    case "turn/completed":
      cacheTurnUpdate(params.threadId, params.turn || {}, "completed");
      clearThreadActivity(params.threadId);
      refreshThreads();
      return;
    case "item/started":
      cacheItemUpdate(params);
      if (params.threadId === state.threadId) renderItem(params.item, false);
      return;
    case "item/completed":
      cacheItemUpdate(params);
      rememberThreadPrompt(params.threadId, params.item);
      if (params.threadId === state.threadId) renderItem(params.item, true);
      return;
    case "item/agentMessage/delta":
      appendCachedText(params, "agentMessage");
      if (params.threadId === state.threadId) upsertMessage(params.itemId, "agent", params.delta, true);
      return;
    case "item/plan/delta":
      appendCachedText(params, "plan");
      if (params.threadId === state.threadId) upsertActivity(params.itemId, "plan", params.delta, true);
      return;
    case "item/reasoning/summaryTextDelta":
      appendCachedReasoning(params);
      if (params.threadId === state.threadId) upsertActivity(params.itemId, "reasoning", params.delta, true);
      return;
    case "item/commandExecution/outputDelta":
      appendCachedText(params, "commandExecution", "aggregatedOutput");
      if (params.threadId === state.threadId) upsertActivity(params.itemId, "command", params.delta, true);
      return;
    case "serverRequest/resolved":
      removeRequest(params.requestId);
      return;
    case "error":
    case "warning":
      notice(params.message || params.error?.message || method);
      return;
    default:
      return;
  }
}

function clearMessages() {
  for (const entry of state.items.values()) {
    if (entry.renderFrame && globalThis.window?.cancelAnimationFrame) {
      window.cancelAnimationFrame(entry.renderFrame);
    }
  }
  ui.thinkingIndicator.hidden = true;
  ui.messages.setAttribute("aria-busy", "false");
  ui.messages.replaceChildren(ui.thinkingIndicator);
  state.items.clear();
  state.pendingUser = null;
  state.followPresent = true;
  ui.jumpPresent.hidden = true;
}

function removeEmpty() {
  ui.messages.querySelector(".empty")?.remove();
}

function messagesAtPresent() {
  const distance = ui.messages.scrollHeight
    - ui.messages.clientHeight
    - ui.messages.scrollTop;
  return distance <= PRESENT_THRESHOLD_PX;
}

function handleMessagesScroll() {
  state.followPresent = messagesAtPresent();
  if (state.followPresent) ui.jumpPresent.hidden = true;
}

function jumpToPresent() {
  state.followPresent = true;
  ui.jumpPresent.hidden = true;
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function presentContentChanged(shouldFollow = state.followPresent) {
  if (state.renderTarget) return;
  if (shouldFollow && state.followPresent) {
    jumpToPresent();
  } else {
    state.followPresent = false;
    ui.jumpPresent.hidden = false;
  }
}

function appendMessageNode(node) {
  const target = state.renderTarget || ui.messages;
  if (target === ui.messages && ui.thinkingIndicator.parentNode === ui.messages) {
    ui.messages.insertBefore(node, ui.thinkingIndicator);
  } else {
    target.append(node);
  }
}

function renderMessageBody(entry) {
  const renderMarkdown = globalThis.CodexMarkdown?.render;
  if (typeof renderMarkdown !== "function") {
    entry.body.classList.add("plain-text");
    entry.body.textContent = entry.text;
    return;
  }

  const commit = () => {
    const shouldFollow = state.followPresent && messagesAtPresent();
    entry.renderFrame = null;
    entry.body.classList.remove("plain-text");
    entry.body.replaceChildren(renderMarkdown(entry.text));
    presentContentChanged(shouldFollow);
  };
  if (state.renderTarget || typeof window.requestAnimationFrame !== "function") {
    commit();
    return;
  }
  if (entry.renderFrame) window.cancelAnimationFrame(entry.renderFrame);
  entry.renderFrame = window.requestAnimationFrame(commit);
}

function upsertMessage(id, role, text, append = false) {
  const shouldFollow = state.followPresent && messagesAtPresent();
  removeEmpty();
  let entry = state.items.get(id);
  if (!entry || entry.kind !== "message") {
    const node = document.createElement("article");
    node.className = `message ${role}`;
    const label = document.createElement("div");
    label.className = "role";
    label.textContent = role === "user" ? "You" : "Codex";
    const body = document.createElement("div");
    body.className = "body";
    node.append(label, body);
    appendMessageNode(node);
    entry = { kind: "message", node, body, text: "", renderFrame: null };
    state.items.set(id, entry);
  }
  entry.text = append ? entry.text + (text || "") : (text || "");
  renderMessageBody(entry);
  presentContentChanged(shouldFollow);
  return entry.node;
}

function upsertActivity(id, title, text, append = false) {
  const shouldFollow = state.followPresent && messagesAtPresent();
  removeEmpty();
  let entry = state.items.get(id);
  if (!entry || entry.kind !== "activity") {
    const node = document.createElement("details");
    node.className = "activity";
    const summary = document.createElement("summary");
    const body = document.createElement("pre");
    node.append(summary, body);
    appendMessageNode(node);
    entry = { kind: "activity", node, summary, body, text: "", totalChars: 0 };
    state.items.set(id, entry);
  }
  entry.summary.textContent = title;
  const incoming = typeof text === "string" ? text : (text == null ? "" : String(text));
  if (append) {
    entry.totalChars += incoming.length;
    const remaining = MAX_ACTIVITY_CHARS - entry.text.length;
    if (remaining > 0) entry.text += incoming.slice(0, remaining);
  } else {
    entry.totalChars = incoming.length;
    entry.text = incoming.slice(0, MAX_ACTIVITY_CHARS);
  }
  const omitted = entry.totalChars - entry.text.length;
  entry.body.textContent = omitted > 0
    ? `${entry.text}\n\n… ${omitted.toLocaleString()} characters omitted`
    : entry.text;
  entry.body.hidden = entry.totalChars === 0;
  presentContentChanged(shouldFollow);
  return entry.node;
}

function inputText(content = []) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part?.type === "text") return part.text || "";
      if (part?.type === "localImage") {
        const name = String(part.path || "image").split(/[\\/]/).at(-1);
        return `[Image: ${name}]`;
      }
      if (part?.type === "image") return `[Image: ${part.url || "remote image"}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function setThreadPromptHistory(thread) {
  if (!thread?.id) return;
  const prompts = [];
  const indexes = new Map();
  for (const turn of thread.turns || []) {
    for (const item of turn.items || []) {
      if (item?.type !== "userMessage") continue;
      const text = inputText(item.content).trim();
      if (!text) continue;
      if (item.id) indexes.set(String(item.id), prompts.length);
      prompts.push(text);
    }
  }
  state.promptHistoryByThread.set(thread.id, prompts);
  state.promptHistoryIndexesByThread.set(thread.id, indexes);
  if (thread.id === state.threadId) resetPromptHistoryNavigation();
}

function rememberThreadPrompt(threadId, item) {
  if (!threadId || item?.type !== "userMessage") return;
  const text = inputText(item.content).trim();
  if (!text) return;
  const prompts = state.promptHistoryByThread.get(threadId) || [];
  const indexes = state.promptHistoryIndexesByThread.get(threadId) || new Map();
  const itemId = item.id ? String(item.id) : "";
  const existingIndex = itemId ? indexes.get(itemId) : undefined;
  if (existingIndex === undefined) {
    if (itemId) indexes.set(itemId, prompts.length);
    prompts.push(text);
  } else {
    prompts[existingIndex] = text;
  }
  state.promptHistoryByThread.set(threadId, prompts);
  state.promptHistoryIndexesByThread.set(threadId, indexes);
}

function currentPromptHistory() {
  if (!state.threadId) return [];
  return state.promptHistoryByThread.get(state.threadId) || [];
}

function promptCaretIsOnFirstLine() {
  const start = Number.isInteger(ui.prompt.selectionStart)
    ? ui.prompt.selectionStart
    : ui.prompt.value.length;
  const end = Number.isInteger(ui.prompt.selectionEnd)
    ? ui.prompt.selectionEnd
    : start;
  return start === end && !ui.prompt.value.slice(0, start).includes("\n");
}

function showPromptHistoryValue(value) {
  ui.prompt.value = value;
  saveComposerDraft();
  ui.prompt.setSelectionRange?.(value.length, value.length);
}

function navigatePromptHistory(event) {
  if (
    event.isComposing
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) return false;
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;

  const prompts = currentPromptHistory();
  if (!prompts.length) {
    resetPromptHistoryNavigation();
    return false;
  }

  if (event.key === "ArrowUp") {
    if (state.promptHistoryIndex === null) {
      if (!promptCaretIsOnFirstLine()) return false;
      state.promptHistoryDraft = ui.prompt.value;
      state.promptHistoryIndex = prompts.length;
    }
    state.promptHistoryIndex = Math.max(0, state.promptHistoryIndex - 1);
    showPromptHistoryValue(prompts[state.promptHistoryIndex]);
    return true;
  }

  if (state.promptHistoryIndex === null) return false;
  const nextIndex = state.promptHistoryIndex + 1;
  if (nextIndex < prompts.length) {
    state.promptHistoryIndex = nextIndex;
    showPromptHistoryValue(prompts[nextIndex]);
  } else {
    const draft = state.promptHistoryDraft;
    resetPromptHistoryNavigation();
    showPromptHistoryValue(draft);
  }
  return true;
}

function reasoningText(summary) {
  if (!Array.isArray(summary)) return typeof summary === "string" ? summary : "";
  return summary
    .map((part) => typeof part === "string" ? part : (part?.text || ""))
    .filter(Boolean)
    .join("\n");
}

function fileChangeText(item) {
  return (item.changes || []).map((change) => {
    const path = change.path || change.movePath || "file";
    return `${change.kind || "change"}: ${path}`;
  }).join("\n");
}

function renderItem(item, completed, threadId = state.threadId) {
  if (!item?.id || !item.type) return;
  switch (item.type) {
    case "userMessage":
      if (state.pendingUser?.threadId === threadId) {
        state.pendingUser.node.remove();
        state.items.delete(state.pendingUser.id);
        state.pendingUser = null;
      }
      upsertMessage(item.id, "user", inputText(item.content));
      break;
    case "agentMessage":
      upsertMessage(item.id, "agent", item.text || "");
      break;
    case "plan":
      upsertActivity(item.id, "plan", item.text || "");
      break;
    case "reasoning": {
      const summary = reasoningText(item.summary);
      if (summary) upsertActivity(item.id, "reasoning summary", summary);
      break;
    }
    case "commandExecution": {
      const status = completed ? item.status : `${item.status || "running"}…`;
      upsertActivity(item.id, `$ ${item.command} · ${status}`, item.aggregatedOutput || "");
      break;
    }
    case "fileChange":
      upsertActivity(item.id, `files · ${item.status || "pending"}`, fileChangeText(item));
      break;
    case "mcpToolCall":
      upsertActivity(item.id, `${item.server}/${item.tool} · ${item.status}`, JSON.stringify(item.result || item.error || item.arguments || {}, null, 2));
      break;
    case "dynamicToolCall":
      upsertActivity(item.id, `${item.tool} · ${item.status}`, JSON.stringify(item.contentItems || item.arguments || {}, null, 2));
      break;
    case "webSearch":
      upsertActivity(item.id, `search · ${item.query}`, "");
      break;
    case "contextCompaction":
      break;
    default:
      if (completed) upsertActivity(item.id, item.type, JSON.stringify(item, null, 2));
  }
}

function renderThreadHistory(thread) {
  setThreadPromptHistory(thread);
  clearMessages();
  const turns = thread.turns || [];
  const fragment = document.createDocumentFragment();
  state.renderTarget = fragment;
  try {
    for (const turn of turns) {
      for (const item of turn.items || []) renderItem(item, true, thread.id);
    }
  } finally {
    state.renderTarget = null;
  }
  appendMessageNode(fragment);
  if (!state.items.size) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No turns yet.";
    appendMessageNode(empty);
  }
  const activeTurn = [...turns].reverse().find((turn) => turn.status === "inProgress");
  if (thread.status?.type === "active" || activeTurn) {
    state.activeTurns.set(thread.id, activeTurn?.id || null);
  } else if (!state.submittingThreads.has(thread.id)) {
    state.activeTurns.delete(thread.id);
  }
  updateControls();
  jumpToPresent();
}

function renderCachedThread(entry) {
  const thread = entry.thread;
  ui.title.textContent = threadLabel(thread);
  ui.cwd.value = thread.cwd || state.defaultCwd;
  renderThreadHistory(thread);
  if (!entry.followPresent) {
    state.followPresent = false;
    ui.messages.scrollTop = entry.scrollTop;
    ui.jumpPresent.hidden = messagesAtPresent();
  }
  if (entry.pendingUser) {
    const pending = entry.pendingUser;
    const node = upsertMessage(pending.id, "user", pending.text);
    state.pendingUser = { ...pending, node };
  }
}

function threadLabel(thread) {
  return thread.name || thread.preview || "Untitled thread";
}

function threadActivityTimestamp(thread) {
  for (const value of [thread?.recencyAt, thread?.updatedAt, thread?.createdAt]) {
    const timestamp = Number(value);
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  }
  return 0;
}

function sortThreadsByActivity(threads) {
  if (!Array.isArray(threads)) return [];
  return threads
    .map((thread, index) => ({ thread, index }))
    .sort((left, right) => (
      threadActivityTimestamp(right.thread) - threadActivityTimestamp(left.thread)
      || left.index - right.index
    ))
    .map(({ thread }) => thread);
}

function threadIdFromSearch(search = "") {
  try {
    const threadId = new URLSearchParams(search).get(THREAD_QUERY_PARAM)?.trim();
    return threadId || null;
  } catch {
    return null;
  }
}

function threadHref(threadId) {
  const params = new URLSearchParams({ [THREAD_QUERY_PARAM]: String(threadId) });
  return `/?${params.toString()}`;
}

function replaceThreadLocation(threadId) {
  if (typeof globalThis.window?.history?.replaceState !== "function") return;
  try {
    window.history.replaceState(null, "", threadId ? threadHref(threadId) : "/");
  } catch {
    // Navigation still works if browser history is unavailable.
  }
}

function plainPrimaryClick(event) {
  return !event.defaultPrevented
    && (event.button ?? 0) === 0
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey;
}

function renderThreads(threads, reconcileActivity = false) {
  const sortedThreads = sortThreadsByActivity(threads);
  state.threads = sortedThreads;
  ui.threads.replaceChildren();
  for (const thread of sortedThreads) {
    if (reconcileActivity) {
      if (thread.status?.type === "active" && !state.activeTurns.has(thread.id)) {
        state.activeTurns.set(thread.id, null);
      } else if (thread.status?.type !== "active" && !state.submittingThreads.has(thread.id)) {
        state.activeTurns.delete(thread.id);
      }
    }
    const running = thread.status?.type === "active"
      || state.activeTurns.has(thread.id)
      || state.submittingThreads.has(thread.id);
    const link = document.createElement("a");
    link.className = `thread${thread.id === state.threadId ? " active" : ""}${running ? " running" : ""}`;
    link.setAttribute("href", threadHref(thread.id));
    link.setAttribute("aria-busy", String(running));
    if (thread.id === state.threadId) link.setAttribute("aria-current", "page");
    const title = document.createElement("strong");
    title.textContent = threadLabel(thread);
    const meta = document.createElement("small");
    const activityTimestamp = threadActivityTimestamp(thread);
    const timestamp = activityTimestamp
      ? new Date(activityTimestamp * 1000).toLocaleString()
      : "Unknown time";
    meta.textContent = `${timestamp} · ${running ? "active" : (thread.status?.type || "unknown")}`;
    link.append(title, meta);
    link.addEventListener("click", (event) => {
      if (!plainPrimaryClick(event)) return;
      event.preventDefault();
      setSidebarOpen(false, false);
      setSearchOpen(false, false);
      openThread(thread.id);
    });
    ui.threads.append(link);
  }
}

async function refreshThreads() {
  if (!state.ready) return;
  const refreshId = ++state.threadRefreshId;
  try {
    const result = await rpc("thread/list", THREAD_LIST_PARAMS);
    if (refreshId !== state.threadRefreshId) return;
    renderThreads(result?.data || [], true);
  } catch (error) {
    notice(error.message);
  }
}

async function openThread(threadId, showErrors = true) {
  if (!state.ready) return;
  saveCurrentThreadView();
  saveComposerDraft();
  const selectionId = ++state.selectionId;
  state.threadId = threadId;
  state.composerKey = threadComposerKey(threadId, selectionId);
  restoreComposerDraft();
  replaceThreadLocation(threadId);
  renderChatSettings();
  notice("");
  const cached = cachedThread(threadId);
  if (cached) {
    renderCachedThread(cached);
  } else {
    ui.title.textContent = "Loading…";
    clearMessages();
    const loading = document.createElement("p");
    loading.className = "empty";
    loading.textContent = "Loading conversation…";
    appendMessageNode(loading);
  }
  renderThreads(state.threads);
  updateControls();
  if (cached?.generation === state.connectionGeneration) {
    refreshPermissionProfiles();
    refreshThreads();
    return;
  }
  try {
    const result = await rpc("thread/resume", { threadId });
    const thread = result.thread;
    const refreshed = cacheThreadSnapshot(thread);
    if (selectionId !== state.selectionId || state.threadId !== threadId) return;
    renderCachedThread(refreshed);
    await refreshPermissionProfiles();
    await refreshThreads();
  } catch (error) {
    if (showErrors && selectionId === state.selectionId && state.threadId === threadId) {
      notice(error.message);
    }
  }
}

function beginNewThread() {
  saveCurrentThreadView();
  saveComposerDraft();
  setSearchOpen(false, false);
  state.selectionId += 1;
  state.threadId = null;
  state.composerKey = threadComposerKey(null, state.selectionId);
  restoreComposerDraft();
  replaceThreadLocation(null);
  state.attachments = [];
  renderAttachments();
  notice("");
  ui.title.textContent = "New thread";
  ui.cwd.value = state.defaultCwd;
  renderChatSettings();
  clearMessages();
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = "Send a request to start a thread.";
  appendMessageNode(empty);
  renderThreads(state.threads);
  refreshThreads();
  refreshPermissionProfiles();
  updateControls();
}

function renderLocalPrompt(id, text, threadId, selectionId) {
  jumpToPresent();
  const node = upsertMessage(id, "user", text);
  const pending = { id, text, threadId, selectionId };
  state.pendingUser = { ...pending, node };
  setCachedPendingUser(threadId, pending);
  return node;
}

async function submitPrompt(event) {
  event.preventDefault();
  const draftText = ui.prompt.value;
  const text = draftText.trim();
  const attachments = [...state.attachments];
  const input = buildTurnInput(text, attachments);
  if (!input.length || !state.ready || selectedThreadBusy() || state.uploading) return;
  const selectionId = state.selectionId;
  const submissionComposerKey = state.composerKey;
  let targetComposerKey = submissionComposerKey;
  const cwd = ui.cwd.value || state.defaultCwd;
  const chatSettings = { ...currentChatSettings() };
  let targetThreadId = state.threadId;
  clearComposerDraft(submissionComposerKey);
  state.attachments = [];
  renderAttachments();
  notice("");
  state.submittingViews.add(selectionId);
  if (targetThreadId) state.submittingThreads.add(targetThreadId);
  updateControls();

  const pendingId = `pending-${Date.now()}-${selectionId}`;
  const pendingText = pendingPromptText(text, attachments);
  const pendingNode = renderLocalPrompt(
    pendingId,
    pendingText,
    targetThreadId,
    selectionId,
  );

  try {
    if (!targetThreadId) {
      const started = await rpc("thread/start", {
        cwd,
        ...threadSettingsParams(chatSettings),
      });
      targetThreadId = started.thread.id;
      targetComposerKey = threadComposerKey(targetThreadId, selectionId);
      moveComposerDraft(submissionComposerKey, targetComposerKey);
      cacheThreadSnapshot(started.thread);
      const pending = {
        id: pendingId,
        text: pendingText,
        threadId: targetThreadId,
        selectionId,
      };
      setCachedPendingUser(targetThreadId, pending);
      if (state.pendingUser?.id === pendingId) {
        state.pendingUser.threadId = targetThreadId;
      }
      state.settingsByThread.set(targetThreadId, { ...chatSettings });
      persistChatSettings();
      state.submittingThreads.add(targetThreadId);
      if (
        selectionId === state.selectionId
        && state.threadId === null
        && state.composerKey === submissionComposerKey
      ) {
        state.threadId = targetThreadId;
        state.composerKey = targetComposerKey;
        ui.title.textContent = threadLabel(started.thread);
        replaceThreadLocation(targetThreadId);
        renderChatSettings();
        renderThreads(state.threads);
      }
    }
    const result = await rpc("turn/start", {
      threadId: targetThreadId,
      input,
      cwd,
      ...turnSettingsParams(chatSettings),
    });
    if (result.turn) cacheTurnUpdate(targetThreadId, result.turn);
    if (result.turn?.status === "inProgress") {
      setThreadActivity(targetThreadId, result.turn.id);
    } else {
      clearThreadActivity(targetThreadId);
    }
    refreshThreads();
  } catch (error) {
    if (targetThreadId) {
      setCachedPendingUser(targetThreadId, null);
      state.submittingThreads.delete(targetThreadId);
      if (state.activeTurns.get(targetThreadId) === null) {
        state.activeTurns.delete(targetThreadId);
      }
    }
    if (selectionId === state.selectionId) {
      pendingNode.remove();
      if (state.pendingUser?.id === pendingId) state.pendingUser = null;
      state.items.delete(pendingId);
      if (!state.composerDrafts.has(targetComposerKey)) {
        state.composerDrafts.set(targetComposerKey, draftText);
      }
      if (state.composerKey === targetComposerKey) {
        restoreComposerDraft(targetComposerKey);
        ui.prompt.setSelectionRange?.(ui.prompt.value.length, ui.prompt.value.length);
      }
      state.attachments = attachments;
      renderAttachments();
      notice(error.message);
    } else {
      if (!state.composerDrafts.has(targetComposerKey)) {
        state.composerDrafts.set(targetComposerKey, draftText);
      }
      notice(`Background turn failed: ${error.message}`);
    }
  } finally {
    state.submittingViews.delete(selectionId);
    if (targetThreadId) state.submittingThreads.delete(targetThreadId);
    updateControls();
  }
}

async function stopTurn() {
  const threadId = state.threadId;
  const turnId = selectedTurnId();
  if (!threadId || !turnId) return;
  try {
    await rpc("turn/interrupt", { threadId, turnId });
  } catch (error) {
    notice(error.message);
  }
}

function removeRequest(id) {
  const card = state.requestCards.get(String(id));
  if (card) card.remove();
  state.requestCards.delete(String(id));
}

function actionButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action, { once: true });
  return button;
}

function approvalRequest(message, kind) {
  const params = message.params || {};
  const card = document.createElement("article");
  card.className = "request";
  const title = document.createElement("strong");
  title.textContent = kind === "command" ? "Command approval" : "File-change approval";
  const reason = document.createElement("p");
  reason.textContent = params.reason || "Codex requests approval.";
  const detail = document.createElement("pre");
  detail.textContent = params.command || params.cwd || params.grantRoot || params.itemId || "";
  const actions = document.createElement("div");
  actions.className = "actions";

  const decide = (decision) => {
    respond(message.id, { decision });
    removeRequest(message.id);
  };
  actions.append(
    actionButton("Allow", () => decide("accept")),
    actionButton("Allow session", () => decide("acceptForSession")),
    actionButton("Decline", () => decide("decline")),
    actionButton("Cancel turn", () => decide("cancel")),
  );
  card.append(title, reason, detail, actions);
  addRequest(message.id, card);
}

function userInputRequest(message) {
  const params = message.params || {};
  const card = document.createElement("article");
  card.className = "request";
  const title = document.createElement("strong");
  title.textContent = "Codex needs input";
  card.append(title);
  const controls = [];

  for (const question of params.questions || []) {
    const label = document.createElement("label");
    const prompt = document.createElement("span");
    prompt.textContent = `${question.header || "Question"}: ${question.question}`;
    let control;
    if (question.options?.length) {
      control = document.createElement("select");
      for (const option of question.options) {
        const choice = document.createElement("option");
        choice.value = option.label;
        choice.textContent = option.description ? `${option.label} — ${option.description}` : option.label;
        control.append(choice);
      }
    } else {
      control = document.createElement("input");
      control.type = question.isSecret ? "password" : "text";
    }
    label.append(prompt, control);
    card.append(label);
    controls.push({ id: question.id, control });
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(actionButton("Submit", () => {
    const answers = {};
    for (const entry of controls) answers[entry.id] = { answers: [entry.control.value] };
    respond(message.id, { answers });
    removeRequest(message.id);
  }));
  card.append(actions);
  addRequest(message.id, card);
}

function unsupportedRequest(message) {
  const card = document.createElement("article");
  card.className = "request";
  const title = document.createElement("strong");
  title.textContent = `Unsupported request: ${message.method}`;
  const detail = document.createElement("pre");
  detail.textContent = JSON.stringify(message.params || {}, null, 2);
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(actionButton("Reject", () => {
    respond(message.id, null, { code: -32601, message: `Unsupported by Codex Web: ${message.method}` });
    removeRequest(message.id);
  }));
  card.append(title, detail, actions);
  addRequest(message.id, card);
}

function addRequest(id, card) {
  removeRequest(id);
  state.requestCards.set(String(id), card);
  ui.requests.append(card);
}

function handleServerRequest(message) {
  switch (message.method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      approvalRequest(message, "command");
      break;
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      approvalRequest(message, "file");
      break;
    case "item/tool/requestUserInput":
      userInputRequest(message);
      break;
    default:
      unsupportedRequest(message);
  }
}

async function boot() {
  const requestedThreadId = threadIdFromSearch(globalThis.location?.search || "");
  if (requestedThreadId) {
    state.threadId = requestedThreadId;
    state.composerKey = threadComposerKey(requestedThreadId);
    restoreComposerDraft();
  }
  loadStoredChatSettings();
  renderChatSettings();
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    const config = await response.json();
    globalThis.CodexMarkdown?.configure?.({
      workspaceRoot: config.workspaceRoot,
    });
    state.defaultCwd = config.defaultCwd || state.defaultCwd;
    state.uploadLimits = config.uploads || null;
    ui.cwd.value = state.defaultCwd;
  } catch (error) {
    notice(`Configuration error: ${error.message}`);
  }
  connect();
}

function promptKeydown(event) {
  if (navigatePromptHistory(event)) {
    event.preventDefault();
    return;
  }
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  ui.composer.requestSubmit();
}

if (globalThis.CODEX_WEB_TEST) {
  globalThis.CodexWebTest = {
    MAX_ACTIVITY_CHARS,
    PRESENT_THRESHOLD_PX,
    THREAD_CACHE_LIMIT,
    THREAD_LIST_PARAMS,
    DEFAULT_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
    SIDEBAR_WIDTH_STORAGE_KEY,
    SIDEBAR_COLLAPSED_STORAGE_KEY,
    THREAD_QUERY_PARAM,
    buildTurnInput,
    clearComposerDraft,
    currentPromptHistory,
    handlePromptInput,
    inputText,
    navigatePromptHistory,
    pendingPromptText,
    promptKeydown,
    rememberThreadPrompt,
    resetPromptHistoryNavigation,
    restoreComposerDraft,
    saveComposerDraft,
    setThreadPromptHistory,
    threadComposerKey,
    threadHref,
    threadIdFromSearch,
    normalizeChatSettings,
    threadSettingsParams,
    turnSettingsParams,
    beginNewThread,
    cacheItemUpdate,
    cacheThreadSnapshot,
    cacheTurnUpdate,
    cachedThread,
    handleNotification,
    handleMessagesScroll,
    isSearchSelectionCurrent,
    jumpToPresent,
    renderThreadHistory,
    renderThinkingIndicator,
    renderLocalPrompt,
    renderThreads,
    renderThemeControl,
    selectedThreadBusy,
    selectedTurnId,
    setThreadActivity,
    cancelSidebarResize,
    clampSidebarWidth,
    applyPreferredSidebarWidth,
    finishSidebarResize,
    handleSidebarCaptureLoss,
    initializeSidebarLayout,
    moveSidebarResize,
    resizeSidebarFromKeyboard,
    setSidebarCollapsed,
    setSidebarOpen,
    setSidebarWidth,
    sidebarMaxWidth,
    startSidebarResize,
    syncSidebarBreakpoint,
    syncSidebarVisibility,
    toggleSidebar,
    setSearchOpen,
    setPreferencesOpen,
    normalizeSearchResponse,
    parseSearchDate,
    performSearch,
    renderSearchResults,
    validateSearchDates,
    sortThreadsByActivity,
    state,
    threadActivityTimestamp,
    ui,
    updateControls,
    upsertMessage,
  };
} else {
  ui.composer.addEventListener("submit", submitPrompt);
  renderThemeControl();
  globalThis.CodexTheme?.subscribe(renderThemeControl);
  ui.preferencesToggle.addEventListener("click", () => setPreferencesOpen(true));
  ui.preferencesClose.addEventListener("click", () => setPreferencesOpen(false));
  for (const button of [ui.themeSystem, ui.themeLight, ui.themeDark]) {
    button.addEventListener("click", () => {
      globalThis.CodexTheme?.setPreference(button.dataset.themePreference);
    });
  }
  ui.preferencesDialog.addEventListener("close", () => {
    if (ui.preferencesToggle.getAttribute("aria-expanded") === "true") {
      ui.preferencesToggle.setAttribute("aria-expanded", "false");
      ui.preferencesToggle.focus();
    }
  });
  ui.messages.addEventListener("scroll", handleMessagesScroll, { passive: true });
  ui.jumpPresent.addEventListener("click", jumpToPresent);
  ui.stop.addEventListener("click", stopTurn);
  ui.settingsToggle.addEventListener("click", () => setSettingsOpen(!state.settingsOpen));
  for (const select of [
    ui.settingModel,
    ui.settingEffort,
    ui.settingServiceTier,
    ui.settingPersonality,
    ui.settingSummary,
    ui.settingApproval,
    ui.settingPermissions,
  ]) {
    select.addEventListener("change", saveChatSettingsFromControls);
  }
  ui.cwd.addEventListener("change", refreshPermissionProfiles);
  ui.menu.addEventListener("click", toggleSidebar);
  ui.searchMenu.addEventListener("click", toggleSidebar);
  ui.closeSidebar.addEventListener("click", () => {
    if (sidebarIsMobile()) setSidebarOpen(false);
    else setSidebarCollapsed(true);
  });
  ui.sidebarScrim.addEventListener("click", () => setSidebarOpen(false));
  ui.sidebarResizer.addEventListener("pointerdown", startSidebarResize);
  ui.sidebarResizer.addEventListener("pointermove", moveSidebarResize);
  ui.sidebarResizer.addEventListener("pointerup", finishSidebarResize);
  ui.sidebarResizer.addEventListener("pointercancel", finishSidebarResize);
  ui.sidebarResizer.addEventListener(
    "lostpointercapture",
    handleSidebarCaptureLoss,
  );
  ui.sidebarResizer.addEventListener("keydown", resizeSidebarFromKeyboard);
  ui.searchChats.addEventListener("click", () => {
    setSidebarOpen(false, false);
    setSearchOpen(true);
  });
  ui.searchForm.addEventListener("submit", performSearch);
  ui.searchClear.addEventListener("click", (event) => {
    event.preventDefault();
    clearSearch();
  });
  for (const control of [ui.searchFrom, ui.searchTo, ui.searchSort]) {
    control.addEventListener("change", () => {
      if (ui.searchQuery.value.trim()) performSearch();
      else validateSearchDates();
    });
  }
  ui.newThread.addEventListener("click", () => {
    setSidebarOpen(false, false);
    beginNewThread();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (ui.preferencesDialog.open) return;
    if (state.settingsOpen) setSettingsOpen(false);
    else if (sidebarIsMobile() && state.sidebarOpen) setSidebarOpen(false);
    else if (state.searchOpen) setSearchOpen(false);
  });
  const mobileLayout = window.matchMedia("(max-width: 760px)");
  if (mobileLayout.addEventListener) {
    mobileLayout.addEventListener("change", syncSidebarBreakpoint);
  } else {
    mobileLayout.addListener(syncSidebarBreakpoint);
  }
  window.addEventListener("resize", applyPreferredSidebarWidth, { passive: true });
  window.addEventListener("blur", () => cancelSidebarResize(true));
  initializeSidebarLayout();
  setSearchOpen(false, false);
  setSettingsOpen(false, false);
  ui.fileInput.addEventListener("change", () => uploadFiles(ui.fileInput.files));
  ui.prompt.addEventListener("input", handlePromptInput);
  ui.prompt.addEventListener("keydown", promptKeydown);
  ui.prompt.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    uploadFiles(files);
  });
  for (const eventName of ["dragenter", "dragover"]) {
    ui.composer.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (!selectedThreadBusy() && !state.uploading) ui.composer.classList.add("drop-target");
    });
  }
  ui.composer.addEventListener("dragleave", (event) => {
    if (!ui.composer.contains(event.relatedTarget)) {
      ui.composer.classList.remove("drop-target");
    }
  });
  ui.composer.addEventListener("drop", (event) => {
    event.preventDefault();
    ui.composer.classList.remove("drop-target");
    uploadFiles(event.dataTransfer?.files || []);
  });

  boot();
}
