"use strict";
// Prompt fuzzer (typo-04/07, bug-03/05): typos in names and "the X flow"
// references got a "Which node?" picker.
const assert = require("node:assert/strict");
const test = require("node:test");
const intake = require("../lib/core/intake.js");
const c = (id, name, inTab) => ({ id, name, type: "function", inActiveTab: inTab !== false });
const cands = [c("t", "Temperature sensor"), c("p", "Parse payload"), c("o", "Sensor output")];
test("one close name match resolves; none or two don't", () => {
  assert.deepEqual(intake.resolveIntakeTarget("Rename Temprature sensor to Indoor", [], cands, null).ids, ["t"]);
  assert.equal(intake.resolveIntakeTarget("Rename Zebra to Indoor", [], cands, null).kind, "unresolved");
  const two = [c("a", "Sensor alpha"), c("b", "Sensor alphb")];
  assert.equal(intake.resolveIntakeTarget("rename Sensor alpah", [], two, null).ids.length === 1, false);
});
test("'the X flow' targets the active tab's nodes; 'a new flow' doesn't", () => {
  assert.deepEqual(intake.resolveIntakeTarget("Fix the sensor flow so its JSON is parsed", [], cands, null).ids.sort(), ["o", "p", "t"]);
  assert.equal(intake.resolveIntakeTarget("Build a new flow that polls", [], cands, null).kind, "unresolved");
});
test("a wire's source is validated (debug has no outputs)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "../lib/core/validate.js"), "utf8");
  assert.match(src, /args\.newWires[\s\S]{0,300}addId\(typeof wire\.from/);
});

test("a plan-envelope final reply is nudged once and never shown raw", () => {
  const modes = require("fs").readFileSync(require("path").join(__dirname, "../lib/core/modes.js"), "utf8");
  assert.match(modes, /if \(nudgePlanOnlyReply\(finalMessages, data\)\) \{ return; \}/);
  const body = modes.slice(modes.indexOf("function planEnvelopeText"), modes.indexOf("function nudgePlanOnlyReply"));
  const planEnvelopeText = new Function(body + "; return planEnvelopeText;")();
  assert.equal(planEnvelopeText('{"summary":"Add a comment","plan_items":["x"]}'), "Add a comment");
  assert.equal(planEnvelopeText("Renamed it."), null);
});
