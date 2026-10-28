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
  history: null
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
assert.strictEqual(decision.pause, false, "the run's own tap (created, then cleaned up) is in scope, not outside the target");
decision = api.diffGateDecision(events.concat([{ t: "edit", node: nodes.extra }]), ["target"], state, {}, red);
assert.strictEqual(decision.pause, true, "editing an existing node outside the target pauses");
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

// Shaped like Node-RED 5.0.9's RED.history (red.js): list()/depth()/peek()
// are functions; replace() swaps the top entry in place.
function fakeHistory() {
  const undo = [];
  return {
    list: function () { return undo; },
    depth: function () { return undo.length; },
    peek: function () { return undo[undo.length - 1]; },
    push: function (ev) { undo.push(ev); },
    replace: function (ev) { undo[undo.length - 1] = ev; },
    pop: function () { return undo.pop(); }
  };
}
const liveNode = { id: "n1", name: "Before", type: "inject", selected: false, dirty: false, changed: false };
const markerRed = { nodes: { eachNode: function (fn) { fn(liveNode); }, eachLink: function () {} }, history: fakeHistory() };
markerRed.history.push({ t: "edit" });
let marker = api.captureDiffGateRunMarker(markerRed);
liveNode.selected = true;
assert.strictEqual(api.diffGateHasMidRunEdit(markerRed, marker), false, "selecting a node is not an edit");
liveNode.dirty = true; liveNode.changed = true;
assert.strictEqual(api.diffGateHasMidRunEdit(markerRed, marker), false, "deploy/dirty flags are not edits");
markerRed.history.push({ t: "move" });
assert.strictEqual(api.diffGateHasMidRunEdit(markerRed, marker), true, "a user edit (history push) is detected");
marker = api.captureDiffGateRunMarker(markerRed);
markerRed.history.replace({ t: "edit", replaced: true });
assert.strictEqual(api.diffGateHasMidRunEdit(markerRed, marker), true, "history.replace() is detected");
marker = api.captureDiffGateRunMarker(markerRed);
markerRed.history.pop();
assert.strictEqual(api.diffGateHasMidRunEdit(markerRed, marker), true, "a user Ctrl+Z is detected");

// New nodes are in scope; a wire touches only its source node.
const scoped = api.diffGateDecision([
  { t: "add", nodes: [{ id: "new-debug", name: "Added", type: "debug" }],
    links: [{ source: { id: "target" }, target: { id: "new-debug" } }] },
  { t: "add", links: [{ source: { id: "target" }, target: { id: "downstream" } }] }
], ["target"], null, {});
assert.strictEqual(scoped.pause, false, "adding a node next to the target and wiring the target onward stays in target");
assert.ok(!scoped.touchedNodes.some(function (n) { return n.id === "downstream"; }), "a wire's target node isn't touched");
const outside = api.diffGateDecision([
  { t: "edit", node: { id: "other", name: "Other", type: "function" } }
], ["target"], null, {});
assert.strictEqual(outside.pause, true, "editing an existing node outside the target pauses");
assert.strictEqual(outside.reason, "out-of-target");

// Deleting the target drops its incoming wire; the upstream node isn't
// edited, so this must not pause (Q5 live check, SF-5: "Delete this node").
const deleteTarget = api.diffGateDecision([
  { t: "delete", nodes: [{ id: "target", name: "Out", type: "debug" }],
    links: [{ source: { id: "upstream", name: "Set Topic", type: "change" }, target: { id: "target" } }] }
], ["target"], null, {});
assert.strictEqual(deleteTarget.pause, false, "deleting the target doesn't count the upstream node as touched");
assert.ok(!deleteTarget.touchedNodes.some(function (n) { return n.id === "upstream"; }));
const rewireOther = api.diffGateDecision([
  { t: "delete", links: [{ source: { id: "upstream" }, target: { id: "elsewhere" } }] }
], ["target"], null, {});
assert.strictEqual(rewireOther.pause, true, "removing a wire between two other nodes still counts");

// Node-RED 5.x: undo is RED.history.pop() ("core:undo"); there's no undo().
const stack = [];
let popped = null;
const undoRed = { history: {
  push: function (event) { stack.push(event); },
  pop: function () { popped = stack.pop(); }
} };
assert.strictEqual(api.undoDiffGateRun(undoRed, [{ t: "add", nodes: ["a"] }, { t: "delete", nodes: ["b"] }]), true, "undo uses RED.history.pop");
assert.strictEqual(popped.t, "multi", "the run is undone as one compound history event");
assert.strictEqual(stack.length, 0, "nothing is left on the undo stack");
assert.strictEqual(api.undoDiffGateRun({ history: { push: function () {} } }, [{ t: "add", nodes: ["a"] }]), false,
  "without a native undo the caller is told it didn't happen");

console.log("SF-4 diff-gate tests passed");
