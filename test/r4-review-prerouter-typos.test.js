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

test("acknowledgements and 'no changes' replies are small talk; requests are not", () => {
  const isSmallTalk = flowPilotRuntime.isSmallTalk || null;
  if (!isSmallTalk) { return; }
  ["Thanks, that looks good.", "Okay, no changes for now.", "Please do not change anything; just say hello.", "Good morning.", "never mind", "Great, that's all"].forEach(p =>
    assert.equal(isSmallTalk(p), true, p));
  ["Thanks, now add a debug node", "Okay, rename it to Beta", "Great, can you explain this flow?", "Looks good, deploy it", "ok fix the bug"].forEach(p =>
    assert.equal(isSmallTalk(p), false, p));
});
