"use strict";

// Real Python file responses decoded by Chromium.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE || "../demo/node_modules/playwright"
);

const root = path.resolve(__dirname, "..");
const python = process.env.PYTHON || "python3";
const unicodeText = [
  "en–dash em—dash",
  "Greek: α β γ",
  "units: 5 µm, 10 Ω, 20 °C",
  "accented: café; emoji: 🧪",
].join("\n") + "\n";
const asciiText = "plain ASCII text\n";
const binaryBytes = Buffer.from([0x00, 0x7f, 0x80, 0xff, 0x0a]);
const launcher = `
import asyncio
from aiohttp import web
import app
async def main():
    runner = web.AppRunner(app.create_app())
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    print(site._server.sockets[0].getsockname()[1], flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()
asyncio.run(main())
`;

function fileUrl(baseUrl, file, download = false) {
  const search = new URLSearchParams({ path: file });
  if (download) search.set("download", "1");
  return `${baseUrl}/api/files?${search}`;
}

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codex-web-files-"));
  const workspace = path.join(temporary, "workspace");
  const unicodeFile = path.join(workspace, "unicode.md");
  const asciiFile = path.join(workspace, "ascii.txt");
  const binaryFile = path.join(workspace, "payload.bin");
  await fs.mkdir(workspace);
  await Promise.all([
    fs.writeFile(unicodeFile, unicodeText, "utf8"),
    fs.writeFile(asciiFile, asciiText, "ascii"),
    fs.writeFile(binaryFile, binaryBytes),
  ]);

  const environment = {
    ...process.env,
    CODEX_APP_SERVER_SOCKET: path.join(temporary, "unused.sock"),
    CODEX_UPLOAD_DIR: path.join(temporary, "uploads"),
    CODEX_UPLOAD_HOST_DIR: path.join(temporary, "uploads"),
    CODEX_WORKSPACE_ROOT: workspace,
  };
  delete environment.CODEX_APP_SERVER_URL;
  const server = spawn(python, ["-u", "-c", launcher], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverErrors = "";
  server.stderr.on("data", (data) => { serverErrors += data; });
  const browser = await chromium.launch({ headless: true });
  try {
    const lines = createInterface({ input: server.stdout });
    const timeout = AbortSignal.timeout(10000);
    const [port] = await Promise.race([
      once(lines, "line", { signal: timeout }),
      once(server, "exit", { signal: timeout }).then(() => {
        throw new Error(serverErrors || "Python server exited early");
      }),
    ]);
    lines.close();
    const baseUrl = `http://127.0.0.1:${Number(port)}`;
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const response = await page.goto(fileUrl(baseUrl, unicodeFile));
    assert.equal(response.status(), 200);
    assert.equal(
      response.headers()["content-type"],
      "text/markdown; charset=utf-8"
    );
    const rendered = await page.evaluate(() => ({
      characterSet: document.characterSet,
      contentType: document.contentType,
      text: document.body.innerText,
    }));
    assert.equal(rendered.characterSet, "UTF-8");
    assert.equal(rendered.contentType, "text/markdown");
    assert.equal(rendered.text.trimEnd(), unicodeText.trimEnd());

    const ascii = await context.request.get(fileUrl(baseUrl, asciiFile, true));
    assert.equal(ascii.status(), 200);
    assert.equal(ascii.headers()["content-type"], "text/plain");
    assert.match(ascii.headers()["content-disposition"], /^attachment;/);
    assert.deepEqual(await ascii.body(), Buffer.from(asciiText, "ascii"));

    const binary = await context.request.get(fileUrl(baseUrl, binaryFile));
    assert.equal(binary.status(), 200);
    assert.equal(binary.headers()["content-type"], "application/octet-stream");
    assert.match(binary.headers()["content-disposition"], /^attachment;/);
    assert.deepEqual(await binary.body(), binaryBytes);

    const result = {
      unicode: rendered,
      ascii: {
        contentType: ascii.headers()["content-type"],
        disposition: ascii.headers()["content-disposition"],
      },
      binary: {
        bytes: [...binaryBytes],
        contentType: binary.headers()["content-type"],
        disposition: binary.headers()["content-disposition"],
      },
    };
    if (process.env.ARTIFACT_DIR) {
      await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(process.env.ARTIFACT_DIR, "unicode-preview.png"),
        fullPage: true,
      });
      await fs.writeFile(
        path.join(process.env.ARTIFACT_DIR, "browser-report.json"),
        JSON.stringify(result, null, 2) + "\n"
      );
    }
    console.log(JSON.stringify(result));
    await context.close();
  } finally {
    await browser.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
