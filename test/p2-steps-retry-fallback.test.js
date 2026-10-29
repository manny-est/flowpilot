"use strict";

// Stage 2 review, found by the Spark routing corpus: a valid proposal that
// only echoes the request gets one retry asking for steps. When that retry
// comes back broken (Spark repeated "plan_items" until the reply was cut
// off), the original proposal is kept; before, the proposal was stripped and
// the request fell to an empty "answer". Drives the real /flowpilot/chat route.

const assert = require("assert");
const { startFakeProvider, loadRuntime, call, provider } = require("./helpers/route-harness");

const PROMPT = "I want something that sends hello to the debug sidebar every minute.";

(async function () {
  let turn = 0;
  const fake = await startFakeProvider({
    reply: "",
    toolCalls: function () {
      turn++;
      if (turn === 1) {
        return [{ id: "p1", type: "function", function: { name: "propose_action",
          arguments: JSON.stringify({ action: "generate", summary: "I will create as requested: " + PROMPT,
            targets: [], plan_items: [] }) } }];
      }
      // The retry: truncated, repeated keys, not parseable.
      return [{ id: "p2", type: "function", function: { name: "propose_action",
        arguments: "{\"action\":\"generate\",\"summary\":\"I will create a flow\",\"plan_items\":[\"Add an inject\"],\"plan_items\":[\"Add an inj" } }];
    }
  });
  try {
    const p = provider(fake.port, { supportsTools: true, routingTierMode: "manual", routingTier: "A" });
    const runtime = loadRuntime({ activeProviderId: p.id, providers: [p], enableAgentWrite: false });
    const out = await call(runtime, "POST", "/flowpilot/chat", {
      prompt: PROMPT, strategy: "agent", entry: "chat", tools: true, context: { nodes: [] }, history: []
    });
    assert.strictEqual(out.status, 200);
    const reqs = fake.requests.filter(function (r) { return r.method === "POST" && !/\/models$/.test(r.url); });
    assert.strictEqual(reqs.length, 2, "one retry asking for steps");
    const proposal = (out.body.toolCalls || []).find(function (c) { return c.function && c.function.name === "propose_action"; });
    assert.ok(proposal, "the original proposal reaches the client instead of an empty answer");
    assert.strictEqual(JSON.parse(proposal.function.arguments).action, "generate");
  } finally {
    fake.close();
  }
  console.log("steps-retry fallback tests passed");
})().catch(function (err) { console.error(err); process.exit(1); });
