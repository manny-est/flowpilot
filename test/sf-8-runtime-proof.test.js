"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const proof = require("../lib/core/runtime-proof.js");
const consent = require("../lib/core/consent.js");
const buildPrompt = require("../lib/build-agent-system-prompt.js");
const { buildCoreScript } = require("../lib/build-core-script.js");
const cards = require("../lib/core/cards.js");

// Runtime evidence is identified by the emitting node id, never by a debug
// node's display name. The same name elsewhere is deliberately ignored.
const evidence = proof.runtimeEvidenceForRun([
  { kind: "debug", nodeId: "tap-this-run", name: "FlowPilot test", value: "good" },
  { kind: "debug", nodeId: "same-name-elsewhere", name: "FlowPilot test", value: "wrong" },
  { kind: "status", nodeId: "changed-node", name: "Worker", value: "ready" },
  { kind: "status", nodeId: "unrelated-node", name: "Worker", value: "wrong" }
], { "tap-this-run": true }, { "changed-node": true });
assert.deepStrictEqual(evidence.map((entry) => entry.nodeId), ["tap-this-run", "changed-node"],
  "proof accepts this run's tap and touched-node status only");

const defaultObserve = proof.runtimeDefaultObserve([
  { id: "source", type: "function", outputs: 1 },
  { id: "multi", type: "switch", outputs: 2 },
  { id: "sink", type: "debug", outputs: 0 }
], {
  source: [{ target: "sink" }],
  multi: []
});
assert.deepStrictEqual(defaultObserve, ["multi"], "default observe uses output-capable terminal nodes");

// own edits 0/>0 × plan-approved/unapproved × Restricted.
const deployTable = [
  [0, false, false, "auto"], [0, true, false, "auto"],
  [2, false, false, "ask"], [2, true, false, "auto"],
  [0, false, true, "restricted"], [0, true, true, "restricted"],
  [2, false, true, "restricted"], [2, true, true, "restricted"]
];
deployTable.forEach(function (row) {
  assert.strictEqual(proof.runtimeDeployConsent(row[0], row[1], row[2]), row[3],
    "deploy decision " + row.slice(0, 3).join("/"));
});
assert.strictEqual(consent.decideConsent("deploy", null, { ownEdits: 0 }), "auto", "deploy is silent with no own edits");
assert.strictEqual(consent.decideConsent("deploy", null, { ownEdits: 1 }), "ask", "deploy asks for own edits");
assert.strictEqual(consent.decideConsent("deploy", null, {
  ownEdits: 1, approvedOperations: [{ operation: "deploy" }]
}), "auto", "approved plan still covers deploy");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "main.js"), "utf8");
assert.ok(mainSource.indexOf("historyEvents.push(event)") !== -1, "tap cleanup is recorded in the run history accumulator");
assert.ok(mainSource.indexOf("applyInsertions(newNodes, newWires, [], runHistoryEvents)") !== -1,
  "tap insertion is recorded in the run history accumulator");
assert.ok(mainSource.indexOf("fpTap: runId") !== -1, "runtime taps carry the run id");
assert.ok(mainSource.indexOf("buildRuntimeTapIds[msg.id]") !== -1, "runtime debug evidence is filtered by source id");
assert.ok(mainSource.indexOf("Removed \" + removed + \" leftover FlowPilot test nodes. Deploy to remove them from the running flow.") !== -1,
  "cleanup notice has the required wording");

assert.ok(buildPrompt.indexOf("FP-UID") === -1, "tool Build prompt no longer asks for FP-UID taps");
assert.ok(buildPrompt.indexOf("verify_runtime with observe") !== -1, "tool Build prompt names FlowPilot-owned observation");
assert.ok(buildPrompt.indexOf("Create new nodes for a new flow") !== -1, "tool Build prompt guards against cross-tab reuse");
assert.ok(buildCoreScript().indexOf("runtimeEvidenceForRun") !== -1, "assembled bundle includes runtime proof code");

assert.strictEqual(cards.buildResultCardModel({
  verifyResults: [{ evidenceCount: 0, evidence: [], note: "Restricted mode is on" }]
}).run.label, "Run: not provable here — Restricted mode is on");
assert.strictEqual(cards.buildResultCardModel({
  verifyResults: [{ evidenceCount: 1, evidence: [{ node: "FlowPilot test", value: "hello" }] }]
}).run.label, 'Run: proven — FlowPilot test: "hello"');

// Node-RED exports only declared defaults, so after a deploy or reload a tap
// has no fpTap property. The saved statusVal tag must still identify it, or
// cleanup-on-load finds nothing.
const reloadedTap = { id: "t9", type: "debug", name: "FlowPilot test", statusVal: "fp-tap:run-42", tostatus: false };
assert.strictEqual(proof.isFlowPilotTap(reloadedTap), true, "a reloaded tap is still recognised");
assert.strictEqual(proof.runtimeTapRunId(reloadedTap), "run-42");
assert.deepStrictEqual(proof.runtimeTapIdSet([reloadedTap], "run-42"), { t9: true });
assert.strictEqual(proof.isFlowPilotTap({ id: "u", type: "debug", name: "FlowPilot test", statusVal: "payload" }), false,
  "a user's debug node, even one with the same name, is not a tap");
assert.strictEqual(proof.isFlowPilotTap({ id: "f", type: "function", statusVal: "fp-tap:x" }), false, "only debug nodes are taps");

// The card quotes the flow's output: the last debug observation, not the
// first (live: an inject tap's "hello" was quoted instead of "HELLO").
const quoted = cards.buildResultCardModel({ verifyResults: [{ evidenceCount: 2, evidence: [
  { kind: "debug", node: "FlowPilot test", value: "hello" },
  { kind: "debug", node: "FlowPilot test", value: "HELLO" }
] }] }).run.label;
assert.ok(/HELLO/.test(quoted) && !/"hello"/.test(quoted), "the run line quotes the most downstream output");

console.log("SF-8 runtime-proof tests passed");
