"use strict";

// A Plan (strategy "agent") chat whose propose_action arrives on a
// continuation step — after a read-tool round trip — is normalized on
// /flowpilot/agent-step, which derives targets/needs_selection from
// context.nodes (ADR-009). The client must send the selection on those
// steps too, or a proposal made with nodes selected renders as "Select
// nodes first". Takes runAgentChat from the REAL client source, builds the
// step body the way runAgentLoop does, and sends it through the REAL route.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { startFakeProvider, loadRuntime, call, provider } = require("./helpers/route-harness");

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");
const fnMatch = source.match(/function runAgentChat\(payload, onDone, onError\) \{[\s\S]*?\n    \}/);
assert.ok(fnMatch, "found runAgentChat in lib/core/modes.js");

let captured = null;
const runAgentChat = new Function("runAgentLoop",
  fnMatch[0] + "\nreturn runAgentChat;")(function (endpoint, payload, stepExtra) { captured = stepExtra; });

const CONTEXT = { nodes: [{ id: "n1", type: "function", name: "Shape", z: "f1", wires: [] }] };
runAgentChat({ prompt: "add a ts field", context: CONTEXT, strategy: "agent", entry: "chat" });
assert.ok(captured && captured.context === CONTEXT, "runAgentChat passes the selection context as stepExtra");

(async function () {
  const fake = await startFakeProvider({
    reply: "",
    toolCalls: function () {
      return [{ id: "c9", type: "function", function: { name: "propose_action",
        arguments: JSON.stringify({ action: "modify", summary: "Add a ts field to Shape." }) } }];
    }
  });
  try {
    const p = provider(fake.port, { supportsTools: true, routingTierMode: "manual", routingTier: "A" });
    const runtime = loadRuntime({ activeProviderId: p.id, providers: [p], enableAgentWrite: false });
    // Same merge order as runAgentLoop's postNextStep.
    const stepBody = Object.assign({
      messages: [{ role: "system", content: "s" }, { role: "user", content: "add a ts field" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_node", arguments: "{\"id\":\"n1\"}" } }] },
        { role: "tool", tool_call_id: "c1", content: "{\"id\":\"n1\"}" }],
      conversationId: "t"
    }, captured, { strategy: "agent", entry: "chat", runId: "r1", events: [] });
    const out = await call(runtime, "POST", "/flowpilot/agent-step", stepBody);
    assert.strictEqual(out.status, 200, "agent-step 200 (" + JSON.stringify(out.body).slice(0, 200) + ")");
    const pa = JSON.parse(out.body.toolCalls[0].function.arguments);
    assert.deepStrictEqual(pa.targets, ["n1"], "continuation proposal targets the selected node");
    assert.strictEqual(pa.needs_selection, false, "continuation proposal does not ask for a selection");
  } finally {
    fake.close();
  }
  console.log("plan-continuation-context tests passed");
})().catch(function (err) { console.error(err); process.exit(1); });
