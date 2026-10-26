"use strict";

// R11-8 consent classifier: every cell of the operation × node-class table,
// the hold override, per-node-per-task memory, and the real client call
// site (writeToolCallNeedsConsent, main.js) evaluated against the module.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const consent = require("../lib/core/consent");

const SAFE = "function";
const SIDE = "http request";
const UNKNOWN = "node-red-contrib-something-new";

// operation → [safe, side-effecting] expectation (unknown = side-effecting)
const TABLE = {
  "create": ["auto", "ask"],
  "modify-config": ["auto", "ask"],
  "rewire": ["auto", "ask"],
  "delete": ["ask", "ask"],
  "deploy": ["ask", "ask"],
  "trigger": ["auto", "ask"]
};

assert.deepStrictEqual(Object.keys(TABLE).sort(), consent.OPERATIONS.slice().sort(), "table covers every operation");
let cells = 0;
Object.keys(TABLE).forEach(function (op) {
  const [safe, side] = TABLE[op];
  assert.strictEqual(consent.decideConsent(op, SAFE), safe, op + " × safe");
  assert.strictEqual(consent.decideConsent(op, SIDE), side, op + " × side-effecting");
  assert.strictEqual(consent.decideConsent(op, UNKNOWN), side, op + " × unknown");
  assert.strictEqual(consent.decideConsent(op, null), side, op + " × no type");
  // hold asks regardless
  assert.strictEqual(consent.decideConsent(op, SAFE, { hold: true }), "ask", op + " × safe × hold");
  assert.strictEqual(consent.decideConsent(op, SIDE, { hold: true }), "ask", op + " × side × hold");
  cells += 6;
});
consent.SAFE_NODE_TYPES.forEach(function (t) {
  assert.strictEqual(consent.decideConsent("create", t), "auto", "safe type " + t);
});
assert.strictEqual(consent.decideConsent("explode", SAFE), "ask", "unknown operation asks");

// memory: per node, per task; never for delete/deploy; hold still wins
const mem = consent.createConsentMemory();
mem.remember("run-1", "n-http");
const ctx = function (taskId, nodeId, extra) { return Object.assign({ memory: mem, taskId: taskId, nodeId: nodeId }, extra || {}); };
assert.strictEqual(consent.decideConsent("modify-config", SIDE, ctx("run-1", "n-http")), "auto", "remembered node, same task");
assert.strictEqual(consent.decideConsent("rewire", SIDE, ctx("run-1", "n-http")), "auto", "remembered node, other op, same task");
assert.strictEqual(consent.decideConsent("modify-config", SIDE, ctx("run-2", "n-http")), "ask", "re-asked in another task");
assert.strictEqual(consent.decideConsent("modify-config", SIDE, ctx("run-1", "n-other")), "ask", "another node asks");
assert.strictEqual(consent.decideConsent("delete", SIDE, ctx("run-1", "n-http")), "ask", "delete always asks");
assert.strictEqual(consent.decideConsent("deploy", SIDE, ctx("run-1", "n-http")), "ask", "deploy always asks");
assert.strictEqual(consent.decideConsent("modify-config", SIDE, ctx("run-1", "n-http", { hold: true })), "ask", "hold beats memory");

// Real client call site, evaluated with the module in the same scope.
const main = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "main.js"), "utf8");
const collect = main.match(/function collectWriteToolConsentItems\(name, args\) \{[\s\S]*?\n    \}\n/)[0];
const gate = main.match(/function writeToolCallNeedsConsent\(tier, name, args, consentContext\) \{[\s\S]*?\n    \}\n/)[0];
const consentSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "consent.js"), "utf8").replace(/if \(typeof module[\s\S]*$/, "");
const LIVE = { "fn1": { type: "function" }, "http1": { type: "http request" }, "dbg1": { type: "debug" } };
const needs = new Function("findLiveNode", consentSrc + collect + gate + "return writeToolCallNeedsConsent;")(function (id) { return LIVE[id] || null; });

assert.strictEqual(needs("write-safe", "group_nodes", {}), false, "write-safe tier never gated");
assert.strictEqual(needs("write-gated", "apply_step", { newNodes: [{ id: "x", type: "debug" }] }), false, "safe create auto");
assert.strictEqual(needs("write-gated", "apply_step", { newNodes: [{ id: "x", type: "http request" }] }), true, "side-effecting create asks");
assert.strictEqual(needs("write-gated", "apply_step", { newNodes: [{ id: "x", type: "mqtt out" }], newWires: [{ from: "fn1", to: "x" }] }), true, "create + wire to new side-effecting node asks");
assert.strictEqual(needs("write-gated", "apply_step", { newWires: [{ from: "fn1", to: "dbg1" }] }), false, "safe rewire auto");
assert.strictEqual(needs("write-gated", "apply_step", { changes: [{ id: "http1", set: { url: "x" } }] }), true, "modify side-effecting asks");
assert.strictEqual(needs("write-gated", "rename_node", { nodeId: "fn1", name: "y" }), false, "rename safe auto");
assert.strictEqual(needs("write-gated", "remove_step", { nodeId: "dbg1" }), true, "delete of a safe node asks");
assert.strictEqual(needs("write-gated", "rename_node", { nodeId: "ghost" }), true, "unresolvable id asks");
assert.strictEqual(needs("write-gated", "apply_step", {}), true, "nothing identifiable asks");
assert.strictEqual(needs("write-gated", "rename_node", { nodeId: "fn1" }, { hold: true }), true, "hold asks on a safe rename");
const m2 = consent.createConsentMemory(); m2.remember("r", "http1");
assert.strictEqual(needs("write-gated", "apply_step", { changes: [{ id: "http1", set: {} }] }, { memory: m2, taskId: "r" }), false, "approved node not re-asked in the same run");

console.log("consent-classifier tests passed (" + cells + " table cells)");
