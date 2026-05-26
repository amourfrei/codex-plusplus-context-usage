const ROOT_ATTR = "data-codexpp-context-usage";
const STYLE_ID = "codexpp-context-usage-style";
const IPC_GET = "context-usage:get";
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const TIP_TIMEOUT_MS = 5000;
const MAIN_SERVICE_KEY = "__codexppContextUsageService";
const MAIN_HANDLER_KEY = "__codexppContextUsageHandler";

module.exports = {
  start(api) {
    if (api.process === "main") {
      startMain(api);
      return;
    }
    startRenderer(this, api);
  },

  stop() {
    if (this._contextUsageRenderer) stopRenderer.call(this);
    if (globalThis[MAIN_SERVICE_KEY]) globalThis[MAIN_SERVICE_KEY] = null;
  },

  startRenderer,
  stopRenderer,
  _internals: {
    parseLatestTokenCount,
    presentationFor,
    contextPercent,
    findThreadId,
    readLatestSnapshot,
  },
};

function startMain(api) {
  globalThis[MAIN_SERVICE_KEY] = {
    read(payload) {
      return readLatestSnapshot(payload || {});
    },
  };
  if (!globalThis[MAIN_HANDLER_KEY]) {
    api.ipc.handle(IPC_GET, (payload = {}) => {
      return globalThis[MAIN_SERVICE_KEY]?.read(payload) || null;
    });
    globalThis[MAIN_HANDLER_KEY] = true;
  }
  api.log.info("[context-usage] main provider active");
}

function readLatestSnapshot(payload, roots) {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const threadId = String(payload?.threadId || "").match(UUID_RE)?.[0] || "";
  const turnIds = Array.isArray(payload?.turnIds)
    ? payload.turnIds.map((id) => String(id || "")).filter((id) => UUID_RE.test(id))
    : [];
  if (!threadId && turnIds.length === 0) return null;
  const searchRoots = roots || [
    path.join(os.homedir(), ".codex", "sessions"),
    path.join(os.homedir(), ".codex", "archived_sessions"),
  ];
  const candidates = [];
  for (const root of searchRoots) collectJsonlFiles(fs, path, root, candidates);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const named = threadId
    ? candidates.filter((item) => item.path.includes(threadId))
    : [];
  const files = named.length ? named : candidates.slice(0, 120);
  for (const item of files) {
    let text;
    try {
      text = fs.readFileSync(item.path, "utf8");
    } catch {
      continue;
    }
    if (threadId && named.length === 0 && !text.includes(`"id":"${threadId}"`)) continue;
    if (!threadId && turnIds.length && !turnIds.some((turnId) => text.includes(turnId))) continue;
    const snapshot = parseLatestTokenCount(text);
    if (snapshot) return snapshot;
  }
  return null;
}

function collectJsonlFiles(fs, path, directory, out) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(fs, path, file, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        out.push({ path: file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {}
    }
  }
}

function parseLatestTokenCount(text) {
  let latest = null;
  for (const line of String(text || "").split("\n")) {
    if (!line.includes('"token_count"')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.payload?.type === "token_count") latest = row.payload;
  }
  if (!latest) return null;
  const info = latest.info || {};
  const rates = latest.rate_limits || {};
  return {
    contextPct: contextPercent(
      info.last_token_usage?.input_tokens,
      info.model_context_window,
    ),
    fiveHourPct: percentForWindow(rates, 300),
    weeklyPct: percentForWindow(rates, 10080),
  };
}

function contextPercent(inputTokens, windowTokens) {
  const used = Number(inputTokens);
  const max = Number(windowTokens);
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / max) * 100)));
}

function percentForWindow(rateLimits, windowMinutes) {
  for (const entry of Object.values(rateLimits || {})) {
    if (!entry || typeof entry !== "object") continue;
    if (Number(entry.window_minutes) !== windowMinutes) continue;
    const value = Number(entry.used_percent);
    if (Number.isFinite(value)) return Math.max(0, Math.min(100, Math.round(value)));
  }
  return null;
}

function presentationFor(snapshot = {}) {
  const contextPct = numberOrNull(snapshot.contextPct);
  const fiveHourPct = numberOrNull(snapshot.fiveHourPct);
  const weeklyPct = numberOrNull(snapshot.weeklyPct);
  const context = contextPct > 41 ? "danger" : contextPct > 21 ? "warning" : "normal";
  return {
    context,
    fiveHour: fiveHourPct > 88 ? "danger" : "normal",
    weekly: weeklyPct > 88 ? "danger" : "normal",
    showCompactTip: context === "danger",
  };
}

