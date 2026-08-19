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

const paragraphAdjacentSource = [
  String.raw`For \(0\le D\le2r\), the final answer is`,
  String.raw`\[`,
  String.raw`V=\frac{16r^3}{3|\sin\alpha|}`,
  String.raw`\left[(2-m)E(m)-2(1-m)K(m)\right].`,
  String.raw`\]`,
  "Following prose remains outside the display.",
  String.raw`Here \(m\) is the elliptic-integral parameter:`,
  String.raw`  \[`,
  String.raw`K(m)=\int_0^{\pi/2}\frac{dt}{\sqrt{1-m\sin^2t}},`,
  String.raw`\qquad`,
  String.raw`E(m)=\int_0^{\pi/2}\sqrt{1-m\sin^2t}\,dt.`,
  String.raw`  \]`,
].join("\n");
const paragraphAdjacentHtml = markdown.parse(paragraphAdjacentSource);
assert.equal(
  (paragraphAdjacentHtml.match(/class="katex-display"/g) || []).length,
  2,
  "standalone display delimiters should interrupt a preceding paragraph",
);
assert.match(
  paragraphAdjacentHtml,
  /Following prose remains outside the display/,
);
assert.doesNotMatch(paragraphAdjacentHtml, /<br>\s*\[/);

const adjacentDisplays = markdown.parse([
  "Adjacent displays:",
  String.raw`\[x^2\]`,
  String.raw`\[y^2\]`,
  "After both displays.",
].join("\n"));
assert.equal(
  (adjacentDisplays.match(/class="katex-display"/g) || []).length,
  2,
);
assert.match(adjacentDisplays, /After both displays/);

const fourSpaceCode = markdown.parse([
  "Four-space indentation remains code:",
  "",
  String.raw`    \[`,
  "    x^2",
  String.raw`    \]`,
].join("\n"));
assert.equal((fourSpaceCode.match(/class="katex-display"/g) || []).length, 0);
assert.match(fourSpaceCode, /<code>\\\[/);

const malformedDisplay = markdown.parse([
  "An unclosed delimiter stays text:",
  String.raw`\[`,
  "x^2",
].join("\n"));
assert.equal((malformedDisplay.match(/class="katex-display"/g) || []).length, 0);

console.log("standard-latex-delimiters=ok");
