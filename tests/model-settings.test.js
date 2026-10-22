"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

const fast = { id: "priority", name: "Fast", description: "Faster responses, increased usage" };
const ultrafast = { id: "ultrafast", name: "Ultrafast", description: "Highest speed, increased usage" };
function model(id, tiers = [fast], efforts = ["low", "medium", "high", "max", "ultra"]) {
  return {
    id, model: id, displayName: id, description: `About ${id}`,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort, description: `${reasoningEffort} reasoning`,
    })),
    defaultReasoningEffort: "medium", serviceTiers: tiers, supportsPersonality: false,
  };
}

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
  const { state, ui } = api;
  state.ready = true;
  state.chatDefaults = api.normalizeChatSettings({ model: "gpt-5.6-sol", effort: "max", serviceTier: "priority" });
  state.models = [model("gpt-5.6-sol"), model("gpt-6-sol"), model("gpt-6-astra", [fast, ultrafast])];
  state.modelsLoaded = true;
  const calls = [];
  let respond = () => ({ data: [] });
  state.ws = {
    readyState: window.WebSocket.OPEN,
    send(raw) {
      const message = JSON.parse(raw);
      calls.push(message);
      queueMicrotask(async () => {
        try { api.handleMessage({ id: message.id, result: await respond(message) }); }
        catch (error) { api.handleMessage({ id: message.id, error: { message: error.message } }); }
      });
    },
  };
  api.renderChatSettings();
  return { ...api, calls, window, replyWith(fn) { respond = fn; } };
}

test("loads all model pages and renders arbitrary catalog capabilities", async (t) => {
  const app = fixture(t);
  app.replyWith(({ method, params }) => method !== "model/list" ? {} : params.cursor
    ? { data: [model("gpt-6.1-sol", [fast, ultrafast]), { ...model("hidden"), hidden: true }], nextCursor: null }
    : { data: [model("gpt-6-sol"), model("gpt-6-luna", [fast], ["low", "medium", "max"])], nextCursor: "next-page" });
  await app.loadChatSettingsCatalog();
  assert.deepEqual(Array.from(app.state.models, (entry) => entry.model), ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]);
  assert.equal(app.calls.filter((call) => call.method === "model/list")[1].params.cursor, "next-page");
  app.ui.settingModel.value = "gpt-6.1-sol";
  app.saveChatSettingsFromControls();
  assert.deepEqual(Array.from(app.ui.settingServiceTier.options, (entry) => entry.value), ["", "default", "priority", "ultrafast"]);
  assert.ok(Array.from(app.ui.settingEffort.options).some((entry) => entry.value === "ultra"));
  assert.match(app.ui.modelHelp.textContent, /gpt-6.1-sol/);
  assert.equal(app.ui.refreshModels.disabled, false);
});

test("failed later pages and repeated cursors preserve the complete previous catalog", async (t) => {
  const app = fixture(t);
  const original = JSON.stringify(app.state.models);
  app.state.newThreadSettings = app.normalizeChatSettings({ model: "gpt-6-sol", effort: "high" });
  app.replyWith(({ method, params }) => {
    if (method !== "model/list") return {};
    if (params.cursor) throw new Error("Temporarily unavailable");
    return { data: [model("new-model")], nextCursor: "second" };
  });
  await app.loadChatSettingsCatalog();
  assert.equal(JSON.stringify(app.state.models), original);
  assert.equal(app.state.newThreadSettings.model, "gpt-6-sol");
  assert.equal(app.state.newThreadSettings.effort, "high");
  assert.match(app.ui.modelCatalogStatus.textContent, /Could not refresh models/);
  app.replyWith(({ method }) => method !== "model/list" ? {} : { data: [], nextCursor: "cycle" });
  await app.loadChatSettingsCatalog();
  assert.equal(JSON.stringify(app.state.models), original);
  assert.match(app.ui.modelCatalogStatus.textContent, /pagination/);
  assert.equal(app.ui.refreshModels.disabled, false);
});

