"use strict";

// R2-B: every row is a small executable statement of Amendment 1.  The
// source fragment is loaded directly so these cases exercise the browser
// gate rather than a test-only copy.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "diff-gate.js"), "utf8");
const api = new Function(src + "\nreturn {" +
  "createDiffGateState:createDiffGateState," +
  "diffGateDecision:diffGateDecision," +
  "diffGateKeepGoing:diffGateKeepGoing," +
  "diffGateApproveScope:(typeof diffGateApproveScope === 'function' ? diffGateApproveScope : null)," +
  "diffGateApprovePlan:(typeof diffGateApprovePlan === 'function' ? diffGateApprovePlan : null)," +
  "diffGateMarkCreated:(typeof diffGateMarkCreated === 'function' ? diffGateMarkCreated : null)" +
"};")();

function existing(ids) {
  return ids.map(function (id) {
    return { id: id, name: id, type: "function" };
  });
}

function created(ids) {
  return ids.map(function (id) {
    return { id: id, name: id, type: "debug", created: true };
  });
}

function approveScope(state, ids) {
  if (api.diffGateApproveScope) { return api.diffGateApproveScope(state, ids); }
  state.allowedNodeIds = state.allowedNodeIds || {};
  ids.forEach(function (id) { state.allowedNodeIds[id] = true; });
  return state;
}

function approvePlan(state, ids) {
  if (api.diffGateApprovePlan) { return api.diffGateApprovePlan(state, ids); }
  state.planApproved = true;
  return approveScope(state, ids);
}

function markCreated(state, ids) {
  if (api.diffGateMarkCreated) { return api.diffGateMarkCreated(state, ids); }
  return state;
}

function run(row) {
  const state = api.createDiffGateState(row.locked || [], {
    diffGateThreshold: row.threshold === undefined ? 5 : row.threshold,
    lane: row.lane,
    planApproved: row.planApproved === true
  });
  if (row.consent) { approveScope(state, row.consent); }
  if (row.plan) { approvePlan(state, row.plan); }
  let decision = api.diffGateDecision(row.touched, row.locked || [], state, {}, {});
  if (row.keep) {
    assert.strictEqual(decision.pause, true, row.name + ": the first pass must pause before Keep going");
    api.diffGateKeepGoing(state, decision);
    decision = api.diffGateDecision(row.keep, row.locked || [], state, {}, {});
  }
  return decision;
}

const rows = [
  {
    name: "confirmed 7-node delete is covered by accepted consent",
    lane: "DIRECT", consent: ["n1", "n2", "n3", "n4", "n5", "n6", "n7"],
    touched: existing(["n1", "n2", "n3", "n4", "n5", "n6", "n7"]), expectPause: false
  },
  {
    name: "ten created nodes do not count toward the size threshold",
    lane: "DIRECT", touched: created(["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10"]), expectPause: false
  },
  {
    name: "six existing nodes outside scope pause in DIRECT",
    lane: "DIRECT", touched: existing(["n1", "n2", "n3", "n4", "n5", "n6"]), expectPause: true, expectReason: "out-of-target"
  },
  {
    name: "an approved plan covers its eight existing nodes",
    lane: "PLAN", planApproved: true, plan: ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"],
    touched: existing(["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"]), expectPause: false
  },
  {
    name: "an approved plan still pauses for one existing node outside its three targets",
    lane: "PLAN", planApproved: true, plan: ["n1", "n2", "n3"],
    touched: existing(["n1", "n2", "n3", "n4"]), expectPause: true, expectReason: "out-of-target"
  },
  {
    name: "six locked targets are already approved scope",
    lane: "DIRECT", locked: ["n1", "n2", "n3", "n4", "n5", "n6"],
    touched: existing(["n1", "n2", "n3", "n4", "n5", "n6"]), expectPause: false
  },
  {
    name: "Keep going approves the shown nodes for the rest of the run",
    lane: "DIRECT", touched: existing(["n1", "n2", "n3", "n4", "n5", "n6"]),
    keep: existing(["n1", "n2", "n3", "n4", "n5", "n6"]), expectPause: false
  },
  {
    name: "Keep going pauses when a new existing outside node appears",
    lane: "DIRECT", touched: existing(["n1", "n2", "n3", "n4", "n5", "n6"]),
    keep: existing(["n1", "n2", "n3", "n4", "n5", "n6", "n7"]), expectPause: true, expectReason: "out-of-target"
  }
];

for (const row of rows) {
  const decision = run(row);
  assert.strictEqual(decision.pause, row.expectPause, row.name);
  if (row.expectReason) { assert.ok(decision.reason.indexOf(row.expectReason) !== -1, row.name + ": reason"); }
}

const idMapState = api.createDiffGateState([], { lane: "DIRECT" });
markCreated(idMapState, ["real-created-1", "real-created-2"]);
const idMapDecision = api.diffGateDecision([
  { id: "real-created-1", name: "Added 1", type: "debug" },
  { id: "real-created-2", name: "Added 2", type: "debug" }
], [], idMapState, {}, {});
assert.strictEqual(idMapDecision.pause, false, "run id-map creations are in scope even before the ledger marks them created");

console.log("R2-B approved-scope table passed");

// Review fix: only a real Approve click marks the run plan-approved. The
// DIRECT handover also goes through dispatchProposedAction, and it must keep
// the size check (Amendment 1: the threshold applies in DIRECT).
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "core", "modes.js"), "utf8");
  assert.ok(/planApproved: userApproved,/.test(src) && /var userApproved = options\.userApproved === true && !direct;/.test(src),
    "plan approval comes from the caller, never from a DIRECT handover");
  assert.ok(/dispatchProposedAction\(rec\.proposeAction, \{ userApproved: true \}\)/.test(src), "Approve passes userApproved");
  assert.ok(/dispatchProposedAction\(data\.directProposal, \{ direct: true \}\)/.test(src), "the DIRECT handover passes direct only");
}
