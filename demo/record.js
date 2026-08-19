#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const pty = require("node-pty");
const { chromium } = require("playwright");

const VIEWPORT = { width: 780, height: 600 };
const DEFAULT_PROMPT = "Reply with exactly: Synced in both.";
const THEME_KEY = "codex-web-theme-v1";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--prompt" || argument === "--output") {
      if (!argv[index + 1]) throw new Error(`${argument} requires a value.`);
      options[argument.slice(2)] = argv[index + 1];
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function usage() {
  console.log(`Usage: ./record.sh [--prompt TEXT] [--output PATH]

Environment: DEMO_PROMPT, DEMO_OUTPUT, DEMO_CODEX_AUTH, CODEX_BIN`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mkdir(directory, mode = 0o700) {
  fs.mkdirSync(directory, { recursive: true, mode });
  fs.chmodSync(directory, mode);
}

function executableOnPath(name) {
  if (name.includes(path.sep)) return fs.realpathSync(name);
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Keep searching.
    }
  }
  throw new Error(`${name} was not found on PATH.`);
}

function findAuthentication() {
  const candidates = [
    process.env.DEMO_CODEX_AUTH,
    process.env.CODEX_AUTH_FILE,
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function captureOutput(child) {
  const chunks = [];
  const collect = (chunk) => {
    chunks.push(String(chunk));
    if (chunks.length > 80) chunks.shift();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return () => chunks.join("").slice(-8000);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.${lastError ? ` ${lastError.message}` : ""}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(1000)]);
  }
}

function terminalHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css">
<style>html,body,#terminal{width:100%;height:100%;margin:0;background:#101112;overflow:hidden}</style></head>
<body><div id="terminal"></div><script src="/xterm.js"></script><script>
const term = new Terminal({
  cols: 88, rows: 28, cursorBlink: false, fontSize: 14, lineHeight: 1.16,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  theme: {background:'#101112',foreground:'#f1f3f4',cursor:'#f1f3f4',black:'#101112',brightBlack:'#73787c'}
});
term.open(document.getElementById('terminal'));
term.onData((data) => window.terminalInput(data));
window.demoWrite = (data) => new Promise((resolve) => term.write(data, resolve));
window.demoScreen = () => {
  const buffer = term.buffer.active;
  const lines = [];
  for (let row = 0; row < term.rows; row += 1) lines.push(buffer.getLine(row)?.translateToString(true) || '');
  return lines.join('\\n').replace(/\\s+$/, '');
};
window.demoReady = true;
</script></body></html>`;
}

function snapshotHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{width:100%;height:100%;margin:0;background:#101112;color:#f1f3f4;overflow:hidden}
pre{box-sizing:border-box;width:100%;height:100%;margin:0;padding:14px 12px;white-space:pre;overflow:hidden;font:14px/1.16 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
</style></head><body><pre id="screen"></pre><script>
window.setScreen = (text) => { document.getElementById('screen').textContent = text; };
</script></body></html>`;
}

