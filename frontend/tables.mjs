// Tables keep their own reading width instead of shrinking to the prose column.
const observed = new Set();
const pendingState = new WeakMap();
let resizeObserver;
let removalObserver;
let mountFrame;
let dialog;
let expanded;

function create(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function updateOverflow(scroller) {
  const maximum = scroller.scrollWidth - scroller.clientWidth;
  const position = Math.abs(scroller.scrollLeft);
  const viewport = scroller.parentElement;
  viewport.classList.toggle("has-start", position > 1);
  viewport.classList.toggle("has-end", position < maximum - 1);
  scroller.tabIndex = maximum > 1 || scroller.scrollHeight > scroller.clientHeight + 1 ? 0 : -1;
  const hint = scroller.closest(".chat-table")?.querySelector(".table-scroll-hint");
  if (hint) hint.hidden = maximum <= 1;
  for (const formula of scroller.querySelectorAll(".katex")) {
    formula.tabIndex = formula.scrollWidth > formula.clientWidth + 1 ? 0 : -1;
  }
}

function observe(scroller) {
  if (!scroller.isConnected || observed.has(scroller)) return;
  if (!resizeObserver && typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(entries => {
      for (const { target } of entries) updateOverflow(target);
    });
    removalObserver = new MutationObserver(records => {
      if (!records.some(record => record.removedNodes.length)) return;
      for (const element of observed) {
        if (element.isConnected) continue;
        resizeObserver.unobserve(element);
        observed.delete(element);
      }
      if (expanded && !expanded.root.isConnected) closeExpandedTable(false);
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });
  }
  observed.add(scroller);
  resizeObserver?.observe(scroller);
  scroller.addEventListener("scroll", () => updateOverflow(scroller), { passive: true });
  updateOverflow(scroller);
}

function scheduleMount() {
  if (mountFrame) return;
  mountFrame = requestAnimationFrame(() => {
    mountFrame = null;
    // History can be assembled in a detached fragment before it is displayed.
    for (const scroller of document.querySelectorAll(".table-scroll")) observe(scroller);
  });
}

function sizeColumns(table) {
  const rows = [...table.rows];
  const columns = rows[0]?.cells.length || 0;
  const colgroup = document.createElement("colgroup");
  const widths = [];
  for (let index = 0; index < columns; index += 1) {
    const cells = rows.map(row => row.cells[index]).filter(Boolean);
    const values = cells.slice(1).map(cell => cell.textContent.trim().replace(/\s+/g, " "));
    const heading = cells[0].textContent.trim();
    const numeric = values.some(Boolean) && values.filter(Boolean).every(value => (
      /^[+−-]?[$€£]?\d[\d,]*(?:\.\d+)?(?:[eE][+−-]?\d+)?\s*%?$/.test(value)
    ));
    const longest = values.reduce((length, value) => Math.max(length, value.length), 0);
    const width = Math.max(6, Math.min(26, longest + 1), Math.min(20, heading.length + 1));
    const column = document.createElement("col");
    // Each cell must still reflow inside a phone or zoomed viewport.
    column.style.width = `min(calc(${width}ch + 1.5rem), calc(100vw - 48px))`;
    widths.push(column.style.width);
    colgroup.append(column);
    for (const cell of cells) {
      // Respect explicit Markdown alignment, including numeric column headers.
      const alignment = cell.getAttribute("align");
      if (["left", "right", "center"].includes(alignment)) cell.style.textAlign = alignment;
      if (numeric && !cell.style.textAlign && !cell.hasAttribute("align")) cell.classList.add("table-number");
      if (cell.tagName === "TH") cell.scope = "col";
    }
  }
  table.prepend(colgroup);
  table.style.width = `calc(${widths.join(" + ")})`;
  return columns;
}

export function enhanceTables(fragment) {
  let enhanced = false;
  for (const table of fragment.querySelectorAll("table")) {
    if (table.closest(".chat-table, .katex")) continue;
    const columns = sizeColumns(table);
    if (!columns) continue;
    const panel = create("div", "chat-table");
    panel.style.setProperty("--table-width", table.style.width);
    const toolbar = create("div", "table-toolbar");
    const label = create("span", "table-label", `${columns} ${columns === 1 ? "column" : "columns"}`);
    const hint = create("span", "table-scroll-hint", "Scroll ↔");
    hint.hidden = true;
    hint.setAttribute("aria-hidden", "true");
    const button = create("button", "table-expand", "Expand");
    button.type = "button";
    button.setAttribute("aria-label", "Expand table");
    button.setAttribute("aria-haspopup", "dialog");
    toolbar.append(label, hint, button);
    const viewport = create("div", "table-viewport");
    const scroller = create("div", "table-scroll");
    scroller.setAttribute("role", "region");
    scroller.setAttribute("aria-label", `Table with ${columns} ${columns === 1 ? "column" : "columns"}. Scroll horizontally for more.`);
    table.replaceWith(panel);
    scroller.append(table);
    viewport.append(scroller);
    panel.append(toolbar, viewport);
    button.addEventListener("click", () => openExpandedTable(panel));
    enhanced = true;
  }
  if (enhanced) scheduleMount();
  return fragment;
}

function createDialog() {
  dialog = create("dialog", "table-dialog");
  dialog.setAttribute("aria-label", "Expanded table");
  const header = create("div", "table-dialog-header");
  header.append(create("h2", "", "Expanded table"));
  const close = create("button", "table-close", "Close");
  close.type = "button";
  close.autofocus = true;
  close.addEventListener("click", () => closeExpandedTable());
  header.append(close);
  const message = create("div", "message");
  const body = create("div", "body");
  const viewport = create("div", "table-viewport");
  const scroller = create("div", "table-scroll");
  scroller.setAttribute("role", "region");
  scroller.setAttribute("aria-label", "Expanded table. Scroll to read more.");
  viewport.append(scroller);
  body.append(viewport);
  message.append(body);
  dialog.append(header, message);
  dialog.addEventListener("close", () => {
    const previous = expanded;
    expanded = null;
    scroller.replaceChildren();
    if (previous?.restoreFocus) {
      previous.root.querySelectorAll(".table-expand")[previous.index]?.focus({ preventScroll: true });
    }
  });
  document.body.append(dialog);
}

function syncExpandedTable(root) {
  if (!expanded || expanded.root !== root) return;
  const panel = root.querySelectorAll(".chat-table")[expanded.index];
  if (!panel) {
    if (!root.querySelector(".math-pending")) closeExpandedTable();
    return;
  }
  const scroller = dialog.querySelector(".table-scroll");
  const { scrollLeft, scrollTop } = scroller;
  const focusedLink = [...scroller.querySelectorAll("a")].indexOf(document.activeElement);
  scroller.replaceChildren(panel.querySelector("table").cloneNode(true));
  scroller.scrollLeft = scrollLeft;
  scroller.scrollTop = scrollTop;
  if (focusedLink >= 0) scroller.querySelectorAll("a")[focusedLink]?.focus({ preventScroll: true });
  observe(scroller);
  updateOverflow(scroller);
}

function openExpandedTable(panel) {
  if (!dialog) createDialog();
  const root = panel.closest(".body");
  if (!root) return;
  expanded = { root, index: [...root.querySelectorAll(".chat-table")].indexOf(panel), restoreFocus: true };
  dialog.showModal();
  syncExpandedTable(root);
  const scroller = dialog.querySelector(".table-scroll");
  scroller.scrollLeft = panel.querySelector(".table-scroll").scrollLeft;
  scroller.scrollTop = 0;
  updateOverflow(scroller);
}

export function closeExpandedTable(restoreFocus = true) {
  if (!expanded) return;
  expanded.restoreFocus = restoreFocus;
  dialog.close();
}

export function isTableExpanded() {
  return Boolean(dialog?.open);
}

// Preserve horizontal reading position and keyboard focus across streamed renders.
export function replaceTableContent(root, update) {
  const scrollers = [...root.querySelectorAll(".table-scroll")];
  const focused = document.activeElement;
  if (scrollers.length || !pendingState.has(root)) pendingState.set(root, scrollers.map(scroller => ({
    left: scroller.scrollLeft,
    focus: focused === scroller ? ".table-scroll"
      : focused === scroller.closest(".chat-table").querySelector(".table-expand") ? ".table-expand" : null,
  })));
  update();
  restoreTableContent(root);
}

export function restoreTableContent(root) {
  const previous = pendingState.get(root) || [];
  root.querySelectorAll(".chat-table").forEach((panel, index) => {
    const scroller = panel.querySelector(".table-scroll");
    observe(scroller);
    if (previous[index]) {
      scroller.scrollLeft = previous[index].left;
      if (previous[index].focus) panel.querySelector(previous[index].focus)?.focus({ preventScroll: true });
    }
    updateOverflow(scroller);
  });
  if (!root.querySelector(".math-pending")) pendingState.delete(root);
  syncExpandedTable(root);
}
