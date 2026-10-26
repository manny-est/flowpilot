"use strict";

// graph-truth.js's verify lookups must see groups (RED.nodes.group), not
// only nodes (RED.nodes.node) — group_nodes verifies its new group by id.
// Runs the REAL fragment against a fake RED.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "graph-truth.js"), "utf8");
const nodes = { n1: { id: "n1", name: "Tick", g: "g1" } };
const groups = { g1: { id: "g1", name: "Input" } };
const RED = {
  nodes: {
    node: function (id) { return nodes[id] || null; },
    group: function (id) { return groups[id] || null; },
    eachLink: function () {}
  }
};
const api = new Function("RED", src + "\nreturn { nodeExists: nodeExists, nodeAbsent: nodeAbsent, propertyEquals: propertyEquals, readProperty: readProperty };")(RED);

assert.strictEqual(api.nodeExists("g1"), true, "a group exists");
assert.strictEqual(api.nodeAbsent("g1"), false, "a group is not absent");
assert.strictEqual(api.propertyEquals("g1", "name", "Input"), true, "group property check");
assert.deepStrictEqual(api.readProperty("g1", "name"), { exists: true, value: "Input" });
assert.strictEqual(api.propertyEquals("n1", "g", "g1"), true, "member's g points at the group");
assert.strictEqual(api.nodeExists("nope"), false, "unknown id");
console.log("graph-truth-groups tests passed");
