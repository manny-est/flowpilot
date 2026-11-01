"use strict";
// QA pass 4: Settings showed "FlowPilot v0.6.1" after a Save; settings.json
// held a stale stored flowpilotVersion that the save response echoed.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createStorage = require("../lib/storage.js");

test("flowpilotVersion is never stored, and is dropped from old settings files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ver-"));
  fs.mkdirSync(path.join(dir, "flowpilot"), { recursive: true });
  const file = path.join(dir, "flowpilot", "settings.json");
  fs.writeFileSync(file, JSON.stringify({ flowpilotVersion: "0.6.1", auto: true }));
  const storage = createStorage(dir);
  const saved = storage.saveSettings({ flowpilotVersion: "0.6.1", auto: true });
  assert.equal(saved.flowpilotVersion, undefined);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).flowpilotVersion, undefined);
  assert.equal(storage.getSettings().flowpilotVersion, undefined);
});
