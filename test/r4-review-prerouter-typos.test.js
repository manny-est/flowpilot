"use strict";
// Prompt fuzzer finding (typo-06): "Rmove Second output" got the intent picker.
const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@node-red/registry") { return {}; }
  return originalLoad.call(this, request, parent, isMain);
};
const flowPilotRuntime = require("../flowpilot.js");
const route = flowPilotRuntime.runDeterministicPreRouter;
const ctx = { nodes: [{ id: "d", type: "debug", name: "Second output" }] };
function action(prompt) { const r = route(prompt, ctx); return r && r.toolCalls ? JSON.parse(r.toolCalls[0].function.arguments).action : null; }
test("a one-letter typo in the leading verb still routes", () => {
  ["Rmove Second output", "renmae this to Beta", "delte this node", "Remvoe the debug"].forEach(p =>
    assert.equal(action(p), "modify", p));
});
test("real words one substitution away are not verbs", () => {
  ["Invert the logic of this", "Remote control: how does it work?"].forEach(p =>
    assert.notEqual(action(p), "modify", p));
});
