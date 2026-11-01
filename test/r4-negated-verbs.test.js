"use strict";
// Prompt fuzzer, round 4: a negated verb ("but do not delete any nodes") is a
// constraint, never the pre-router's chosen action.
const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@node-red/registry") { return {}; }
  return originalLoad.call(this, request, parent, isMain);
};
const runtime = require("../flowpilot.js");
Module._load = originalLoad;

function summaryOf(prompt, context) {
  const result = runtime.runDeterministicPreRouter(prompt, context || { nodes: [] });
  if (!result) { return null; }
  const call = result.toolCalls[0];
  return JSON.parse(call.function.arguments).summary;
}

test("a negated delete or add is not the request", () => {
  const sel = { nodes: [{ id: "debug-weather", type: "debug", name: "Weather output" }] };
  const s1 = summaryOf("Change the weather output, but do not delete any nodes.", sel);
  assert.ok(s1 === null || !/\bdelete\b/i.test(s1), "no 'I will delete' for a no-delete constraint: " + s1);
  const s2 = summaryOf("Keep the weather flow, but do not add another HTTP node.");
  assert.ok(s2 === null || !/\badd\b/i.test(s2), "no 'add' for a no-add constraint: " + s2);
  const s3 = summaryOf("Delete the selected node but do not add a replacement.", sel);
  assert.match(String(s3), /I will delete/i, "the real verb still wins");
});

test("plain verbs still pre-route", () => {
  const sel = { nodes: [{ id: "a", type: "debug", name: "Out" }] };
  assert.match(String(summaryOf("Delete the selected node", sel)), /delete/i);
  assert.match(String(summaryOf("Add a debug node after this", sel)), /add/i);
});
