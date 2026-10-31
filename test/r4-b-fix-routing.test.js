"use strict";

const assert = require("assert");
const fs = require("fs");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@node-red/registry") { return {}; }
  return originalLoad.call(this, request, parent, isMain);
};

const runtime = require("../flowpilot.js");
const intake = require("../lib/core/intake");
const tierPrompt = require("../lib/tier-c-classification-prompt");
const modesSource = fs.readFileSync(require.resolve("../lib/core/modes.js"), "utf8");

function proposalArgs(result) {
  assert.ok(result && result.toolCalls && result.toolCalls.length === 1, "one pre-router proposal");
  assert.strictEqual(result.toolCalls[0].function.name, "propose_action");
  return JSON.parse(result.toolCalls[0].function.arguments);
}

const selectedFunction = { nodes: [{ id: "fn-1", type: "function", name: "Upper" }] };
[
  "Fix the bug in this function",
  "fix this",
  "debug this",
  "repair it",
  "why doesn't this work?",
  "this is broken, fix it"
].forEach(function (prompt) {
  const args = proposalArgs(runtime.runDeterministicPreRouter(prompt, selectedFunction));
  assert.strictEqual(args.action, "modify", prompt + " routes to modify");
  assert.deepStrictEqual(args.targets, ["fn-1"], prompt + " keeps the selection");
  assert.strictEqual(args.needs_selection, false, prompt + " does not ask for a picker");
});

[
  "Fix the bug in this function",
  "fix this",
  "debug this",
  "repair it",
  "why doesn't this work?",
  "this is broken, fix it"
].forEach(function (prompt) {
  assert.strictEqual(runtime.runDeterministicPreRouter(prompt, { nodes: [] }), null,
    prompt + " is not forced to modify without a selection");
});
assert.strictEqual(runtime.runDeterministicPreRouter(
  "why does this node use a switch?", selectedFunction
), null, "explanation questions stay out of modify");

assert.match(tierPrompt, /Fix the bug in this function[\s\S]*Assistant:\s*\nC/);
assert.match(tierPrompt, /Why doesn't this work\?[\s\S]*Assistant:\s*\nC/);
assert.match(tierPrompt, /User: "debug this"[\s\S]*Assistant:\s*\nC/);
assert.doesNotMatch(tierPrompt, /A selected node does not turn a vague request into an action/);

const tabs = {
  active: { id: "tab-active", label: "Active" },
  one: { id: "tab-one", label: "One" },
  two: { id: "tab-two", label: "Two" }
};
const allNodes = [
  { id: "process-one", type: "function", name: "Process", z: tabs.one.id },
  { id: "process-two", type: "function", name: "Process", z: tabs.two.id }
];
global.RED = {
  nodes: {
    eachNode: function (callback) { allNodes.forEach(callback); },
    workspace: function (id) { return Object.keys(tabs).map(function (key) { return tabs[key]; }).find(function (tab) { return tab.id === id; }) || null; }
  }
};
const ambiguous = intake.buildIntake("Rename Process to Formatter", {}, { activeTab: tabs.active });
assert.strictEqual(ambiguous.target.kind, "unresolved", "same name across tabs is ambiguous");
assert.deepStrictEqual(ambiguous.candidates.map(function (node) { return node.id; }).sort(),
  ["process-one", "process-two"], "picker includes same-name candidates from every tab");

allNodes.push({ id: "process-active", type: "function", name: "Process", z: tabs.active.id });
const activeWins = intake.buildIntake("Rename Process to Formatter", {}, { activeTab: tabs.active });
assert.strictEqual(activeWins.target.kind, "named", "active tab settles a duplicate name");
assert.deepStrictEqual(activeWins.target.ids, ["process-active"], "active-tab match wins");
assert.strictEqual(runtime.runDeterministicPreRouter("Make the Process node fire now", {
  activeTabId: tabs.active.id,
  openTabNodes: ambiguous.candidates
}), null, "pre-router leaves duplicate off-tab names for the picker");
const preRouterActive = runtime.runDeterministicPreRouter("Make the Process node fire now", {
  activeTabId: tabs.active.id,
  openTabNodes: activeWins.allCandidates
});
assert.deepStrictEqual(proposalArgs(preRouterActive).targets, ["process-active"],
  "pre-router uses the one active-tab match");

delete global.RED;

// Spark S2 regression: a successful WRITE followed by redirect_mode must still
// finish through the normal result-card path, with a fallback item for a
// direct one-write turn and the existing Undo control.
const redirectStart = modesSource.indexOf('if (name === "redirect_mode")');
const redirectEnd = modesSource.indexOf('if (name === "propose_action")', redirectStart);
assert.ok(redirectStart >= 0 && redirectEnd > redirectStart, "redirect branch exists");
assert.match(modesSource.slice(redirectStart, redirectEnd), /agentWriteResults\.length[\s\S]*completeRun/,
  "redirect preserves completed WRITE results");
assert.match(modesSource, /if \(writeResults\.length && !planItems\.length\)[\s\S]{0,500}writeResults\.map/,
  "direct writes get a result-card plan item");
assert.match(modesSource, /data-fp-record-action", "result-undo"/,
  "result card retains the Undo action");

console.log("R4-B fix-routing regression tests passed");
