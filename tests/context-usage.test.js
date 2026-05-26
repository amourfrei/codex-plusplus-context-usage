const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const { startRenderer, stopRenderer, _internals } = require("../index.js");

const HIGH_SNAPSHOT = {
  contextPct: 44,
  fiveHourPct: 46,
  weeklyPct: 89,
};

test("parseLatestTokenCount returns context and used-rate percentages from the newest event", () => {
  const lines = [
    tokenLine(54000, 258400, 3, 25),
    tokenLine(113696, 258400, 46, 89),
  ].join("\n");

  assert.deepEqual(_internals.parseLatestTokenCount(lines), HIGH_SNAPSHOT);
});

test("presentation applies context warning levels and usage red threshold", () => {
  assert.deepEqual(_internals.presentationFor({ contextPct: 21, fiveHourPct: 88, weeklyPct: 4 }), {
    context: "normal",
    fiveHour: "normal",
    weekly: "normal",
    showCompactTip: false,
  });
  assert.equal(_internals.presentationFor({ contextPct: 22 }).context, "warning");
  assert.deepEqual(_internals.presentationFor(HIGH_SNAPSHOT), {
    context: "danger",
    fiveHour: "normal",
    weekly: "danger",
    showCompactTip: true,
  });
});

test("renderer mounts metrics in one footer slot with dividers and an anchored tip", async () => {
  const env = mount(HIGH_SNAPSHOT);
  await flush();

  const metrics = env.document.querySelector("[data-codexpp-context-usage='metrics']");
  const tip = env.document.querySelector("[data-codexpp-context-usage='tip']");
  assert.ok(metrics);
  assert.equal(metrics.parentElement.id, "middle");
  assert.equal(metrics.querySelectorAll("[data-codexpp-context-usage='separator']").length, 3);
  assert.match(metrics.textContent, /Context\s*44%/);
  assert.match(metrics.textContent, /5h\s*46%/);
  assert.match(metrics.textContent, /Weekly\s*89%/);
  assert.equal(tip.dataset.anchor, "context");
  assert.match(tip.textContent, /Consider\s*\/compact\s*to reduce context/);
  assert.equal(env.document.querySelector(".composer-footer").children.length, 3);

  teardown(env);
});

test("red-context tip auto-dismisses without submitting compact", async () => {
  const env = mount(HIGH_SNAPSHOT, { tipTimeoutMs: 8 });
  await flush();
  assert.ok(env.document.querySelector("[data-codexpp-context-usage='tip']"));

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(env.document.querySelector("[data-codexpp-context-usage='tip']"), null);
  assert.equal(env.submissions, 0);
  teardown(env);
});

test("an unchanged renderer refresh does not remove an open compact tip early", async () => {
  const env = mount(HIGH_SNAPSHOT, { tipTimeoutMs: 1000 });
  await flush();
  assert.ok(env.document.querySelector("[data-codexpp-context-usage='tip']"));

  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.ok(env.document.querySelector("[data-codexpp-context-usage='tip']"));
  assert.equal(env.submissions, 0);
  teardown(env);
});

test("closing the tip dismisses it without submitting compact", async () => {
  const env = mount(HIGH_SNAPSHOT);
  await flush();

  env.document.querySelector("[data-codexpp-context-usage='tip-close']").click();

  assert.equal(env.document.querySelector("[data-codexpp-context-usage='tip']"), null);
  assert.equal(env.submissions, 0);
  teardown(env);
});

test("clicking the tip submits slash compact exactly once", async () => {
  const env = mount(HIGH_SNAPSHOT);
  await flush();

  env.document.querySelector("[data-codexpp-context-usage='tip-action']").click();

  assert.equal(env.input.value, "/compact");
  assert.equal(env.submissions, 1);
  assert.equal(env.document.querySelector("[data-codexpp-context-usage='tip']"), null);
  teardown(env);
});

function tokenLine(inputTokens, contextWindow, fiveHour, weekly) {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: inputTokens },
        model_context_window: contextWindow,
      },
      rate_limits: {
        primary: { used_percent: fiveHour, window_minutes: 300 },
        secondary: { used_percent: weekly, window_minutes: 10080 },
      },
    },
  });
}

function mount(snapshot, options = {}) {
  const dom = new JSDOM(`
    <form class="composer-form">
      <textarea placeholder="Ask for follow-up changes"></textarea>
      <div class="composer-footer grid">
        <div id="left">Auto-review</div>
        <div id="middle"><span data-codexpp-goal="pill">Goal</span></div>
        <div id="right"><button type="submit" class="bg-token-foreground">Send</button></div>
      </div>
    </form>
  `, { url: "https://codex.local/local/019e622e-57de-7b10-82b0-e48955197491" });
  global.window = dom.window;
  global.document = dom.window.document;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  global.HTMLInputElement = dom.window.HTMLInputElement;
  global.MutationObserver = dom.window.MutationObserver;
  global.Event = dom.window.Event;

  const host = {};
  let submissions = 0;
  const form = dom.window.document.querySelector("form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submissions += 1;
  });
  const api = {
    ipc: { invoke: async () => snapshot },
    log: { warn() {}, info() {} },
  };
  startRenderer(host, api, options);
  return {
    host,
    dom,
    document: dom.window.document,
    input: dom.window.document.querySelector("textarea"),
    get submissions() { return submissions; },
  };
}

function teardown(env) {
  stopRenderer.call(env.host);
  env.dom.window.close();
  delete global.window;
  delete global.document;
  delete global.Element;
  delete global.HTMLElement;
  delete global.HTMLTextAreaElement;
  delete global.HTMLInputElement;
  delete global.MutationObserver;
  delete global.Event;
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
