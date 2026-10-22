import "katex/dist/katex.min.css";
import markedKatex from "marked-katex-extension";
import standardLatex from "./standard-latex.mjs";

globalThis.CodexMath = Object.freeze({
  install(markdown) {
    const options = { throwOnError: false, trust: false, strict: "warn" };
    markdown.use(markedKatex(options));
    markdown.use(standardLatex(options));
  },
});
