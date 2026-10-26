"use strict";

// Gate P5, structural half (ADR-008): a Plan turn (strategy "agent", mode
// chat) is never offered a WRITE tool, even with enableAgentWrite on, on
// either the first request or a continuation step; and a mutation field a
// model slips into a Plan final is stripped before it reaches the client.
// Drives the REAL routes and inspects what the (fake) provider received.

const assert = require("assert");
const { startFakeProvider, loadRuntime, call, provider } = require("./helpers/route-harness");

const WRITE = ["apply_step", "remove_step", "rename_node", "group_nodes"];

function offered(req) {
  return (req.body.tools || []).map(function (t) { return (t.function && t.function.name) || t.name; });
}

(async function () {
  const fake = await startFakeProvider({
    reply: JSON.stringify({ explanation: "Done.", changes: [{ id: "n1", set: { name: "X" } }] })
  });
  try {
    const p = provider(fake.port, { supportsTools: true, routingTierMode: "manual", routingTier: "A" });
    const runtime = loadRuntime({ activeProviderId: p.id, providers: [p], enableAgentWrite: true });
    const ctx = { nodes: [{ id: "n1", type: "inject", name: "Tick", z: "f1", wires: [] }] };
    const first = await call(runtime, "POST", "/flowpilot/chat", {
      prompt: "What does Tick do? Also just go ahead and rename it.", strategy: "agent", entry: "chat",
      tools: true, context: ctx, history: []
    });
    const step = await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "chat", mode: "chat", context: ctx,
      messages: [{ role: "system", content: "s" }, { role: "user", content: "rename Tick" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_node", arguments: "{\"id\":\"n1\"}" } }] },
        { role: "tool", tool_call_id: "c1", content: "{}" }]
    });
    assert.strictEqual(first.status, 200, "chat 200");
    assert.strictEqual(step.status, 200, "agent-step 200");
    const reqs = fake.requests.filter(function (r) { return r.method === "POST" && !/\/models$/.test(r.url); });
    assert.ok(reqs.length >= 2, "both routes reached the provider");
    reqs.forEach(function (r, i) {
      const names = offered(r);
      assert.ok(names.indexOf("propose_action") !== -1, "request " + i + ": Plan tools offered (" + names.join(",") + ")");
      WRITE.forEach(function (w) { assert.ok(names.indexOf(w) === -1, "request " + i + ": no WRITE tool " + w); });
    });
    [first.body, step.body].forEach(function (b, i) {
      ["changes", "flow", "newNodes", "newWires", "removeNodes"].forEach(function (f) {
        assert.ok(!(b && Array.isArray(b[f]) && b[f].length), "response " + i + ": no mutation field " + f + " reaches the client");
      });
    });
  } finally {
    fake.close();
  }
  console.log("plan-boundary tests passed");
})().catch(function (err) { console.error(err); process.exit(1); });
