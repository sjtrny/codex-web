"use strict";

// Loopback UI and simulated app-server: no real conversations or tasks are changed.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright");

const staticRoot = path.resolve(process.env.CODEX_WEB_STATIC_ROOT || path.join(__dirname, "../static"));
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const file = path.resolve(staticRoot, url.pathname === "/" ? "index.html" : url.pathname.slice(8));
    if ((url.pathname !== "/" && !url.pathname.startsWith("/static/"))
      || !file.startsWith(`${staticRoot}${path.sep}`)) throw new Error("Invalid path");
    const body = await fs.readFile(file);
    response.writeHead(200, { "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  let page;
  async function screenshot(name) {
    if (!process.env.ARTIFACT_DIR || !page) return;
    await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(process.env.ARTIFACT_DIR, `${name}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  try {
    page = await browser.newPage({ viewport: { width: 1100, height: 820 }, serviceWorkers: "block" });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/config", (route) => route.fulfill({
      json: { defaultCwd: "/workspaces", workspaceRoot: "/workspaces", chatDefaults: {} },
    }));
    const source = {
      id: "source", name: "Explore a different approach", cwd: "/workspaces/project",
      createdAt: 1789603200, updatedAt: 1789603200, status: { type: "idle" },
      turns: [
        {
          id: "turn-one", status: "completed", items: [
            { id: "user-one", type: "userMessage", content: [{ type: "text", text: "Help me compare two approaches." }] },
            { id: "commentary-one", type: "agentMessage", phase: "commentary", text: "I’ll compare the tradeoffs." },
            { id: "agent-one", type: "agentMessage", phase: "final_answer", text: "The first approach is simpler." },
          ],
        },
        {
          id: "turn-two", status: "completed", items: [
            { id: "user-two", type: "userMessage", content: [{ type: "text", text: "Try the other approach" }] },
            { id: "agent-two", type: "agentMessage", phase: "final_answer", text: "The other approach is more flexible." },
          ],
        },
      ],
    };
    const original = JSON.stringify(source);
    const threads = new Map([[source.id, source]]);
    const received = [];
    let pendingFork;
    let failFork = true;
    await page.routeWebSocket("**/ws", (socket) => {
      const send = (message) => socket.send(JSON.stringify(message));
      socket.onMessage((data) => {
        const message = JSON.parse(data);
        received.push(message);
        if (!message.method || message.id == null) return;
        let result;
        switch (message.method) {
          case "initialize": result = { userAgent: "fork-browser-test" }; break;
          case "model/list":
          case "permissionProfile/list": result = { data: [] }; break;
          case "config/read": result = { config: {} }; break;
          case "configRequirements/read": result = { requirements: null }; break;
          case "thread/list": result = { data: [...threads.values()], nextCursor: null }; break;
          case "thread/resume": result = { thread: threads.get(message.params.threadId) }; break;
          case "thread/fork":
            assert.equal("beforeTurnId" in message.params, false);
            assert.ok(message.params.lastTurnId);
            if (failFork) {
              send({ id: message.id, error: { message: "Fork temporarily unavailable" } });
            } else {
              pendingFork = () => {
                const parent = threads.get(message.params.threadId);
                const index = parent.turns.findIndex((turn) => turn.id === message.params.lastTurnId);
                const thread = {
                  ...structuredClone(parent), id: `fork-${threads.size}`,
                  forkedFromId: message.params.threadId,
                  turns: structuredClone(parent.turns.slice(0, index + 1)),
                  createdAt: 1789603300 + threads.size,
                  updatedAt: 1789603300 + threads.size,
                };
                threads.set(thread.id, thread);
                // The event can precede the response without duplicating the chat.
                send({ method: "thread/started", params: { thread } });
                send({ id: message.id, result: { thread } });
              };
            }
            return;
          case "turn/start": {
            assert.notEqual(message.params.threadId, "source");
            const turn = {
              id: "fork-next-turn", status: "completed", items: [
                { id: "fork-prompt", type: "userMessage", content: message.params.input },
                { id: "fork-answer", type: "agentMessage", phase: "final_answer", text: "This reply belongs only to the response fork." },
              ],
            };
            threads.get(message.params.threadId).turns.push(turn);
            result = { turn };
            break;
          }
          default:
            errors.push(`Unexpected RPC: ${message.method}`);
            send({ id: message.id, error: { message: "Unexpected RPC" } });
            return;
        }
        send({ id: message.id, result });
      });
    });

    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/?thread=source`);
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll(".message-fork")];
      return buttons.length === 3 && buttons.every((button) => !button.disabled);
    });
    assert.equal(await page.locator(".message-toolbar").count(), 3);
    assert.equal(await page.locator(".message.user .message-toolbar").count(), 0);
    assert.equal(await page.locator(".message.user .message-fork").count(), 0);
    assert.equal(await page.locator("#fork-thread").count(), 0);
    assert.equal(await page.locator(".message.agent").evaluateAll(
      (messages) => messages.every((message) => message.lastElementChild?.classList.contains("message-toolbar")),
    ), true);
    const desktopOffsets = await page.locator(".message.agent").evaluateAll((messages) => (
      messages.map((message) => {
        const responseLeft = message.querySelector(".body").getBoundingClientRect().left;
        const iconLeft = message.querySelector(".message-fork svg").getBoundingClientRect().left;
        return Math.abs(responseLeft - iconLeft);
      })
    ));
    assert.ok(desktopOffsets.every((offset) => offset <= 1), "fork icons must align with response text");
    await screenshot("desktop-response-toolbar");

    await page.getByRole("button", { name: "Model and chat settings", exact: true }).click();
    await page.getByLabel("Working folder").fill("/workspaces/fork-example");
    await page.getByLabel("Working folder").press("Tab");
    await page.getByRole("button", { name: "Close chat settings" }).click();
    await page.locator("#prompt").fill("Keep this unsent draft in the original chat");
    const responseForks = page.getByRole("button", { name: "Fork from this Codex response", exact: true });
    await responseForks.last().click();
    await page.getByText("Unable to fork from response: Fork temporarily unavailable", { exact: true }).waitFor();
    assert.equal(await page.locator("#prompt").inputValue(), "Keep this unsent draft in the original chat");

    failFork = false;
    await responseForks.last().focus();
    await page.keyboard.press("Enter");
    const forkingResponse = page.getByRole("button", { name: "Forking from this Codex response" });
    await forkingResponse.waitFor();
    await forkingResponse.evaluate((button) => button.click());
    assert.equal(received.filter((message) => message.method === "thread/fork").length, 2);
    assert.deepEqual(received.findLast((message) => message.method === "thread/fork").params, {
      threadId: "source", lastTurnId: "turn-two", deferGoalContinuation: true,
    });
    pendingFork();
    await page.waitForURL("**/?thread=fork-1");
    await page.locator("#thread-title").getByText("Fork: Explore a different approach", { exact: true }).waitFor();
    assert.equal(await page.locator("#prompt").inputValue(), "");
    assert.equal(await page.locator('#threads a[href="/?thread=fork-1"]').count(), 1);
    assert.ok(!received.some((message) => message.method.startsWith("turn/")));
    await screenshot("desktop-response-fork");

    await page.locator('#threads a[href="/?thread=source"]').click();
    assert.equal(await page.locator("#prompt").inputValue(), "Keep this unsent draft in the original chat");
    assert.equal(await page.locator(".message.user .message-toolbar").count(), 0);
    await page.locator('#threads a[href="/?thread=fork-1"]').click();
    await page.getByRole("button", { name: "Model and chat settings", exact: true }).click();
    assert.equal(await page.getByLabel("Working folder").inputValue(), "/workspaces/fork-example");
    await page.getByRole("button", { name: "Close chat settings" }).click();
    await page.locator("#prompt").fill("Continue only in this fork");
    await page.locator("#send").click();
    await page.waitForFunction(() => !document.getElementById("send").disabled);
    await page.reload();
    await page.getByText("This reply belongs only to the response fork.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Model and chat settings", exact: true }).click();
    assert.equal(await page.getByLabel("Working folder").inputValue(), "/workspaces/fork-example");
    await page.getByRole("button", { name: "Close chat settings" }).click();
    assert.equal(JSON.stringify(source), original);
    const start = received.find((message) => message.method === "turn/start");
    assert.equal(start.params.threadId, "fork-1");
    assert.equal(start.params.cwd, "/workspaces/fork-example");

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 740 });
      const forkButtons = page.locator(".message-fork");
      const count = await forkButtons.count();
      assert.equal(count, 4);
      for (let index = 0; index < count; index += 1) {
        const bounds = await forkButtons.nth(index).boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      }
      assert.equal(await page.locator(".message.user .message-toolbar").count(), 0);
      const mobileOffsets = await page.locator(".message.agent").evaluateAll((messages) => (
        messages.map((message) => {
          const responseLeft = message.querySelector(".body").getBoundingClientRect().left;
          const iconLeft = message.querySelector(".message-fork svg").getBoundingClientRect().left;
          return Math.abs(responseLeft - iconLeft);
        })
      ));
      assert.ok(mobileOffsets.every((offset) => offset <= 1), `${width}px fork icons must align with response text`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await screenshot(`mobile-response-toolbar-${width}`);
    }

    // The response action remains keyboard-usable on mobile and can fork a fork.
    const latestFork = page.getByRole("button", { name: "Fork from this Codex response", exact: true }).last();
    await latestFork.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Forking from this Codex response" }).waitFor();
    assert.deepEqual(received.findLast((message) => message.method === "thread/fork").params, {
      threadId: "fork-1", lastTurnId: "fork-next-turn", deferGoalContinuation: true,
    });
    pendingFork();
    await page.waitForURL("**/?thread=fork-2");
    await page.getByText("This reply belongs only to the response fork.", { exact: true }).waitFor();
    assert.equal(threads.get("fork-2").forkedFromId, "fork-1");
    assert.deepEqual(errors, []);
    console.log("fork-browser=ok");
  } catch (error) {
    await screenshot("failure");
    throw error;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
