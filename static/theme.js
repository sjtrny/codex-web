"use strict";

(() => {
  const STORAGE_KEY = "codex-web-theme-v1";
  const explicitThemes = new Set(["light", "dark"]);
  const systemPreference = window.matchMedia("(prefers-color-scheme: dark)");
  const listeners = new Set();

  function readPreference() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return explicitThemes.has(stored) ? stored : "system";
    } catch {
      return "system";
    }
  }

  let preference = readPreference();

  function systemTheme() {
    return systemPreference.matches ? "dark" : "light";
  }

  function effectiveTheme() {
    return preference === "system" ? systemTheme() : preference;
  }

  function nextPreference() {
    const system = systemTheme();
    if (preference === "system") return system === "dark" ? "light" : "dark";
    if (preference !== system) return system;
    return "system";
  }

  function apply() {
    document.documentElement.dataset.theme = effectiveTheme();
  }

  function notify() {
    const value = Object.freeze({
      effective: effectiveTheme(),
      preference,
    });
    for (const listener of listeners) listener(value);
  }

  function setPreference(value) {
    preference = explicitThemes.has(value) ? value : "system";
    try {
      if (preference === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Theme switching should still work when storage is unavailable.
    }
    apply();
    notify();
  }

  function cycle() {
    setPreference(nextPreference());
  }

  function systemChanged() {
    if (preference !== "system") return;
    apply();
    notify();
  }

  if (systemPreference.addEventListener) {
    systemPreference.addEventListener("change", systemChanged);
  } else if (systemPreference.addListener) {
    systemPreference.addListener(systemChanged);
  }

  apply();
  globalThis.CodexTheme = Object.freeze({
    cycle,
    effectiveTheme,
    nextPreference,
    preference: () => preference,
    setPreference,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
})();
