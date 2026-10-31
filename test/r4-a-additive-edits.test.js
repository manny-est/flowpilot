"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const intake = require(path.join(root, "lib", "core", "intake.js"));
const limits = require(path.join(root, "lib", "core", "limits.js"));
const replan = require(path.join(root, "lib", "core", "replan.js"));
const modesSource = fs.readFileSync(path.join(root, "lib", "core", "modes.js"), "utf8");

const touched = {
  run: 7,
  runs: [{ run: 7, nodeIds: ["flow-start", "flow-end"] }]
};

function intent(message, extra) {
  return Object.assign({
    message,
    action: "generate",
    selectionIds: [],
    namedTargetIds: [],
    touchedIndex: touched,
    activeTabNodes: [{ id: "other-flow" }]
  }, extra || {});
}

test("additive versus standalone creation wording has anchored decisions", () => {
  const cases = [
    ["also add a comment node explaining the flow", { action: "generate" }, "additive"],
    ["add a debug after the function", { namedTargetIds: ["fn"] }, "additive"],
    ["add a delay before Output", { namedTargetIds: ["out"] }, "additive"],
    ["add a comment next to the selected node", { selectionIds: ["selected"] }, "additive"],
    ["log it too", {}, "additive"],
    ["and add a change node", { selectionIds: ["selected"] }, "additive"],
    ["add a comment describing this flow", {}, "additive"],
    ["also add an http request to the flow", { selectionIds: ["selected"] }, "additive"],
    ["please add a debug node to it", { inheritedRun: { runId: "run-1", targetLock: { ids: ["n1"] } } }, "additive"],
    ["Build a flow that fetches the weather every 5 minutes", { touchedIndex: { run: 0, runs: [] } }, "creation"],
    ["make a new flow that polls the API", { touchedIndex: { run: 0, runs: [] } }, "creation"],
    ["create a flow that stores the result", { touchedIndex: { run: 0, runs: [] } }, "creation"],
    ["fetch the weather every 5 minutes", { touchedIndex: { run: 0, runs: [] } }, "creation"],
    ["add a node", { touchedIndex: { run: 0, runs: [] }, activeTabNodes: [] }, "creation"]
  ];
  cases.forEach(([message, extra, expected]) => {
    const result = intake.classifyEditIntent(intent(message, extra));
    assert.equal(result.kind, expected, message);
  });
  const comment = intake.classifyEditIntent(intent("also add a comment node explaining the flow"));
  assert.deepEqual(comment.targetIds, ["flow-start", "flow-end"]);
});

test("dispatch policy keeps an anchored queued additive action out of creation mode", () => {
  assert.equal(typeof intake.creationRunForAction, "function");
  assert.equal(intake.creationRunForAction({
    action: "generate",
    summary: "also add a comment node explaining the flow",
    targets: ["flow-start"],
    inheritedRun: { runId: "run-1" }
  }), false);
  assert.equal(intake.creationRunForAction({
    action: "build",
    summary: "Build a flow that fetches the weather every 5 minutes",
    targets: []
  }), true);
  assert.match(modesSource.slice(modesSource.indexOf("function dispatchProposedAction(")), /creationRunForAction/);
});

test("first creation write counts nodes, not plan steps", () => {
  assert.equal(limits.creationFirstWriteError({
    newNodes: [{ id: "comment-1", type: "comment", info: "Explains the flow" }]
  }, { active: true, planStepCount: 3, plannedNodeCount: null, firstWriteComplete: false }), null);
  assert.match(limits.creationFirstWriteError({
    newNodes: [
      { id: "n1", type: "inject", wires: [["n2"]] },
      { id: "n2", type: "debug", wires: [[]] }
    ]
  }, { active: true, planStepCount: 4, plannedNodeCount: 4, firstWriteComplete: false }), /whole flow/);
});

test("queued run context snapshots tab, touched ids, and target lock", () => {
  assert.equal(typeof intake.snapshotRunContext, "function");
  const runContext = intake.snapshotRunContext({
    runId: "run-42",
    context: { activeTab: { id: "tab-1", label: "Weather" } },
    intake: { touchedNodeIndex: touched },
    targetLock: { ids: ["flow-start"], labels: ["Start"] }
  });
  const entry = { text: "also add a comment node explaining the flow", runContext };
  ["stop-and-do-this", "do-it-after"].forEach((choice) => {
    const dispatched = intake.queuedRunDispatch(entry, choice);
    assert.equal(dispatched.context.activeTab.id, "tab-1", choice);
    assert.deepEqual(dispatched.context.touchedNodeIndex, touched, choice);
    assert.deepEqual(dispatched.targetLock.ids, ["flow-start"], choice);
    assert.equal(dispatched.inheritedRun.runId, "run-42", choice);
  });
  assert.match(modesSource.slice(modesSource.indexOf("function queueMessage(")), /snapshotRunContext/);
  assert.match(modesSource.slice(modesSource.indexOf("function queueMessage(")), /runContext:/);
});

test("re-plan removes steps whose planned node ids were created", () => {
  const reduced = replan.reducePlan([
    { text: "place the trigger", nodeIds: ["n1"] },
    { text: "wire the transform", nodeIds: ["n2"] }
  ], [
    { id: "n1", name: "Trigger", type: "inject" },
    { id: "n2", name: "Transform", type: "function" }
  ], { createdIds: ["n1", "n2"] });
  assert.deepEqual(reduced.remaining, []);
});

test("queue choice state disables both chips and ignores a second choice", () => {
  assert.equal(typeof intake.createQueueChoiceState, "function");
  const state = intake.createQueueChoiceState();
  let calls = 0;
  assert.equal(state.choose(() => { calls += 1; }), true);
  assert.equal(state.choose(() => { calls += 1; }), false);
  assert.equal(calls, 1);
  assert.equal(state.disabled, true);
  assert.match(modesSource.slice(modesSource.indexOf("function renderQueuedMessageChoice(")), /prop\("disabled", true\)/);
});

test("agent continuations drop repeated conversation history but keep the active tool turn", () => {
  const compact = intake.compactAgentContinuationMessages([
    { role: "system", content: "system" },
    { role: "user", content: "old question" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "build this" },
    { role: "assistant", content: null, tool_calls: [{ id: "q1" }] },
    { role: "tool", tool_call_id: "q1", content: "answer" }
  ]);
  assert.deepEqual(compact.map((message) => message.role), ["system", "user", "assistant", "tool"]);
  assert.equal(compact[1].content, "build this");
  assert.match(modesSource, /compactAgentContinuationMessages/);
});
