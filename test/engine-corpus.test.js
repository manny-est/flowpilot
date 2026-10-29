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

// The server and browser apply lane routing only to propose_action, so a
// write still goes through consent and the diff gate.
assert.strictEqual(runner.proposalKind(call("propose_action", { action: "modify" }), false, "ASK"),
  "ask_target", "propose_action in the ASK lane is the picker");
assert.strictEqual(runner.proposalKind(call("propose_action", { action: "modify" }), false, "DIRECT"),
  "refused", "propose_action outside ASK without needs_selection is not a picker");

// A passing write is applied to the fixture, and the result carries the
// browser's changeDetails. Like the browser, a repeat write is a successful
// no-op and does not create another change record.
const writeParts = runner.fixtureParts(generateCase);
const rename = call("apply_step", { changes: [{ id: "n1", set: { name: "Timer" } }] });
const first = runner.applyWriteToFixture(rename, writeParts);
assert.deepStrictEqual(first.changeDetails[0].propertyChanges, [{ key: "name", oldVal: "Trigger", newVal: "Timer" }]);
assert.strictEqual(runner.readTool(call("read_node", { id: "n1" }), writeParts, writeParts.context).name, "Timer",
  "read tools see the applied write");
const second = runner.applyWriteToFixture(rename, writeParts);
assert.strictEqual(second.noChange, true);
assert.strictEqual(second.error, "No change: already applied");
assert.strictEqual(generateCase.flow.find(function (n) { return n.id === "n1"; }).name, "Trigger",
  "the case fixture itself is not modified");

console.log("engine-corpus gate-loading tests passed");