test("Standard explicitly overrides Fast, and catalog-only tiers are sent unchanged", (t) => {
  const app = fixture(t);
  app.ui.settingServiceTier.value = "default";
  app.saveChatSettingsFromControls();
  let effective = app.effectiveChatSettings(app.state.newThreadSettings);
  assert.equal(app.turnSettingsParams(effective).serviceTier, "default");
  assert.equal(app.threadSettingsParams(effective).serviceTier, "default");
  assert.equal(app.state.chatDefaults.serviceTier, "priority");
  app.ui.settingModel.value = "gpt-6-astra";
  app.saveChatSettingsFromControls();
  app.ui.settingServiceTier.value = "ultrafast";
  app.saveChatSettingsFromControls();
  effective = app.effectiveChatSettings(app.state.newThreadSettings);
  assert.equal(app.turnSettingsParams(effective).serviceTier, "ultrafast");
  assert.equal(app.threadSettingsParams(effective).model, "gpt-6-astra");
  assert.match(app.ui.serviceTierHelp.textContent, /Highest speed/);
  app.ui.settingModel.value = "gpt-6-sol";
  app.saveChatSettingsFromControls();
  assert.equal(app.state.newThreadSettings.serviceTier, "");
  assert.equal(app.effectiveChatSettings(app.state.newThreadSettings).serviceTier, "priority");
  assert.ok(!Array.from(app.ui.settingServiceTier.options).some((entry) => entry.value === "ultrafast"));
});

test("unsupported instance effort and speed use valid model defaults without changing preferences", (t) => {
  const app = fixture(t);
  app.state.models.push(model("standard-only", [], ["low", "medium"]));
  app.state.newThreadSettings = app.normalizeChatSettings({ model: "standard-only" });
  app.renderChatSettings();
  const effective = app.effectiveChatSettings(app.state.newThreadSettings);
  assert.equal(effective.effort, "medium");
  assert.equal(app.ui.selectedReasoning.textContent, "medium");
  assert.equal(effective.serviceTier, "default");
  assert.equal(app.ui.settingEffort.selectedOptions[0].textContent, "Model default — medium");
  assert.equal(app.ui.settingServiceTier.selectedOptions[0].textContent, "Model default — Standard");
  assert.equal(app.ui.settingServiceTier.disabled, false);
  assert.equal(app.state.chatDefaults.effort, "max");
  assert.equal(app.state.chatDefaults.serviceTier, "priority");
  assert.equal(app.state.newThreadSettings.effort, "");
});

test("missing saved model is retained and cannot silently submit with another model", async (t) => {
  const app = fixture(t);
  app.state.newThreadSettings = app.normalizeChatSettings({ model: "not-in-catalog" });
  app.renderChatSettings();
  assert.equal(app.state.newThreadSettings.model, "not-in-catalog");
  assert.equal(app.ui.settingModel.value, "not-in-catalog");
  assert.match(app.ui.modelHelp.textContent, /unavailable/);
  app.ui.prompt.value = "Preserve this draft";
  await app.submitPrompt({ preventDefault() {} });
  assert.equal(app.calls.length, 0);
  assert.equal(app.ui.prompt.value, "Preserve this draft");
  assert.match(app.ui.notice.textContent, /model is unavailable/);
});

test("active model comes from the server while the selected model stays a next-turn preference", async (t) => {
  const app = fixture(t);
  const id = "model-mismatch";
  app.state.threadId = id;
  app.state.settingsByThread.set(id, app.normalizeChatSettings({ model: "gpt-6-astra", effort: "ultra" }));
  app.cacheThreadSnapshot({ id, model: "stale-model", turns: [] });
  app.replyWith(() => ({ thread: { id, model: "gpt-5.6-sol", reasoningEffort: "max", status: { type: "active" } } }));
  app.setThreadActivity(id, "turn-one");
  assert.equal(app.ui.activeModel.textContent, "Loading…");
  assert.equal(app.ui.selectedModel.textContent, "gpt-6-astra");
  await app.state.activeModels.get(id).promise;
  assert.equal(app.ui.activeModel.textContent, "gpt-5.6-sol");
  assert.equal(app.ui.settingsActiveModel.textContent, "gpt-5.6-sol · max reasoning");
  assert.equal(app.ui.activeReasoning.textContent, "max");
  assert.equal(app.ui.selectedReasoning.textContent, "ultra");
  app.renderChatSettings();
  assert.equal(app.ui.settingModel.value, "gpt-6-astra");
  app.ui.settingModel.value = "gpt-6-sol";
  app.saveChatSettingsFromControls();
  assert.equal(app.ui.activeModel.textContent, "gpt-5.6-sol");
  assert.equal(app.ui.selectedModel.textContent, "gpt-6-sol");
  assert.equal(app.ui.activeReasoning.textContent, "max");
  assert.equal(app.ui.selectedReasoning.textContent, "ultra");
  app.updateControls();
  app.updateControls();
  assert.equal(app.calls.length, 1, "streaming updates must not repeatedly request metadata");
  assert.equal(app.calls[0].method, "thread/read");
  assert.deepEqual(app.calls[0].params, { threadId: id, includeTurns: false });
});

