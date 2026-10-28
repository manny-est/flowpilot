"use strict";

const assert = require("assert");
const runner = require("./engine-corpus/runner.js");

const gates = runner.loadGateModules();
assert.strictEqual(typeof gates.consent.decideConsent, "function", "runner loads consent.js via require");
assert.strictEqual(typeof gates.diffGate.diffGateDecision, "function", "runner loads diff-gate.js in vm");

const generateCase = runner.cases.find(function (testCase) {
  return testCase.id === "sf-generate-existing-node";
});
const parts = runner.fixtureParts(generateCase);

function call(name, args) {
  return { id: "canned-" + name, type: "function", function: {
    name: name, arguments: JSON.stringify(args || {})
  } };
}

assert.strictEqual(runner.classifyCannedToolCall(call("ask_user", { question: "Which one?" }), parts, ["n1"]),
  "ask_target", "ask_user is ask_target");
assert.strictEqual(runner.classifyCannedToolCall(call("remove_step", { nodeId: "n3" }), parts, ["n3"]),
  "consent_ask", "delete is consent_ask");
assert.strictEqual(runner.classifyCannedToolCall(call("rename_node", { nodeId: "n4", name: "Timer" }), parts, ["n1"]),
  "diff_gate_pause", "out-of-target edit is diff_gate_pause");
assert.strictEqual(runner.classifyCannedToolCall(call("rename_node", { nodeId: "n1", name: "Timer" }), parts, ["n1"]),
  "write_allowed", "locked safe edit is write_allowed");

console.log("engine-corpus gate-loading tests passed");
