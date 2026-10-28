"use strict";

const assert = require("assert");
const cards = require("../lib/core/cards.js");

const record = {
  changedNodes: [
    {
      id: "fn-1",
      name: "Shape",
      type: "function",
      before: { func: "msg.payload = 1;\nreturn msg;" },
      after: { func: "msg.payload = 2;\nreturn msg;" }
    },
    { id: "new-1", name: "Output", type: "debug", changeType: "added", after: { id: "new-1", name: "Output", type: "debug" } },
    { id: "old-1", name: "Old", type: "change", changeType: "removed", before: { id: "old-1", name: "Old", type: "change" } }
  ],
  events: [
    { t: "validation", checks: [
      { check: "node", status: "pass", message: "valid" },
      { check: "wire", status: "fail", message: "missing target" },
      { check: "lint", status: "warning", message: "review" }
    ] },
    { t: "verified", opId: "w1", detail: true },
    { t: "usage", total_tokens: 12 }
  ],
  // verify_runtime results, as converged Build stores them on the record
  verifyResults: [{ evidenceCount: 1, evidence: [{ kind: "debug", node: "Output", value: "hello world" }] }],
  usage: [{ total_tokens: 8 }, { prompt_tokens: 3, completion_tokens: 2 }]
};

const model = cards.buildResultCardModel(record);
assert.strictEqual(model.changedNodes.length, 3, "changed nodes come from the record");
const fn = model.changedNodes.find((node) => node.id === "fn-1");
assert.strictEqual(fn.changed.length, 1, "property changes are retained");
assert.ok(fn.changed[0].lines.some((line) => line.kind === "remove" && /1/.test(line.text)), "function removal is a line diff");
assert.ok(fn.changed[0].lines.some((line) => line.kind === "add" && /2/.test(line.text)), "function addition is a line diff");
assert.deepStrictEqual(model.validation.map((check) => check.status), ["pass", "fail", "warning"]);
assert.strictEqual(model.run.state, "proven");
assert.strictEqual(model.run.label, "Run: proven — Output: hello world");
assert.strictEqual(model.tokenCount, 13, "token count sums all usage records");

assert.strictEqual(cards.buildResultCardModel({}).run.label, "Run: not run");
assert.strictEqual(cards.buildResultCardModel({ verifyResults: [{ evidence: [] }] }).run.label, "Run: not provable here");
// Per-write canvas checks ("verified" events) are not runs.
assert.strictEqual(cards.buildResultCardModel({ events: [{ t: "verified", opId: "w1", detail: true }] }).run.label, "Run: not run");
// Only the last runtime check decides, like the run's own outcome.
assert.strictEqual(cards.buildResultCardModel({ verifyResults: [
  { evidenceCount: 1, evidence: [{ node: "Out", value: "x" }] }, { evidenceCount: 0, evidence: [] }
] }).run.state, "not-provable", "an earlier observation followed by a failing check isn't proof");

function fakeHistory() {
  const entries = [];
  return {
    list: () => entries,
    depth: () => entries.length,
    peek: () => entries[entries.length - 1],
    push: (entry) => entries.push(entry),
    pop: () => entries.pop()
  };
}
const history = fakeHistory();
const entry = { t: "multi", events: [{ t: "edit" }] };
history.push(entry);
const undoRecord = { historyEntry: entry };
assert.deepStrictEqual(cards.undoResultCard(undoRecord, { history }), { undone: true, message: "Undone in the editor." });
history.push({ t: "newer" });
assert.deepStrictEqual(cards.undoResultCard(undoRecord, { history }), { undone: false, message: "Newer edits are on top of this run. Nothing was undone." });

const plan = {
  plan_items: ["Change the HTTP request", "Delete the temporary debug node", "Deploy the flow"],
  targetNodes: [
    { id: "http-1", name: "Request", type: "http request" },
    { id: "fn-1", name: "Shape", type: "function" }
  ]
};
const consent = { decideConsent: (operation, type) => type === "http request" ? "ask" : "auto" };
const risks = cards.planRiskPrediction(plan, null, consent);
assert.deepStrictEqual(risks.map((risk) => risk.operation), ["delete", "deploy", "modify-config"]);
const unnamedDelete = risks.find((risk) => risk.operation === "delete");
assert.strictEqual(unnamedDelete.approvable, false, "a delete the plan can't tie to a named target is listed, not pre-approved");
assert.ok(!risks.some((risk) => risk.operation === "create"), "changing an HTTP request isn't predicted as adding one");

const remembered = [];
const memory = { rememberOperation: (taskId, operation, nodeId) => remembered.push({ taskId, operation, nodeId }) };
const approval = cards.approvePlanCard(plan, memory, "run-1", null, consent);
assert.deepStrictEqual(approval.operations.map((op) => op.operation).sort(), ["deploy", "modify-config"],
  "Approve covers exactly the approvable listed operations");
assert.deepStrictEqual(remembered.map((r) => r.operation + ":" + (r.nodeId || "")).sort(), ["deploy:", "modify-config:http-1"]);

// A delete the plan names is approvable, but only for that node.
const named = cards.planRiskPrediction({ plan_items: ["Remove Shape"], targetNodes: plan.targetNodes }, null, consent);
assert.deepStrictEqual(named.filter((r) => r.operation === "delete").map((r) => [r.nodeId, r.approvable]), [["fn-1", true]]);
// Side-effecting creates are listed by type when a line adds one.
const creates = cards.planRiskPrediction({ plan_items: ["Add an MQTT out node to publish the reading"] }, null, consent);
assert.deepStrictEqual(creates.map((r) => r.operation + ":" + r.type), ["create:mqtt out"]);
// Build plans always list deploy.
assert.ok(cards.planRiskPrediction({ proposeAction: { action: "build", plan_items: [] } }, null, consent).some((r) => r.operation === "deploy"));

// consent.js: plan approvals never become wildcards for delete/config.
const consentLib = require("../lib/core/consent.js");
const approvedOps = [{ operation: "delete", nodeId: null }, { operation: "deploy", nodeId: null }, { operation: "create", type: "mqtt out" }];
assert.strictEqual(consentLib.decideConsent("delete", "debug", { approvedOperations: approvedOps, nodeId: "any" }), "ask", "no node-less delete approval");
assert.strictEqual(consentLib.decideConsent("deploy", null, { approvedOperations: approvedOps }), "auto", "deploy may be approved without a node");
assert.strictEqual(consentLib.decideConsent("create", "mqtt out", { approvedOperations: approvedOps }), "auto", "listed create type is approved");
assert.strictEqual(consentLib.decideConsent("create", "exec", { approvedOperations: approvedOps }), "ask", "an unlisted risky create still asks");
const mem = consentLib.createConsentMemory();
mem.rememberOperation("t", "delete", null);
assert.strictEqual(mem.hasOperation("t", "delete", "n1"), false, "memory has no delete wildcard");

console.log("SF-6 card tests passed");