test("idle, disconnected and missing metadata never present the selected model as active", async (t) => {
  const app = fixture(t);
  assert.equal(app.ui.activeModel.textContent, "No active turn");
  assert.equal(app.ui.selectedModel.textContent, "gpt-5.6-sol");
  const id = "unknown-model";
  app.state.threadId = id;
  app.replyWith(() => { throw new Error("Metadata unavailable"); });
  app.setThreadActivity(id, "turn-one");
  await app.state.activeModels.get(id).promise;
  assert.equal(app.ui.activeModel.textContent, "Unavailable");
  assert.equal(app.ui.selectedModel.textContent, "gpt-5.6-sol");
  app.state.ready = false;
  app.updateControls();
  assert.equal(app.ui.activeModel.textContent, "Not connected");
  app.state.ready = true;
  app.state.connectionGeneration += 1;
  app.replyWith(() => ({ thread: { id, model: "gpt-6-astra", status: { type: "active" } } }));
  app.updateControls();
  assert.equal(app.ui.activeModel.textContent, "Loading…");
  await app.state.activeModels.get(id).promise;
  assert.equal(app.ui.activeModel.textContent, "gpt-6-astra");
  assert.equal(app.ui.activeReasoning.textContent, "unknown", "missing active reasoning must not use the selected level");
  app.handleNotification("thread/status/changed", { threadId: id, status: { type: "idle" } });
  assert.equal(app.ui.activeModel.textContent, "No active turn");
});

test("new turns reject late model reads from previous turns or connections", async (t) => {
  const app = fixture(t);
  const id = "changing-model";
  app.state.threadId = id;
  const responses = [];
  app.replyWith(() => new Promise((resolve) => responses.push(resolve)));
  app.setThreadActivity(id, "old-turn");
  const oldRead = app.state.activeModels.get(id).promise;
  await Promise.resolve();
  app.setThreadActivity(id, "new-turn");
  const newRead = app.state.activeModels.get(id).promise;
  await Promise.resolve();
  responses[1]({ thread: { id, model: "gpt-6-astra", reasoningEffort: "ultra", status: { type: "active" } } });
  await newRead;
  responses[0]({ thread: { id, model: "gpt-5.6-sol", reasoningEffort: "high", status: { type: "active" } } });
  await oldRead;
  assert.equal(app.ui.activeModel.textContent, "gpt-6-astra");
  assert.equal(app.ui.activeReasoning.textContent, "ultra");
  app.state.connectionGeneration += 1;
  app.updateControls();
  const reconnectRead = app.state.activeModels.get(id).promise;
  assert.equal(app.ui.activeModel.textContent, "Loading…");
  await Promise.resolve();
  responses[2]({ thread: { id, model: "gpt-6-sol", reasoningEffort: "low", status: { type: "active" } } });
  await reconnectRead;
  assert.equal(app.ui.activeModel.textContent, "gpt-6-sol");
  assert.equal(app.ui.activeReasoning.textContent, "low");
});

test("chat switches isolate model reads and settings can retry missing model information", async (t) => {
  const app = fixture(t);
  app.state.threadId = "first";
  let resolveFirst;
  app.replyWith(({ params }) => params.threadId === "first"
    ? new Promise((resolve) => { resolveFirst = resolve; })
    : { thread: { id: "second", status: { type: "active" } } });
  app.setThreadActivity("first", "first-turn");
  const firstRead = app.state.activeModels.get("first").promise;
  await Promise.resolve();
  app.state.threadId = "second";
  app.setThreadActivity("second", "second-turn");
  await app.state.activeModels.get("second").promise;
  assert.equal(app.ui.activeModel.textContent, "Unavailable");
  resolveFirst({ thread: { id: "first", model: "gpt-6-astra", status: { type: "active" } } });
  await firstRead;
  assert.equal(app.ui.activeModel.textContent, "Unavailable");
  app.replyWith(() => ({ thread: { id: "second", model: "gpt-5.6-sol", reasoningEffort: "max", status: { type: "active" } } }));
  app.setSettingsOpen(true, false);
  await app.state.activeModels.get("second").promise;
  assert.equal(app.ui.settingsActiveModel.textContent, "gpt-5.6-sol · max reasoning");
  app.state.threadId = "first";
  app.renderChatSettings();
  assert.equal(app.ui.activeModel.textContent, "gpt-6-astra");
});

test("completed or mismatched metadata does not label an active turn", async (t) => {
  const app = fixture(t);
  app.state.threadId = "active-thread";
  for (const thread of [
    { id: "active-thread", model: "gpt-6-astra", status: { type: "idle" } },
    { id: "other-thread", model: "gpt-6-astra", status: { type: "active" } },
  ]) {
    app.replyWith(() => ({ thread }));
    app.setThreadActivity("active-thread", thread.id);
    await app.state.activeModels.get("active-thread").promise;
    assert.equal(app.ui.activeModel.textContent, "Unavailable");
  }
});
