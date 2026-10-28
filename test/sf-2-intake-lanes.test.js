"use strict";

const assert = require("assert");
const intake = require("../lib/core/intake");
const { chooseLane, dispatchForLane } = require("../lib/core/lanes");

function base(message, extra) {
  return intake.buildIntake(message, {}, Object.assign({
    activeSelectionIds: function () { return []; },
    activeTab: { id: "tab-a", label: "Main" },
    candidates: [
      { id: "a", name: "Alpha", type: "inject" },
      { id: "b", name: "Beta", type: "debug" },
      { id: "c", name: "Gamma", type: "function" },
      { id: "d", name: "Delta", type: "change" },
      { id: "e", name: "Epsilon", type: "switch" },
      { id: "f", name: "Zeta", type: "status" },
      { id: "g", name: "Eta", type: "comment" }
    ]
  }, extra || {}));
}

// Intake defaults, active-tab context, candidate ordering/cap, and the
// pronoun resolution path all use the same real source functions.
const touched = intake.createTouchedNodeIndex();
const firstRun = touched.beginRun();
touched.recordRun([{ t: "edit", node: { id: "touched-1" } }], firstRun);
const secondRun = touched.beginRun();
touched.recordRun([], secondRun);
const inRecord = base("Rename it", { touchedIndex: touched });
assert.deepStrictEqual(inRecord.activeTab, { id: "tab-a", label: "Main" });
assert.strictEqual(inRecord.auto, true);
assert.strictEqual(inRecord.restricted, false);
assert.deepStrictEqual(inRecord.targetIds, ["touched-1"]);
assert.strictEqual(inRecord.target.kind, "it");
assert.strictEqual(inRecord.candidates.length, 6);
assert.strictEqual(intake.pickerCandidates(inRecord).length, 7);
assert.strictEqual(intake.pickerCandidates(inRecord).slice(-1)[0], "Something else (describe it)");
assert.deepStrictEqual(intake.lockTargetIds({ nodes: [{ id: "a", name: "Alpha" }] }),
  { ids: ["a"], labels: ["Alpha"] });

// A touched target is valid through two subsequent run numbers, but not the
// third. The last run's node list is the only list returned.
const ageIndex = intake.createTouchedNodeIndex();
const run1 = ageIndex.beginRun();
ageIndex.recordRun([{ t: "edit", node: { id: "n1" } }], run1);
ageIndex.beginRun();
ageIndex.beginRun();
assert.deepStrictEqual(ageIndex.resolveRecent(2), ["n1"]);
ageIndex.beginRun();
assert.deepStrictEqual(ageIndex.resolveRecent(2), []);

const selected = { activeSelectionIds: ["n1"], flags: { auto: true, restricted: false } };
const table = [
  ["F/unclear", chooseLane({}, { letter: "F" }).lane, "ASK"],
  ["unresolved change", chooseLane({}, { action: "modify" }).lane, "ASK"],
  ["resolved change", chooseLane(selected, { action: "modify" }).lane, "DIRECT"],
  ["open creation", chooseLane({}, { action: "generate" }).lane, "PLAN"],
  ["multi-target plan", chooseLane(selected, { action: "modify", plan_items: ["a", "b"], distinctTargets: true }).lane, "PLAN"],
  ["several selected nodes are one target set", chooseLane(selected, { action: "document", plan_items: ["a", "b"], targets: ["n1", "n2", "n3"] }).lane, "DIRECT"],
  ["answer is its own label", chooseLane(selected, { kind: "answer" }).lane, "ANSWER"],
  ["anchored addition (add-next-to)", chooseLane(selected, { action: "generate" }, { message: "add a debug node after this" }).lane, "DIRECT"],
  ["open-ended creation with a selection", chooseLane(Object.assign({ message: "build me a new flow that polls an API" }, selected), { action: "generate" }).lane, "PLAN"],
  ["cross-tab", chooseLane(selected, { action: "modify", crossTab: true }).lane, "PLAN"],
  ["subflow template", chooseLane(selected, { action: "modify", subflowTemplate: true }).lane, "PLAN"],
  ["cross-tab link", chooseLane(selected, { action: "modify", crossTabLink: true }).lane, "PLAN"],
  ["restricted", chooseLane(Object.assign({}, selected, { restricted: true }), { action: "modify" }).lane, "PLAN"],
  ["auto off", chooseLane(Object.assign({}, selected, { auto: false }), { action: "modify" }).lane, "PLAN"],
  ["plan first override", chooseLane(Object.assign({}, selected, { planFirst: true }), { action: "modify" }).lane, "PLAN"],
  ["just do it override", chooseLane(Object.assign({}, selected, { justDoIt: true }), { action: "modify" }).lane, "DIRECT"],
  ["C1 targeted behavior", chooseLane(selected, { action: "modify" }).lane, "DIRECT"],
  ["'this flow' with the open tab known is a resolved target", chooseLane({ message: "Document this flow for a teammate", activeTab: { id: "t1", label: "Flow 1" } }, { action: "document" }).lane, "DIRECT"],
  ["'this flow' without a known tab still asks", chooseLane({ message: "Document this flow for a teammate" }, { action: "document" }).lane, "ASK"],
  ["C1 targeted behavior via build", chooseLane(Object.assign({ message: "make this inject fire every 5 s" }, selected), { action: "build" }).lane, "DIRECT"]
];
table.forEach(function (row) { assert.strictEqual(row[1], row[2], row[0]); });

