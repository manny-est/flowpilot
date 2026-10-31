"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const root = path.join(__dirname, "..");
const consent = require(path.join(root, "lib", "core", "consent.js"));

function makeRed(existing, options) {
  options = options || {};
  const nodes = Object.create(null);
  const links = [];
  const history = [];
  const types = {
    function: { inputs: 1, outputs: 1, defaults: {} },
    inject: { inputs: 0, outputs: 1, defaults: {} },
    debug: { inputs: 1, outputs: 0, defaults: {} }
  };
  (existing || []).forEach((node) => { nodes[node.id] = node; });
  const red = {
    nodes: {
      node: (id) => nodes[id] || null,
      add: (node) => { nodes[node.id] = node; return node; },
      remove: (id) => { delete nodes[id]; },
      getType: (type) => types[type] || null,
      eachNode: (fn) => Object.keys(nodes).forEach((id) => fn(nodes[id])),
      eachLink: (fn) => links.slice().forEach(fn),
      filterLinks: (filter) => links.filter((link) =>
        (!filter.source || link.source === filter.source) && (!filter.target || link.target === filter.target)),
      addLink: (link) => { links.push(link); return link; },
      removeLink: (link) => { const index = links.indexOf(link); if (index !== -1) links.splice(index, 1); },
      dirty: () => false,
      updateConfigNodeUsers: () => {},
      workspace: (id) => id === "tab-1" ? { id } : null,
      group: () => null,
      junctions: () => []
    },
    workspaces: { active: () => "tab-1" },
    editor: {
      validateNode: (node) => {
        if (options.invalidIds && options.invalidIds.has(node.id)) {
          node.valid = false;
          node.validationErrors = ["Error in JavaScript code"];
        } else {
          node.valid = true;
          delete node.validationErrors;
        }
        if (options.addProperty && !Object.prototype.hasOwnProperty.call(node, options.addProperty)) {
          node[options.addProperty] = "added by editor";
        }
      }
    },
    view: { redraw: () => {} },
    history: { push: (event) => history.push(event) }
  };
  return { red, nodes, links, history };
}

function loadCore(red) {
  const order = require(path.join(root, "lib", "build-core-script.js")).FRAGMENT_ORDER;
  const source = [
    "(function () {\n\"use strict\";",
    order.map((name) => fs.readFileSync(path.join(root, "lib", "core", name), "utf8")).join("\n"),
    "window.__r4d = { executeAgentToolCall, validateFlow, verifyWriteAgainstEditor: typeof verifyWriteAgainstEditor === 'function' ? verifyWriteAgainstEditor : function () { return { ok: false, errors: ['verifyWriteAgainstEditor is unavailable'] }; } };",
    "})();"
  ].join("\n");
  const sandbox = {
    RED: red,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    $: () => ({ length: 0 }),
    document: {},
    location: { origin: "http://localhost" }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "flowpilot-core-r4-d.js" });
  return sandbox.__r4d;
}

function applyStep(api, args) {
  return api.executeAgentToolCall({
    function: { name: "apply_step", arguments: JSON.stringify(args) }
  }, {}, [], { pending: [], connected: [], failed: [], expected: [] });
}

function snapshot(node) {
  const result = {};
  Object.keys(node).forEach((key) => {
    if (key[0] !== "_") { result[key] = node[key]; }
  });
  return result;
}

test("function modify does not add noerr to a node that did not have it", () => {
  const fn = { id: "fn", type: "function", name: "Original", func: "return msg;", wires: [[]], z: "tab-1" };
  const env = makeRed([fn]);
  const api = loadCore(env.red);
  const result = applyStep(api, {
    summary: "Rename the function",
    changes: [{ id: "fn", set: { name: "Renamed", noerr: true } }]
  });
  assert.equal(Object.prototype.hasOwnProperty.call(env.nodes.fn, "noerr"), false);
  assert.equal(env.nodes.fn.name, "Renamed");
  assert.equal(env.nodes.fn.valid, true);
  assert.notEqual(result.allPass, false, "the valid write is not rejected");
});

