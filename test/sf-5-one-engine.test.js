"use strict";

// SF-5's engine matrix drives the real generation-family routes. Tool-capable
// providers must get the agent engine and WRITE tools for every action,
// regardless of the retired settings flags. Providers without tools must keep
// the classic envelope path for every action.

const assert = require("assert");
const { startFakeProvider, loadRuntime, call, provider } = require("./helpers/route-harness");

const CONTEXT = {
  nodes: [{ id: "n1", type: "inject", name: "Tick", z: "f1", wires: [] }],
  connections: { edges: [], perNode: [] }
};

function toolNames(request) {
  return (request.body.tools || []).map(function (tool) {
    return tool && tool.function && tool.function.name;
  });
}

function generationBody(route, strategy) {
  const body = {
    prompt: route === "document" ? "Explain this flow." : "Make the requested change.",
    strategy: strategy,
    entry: route,
    context: route === "build" || route === "generate" ? { nodes: [] } : CONTEXT,
    history: []
  };
  if (route === "document") { body.prompt = "Explain this flow."; }
  return body;
}

async function assertToolProviderMatrix() {
  const fake = await startFakeProvider({
    reply: "",
    toolCalls: function (body) {
      const system = body && body.messages && body.messages[0] && body.messages[0].content || "";
      const name = system.indexOf("BUILD run") !== -1 ? "deploy_flows" : "apply_step";
      return [{ id: "call-1", type: "function", function: { name: name, arguments: "{}" } }];
    }
  });
  try {
    const p = provider(fake.port, { supportsTools: true });
    const runtime = loadRuntime({
      activeProviderId: p.id,
      providers: [p],
      enableAgentWrite: false,
      buildEngine: "classic"
    });

    for (const route of ["generate", "modify", "document", "build"]) {
      const result = await call(runtime, "POST", "/flowpilot/" + route,
        generationBody(route, "agent"));
      assert.strictEqual(result.status, 200, route + " tool provider uses agent strategy");
    }

    const requests = fake.requests.filter(function (request) { return request.url.indexOf("/models") === -1; });
    assert.strictEqual(requests.length, 4, "one provider request per agent action");
    assert.ok(toolNames(requests[0]).indexOf("apply_step") !== -1, "Generate offers WRITE tools");
    assert.ok(toolNames(requests[1]).indexOf("apply_step") !== -1, "Modify offers WRITE tools");
    assert.ok(toolNames(requests[2]).indexOf("apply_step") !== -1, "Document offers WRITE tools");
    assert.ok(toolNames(requests[3]).indexOf("apply_step") !== -1, "Build offers apply_step");
    assert.ok(toolNames(requests[3]).indexOf("deploy_flows") !== -1, "Build offers runtime tools");
    requests.forEach(function (request) {
      assert.strictEqual(request.body.tool_choice, "required", "agent action requires a tool call");
    });

    // An explicit "classic" is honored: it's the client's retry-without-
    // tools fallback when a tool request fails (stale capability probe).
    const fallback = await call(runtime, "POST", "/flowpilot/generate",
      generationBody("generate", "classic"));
    assert.strictEqual(fallback.status, 200, "classic fallback request accepted");
    const fallbackRequest = fake.requests.filter(function (request) { return request.url.indexOf("/models") === -1; })[4];
    assert.strictEqual(fallbackRequest.body.tools, undefined, "classic fallback sends no tools");
  } finally {
    fake.close();
  }
}

