import createDOMPurify from "dompurify";
import "katex/dist/katex.min.css";
import { Marked } from "marked";
import markedKatex from "marked-katex-extension";
import { enhanceCodeBlocks } from "./code-copy.mjs";
import standardLatex from "./standard-latex.mjs";
import {
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
const katexOptions = Object.freeze({
  throwOnError: false,
  trust: false,
  strict: "warn",
});
markdown.use(markedKatex(katexOptions));
markdown.use(standardLatex(katexOptions));

const purifier = createDOMPurify(window);
purifier.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName !== "href") return;
  const rewritten = workspaceFileUrl(data.attrValue);
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

function render(value) {
  const source = String(value || "");
  try {
    const html = markdown.parse(source);
    const fragment = purifier.sanitize(html, sanitizeOptions);
    rewriteWorkspaceLinks(fragment);
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

function configure(options = {}) {
  if (options.workspaceRoot) setWorkspaceRoot(options.workspaceRoot);
}

globalThis.CodexMarkdown = Object.freeze({ configure, render });
