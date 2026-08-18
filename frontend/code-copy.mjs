const feedbackTimers = new WeakMap();
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function createIcon(document, name) {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("class", "copy-code-icon");
  svg.setAttribute("data-icon", name);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  if (name === "check") {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", "m2.75 8.25 3.25 3.25 7.25-7.25");
    svg.append(path);
    return svg;
  }

  const front = document.createElementNS(SVG_NAMESPACE, "rect");
  front.setAttribute("x", "4.75");
  front.setAttribute("y", "4.75");
  front.setAttribute("width", "8.5");
  front.setAttribute("height", "8.5");
  front.setAttribute("rx", "1.4");
  const back = document.createElementNS(SVG_NAMESPACE, "path");
  back.setAttribute("d", "M10.25 4.75V3.5A1.75 1.75 0 0 0 8.5 1.75h-5A1.75 1.75 0 0 0 1.75 3.5v5a1.75 1.75 0 0 0 1.75 1.75h1.25");
  svg.append(front, back);
  return svg;
}

function renderButtonState(button, state, environment) {
  const document = environment.document;
  const states = {
    idle: ["copy-code", "copy", "Copy code to clipboard", "Copy code"],
    copying: ["copy-code copying", "copy", "Copying code", "Copying…"],
    copied: ["copy-code copied", "check", "Code copied to clipboard", "Copied!"],
    failed: ["copy-code copy-failed", "copy", "Copy failed; retry", "Copy failed"],
  };
  const [className, icon, label, title] = states[state] || states.idle;
  button.className = className;
  button.replaceChildren(createIcon(document, icon));
  button.setAttribute("aria-label", label);
  button.title = title;
}

function restoreFocus(element) {
  if (typeof element?.focus !== "function") return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

export function legacyCopy(text, environment = globalThis) {
  const document = environment.document;
  const activeElement = document.activeElement;
  const buffer = document.createElement("textarea");
  buffer.className = "clipboard-buffer";
  buffer.value = text;
  buffer.setAttribute("readonly", "");
  buffer.setAttribute("aria-hidden", "true");
  buffer.tabIndex = -1;
  document.body.append(buffer);
  restoreFocus(buffer);
  buffer.select();
  buffer.setSelectionRange?.(0, buffer.value.length);

  let copied = false;
  try {
    copied = Boolean(document.execCommand?.("copy"));
  } finally {
    buffer.remove();
    restoreFocus(activeElement);
  }
  if (!copied) throw new Error("The browser refused the copy command");
}

export async function writeClipboard(text, environment = globalThis) {
  const clipboard = environment.navigator?.clipboard;
  let clipboardError = null;
  if (environment.isSecureContext && typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }
  try {
    legacyCopy(text, environment);
  } catch (error) {
    throw clipboardError || error;
  }
}

function clearFeedbackTimer(button, environment) {
  const timer = feedbackTimers.get(button);
  if (timer === undefined) return;
  const cancel = environment.clearTimeout || globalThis.clearTimeout;
  cancel.call(environment, timer);
  feedbackTimers.delete(button);
}

function showFeedback(button, copied, environment) {
  clearFeedbackTimer(button, environment);
  renderButtonState(button, copied ? "copied" : "failed", environment);
  const schedule = environment.setTimeout || globalThis.setTimeout;
  const timer = schedule.call(environment, () => {
    renderButtonState(button, "idle", environment);
    feedbackTimers.delete(button);
  }, 1600);
  feedbackTimers.set(button, timer);
}

export function enhanceCodeBlocks(fragment, environment = globalThis) {
  const document = environment.document;
  for (const code of fragment.querySelectorAll("pre > code")) {
    const pre = code.parentElement;
    if (!pre || pre.parentElement?.classList.contains("code-block")) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    const button = document.createElement("button");
    button.type = "button";
    renderButtonState(button, "idle", environment);

    pre.replaceWith(wrapper);
    wrapper.append(button, pre);

    let copying = false;
    button.addEventListener("click", async () => {
      if (copying) return;
      copying = true;
      clearFeedbackTimer(button, environment);
      renderButtonState(button, "copying", environment);
      button.setAttribute("aria-busy", "true");
      try {
        await writeClipboard(code.textContent || "", environment);
        showFeedback(button, true, environment);
      } catch {
        showFeedback(button, false, environment);
      } finally {
        button.removeAttribute("aria-busy");
        copying = false;
      }
    });
  }
  return fragment;
}
