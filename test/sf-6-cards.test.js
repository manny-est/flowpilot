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
    { t: "verified", evidence: [{ node: "Output", value: "hello world" }] },
    { t: "usage", total_tokens: 12 }
  ],
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
assert.strictEqual(model.run.label, "Run: proven — hello world");
assert.strictEqual(model.tokenCount, 13, "token count sums all usage records");

assert.strictEqual(cards.buildResultCardModel({}).run.label, "Run: not run");
assert.strictEqual(cards.buildResultCardModel({ verifyResults: [{ evidence: [] }] }).run.label, "Run: not provable here");

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

const remembered = [];
const memory = { rememberOperation: (taskId, operation, nodeId) => remembered.push({ taskId, operation, nodeId }) };
const approval = cards.approvePlanCard(plan, memory, "run-1", null, consent);
assert.deepStrictEqual(approval.operations, risks.map((risk) => ({ operation: risk.operation, nodeId: risk.nodeId || null, type: risk.type || null })));
assert.deepStrictEqual(remembered, approval.operations.map((operation) => ({ taskId: "run-1", operation: operation.operation, nodeId: operation.nodeId })));

console.log("SF-6 card tests passed");