test("modify sets only explicit properties and rejects or strips a stray addition", () => {
  const fn = { id: "fn", type: "function", name: "Original", func: "return msg;", wires: [[]], z: "tab-1" };
  const before = snapshot(fn);
  const env = makeRed([fn], { addProperty: "strayAddedByEditor" });
  const api = loadCore(env.red);
  const result = applyStep(api, {
    summary: "Rename only",
    changes: [{ id: "fn", set: { name: "Renamed" } }]
  });
  assert.ok(env.nodes.fn.name === "Renamed" || env.nodes.fn.name === "Original");
  assert.equal(Object.prototype.hasOwnProperty.call(env.nodes.fn, "strayAddedByEditor"), false,
    "a property not present before the write must not land");
  Object.keys(before).forEach((key) => {
    if (key !== "name") { assert.deepEqual(env.nodes.fn[key], before[key], key + " is unchanged"); }
  });
  assert.ok(result.error || result.allPass, "the write either reports a specific refusal or passes after stripping");
});

test("RED.editor validation failure fails the write with the node name and does not pass", () => {
  const fn = { id: "fn", type: "function", name: "Broken function", func: "return msg;", wires: [[]], z: "tab-1" };
  const env = makeRed([fn], { invalidIds: new Set(["fn"]) });
  const api = loadCore(env.red);
  const result = applyStep(api, {
    summary: "Change the invalid function",
    changes: [{ id: "fn", set: { name: "Still broken" } }]
  });
  assert.equal(result.allPass, false);
  assert.match(String(result.error || result.reason || JSON.stringify(result)), /Broken function|fn|invalid|validation/i);
});

test("verifyWriteAgainstEditor reports missing node, wire, overlap, and unexpected property separately", () => {
  const a = { id: "a", type: "function", name: "A", x: 100, y: 100, w: 100, h: 30, z: "tab-1", wires: [[]] };
  const b = { id: "b", type: "debug", name: "B", x: 100, y: 100, w: 100, h: 30, z: "tab-1", wires: [[]] };
  const env = makeRed([a, b]);
  const api = loadCore(env.red);
  const before = { a: snapshot(a), b: snapshot(b) };

  let result = api.verifyWriteAgainstEditor({ nodeIds: ["missing"], before: {} });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /missing node.*missing/i);

  result = api.verifyWriteAgainstEditor({
    nodeIds: ["a", "b"],
    wires: [{ from: "a", fromPort: 0, to: "b" }],
    before,
    explicitKeys: { a: [], b: [] }
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /wire.*a.*b|a.*b.*wire/i);

  result = api.verifyWriteAgainstEditor({ nodeIds: ["a", "b"], before, explicitKeys: { a: [], b: [] } });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /overlap/i);

  a.stray = "unexpected";
  result = api.verifyWriteAgainstEditor({ nodeIds: ["a"], before, explicitKeys: { a: [] } });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /unexpected.*stray|stray.*unexpected/i);
});

test("consent auto-approves core in-editor nodes and asks for outside effects or unknown types", () => {
  ["template", "delay", "trigger", "rbe", "range", "catch", "complete", "group"].forEach((type) => {
    assert.equal(consent.decideConsent("create", type), "auto", type + " is in-editor safe");
  });
  ["http request", "mqtt out", "exec", "file", "unknown-addon"].forEach((type) => {
    assert.equal(consent.decideConsent("create", type), "ask", type + " reaches outside or is unknown");
  });
});

test("group and junction are not reported as missing node types", () => {
  const api = loadCore(makeRed().red);
  const result = api.validateFlow([
    { id: "g", type: "group" },
    { id: "j", type: "junction" }
  ], { isInstalled: () => false });
  assert.equal(result.failures.some((failure) => /not installed/i.test(failure.message)), false);
});
