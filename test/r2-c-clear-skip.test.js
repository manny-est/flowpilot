"use strict";

// R2-C regression coverage. The Clear assertions load the browser core in the
// same VM harness used by P1-36; the consent and Build assertions exercise the
// real source fragments without starting Node-RED.
const assert = require("assert");
const test = require("node:test");
const fs = require("fs");
const path = require("path");
const consent = require("../lib/core/consent");
const { load } = require("./p1-36-clear-ends-run.test");

function extractFunction(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.notStrictEqual(start, -1, "found " + name);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") { depth++; }
    if (source[i] === "}" && --depth === 0) { return source.slice(start, i + 1); }
  }
  throw new Error("unterminated " + name);
}

// 1. Clear must leave the browser controls and conversation-scoped inputs as
// if the editor had just loaded, including when a run and a queued message
// were both present.
test("Clear resets all conversation and run state", () => {
  const h = load();
  h.api.arm("modify");
  h.api.query({ label: "Which node?", text: "Which node?" });
  h.api.setFlags({ planFirst: true, justDoIt: false });
  h.api.setPin(["old-selection"]);
  h.api.setIntake({ targetIds: ["old-target"], target: { kind: "named", ids: ["old-target"] } });
  h.api.setState({ ended: false, targetLock: { ids: ["old-target"] }, cancel: () => {} });
  h.api.setQueued({ text: "old queued message", deferred: false });
  h.dom.elements["#fp-prompt"].value = "draft from old chat";
  h.api.clear();

  const state = h.api.get();
  assert.strictEqual(state.armed, null, "Clear disarms Execute mode");
  assert.strictEqual(state.query, null, "Clear disarms Query intent");
  assert.strictEqual(state.flags, null, "Clear clears one-shot Send flags");
  assert.strictEqual(state.pin, null, "Clear clears pinned selection");
  assert.strictEqual(state.intake, null, "Clear clears pending intake and target lock source");
  assert.strictEqual(state.queued, null, "Clear discards queued text");
  assert.strictEqual(state.state, null, "Clear ends the old run state");
  assert.strictEqual(h.dom.elements["#fp-prompt"].value, "", "Clear clears the old draft");
  assert.strictEqual(state.records.length, 0, "Clear posts nothing into the new conversation");

  h.dom.elements["#fp-prompt"].value = "fresh prompt";
  h.api.sendRoute("chat");
  const payload = JSON.parse(h.context.ajaxCalls[0].options.data);
  assert.ok(!payload.targetLock, "fresh chat has no old target lock");
  assert.deepStrictEqual(payload.intake.targetIds, [], "fresh chat has no old target ids");
});

// 2. A skipped consent is remembered by operation + node type + target. The
// same call is therefore answered as skip without a second consent prompt.
test("skipped consent is remembered and not asked twice", () => {
  const memory = consent.createConsentMemory();
  memory.rememberDecision("run-1", "create", "http request", "http-1", "skipped");
  assert.strictEqual(memory.hasDecision("run-1", "create", "http request", "http-1", "skipped"), true,
    "skipped consent is remembered for the run");

  const main = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "main.js"), "utf8");
  const collect = extractFunction(main, "collectWriteToolConsentItems");
  const decision = extractFunction(main, "writeToolCallConsentDecision");
  const gate = extractFunction(main, "writeToolCallNeedsConsent");
  const decide = consent.decideConsent;
  const needs = new Function("findLiveNode", "decideConsent", "planApprovalMatches",
    collect + decision + gate + "return {decision: writeToolCallConsentDecision, needs: writeToolCallNeedsConsent};")(
      () => null, decide, consent.planApprovalMatches);
  const context = { memory, taskId: "run-1" };
  const args = { summary: "add the HTTP request", newNodes: [{ id: "http-1", type: "http request" }] };
  assert.strictEqual(needs.decision("write-gated", "apply_step", args, context), "skip",
    "the next identical consent is answered as skip");
  assert.strictEqual(needs.needs("write-gated", "apply_step", args, context), false,
    "the same skipped step is not asked again");
});

// 3. DIRECT runs must continue after a skipped tool and finish with a short
// note rather than creating an empty result card or a Re-plan.
test("DIRECT skip continues and has no empty result or Re-plan", () => {
  const modes = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");
  assert.match(modes, /consentDecision === "skip"[\s\S]*?continueWithResult\(\{ skipped: true/,
    "a remembered skip returns a tool result and continues the batch");
  assert.match(modes, /activeActRun && activeActRun\.direct\) \{ settleRunOutcome\("done", null\); \}/,
    "DIRECT skip does not settle as a Re-plan outcome");
  assert.match(modes, /Skipped: .*Nothing else was changed\./,
    "only-skipped runs render the required short note");
});

// 4. Classic Build rechecks the complete generated step. If server metadata
// only mentions the first safe node, the HTTP request still gets named in the
// consent gate for a step that creates inject + http request together.
test("mixed Build creates ask for the side-effecting node", () => {
  const modes = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");
  const helper = extractFunction(modes, "buildConsentSideEffectingNodes");
  const classify = new Function("decideConsent", helper + "return buildConsentSideEffectingNodes;")(consent.decideConsent);
  const side = classify([
    { id: "inject-1", type: "inject", name: "Every 5 minutes" },
    { id: "http-1", type: "http request", name: "Fetch data" }
  ], { sideEffecting: [] });
  assert.deepStrictEqual(side.map(node => node.type), ["http request"],
    "mixed create step asks for the side-effecting HTTP request");
  assert.strictEqual(side[0].name, "Fetch data", "consent names the HTTP request node");
});

console.log("R2-C clear-skip tests passed");
