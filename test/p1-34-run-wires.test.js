"use strict";

// P1-34 exercises the browser core directly. The fake RED surface is enough
// for the real insertion/agent executor path; no live Node-RED is required.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const childProcess = require("child_process");

const sourceRoot = process.env.P134_SOURCE_ROOT || path.join(__dirname, "..");

function makeRed() {
  const nodes = {};
  const links = [];
  const history = [];
  let dirty = false;
  const types = {
    inject: { inputs: 0, outputs: 1, defaults: {} },
    function: { inputs: 1, outputs: 1, defaults: {} },
    "http request": { inputs: 1, outputs: 1, defaults: {} },
    change: { inputs: 1, outputs: 1, defaults: {} }
  };
  const red = {
    nodes: {
      node: function (id) { return nodes[id] || null; },
      add: function (node) { nodes[node.id] = node; return node; },
      getType: function (type) { return types[type] || null; },
      eachNode: function (fn) { Object.keys(nodes).forEach(function (id) { fn(nodes[id]); }); },
      eachLink: function (fn) { links.slice().forEach(fn); },
      addLink: function (link) { links.push(link); return link; },
      dirty: function (value) { if (arguments.length) { dirty = value; } return dirty; },
      updateConfigNodeUsers: function () {},
      workspace: function (id) { return id === "tab-1" ? { id: id } : null; }
    },
    workspaces: { active: function () { return "tab-1"; } },
    editor: { validateNode: function (node) { node.valid = true; } },
    view: { redraw: function () {} },
    history: { push: function (event) { history.push(event); } }
  };
  return { red: red, nodes: nodes, links: links, history: history };
}

function loadCore(red) {
  let source;
  if (process.env.P134_BASELINE_COMMIT) {
    const fragmentOrder = [
      "redaction.js", "history.js", "diff-gate.js", "markdown.js", "intake.js",
      "lanes.js", "selection-context.js", "consent.js", "runtime-proof.js", "cards.js",
      "apply-review.js", "graph-truth.js", "validate.js", "modes.js", "main.js", "init.js"
    ];
    source = "(function () {\n    \"use strict\";\n" + fragmentOrder.map(function (name) {
      return childProcess.execFileSync("git", ["show", process.env.P134_BASELINE_COMMIT + ":lib/core/" + name], { encoding: "utf8" });
    }).join("\n") + "\n})();\n";
  } else {
    const buildCoreScript = require(path.join(sourceRoot, "lib", "build-core-script.js")).buildCoreScript;
    source = buildCoreScript();
  }
  source = source.replace(/\n\}\)\(\);\s*$/, [
    "",
    "window.__p134 = {",
    "  executeAgentToolCall: executeAgentToolCall,",
    "  applyInsertions: applyInsertions,",
    "  buildResultCardModel: buildResultCardModel",
    "};",
    "})();",
    ""
  ].join("\n"));
  const sandbox = {
    RED: red,
    console: { log: function () {}, warn: function () {}, error: function () {} },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    $: function () { return { length: 0 }; },
    document: {},
    location: { origin: "http://localhost" }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "flowpilot-core-p1-34.js" });
  return sandbox.__p134;
}

function callApply(api, args, runIdMap, historyEvents, wireState) {
  const result = api.executeAgentToolCall({
    function: { name: "apply_step", arguments: JSON.stringify(args) }
  }, runIdMap, historyEvents, wireState);
  if (result.idMap) { Object.assign(runIdMap, result.idMap); }
  return result;
}

function reverseMap(runIdMap) {
  const result = {};
  Object.keys(runIdMap).forEach(function (placeholder) {
    result[runIdMap[placeholder]] = placeholder;
  });
  return result;
}

function edgeNames(env, runIdMap) {
  const reverse = reverseMap(runIdMap);
  return env.links.map(function (link) {
    return reverse[link.source.id] + ":" + (link.sourcePort || 0) + "->" + reverse[link.target.id];
  }).sort();
}

