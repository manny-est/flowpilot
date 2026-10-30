"use strict";

// R2-A exercises the real browser-core insertion path with a Node-RED 5-like
// fake: nodes.add stores nodes, but only addLink stores canvas links.

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const vm = require("vm");

const sourceRoot = path.join(__dirname, "..");

function makeRed(options) {
  options = options || {};
  const nodes = {};
  const links = [];
  const history = [];
  const types = {
    inject: { inputs: 0, outputs: 1, defaults: {} },
    function: { inputs: 1, outputs: 1, defaults: {} },
    change: { inputs: 1, outputs: 1, defaults: {} }
  };
  return {
    nodes: nodes,
    links: links,
    history: history,
    red: {
      nodes: {
        node: function (id) { return nodes[id] || null; },
        add: function (node) { nodes[node.id] = node; return node; },
        getType: function (type) { return types[type] || null; },
        eachNode: function (fn) { Object.keys(nodes).forEach(function (id) { fn(nodes[id]); }); },
        eachLink: function (fn) { links.slice().forEach(fn); },
        addLink: function (link) {
          if (options.refuseLinks) { return null; }
          links.push(link);
          return link;
        },
        dirty: function () {},
        updateConfigNodeUsers: function () {},
        workspace: function (id) { return id === "tab-1" ? { id: id } : null; }
      },
      workspaces: { active: function () { return "tab-1"; } },
      editor: { validateNode: function (node) { node.valid = true; } },
      view: { redraw: function () {} },
      history: { push: function (event) { history.push(event); } }
    }
  };
}

function loadCore(red) {
  const fragments = [
    "redaction.js", "history.js", "diff-gate.js", "markdown.js", "intake.js",
    "lanes.js", "selection-context.js", "consent.js", "runtime-proof.js", "cards.js",
    "apply-review.js", "graph-truth.js", "validate.js", "modes.js", "main.js", "init.js"
  ];
  let source;
  if (process.env.R2A_BASELINE_COMMIT) {
    source = "(function () {\n\"use strict\";\n" + fragments.map(function (name) {
      return childProcess.execFileSync("git", ["show", process.env.R2A_BASELINE_COMMIT + ":lib/core/" + name], { encoding: "utf8" });
    }).join("\n") + "\n})();\n";
  } else {
    source = require(path.join(sourceRoot, "lib", "build-core-script.js")).buildCoreScript();
  }
  source = source.replace(/\n\}\)\(\);\s*$/, [
    "",
    "window.__r2a = {",
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
  vm.runInNewContext(source, sandbox, { filename: "flowpilot-core-r2-a.js" });
  return sandbox.__r2a;
}

function applyStep(api, args, env) {
  const runIdMap = {};
  const historyEvents = [];
  const wireState = { pending: [], connected: [], failed: [] };
  const result = api.executeAgentToolCall({
    function: { name: "apply_step", arguments: JSON.stringify(args) }
  }, runIdMap, historyEvents, wireState);
  return { result: result, map: runIdMap, state: wireState, history: historyEvents, env: env };
}

test("QA repro creates and names every in-step canvas link", function () {
  const env = makeRed();
  const api = loadCore(env.red);
  const run = applyStep(api, {
    summary: "Build chain",
    newNodes: [
      { id: "n1", type: "inject", name: "Trigger", wires: [["n2"]] },
      { id: "n2", type: "function", name: "Format", wires: [["n3"]] },
      { id: "n3", type: "function", name: "Prepare", wires: [["n4"]] },
      { id: "n4", type: "change", name: "Store", wires: [[]] }
    ]
  }, env);
  assert.strictEqual(env.links.length, 3, "each in-step wire is a real link");
  assert.strictEqual(run.result.wires.connected.length, 3, "tool result reads three live links");
  const card = api.buildResultCardModel({ wireOutcome: run.result.wires });
  assert.deepStrictEqual(Array.from(card.wires.connected.map(function (wire) {
    return wire.fromName + " -> " + wire.toName;
  })), ["Trigger -> Format", "Format -> Prepare", "Prepare -> Store"]);
  assert.ok(card.wires.connected.every(function (wire) {
    return wire.fromName !== "n1" && wire.toName !== "n2";
  }), "card wire rows do not use placeholder ids as labels");
});

test("an unwired canvas edge is a named failure, never a false checkmark", function () {
  const env = makeRed({ refuseLinks: true });
  const api = loadCore(env.red);
  const run = applyStep(api, {
    summary: "Refuse link",
    newNodes: [
      { id: "n1", type: "inject", name: "Trigger", wires: [["n2"]] },
      { id: "n2", type: "change", name: "Store", wires: [[]] }
    ]
  }, env);
  assert.strictEqual(env.links.length, 0, "the fake editor refused the link");
  assert.strictEqual(run.result.wires.connected.length, 0, "no live link is reported connected");
  assert.strictEqual(run.result.wires.failed.length, 1, "the missing live link is reported failed");
  assert.strictEqual(run.result.wires.failed[0].reason, "Not connected: Trigger → Store");
  const card = api.buildResultCardModel({ wireOutcome: run.result.wires });
  assert.strictEqual(card.wires.connected.length, 0, "the card has no false checkmark");
  assert.match(card.wires.failed[0].reason, /Trigger → Store/);
});

test("newWires and an in-node declaration create one registry link", function () {
  const env = makeRed();
  const api = loadCore(env.red);
  applyStep(api, {
    summary: "Deduplicate link",
    newNodes: [
      { id: "n1", type: "inject", name: "Trigger", wires: [["n2"]] },
      { id: "n2", type: "change", name: "Store", wires: [[]] }
    ],
    newWires: [{ from: "n1", fromPort: 0, to: "n2" }]
  }, env);
  assert.strictEqual(env.links.length, 1, "the duplicate request is one canvas link");
});

test("classic insertion also registers in-step wires", function () {
  const env = makeRed();
  const api = loadCore(env.red);
  api.applyInsertions([
    { id: "n1", type: "inject", name: "Trigger", wires: [["n2"]] },
    { id: "n2", type: "change", name: "Store", wires: [[]] }
  ], [], [], []);
  assert.strictEqual(env.links.length, 1, "classic insertion creates the link through addLink");
});
