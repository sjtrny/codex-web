import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { JSDOM } from "jsdom";

import {
  enhanceCodeBlocks,
  writeClipboard,
} from "../frontend/code-copy.mjs";

function clipboardEnvironment() {
  const { window } = new JSDOM("<!doctype html><body><pre><code></code></pre></body>");
  const { document } = window;
  document.execCommand = (command) => {
    assert.equal(command, "copy");
    document.copiedText = document.activeElement.value;
    return true;
  };
  const scheduled = [];
  return {
    document,
    isSecureContext: false,
    navigator: {},
    setTimeout(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    clearTimeout() {},
    close: () => window.close(),
    scheduled,
  };
}

const environment = clipboardEnvironment();
const host = environment.document.body;
const pre = host.querySelector("pre");
const code = pre.querySelector("code");
code.textContent = "const answer = 42;\n";
assert.equal(enhanceCodeBlocks(host, environment), host);
const wrapper = host.children[0];
assert.equal(wrapper.className, "code-block");
assert.equal(wrapper.children.length, 2);
const [button, wrappedPre] = wrapper.children;
assert.equal(button.className, "copy-code");
assert.equal(button.type, "button");
assert.equal(button.getAttribute("aria-label"), "Copy code to clipboard");
assert.equal(button.title, "Copy code");
assert.equal(button.children[0].tagName, "svg");
assert.equal(button.children[0].getAttribute("data-icon"), "copy");
assert.equal(wrappedPre, pre);
enhanceCodeBlocks(host, environment);
assert.equal(host.children.length, 1, "enhancement should be idempotent");
assert.equal(wrapper.children.length, 2, "an enhanced block should not gain another button");

button.focus();
button.click();
await setImmediate();
assert.equal(environment.document.copiedText, code.textContent);
assert.equal(environment.document.activeElement, button, "fallback copy restores focus");
assert.equal(button.className, "copy-code copied");
assert.equal(button.title, "Copied!");
assert.equal(button.children[0].getAttribute("data-icon"), "check");
assert.equal(button.getAttribute("aria-busy"), null);
environment.scheduled.at(-1)();
assert.equal(button.className, "copy-code");
assert.equal(button.title, "Copy code");
assert.equal(button.children[0].getAttribute("data-icon"), "copy");

let secureCopy = null;
await writeClipboard("secure copy", {
  isSecureContext: true,
  navigator: {
    clipboard: {
      async writeText(value) {
        secureCopy = value;
      },
    },
  },
});
assert.equal(secureCopy, "secure copy");

const retryEnvironment = clipboardEnvironment();
retryEnvironment.isSecureContext = true;
retryEnvironment.navigator.clipboard = {
  async writeText() {
    throw new Error("permission denied");
  },
};
await writeClipboard("fallback after rejection", retryEnvironment);
assert.equal(
  retryEnvironment.document.copiedText,
  "fallback after rejection",
  "a rejected Clipboard API call should use the LAN-compatible fallback",
);

environment.close();
retryEnvironment.close();
console.log("code-copy=ok");
