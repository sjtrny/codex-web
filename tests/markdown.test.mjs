import assert from "node:assert/strict";

import { Marked } from "marked";
import markedKatex from "marked-katex-extension";

import standardLatex from "../frontend/standard-latex.mjs";

const options = { throwOnError: false, trust: false, strict: "warn" };
const markdown = new Marked({ gfm: true, breaks: true });
markdown.use(markedKatex(options));
markdown.use(standardLatex(options));

const source = [
  String.raw`Inline \(S_T \approx 11.012\ \mathrm{pm/^\circ C}\) and $x^2$.`,
  "",
  String.raw`\[`,
  String.raw`\boxed{`,
  String.raw`V_{\mathrm{offset}}(T)`,
  String.raw`=V_{\mathrm{offset,ref}}-0.0548(T-T_{\mathrm{ref}})`,
  "}",
  String.raw`\]`,
  "",
  String.raw`\[ b_{\mathrm{new}}=b_{\mathrm{old}}-\frac{r}{S_V} \]`,
  "",
  "Keep inline and fenced code intact:",
  "",
  "`\\(not math\\)`",
  "",
  "```tex",
  String.raw`\[also not math\]`,
  "```",
].join("\n");

const html = markdown.parse(source);
assert.equal((html.match(/class="katex-display"/g) || []).length, 2);
assert.equal((html.match(/class="katex"/g) || []).length, 4);
assert.match(html, /<code>\\\(not math\\\)<\/code>/);
assert.match(html, /<code class="language-tex">\\\[also not math\\\]/);
assert.match(html, /V_{\\mathrm\{offset\}}/);

console.log("standard-latex-delimiters=ok");
