"use strict";

const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@node-red/registry") {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const flowPilotRuntime = require("../flowpilot.js");
const cases = require("./routing-corpus/routing-cases.json");

const runDeterministicPreRouter = flowPilotRuntime.runDeterministicPreRouter;

assert.strictEqual(typeof runDeterministicPreRouter, "function", "pre-router export");

const expectedPreRouter = {
  "generate-basic-flow": { action: "generate", needs_selection: false },
  "generate-http-poll": { action: "generate", needs_selection: false },
  "generate-mqtt": { action: "generate", needs_selection: false },
  "generate-transform": { action: "generate", needs_selection: false },
  "generate-webhook": { action: "generate", needs_selection: false },
  "generate-dashboard": { action: "generate", needs_selection: false },
  "modify-rename-selected": { action: "modify", needs_selection: true },
  "modify-rename-selected-with-selection": { action: "modify", needs_selection: false },
  "modify-add-debug-after-current": { action: "modify", needs_selection: true },
  "modify-rewire": { action: "modify", needs_selection: true },
  "modify-remove-unused": { action: "modify", needs_selection: true },
  "modify-function-code": { action: "modify", needs_selection: true },
  "modify-insert-delay": { action: "modify", needs_selection: true }
};

const namedTrapResults = {};

function parsePreRouterArgs(result) {
  assert.ok(result && Array.isArray(result.toolCalls), "result has toolCalls");
  assert.strictEqual(result.toolCalls.length, 1, "one tool call");
  const call = result.toolCalls[0];
  assert.ok(/^prerouter-\d+$/.test(call.id), "pre-router call id");
  assert.strictEqual(call.function && call.function.name, "propose_action", "tool name");
  return JSON.parse(call.function.arguments);
}

cases.forEach(function (testCase) {
  const result = runDeterministicPreRouter(testCase.prompt, testCase.context || {});
  const expected = expectedPreRouter[testCase.id] || null;

  if (expected) {
    const args = parsePreRouterArgs(result);
    assert.strictEqual(args.action, expected.action, testCase.id + ": action");
    assert.strictEqual(args.needs_selection, expected.needs_selection, testCase.id + ": needs_selection");
    assert.strictEqual(args.confidence, "high", testCase.id + ": confidence");
    assert.deepStrictEqual(Array.isArray(args.plan_items) ? args.plan_items : [], [], testCase.id + ": plan_items");
    if (expected.needs_selection) {
      assert.deepStrictEqual(args.targets, [], testCase.id + ": targets");
    }
  } else {
    assert.strictEqual(result, null, testCase.id + ": should fall through");
  }

  if ([
    "answer-how-add-switch",
    "clarify-add-something",
    "clarify-selection-needed",
    "document-subflow"
  ].indexOf(testCase.id) !== -1) {
    namedTrapResults[testCase.id] = result === null ? "null" : "decided";
  }
});

assert.deepStrictEqual(namedTrapResults, {
  "answer-how-add-switch": "null",
  "clarify-add-something": "null",
  "clarify-selection-needed": "null",
  "document-subflow": "null"
}, "named trap prompts");

console.log("deterministic pre-router tests passed (" + cases.length + " cases)");
console.log("answer-how-add-switch: " + namedTrapResults["answer-how-add-switch"]);
console.log("clarify-add-something: " + namedTrapResults["clarify-add-something"]);
console.log("clarify-selection-needed: " + namedTrapResults["clarify-selection-needed"]);
console.log("document-subflow: " + namedTrapResults["document-subflow"]);