const proposal = { action: "modify", summary: "Change Shaper" };
[
  ["DIRECT", {}, "direct"], ["DIRECT", { auto: false }, "plan"],
  ["DIRECT", { restricted: true }, "plan"], ["PLAN", {}, "plan"],
  ["ASK", {}, "ask"], [undefined, {}, "plan"],
  ["DIRECT", { planFirst: true }, "plan"]
].forEach(function (row) {
  assert.strictEqual(dispatchForLane(row[0], proposal, row[1]).kind, row[2],
    "proposal dispatch " + row[0] + " / " + JSON.stringify(row[1]));
});

const once = base("Change Alpha", { oneShotFlags: { planFirst: true } });
assert.strictEqual(once.flags.planFirst, true, "one-shot Plan first reaches intake");
assert.strictEqual(base("Change Alpha").flags.planFirst, false, "one-shot Plan first is not persisted");
assert.strictEqual(base("Change Alpha", { oneShotFlags: { justDoIt: true } }).flags.justDoIt, true,
  "one-shot Just do it reaches intake");

console.log("SF-2 intake/lanes tests passed");

// Picker candidates rank nodes the message names by type or name, open tab
// first (live-found: the first 6 nodes of the tab were offered regardless).
global.RED = { nodes: { eachNode: function (cb) {
  [{ id: "k", type: "inject", name: "Kick", z: "t1" }, { id: "s", type: "function", name: "Shaper", z: "t1" },
   { id: "a", type: "debug", name: "Out A", z: "t1" }, { id: "b", type: "debug", name: "Out B", z: "t1" },
   { id: "x", type: "debug", name: "Elsewhere", z: "t2" }].forEach(cb);
} } };
const debugs = intake.nodeCandidates({ id: "t1" }, "Rename the debug node to Final").map(function (c) { return c.id; });
assert.deepStrictEqual(debugs.slice(0, 2).sort(), ["a", "b"], "open-tab debug nodes come first");
assert.ok(debugs.indexOf("k") === -1 && debugs.indexOf("s") === -1, "non-matching nodes aren't offered when something matches");
assert.deepStrictEqual(intake.nodeCandidates({ id: "t1" }, "Rename Shaper").map(function (c) { return c.id; }), ["s"], "a name match wins");
assert.strictEqual(intake.nodeCandidates({ id: "t1" }, "fix it").length, 4, "no match falls back to the open tab's nodes");
const named = intake.nodeCandidates({ id: "t1" }, "Add a debug node after the Elsewhere node").map(function (c) { return c.id; });
assert.strictEqual(named[0], "x", "a node the user names on another tab outranks open-tab type matches");
delete global.RED;
console.log("SF-2 picker candidate tests passed");

// Name resolution is safe (live-found: "Rename the debug node" resolved to a
// node named "Debug" on another tab).
global.RED = { nodes: { eachNode: function (cb) {
  [{ id: "a", type: "debug", name: "Out A", z: "t1" }, { id: "b", type: "debug", name: "Out B", z: "t1" },
   { id: "d", type: "debug", name: "Debug", z: "t2" }, { id: "s", type: "function", name: "Shaper", z: "t1" },
   { id: "s2", type: "function", name: "Shaper", z: "t2" }, { id: "w", type: "function", name: "Weather Fmt", z: "t2" }].forEach(cb);
} } };
function resolved(msg) { return intake.resolveIntakeTarget(msg, [], intake.nodeCandidates({ id: "t1" }, msg), null); }
assert.strictEqual(resolved("Rename the debug node to Final").kind, "unresolved", "a type word never names a node");
assert.deepStrictEqual(resolved("Rename Shaper to Main").ids, ["s"], "the open tab's match wins over another tab's");
assert.deepStrictEqual(resolved("Fix Weather Fmt please").ids, ["w"], "a unique name elsewhere resolves");
delete global.RED;
console.log("SF-2 safe name-resolution tests passed");
