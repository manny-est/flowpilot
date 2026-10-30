"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const cards = require("../lib/core/cards.js");
const { startFakeProvider, loadRuntime, call, provider } = require("./helpers/route-harness");

function source(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

test("32k, 240k, unknown, and explicit ceiling rules", () => {
  const limits = require("../lib/core/limits.js");
  // The ceiling sums every step of a turn, so it scales with steps x one step's context.
  assert.strictEqual(limits.deriveAgentLoopTokenCeiling({ agentLoopTokenCeiling: 50000 }, { numCtx: 32000 }, 8), 256000,
    "32k model: 8 steps x 32k");
  assert.strictEqual(limits.deriveAgentLoopTokenCeiling({ agentLoopTokenCeiling: 50000 }, { numCtx: 240000 }, 8), 8 * 32768,
    "a huge context is capped per step");
  assert.strictEqual(limits.deriveAgentLoopTokenCeiling({ agentLoopTokenCeiling: 50000 }, { numCtx: 0 }, 8), 8 * 16384,
    "unknown context (Spark reports numCtx 0) still clears the ~59k Spark builds died at");
  assert.ok(limits.deriveAgentLoopTokenCeiling({ agentLoopTokenCeiling: 50000 }, { numCtx: 0 }, 8) > 60000);
  assert.strictEqual(limits.deriveAgentLoopTokenCeiling({ agentLoopTokenCeiling: 50000 }, { numCtx: 4096 }, 8), 50000,
    "never below the old default");
  assert.strictEqual(limits.deriveAgentLoopTokenCeiling({ agentLoopTokenCeiling: 43210 }, { numCtx: 0 }), 43210);
  assert.strictEqual(limits.deriveAgentLoopTokenCeiling({ agentLoopTokenCeiling: 12345, agentLoopTokenCeilingUserSet: true }, { numCtx: 240000 }), 12345);
  assert.ok(limits.deriveAgentLoopTokenCeiling({ agentLoopTokenCeiling: 50000 }, { contextWindow: 240000 }) > 50000);
});

test("step status never displays a total smaller than the current step", () => {
  const limits = require("../lib/core/limits.js");
  for (let step = 0; step < 20; step++) {
    const total = limits.displayStepTotal(step, 5);
    assert.ok(total >= step, "step " + step + " must not exceed total " + total);
  }
});

test("continue card keeps state hidden from its visible summary and carries it in dispatch", () => {
  const modes = source("lib/core/modes.js");
  const renderStart = modes.indexOf("function renderReplanChip(");
  const renderEnd = modes.indexOf("// ---- Unsaved-changes warning", renderStart);
  const render = modes.slice(renderStart, renderEnd);
  assert.doesNotMatch(render, /summary:[\s\S]*Already built; do not recreate|summary:[\s\S]*wires=/);
  assert.match(render, /Already built:/);
  assert.match(modes, /pendingActDispatch[\s\S]*continuation/);
  assert.match(modes, /payload\.continuation\s*=\s*actDispatch\.continuation/);
  assert.match(source("flowpilot.js"), /continuation state|continuationState|continuation/);
});

test("continuation with an explanation and no flow is Done, not a 422", async () => {
  const fake = await startFakeProvider({
    reply: JSON.stringify({ explanation: "Those nodes are already present; nothing remains to do." })
  });
  try {
    const p = provider(fake.port, { supportsTools: true });
    const runtime = loadRuntime({
      activeProviderId: p.id,
      providers: [p],
      agentLoopTokenCeiling: 50000
    });
    const result = await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "build", mode: "build", prompt: "Continue the build",
      continuation: [{ id: "n1", name: "Get Weather", type: "http request", wires: [[]] }],
      messages: [{ role: "system", content: "internal" }, { role: "user", content: "continue" }]
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.explanation, "Those nodes are already present; nothing remains to do.");
    assert.ok(result.body.flow === undefined || result.body.flow === null);
  } finally {
    fake.close();
  }
});

test("result cards expose names/types and no editor bookkeeping", () => {
  const model = cards.buildResultCardModel({ changedNodes: [
    { id: "removed", changeType: "removed", name: "Old node", type: "change", x: 10, y: 20, _def: { category: "config" }, dirty: true },
    { id: "added", changeType: "added", name: "New node", type: "debug", after: {
      id: "added", name: "New node", type: "debug", x: 1, y: 2, z: "tab", wires: [], _def: {}, dirty: true, valid: true
    } },
    { id: "changed", name: "Changed", type: "function", before: { x: 1, _def: {}, dirty: false, func: "old" }, after: { y: 2, _def: {}, changed: true, func: "new" } }
  ] });
  const forbidden = /^(?:_def|x|y|z|dirty|changed|valid|validationErrors|_)/;
  model.changedNodes.forEach(function (node) {
    [node.before, node.after].forEach(function (snapshot) {
      Object.keys(snapshot || {}).forEach(function (key) { assert.ok(!forbidden.test(key), "bookkeeping key leaked: " + key); });
    });
    (node.changed || []).forEach(function (change) { assert.ok(!forbidden.test(change.key), "changed key leaked: " + change.key); });
    (node.added || []).concat(node.removed || []).forEach(function (key) { assert.ok(!forbidden.test(key), "field list leaked: " + key); });
  });
  assert.deepStrictEqual(model.changedNodes[0], {
    id: "removed", name: "Old node", type: "change", changeType: "removed",
    added: [], changed: [], removed: [], before: {}, after: {}
  });
});

test("provider error bodies become one sentence with technical details", async () => {
  const errors = require("../lib/provider-errors.js");
  const cases = [
    [{ error: { message: 'The model "no-such-model" was not found.', type: "invalid_request_error" } }, 'The model "no-such-model" was not found.'],
    [{ error: "Model loading failed on LocalAI." }, "Model loading failed on LocalAI."],
    [{ type: "error", error: { type: "invalid_request_error", message: "request is invalid" } }, "request is invalid."]
  ];
  cases.forEach(function (entry) {
    const normalized = errors.normalizeProviderError(entry[0], 404);
    assert.strictEqual(normalized.message, entry[1]);
    assert.strictEqual(normalized.raw, JSON.stringify(entry[0]));
  });

  const fake = await startFakeProvider({
    status: 404,
    responseBody: JSON.stringify({ error: { message: 'The model "no-such-model" was not found.', type: "invalid_request_error" } })
  });
  try {
    const p = provider(fake.port, { supportsTools: false });
    const runtime = loadRuntime({ activeProviderId: p.id, providers: [p] });
    const result = await call(runtime, "POST", "/flowpilot/chat", {
      prompt: "hello", strategy: "classic", entry: "chat"
    });
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.body.error, 'The model "no-such-model" was not found.');
    assert.match(result.body.raw, /no-such-model/);
    assert.doesNotMatch(result.body.error, /\{.*message/);
  } finally {
    fake.close();
  }

  const modes = source("lib/core/modes.js");
  assert.match(modes, /Technical details/);
  assert.match(modes, /<details>/);
});
