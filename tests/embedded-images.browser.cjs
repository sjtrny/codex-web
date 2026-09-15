"use strict";

// Real-browser check with a temporary static server and simulated app-server.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright"
);

const root = path.resolve(__dirname, "..");
const staticRoot = path.resolve(
  process.env.CODEX_WEB_STATIC_ROOT || path.join(root, "static")
);
const artifacts = path.resolve(
  process.env.ARTIFACT_DIR
    || path.join(root, "../../artifacts/clickable-chat-images/fixed")
);
const contentTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (["/api/files", "/api/host-images"].includes(url.pathname)) {
      const body = await fs.readFile(path.join(staticRoot, "icons/icon-192.png"));
      response.writeHead(200, {
        "Content-Disposition": "inline",
        "Content-Type": "image/png",
      });
      response.end(body);
      return;
    }
    if (url.pathname !== "/" && !url.pathname.startsWith("/static/")) {
      throw new Error("Invalid path");
    }
    const file = path.resolve(
      staticRoot,
      url.pathname === "/" ? "index.html" : url.pathname.slice(8)
    );
    if (!file.startsWith(`${staticRoot}${path.sep}`)) {
      throw new Error("Invalid path");
    }
    const body = await fs.readFile(file);
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream",
    });
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
  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1100, height: 820 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/config", (route) => route.fulfill({
      json: {
        chatDefaults: {},
        defaultCwd: "/workspaces",
        workspaceRoot: "/workspaces",
      },
    }));

    const userMarkdown = "![User image](/workspaces/example/user.png)";
    const workspaceImageAlt = "Gas absorption spectra with FBG reflectivity overlay";
    const workspaceImagePath = "/workspaces/fbg-home/grating-analysis/spectra.png";
    const thread = {
      id: "images",
      name: "Clickable embedded images",
      cwd: "/workspaces",
      createdAt: 1788652800,
      updatedAt: 1788652800,
      status: { type: "idle" },
      turns: [{
        id: "turn-images",
        status: "completed",
        items: [
          {
            id: "user-markdown",
            type: "userMessage",
            content: [{ type: "text", text: userMarkdown }],
          },
          {
            id: "agent-images",
            type: "agentMessage",
            phase: "final_answer",
            text: [
              `![${workspaceImageAlt}](${workspaceImagePath})`,
              "",
              "[![Linked result](/workspaces/example/thumbnail.png)](/workspaces/example/details.png)",
              "",
              "![Host result](/tmp/host-result.png)",
              "",
              "![](/workspaces/example/unnamed.png)",
              "",
              "![Unsafe result](data:text/html,unsafe)",
              "",
              "![Unsafe contact](mailto:images@example.com)",
            ].join("\n"),
          },
        ],
      }],
    };
    const received = [];
    await page.routeWebSocket("**/ws", (socket) => {
      socket.onMessage((data) => {
        const message = JSON.parse(data);
        received.push(message);
        if (!message.method || message.id == null) return;
        let result;
        switch (message.method) {
          case "initialize": result = { userAgent: "embedded-image-browser-test" }; break;
          case "model/list": result = { data: [] }; break;
          case "permissionProfile/list": result = { data: [] }; break;
          case "config/read": result = { config: {} }; break;
          case "configRequirements/read": result = { requirements: null }; break;
          case "thread/list": result = { data: [thread], nextCursor: null }; break;
          case "thread/resume": result = { thread }; break;
          default:
            errors.push(`Unexpected RPC: ${message.method}`);
            socket.send(JSON.stringify({
              id: message.id,
              error: { code: -32601, message: "Unexpected RPC" },
            }));
            return;
        }
        socket.send(JSON.stringify({ id: message.id, result }));
      });
    });

    await page.goto(`http://127.0.0.1:${server.address().port}/?thread=images`);
    const workspaceImage = page.getByRole("img", { name: workspaceImageAlt });
    await workspaceImage.waitFor();
    const workspaceLink = workspaceImage.locator("xpath=parent::a");
    const workspaceHref = `/api/files?${new URLSearchParams({
      path: workspaceImagePath,
    })}`;
    assert.equal(await workspaceLink.getAttribute("href"), workspaceHref);
    assert.equal(await workspaceLink.getAttribute("target"), "_blank");
    assert.equal(await workspaceLink.getAttribute("rel"), "noopener noreferrer");
    assert.equal(await workspaceLink.getAttribute("title"), "Open image in a new window");
    assert.equal(await workspaceLink.getAttribute("class"), "embedded-image-link");
    assert.equal(
      await workspaceLink.getAttribute("aria-label"),
      `${workspaceImageAlt} (opens in a new window)`,
    );

    const linkedImage = page.getByRole("img", { name: "Linked result" });
    const explicitLink = linkedImage.locator("xpath=parent::a");
    assert.equal(
      await explicitLink.getAttribute("href"),
      `/api/files?${new URLSearchParams({ path: "/workspaces/example/details.png" })}`
    );
    assert.equal(await explicitLink.getAttribute("class"), null);
    assert.equal(await explicitLink.getAttribute("target"), "_blank");
    assert.equal(await explicitLink.getAttribute("rel"), "noopener noreferrer");

    const hostLink = page.getByRole("img", { name: "Host result" })
      .locator("xpath=parent::a");
    assert.equal(
      await hostLink.getAttribute("href"),
      `/api/host-images?${new URLSearchParams({ path: "/tmp/host-result.png" })}`
    );
    const unnamedLink = page.locator('img[alt=""]').locator("xpath=parent::a");
    assert.equal(
      await unnamedLink.getAttribute("aria-label"),
      "Open image in a new window"
    );
    assert.equal(
      await page.getByRole("img", { name: "Unsafe result" })
        .locator("xpath=parent::a").count(),
      0,
      "an image-only data URI must not become a navigation link"
    );
    assert.equal(
      await page.getByRole("img", { name: "Unsafe contact" })
        .locator("xpath=parent::a").count(),
      0,
      "a non-image navigation scheme must not become a link"
    );
    assert.equal(await page.locator(".message.user img").count(), 0);
    await page.getByText(userMarkdown, { exact: true }).waitFor();

    await workspaceLink.focus();
    assert.equal(
      await workspaceLink.evaluate((node) => getComputedStyle(node).outlineStyle),
      "solid"
    );
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      workspaceImage.click(),
    ]);
    await popup.waitForLoadState();
    const opened = new URL(popup.url());
    assert.equal(opened.pathname, "/api/files");
    assert.equal(opened.searchParams.get("path"), workspaceImagePath);
    assert.equal(await popup.evaluate(() => window.opener === null), true);
    await popup.close();

    await hostLink.focus();
    const [keyboardPopup] = await Promise.all([
      page.waitForEvent("popup"),
      page.keyboard.press("Enter"),
    ]);
    await keyboardPopup.waitForLoadState();
    const keyboardOpened = new URL(keyboardPopup.url());
    assert.equal(keyboardOpened.pathname, "/api/host-images");
    assert.equal(keyboardOpened.searchParams.get("path"), "/tmp/host-result.png");
    assert.equal(await keyboardPopup.evaluate(() => window.opener === null), true);
    await keyboardPopup.close();

    await workspaceLink.focus();
    await page.locator("#messages").evaluate((node) => { node.scrollTop = 0; });
    await fs.mkdir(artifacts, { recursive: true });
    await page.screenshot({
      path: path.join(artifacts, "embedded-images.png"),
      fullPage: true,
      animations: "disabled",
    });
    assert.equal(
      received.some((message) => ["thread/start", "turn/start", "turn/steer"]
        .includes(message.method)),
      false
    );
    assert.deepEqual(errors, []);
    console.log(`Embedded image browser checks passed; screenshot: ${artifacts}`);
  } catch (error) {
    await fs.mkdir(artifacts, { recursive: true });
    if (page) {
      await page.screenshot({
        path: path.join(artifacts, "failure.png"),
        fullPage: true,
      });
    }
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => server.close());
