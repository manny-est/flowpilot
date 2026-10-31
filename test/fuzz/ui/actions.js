"use strict";

const fs = require("fs");
const path = require("path");

const PROMPTS = JSON.parse(fs.readFileSync(path.join(__dirname, "prompts.json"), "utf8"));

function hashSeed(seed) {
  const text = String(seed);
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function createRng(seed) {
  let value = hashSeed(seed);
  return function next() {
    value = (value + 0x6D2B79F5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function visibleCount(state, key) {
  return Number.isFinite(Number(state && state[key])) ? Number(state[key]) : 0;
}

function available(state, key) {
  return !state || state[key] === undefined || !!state[key];
}

function always() { return true; }

function action(name, precondition, run) {
  return { name, precondition, do: run };
}

const ACTIONS = [
  action("type-and-send", state => available(state, "canSend"), async (driver, state, rng) => {
    const prompt = PROMPTS[Math.floor(rng() * PROMPTS.length)];
    await driver.typeAndSend(prompt.text);
    return { prompt: prompt.id };
  }),
  action("enter-while-busy", state => !!(state && state.busy), async driver => {
    await driver.press("Enter");
  }),
  action("stop", state => !!(state && state.busy), async driver => {
    await driver.click("#fp-root button.fp-working-stop");
  }),
  action("clear", always, async driver => {
    await driver.click("#fp-clear-chat");
  }),
  action("escape", always, async driver => {
    await driver.press("Escape");
  }),
  action("approve", state => visibleCount(state, "approve") > 0, async driver => {
    await driver.click("#fp-messages button[data-fp-record-action=propose-act]:not(:disabled)");
  }),
  action("skip", state => visibleCount(state, "proceed") > 0, async driver => {
    await driver.click("#fp-messages button[data-fp-record-action=skip]:not(:disabled)");
  }),
  action("proceed", state => visibleCount(state, "proceed") > 0, async driver => {
    await driver.click("#fp-messages button[data-fp-record-action=proceed]:not(:disabled)");
  }),
  action("keep-going", state => visibleCount(state, "keep") > 0, async driver => {
    await driver.click("#fp-messages button[data-fp-record-action=keep]:not(:disabled)");
  }),
  action("undo", state => visibleCount(state, "undo") > 0, async driver => {
    await driver.click("#fp-messages button[data-fp-record-action=result-undo]:not(:disabled)");
  }),
  action("picker-option", state => visibleCount(state, "options") > 0, async (driver, state, rng) => {
    const count = visibleCount(state, "options");
    await driver.click("#fp-messages button.fp-question-option:nth-of-type(" + (1 + Math.floor(rng() * Math.max(1, count))) + "):not(:disabled)");
  }),
  action("queue-do-it-after", state => !!(state && state.busy && state.queued), async driver => {
    await driver.click("#fp-messages button[data-fp-record-action=continue]:not(:disabled)");
  }),
  action("queue-stop-and-do-this-instead", state => !!(state && state.busy && state.queued), async driver => {
    await driver.click("#fp-messages button[data-fp-record-action=stop]:not(:disabled)");
  }),
  action("reload", always, async driver => {
    await driver.reload();
  }),
  action("switch-provider", (state, context) => !!(context && context.allowProviderSwitch && available(state, "hasProviderChoice")), async driver => {
    await driver.chooseNextProvider();
  }),
  action("toggle-auto", always, async driver => {
    await driver.click("#fp-auto-toggle");
  }),
  action("toggle-restricted", always, async driver => {
    await driver.click("#fp-show-settings");
    await driver.click("#fp-restricted-toggle");
    await driver.click("#fp-save-settings");
  }),
  action("open-popout", state => !state || !state.popoutOpen, async driver => {
    await driver.click("#fp-popout");
  }),
  action("close-popout", state => !!(state && state.popoutOpen), async driver => {
    await driver.closePopout();
  }),
  action("resize-popout", state => !!(state && state.popoutOpen), async (driver, state, rng) => {
    const width = rng() < 0.5 ? 300 : 500;
    await driver.resize(width, 640);
  }),
  action("select-nodes", always, async driver => {
    await driver.evaluate("() => { if (RED.view && RED.view.selectAll) { RED.view.selectAll(); } return true; }");
  }),
  action("deselect-nodes", always, async driver => {
    await driver.evaluate("() => { if (RED.view && RED.view.select) { RED.view.select(null); } return true; }");
  }),
  action("add-fixture-flow", always, async (driver, state, rng, context) => {
    await driver.addFixture(context.fixtures[Math.floor(rng() * context.fixtures.length)]);
  }),
  action("switch-tabs", always, async driver => {
    await driver.switchEditorTab();
  })
];

const ACTION_NAMES = ACTIONS.map(item => item.name);

function chooseActions(options) {
  const opts = options || {};
  const rng = createRng(opts.seed === undefined ? 1 : opts.seed);
  const length = Number.isInteger(opts.length) ? opts.length : 25;
  const state = opts.state || {};
  const context = opts.context || {};
  const result = [];
  for (let i = 0; i < length; i += 1) {
    const candidates = ACTIONS.filter(item => {
      try { return item.precondition(state, context); } catch (error) { return false; }
    });
    const pool = candidates.length ? candidates : [ACTIONS[3]];
    result.push(pool[Math.floor(rng() * pool.length)]);
  }
  return result;
}

module.exports = {
  ACTIONS,
  ACTION_NAMES,
  PROMPTS,
  chooseActions,
  createRng
};
