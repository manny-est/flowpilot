"use strict";

// "xray" is reserved in the propose_action enum for Phase 12 (directive
// §2.3): never valid yet, so a model that proposes it gets the targeted
// retry message, and no xray proposal ever reaches the client. Drives the
// REAL /flowpilot/chat Plan route against a fake provider.

const assert = require("assert");
const { startFakeProvider, loadRuntime, call, provider } = require("./helpers/route-harness");

(async function () {
  const fake = await startFakeProvider({
    reply: "",
    toolCalls: function () {
      return [{ id: "x1", type: "function", function: { name: "propose_action",
        arguments: JSON.stringify({ action: "xray", summary: "Capture messages on these nodes." }) } }];
    }
  });
  try {
    const p = provider(fake.port, { supportsTools: true, routingTierMode: "manual", routingTier: "A" });
    const runtime = loadRuntime({ activeProviderId: p.id, providers: [p], enableAgentWrite: false });
    const out = await call(runtime, "POST", "/flowpilot/chat", {
      prompt: "What messages pass through these nodes overnight?", strategy: "agent", entry: "chat", tools: true,
      context: { nodes: [] }, history: []
    });
    assert.strictEqual(out.status, 200, "chat 200");
    const reqs = fake.requests.filter(function (r) { return r.method === "POST" && !/\/models$/.test(r.url); });
    assert.strictEqual(reqs.length, 2, "one targeted retry after the reserved action");
    const toolMsg = reqs[1].body.messages.filter(function (m) { return m.role === "tool"; }).pop();
    assert.ok(/reserved and not available yet/.test(toolMsg.content), "retry names the reservation: " + toolMsg.content);
    const calls = out.body.toolCalls || [];
    assert.ok(!calls.some(function (c) {
      return c.function && c.function.name === "propose_action" && /"xray"/.test(c.function.arguments);
    }), "no xray proposal reaches the client");
  } finally {
    fake.close();
  }
  console.log("propose-action-reserved tests passed");
})().catch(function (err) { console.error(err); process.exit(1); });
