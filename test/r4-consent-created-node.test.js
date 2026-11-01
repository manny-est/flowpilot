"use strict";
// QA pass 4 (S20, S8c): the user approved adding an http request node, then
// FlowPilot asked again before changing that same node in the same run. The
// approval was remembered under the model's placeholder id; the change used
// the real id Node-RED assigned.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const consent = require("../lib/core/consent.js");

test("an approval remembered under the real id covers a later change in the same run", () => {
  const memory = consent.createConsentMemory();
  memory.remember("run-1", "n2");            // placeholder, at Proceed
  const ctx = id => ({ memory: memory, taskId: "run-1", nodeId: id });
  assert.equal(consent.decideConsent("modify-config", "http request", ctx("a1b2c3")), "ask",
    "placeholder-only memory misses the real id (the bug)");
  memory.remember("run-1", "a1b2c3");        // real id, after the write applied
  assert.equal(consent.decideConsent("modify-config", "http request", ctx("a1b2c3")), "auto");
  assert.equal(consent.decideConsent("delete", "http request", ctx("a1b2c3")), "ask", "delete still always asks");
  assert.equal(consent.decideConsent("modify-config", "http request", { memory: memory, taskId: "run-2", nodeId: "a1b2c3" }), "ask",
    "approval never carries to another run");
});

test("the agent loop remembers the real id after an approved write is applied", () => {
  const modes = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");
  const at = modes.indexOf("var result = runExecutorIdempotent();");
  assert.ok(at > 0);
  const after = modes.slice(at, at + 900);
  assert.match(after, /runIdMap\[item\.nodeId\][\s\S]{0,120}runConsentMemory\.remember\(runId, realId\)/);
});

test("Stop at a consent gate can't throw before releasing the run", () => {
  const modes = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");
  assert.doesNotMatch(modes, /activeActRun\.changedNodes = runRec\.changedNodes\.slice\(\)/,
    "a consent-gate record has no changedNodes yet");
  const end = modes.slice(modes.indexOf("function endActiveRun"), modes.indexOf("function queueMessage"));
  assert.match(end, /stopStep\("cancel"/);
  assert.ok(end.indexOf("stopStep(\"cancel\"") < end.indexOf("setBusy(false)"), "the release comes after guarded steps");
});
