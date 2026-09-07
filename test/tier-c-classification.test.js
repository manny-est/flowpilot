"use strict";

const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@node-red/registry") {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const flowPilotRuntime = require("../flowpilot.js");
const parseTierCClassification = flowPilotRuntime.parseTierCClassification;
const tierCClassificationToResult = flowPilotRuntime.tierCClassificationToResult;

assert.strictEqual(typeof parseTierCClassification, "function", "Tier-C parser export");
assert.strictEqual(typeof tierCClassificationToResult, "function", "Tier-C mapper export");

[
  ["A", "A"],
  ["B.", "B"],
  ["I choose C for this.", "C"],
  ["The answer is D because documentation is requested.", "D"],
  ["E\nBuild and verify.", "E"],
  ["F - unclear", "F"]
].forEach(function (fixture) {
  assert.strictEqual(parseTierCClassification(fixture[0]).letter, fixture[1], "parses " + fixture[0]);
});

const ambiguous = parseTierCClassification("It could be B or C.");
assert.strictEqual(ambiguous.letter, "F", "ambiguous maps to F");
assert.strictEqual(ambiguous.ambiguous, true, "ambiguous flag");

const garbage = parseTierCClassification("not sure, please handle it");
assert.strictEqual(garbage.letter, "F", "garbage-input-routes-to-F");
assert.strictEqual(garbage.unparseable, true, "garbage input is unparseable");

const modify = tierCClassificationToResult("C", "Rename the selected inject node.", {
  nodes: [{ id: "n1", type: "inject", name: "Old" }]
});
assert.strictEqual(modify.result.toolCalls[0].function.name, "propose_action", "C creates proposal");
assert.deepStrictEqual(JSON.parse(modify.result.toolCalls[0].function.arguments), {
  action: "modify",
  summary: "I will change the existing Node-RED flow as requested: Rename the selected inject node.",
  targets: ["n1"],
  deploy_verify: false,
  confidence: "high",
  needs_selection: false,
  plan_items: []
}, "C reuses normalized propose_action shape");

const clarify = tierCClassificationToResult("B or C", "Add whatever is missing.", {});
assert.strictEqual(clarify.result.toolCalls[0].function.name, "ask_user", "ambiguous classification asks user");

const answer = tierCClassificationToResult("A\nUse a switch node for branching.", "How do I branch?", {});
assert.strictEqual(answer.result.content, "Use a switch node for branching.", "A returns visible answer prose");
assert.strictEqual(answer.result.toolCalls, null, "A has no tool call");

console.log("Tier-C classification tests passed");