async function assertNoToolsProviderMatrix() {
  const fake = await startFakeProvider({
    reply: JSON.stringify({ explanation: "Classic response.", flow: [] })
  });
  try {
    const p = provider(fake.port, { supportsTools: false });
    const runtime = loadRuntime({
      activeProviderId: p.id,
      providers: [p],
      enableAgentWrite: false,
      buildEngine: "converged"
    });

    for (const route of ["generate", "modify", "document", "build"]) {
      const result = await call(runtime, "POST", "/flowpilot/" + route,
        generationBody(route, "classic"));
      assert.strictEqual(result.status, 200, route + " no-tools provider keeps classic path");
    }

    const requests = fake.requests.filter(function (request) { return request.url.indexOf("/models") === -1; });
    assert.strictEqual(requests.length, 4, "one provider request per classic action");
    requests.forEach(function (request) {
      assert.ok(!request.body.tools, "classic request offers no tools");
      assert.ok(!request.body.tool_choice, "classic request has no tool choice");
    });

    for (const route of ["generate", "modify", "document", "build"]) {
      const result = await call(runtime, "POST", "/flowpilot/" + route,
        generationBody(route, "agent"));
      assert.strictEqual(result.status, 409, route + " agent strategy is unavailable without tools");
      assert.strictEqual(result.body.error, "agent_strategy_unavailable");
    }
  } finally {
    fake.close();
  }
}

// A one-shot model that writes the whole result into its final JSON (gpt-4.1
// on Document, C6 gate) gets one corrective turn to use apply_step, instead of
// the contract stripping the flow and the run ending in a 422.
function inlineDocumentReply() {
  return JSON.stringify({
    explanation: "Documented the flow.",
    flow: [{ id: "c1", type: "comment", name: "Read me", info: "What this does", wires: [] }]
  });
}

function isRetryTurn(body) {
  const last = body && body.messages && body.messages[body.messages.length - 1];
  return !!(last && last.role === "user" && /only applies changes made with the apply_step tool/.test(last.content));
}

async function assertInlineWriteRetried() {
  const fake = await startFakeProvider({
    reply: function (body) { return isRetryTurn(body) ? "" : inlineDocumentReply(); },
    toolCalls: function (body) {
      return isRetryTurn(body)
        ? [{ id: "call-2", type: "function", function: { name: "apply_step", arguments: "{\"summary\":\"Add a comment\"}" } }]
        : null;
    }
  });
  try {
    const p = provider(fake.port, { supportsTools: true });
    const runtime = loadRuntime({ activeProviderId: p.id, providers: [p] });
    const out = await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "document", mode: "document", prompt: "Document these nodes",
      context: CONTEXT, messages: [{ role: "system", content: "x" }, { role: "user", content: "doc" }]
    });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.toolCalls[0].function.name, "apply_step", "the retry's write reaches the client loop");
    const calls = fake.requests.filter(function (r) { return /\/chat\/completions$/.test(r.url); });
    assert.strictEqual(calls.length, 2, "exactly one corrective turn");
    assert.ok(toolNames(calls[1]).indexOf("apply_step") !== -1, "the retry still offers the write tools");
    const sent = calls[1].body.messages;
    assert.strictEqual(sent.filter(function (m) { return m.role === "system"; }).length, 1);
    assert.strictEqual(sent[sent.length - 2].role, "assistant");
  } finally {
    fake.close();
  }
}

async function assertInlineWriteRetriedOnlyOnce() {
  const fake = await startFakeProvider({ reply: inlineDocumentReply() });
  try {
    const p = provider(fake.port, { supportsTools: true });
    const runtime = loadRuntime({ activeProviderId: p.id, providers: [p] });
    const out = await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "document", mode: "document", prompt: "Document these nodes",
      context: CONTEXT, messages: [{ role: "system", content: "x" }, { role: "user", content: "doc" }]
    });
    assert.strictEqual(out.status, 422, "a second inline reply still fails under the contract");
    assert.strictEqual(fake.requests.filter(function (r) { return /\/chat\/completions$/.test(r.url); }).length, 2);
  } finally {
    fake.close();
  }
}

async function assertSummaryFinalNotRetried() {
  const fake = await startFakeProvider({ reply: JSON.stringify({ explanation: "Added the comment." }) });
  try {
    const p = provider(fake.port, { supportsTools: true });
    const runtime = loadRuntime({ activeProviderId: p.id, providers: [p] });
    await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "document", mode: "document", prompt: "Document these nodes",
      context: CONTEXT, messages: [{ role: "system", content: "x" }, { role: "user", content: "doc" }]
    });
    assert.strictEqual(fake.requests.filter(function (r) { return /\/chat\/completions$/.test(r.url); }).length, 1,
      "a normal summary final is not retried");
  } finally {
    fake.close();
  }
}


