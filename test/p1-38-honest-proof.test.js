"use strict";

const assert = require("assert");
const proof = require("../lib/core/runtime-proof.js");
const cards = require("../lib/core/cards.js");

function node(id, type, name, outputs) {
  return { id, type, name, outputs };
}
function link(source, target) { return { source: { id: source }, target: { id: target } }; }

// An unwired trigger is not itself proof. The other output-capable nodes are
// not reachable from it, so no goal tap is installed.
const unwired = proof.runtimeGoalObserve([
  node("inject", "inject", "Weather trigger", 1),
  node("fn", "function", "Format weather", 1),
  node("http", "http request", "Fetch weather", 1)
], [], "inject");
assert.deepStrictEqual(unwired.tapNodeIds, []);
assert.strictEqual(unwired.noOutputReason, "Weather trigger isn't wired to anything");
assert.strictEqual(proof.runtimeProofOutcome([], unwired).state, "no-output");
assert.strictEqual(proof.runtimeProofOutcome([], unwired).label, "Ran, but Weather trigger isn't wired to anything");

// inject -> function -> debug: the debug is the path end, but the tap is on
// the incoming function node. A trigger tap or a middle-node tap is not goal
// evidence.
const wiredNodes = [
  node("inject", "inject", "Trigger", 1),
  node("fn", "function", "Format", 1),
  node("debug", "debug", "Output", 0)
];
const wired = proof.runtimeGoalObserve(wiredNodes, [link("inject", "fn"), link("fn", "debug")], "inject");
assert.deepStrictEqual(wired.tapNodeIds, ["fn"]);
assert.deepStrictEqual(wired.debugNodeIds, ["debug"]);
assert.ok(!wired.tapNodeIds.includes("inject"), "the trigger is never a goal tap when wired");
const onlyMiddle = proof.runtimeEvidenceForRun([
  { kind: "debug", nodeId: "middle", value: "WRONG" }
], { fn: true }, {}, {});
assert.deepStrictEqual(onlyMiddle, [], "middle-node evidence is not goal evidence");

const observed = proof.runtimeEvidenceForRun([
  { kind: "debug", nodeId: "fn", node: "Format", value: "HELLO", valueType: "string" }
], { fn: true }, {}, {});
assert.strictEqual(proof.runtimeProofOutcome(observed, wired).label, "Run: observed — HELLO (at Format)");
assert.ok(!/_msgid|\\\"/.test(proof.runtimeProofOutcome(observed, wired).label));
assert.strictEqual(proof.runtimeProofOutcome([
  { kind: "debug", nodeId: "fn", node: "Format", value: { answer: 42 }, valueType: "object" }
], wired).label, 'Run: observed — {"answer":42} (at Format)');

// A legacy/full-message observation is normalized to the default watched
// property, msg.payload, rather than quoting _msgid or encoding JSON twice.
assert.strictEqual(cards.buildResultCardModel({ verifyResults: [{
  state: "observed", evidenceCount: 1,
  evidence: [{ kind: "debug", node: "Format", value: { payload: "HELLO", _msgid: "x" } }]
}] }).run.label, "Run: observed — HELLO (at Format)");
assert.strictEqual(cards.buildResultCardModel({ verifyResults: [{
  state: "no-output", label: "Ran, but no output reached Output", evidenceCount: 0, evidence: []
}] }).run.label, "Ran, but no output reached Output");

// Converged Build must require an observed goal tap, not merely a prior or
// generic runtime result. A no-output last verify cannot converge.
assert.strictEqual(proof.runtimeBuildCanConverge({ state: "no-output", evidenceCount: 0 }, true), false);
assert.strictEqual(proof.runtimeBuildCanConverge({ state: "observed", evidenceCount: 1 }, true), true);


// Without a trigger (none found, or trigger consent declined), a source node
// nothing feeds is not a goal: an isolated inject firing on its own must not
// prove an unwired flow.
const noTrigger = proof.runtimeGoalObserve([
  node("inject", "inject", "Every 5 min", 1),
  node("fn", "function", "Format weather", 1),
  node("store", "function", "Store to global", 1)
], [], null);
assert.deepStrictEqual(noTrigger.tapNodeIds, []);
assert.strictEqual(proof.runtimeProofOutcome([], noTrigger).state, "no-output");

// Partly wired: inject -> fn is connected, the store node is not. Observed at
// fn, but the label names what the trigger never reached.
const partly = proof.runtimeGoalObserve([
  node("inject", "inject", "Trigger", 1),
  node("fn", "function", "Format", 1),
  node("store", "function", "Store to global", 1)
], [link("inject", "fn")], "inject");
assert.deepStrictEqual(partly.tapNodeIds, ["fn"]);
const partlyOutcome = proof.runtimeProofOutcome([
  { kind: "debug", nodeId: "fn", value: "22", valueType: "string" }
], partly);
assert.strictEqual(partlyOutcome.label, "Run: observed — 22 (at Format) · not reached: Store to global");
assert.strictEqual(cards.buildResultCardModel({ verifyResults: [Object.assign({ evidenceCount: 1,
  evidence: [{ kind: "debug", node: "Format", value: "22" }] }, partlyOutcome)] }).run.label,
  "Run: observed — 22 (at Format) · not reached: Store to global");


// A trigger alone proves nothing: a one-node run (just the inject) whose
// trigger tap fires is not "observed" (live: gpt-4.1 stopped after the inject
// and Test it quoted the inject's own timestamp).
const lone = proof.runtimeGoalObserve([node("inject", "inject", "Get Weather & Joke", 1)], [], "inject");
assert.deepStrictEqual(Array.from(lone.tapNodeIds), []);
assert.strictEqual(proof.runtimeProofOutcome([], lone).label, "Ran, but Get Weather & Joke isn't wired to anything");

console.log("P1-38 honest-proof tests passed");
