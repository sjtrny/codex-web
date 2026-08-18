import assert from "node:assert/strict";

import {
  enhanceCodeBlocks,
  writeClipboard,
} from "../frontend/code-copy.mjs";

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.listeners = new Map();
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }

  replaceWith(node) {
    const index = this.parentElement.children.indexOf(this);
    this.parentElement.children.splice(index, 1, node);
    node.parentElement = this.parentElement;
    this.parentElement = null;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(
      (child) => child !== this,
    );
    this.parentElement = null;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  select() {
    this.selected = true;
  }

  setSelectionRange(start, end) {
    this.selection = [start, end];
  }
}

function fakeEnvironment() {
  const document = {
    activeElement: null,
    body: null,
    copiedText: null,
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    createElementNS(_namespace, tagName) {
      return new FakeElement(tagName, document);
    },
    execCommand(command) {
      assert.equal(command, "copy");
      document.copiedText = document.body.children.at(-1).value;
      return true;
    },
  };
  document.body = new FakeElement("body", document);
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
    scheduled,
  };
}

const environment = fakeEnvironment();
const host = new FakeElement("div", environment.document);
const pre = new FakeElement("pre", environment.document);
const code = new FakeElement("code", environment.document);
code.textContent = "const answer = 42;\n";
pre.append(code);
host.append(pre);
const fragment = {
  querySelectorAll(selector) {
    assert.equal(selector, "pre > code");
    return [code];
  },
};

assert.equal(enhanceCodeBlocks(fragment, environment), fragment);
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
enhanceCodeBlocks(fragment, environment);
assert.equal(host.children.length, 1, "enhancement should be idempotent");
assert.equal(wrapper.children.length, 2, "an enhanced block should not gain another button");

environment.document.activeElement = button;
await button.listeners.get("click")();
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

const retryEnvironment = fakeEnvironment();
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

console.log("code-copy=ok");
