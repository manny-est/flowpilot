"use strict";

// P1-38 follow-up, found live: a card's Test it calls the proof with no run
// history, so the goal rule only saw the trigger and the goal node and
// reported a fully wired flow as "Start isn't wired to anything". This runs
// the real composition (ensureFlowPilotRuntimeTaps in the core bundle) on a
// fake editor graph.

const assert = require("assert");
const path = require("path");
const vm = require("vm");

function makeRed() {
  const nodes = {};
  const links = [];
  const types = {
    inject: { inputs: 0, outputs: 1, defaults: {} },
    function: { inputs: 1, outputs: 1, defaults: {} },
    change: { inputs: 1, outputs: 1, defaults: {} },
    debug: { inputs: 1, outputs: 0, defaults: {} }
  };
  const red = {
    nodes: {
      node: function (id) { return nodes[id] || null; },
      add: function (node) { nodes[node.id] = node; return node; },
      getType: function (type) { return types[type] || null; },
      eachNode: function (fn) { Object.keys(nodes).forEach(function (id) { fn(nodes[id]); }); },
      eachLink: function (fn) { links.slice().forEach(fn); },
      filterLinks: function (filter) {
        return links.filter(function (link) { return !filter.source || link.source === filter.source; });
      },
      addLink: function (link) { links.push(link); return link; },
      dirty: function () { return false; },
      updateConfigNodeUsers: function () {},
      workspace: function (id) { return id === "tab-1" ? { id: id } : null; }
    },
    workspaces: { active: function () { return "tab-1"; } },
    editor: { validateNode: function (node) { node.valid = true; } },
    view: { redraw: function () {} },
    history: { push: function () {} }
  };
  function add(id, type, name, outputs) {
    nodes[id] = { id: id, type: type, name: name, z: "tab-1", x: 100, y: 100, outputs: outputs, wires: [] };
    return nodes[id];
  }
  function link(from, to) { links.push({ source: nodes[from], sourcePort: 0, target: nodes[to] }); }
  return { red: red, add: add, link: link };
}

function loadCore(red) {
  const buildCoreScript = require(path.join(__dirname, "..", "lib", "build-core-script.js")).buildCoreScript;
  const source = buildCoreScript().replace(/\n\}\)\(\);\s*$/,
    "\nwindow.__t = { ensureTaps: ensureFlowPilotRuntimeTaps };\n})();\n");
  const sandbox = {
    RED: red,
    console: { log: function () {}, warn: function () {}, error: function () {} },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    $: function () { return { length: 0 }; },
    document: {}, location: { origin: "http://localhost" }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "flowpilot-core-p1-38b.js" });
  return sandbox.__t;
}

// The live repro: Start -> Double -> Tag -> Store -> Out, Test it with an
// empty run history, observing the goal the card computed (Out).
{
  const env = makeRed();
  env.add("start", "inject", "Start", 1);
  env.add("double", "function", "Double", 1);
  env.add("tag", "change", "Tag", 1);
  env.add("store", "function", "Store", 1);
  env.add("out", "debug", "Out", 0);
  env.link("start", "double"); env.link("double", "tag"); env.link("tag", "store"); env.link("store", "out");
  const api = loadCore(env.red);
  const proof = api.ensureTaps({ observe: ["out"], trigger_node_id: "start",
    scope_ids: ["start", "double", "tag", "store", "out"] }, {}, [], "card-test-1", "start");
  assert.strictEqual(proof.goal.noOutputReason, null, "a wired trigger is not reported as unwired");
  assert.strictEqual(proof.goal.triggerHasPath, true);
  assert.deepStrictEqual(Array.from(proof.goal.goalNames), ["Out"], "the goal is the end of the path");
  assert.deepStrictEqual(Array.from(proof.goal.unreachedNames), [], "nothing in scope is unreached");
  const tapNames = Object.keys(proof.goal.evidenceNodeNames).filter(function (id) { return proof.tapIds.indexOf(id) !== -1; })
    .map(function (id) { return proof.goal.evidenceNodeNames[id]; });
  assert.deepStrictEqual(tapNames, ["Store"], "the tap's evidence is named after the node it watches, not 'FlowPilot test'");

  // Without a scope (older callers), following the live wires from the
  // trigger still finds the path.
  const noScope = api.ensureTaps({ observe: ["out"], trigger_node_id: "start" }, {}, [], "card-test-2", "start");
  assert.strictEqual(noScope.goal.noOutputReason, null);
  assert.deepStrictEqual(Array.from(noScope.goal.goalNames), ["Out"]);
}

// A really unwired trigger is still reported honestly, and scope nodes the
// trigger never reaches are named.
{
  const env = makeRed();
  env.add("start", "inject", "Start", 1);
  env.add("fn", "function", "Format", 1);
  env.add("store", "function", "Store", 1);
  const api = loadCore(env.red);
  const proof = api.ensureTaps({ trigger_node_id: "start", scope_ids: ["start", "fn", "store"] },
    {}, [], "card-test-3", "start");
  assert.strictEqual(proof.goal.noOutputReason, "Start isn't wired to anything");

  env.link("start", "fn");
  const partly = api.ensureTaps({ trigger_node_id: "start", scope_ids: ["start", "fn", "store"] },
    {}, [], "card-test-4", "start");
  assert.deepStrictEqual(Array.from(partly.goal.goalNames), ["Format"]);
  assert.deepStrictEqual(Array.from(partly.goal.unreachedNames), ["Store"]);
}

console.log("P1-38 Test it path tests passed");
