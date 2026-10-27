"use strict";

// SF-4's client-only decision layer is exercised against the real fragment.
// No copy of the gate logic lives in this test; the fake editor only supplies
// the small RED.history/RED.nodes surface the fragment reads.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "diff-gate.js"), "utf8");
const api = new Function(src + "\nreturn {" +
  "getDiffGateThreshold:getDiffGateThreshold," +
  "deriveDiffGateTouchedNodes:deriveDiffGateTouchedNodes," +
  "createDiffGateState:createDiffGateState," +
  "diffGateDecision:diffGateDecision," +
  "diffGateKeepGoing:diffGateKeepGoing," +
  "captureDiffGateRunMarker:captureDiffGateRunMarker," +
  "diffGateHasMidRunEdit:diffGateHasMidRunEdit," +
  "undoDiffGateRun:undoDiffGateRun" +
"};")();

const nodes = {
  target: { id: "target", name: "Input", type: "inject" },
  tap: { id: "tap", name: "FP-UID001", type: "debug" },
  extra: { id: "extra", name: "Unexpected", type: "function" }
};
const red = {
  nodes: {
    node: function (id) { return nodes[id] || null; },
    group: function () { return null; },
    eachNode: function (fn) { Object.keys(nodes).forEach(function (id) { fn(nodes[id]); }); },
    eachLink: function (fn) { fn({ source: nodes.target, sourcePort: 0, target: nodes.tap }); }
  },
  history: { list: [], depth: 0, index: 0 }
};

assert.strictEqual(api.getDiffGateThreshold({}), 5, "default threshold is five");
assert.strictEqual(api.getDiffGateThreshold({ diffGateThreshold: 2.9 }), 2, "threshold is read and normalized");

// The add + tap-cleanup events are one run ledger. Link endpoints count too,
// so a tap cleanup cannot disappear from the diff just because its node was
// removed before the run is flushed.
const events = [
  { t: "add", nodes: ["target", "tap"], links: [{ source: nodes.target, target: nodes.tap }] },
  { t: "delete", nodes: [nodes.tap], links: [{ source: nodes.target, target: nodes.tap }] }
];
const ledger = api.deriveDiffGateTouchedNodes(events, red);
assert.deepStrictEqual(ledger.map(function (n) { return n.id; }).sort(), ["tap", "target"], "accumulator includes tap insertion and cleanup");

let state = api.createDiffGateState(["target"], {});
let decision = api.diffGateDecision(events, ["target"], state, {}, red);
assert.strictEqual(decision.pause, true, "out-of-target touch pauses");
assert.strictEqual(decision.reason, "out-of-target", "pause reason is recorded");
assert.strictEqual(decision.touchedNodes.filter(function (n) { return n.outOfTarget; }).length, 1, "out-of-target node is marked");

state = api.createDiffGateState(["target", "tap", "extra"], { diffGateThreshold: 2 });
decision = api.diffGateDecision([
  { id: "target", name: "Input", type: "inject" },
  { id: "tap", name: "Tap", type: "debug" },
  { id: "extra", name: "Extra", type: "function" }
], ["target", "tap", "extra"], state, {});
assert.strictEqual(decision.pause, true, "threshold overflow pauses");
assert.strictEqual(decision.reason, "threshold", "threshold reason is recorded");
api.diffGateKeepGoing(state, decision);
const afterKeep = api.diffGateDecision(decision.touchedNodes, ["target", "tap", "extra"], state, {});
assert.strictEqual(afterKeep.pause, false, "Keep going raises allowance for the same nodes");

const markerRed = {
  nodes: {
    eachNode: function (fn) { fn({ id: "n1", name: "Before", type: "inject" }); },
    eachLink: function () {}
  },
  history: { list: [], depth: 0, index: 0 }
};
const marker = api.captureDiffGateRunMarker(markerRed);
markerRed.nodes.eachNode = function (fn) { fn({ id: "n1", name: "User edit", type: "inject" }); };
assert.strictEqual(api.diffGateHasMidRunEdit(markerRed, marker), true, "node edit is detected at the step boundary");
markerRed.nodes.eachNode = function (fn) { fn({ id: "n1", name: "Before", type: "inject" }); };
markerRed.history.list.push({ t: "edit" });
assert.strictEqual(api.diffGateHasMidRunEdit(markerRed, marker), true, "external RED.history push is detected");

let restored = false;
let pushed;
const undoRed = {
  history: {
    push: function (event) { pushed = event; },
    undo: function () { restored = true; }
  }
};
assert.strictEqual(api.undoDiffGateRun(undoRed, [{ t: "add", nodes: ["a"] }, { t: "delete", nodes: ["b"] }]), true, "undo uses the native history API");
assert.strictEqual(pushed.t, "multi", "the run is undone as one compound history event");
assert.strictEqual(restored, true, "native undo restores the pre-run state");

console.log("SF-4 diff-gate tests passed");
