"use strict";

// Optional real-browser integration check. Uses the demo's existing Playwright:
// node tests/questions.browser.cjs (or set PLAYWRIGHT_MODULE to another install).
// Only a temporary loopback static server and simulated app-server are used.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");

const root = path.resolve(__dirname, "..");
const staticRoot = path.join(root, "static");
const artifacts = path.resolve(root, "../artifacts/questions/composer-controls");
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/" && !url.pathname.startsWith("/static/")) throw new Error("Invalid path");
    const file = path.resolve(staticRoot, url.pathname === "/" ? "index.html" : url.pathname.slice(8));
    if (!file.startsWith(`${staticRoot}${path.sep}`)) throw new Error("Invalid path");
    const body = await fs.readFile(file);
    response.writeHead(200, { "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

async function eventually(check, label) {
  const deadline = Date.now() + 7000;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/config", (route) => route.fulfill({
      json: { defaultCwd: "/workspaces", workspaceRoot: "/workspaces", chatDefaults: {} },
    }));
    await page.route("**/api/uploads", (route) => route.fulfill({
      json: { files: [{ name: "note.txt", path: "/workspaces/uploads/note.txt", size: 4, image: false }] },
    }));
    const questionText = "A recording is running. May I finish it safely before updating?";
    const thread = (id, name, items = []) => ({
      id, name, cwd: "/workspaces", createdAt: 1788652800, updatedAt: 1788652800,
      status: { type: "active", activeFlags: [] },
      turns: [{ id: `turn-${id}`, status: "inProgress", items }],
    });
    const threads = new Map([
      ["a", thread("a", "Recording feature", [{ id: "plain-question", type: "agentMessage", text: questionText }])],
      ["b", thread("b", "Separate task")],
      ["async", thread("async", "Question and reply ordering", [{
        id: "async-prompt", type: "userMessage", content: [{
          type: "text", text: "Let's test this. Ask me a question that will change your response.",
        }],
      }])],
    ]);
    const received = [];
    let socket;
    let connections = 0;
    let delaySteerEcho = false;
    const pendingEchoes = [];
    const pendingInterrupts = [];
    const send = (message) => socket.send(JSON.stringify(message));
    const notification = (method, params) => send({ method, params });
    await page.routeWebSocket("**/ws", (ws) => {
      socket = ws;
      connections += 1;
      ws.onMessage((data) => {
        const message = JSON.parse(data);
        received.push(message);
        if (!message.method || message.id == null) return;
        let result;
        switch (message.method) {
          case "initialize": result = { userAgent: "browser-test" }; break;
          case "model/list": result = { data: [{
            id: "model-a", model: "model-a", displayName: "Example model",
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
          }] }; break;
          case "permissionProfile/list": result = { data: [] }; break;
          case "config/read": result = { config: {} }; break;
          case "configRequirements/read": result = { requirements: null }; break;
          case "thread/list": result = { data: [...threads.values()], nextCursor: null }; break;
          case "thread/resume": result = { thread: threads.get(message.params.threadId) }; break;
          case "turn/steer": {
            const item = { id: message.params.clientUserMessageId, type: "userMessage", content: message.params.input };
            const echo = () => {
              threads.get(message.params.threadId).turns[0].items.push(item);
              send({ method: "item/completed", params: {
                threadId: message.params.threadId, turnId: message.params.expectedTurnId, item,
              } });
            };
            if (delaySteerEcho) pendingEchoes.push(echo);
            else echo();
            result = { turnId: message.params.expectedTurnId };
            break;
          }
          case "turn/interrupt": pendingInterrupts.push(message); return;
          default:
            errors.push(`Unexpected RPC: ${message.method}`);
            ws.send(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unexpected RPC" } }));
            return;
        }
        ws.send(JSON.stringify({ id: message.id, result }));
      });
    });
    const card = page.locator("#requests .request:visible");
    const label = page.locator("#thinking-label");
    const question = (id, threadId, isBlocking, itemId = `question-${id}`) => ({
      id, method: "item/tool/requestUserInput", params: {
        threadId, turnId: `turn-${threadId}`, itemId, isBlocking,
        questions: [{ id: "deployment", header: "Recording", question: questionText,
          options: [
            { label: "Finish safely", description: "Finish the recording, then update the app." },
            { label: "Keep recording", description: "Keep this recording running and deploy separately." },
          ],
        }],
      },
    });
    const waitLabel = (text) => eventually(async () => await label.textContent() === text, text);
    const responseTo = (id) => received.find((message) => message.id === id && !message.method);
    await page.goto(`http://127.0.0.1:${server.address().port}/?thread=a`);
    await eventually(async () => await page.locator("#send").textContent() === "Stop"
      && await page.locator("#send").isEnabled(), "active stop ready");
    assert.equal(await page.evaluate(() => typeof globalThis.CodexWebTest), "undefined");
    assert.equal(await page.locator(".topbar #settings-toggle, #stop, #settings-panel").count(), 0);
    assert.equal(await page.locator(".composer-tools #settings-toggle").count(), 1);
    await page.locator("#prompt").press("Enter");
    assert.equal(received.some((message) => ["turn/interrupt", "turn/steer", "turn/start"].includes(message.method)), false,
      "Enter in an empty text box must not stop or submit work");
    await page.locator("#file-input").setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("Note") });
    await eventually(async () => await page.locator("#send").textContent() === "Reply"
      && await page.locator("#send").isEnabled(), "attachment-only reply ready");
    await page.getByRole("button", { name: "Remove note.txt" }).click();
    assert.equal(await page.locator("#send").textContent(), "Stop");

    const dialog = page.getByRole("dialog", { name: "Model and chat settings" });
    const settingsButton = page.getByRole("button", { name: "Model and chat settings", exact: true });
    await settingsButton.click();
    await dialog.waitFor();
    assert.equal(await dialog.evaluate((node) => node.matches(":modal")), true);
    assert.equal(await page.locator("#setting-model").evaluate((node) => node === document.activeElement), true);
    await page.locator("#setting-model").selectOption("model-a");
    await page.locator("#setting-effort").selectOption("high");
    await page.locator("#setting-permissions").focus();
    await page.keyboard.press("Tab");
    // Native dialogs can pass focus through browser chrome between endpoints.
    if (await page.evaluate(() => document.activeElement === document.body)) await page.keyboard.press("Tab");
    assert.equal(await page.locator("#settings-close").evaluate((node) => node === document.activeElement), true,
      "Tab returns to the modal without focusing the background app");
    await fs.mkdir(artifacts, { recursive: true });
    for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844], ["small-mobile", 320, 568]]) {
      await page.setViewportSize({ width, height });
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height);
      assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true, `${name} modal overflow`);
      await page.screenshot({ path: path.join(artifacts, `settings-${name}.png`), fullPage: true, animations: "disabled" });
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await eventually(async () => await settingsButton.getAttribute("aria-expanded") === "false", "native dialog close event");
    assert.equal(await settingsButton.evaluate((node) => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "small mobile composer overflow");
    await settingsButton.click();
    assert.equal(await page.locator("#setting-model").inputValue(), "model-a");
    assert.equal(await page.locator("#setting-effort").inputValue(), "high");
    await page.locator("#settings-close").click();
    await dialog.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByText(questionText, { exact: true }).waitFor();
    await page.locator("#prompt").fill("Yes, finish the recording safely, then update.");
    assert.equal(await page.locator("#send").textContent(), "Reply");
    await page.locator("#send").click();
    await eventually(() => received.some((message) => message.method === "turn/steer"), "steer sent");
    const steer = received.find((message) => message.method === "turn/steer");
    assert.equal(steer.params.threadId, "a");
    assert.equal(steer.params.expectedTurnId, "turn-a");
    assert.ok(steer.params.clientUserMessageId);
    assert.deepEqual(steer.params.input, [{ type: "text", text: "Yes, finish the recording safely, then update." }]);
    await eventually(async () => await page.getByText(steer.params.input[0].text, { exact: true }).count() === 1, "one reply echo");
    await eventually(async () => await page.locator("#send").textContent() === "Stop"
      && await page.locator("#send").isEnabled(), "reply returns to stop");
    assert.equal(steer.params.model, undefined, "settings do not change an active task's model");

    send(question(1001, "a", false));
    await waitLabel("Working — question pending");
    assert.equal(await card.count(), 0, "native questions must not render cards");
    assert.equal(await page.locator("#requests input, #requests select, #requests button").count(), 0);
    await page.locator("#messages .body").filter({ hasText: "Keep recording — Keep this recording running" }).waitFor();
    await page.locator("#prompt").fill("Finish safely, but wait until the export is saved.");
    send(question(1002, "b", true));
    await page.locator('#threads a[href="/?thread=b"]').click();
    await waitLabel("Waiting for your answer");
    assert.equal(await page.locator("#prompt").inputValue(), "");
    assert.equal(await card.count(), 0);
    await page.locator("#prompt").fill("Keep recording");
    await page.locator("#send").click();
    await eventually(() => responseTo(1002), "blocking answer sent through the composer");
    assert.deepEqual(responseTo(1002).result, { answers: { deployment: { answers: ["Keep recording"] } } });
    await page.locator('#threads a[href="/?thread=a"]').click();
    await waitLabel("Working — question pending");
    assert.equal(await page.locator("#prompt").inputValue(), "Finish safely, but wait until the export is saved.");

    socket.close({ code: 1012, reason: "Test reconnect" });
    await eventually(async () => await page.locator("#send").isDisabled(), "disconnected answer disabled");
    await eventually(() => connections === 2, "new websocket connection");
    assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(await page.locator("#prompt").inputValue(), "Finish safely, but wait until the export is saved.");
    send(question(1003, "a", false, "question-1001"));
    await eventually(async () => await page.locator("#send").isEnabled(), "replayed question enables the composer");
    assert.equal(await card.count(), 0);
    await page.locator("#send").click();
    await eventually(() => responseTo(1003), "custom answer sent on new request id");
    assert.equal(responseTo(1001), undefined);
    assert.deepEqual(responseTo(1003).result, { answers: { deployment: { answers: ["Finish safely, but wait until the export is saved."] } } });

    send(question(1004, "a", true));
    await waitLabel("Waiting for your answer");
    await fs.mkdir(artifacts, { recursive: true });
    for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.locator("#prompt").fill("Wait for the recording to finish safely.");
      assert.equal(await card.count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} page overflow`);
      await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true, animations: "disabled" });
    }
    const finished = threads.get("a");
    finished.status = { type: "idle" };
    finished.turns[0].status = "completed";
    notification("turn/completed", { threadId: "a", turn: finished.turns[0] });
    await eventually(async () => await page.locator("#thinking-indicator").isHidden(), "completed status hidden");
    assert.equal(await page.locator("#send").textContent(), "Send");
    assert.equal(await page.locator("#prompt").inputValue(), "Wait for the recording to finish safely.");

    // Real asynchronous questions are agentMessage items, not server requests.
    // This is the payload shape captured from the sky/adventure conversation.
    const asyncThread = threads.get("async");
    const asyncTurn = asyncThread.turns[0];
    const skyTitle = "How should I explain why the sky is blue?";
    const skyReply = "One simple sentence";
    const skyFinal = "The sky looks blue because air scatters blue sunlight more than other colors.";
    const skyQuestion = {
      id: "call_async-sky-question", type: "agentMessage", phase: "final_answer",
      text: `${skyTitle}\n- One simple sentence\n- A short scientific explanation\n- A playful rhyme`,
      questions: [{ title: skyTitle, options: [skyReply, "A short scientific explanation", "A playful rhyme"] }],
    };
    const emitAsyncItem = async (item, method = "item/completed") => {
      asyncTurn.items.push(item);
      notification(method, { threadId: "async", turnId: asyncTurn.id, item });
      // All message/activity updates can take a rendering frame.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const assertConversationOrder = async (expected, stage) => {
      const bodies = await page.locator("#messages .message .body").allTextContents();
      const positions = expected.map((text) => {
        const matches = bodies.flatMap((body, index) => body.trim().startsWith(text) ? [index] : []);
        assert.equal(matches.length, 1, `${stage}: one message containing ${text}`);
        return matches[0];
      });
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `${stage}: conversation order`);
    };
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#threads a[href="/?thread=async"]').click();
    await page.getByText(asyncTurn.items[0].content[0].text, { exact: true }).waitFor();
    await emitAsyncItem(skyQuestion);
    await waitLabel("Waiting for your answer");
    assert.equal(await card.count(), 0, "async question is an ordinary transcript message");
    assert.equal(await page.locator("#messages").getAttribute("aria-busy"), "false");
    assert.equal(await page.locator("#send").textContent(), "Stop");
    assert.equal(await page.locator("#send").isEnabled(), true);
    await emitAsyncItem({
      id: "sky-reasoning", type: "reasoning", summary: ["Waiting for user input", "Awaiting your answer"], content: [],
    });
    await emitAsyncItem({
      id: "sky-commentary", type: "agentMessage", phase: "commentary", questions: null,
      text: "Your choice will determine my explanation. I’ll wait for your answer.",
    });
    await emitAsyncItem({ id: "call_async-sky-sleep", type: "sleep" });
    await waitLabel("Waiting for your answer");
    for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} async overflow`);
      await page.screenshot({ path: path.join(artifacts, `async-waiting-${name}.png`), fullPage: true, animations: "disabled" });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await waitLabel("Waiting for your answer");
    await assertConversationOrder([asyncTurn.items[0].content[0].text, skyTitle, "Your choice will determine"], "unanswered reload");

    // A successful acknowledgement clears waiting even before its user echo.
    // A stale resume response must not resurrect the unanswered state.
    delaySteerEcho = true;
    await page.locator("#prompt").fill(skyReply);
    const resumeCount = received.filter((message) => message.method === "thread/resume").length;
    await page.locator("#send").click();
    await eventually(() => pendingEchoes.length === 1, "delayed answer accepted");
    await waitLabel("Codex is thinking");
    await eventually(() => received.filter((message) => message.method === "thread/resume").length > resumeCount, "accepted answer resumes history");
    await eventually(async () => await page.locator("#send").isEnabled(), "accepted answer controls ready");
    await waitLabel("Codex is thinking");
    assert.equal(await page.locator("#messages").getAttribute("aria-busy"), "true");
    assert.equal(asyncTurn.items.some((item) => item.type === "userMessage" && item.content[0].text === skyReply), false);
    pendingEchoes.shift()();
    delaySteerEcho = false;
    await emitAsyncItem({ id: "sky-final", type: "agentMessage", phase: "final_answer", text: skyFinal, questions: null });
    await page.getByText(skyFinal, { exact: true }).waitFor();
    await assertConversationOrder([skyTitle, "Your choice will determine", skyReply, skyFinal], "live answer");
    asyncThread.status = { type: "idle" };
    asyncTurn.status = "completed";
    notification("turn/completed", { threadId: "async", turn: asyncTurn });
    await eventually(async () => await page.locator("#thinking-indicator").isHidden(), "async completed status hidden");
    await assertConversationOrder([skyTitle, "Your choice will determine", skyReply, skyFinal], "completed answer");

    // Replay the second original example too, including its initial commentary.
    const adventurePrompt = "Try it again. Different question.";
    const adventureTitle = "Where should a tiny fictional adventure take place?";
    const adventureReply = "A village";
    const adventureFinal = "Every evening, the village inside the giant tree lit its lanterns—until one night, something deep in the trunk lit a lantern back.";
    asyncThread.turns.push({ id: "turn-async-adventure", status: "completed", items: [
      { id: "adventure-prompt", type: "userMessage", content: [{ type: "text", text: adventurePrompt }] },
      { id: "adventure-commentary", type: "agentMessage", phase: "commentary", questions: null,
        text: "I’ll ask a different question and use your answer to shape my response." },
      { id: "call_async-adventure-question", type: "agentMessage", phase: "final_answer",
        text: `${adventureTitle}\n- An abandoned space station\n- A library beneath the ocean\n- A village inside a giant tree`,
        questions: [{ title: adventureTitle, options: ["An abandoned space station", "A library beneath the ocean", "A village inside a giant tree"] }] },
      { id: "call_async-adventure-sleep", type: "sleep" },
      { id: "adventure-reply", type: "userMessage", content: [{ type: "text", text: adventureReply }] },
      { id: "adventure-final", type: "agentMessage", phase: "final_answer", text: adventureFinal, questions: null },
    ] });
    const expectedHistory = [skyTitle, skyReply, skyFinal, adventurePrompt, adventureTitle, adventureReply, adventureFinal];
    await page.locator('#threads a[href="/?thread=b"]').click();
    await page.locator('#threads a[href="/?thread=async"]').click();
    await page.getByText(adventureFinal, { exact: true }).waitFor();
    await assertConversationOrder(expectedHistory, "resumed history");
    await page.reload();
    await page.getByText(adventureFinal, { exact: true }).waitFor();
    await assertConversationOrder(expectedHistory, "reloaded history");
    assert.equal(await page.locator("#thinking-indicator").isHidden(), true);
    await page.screenshot({ path: path.join(artifacts, "async-history-desktop.png"), fullPage: true, animations: "disabled" });
    assert.equal(received.some((message) => ["turn/start", "thread/start", "turn/interrupt"].includes(message.method)), false);

    // Stop the selected task through the composer, including while awaiting an answer.
    await page.locator('#threads a[href="/?thread=b"]').click();
    send(question(1005, "b", true));
    await waitLabel("Waiting for your answer");
    assert.equal(await page.locator("#send").textContent(), "Stop");
    await page.locator("#send").click();
    await eventually(() => pendingInterrupts.length === 1, "stop request sent");
    const interrupt = pendingInterrupts[0];
    assert.deepEqual(interrupt.params, { threadId: "b", turnId: "turn-b" });
    assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(await page.locator("#send").textContent(), "Stopping…");
    await page.locator("#prompt").press("Enter");
    assert.equal(pendingInterrupts.length, 1, "no duplicate interrupt while pending");
    send({ id: interrupt.id, error: { code: -32603, message: "Try stopping again" } });
    await eventually(async () => await page.locator("#send").isEnabled(), "failed stop can be retried");
    assert.equal(await page.locator("#send").textContent(), "Stop");
    await page.getByText("Could not stop the task: Try stopping again", { exact: true }).waitFor();
    await page.locator("#send").click();
    await eventually(() => pendingInterrupts.length === 2, "stop retried");
    await page.locator("#prompt").fill("Keep this draft after stopping.");
    await page.locator("#prompt").press("Enter");
    assert.equal(await page.locator("#prompt").inputValue(), "Keep this draft after stopping.");
    const stopped = threads.get("b");
    stopped.status = { type: "idle" };
    stopped.turns[0].status = "interrupted";
    notification("turn/completed", { threadId: "b", turn: stopped.turns[0] });
    send({ id: pendingInterrupts[1].id, result: {} });
    await eventually(async () => await page.locator("#send").textContent() === "Send"
      && await page.locator("#send").isEnabled(), "stopped task returns to send");
    assert.equal(await page.locator("#thinking-indicator").isHidden(), true);
    assert.equal(await page.locator("#prompt").inputValue(), "Keep this draft after stopping.");
    assert.equal(await page.locator("#notice").isHidden(), true);
    assert.equal(received.some((message) => ["turn/start", "thread/start"].includes(message.method)), false);
    assert.deepEqual(errors, []);
    console.log(`Question browser checks passed; screenshots: ${artifacts}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => server.close());
