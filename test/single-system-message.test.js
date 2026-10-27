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

  // Phase 11 paths (CODEX-042): the Act transition notice (fromAct) and
  // Plan routing (strategy "agent" chat, Tier A and Tier C).
  const NOTICE = "The user approved this plan:";
  const act = await exercise("generate (fromAct)", "/flowpilot/generate",
    Object.assign({ prompt: "make a flow", entry: "generate", fromAct: true }, COMMON));
  const actSys = act.reqs[0].body.messages[0].content;
  assert.ok(actSys.indexOf(NOTICE) > actSys.indexOf("earlier parts of this conversation were omitted"),
    "fromAct: transition notice is the last fragment of the system message");
  await exercise("generate (fromAct, stream)", "/flowpilot/generate",
    Object.assign({ prompt: "make a flow", entry: "generate", fromAct: true, stream: true }, COMMON));
  const actModify = await exercise("modify (fromAct)", "/flowpilot/modify",
    Object.assign({ prompt: "rename it", entry: "modify", fromAct: true }, COMMON));
  assert.ok(actModify.reqs[0].body.messages[0].content.indexOf(NOTICE) > 0, "modify fromAct: transition notice present");
  await exercise("build (fromAct)", "/flowpilot/build",
    Object.assign({ prompt: "build a flow", entry: "build", fromAct: true }, COMMON));
  await exercise("document (fromAct)", "/flowpilot/document",
    Object.assign({ prompt: "", entry: "document", fromAct: true }, COMMON));
  const noAct = await exercise("modify (no fromAct)", "/flowpilot/modify",
    Object.assign({ prompt: "rename it", entry: "modify" }, COMMON));
  noAct.reqs.forEach(function (r) {
    r.body.messages.forEach(function (m) {
      assert.ok(String(m.content).indexOf(NOTICE) === -1, "no fromAct: transition notice absent");
    });
  });

  const PLAN = { prompt: "What does this flow do?", strategy: "agent", entry: "chat", tools: true,
    history: HISTORY, historyTruncated: true, context: CONTEXT };
  const tierA = await exercise("plan routing (Tier A)", "/flowpilot/chat", PLAN, { enableAgentWrite: false }, {},
    { supportsTools: true, routingTierMode: "manual", routingTier: "A" });
  const planSys = tierA.reqs[0].body.messages[0].content;
  assert.ok(planSys.indexOf("2 nodes selected.") > 0, "plan routing: selection-state line folded into the system message");
  assert.ok(planSys.indexOf("earlier parts of this conversation were omitted") > planSys.indexOf("2 nodes selected."),
    "plan routing: truncation notice after the selection-state line");
  assert.deepStrictEqual(tierA.reqs[0].body.messages.slice(1).map(function (m) { return m.role; }), ["user", "assistant", "user"],
    "plan routing: history then the user turn follow the single system message");
  await exercise("plan routing (Tier C)", "/flowpilot/chat", PLAN, {}, { reply: "A" },
    { supportsTools: true, routingTierMode: "manual", routingTier: "C" });
  let n = 0;
  const retryC = await exercise("plan routing (Tier C retry)", "/flowpilot/chat", PLAN, {},
    { reply: function () { return n++ === 0 ? "hmm, not sure" : "A"; } },
    { supportsTools: true, routingTierMode: "manual", routingTier: "C" });
  assert.strictEqual(retryC.reqs.length, 3, "Tier C retry: classification retry plus answer handoff sent");
  const retryRoles = retryC.reqs[1].body.messages.map(function (m) { return m.role; });
  assert.deepStrictEqual(retryRoles.slice(-2), ["assistant", "user"], "Tier C retry: nudge is a user turn after the unparseable reply");
  const handoffRoles = retryC.reqs[2].body.messages.map(function (m) { return m.role; });
  assert.deepStrictEqual(handoffRoles.slice(-1), ["user"], "Tier C answer handoff: normal Plan chat ends on the user turn");

  await exercise("test", "/flowpilot/test", { prompt: "Say hello." });
  // (non-empty body: the route 400s on {} — see the 0.6.4 report, unrelated)
  await exercise("probe", "/flowpilot/probe", { reason: "test" });

  results.forEach(function (r) { console.log("  " + r); });
  console.log("single-system-message tests passed");
})().catch(function (err) { console.error(err); process.exit(1); });
