"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const truth = require("../lib/core/runtime-truth.js");
const storage = new Map();
global.window = { sessionStorage: {
  getItem: (key) => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
} };
global.location = { href: "http://test/" };
global.document = { readyState: "complete" };
const history = require("../lib/core/history.js");
const mainSource = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "main.js"), "utf8");
const modesSource = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");
const initSource = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "init.js"), "utf8");
const { buildCoreScript } = require("../lib/build-core-script.js");

const runNodes = [
  { id: "inject-1", type: "inject", z: "tab-1", name: "Start", payload: "hello", payloadType: "str" },
  { id: "fn-1", type: "function", z: "tab-1", name: "Upper", func: "msg.payload = msg.payload.toUpperCase();\\nreturn msg;" }
];
const runWires = [{ from: "inject-1", fromPort: 0, to: "fn-1" }];
const deployed = {
  rev: "rev-2",
  flows: [
    Object.assign({}, runNodes[0], { wires: [["fn-1"]] }),
    Object.assign({}, runNodes[1], { wires: [[]] })
  ]
};

function confirm(beforeRev, response) {
  return new Promise((resolve) => {
    truth.confirmDeploy(beforeRev, runNodes, runWires, resolve, function (done) {
      done(response);
    });
  });
}

test("compareRunToRuntime reports all matching nodes and wires as present", () => {
  const result = truth.compareRunToRuntime(runNodes, runWires, deployed);
  assert.deepStrictEqual(result.nodes.missing, []);
  assert.deepStrictEqual(result.nodes.differ, []);
  assert.deepStrictEqual(result.wires.missing, []);
  assert.deepStrictEqual(result.wires.differ, []);
});

test("compareRunToRuntime reports a missing node and missing wire", () => {
  const result = truth.compareRunToRuntime(runNodes, runWires, {
    rev: "rev-2",
    flows: [Object.assign({}, deployed.flows[0], { wires: [[]] })]
  });
  assert.deepStrictEqual(result.nodes.missing.map((node) => node.id), ["fn-1"]);
  assert.strictEqual(result.wires.missing.length, 1);
});

test("compareRunToRuntime reports node config and wire-port differences", () => {
  const result = truth.compareRunToRuntime(runNodes, runWires, {
    rev: "rev-2",
    flows: [
      Object.assign({}, deployed.flows[0], { wires: [["fn-1"]] }),
      Object.assign({}, deployed.flows[1], { name: "Changed", wires: [[]] })
    ]
  });
  assert.strictEqual(result.nodes.differ.length, 1);
  assert.strictEqual(result.nodes.differ[0].id, "fn-1");
  assert.strictEqual(result.wires.differ.length, 0);
  const wireDifference = truth.compareRunToRuntime(runNodes, [{ from: "inject-1", fromPort: 1, to: "fn-1" }], deployed);
  assert.strictEqual(wireDifference.wires.differ.length, 1);
});

test("confirmDeploy rejects an unchanged revision when the run changed the graph", async () => {
  const result = await confirm("rev-2", deployed);
  assert.strictEqual(result.confirmed, false);
  assert.strictEqual(result.rev, "rev-2");
  assert.match(result.reason, /revision/i);
});

test("confirmDeploy accepts a new revision with every run node and wire", async () => {
  const result = await confirm("rev-1", deployed);
  assert.strictEqual(result.confirmed, true);
  assert.strictEqual(result.rev, "rev-2");
  assert.deepStrictEqual(result.missing.nodes, []);
  assert.deepStrictEqual(result.missing.wires, []);
});

test("confirmDeploy turns a fetch failure into a readable unconfirmed result", async () => {
  const result = await confirm("rev-1", { error: "Admin API unavailable" });
  assert.strictEqual(result.confirmed, false);
  assert.match(result.reason, /Admin API unavailable/);
});

