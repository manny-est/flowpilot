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

console.log("P1-38 honest-proof tests passed");