async function startAssetServer() {
  const xtermEntry = require.resolve("@xterm/xterm");
  const xtermRoot = path.resolve(path.dirname(xtermEntry), "..");
  const assets = {
    "/xterm.js": [path.join(xtermRoot, "lib", "xterm.js"), "text/javascript; charset=utf-8"],
    "/xterm.css": [path.join(xtermRoot, "css", "xterm.css"), "text/css; charset=utf-8"],
  };
  const server = http.createServer((request, response) => {
    if (request.url === "/terminal") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(terminalHtml());
      return;
    }
    if (request.url === "/snapshot") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(snapshotHtml());
      return;
    }
    const asset = assets[request.url];
    if (asset) {
      response.writeHead(200, { "Content-Type": asset[1] });
      fs.createReadStream(asset[0]).pipe(response);
      return;
    }
    response.writeHead(404).end();
  });
  const port = await freePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${port}` };
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

async function screenshot(page, session, destination) {
  await page.bringToFront();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result = await session.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 },
  });
  fs.writeFileSync(destination, Buffer.from(result.data, "base64"));
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const repoRoot = path.resolve(__dirname, "..");
  const prompt = options.prompt || process.env.DEMO_PROMPT || DEFAULT_PROMPT;
  const output = path.resolve(options.output || process.env.DEMO_OUTPUT || path.join(repoRoot, "docs", "sync-demo.gif"));
  if (!prompt.trim() || /[\r\n]/.test(prompt)) throw new Error("The demo prompt must be one non-empty line.");

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-demo-"));
  const temporaryHome = path.join(temporaryRoot, "home");
  const codexHome = path.join(temporaryRoot, "codex-home");
  const workspace = path.join(temporaryRoot, "workspace");
  const uploads = path.join(temporaryRoot, "uploads");
  const runDirectory = path.join(temporaryRoot, "run");
  const framesRoot = path.join(temporaryRoot, "frames");
  const webFrames = path.join(framesRoot, "web");
  const cliFrames = path.join(framesRoot, "cli");
  for (const directory of [temporaryHome, codexHome, workspace, uploads, runDirectory, webFrames, cliFrames]) mkdir(directory);

  let appServer;
  let webServer;
  let assetServer;
  let browser;
  let terminalProcess;
  let terminalClosed = false;

  try {
    const authentication = findAuthentication();
    if (authentication) {
      fs.copyFileSync(authentication, path.join(codexHome, "auth.json"));
      fs.chmodSync(path.join(codexHome, "auth.json"), 0o600);
    } else if (!process.env.OPENAI_API_KEY) {
      throw new Error("Codex authentication was not found. Sign in with Codex CLI first.");
    }

    const codexBinary = executableOnPath(process.env.CODEX_BIN || "codex");
    const python = process.env.DEMO_PYTHON || (fs.existsSync(path.join(__dirname, ".venv", "bin", "python"))
      ? path.join(__dirname, ".venv", "bin", "python")
      : "python3");
    const socketPath = path.join(runDirectory, "app.sock");
    const socketUri = `unix://${socketPath}`;
    const isolatedEnvironment = {
      ...process.env,
      CODEX_HOME: codexHome,
      HOME: temporaryHome,
      USER: process.env.USER || os.userInfo().username,
    };
    delete isolatedEnvironment.CODEX_APP_SERVER_SOCKET;

    appServer = spawn(codexBinary, ["app-server", "--listen", socketUri], {
      cwd: workspace,
      env: isolatedEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const appServerOutput = captureOutput(appServer);
    await waitFor(() => {
      if (appServer.exitCode !== null) throw new Error(appServerOutput());
      try {
        return fs.statSync(socketPath).isSocket();
      } catch {
        return false;
      }
    }, "the isolated app-server socket");

    const webPort = await freePort();
    webServer = spawn(python, [path.join(repoRoot, "app.py")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_APP_SERVER_SOCKET: socketPath,
        CODEX_DEFAULT_CWD: workspace,
        CODEX_UPLOAD_DIR: uploads,
        CODEX_UPLOAD_HOST_DIR: uploads,
        CODEX_WORKSPACE_ROOT: workspace,
        HOST: "127.0.0.1",
        PORT: String(webPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const webServerOutput = captureOutput(webServer);
    const webUrl = `http://127.0.0.1:${webPort}`;
    await waitFor(async () => {
      if (webServer.exitCode !== null) throw new Error(webServerOutput());
      const response = await fetch(`${webUrl}/healthz`);
      return response.ok;
    }, "Codex Web");

    assetServer = await startAssetServer();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark", reducedMotion: "reduce" });
    await context.addInitScript(({ key }) => localStorage.setItem(key, "dark"), { key: THEME_KEY });

    const terminalPage = await context.newPage();
    await terminalPage.exposeFunction("terminalInput", (data) => {
      if (!terminalClosed) terminalProcess?.write(data);
    });
    await terminalPage.goto(`${assetServer.url}/terminal`);
    await terminalPage.waitForFunction(() => window.demoReady === true);

    let writeQueue = Promise.resolve();
    terminalProcess = pty.spawn(codexBinary, [
      "--remote", socketUri,
      "-C", workspace,
      "-s", "read-only",
      "-a", "never",
    ], {
      name: "xterm-256color",
      cols: 88,
      rows: 28,
      cwd: workspace,
      env: { ...isolatedEnvironment, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    terminalProcess.onData((data) => {
      writeQueue = writeQueue.then(() => terminalPage.evaluate((chunk) => window.demoWrite(chunk), data));
    });

    await delay(9000);
    terminalProcess.write("\x0c");
    await delay(1200);
    await writeQueue;

    const snapshotPage = await context.newPage();
    await snapshotPage.goto(`${assetServer.url}/snapshot`);
    const webPage = await context.newPage();
    await webPage.goto(webUrl, { waitUntil: "networkidle" });
    await webPage.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}" });
    await webPage.waitForFunction(() => {
      const promptBox = document.querySelector("#prompt");
      return promptBox && !promptBox.disabled && document.querySelector("#cwd")?.value;
    });
    await delay(500);
    if (await webPage.locator(".thread").count() !== 0) throw new Error("The isolated app-server was not blank.");

    const webSession = await context.newCDPSession(webPage);
    const snapshotSession = await context.newCDPSession(snapshotPage);
    let frameNumber = 0;
    const capture = async () => {
      await writeQueue;
      const screen = await terminalPage.evaluate(() => window.demoScreen());
      await snapshotPage.evaluate((text) => window.setScreen(text), screen);
      const number = String(frameNumber).padStart(4, "0");
      await screenshot(webPage, webSession, path.join(webFrames, `web-${number}.png`));
      await screenshot(snapshotPage, snapshotSession, path.join(cliFrames, `cli-${number}.png`));
      frameNumber += 1;
    };

    for (let index = 0; index < 7; index += 1) await capture();
    for (let index = 0; index < prompt.length; index += 2) {
      terminalProcess.write(prompt.slice(index, index + 2));
      await delay(90);
      await capture();
    }
    terminalProcess.write("\r");

    const responseDeadline = Date.now() + 90_000;
    let threadOpened = false;
    let lastRefresh = 0;
    while (Date.now() < responseDeadline) {
      if (!threadOpened && Date.now() - lastRefresh >= 600) {
        lastRefresh = Date.now();
        await webPage.evaluate(() => refreshThreads());
        const threadCount = await webPage.locator(".thread").count();
        if (threadCount > 1) throw new Error("Unexpected pre-existing threads appeared.");
        if (threadCount === 1) {
          await webPage.locator(".thread").click();
          threadOpened = true;
          await delay(250);
        }
      }

      await capture();
      if (threadOpened) {
        const complete = await webPage.evaluate(() => {
          const answer = [...document.querySelectorAll(".message.agent .body")]
            .map((node) => node.innerText).join("").trim();
          return Boolean(answer) && document.querySelector("#thinking-indicator")?.hidden === true;
        });
        if (complete) break;
      }
      await delay(160);
    }
    if (Date.now() >= responseDeadline) throw new Error("Timed out waiting for the Codex response.");
    for (let index = 0; index < 12; index += 1) await capture();

    await new Promise((resolve, reject) => {
      const composer = spawn(python, [
        path.join(__dirname, "compose.py"),
        "--frames", framesRoot,
        "--output", output,
      ], { stdio: "inherit" });
      composer.once("error", reject);
      composer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`GIF composer exited with ${code}.`)));
    });
    console.log(`Recorded ${frameNumber} frames with prompt: ${prompt}`);
  } finally {
    terminalClosed = true;
    try { terminalProcess?.kill(); } catch {}
    try { if (browser) await browser.close(); } catch {}
    try { await closeServer(assetServer?.server); } catch {}
    try { await stopChild(webServer); } catch {}
    try { await stopChild(appServer); } catch {}
    if (process.env.DEMO_KEEP_TEMP === "1") {
      console.log(`Temporary files kept at ${temporaryRoot}`);
    } else {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
