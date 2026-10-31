"use strict";
// Live S9 (nodered, gpt-4.1): "Stop and do this instead" after the build wrote
// its nodes left them with no result card and made Re-plan offer the whole
// plan again (approving it built a duplicate flow).
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const modes = fs.readFileSync(path.join(__dirname, "../lib/core/modes.js"), "utf8");
const replan = require("../lib/core/replan.js");
test("a stop at a pause records the run's writes before onDone", () => {
  const body = modes.slice(modes.indexOf("function endRunFromPause("), modes.indexOf("function endRunFromPause(") + 1500);
  assert.ok(body.indexOf("captureRunWrites()") !== -1 && body.indexOf("captureRunWrites()") < body.indexOf("onDone("));
  assert.match(modes, /function interruptRun\(detail\) \{[\s\S]{0,200}captureRunWrites\(\);/);
});
test("with the built nodes recorded, Re-plan has nothing left for a fully built plan", () => {
  const items = ["Add an inject node set to trigger every 5 minutes", "Add an http request node to fetch the weather",
    "Add a function node to store the temperature", "Add a debug node to show it"];
  const built = [{ id: "a", type: "inject" }, { id: "b", type: "http request" }, { id: "c", type: "function" }, { id: "d", type: "debug" }];
  assert.deepEqual(replan.reducePlan(items, built, {}).remaining, []);
  assert.equal(replan.reducePlan(items, [], {}).remaining.length, 4, "without them (the bug) everything looks left");
});