function runLiveRepro(api, env) {
  const runIdMap = {};
  const historyEvents = [];
  const wireState = { pending: [], connected: [], failed: [] };
  const results = [];
  results.push(callApply(api, {
    summary: "Add trigger",
    newNodes: [{ id: "n1", type: "inject", wires: [["n2"]], outputs: 1 }]
  }, runIdMap, historyEvents, wireState));
  results.push(callApply(api, {
    summary: "Add formatter",
    newNodes: [{ id: "n2", type: "function", outputs: 2, wires: [["n3"], ["n4"]] }],
    newWires: [{ from: "n1", fromPort: 0, to: "n2" }]
  }, runIdMap, historyEvents, wireState));
  results.push(callApply(api, {
    summary: "Add weather request",
    newNodes: [{ id: "n3", type: "http request", wires: [["n5"]], outputs: 1 }],
    newWires: [{ from: "n2", fromPort: 0, to: "n3" }]
  }, runIdMap, historyEvents, wireState));
  results.push(callApply(api, {
    summary: "Add joke request",
    newNodes: [{ id: "n4", type: "http request", wires: [["n5"]], outputs: 1 }],
    newWires: [{ from: "n2", fromPort: 1, to: "n4" }]
  }, runIdMap, historyEvents, wireState));
  results.push(callApply(api, {
    summary: "Store result",
    newNodes: [{ id: "n5", type: "change", wires: [], outputs: 1 }],
    newWires: [
      { from: "n3", fromPort: 0, to: "n5" },
      { from: "n4", fromPort: 0, to: "n5" }
    ]
  }, runIdMap, historyEvents, wireState));
  return { runIdMap: runIdMap, historyEvents: historyEvents, wireState: wireState, results: results };
}

const env = makeRed();
const api = loadCore(env.red);
const repro = runLiveRepro(api, env);

assert.deepStrictEqual(edgeNames(env, repro.runIdMap), [
  "n1:0->n2", "n2:0->n3", "n2:1->n4", "n3:0->n5", "n4:0->n5"
], "the five one-node-per-step repro is fully wired exactly once");
assert.strictEqual(env.links.length, 5, "forward wires and backward newWires do not duplicate links");
assert.strictEqual(repro.wireState.pending.length, 0, "all forward references were eventually connected");
assert.strictEqual(repro.wireState.failed.length, 0, "the repro has no wire failures");
assert.ok(repro.results[1].wires.connected.some(function (wire) {
  return wire.from === "n1" && wire.to === "n2";
}), "backward newWires resolves the earlier placeholder");
assert.strictEqual(env.history.length, 0, "agent history is accumulated until the run ends");
assert.ok(repro.historyEvents[1].links.some(function (link) {
  return link.source.id === repro.runIdMap.n1 && link.target.id === repro.runIdMap.n2;
}), "the step completing a pending wire owns that link in its undo event");

// Simulate Node-RED's t:"add" undo for the completing step and prove the
// pending link is removed along with that step.
const completingEvent = repro.historyEvents[4];
completingEvent.links.forEach(function (link) {
  const index = env.links.indexOf(link);
  if (index !== -1) { env.links.splice(index, 1); }
});
assert.strictEqual(env.links.some(function (link) {
  return link.source.id === repro.runIdMap.n3 && link.target.id === repro.runIdMap.n5;
}), false, "undo of the completing step removes its completed pending wire");

// A never-created endpoint is retained in the agent result, rather than
// becoming a red editor error or disappearing.
const pendingEnv = makeRed();
const pendingApi = loadCore(pendingEnv.red);
const pendingMap = {};
const pendingHistory = [];
const pendingState = { pending: [], connected: [], failed: [] };
const pendingResult = callApply(pendingApi, {
  summary: "Forward reference",
  newNodes: [{ id: "n1", type: "inject", wires: [["n2"]], outputs: 1 }]
}, pendingMap, pendingHistory, pendingState);
assert.notStrictEqual(pendingResult.allPass, false,
  "a forward wire waiting for its node is not a failed step (a failed step invites the model to redo it)");
assert.ok(/Waiting to connect: n1 → n2/.test(pendingResult.note || "") && /don't recreate/.test(pendingResult.note),
  "the tool result tells the model the wire is waiting and not to redo the step");
assert.deepStrictEqual(Array.from(pendingResult.wires.pending, function (wire) {
  return [wire.from, wire.to];
}), [["n1", "n2"]], "the tool result reports the unresolved wire as pending");
assert.strictEqual(pendingResult.wires.failed.length, 0, "forward references are not reported as failures");

// The classic path retains its old user-facing missing-node message and does
// not opt into run-scoped pending state.
const reviewSource = fs.readFileSync(path.join(sourceRoot, "lib", "core", "apply-review.js"), "utf8");
assert.ok(reviewSource.indexOf("Cannot wire new node to existing node — node not found") !== -1,
  "classic insertion keeps its existing missing-node message");
const cards = api.buildResultCardModel({
  wireOutcome: {
    connected: [],
    pending: [{ from: "n1", fromPort: 0, to: "n2", reason: "Not connected: n1 → n2 (n2 was never created)" }],
    failed: []
  }
});
assert.strictEqual(cards.wires.pending[0].reason, "Not connected: n1 → n2 (n2 was never created)",
  "the result-card model preserves the final not-connected wording");

console.log("P1-34 run-wire tests passed");
