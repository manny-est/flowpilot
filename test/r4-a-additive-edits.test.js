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
  // Review change: earlier user/assistant TEXT is kept (truncated) so the
  // original request survives; only earlier tool transcripts are dropped.
  assert.deepEqual(compact.map((message) => message.role), ["system", "user", "assistant", "user", "assistant", "tool"]);
  assert.equal(compact[3].content, "build this");
  assert.match(modesSource, /compactAgentContinuationMessages/);
});

test("review: weak anchors need wording or the active tab; compaction keeps the original request; client creation flag is sent as a boolean", () => {
  const intake = require("../lib/core/intake.js");
  const otherTab = { activeTabId: "t2", nodeTab: () => "t1" };
  const touched = { nodeIds: ["n1", "n2"] };
  // S10-style request after an earlier build on another tab: a creation, not an edit of the old flow.
  assert.equal(intake.classifyEditIntent(Object.assign({ action: "build", message: "Do something cool and unique, but no http or exec nodes", touchedIndex: touched }, otherTab)).creation, true);
  // Same request with the last work on the active tab: prefer additive.
  assert.equal(intake.classifyEditIntent({ action: "build", message: "Do something cool and unique", touchedIndex: touched, activeTabId: "t1", nodeTab: () => "t1" }).additive, true);
  // Worded additive with a touched index anywhere: additive.
  assert.equal(intake.classifyEditIntent(Object.assign({ action: "generate", message: "also add a comment node explaining the flow", touchedIndex: touched }, otherTab)).additive, true);
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "Build a weather flow" },
    { role: "assistant", content: "Which city?" },
    { role: "user", content: "London" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
    { role: "tool", tool_call_id: "c1", content: "ok" }
  ];
  const out = intake.compactAgentContinuationMessages(msgs);
  assert.ok(out.some(m => m.role === "user" && m.content === "Build a weather flow"), "original request kept");
  assert.ok(out.some(m => m.content === "Which city?"), "clarifying question kept");
  const old = [{ role: "system", content: "s" }, { role: "user", content: "a" }, { role: "assistant", content: "", tool_calls: [{ id: "x" }] }, { role: "tool", tool_call_id: "x", content: "big" }, { role: "assistant", content: "done" }, { role: "user", content: "b" }, { role: "assistant", content: null, tool_calls: [{ id: "y" }] }, { role: "tool", tool_call_id: "y", content: "r" }];
  const c = intake.compactAgentContinuationMessages(old);
  const callIds = new Set(c.flatMap(m => (m.tool_calls || []).map(t => t.id)));
  c.filter(m => m.role === "tool").forEach(m => assert.ok(callIds.has(m.tool_call_id), "no orphan tool message"));
  const modes = require("fs").readFileSync(require("path").join(__dirname, "../lib/core/modes.js"), "utf8");
  assert.match(modes, /stepPayload\.creationRun = creationRunState\.active === true;/);
  const fp = require("fs").readFileSync(require("path").join(__dirname, "../flowpilot.js"), "utf8");
  assert.match(fp, /typeof execution\.creationRun === "boolean"/);
});