// Polish pass, Stage 1 live check: once a run has written through the tools,
// a final reply that restates the built flow is not retried as "make the same
// changes" (gpt-4.1 then built a duplicate trigger), and an agent Generate
// ends with its explanation instead of a 422 (#33).
async function assertRestatedFlowAfterWritesAccepted() {
  const fake = await startFakeProvider({ reply: JSON.stringify({
    explanation: "Built the weather and joke flow.",
    flow: [{ id: "abc123", type: "inject", name: "Get Weather & Joke", wires: [["def456"]] }]
  }) });
  try {
    const p = provider(fake.port, { supportsTools: true });
    const runtime = loadRuntime({ activeProviderId: p.id, providers: [p] });
    const out = await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "generate", mode: "generate", prompt: "Build a weather and joke flow",
      context: CONTEXT, messages: [
        { role: "system", content: "x" }, { role: "user", content: "build it" },
        { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function",
          function: { name: "apply_step", arguments: "{\"summary\":\"Add the trigger\"}" } }] },
        { role: "tool", tool_call_id: "call-1", content: "{\"allPass\":true,\"idMap\":{\"inj1\":\"abc123\"}}" }
      ]
    });
    assert.strictEqual(fake.requests.filter(function (r) { return /\/chat\/completions$/.test(r.url); }).length, 1,
      "no corrective 'make the same changes' turn after the run already wrote");
    assert.strictEqual(out.status, 200, "an agent Generate that already wrote ends without a 422");
    assert.strictEqual(out.body.explanation, "Built the weather and joke flow.");
    assert.ok(!out.body.flow || !out.body.flow.length, "the restated flow is not handed back for import");
  } finally {
    fake.close();
  }
}

// The opposite case (same live check): after writing one node, gpt-4.1 put
// the REST of the flow (nodes it hadn't built) into JSON. That's work still to
// do, so the corrective apply_step turn still happens.
async function assertUnbuiltFlowAfterWritesRetried() {
  const fake = await startFakeProvider({
    reply: function (body) { return isRetryTurn(body) ? "" : JSON.stringify({
      explanation: "Plan: fetch weather and a joke.",
      flow: [{ id: "abc123", type: "inject", wires: [["w2"]] }, { id: "w2", type: "http request", wires: [[]] }]
    }); },
    toolCalls: function (body) {
      return isRetryTurn(body)
        ? [{ id: "call-2", type: "function", function: { name: "apply_step", arguments: "{\"summary\":\"Add w2\"}" } }]
        : null;
    }
  });
  try {
    const p = provider(fake.port, { supportsTools: true });
    const runtime = loadRuntime({ activeProviderId: p.id, providers: [p] });
    const out = await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "generate", mode: "generate", prompt: "Build a weather and joke flow",
      context: CONTEXT, messages: [
        { role: "system", content: "x" }, { role: "user", content: "build it" },
        { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function",
          function: { name: "apply_step", arguments: "{\"summary\":\"Add the trigger\"}" } }] },
        { role: "tool", tool_call_id: "call-1", content: "{\"allPass\":true,\"idMap\":{\"w1\":\"abc123\"}}" }
      ]
    });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.toolCalls[0].function.name, "apply_step", "the unbuilt nodes get built through the tools");
  } finally {
    fake.close();
  }
}

(async function () {
  await assertToolProviderMatrix();
  await assertNoToolsProviderMatrix();
  await assertInlineWriteRetried();
  await assertInlineWriteRetriedOnlyOnce();
  await assertSummaryFinalNotRetried();
  await assertRestatedFlowAfterWritesAccepted();
  await assertUnbuiltFlowAfterWritesRetried();
  console.log("sf-5 one-engine tests passed");
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
