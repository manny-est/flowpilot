"use strict";

const assert = require("assert");
const { test } = require("node:test");

const {
  ACTION_NAMES,
  chooseActions,
  createRng
} = require("./fuzz/ui/actions");
const {
  INVARIANT_NAMES,
  evaluateInPage
} = require("./fuzz/ui/invariants");
const { shrinkActions } = require("./fuzz/ui/shrink");
const { formatResultLine } = require("./fuzz/ui/run");
const { buildCoreScript } = require("../lib/build-core-script");

function fakeElement(options) {
  const opts = options || {};
  return {
    disabled: !!opts.disabled,
    offsetParent: opts.visible === false ? null : {},
    innerText: opts.text || "",
    textContent: opts.text || "",
    placeholder: opts.placeholder || "",
    classList: {
      contains: name => (opts.classes || []).indexOf(name) !== -1
    },
    getAttribute: name => (opts.attributes || {})[name] || null,
    dataset: opts.dataset || {}
  };
}

function fakeDocument(options) {
  const opts = options || {};
  const elements = opts.elements || {};
  return {
    getElementById: id => elements["#" + id] || null,
    querySelector: selector => elements[selector] || null,
    querySelectorAll: selector => elements[selector] || [],
    documentElement: { classList: { contains: () => false } }
  };
}

function pageFor(overrides) {
  const clean = {
    document: fakeDocument({
      elements: {
        "#fp-send": fakeElement(),
        "#fp-prompt": fakeElement({ placeholder: "Select nodes for context, or just type a question…" }),
        "#fp-working-status": fakeElement({ visible: false }),
        "#fp-messages": fakeElement({ text: "All set" }),
        "#fp-messages > *": []
      }
    }),
    RED: {
      nodes: {
        workspace: { id: "tab-1" },
        filterNodes: () => [{ id: "node-1", x: 100, y: 100, w: 100, h: 30, valid: true }]
      }
    },
    consoleErrors: [],
    touchedNodeIds: ["node-1"],
    deployedFlows: [{ id: "node-1", z: "tab-1" }],
    cards: [],
    messages: [{ id: "m1", text: "All set" }],
    popoutMessages: [{ id: "m1", text: "All set" }],
    reloadMessages: [{ id: "m1", text: "All set" }],
    afterReload: true
  };
  return Object.assign(clean, overrides || {});
}

test("the seeded action pool is deterministic and covers the ticket actions", () => {
  const first = chooseActions({ seed: 104729, length: 80 }).map(action => action.name);
  const second = chooseActions({ seed: 104729, length: 80 }).map(action => action.name);
  assert.deepStrictEqual(first, second);
  assert.ok(ACTION_NAMES.includes("type-and-send"));
  assert.ok(ACTION_NAMES.includes("queue-do-it-after"));
  assert.ok(ACTION_NAMES.includes("open-popout"));
  assert.ok(ACTION_NAMES.includes("add-fixture-flow"));
  assert.strictEqual(createRng(7)(), createRng(7)());
});

test("the shrinker finds the shortest failing subsequence", async () => {
  const actions = ["noise-a", "noise-b", "bad", "noise-c", "noise-d"];
  const result = await shrinkActions(actions, candidate => candidate.includes("bad"));
  assert.deepStrictEqual(result, ["bad"]);
});

test("every invariant is quiet for a clean fake page", async () => {
  const result = await evaluateInPage({}, pageFor());
  assert.deepStrictEqual(result.violations, []);
  assert.deepStrictEqual(Object.keys(result.evidence).sort(), INVARIANT_NAMES.slice().sort());
});

test("the invariants report a canned bad fake DOM and RED state", async () => {
  const bad = pageFor({
    document: fakeDocument({
      elements: {
        "#fp-send": fakeElement({ disabled: true }),
        "#fp-prompt": fakeElement({ placeholder: "working" }),
        "#fp-working-status": fakeElement({ text: "working" }),
        "#fp-messages": fakeElement({ text: "<div>{\"stack\":\"Error: boom\"}</div>" }),
        "#fp-messages > *": [
          fakeElement({ attributes: { "data-fp-record-id": "m1" }, text: "same" }),
          fakeElement({ attributes: { "data-fp-record-id": "m1" }, text: "same" })
        ],
        "#fp-messages button[data-fp-record-action]": [fakeElement({ disabled: false, text: "approved ✓", attributes: { "data-fp-state": "approved" } })]
      }
    }),
    consoleErrors: ["FlowPilot exploded"],
    cards: [{ nodeIds: ["missing-node"], deployed: true }],
    deployedFlows: [],
    messages: [{ id: "m1", text: "same" }, { id: "m1", text: "same" }, { id: "m-bad", text: "<div>{\"stack\":\"Error: boom\"}</div>" }],
    popoutMessages: [{ id: "other", text: "different" }],
    reloadMessages: [{ id: "old", text: "different" }],
    touchedNodeIds: ["node-1", "node-2"],
    RED: {
      nodes: {
        workspace: { id: "tab-1" },
        filterNodes: () => [
          { id: "node-1", x: 100, y: 100, w: 100, h: 30, valid: false },
          { id: "node-2", x: 100, y: 100, w: 100, h: 30, valid: true }
        ]
      }
    },
    afterReload: true
  });
  const result = await evaluateInPage({ afterReload: true }, bad);
  assert.ok(result.violations.length >= 8);
  ["idle-controls", "console-errors", "chat-safety", "live-controls",
    "cards-agree-with-canvas", "no-overlapping-nodes", "no-duplicates",
    "popout-conversation", "reload-restores", "touched-nodes-valid"].forEach(name => {
    assert.ok(result.violations.some(violation => violation.invariant === name), name);
  });
});

test("the result line has the required stable format and the client bundle still assembles", () => {
  const line = formatResultLine("gpt-4.1", "nrt", 2, 16, 0, {
    "idle-controls": 0,
    "console-errors": 0
  });
  assert.strictEqual(line, "UI-FUZZ RESULT: gpt-4.1 nrt sequences 2 · actions 16 · violations 0 · by invariant {\"idle-controls\":0,\"console-errors\":0}");
  assert.ok(buildCoreScript().includes("FlowPilotCore"));
});
