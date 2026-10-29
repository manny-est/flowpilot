"use strict";

const assert = require("assert");
const fs = require("fs");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@node-red/registry") { return {}; }
  return originalLoad.call(this, request, parent, isMain);
};

const flowPilotRuntime = require("../flowpilot.js");
const intake = require("../lib/core/intake");
const tierPrompt = require("../lib/tier-c-classification-prompt");

function proposalArgs(result) {
  assert.ok(result && result.toolCalls && result.toolCalls.length === 1, "one proposal tool call");
  assert.strictEqual(result.toolCalls[0].function.name, "propose_action");
  return JSON.parse(result.toolCalls[0].function.arguments);
}

// #1: “make the/this existing node” is a change to a known node, while
// “make a new” remains creation.
const makeExisting = flowPilotRuntime.runDeterministicPreRouter(
  "Make the Timer node fire every 5 seconds.",
  { nodes: [{ id: "timer-1", type: "inject", name: "Timer" }] }
);
assert.strictEqual(proposalArgs(makeExisting).action, "modify");
assert.deepStrictEqual(proposalArgs(makeExisting).targets, ["timer-1"]);
const makeOpenTabNode = flowPilotRuntime.runDeterministicPreRouter(
  "Make the existing Weather Timer node fire every 5 seconds.",
  { openTabNodes: [
    { id: "timer-2", type: "inject", name: "Weather Timer" },
    { id: "debug-2", type: "debug", name: "Output" }
  ] }
);
assert.deepStrictEqual(proposalArgs(makeOpenTabNode).targets, ["timer-2"]);
const makeNew = flowPilotRuntime.runDeterministicPreRouter("Make a new flow with an inject node.", {});
assert.strictEqual(proposalArgs(makeNew).action, "generate");

// #2: the routing classifier must recognize deploy/check requests as Build.
assert.match(tierPrompt, /Deploy this flow and check that it works/);
assert.match(tierPrompt, /Assistant:\nE/);

// #3: slash-command text is preserved after arming each action.
assert.deepStrictEqual(intake.parseSlashCommand("/build fetch weather every 5 min"), {
  command: "/build", rest: "fetch weather every 5 min"
});
assert.deepStrictEqual(intake.parseSlashCommand("/generate a weather flow"), {
  command: "/generate", rest: "a weather flow"
});
assert.deepStrictEqual(intake.parseSlashCommand("/modify rename Timer"), {
  command: "/modify", rest: "rename Timer"
});
assert.deepStrictEqual(intake.parseSlashCommand("/document explain the tab"), {
  command: "/document", rest: "explain the tab"
});

// #4/#40: F is an intent question, so its own options must win over target
// candidates; explanations, greetings, and creative requests are classifier
// examples rather than target-picking requests.
const fArgs = JSON.parse(flowPilotRuntime.tierCClassificationToResult("F", "surprise me", {}).result.toolCalls[0].function.arguments);
assert.strictEqual(fArgs.question_kind, "intent");
assert.deepStrictEqual(fArgs.options, ["Answer", "Create", "Change", "Document", "Build"]);
const candidates = [{ id: "n1", name: "Timer", type: "inject" }];
assert.deepStrictEqual(intake.askUserOptions(
  { target: { kind: "unresolved" }, candidates: candidates },
  fArgs
), fArgs.options);
assert.match(tierPrompt, /Explain what this flow does in plain English/);
assert.match(tierPrompt, /User: "hi"/);
assert.match(tierPrompt, /Do something cool and unique/);

// The one-shot Build correction is deliberately exact and only appears once
// in the loop path.
const modesSource = fs.readFileSync(require.resolve("../lib/core/modes.js"), "utf8");
assert.match(modesSource, /The user asked you to deploy and check it; call deploy_flows and verify_runtime/);
assert.match(modesSource, /askUserOptions\(payload\.intake, args\)/);

console.log("P2-A routing tests passed");
