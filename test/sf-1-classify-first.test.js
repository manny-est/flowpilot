"use strict";

const assert = require("assert");
const { startFakeProvider, loadRuntime, call, provider } = require("./helpers/route-harness");

function toolCall(name, args, id) {
  return [{
    id: id || "call-1",
    type: "function",
    function: { name: name, arguments: JSON.stringify(args || {}) }
  }];
}

async function withRuntime(fakeOptions, providerExtra, fn) {
  const fake = await startFakeProvider(fakeOptions);
  try {
    const p = provider(fake.port, Object.assign({ supportsTools: true }, providerExtra || {}));
    const runtime = loadRuntime({ activeProviderId: p.id, providers: [p] });
    return await fn(runtime, fake);
  } finally {
    fake.close();
  }
}

async function testAnswerHandoff() {
  await withRuntime({
    reply: function (body) {
      return body && Array.isArray(body.tools) ? "answer after reading" : "A";
    },
    toolCalls: function (body) {
      return body && Array.isArray(body.tools)
        ? toolCall("read_node", { name: "Poll" })
        : null;
    }
  }, {}, async function (runtime, fake) {
    const out = await call(runtime, "POST", "/flowpilot/chat", {
      prompt: "What does Poll do?", strategy: "agent", entry: "chat", tools: true,
      context: { nodes: [] }
    });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.answerPhase, true, "answer handoff marks the response");
    assert.strictEqual(out.body.toolCalls[0].function.name, "read_node");
    const offered = fake.requests.filter(function (request) { return /\/chat\/completions$/.test(request.url); })[1].body.tools;
    const names = offered.map(function (tool) { return tool.function.name; });
    assert.ok(names.indexOf("read_node") !== -1, "handoff offers read tools");
    assert.ok(names.indexOf("ask_user") !== -1, "handoff keeps ask_user");
    assert.strictEqual(names.indexOf("propose_action"), -1, "handoff withholds propose_action");
  });
}

async function testAnswerNoTools() {
  await withRuntime({ reply: "A\nA blind answer" }, { supportsTools: false }, async function (runtime, fake) {
    const out = await call(runtime, "POST", "/flowpilot/chat", {
      prompt: "What does this do?", strategy: "agent", entry: "chat", tools: true,
      context: { nodes: [] }
    });
    assert.strictEqual(out.body.message, "A blind answer");
    assert.strictEqual(fake.requests.filter(function (request) { return /\/chat\/completions$/.test(request.url); }).length, 1);
  });
}

async function testAnswerPhaseDefense() {
  await withRuntime({
    reply: "The answer text",
    toolCalls: function (body) {
      return body && Array.isArray(body.tools) ? toolCall("propose_action", { action: "modify", summary: "bad" }) : null;
    }
  }, {}, async function (runtime, fake) {
    const out = await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "chat", mode: "chat", answerPhase: true,
      messages: [{ role: "system", content: "x" }, { role: "user", content: "answer" }]
    });
    assert.strictEqual(out.body.message, "The answer text");
    assert.strictEqual(out.body.toolCalls, undefined);
    const names = fake.requests.filter(function (request) { return /\/chat\/completions$/.test(request.url); })[0].body.tools
      .map(function (tool) { return tool.function.name; });
    assert.strictEqual(names.indexOf("propose_action"), -1);
  });
}

async function testAnswerPhaseKeepsReadCalls() {
  await withRuntime({
    reply: "",
    toolCalls: function (body) {
      return body && Array.isArray(body.tools)
        ? toolCall("read_node", { name: "Poll" }, "call-read").concat(
          toolCall("propose_action", { action: "modify", summary: "bad" }, "call-prop"))
        : null;
    }
  }, {}, async function (runtime, fake) {
    const out = await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "chat", mode: "chat", answerPhase: true,
      messages: [{ role: "system", content: "x" }, { role: "user", content: "answer" }]
    });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.answerPhase, true);
    assert.deepStrictEqual(out.body.toolCalls.map(function (c) { return c.function.name; }), ["read_node"],
      "a stray proposal is dropped but the read call in the same turn still runs");
  });
}

async function testActionSummary() {
  let callIndex = 0;
  await withRuntime({
    reply: function (body) {
      callIndex++;
      if (callIndex === 1) { return "C"; }
      return JSON.stringify({
        action: "generate",
        summary: "Set the selected node's topic and verify the result.",
        plan_items: ["Update msg.topic", "Check the downstream debug output"]
      });
    }
  }, {}, async function (runtime, fake) {
    const out = await call(runtime, "POST", "/flowpilot/chat", {
      prompt: "Change the selected node", strategy: "agent", entry: "chat", tools: true,
      context: { nodes: [{ id: "n1", type: "inject", name: "Tick" }] }
    });
    assert.strictEqual(out.body.toolCalls[0].function.name, "propose_action");
    const args = JSON.parse(out.body.toolCalls[0].function.arguments);
    assert.strictEqual(args.action, "modify", "the classification action wins");
    assert.strictEqual(args.summary, "Set the selected node's topic and verify the result.");
    assert.deepStrictEqual(args.plan_items, ["Update msg.topic", "Check the downstream debug output"]);
    const requests = fake.requests.filter(function (request) { return /\/chat\/completions$/.test(request.url); });
    assert.strictEqual(requests.length, 2, "classification plus one no-tools summary call");
    assert.strictEqual(requests[1].body.tools, undefined, "summary follow-up has no tools");
    requests.forEach(function (request) {
      assert.strictEqual(request.body.messages.filter(function (message) { return message.role === "system"; }).length, 1);
      assert.strictEqual(request.body.messages[0].role, "system");
      assert.notStrictEqual(request.body.messages[request.body.messages.length - 1].role, "assistant");
    });
  });
}

async function testActionFallback() {
  let callIndex = 0;
  await withRuntime({
    reply: function () { callIndex++; return callIndex === 1 ? "C" : "not json"; }
  }, {}, async function (runtime) {
    const out = await call(runtime, "POST", "/flowpilot/chat", {
      prompt: "Change it", strategy: "agent", entry: "chat", tools: true,
      context: { nodes: [{ id: "n1", type: "inject", name: "Tick" }] }
    });
    const args = JSON.parse(out.body.toolCalls[0].function.arguments);
    assert.strictEqual(args.summary, "I will change the existing Node-RED flow as requested: Change it");
    assert.deepStrictEqual(args.plan_items, []);
  });
}

(async function () {
  await testAnswerHandoff();
  await testAnswerNoTools();
  await testAnswerPhaseDefense();
  await testAnswerPhaseKeepsReadCalls();
  await testActionSummary();
  await testActionFallback();
  console.log("SF-1 classify-first tests passed");
})().catch(function (err) {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
