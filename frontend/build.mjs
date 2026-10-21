import { build } from "esbuild";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const output = "static/vendor";
// This directory contains only generated assets. Remove obsolete fingerprints.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: ["frontend/markdown.js", "frontend/math.js", "static/app.js", "static/theme.js", "static/style.css"],
  bundle: true, minify: true, format: "iife", target: "es2020", outdir: output,
  entryNames: "[name]", assetNames: "fonts/[name]-[hash]",
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  logLevel: "info",
});

async function writeCompressed(filename, bytes) {
  await writeFile(filename, bytes);
  await writeFile(filename + ".gz", gzipSync(bytes, { level: 9 }));
  await writeFile(filename + ".br", brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }));
}

const urls = new Map();
for (const name of (await readdir(output)).sort()) {
  if (!/\.(js|css)$/.test(name)) continue;
  const bytes = await readFile(path.join(output, name));
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const fingerprint = name.replace(/\.(js|css)$/, `-${hash}.$1`);
  await writeCompressed(path.join(output, fingerprint), bytes);
  urls.set(name, `/static/vendor/${fingerprint}`);
}
let html = await readFile("static/index.html", "utf8");
html = html.replace(/\/static\/(?:vendor\/)?([\w-]+\.(?:js|css))/g, (url, name) => urls.get(name) || url);
await writeCompressed(path.join(output, "index.html"), Buffer.from(html));
