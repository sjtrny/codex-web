"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../static/theme.js"), "utf8");

function loadTheme({ dark = false, stored = null } = {}) {
  const values = new Map();
  if (stored !== null) values.set("codex-web-theme-v1", stored);
  const mediaListeners = new Set();
  const media = {
    matches: dark,
    addEventListener(name, listener) {
      if (name === "change") mediaListeners.add(listener);
    },
  };
  const context = {
    console,
    document: { documentElement: { dataset: {} } },
    localStorage: {
      getItem(key) {
        return values.get(key) ?? null;
      },
      removeItem(key) {
        values.delete(key);
      },
      setItem(key, value) {
        values.set(key, String(value));
      },
    },
    matchMedia() {
      return media;
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(script, context, { filename: "theme.js" });
  return {
    api: context.CodexTheme,
    dataset: context.document.documentElement.dataset,
    setSystemDark(value) {
      media.matches = value;
      for (const listener of mediaListeners) listener({ matches: value });
    },
    stored: () => values.get("codex-web-theme-v1") ?? null,
  };
}

const automatic = loadTheme({ dark: true });
assert.equal(automatic.api.preference(), "system");
assert.equal(automatic.api.effectiveTheme(), "dark");
assert.equal(automatic.dataset.theme, "dark");
assert.equal(automatic.stored(), null);

let notifications = 0;
automatic.api.subscribe(() => { notifications += 1; });
automatic.setSystemDark(false);
assert.equal(automatic.api.effectiveTheme(), "light");
assert.equal(automatic.dataset.theme, "light");
assert.equal(notifications, 1);

automatic.api.cycle();
assert.equal(automatic.api.preference(), "dark");
assert.equal(automatic.dataset.theme, "dark");
assert.equal(automatic.stored(), "dark");

automatic.setSystemDark(true);
assert.equal(automatic.api.effectiveTheme(), "dark", "manual preference ignores OS changes");
assert.equal(notifications, 2, "manual mode should not notify for OS changes");

automatic.api.cycle();
assert.equal(automatic.api.preference(), "system");
assert.equal(automatic.dataset.theme, "dark");
assert.equal(automatic.stored(), null);

const persisted = loadTheme({ dark: true, stored: "light" });
assert.equal(persisted.api.preference(), "light");
assert.equal(persisted.api.effectiveTheme(), "light");
assert.equal(persisted.dataset.theme, "light");

const invalid = loadTheme({ dark: false, stored: "sepia" });
assert.equal(invalid.api.preference(), "system");
assert.equal(invalid.dataset.theme, "light");

console.log("theme-preference=ok");