function startRenderer(host, api, options = {}) {
  stopRenderer.call(host);
  const state = {
    api,
    disposed: false,
    root: null,
    style: installStyle(),
    refreshTimer: null,
    scanTimer: null,
    observer: null,
    tipTimer: null,
    tipShownForCurrentDanger: false,
    wasDanger: false,
    loggedMount: false,
    tipTimeoutMs: Number(options.tipTimeoutMs) || TIP_TIMEOUT_MS,
  };
  host._contextUsageRenderer = state;

  state.observer = new MutationObserver(() => scheduleRefresh(state));
  state.observer.observe(document.body, { childList: true, subtree: true });
  state.refreshTimer = window.setInterval(() => void refreshRenderer(state), 2500);
  void refreshRenderer(state);
  return state;
}

function stopRenderer() {
  const state = this._contextUsageRenderer;
  if (!state) return;
  state.disposed = true;
  state.observer?.disconnect();
  if (state.scanTimer) window.clearTimeout(state.scanTimer);
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  dismissTip(state);
  state.root?.remove();
  state.style?.remove();
  this._contextUsageRenderer = null;
}

function scheduleRefresh(state) {
  if (state.disposed || state.scanTimer) return;
  state.scanTimer = window.setTimeout(() => {
    state.scanTimer = null;
    void refreshRenderer(state);
  }, 80);
}

async function refreshRenderer(state) {
  if (state.disposed) return;
  const payload = {
    threadId: findThreadId(),
    turnIds: Array.from(document.querySelectorAll("[data-turn-key]"))
      .map((node) => node.getAttribute("data-turn-key"))
      .filter(Boolean),
  };
  let snapshot = null;
  try {
    snapshot = await state.api.ipc.invoke(IPC_GET, payload);
  } catch (error) {
    state.api.log.warn("[context-usage] unable to load usage", error);
  }
  if (state.disposed) return;
  renderMetrics(state, snapshot || {});
}

function findThreadId() {
  const route = `${window.location.pathname} ${window.location.hash} ${window.location.search}`;
  const fromRoute = route.match(UUID_RE)?.[0];
  if (fromRoute) return fromRoute;
  return document
    .querySelector('[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]')
    ?.getAttribute("data-app-action-sidebar-thread-id")
    ?.match(UUID_RE)?.[0] || null;
}

function renderMetrics(state, snapshot) {
  const slot = findComposerFooterSlot();
  if (!slot) return;
  let root = state.root;
  if (!root) {
    root = document.createElement("div");
    root.setAttribute(ROOT_ATTR, "metrics");
    root.className = "relative flex min-w-0 items-center text-sm text-token-text-tertiary";
    state.root = root;
  }
  if (root.parentElement !== slot) slot.append(root);
  const presentation = presentationFor(snapshot);
  const renderKey = JSON.stringify({
    contextPct: snapshot.contextPct ?? null,
    fiveHourPct: snapshot.fiveHourPct ?? null,
    weeklyPct: snapshot.weeklyPct ?? null,
    presentation,
  });
  if (root.dataset.renderKey !== renderKey) {
    const openTip = root.querySelector(`[${ROOT_ATTR}="tip"]`);
    root.replaceChildren(
      separator(),
      metric("Context", snapshot.contextPct, presentation.context, true),
      separator(),
      metric("5h", snapshot.fiveHourPct, presentation.fiveHour),
      separator(),
      metric("Weekly", snapshot.weeklyPct, presentation.weekly),
    );
    if (openTip) root.querySelector(`[${ROOT_ATTR}="context"]`)?.append(openTip);
    root.dataset.renderKey = renderKey;
  }
  const danger = presentation.showCompactTip;
  if (!danger) {
    dismissTip(state);
    state.tipShownForCurrentDanger = false;
  } else if (!state.wasDanger && !state.tipShownForCurrentDanger) {
    showCompactTip(state, root.querySelector(`[${ROOT_ATTR}="context"]`));
    state.tipShownForCurrentDanger = true;
  }
  state.wasDanger = danger;
  if (!state.loggedMount) {
    state.loggedMount = true;
    state.api.log.info("[context-usage] mounted composer footer", {
      contextPct: snapshot.contextPct ?? null,
      fiveHourPct: snapshot.fiveHourPct ?? null,
      weeklyPct: snapshot.weeklyPct ?? null,
      tipVisible: Boolean(root.querySelector(`[${ROOT_ATTR}="tip"]`)),
    });
  }
}

