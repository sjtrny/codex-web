import createDOMPurify from "dompurify";
import { Marked } from "marked";
import { enhanceCodeBlocks } from "./code-copy.mjs";
import {
  isSameOriginHttpUrl,
  linkRenderedImages,
  localImageUrl,
  rewriteLocalImages,
  rewriteWorkspaceLinks,
  setWorkspaceRoot,
  workspaceFileUrl,
} from "./workspace-links.mjs";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const markdown = new Marked();
markdown.use({
  gfm: true,
  breaks: true,
  renderer: {
    html(token) {
      return escapeHtml(token.text);
    },
  },
});
// Capture these while the script is executing. The production page supplies
// fingerprinted URLs; the source page also works with the development assets.
const script = document.currentScript;
const mathScript = script?.dataset.mathScript || "/static/vendor/math.js";
const mathStyle = script?.dataset.mathStyle || "/static/vendor/math.css";
let mathReady = false;
let mathRequest;

function loadMathAsset(tag, url) {
  return new Promise((resolve, reject) => {
    const element = document.createElement(tag);
    if (tag === "link") { element.rel = "stylesheet"; element.href = url; }
    else { element.src = url; element.async = true; }
    element.onload = () => resolve();
    element.onerror = () => {
      element.remove();
      reject(new Error(`Unable to load ${url}`));
    };
    document.head.append(element);
  });
}

function loadMath() {
  if (!mathRequest) {
    mathRequest = Promise.all([
      globalThis.CodexMath ? Promise.resolve() : loadMathAsset("script", mathScript),
      loadMathAsset("link", mathStyle),
    ]).then(() => {
      globalThis.CodexMath.install(markdown);
      mathReady = true;
    }).catch((error) => {
      mathRequest = undefined; // A later render can retry after a network failure.
      throw error;
    });
  }
  return mathRequest;
}

const purifier = createDOMPurify(window);
purifier.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName !== "href" && data.attrName !== "src") return;
  const rewritten = data.attrName === "src"
    ? localImageUrl(data.attrValue)
    : workspaceFileUrl(data.attrValue);
  if (rewritten) data.attrValue = rewritten;
});
const sanitizeOptions = Object.freeze({
  RETURN_DOM_FRAGMENT: true,
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["iframe", "object", "embed", "form", "style", "script"],
});

function plainTextFragment(value) {
  const fragment = document.createDocumentFragment();
  fragment.append(document.createTextNode(String(value || "")));
  return fragment;
}

function renderNow(value) {
  const source = String(value || "");
  try {
    const html = markdown.parse(source);
    const fragment = purifier.sanitize(html, sanitizeOptions);
    rewriteWorkspaceLinks(fragment);
    rewriteLocalImages(fragment);
    for (const image of fragment.querySelectorAll("img")) {
      image.loading = "lazy";
      image.decoding = "async";
    }
    linkRenderedImages(fragment, (source) => (
      isSameOriginHttpUrl(source, window.location.href)
      && purifier.isValidAttribute("a", "href", source)
    ));
    for (const link of fragment.querySelectorAll("a[href]")) {
      if (!link.getAttribute("href").startsWith("#")) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
    }
    enhanceCodeBlocks(fragment);
    return fragment;
  } catch (error) {
    console.warn("Markdown rendering failed; showing plain text", error);
    return plainTextFragment(source);
  }
}

function render(value) {
  const source = String(value || "");
  // Be conservative: incomplete streamed maths should also trigger loading.
  // Plain text, ordinary Markdown and dollar amounts need no KaTeX download.
  if (mathReady || !/\\\(|\\\[|\$\$|\$[^\n$]+\$|\$\r?\n/.test(source)) return renderNow(source);
  const fragment = document.createDocumentFragment();
  const pending = document.createElement("div");
  pending.className = "math-pending";
  pending.textContent = source;
  fragment.append(pending);
  void loadMath().then(() => {
    const visible = pending.isConnected;
    if (visible) document.dispatchEvent(new Event("codex:before-math-render"));
    pending.replaceWith(renderNow(source));
    if (visible) document.dispatchEvent(new Event("codex:after-math-render"));
  }).catch((error) => {
    console.warn("Math rendering unavailable; keeping readable source", error);
  });
  return fragment;
}

function configure(options = {}) {
  if (options.workspaceRoot) setWorkspaceRoot(options.workspaceRoot);
}

globalThis.CodexMarkdown = Object.freeze({ configure, render });
