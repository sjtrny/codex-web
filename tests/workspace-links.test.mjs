import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import {
  isSameOriginHttpUrl,
  linkRenderedImages,
  localImageUrl,
  rewriteLocalImages,
  rewriteWorkspaceLinks,
  setWorkspaceRoot,
  workspaceFileUrl,
} from "../frontend/workspace-links.mjs";

assert.equal(
  workspaceFileUrl("/workspaces/example-project/report.pdf"),
  "/api/files?path=%2Fworkspaces%2Fexample-project%2Freport.pdf",
);
assert.equal(
  workspaceFileUrl("/workspaces/example-project/a%20file.py:42:7"),
  "/api/files?path=%2Fworkspaces%2Fexample-project%2Fa+file.py%3A42%3A7&line=42",
);
assert.equal(
  workspaceFileUrl("file:///workspaces/example-project/image.png#L12"),
  "/api/files?path=%2Fworkspaces%2Fexample-project%2Fimage.png&line=12",
);
assert.equal(
  workspaceFileUrl("/workspaces/example-project/100%.txt"),
  "/api/files?path=%2Fworkspaces%2Fexample-project%2F100%25.txt",
);
assert.equal(workspaceFileUrl("https://example.com/report.pdf"), null);
assert.equal(workspaceFileUrl("/etc/passwd"), null);
assert.equal(
  localImageUrl("/tmp/freelens-illumination/synthetic_comparison.png"),
  "/api/host-images?path=%2Ftmp%2Ffreelens-illumination%2Fsynthetic_comparison.png",
);
assert.equal(
  localImageUrl("file:///tmp/freelens-illumination/field%200001.webp#preview"),
  "/api/host-images?path=%2Ftmp%2Ffreelens-illumination%2Ffield+0001.webp",
);
assert.equal(localImageUrl("https://example.com/image.png"), null);
assert.equal(localImageUrl("//example.com/image.png"), null);
assert.equal(localImageUrl("/tmp/not-an-image.txt"), null);
assert.equal(localImageUrl("/api/host-images?path=%2Ftmp%2Fimage.png"), null);

const attributes = new Map([["href", "/workspaces/example-project/result.txt:9"]]);
const link = {
  title: "",
  getAttribute(name) {
    return attributes.get(name) ?? null;
  },
  setAttribute(name, value) {
    attributes.set(name, String(value));
  },
};
rewriteWorkspaceLinks({ querySelectorAll: () => [link] });
assert.equal(
  attributes.get("href"),
  "/api/files?path=%2Fworkspaces%2Fexample-project%2Fresult.txt%3A9&line=9",
);
assert.equal(attributes.get("data-workspace-file"), "true");
assert.equal(link.title, "Open workspace file");

const imageAttributes = new Map([
  ["src", "/workspaces/cairo-visuals/preview_codex_web.png"],
]);
const image = {
  getAttribute(name) {
    return imageAttributes.get(name) ?? null;
  },
  setAttribute(name, value) {
    imageAttributes.set(name, String(value));
  },
};
rewriteLocalImages({ querySelectorAll: () => [image] });
assert.equal(
  imageAttributes.get("src"),
  "/api/files?path=%2Fworkspaces%2Fcairo-visuals%2Fpreview_codex_web.png",
);
assert.equal(imageAttributes.get("data-local-image"), "true");

imageAttributes.set(
  "src",
  "/tmp/freelens-illumination/field_0001_comparison.png",
);
rewriteLocalImages({ querySelectorAll: () => [image] });
assert.equal(
  imageAttributes.get("src"),
  "/api/host-images?path=%2Ftmp%2Ffreelens-illumination%2Ffield_0001_comparison.png",
);

const document = new JSDOM().window.document;
const rendered = document.createRange().createContextualFragment(`
  <img id="bare" src="/api/files?path=%2Fworkspaces%2Fchart.png" alt="Result chart">
  <a id="explicit" href="https://example.com/details">
    <img id="linked" src="https://example.com/thumbnail.png" alt="Linked thumbnail">
  </a>
  <img id="empty-alt" src="/api/host-images?path=%2Ftmp%2Fpreview.png" alt="">
  <img id="unsafe" src="data:text/html,unsafe" alt="Unsafe image">
`);
const baseUrl = "https://codex.example/thread";
const isSafeHref = (value) => isSameOriginHttpUrl(value, baseUrl);
assert.equal(linkRenderedImages(rendered, isSafeHref), rendered);
const bare = rendered.querySelector("#bare");
const bareLink = bare.parentElement;
assert.equal(bareLink.localName, "a");
assert.equal(
  bareLink.getAttribute("href"),
  "/api/files?path=%2Fworkspaces%2Fchart.png",
);
assert.equal(bareLink.getAttribute("title"), "Open image in a new window");
assert.equal(bareLink.className, "embedded-image-link");
assert.equal(
  bareLink.getAttribute("aria-label"),
  "Result chart (opens in a new window)",
);
const emptyAltLink = rendered.querySelector("#empty-alt").parentElement;
assert.equal(emptyAltLink.getAttribute("aria-label"), "Open image in a new window");
const explicit = rendered.querySelector("#explicit");
assert.equal(rendered.querySelector("#linked").parentElement, explicit);
assert.equal(explicit.getAttribute("href"), "https://example.com/details");
assert.equal(rendered.querySelector("#unsafe").closest("a"), null);
linkRenderedImages(rendered, isSafeHref);
assert.equal(bare.parentElement, bareLink, "linking images must be idempotent");

assert.equal(isSameOriginHttpUrl("/api/files?path=image.png", baseUrl), true);
assert.equal(isSameOriginHttpUrl("relative/image.png", baseUrl), true);
assert.equal(isSameOriginHttpUrl("https://codex.example/image.png", baseUrl), true);
assert.equal(isSameOriginHttpUrl("//codex.example/image.png", baseUrl), true);
assert.equal(isSameOriginHttpUrl("https://other.example/image.png", baseUrl), false);
assert.equal(isSameOriginHttpUrl("mailto:images@example.com", baseUrl), false);
assert.equal(isSameOriginHttpUrl("data:image/png;base64,AAAA", baseUrl), false);
assert.equal(isSameOriginHttpUrl("ftp://codex.example/image.png", baseUrl), false);
assert.equal(isSameOriginHttpUrl("#image", baseUrl), false);

assert.equal(setWorkspaceRoot("/srv/code/"), true);
assert.equal(
  workspaceFileUrl("/srv/code/project/result.txt:12"),
  "/api/files?path=%2Fsrv%2Fcode%2Fproject%2Fresult.txt%3A12&line=12",
);
assert.equal(
  workspaceFileUrl("file:///srv/code/project/image.png"),
  "/api/files?path=%2Fsrv%2Fcode%2Fproject%2Fimage.png",
);
assert.equal(workspaceFileUrl("/workspaces/example-project/report.pdf"), null);
assert.equal(setWorkspaceRoot("relative/path"), false);

console.log("workspace-links=ok");
