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

(async function () {
  await assertToolProviderMatrix();
  await assertNoToolsProviderMatrix();
  console.log("sf-5 one-engine tests passed");
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
