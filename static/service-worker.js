"use strict";

// Codex requires a live app-server, so the worker deliberately avoids caching
// the UI or conversation data. Its only job is to provide the PWA lifecycle.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
