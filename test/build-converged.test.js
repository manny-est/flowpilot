"use strict";

// R11-6 converged Build, server side, through the REAL /flowpilot/build and
// /flowpilot/agent-step routes:
// - flag off (buildEngine "classic", the default): a classic Build request is
//   unchanged (classic prompt, no tools), and an agent-strategy Build 409s;
// - flag on: agent-strategy Build runs the converged prompt with the WRITE
//   tools plus deploy_flows/verify_runtime, tool_choice required, on both the
//   first turn and continuation steps; deploy_flows is consent-gated.

const assert = require("assert");
const { startFakeProvider, loadRuntime, call, provider } = require("./helpers/route-harness");
const classicPrompt = require("../lib/build-system-prompt");

function names(req) { return (req.body.tools || []).map(function (t) { return t.function && t.function.name; }); }
function chatReqs(fake) { return fake.requests.filter(function (r) { return r.method === "POST" && !/\/models$/.test(r.url); }); }

(async function () {
  // ---- flag off ----
  let fake = await startFakeProvider({ reply: JSON.stringify({ explanation: "Plan:\n1. x", flow: [] }) });
  try {
    const p = provider(fake.port, { supportsTools: true });
    const rt = loadRuntime({ activeProviderId: p.id, providers: [p], enableAgentWrite: true });
    const classic = await call(rt, "POST", "/flowpilot/build", { prompt: "inject to debug", strategy: "classic", entry: "build", context: { nodes: [] } });
    assert.strictEqual(classic.status, 200, "classic build 200");
    const req = chatReqs(fake)[0];
    assert.ok(req.body.messages[0].content.indexOf(classicPrompt) === 0, "classic build: classic prompt, unchanged");
    assert.ok(!req.body.tools, "classic build: no tools offered");
    const agentOff = await call(rt, "POST", "/flowpilot/build", { prompt: "inject to debug", strategy: "agent", entry: "build", context: { nodes: [] } });
    assert.strictEqual(agentOff.status, 409, "agent build with the flag off → 409");
    assert.strictEqual(agentOff.body.error, "converged_build_unavailable");
  } finally { fake.close(); }

  // ---- flag on ----
  const isFinal = function (body) { return (body.messages || []).some(function (m) { return m.role === "tool"; }); };
  fake = await startFakeProvider({
    // First turn deploys; the continuation (after a tool result) finishes
    // with an explanation and no "flow" — the work is already on the canvas.
    reply: function (body) { return isFinal(body) ? JSON.stringify({ explanation: "Built and verified: debug showed 42.", goalMet: true }) : ""; },
    toolCalls: function (body) {
      return isFinal(body) ? null
        : [{ id: "d1", type: "function", function: { name: "deploy_flows", arguments: "{\"summary\":\"first deploy\"}" } }];
    }
  });
  try {
    const p = provider(fake.port, { supportsTools: true });
    const rt = loadRuntime({ activeProviderId: p.id, providers: [p], enableAgentWrite: true, buildEngine: "converged" });
    const first = await call(rt, "POST", "/flowpilot/build", { prompt: "inject to debug", strategy: "agent", entry: "build", context: { nodes: [] }, tools: true });
    assert.strictEqual(first.status, 200, "converged build 200 (" + JSON.stringify(first.body).slice(0, 160) + ")");
    assert.strictEqual(first.body.toolCalls[0].function.name, "deploy_flows");
    assert.strictEqual(first.body.toolTiers.d1, "write-gated", "deploy_flows is consent-gated");
    const r0 = chatReqs(fake)[0];
    assert.ok(/^IMPORTANT — this is a BUILD run/.test(r0.body.messages[0].content), "converged prompt leads the system message");
    ["apply_step", "deploy_flows", "verify_runtime", "finish_build", "read_node"].forEach(function (n) {
      assert.ok(names(r0).indexOf(n) !== -1, "first turn offers " + n);
    });
    assert.ok(names(r0).indexOf("propose_action") === -1, "no Plan tools in Build");
    assert.strictEqual(r0.body.tool_choice, "required", "first build turn must act");

    const step = await call(rt, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "build", mode: "build", context: { nodes: [] },
      messages: r0.body.messages.concat([
        { role: "assistant", content: null, tool_calls: first.body.toolCalls },
        { role: "tool", tool_call_id: "d1", content: "{\"deployed\":true,\"attemptsRemaining\":4}" }
      ])
    });
    assert.strictEqual(step.status, 200, "agent-step build final 200, no flow needed (" + JSON.stringify(step.body).slice(0, 160) + ")");
    assert.strictEqual(step.body.prose, true, "final renders as the run's explanation");
    assert.ok(/verified/.test(step.body.explanation), "explanation passed through: " + JSON.stringify(step.body));
    assert.strictEqual(step.body.goalMet, true, "goalMet verdict passed through");
    const r1 = chatReqs(fake)[1];
    ["apply_step", "deploy_flows", "verify_runtime"].forEach(function (n) {
      assert.ok(names(r1).indexOf(n) !== -1, "continuation offers " + n);
    });
  } finally { fake.close(); }

  console.log("build-converged tests passed");
})().catch(function (err) { console.error(err); process.exit(1); });
