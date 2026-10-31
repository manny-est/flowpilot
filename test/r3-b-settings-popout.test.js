"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "lib/core/main.js"), "utf8");
const init = fs.readFileSync(path.join(root, "lib/core/init.js"), "utf8");
const limits = require(path.join(root, "lib/core/limits.js"));

test("saving an untouched automatic ceiling keeps UserSet false and derives above 50k", () => {
  const saved = limits.readAgentLoopTokenCeilingSettings({
    agentLoopTokenCeiling: 50000,
    agentLoopTokenCeilingUserSet: false
  }, "");
  assert.equal(saved.agentLoopTokenCeilingUserSet, false);
  assert.ok(limits.deriveAgentLoopTokenCeiling(saved, { numCtx: 0 }, 8) > 50000);
});

test("changing the ceiling field marks it as a user choice", () => {
  const saved = limits.readAgentLoopTokenCeilingSettings({
    agentLoopTokenCeiling: 50000,
    agentLoopTokenCeilingUserSet: false
  }, "43210");
  assert.equal(saved.agentLoopTokenCeiling, 43210);
  assert.equal(saved.agentLoopTokenCeilingUserSet, true);
  assert.equal(limits.deriveAgentLoopTokenCeiling(saved, { numCtx: 0 }, 8), 43210);
});

test("the beta.3 50000 override migrates back to automatic", () => {
  const legacy = { agentLoopTokenCeiling: 50000, agentLoopTokenCeilingUserSet: true };
  assert.ok(limits.deriveAgentLoopTokenCeiling(legacy, { numCtx: 0 }, 8) > 50000);
  const deliberate = Object.assign({}, legacy, { agentLoopTokenCeilingUserSetV2: true });
  assert.equal(limits.deriveAgentLoopTokenCeiling(deliberate, { numCtx: 0 }, 8), 50000);
});

test("Auto saves silently and does not append a chat confirmation", () => {
  assert.match(init, /#fp-auto-toggle[\s\S]{0,180}saveSettings\(null, false, true\)/);
  assert.doesNotMatch(main, /if \(!silent\) \{ addMessage\("assistant", "Settings saved\."\); \}/);
});

test("automatic ceiling is shown as a model-specific hint", () => {
  assert.match(init, /fp-agent-loop-token-ceiling-hint/);
  assert.match(main, /Automatic: " \+ automatic\.toLocaleString\(\) \+ " for this model/);
  assert.match(main, /readAgentLoopTokenCeilingSettings\(/);
});

test("settings changes use the existing parent-child postMessage channel", () => {
  assert.match(init, /function relaySettingsToPopout\(/);
  assert.match(init, /event: "settingsLoaded", settings: currentSettings/);
  assert.match(init, /data\.event === "settingsLoaded"[\s\S]{0,180}fillSettings\(data\.settings/);
  assert.match(main, /saveSettings POST response[\s\S]{0,260}relaySettingsToPopout\(\)/);
});

test("Clear resets the pop-out transcript and its status strip", () => {
  assert.match(main, /relayClearMessagesToPopout\(\);[\s\S]{0,500}conversationHistory = \[\];/);
  assert.match(main, /clearRunMarker\("clearChat"\);[\s\S]{0,180}updateSelectionStatus\(\);/);
  assert.match(init, /data\.event === "clearMessages"[\s\S]{0,300}renderEmptyState\(\)/);
  assert.match(init, /data\.event === "statusStripSync"[\s\S]{0,500}fp-size-status/);
});
