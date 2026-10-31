"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const intake = require(path.join(root, "lib", "core", "intake.js"));
const corpus = require(path.join(root, "test", "engine-corpus", "runner.js"));
const fragments = require(path.join(root, "lib", "build-core-script.js")).FRAGMENT_ORDER;

function makeRed() {
  const nodes = {
    n1: { id: "n1", type: "inject", name: "Grouped trigger", z: "tab-1", g: "g1" },
    n2: { id: "n2", type: "debug", name: "Grouped output", z: "tab-1", g: "g1" }
  };
  const groups = {
    g1: { id: "g1", type: "group", name: "Existing group", z: "tab-1", nodes: [nodes.n1, nodes.n2], style: { fill: "#eeeeee" } }
  };
  const history = [];
  const dirtyCalls = [];
  const red = {
    nodes: {
      node: function (id) { return nodes[id] || null; },
      group: function (id) { return groups[id] || null; },
      eachNode: function (callback) { Object.keys(nodes).forEach(function (id) { callback(nodes[id]); }); },
      eachGroup: function (callback) { Object.keys(groups).forEach(function (id) { callback(groups[id]); }); },
      eachLink: function () {},
      remove: function (id) { delete nodes[id]; },
      dirty: function (value) { if (arguments.length) { dirtyCalls.push(value); } return true; }
    },
    workspaces: { active: function () { return "tab-1"; } },
    editor: { validateNode: function (node) { node.valid = true; } },
    view: { redraw: function () {} },
    history: { push: function (event) { history.push(event); } },
    group: {
      markDirty: function (group) { dirtyCalls.push(group.id); },
      ungroup: function (group) {
        group.nodes.forEach(function (node) { delete node.g; });
        delete groups[group.id];
      }
    }
  };
  return { red: red, nodes: nodes, groups: groups, history: history, dirtyCalls: dirtyCalls };
}

function loadCore(red) {
  const source = "(function () {\n\"use strict\";\n" +
    fragments.map(function (name) { return fs.readFileSync(path.join(root, "lib", "core", name), "utf8"); }).join("\n") +
    [
      "",
      "window.__r4k = { executeAgentToolCall: executeAgentToolCall, executeReadNodeTool: executeReadNodeTool };",
      "})();",
      ""
    ].join("\n");
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
  vm.runInNewContext(source, sandbox, { filename: "flowpilot-core-r4-k.js" });
  return sandbox.__r4k;
}

function call(api, name, args, historyEvents) {
  return api.executeAgentToolCall({
    function: { name: name, arguments: JSON.stringify(args) }
  }, {}, historyEvents || []);
}

test("group names are intake and corpus candidates", function () {
  const oldRed = global.RED;
  global.RED = {
    nodes: {
      eachNode: function (callback) { callback({ id: "n1", type: "debug", name: "Other", z: "tab-1" }); },
      eachGroup: function (callback) { callback({ id: "g1", type: "group", name: "Existing group", z: "tab-1" }); },
      workspace: function () { return { id: "tab-1", label: "Main" }; },
      node: function () { return null; }
    }
  };
  try {
    const candidates = intake.nodeCandidates({ id: "tab-1", label: "Main" }, "Rename Existing group to Sensors", []);
    assert.deepEqual(candidates.find(function (candidate) { return candidate.id === "g1" }), {
      id: "g1", name: "Existing group", type: "group", z: "tab-1", tabLabel: "Main", inActiveTab: true
    });

    const parts = corpus.fixtureParts({
      prompt: "Rename Existing group to Sensors",
      flow: [
        { id: "tab-1", type: "tab", label: "Main" },
        { id: "g1", type: "group", z: "tab-1", name: "Existing group", nodes: ["n1"] },
        { id: "n1", type: "debug", z: "tab-1", name: "Output", wires: [] }
      ]
    });
    assert.deepEqual(parts.candidates.find(function (candidate) { return candidate.id === "g1" }), {
      id: "g1", name: "Existing group", type: "group", z: "tab-1", tabLabel: "Main", inActiveTab: true
    });
  } finally {
    global.RED = oldRed;
  }
});

test("rename and style edits update an existing group in place", function () {
  const env = makeRed();
  const api = loadCore(env.red);
  const historyEvents = [];
  call(api, "rename_node", { nodeId: "g1", name: "Sensor group" }, historyEvents);
  assert.equal(env.groups.g1.name, "Sensor group");
  assert.equal(historyEvents.length, 1, "rename is one undoable edit");
  assert.equal(historyEvents[0].t, "edit");
  assert.equal(historyEvents[0].node, env.groups.g1);
  assert.equal(env.dirtyCalls.includes("g1"), true, "group rename marks the group dirty");
  assert.equal(Object.keys(env.groups).length, 1, "rename does not create a group");

  const styleHistory = [];
  call(api, "apply_step", { changes: [{ id: "g1", set: { style: { fill: "#123456" } } }] }, styleHistory);
  assert.equal(env.groups.g1.style.fill, "#123456");
  assert.equal(styleHistory.length, 1, "style edit is one undoable edit");
  assert.equal(env.dirtyCalls.includes("g1"), true, "group style edit marks the group dirty");
});

test("removing a member preserves the group and its other members", function () {
  const env = makeRed();
  const api = loadCore(env.red);
  const result = call(api, "remove_step", { nodeId: "n2" }, []);
  assert.equal(result.allPass, true);
  assert.equal(env.nodes.n2, undefined);
  assert.deepEqual(env.groups.g1.nodes.map(function (node) { return node.id; }), ["n1"]);
  assert.equal(env.nodes.n1.g, "g1");
});

test("reading a group returns its member nodes", function () {
  const env = makeRed();
  const api = loadCore(env.red);
  const result = api.executeReadNodeTool({ id: "g1" });
  assert.equal(result.id, "g1");
  assert.equal(result.type, "group");
  assert.deepEqual(result.nodes.map(function (node) { return node.id; }), ["n1", "n2"]);
});

test("deleting a group removes only the group and keeps its members", function () {
  const env = makeRed();
  const api = loadCore(env.red);
  const historyEvents = [];
  call(api, "remove_step", { nodeId: "g1" }, historyEvents);
  assert.equal(env.groups.g1, undefined);
  assert.ok(env.nodes.n1 && env.nodes.n2, "group deletion keeps member nodes");
  assert.equal(env.nodes.n1.g, undefined);
  assert.equal(env.nodes.n2.g, undefined);
  assert.equal(historyEvents.length, 1, "group deletion is undoable");
  assert.equal(historyEvents[0].t, "ungroup");
});

console.log("R4-K group-target tests passed");
