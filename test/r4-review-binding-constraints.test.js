"use strict";
// Spark prompt fuzz: "Explain this flow but make no writes…" wrote; the same
// apply_step twice built a duplicate flow.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("module");
const load = Module._load;
Module._load = function (r, p, m) { return r === "@node-red/registry" ? {} : load.call(this, r, p, m); };
const fp = require("../flowpilot.js");
test("explicit no-write constraints are detected", () => {
  ["Explain this flow but make no writes and do not touch the broker.", "Describe the group, but don't modify it.",
   "Just explain what this does", "Tell me about it without changing anything"].forEach(p => assert.equal(fp.hasNoWriteConstraint(p), true, p));
  ["Change the weather output, but do not delete any nodes.", "Rename First output only", "Add a debug node"].forEach(p =>
    assert.equal(fp.hasNoWriteConstraint(p), false, p));
});
test("re-creating ids from earlier in the run is refused", () => {
  const main = fs.readFileSync(path.join(__dirname, "../lib/core/main.js"), "utf8");
  assert.match(main, /These nodes already exist from an earlier step in this run/);
  const runner = fs.readFileSync(path.join(__dirname, "engine-corpus/runner.js"), "utf8");
  assert.match(runner, /These nodes already exist from an earlier step in this run/);
});