test("fetchDeployedFlows uses the editor auth and Node-RED v2 Admin API", () => {
  const oldDollar = global.$;
  const oldRed = global.RED;
  const oldUrl = global.flowpilotUrl;
  let request;
  global.RED = { settings: { get: () => ({ access_token: "editor-token" }) } };
  global.flowpilotUrl = (value) => "/manage/" + value;
  global.$ = { ajax: (options) => {
    request = options;
    const xhr = { setRequestHeader: (name, value) => { request[name] = value; } };
    options.beforeSend(xhr);
    options.success({ rev: "rev-7", flows: [] });
  } };
  try {
    let result;
    truth.fetchDeployedFlows((value) => { result = value; });
    assert.strictEqual(request.url, "/manage/flows");
    assert.strictEqual(request.headers["Node-RED-API-Version"], "v2");
    assert.strictEqual(request.Authorization, "Bearer editor-token");
    assert.deepStrictEqual(result, { rev: "rev-7", flows: [] });
  } finally {
    global.$ = oldDollar;
    global.RED = oldRed;
    global.flowpilotUrl = oldUrl;
  }
});

test("Test it refuses to claim a run when the target is not deployed", () => {
  const result = truth.runtimeProofOutcome([], {
    runtimeConfirmed: false,
    missingNodeNames: ["Upper"]
  });
  assert.match(result.label, /Not tested: Upper isn't deployed/);
  assert.doesNotMatch(result.label, /Ran/);
});

test("reload truth waits for flows to load and distinguishes runtime presence", () => {
  assert.strictEqual(truth.runtimeReloadNotice(["n1"], [], { flows: [] }, false), null);
  assert.strictEqual(truth.runtimeReloadNotice(["n1"], [], { flows: [{ id: "n1" }] }, true), null);
  assert.match(truth.runtimeReloadNotice(["n1"], [], { flows: [] }, true), /weren't deployed and are gone/);
});

test("an interrupted restore renders one notice and removes live progress", () => {
  const html = '<div id="fp-pending"><span class="fp-typing-label">Cruising…</span></div>' +
    '<div id="fp-working-status">Working on your flow · step 1</div>';
  const restored = history.sanitizeInterruptedRunViewHtml(html);
  assert.doesNotMatch(restored, /Cruising|Working on/);
  assert.strictEqual(history.interruptedRunNotice(2),
    "⚠ This run was interrupted after step 2 — completed steps are applied (Ctrl+Z to undo). Re-send to continue from here.");
});

test("runtime truth is wired into deploy, reload, and the assembled client", () => {
  assert.match(mainSource, /fetchDeployedFlows/);
  assert.match(mainSource, /confirmDeploy/);
  assert.match(mainSource, /flows:loaded/);
  assert.match(modesSource, /deployFlowsForBuild\([\s\S]*?runtime/);
  assert.match(initSource, /flows:loaded/);
  assert.match(mainSource, /runtimeProofOutcome\(\[\], initialPresence\)/);
  assert.match(buildCoreScript(), /function fetchDeployedFlows/);
});

console.log("R4-E runtime-truth regression tests loaded");

test("review: a config-only difference doesn't fail confirmation; a type change or missing node does; null beforeRev skips the rev test", () => {
  const rt = require("../lib/core/runtime-truth.js");
  const deployed = { rev: "r1", flows: [{ id: "a", type: "inject", z: "t", repeat: "" , wires: [["b"]] }, { id: "b", type: "debug", z: "t", wires: [] }] };
  const req = (ok) => ok(deployed);
  let out;
  rt.confirmDeploy(null, [{ id: "a", type: "inject", z: "t", repeat: "5" }, { id: "b", type: "debug", z: "t" }], [{ from: "a", fromPort: 0, to: "b" }], (r) => { out = r; }, req);
  assert.equal(out.confirmed, true);
  rt.confirmDeploy(null, [{ id: "b", type: "function", z: "t" }], [], (r) => { out = r; }, req);
  assert.equal(out.confirmed, false);
  rt.confirmDeploy("r1", [{ id: "a", type: "inject", z: "t" }], [], (r) => { out = r; }, req);
  assert.equal(out.confirmed, false);
});
