import katex from "katex";

const inlineRule = /^\\\(([^\n]*?)\\\)/;
const blockRule = /^\\\[[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n)?[ \t]*\\\][ \t]*(?:\r?\n|$)/;

function renderer(options, displayMode, newlineAfter = false) {
  return (token) => katex.renderToString(token.text, {
    ...options,
    displayMode,
  }) + (newlineAfter ? "\n" : "");
}

function inlineLatex(options) {
  return {
    name: "inlineBracketKatex",
    level: "inline",
    start(source) {
      const index = source.indexOf("\\(");
      return index >= 0 ? index : undefined;
    },
    tokenizer(source) {
      const match = source.match(inlineRule);
      if (!match) return undefined;
      return {
        type: "inlineBracketKatex",
        raw: match[0],
        text: match[1].trim(),
      };
    },
    renderer: renderer(options, false),
  };
}

function blockLatex(options) {
  return {
    name: "blockBracketKatex",
    level: "block",
    tokenizer(source) {
      const match = source.match(blockRule);
      if (!match) return undefined;
      return {
        type: "blockBracketKatex",
        raw: match[0],
        text: match[1].trim(),
      };
    },
    renderer: renderer(options, true, true),
  };
}

export default function standardLatex(options = {}) {
  return {
    extensions: [inlineLatex(options), blockLatex(options)],
  };
}
