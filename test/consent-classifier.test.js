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
const collect = main.match(/function collectWriteToolConsentItems\(name, args, idMap\) \{[\s\S]*?\n    \}\n/)[0];
const isEmptyWrite = main.match(/function writeToolCallIsEmpty\(name, args\) \{[\s\S]*?\n    \}\n/)[0];
const decision = isEmptyWrite + main.match(/function writeToolCallConsentDecision\(tier, name, args, consentContext\) \{[\s\S]*?\n    \}\n/)[0];
const gate = main.match(/function writeToolCallNeedsConsent\(tier, name, args, consentContext\) \{[\s\S]*?\n    \}\n/)[0];
const consentSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "consent.js"), "utf8").replace(/if \(typeof module[\s\S]*$/, "");
const LIVE = { "fn1": { type: "function" }, "http1": { type: "http request" }, "dbg1": { type: "debug" } };
const needs = new Function("findLiveNode", consentSrc + collect + decision + gate + "return writeToolCallNeedsConsent;")(function (id) { return LIVE[id] || null; });

assert.strictEqual(needs("write-safe", "group_nodes", {}), false, "write-safe tier never gated");
assert.strictEqual(needs("write-gated", "apply_step", { newNodes: [{ id: "x", type: "debug" }] }), false, "safe create auto");
assert.strictEqual(needs("write-gated", "apply_step", { newNodes: [{ id: "x", type: "http request" }] }), true, "side-effecting create asks");
assert.strictEqual(needs("write-gated", "apply_step", { newNodes: [
  { id: "inject-1", type: "inject" }, { id: "http-1", type: "http request" }
] }), true, "a mixed create step asks for its http request");
assert.strictEqual(needs("write-gated", "apply_step", { newNodes: [{ id: "x", type: "mqtt out" }], newWires: [{ from: "fn1", to: "x" }] }), true, "create + wire to new side-effecting node asks");
assert.strictEqual(needs("write-gated", "apply_step", { newWires: [{ from: "fn1", to: "dbg1" }] }), false, "safe rewire auto");
assert.strictEqual(needs("write-gated", "apply_step", { changes: [{ id: "http1", set: { url: "x" } }] }), true, "modify side-effecting asks");
assert.strictEqual(needs("write-gated", "rename_node", { nodeId: "fn1", name: "y" }), false, "rename safe auto");
assert.strictEqual(needs("write-gated", "remove_step", { nodeId: "dbg1" }), true, "delete of a safe node asks");
assert.strictEqual(needs("write-gated", "rename_node", { nodeId: "ghost" }), true, "unresolvable id asks");
// Round 2 live check: an apply_step with nothing in it applies nothing (the
// tool answers "nothing to apply"), so asking only showed the user a vague
// "update the flow" question. An unresolvable id (above) still asks.
assert.strictEqual(needs("write-gated", "apply_step", {}), false, "an empty write asks nothing");
assert.strictEqual(needs("write-gated", "apply_step", { summary: "Add an inject node" }), false, "summary only asks nothing");
assert.strictEqual(needs("write-gated", "rename_node", { nodeId: "fn1" }, { hold: true }), true, "hold asks on a safe rename");
const m2 = consent.createConsentMemory(); m2.remember("r", "http1");
assert.strictEqual(needs("write-gated", "apply_step", { changes: [{ id: "http1", set: {} }] }, { memory: m2, taskId: "r" }), false, "approved node not re-asked in the same run");

assert.strictEqual(needs("write-gated", "apply_step", { newWires: [{ from: "fn1", to: "ph-dbg" }] }, { idMap: { "ph-dbg": "dbg1" } }), false,
  "a node created earlier in the run is classified by its real type via the run id map");
assert.strictEqual(needs("write-gated", "deploy_flows", { summary: "x" }), true, "deploy always asks");

// SF-6 plan card (live, Spark): Approve listed "Add a http request node", but
// wiring it in and setting its URL still asked. An approved create covers
// wiring/configuring the node the run created; nothing else.
const approvedHttp = { approvedOperations: [{ operation: "create", type: "http request", nodeId: null }] };
assert.strictEqual(needs("write-gated", "apply_step", { newNodes: [{ id: "h", type: "http request" }],
  newWires: [{ from: "fn1", to: "h" }] }, approvedHttp), false, "approved create + its wire doesn't ask");
assert.strictEqual(needs("write-gated", "apply_step", { changes: [{ id: "ph-h", set: { url: "u" } }] },
  Object.assign({ idMap: { "ph-h": "http2" } }, approvedHttp)), true,
  "an unknown live type still asks even if run-created");
LIVE.http2 = { type: "http request" };
assert.strictEqual(needs("write-gated", "apply_step", { changes: [{ id: "ph-h", set: { url: "u" } }] },
  Object.assign({ idMap: { "ph-h": "http2" } }, approvedHttp)), false, "configuring the run's own approved node doesn't ask");
assert.strictEqual(needs("write-gated", "apply_step", { changes: [{ id: "http1", set: { url: "u" } }] }, approvedHttp), true,
  "an existing http request node the run didn't create still asks");
assert.strictEqual(needs("write-gated", "apply_step", { newNodes: [{ id: "m", type: "mqtt out" }],
  newWires: [{ from: "fn1", to: "m" }] }, approvedHttp), true, "a type the plan didn't list still asks");
console.log("consent-classifier tests passed (" + cells + " table cells)");
