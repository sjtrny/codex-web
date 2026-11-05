"use strict";

// Account RPCs do not require a model turn. Keep recovery available when inference
// authentication has failed, and leave credential storage to the app-server.
globalThis.CodexAccount = {
  create({ rpc, openSettings, onSignedIn = () => {}, storage }) {
    const ids = ["status", "sign-in", "refresh", "login", "code", "copy", "login-link",
      "login-time", "cancel", "message", "banner", "banner-message", "banner-open"];
    const ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(`account-${id}`)]));
    const storageKey = "codex-web-device-login-v1";
    let online = false, generation = 0, readId = 0, busy = false, checking = false;
    let account = null, checked = false, needsSignIn = false, message = "", login = null, timer;
    let completionPending = false;
    const earlyCompletions = new Map();
    if (storage === undefined) {
      try { storage = globalThis.sessionStorage; } catch { storage = null; }
    }

    function authFailure(error) {
      return error?.codexErrorInfo === "unauthorized"
        || error?.data?.codexErrorInfo === "unauthorized"
        || /access token.*(?:refresh|expired)|refresh token|not (?:logged|signed) in|unauthorized|authentication (?:failed|required)|please sign in again/i.test(error?.message || "");
    }

    function validLogin(value) {
      try {
        const url = new URL(value.verificationUrl);
        return typeof value.loginId === "string" && Boolean(value.loginId)
          && typeof value.userCode === "string" && Boolean(value.userCode)
          && value.userCode.length <= 64 && url.protocol === "https:" && !url.username && !url.password
          && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now()
          && value.expiresAt <= Date.now() + 15 * 60 * 1000;
      } catch { return false; }
    }

    function saveLogin() {
      try {
        if (login) storage?.setItem(storageKey, JSON.stringify(login));
        else storage?.removeItem(storageKey);
      } catch { /* Sign-in works when browser storage is disabled. */ }
    }

    function clearLogin() {
      login = null;
      window.clearInterval(timer);
      saveLogin();
    }

    function render() {
      if (login && login.expiresAt <= Date.now()) {
        clearLogin();
        message = "This sign-in code has expired. Start a new sign-in.";
      }
      ui.status.textContent = !online ? "Connecting to Codex…"
        : checking ? "Checking account…"
          : needsSignIn ? "Sign-in required"
            : !checked ? "Account status unavailable"
              : account?.type === "chatgpt" ? `Connected as ${account.email || "ChatGPT account"}${account.planType ? ` · ${account.planType}` : ""}`
                : account?.type === "apiKey" ? "Connected using an API key"
                  : account ? "Connected using another provider" : "This provider does not require an OpenAI account.";
      ui["sign-in"].disabled = !online || busy || Boolean(login);
      ui["sign-in"].textContent = busy && !login ? "Starting sign-in…"
        : account && !needsSignIn ? "Switch account" : "Sign in with ChatGPT";
      ui.refresh.disabled = !online || busy || checking;
      ui.cancel.disabled = !online || busy;
      ui.login.hidden = !login;
      ui.code.textContent = login?.userCode || "";
      if (login) {
        ui["login-link"].href = login.verificationUrl;
        ui["login-time"].textContent = `Waiting for sign-in. Code expires in ${Math.max(1, Math.ceil((login.expiresAt - Date.now()) / 60000))} min. Return here after authorizing.`;
      } else {
        ui["login-link"].removeAttribute("href");
        ui["login-time"].textContent = "";
      }
      ui.message.textContent = message;
      ui.banner.hidden = !needsSignIn && !login;
      ui["banner-message"].textContent = login ? "Complete your ChatGPT sign-in to connect the account." : "Sign in to use Codex. Your conversations are still available.";
      ui["banner-open"].textContent = login ? "View sign-in" : "Sign in";
    }

    function observeError(error, method = "") {
      if (method && !/^(account\/|model\/|thread\/(?:start|resume)|turn\/)/.test(method)) return;
      if (!authFailure(error)) return;
      // A late read from before a successful login must not restore an old error.
      if (method.startsWith("account/")) return;
      needsSignIn = true;
      checked = false;
      render();
    }

    async function refresh({ completed = false } = {}) {
      if (!online) return;
      if (completed) completionPending = true;
      const id = ++readId, connection = generation;
      checking = true;
      render();
      try {
        const result = await rpc("account/read", { refreshToken: false }, 15000);
        if (connection !== generation || id !== readId) return;
        if (typeof result?.requiresOpenaiAuth !== "boolean") throw new Error("Account status is unavailable on this Codex server.");
        const next = result.account || null;
        // account/read may return cached credentials. A live account request is
        // needed to detect the failed-refresh state that prevents agent turns.
        if (next?.type === "chatgpt") await rpc("account/rateLimits/read", {}, 15000);
        if (connection !== generation || id !== readId) return;
        const changed = (checked || needsSignIn)
          && (account?.type !== next?.type || account?.email !== next?.email);
        account = next;
        checked = true;
        needsSignIn = !account && result.requiresOpenaiAuth;
        const restored = login && !needsSignIn && account?.type === "chatgpt"
          && (login.previouslyUnavailable || account.email !== login.previousEmail);
        if (completionPending || restored) {
          completionPending = false;
          clearLogin();
          message = needsSignIn ? "Sign-in did not connect an account. Please try again."
            : "Sign-in complete. You can return to your conversation.";
          if (!needsSignIn) onSignedIn();
        } else {
          if (!login) message = "";
          if (changed && !needsSignIn) onSignedIn();
        }
      } catch (error) {
        if (connection !== generation || id !== readId) return;
        checked = false;
        if (authFailure(error)) {
          needsSignIn = true;
          message = "Your saved sign-in is no longer valid. Sign in with ChatGPT to reconnect.";
        } else {
          message = "Could not check the account. Check your connection or try signing in again.";
        }
      } finally {
        if (connection === generation && id === readId) {
          checking = false;
          render();
        }
      }
    }

    function complete(params) {
      if (!login || params.loginId !== login.loginId) return;
      clearLogin();
      if (params.success) {
        message = "Sign-in completed. Checking account…";
        void refresh({ completed: true });
      } else {
        message = params.error || "Sign-in was not completed. Please try again.";
      }
      render();
    }

    async function start() {
      if (!online || busy || login) return;
      const connection = generation;
      const previousEmail = account?.email || null, previouslyUnavailable = needsSignIn;
      ++readId;
      checking = false;
      busy = true;
      completionPending = false;
      earlyCompletions.clear();
      message = "Requesting a sign-in code…";
      render();
      try {
        const result = await rpc("account/login/start", { type: "chatgptDeviceCode" }, 30000);
        if (connection !== generation) return;
        const next = {
          loginId: result?.loginId, userCode: result?.userCode, verificationUrl: result?.verificationUrl,
          expiresAt: Date.now() + 15 * 60 * 1000, previousEmail, previouslyUnavailable,
        };
        if (result?.type !== "chatgptDeviceCode" || !validLogin(next)) {
          throw new Error("This Codex server did not return a valid device sign-in code");
        }
        login = next;
        saveLogin();
        window.clearInterval(timer);
        timer = window.setInterval(render, 1000);
        message = "Complete sign-in in the browser tab. Codex will connect the account automatically.";
        if (earlyCompletions.has(login.loginId)) complete(earlyCompletions.get(login.loginId));
      } catch (error) {
        if (connection !== generation) return;
        message = /unknown variant|method not found|unsupported/i.test(error.message)
          ? "Device sign-in is unavailable on this Codex server. Update Codex or sign in from its terminal."
          : `Could not start sign-in: ${error.message}`;
      } finally {
        if (connection === generation) { busy = false; earlyCompletions.clear(); render(); }
      }
    }

    async function cancel() {
      if (!online || busy || !login) return;
      const current = login, connection = generation;
      busy = true;
      render();
      try {
        await rpc("account/login/cancel", { loginId: current.loginId }, 15000);
        if (connection !== generation) return;
        if (login === current) { clearLogin(); message = "Sign-in cancelled. You can start again when ready."; }
      } catch (error) {
        if (connection === generation) message = `Could not cancel sign-in: ${error.message}`;
      } finally {
        if (connection === generation) { busy = false; render(); }
      }
    }

    function notification(method, params) {
      if (method === "account/login/completed") {
        if (busy && !login && params.loginId) {
          earlyCompletions.set(params.loginId, params);
          if (earlyCompletions.size > 8) earlyCompletions.delete(earlyCompletions.keys().next().value);
        }
        complete(params);
      } else if (method === "account/updated") {
        void refresh();
      } else if (method === "error") {
        observeError(params.error || params);
      } else if (method === "turn/completed" && params.turn?.error) {
        observeError(params.turn.error);
      }
    }

    function connectionChanged(ready) {
      online = ready;
      ++generation;
      ++readId;
      busy = false;
      checking = false;
      if (!ready) {
        checked = false;
        if (login) message = "Connection lost. You can finish sign-in and reconnect to check the account.";
        render();
      } else void refresh();
    }

    try {
      const saved = JSON.parse(storage?.getItem(storageKey) || "null");
      if (validLogin(saved)) {
        login = saved;
        timer = window.setInterval(render, 1000);
      } else storage?.removeItem(storageKey);
    } catch { /* Only this tab's temporary device code is saved, never tokens. */ }
    ui["banner-open"].addEventListener("click", () => openSettings());
    ui["sign-in"].addEventListener("click", () => void start());
    ui.refresh.addEventListener("click", () => void refresh());
    ui.cancel.addEventListener("click", () => void cancel());
    ui.copy.addEventListener("click", async () => {
      if (!login) return;
      try { await navigator.clipboard.writeText(login.userCode); message = "Code copied."; }
      catch { message = "Select the code above to copy it."; }
      render();
    });
    render();
    return { connectionChanged, notification, observeError, refresh, start, cancel };
  },
};
