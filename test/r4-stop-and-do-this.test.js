"use strict";
// QA pass 4b (S9): after "Stop and do this instead", a Re-plan card for the
// old plan appeared and competed with the queued request, which then ran as
// the old plan. The user chose new work; the old plan isn't offered back.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const modes = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");

test("a run stopped for a queued message ends without a Re-plan card", () => {
  const src = modes.match(/function finishActRun\(\) \{[\s\S]*?\n    \}\n/)[0];
  const calls = [];
  const fn = new Function("activeActRunRef", "renderReplanChip", "disarmExecuteAction",
    "var activeActRun = activeActRunRef; var armedExecuteAction = null; var recentActBuild = null;\n" + src + "return finishActRun;");
  const run = outcome => fn({ proposal: { action: "build" }, outcome: outcome }, function (r, o) { calls.push(o.reason); }, function () {})();
  run({ state: "cancelled", reason: "queued-message" });
  assert.deepEqual(calls, [], "no Re-plan for Stop and do this instead");
  run({ state: "honest-stop", reason: "stopped by user" });
  assert.deepEqual(calls, ["stopped by user"], "a plain Stop still offers Re-plan");
});

test("the stop records the queued-message reason that finishActRun checks", () => {
  assert.match(modes, /endRunFromPause\("queued-message", "stop-and-do-this"/);
});