function separator() {
  const node = document.createElement("span");
  node.setAttribute(ROOT_ATTR, "separator");
  node.className = "mx-3 h-5 w-px shrink-0 bg-token-border";
  node.setAttribute("aria-hidden", "true");
  return node;
}

function metric(label, value, state, isContext = false) {
  const node = document.createElement("span");
  node.className = "relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap";
  if (isContext) node.setAttribute(ROOT_ATTR, "context");
  const key = document.createElement("span");
  key.textContent = label;
  const number = document.createElement("span");
  number.className =
    "tabular-nums " +
    (state === "danger"
      ? "text-token-charts-red"
      : state === "warning"
        ? "text-token-charts-yellow"
        : "text-token-text-tertiary");
  number.textContent = formatPercent(value);
  node.append(key, number);
  return node;
}

function showCompactTip(state, anchor) {
  if (!(anchor instanceof HTMLElement)) return;
  dismissTip(state);
  const tip = document.createElement("div");
  tip.setAttribute(ROOT_ATTR, "tip");
  tip.dataset.anchor = "context";
  tip.className =
    "absolute bottom-[calc(100%+16px)] left-1/2 z-50 flex -translate-x-1/2 items-center " +
    "gap-3 whitespace-nowrap rounded-xl border border-token-border bg-token-bg-primary " +
    "px-4 py-2.5 text-sm text-token-text-secondary shadow-sm";

  const action = document.createElement("button");
  action.type = "button";
  action.setAttribute(ROOT_ATTR, "tip-action");
  action.className = "cursor-interaction text-token-text-secondary";
  action.append("Consider ");
  const command = document.createElement("span");
  command.className = "text-token-charts-red";
  command.textContent = "/compact";
  action.append(command, " to reduce context");
  action.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dismissTip(state);
    submitCompactCommand();
  });

  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute(ROOT_ATTR, "tip-close");
  close.className = "cursor-interaction text-token-text-tertiary";
  close.setAttribute("aria-label", "Dismiss compact suggestion");
  close.textContent = "\u00d7";
  close.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dismissTip(state);
  });

  const arrow = document.createElement("span");
  arrow.setAttribute(ROOT_ATTR, "tip-arrow");
  arrow.setAttribute("aria-hidden", "true");
  tip.append(action, close, arrow);
  anchor.append(tip);
  state.api.log.info("[context-usage] compact suggestion shown", {
    timeoutMs: state.tipTimeoutMs,
  });
  state.tipTimer = window.setTimeout(() => dismissTip(state), state.tipTimeoutMs);
}

function dismissTip(state) {
  if (state.tipTimer) window.clearTimeout(state.tipTimer);
  state.tipTimer = null;
  document.querySelectorAll(`[${ROOT_ATTR}="tip"]`).forEach((tip) => tip.remove());
}

function submitCompactCommand() {
  const input = findComposerInput();
  if (!input) return false;
  setComposerText(input, "/compact");
  const button = findComposerSendButton();
  if (button) {
    button.click();
    return true;
  }
  const form = input.closest("form");
  if (form && typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return true;
  }
  return false;
}

function findComposerFooterSlot() {
  const footer = Array.from(document.querySelectorAll(".composer-footer"))
    .find((node) => node instanceof HTMLElement);
  if (!footer) return null;
  let slot = footer.children[1];
  if (!(slot instanceof HTMLElement)) {
    slot = document.createElement("div");
    footer.insertBefore(slot, footer.children[1] || null);
  }
  return slot;
}

function findComposerInput() {
  return Array.from(document.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']"))
    .find((node) => node instanceof HTMLElement) || null;
}

function findComposerSendButton() {
  const buttons = Array.from(document.querySelectorAll(".composer-footer button"));
  return buttons.find((button) => String(button.className || "").includes("bg-token-foreground")) ||
    buttons[buttons.length - 1] ||
    null;
}

function setComposerText(input, text) {
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    input.value = text;
  } else {
    input.textContent = text;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function installStyle() {
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    [${ROOT_ATTR}="tip-arrow"] {
      position: absolute;
      left: 50%;
      bottom: -6px;
      width: 11px;
      height: 11px;
      transform: translateX(-50%) rotate(45deg);
      border-right: 1px solid var(--color-token-border);
      border-bottom: 1px solid var(--color-token-border);
      background: var(--color-token-bg-primary, var(--color-token-bg-fog));
    }
  `;
  document.head.appendChild(style);
  return style;
}

function formatPercent(value) {
  const number = numberOrNull(value);
  return number == null ? "\u2014" : `${number}%`;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
