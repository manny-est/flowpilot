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

// The reply to Tier C's own "What would you like FlowPilot to do?" question
// arrives on agent-step. It must route, not go back to the classifier model
// (which would just print "C" as the chat answer).
function tierCAskMessages(answer) {
  const askId = "tier-c-123";
  return [
    { role: "system", content: "You classify one Node-RED user request for FlowPilot." },
    { role: "user", content: "Fix the bug in this function" },
    { role: "assistant", content: null, tool_calls: toolCall("ask_user", {
      question: "What would you like FlowPilot to do with this flow?",
      options: ["Answer a question", "Create nodes", "Change nodes", "Document nodes", "Build and verify"]
    }, askId) },
    { role: "tool", tool_call_id: askId, content: JSON.stringify({ answer: answer }) }
  ];
}

async function testTierCAskOptionRoutes() {
  await withRuntime({
    reply: function () {
      return JSON.stringify({ summary: "Fix the uppercase call.", plan_items: ["Use toUpperCase"] });
    }
  }, {}, async function (runtime, fake) {
    const out = await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "chat", mode: "chat",
      intake: { message: "Fix the bug in this function" },
      context: { nodes: [{ id: "n1", type: "function", name: "Shaper" }] },
      messages: tierCAskMessages("Change nodes")
    });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.message, undefined, "no bare letter reply");
    assert.strictEqual(out.body.toolCalls[0].function.name, "propose_action");
    const args = JSON.parse(out.body.toolCalls[0].function.arguments);
    assert.strictEqual(args.action, "modify");
    assert.strictEqual(args.summary, "Fix the uppercase call.");
    const calls = fake.requests.filter(function (request) { return /\/chat\/completions$/.test(request.url); });
    assert.strictEqual(calls.length, 1, "the option maps to its letter; only the summary follow-up calls the model");
    assert.strictEqual(calls[0].body.tools, undefined, "summary follow-up runs without tools");
    const last = calls[0].body.messages[calls[0].body.messages.length - 1];
    assert.ok(/already decided as modify/.test(last.content));
    assert.strictEqual(calls[0].body.messages.filter(function (m) { return m.role === "system"; }).length, 1);
  });
}

async function testTierCAskAnswerHandsOff() {
  await withRuntime({
    reply: "",
    toolCalls: function (body) {
      return body && Array.isArray(body.tools) ? toolCall("read_node", { name: "Shaper" }) : null;
    }
  }, {}, async function (runtime, fake) {
    const out = await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "chat", mode: "chat",
      intake: { message: "Fix the bug in this function" },
      messages: tierCAskMessages("Answer a question")
    });
    assert.strictEqual(out.body.answerPhase, true);
    assert.strictEqual(out.body.toolCalls[0].function.name, "read_node");
    const sent = fake.requests.filter(function (request) { return /\/chat\/completions$/.test(request.url); })[0].body;
    assert.ok(!/You classify one Node-RED user request/.test(sent.messages[0].content),
      "the answer turn uses the chat system prompt, not the classifier's");
    assert.strictEqual(sent.messages[sent.messages.length - 1].role, "user");
    assert.strictEqual(sent.tools.map(function (t) { return t.function.name; }).indexOf("propose_action"), -1);
  });
}

async function testTierCAskOtherTextIsClassified() {
  let callIndex = 0;
  await withRuntime({
    reply: function () { callIndex++; return callIndex === 1 ? "D" : "not json"; }
  }, {}, async function (runtime, fake) {
    const out = await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "chat", mode: "chat",
      intake: { message: "Fix the bug in this function" },
      context: { nodes: [{ id: "n1", type: "function", name: "Shaper" }] },
      messages: tierCAskMessages("just add comments explaining it")
    });
    assert.strictEqual(out.body.toolCalls[0].function.name, "propose_action");
    assert.strictEqual(JSON.parse(out.body.toolCalls[0].function.arguments).action, "document");
    const first = fake.requests.filter(function (request) { return /\/chat\/completions$/.test(request.url); })[0].body;
    assert.strictEqual(first.tools, undefined, "typed answers are classified with tools off");
  });
}

async function testOrdinaryAskUserUntouched() {
  await withRuntime({ reply: "Thanks, done." }, {}, async function (runtime) {
    const messages = tierCAskMessages("Change nodes");
    messages[2].tool_calls[0].id = "call-9";
    messages[3].tool_call_id = "call-9";
    const out = await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "chat", mode: "chat", messages: messages
    });
    assert.strictEqual(out.body.message, "Thanks, done.", "a model's own ask_user still continues normally");
  });
}

(async function () {
  await testAnswerHandoff();
  await testAnswerNoTools();
  await testAnswerPhaseDefense();
  await testAnswerPhaseKeepsReadCalls();
  await testActionSummary();
  await testActionFallback();
  await testTierCAskOptionRoutes();
  await testTierCAskAnswerHandsOff();
  await testTierCAskOtherTextIsClassified();
  await testOrdinaryAskUserUntouched();
  console.log("SF-1 classify-first tests passed");
})().catch(function (err) {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
