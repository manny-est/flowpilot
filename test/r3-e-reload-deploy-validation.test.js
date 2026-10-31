"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const {
  deployValidationMessage,
  invalidDeployNodes,
  missingReferencedNodeIds,
  restoreVisibleView,
  serializeVisibleRecords,
  transcriptUserText
} = require("../lib/conversation-view");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "main.js"), "utf8");
const historySource = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "history.js"), "utf8");
const modesSource = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");
const flowpilotSource = fs.readFileSync(path.join(__dirname, "..", "flowpilot.js"), "utf8");

test("persist and restore keeps the visible user turn, cards, and used controls", function () {
  const records = [
    { id: 1, kind: "chat", role: "user", text: "Use my exact weather request." },
    { id: 2, kind: "chip", chipType: "proposeAction", decision: "act",
      proposeAction: { action: "build", summary: "Plan: restated internal goal", targets: [] } },
    { id: 3, kind: "question", agentToolConsent: true, decision: "skip", args: { nodeId: "mqtt-1" } },
    { id: 4, kind: "todo", cardType: "result", undone: false,
      changedNodes: [{ id: "weather-1", name: "Fetch Weather", type: "http request" }] }
  ];
  const restored = restoreVisibleView({ records: serializeVisibleRecords(records) });
  assert.deepStrictEqual(restored.records, records);
  assert.strictEqual(restored.records.filter(function (r) { return r.kind === "chat" && r.role === "user"; })[0].text,
    "Use my exact weather request.");
  assert.strictEqual(restored.records[1].proposeAction.summary, "Plan: restated internal goal");
  assert.strictEqual(restored.records[1].decision, "act");
  assert.strictEqual(restored.records[2].decision, "skip");
  assert.strictEqual(restored.records[3].cardType, "result");
});

test("the dispatched plan payload never becomes the persisted user turn", function () {
  assert.strictEqual(
    transcriptUserText("Plan: restated internal goal", "Use my exact weather request.", true),
    "Use my exact weather request."
  );
  assert.match(flowpilotSource, /transcriptPrompt/);
  assert.match(modesSource, /fromAct/);
});

test("reload notice is based only on restored records that reference missing live nodes", function () {
  const records = [{ kind: "todo", targetLock: { ids: ["present", "gone"] } }];
  assert.deepStrictEqual(missingReferencedNodeIds(records, function (id) { return id === "present"; }), ["gone"]);
  assert.match(mainSource, /Some nodes from this chat weren't deployed and are gone after the reload\./);
});

test("invalid regular and config nodes produce the plain deploy-blocking message", function () {
  const invalid = invalidDeployNodes([
    { id: "bad-http", name: "Fetch Weather", type: "http request", valid: false },
    { id: "ok", name: "Debug", type: "debug", valid: true }
  ], [{ id: "bad-mqtt", name: "MQTT Out", type: "mqtt out", valid: false }]);
  assert.strictEqual(invalid.length, 2);
  assert.strictEqual(deployValidationMessage(invalid),
    'Can\'t deploy yet: Node-RED reports 2 nodes as not properly configured: "Fetch Weather" (http request), "MQTT Out" (mqtt out). Fix them, or remove them, and try again.');
  assert.match(mainSource, /RED\.nodes\.eachConfig/);
  assert.match(mainSource, /deployValidation/);
});

test("all valid nodes leave the deploy action available", function () {
  const valid = invalidDeployNodes([{ type: "inject", valid: true }], [{ type: "mqtt-broker", valid: true }]);
  assert.deepStrictEqual(valid, []);
  assert.match(mainSource, /RED\.actions\.invoke\("core:deploy-flows"\)/);
});
