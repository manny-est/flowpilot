"use strict";

// Issue #11: every request FlowPilot sends to a provider must contain at
// most ONE system message, at index 0 — strict chat templates (e.g. Qwen's
// official one) reject anything else. Drives every message-building route
// end to end through the REAL flowpilot.js runtime and inspects the request
// bodies the (fake) provider actually received.

const assert = require("assert");
const { startFakeProvider, loadRuntime, call, provider } = require("./helpers/route-harness");

const HISTORY = [
  { role: "user", content: "earlier question" },
  { role: "assistant", content: "earlier answer" }
];
const CONTEXT = {
  nodes: [{ id: "n1", type: "inject", name: "Tick", z: "f1", wires: [["n2"]] },
          { id: "n2", type: "debug", name: "Out", z: "f1", wires: [] }]
};
const COMMON = { history: HISTORY, historyTruncated: true, context: CONTEXT, strategy: "classic" };

function assertSingleLeadingSystem(label, body) {
  assert.ok(body && Array.isArray(body.messages), label + ": request has messages");
  const roles = body.messages.map(function (m) { return m.role; });
  const systemIdx = roles.reduce(function (acc, r, i) { if (r === "system") { acc.push(i); } return acc; }, []);
  assert.ok(systemIdx.length <= 1, label + ": at most one system message (got " + systemIdx.length + ": " + roles.join(",") + ")");
  if (systemIdx.length) { assert.strictEqual(systemIdx[0], 0, label + ": system message at index 0 (" + roles.join(",") + ")"); }
}

function chatRequests(fake) {
  return fake.requests.filter(function (r) { return r.method === "POST" && !/\/models$/.test(r.url); });
}

const results = [];

async function exercise(label, route, body, settingsExtra, fakeOptions, providerExtra) {
  const fake = await startFakeProvider(fakeOptions);
  try {
    const p = provider(fake.port, providerExtra);
    const runtime = loadRuntime(Object.assign({ activeProviderId: p.id, providers: [p] }, settingsExtra || {}));
    const out = await call(runtime, "POST", route, body);
    const reqs = chatRequests(fake);
    assert.ok(reqs.length > 0, label + ": provider was called (status " + out.status + ")");
    reqs.forEach(function (r, i) { assertSingleLeadingSystem(label + " request " + i, r.body); });
    results.push(label + ": " + reqs.length + " request(s) ok");
    return { out: out, reqs: reqs };
  } finally {
    fake.close();
  }
}

(async function () {
  // Plain chat — also check fragment folding/order inside the one message.
  const chat = await exercise("chat", "/flowpilot/chat", Object.assign({ prompt: "hi" }, COMMON));
  const sys = chat.reqs[0].body.messages[0].content;
  const msgs = chat.reqs[0].body.messages;
  assert.deepStrictEqual(msgs.slice(1).map(function (m) { return m.role; }), ["user", "assistant", "user"],
    "chat: history then the new user turn follow the single system message");
  const nodesIdx = sys.indexOf("node-red-contrib-example");
  const selIdx = sys.indexOf("Tick");
  assert.ok(nodesIdx > 0, "chat: installed-nodes note folded into the system message");
  assert.ok(selIdx > nodesIdx, "chat: selection context after the installed-nodes note");
  const truncIdx = sys.indexOf("earlier parts of this conversation were omitted");
  assert.ok(selIdx > 0, "chat: selection context folded into the system message");
  assert.ok(truncIdx > selIdx, "chat: truncation notice (most volatile) comes last");
  assert.ok(sys.indexOf("\n\n") > 0, "chat: fragments joined with a blank line");

  await exercise("chat (stream)", "/flowpilot/chat", Object.assign({ prompt: "hi", stream: true }, COMMON));
  await exercise("generate", "/flowpilot/generate", Object.assign({ prompt: "make a flow", entry: "generate" }, COMMON));
  await exercise("generate (stream)", "/flowpilot/generate", Object.assign({ prompt: "make a flow", entry: "generate", stream: true }, COMMON));
  await exercise("build", "/flowpilot/build", Object.assign({ prompt: "build a flow", entry: "build" }, COMMON));
  await exercise("document", "/flowpilot/document", Object.assign({ prompt: "", entry: "document" }, COMMON));
  await exercise("modify", "/flowpilot/modify", Object.assign({ prompt: "rename it", entry: "modify" }, COMMON));

  // Agent-step continuation: replays the server-built messages plus an
  // assistant tool call and its client-produced tool result.
  const continued = chat.reqs[0].body.messages.concat([
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_node", arguments: "{\"id\":\"n1\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "{\"id\":\"n1\"}" }
  ]);
  await exercise("agent-step", "/flowpilot/agent-step", { strategy: "classic", entry: "chat", mode: "chat", messages: continued });

  // Agent-strategy truncation retry (finish_reason "length" on the first
  // call): the nudge is folded into the system message, not appended.
  const retry = await exercise("agent-step (truncation retry)", "/flowpilot/agent-step",
    { strategy: "agent", entry: "chat", mode: "chat", messages: continued },
    { enableAgentWrite: true },
    { finishReason: function (i) { return i === 0 ? "length" : "stop"; } },
    { supportsTools: true });
  assert.strictEqual(retry.reqs.length, 2, "truncation retry: second request sent");
  assert.ok(/emit ONLY the tool call$/.test(retry.reqs[1].body.messages[0].content),
    "truncation retry: nudge appended to the end of the single system message");
  assert.strictEqual(retry.reqs[1].body.messages.length, retry.reqs[0].body.messages.length,
    "truncation retry: no extra message added");

  await exercise("test", "/flowpilot/test", { prompt: "Say hello." });
  // (non-empty body: the route 400s on {} — see the 0.6.4 report, unrelated)
  await exercise("probe", "/flowpilot/probe", { reason: "test" });

  results.forEach(function (r) { console.log("  " + r); });
  console.log("single-system-message tests passed");
})().catch(function (err) { console.error(err); process.exit(1); });
