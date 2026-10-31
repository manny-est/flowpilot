"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@node-red/registry") { return {}; }
  return originalLoad.call(this, request, parent, isMain);
};

const runtime = require("../flowpilot.js");
const intake = require("../lib/core/intake");
const replan = require("../lib/core/replan");
const lanes = require("../lib/core/lanes");

function proposalArgs(result) {
  assert.ok(result && result.toolCalls && result.toolCalls.length === 1, "one proposal tool call");
  return JSON.parse(result.toolCalls[0].function.arguments);
}

// Slash commands with inline text are sends; bare commands remain armed.
assert.deepStrictEqual(intake.slashCommandIntent("/build fetch weather"), {
  command: "/build", rest: "fetch weather", mode: "build", send: true
});
assert.deepStrictEqual(intake.slashCommandIntent("/build"), {
  command: "/build", rest: "", mode: "build", send: false
});
assert.deepStrictEqual(intake.slashCommandIntent("/plan review this"), {
  command: "/plan", rest: "review this", mode: "plan", send: true
});

// Small talk is a deterministic chat answer, while an actionable greeting is
// allowed through to normal routing.
["hi", "thanks!", "hello there", "how are you?"] .forEach(function (text) {
  assert.strictEqual(runtime.isSmallTalk(text), true, text + " is small talk");
});
assert.strictEqual(runtime.isSmallTalk("hi, add a debug node"), false, "actionable greeting is not small talk");

// Empty-tab vague creation asks for a node type; an empty Modify is a plain
// instruction rather than an unapprovable plan card.
assert.deepStrictEqual(intake.emptyRequestAction("add a node", []), {
  kind: "node-type", options: ["inject", "debug", "function", "change", "http request", "Other"]
});
assert.deepStrictEqual(intake.emptyRequestAction("/modify change it", []), {
  kind: "modify-empty", message: "Select the node(s) to change, then send again."
});

// A queued comment is a creation request on the current tab, never Document.
const commentArgs = proposalArgs(runtime.runDeterministicPreRouter(
  "add a comment node explaining the flow", { nodes: [] }
));
assert.strictEqual(commentArgs.action, "generate");
assert.strictEqual(commentArgs.needs_selection, false);
assert.strictEqual(lanes.chooseLane({ message: "add a comment node explaining the flow", activeTab: { id: "tab-1" } }, commentArgs).lane, "PLAN");

// Re-plan contains only unbuilt work, names completed nodes, and has a
// terminal state when all approved work is already present.
const plan = ["Add an inject node named Start", "Add an http request node named Fetch", "Add a debug node named Output", "Connect the flow", "Verify the result"];
const reduced = replan.reducePlan(plan, [
  { id: "n1", name: "Start", type: "inject" },
  { id: "n2", name: "Fetch", type: "http request" },
  { id: "n3", name: "Output", type: "debug" }
], { completedCount: 4 });
assert.deepStrictEqual(reduced.remaining, ["Verify the result"]);
assert.deepStrictEqual(reduced.alreadyBuilt, ["Start", "Fetch", "Output"]);
assert.ok(!JSON.stringify(reduced).includes("n1"), "re-plan does not expose raw ids");
assert.strictEqual(replan.reducePlan(plan, [
  { id: "n1", name: "Start", type: "inject" },
  { id: "n2", name: "Fetch", type: "http request" },
  { id: "n3", name: "Output", type: "debug" }
], { completedCount: 5 }).remaining.length, 0);

const modes = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");
const init = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "init.js"), "utf8");
const history = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "history.js"), "utf8");

assert.match(modes, /hidePending\(true\)/, "question pauses retain the working Stop control");
assert.match(modes, /popDanglingUserHistory\(\)/, "ending a run removes its unfinished user turn");
assert.match(modes, /if \(!remaining\.length\)[\s\S]{0,180}Done/, "completed re-plans show Done instead of an empty card");
assert.match(modes, /a node that no longer exists/, "re-plan labels deleted targets without raw ids");
assert.match(init, /if \(rest\)[\s\S]{0,180}dispatchSend\(\)/, "inline slash commands dispatch their rest text");
assert.match(history, /function popDanglingUserHistory/, "history has an explicit unfinished-turn cleanup path");

console.log("R3-D intake/re-plan/stop regression tests passed");
