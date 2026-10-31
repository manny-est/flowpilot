"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const limits = require(path.join(root, "lib", "core", "limits.js"));
const runner = require(path.join(root, "test", "engine-corpus", "runner.js"));
const applyReviewSource = fs.readFileSync(path.join(root, "lib", "core", "apply-review.js"), "utf8");
const flowpilotSource = fs.readFileSync(path.join(root, "flowpilot.js"), "utf8");
const buildPrompt = fs.readFileSync(path.join(root, "lib", "build-agent-system-prompt.js"), "utf8");

function makeRed(existing) {
  const nodes = {};
  const links = [];
  const history = [];
  const types = {
    inject: { inputs: 0, outputs: 1, defaults: {} },
    function: { inputs: 1, outputs: 1, defaults: {} },
    debug: { inputs: 1, outputs: 0, defaults: {} },
    comment: { inputs: 0, outputs: 0, defaults: {} }
  };
  (existing || []).forEach((node) => { nodes[node.id] = node; });
  return {
    nodes,
    links,
    history,
    red: {
      nodes: {
        node: (id) => nodes[id] || null,
        add: (node) => { nodes[node.id] = node; return node; },
        getType: (type) => types[type] || null,
        eachNode: (fn) => Object.keys(nodes).forEach((id) => fn(nodes[id])),
        eachLink: (fn) => links.slice().forEach(fn),
        addLink: (link) => { links.push(link); return link; },
        dirty: () => {},
        updateConfigNodeUsers: () => {},
        workspace: (id) => id === "tab-1" ? { id } : null
      },
      workspaces: { active: () => "tab-1" },
      editor: { validateNode: (node) => { node.valid = true; } },
      view: { redraw: () => {} },
      history: { push: (event) => history.push(event) }
    }
  };
}

function functionSource(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "found " + name);
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > start, "closed " + name);
  return source.slice(start, end);
}

function loadCore(red) {
  // The real bundle order, so a new core fragment can't be missing here.
  const fragments = require(path.join(root, "lib", "build-core-script.js")).FRAGMENT_ORDER;
  const source = "(function () {\n\"use strict\";\n" + fragments.map((name) =>
    fs.readFileSync(path.join(root, "lib", "core", name), "utf8")
  ).join("\n") + [
    "",
    "window.__r3a = { executeAgentToolCall, applyInsertions, buildResultCardModel };",
    "})();",
    ""
  ].join("\n");
  const sandbox = {
    RED: red,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    $: () => ({ length: 0 }),
    document: {},
    location: { origin: "http://localhost" }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "flowpilot-core-r3-a.js" });
  return sandbox.__r3a;
}

function applyStep(api, args, creationState) {
  const runIdMap = {};
  const historyEvents = [];
  const wireState = { pending: [], connected: [], failed: [], expected: [] };
  const result = api.executeAgentToolCall({
    function: { name: "apply_step", arguments: JSON.stringify(args) }
  }, runIdMap, historyEvents, wireState, creationState);
  return { result, runIdMap, historyEvents, wireState };
}

function rect(node) {
  const width = Number(node.w) || Math.max(120, 80 + String(node.name || node.type || "").length * 8);
  const height = Number(node.h) || 30;
  return { left: node.x - width / 2, right: node.x + width / 2, top: node.y - height / 2, bottom: node.y + height / 2 };
}

function overlaps(left, right) {
  return left.left < right.right && right.left < left.right && left.top < right.bottom && right.top < left.bottom;
}

function assertNoOverlaps(nodes, message) {
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      assert.equal(overlaps(rect(nodes[i]), rect(nodes[j])), false, message + ": " + nodes[i].id + "/" + nodes[j].id);
    }
  }
}

function assertWiresGrowRight(nodes) {
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
  nodes.forEach((node) => (node.wires || []).forEach((targets) => (targets || []).forEach((targetId) => {
    if (byId[targetId]) assert.ok(node.x < byId[targetId].x, "wire grows left to right: " + node.id + " -> " + targetId);
  })));
}

test("creation first write rejects partial browser writes and applies one complete write", () => {
  const env = makeRed();
  const api = loadCore(env.red);
  const state = { active: true, plannedNodeCount: 4, firstWriteComplete: false };
  const partial = applyStep(api, {
    summary: "Start the new flow",
    newNodes: [
      { id: "n1", type: "inject", name: "Start", wires: [["n2"]] },
      { id: "n2", type: "function", name: "Normalize", wires: [[]] }
    ]
  }, state);
  assert.equal(partial.result.error, "This is a new flow: send the whole flow in one apply_step — all 4 planned nodes and their wires.");
  assert.equal(Object.keys(env.nodes).length, 0, "partial creation is not applied");
  assert.equal(env.links.length, 0, "partial creation adds no wires");

  const complete = applyStep(api, {
    summary: "Create the complete flow",
    newNodes: [
      { id: "n1", type: "inject", name: "Start", wires: [["n2"]] },
      { id: "n2", type: "function", name: "Normalize", wires: [["n3"]] },
      { id: "n3", type: "function", name: "Format", wires: [["n4"]] },
      { id: "n4", type: "debug", name: "Display", wires: [[]] }
    ]
  }, state);
  assert.equal(complete.result.allPass, true);
  assert.equal(Object.keys(env.nodes).length, 4);
  assert.equal(env.links.length, 3);
  assert.equal(state.firstWriteComplete, true);
});
test("the server-side engine uses the same creation rule", () => {
  const args = {
    summary: "Start the new flow",
    newNodes: [{ id: "n1", type: "inject", wires: [[]] }]
  };
  const state = { active: true, plannedNodeCount: 4, firstWriteComplete: false };
  assert.equal(typeof runner.creationFirstWriteError, "function");
  assert.equal(runner.creationFirstWriteError(args, state),
    "This is a new flow: send the whole flow in one apply_step — all 4 planned nodes and their wires.");
  assert.equal(runner.creationFirstWriteError({
    summary: "Create the complete flow",
    newNodes: [
      { id: "n1", type: "inject", wires: [["n2"]] },
      { id: "n2", type: "function", wires: [["n3"]] },
      { id: "n3", type: "function", wires: [["n4"]] },
      { id: "n4", type: "debug", wires: [[]] }
    ]
  }, state), null);
});

test("one-pass layout follows wires and clears wide labels and branches", () => {
  const layoutGeneratedFlow = new Function("return " + functionSource(applyReviewSource, "layoutGeneratedFlow"))();
  const chain = [
    { id: "a", type: "inject", name: "A".repeat(20), w: 200, wires: [["b"]] },
    { id: "b", type: "function", name: "B".repeat(24), w: 240, wires: [["c"]] },
    { id: "c", type: "function", name: "C".repeat(28), w: 280, wires: [["d"]] },
    { id: "d", type: "debug", name: "D".repeat(20), w: 200, wires: [[]] }
  ];
  layoutGeneratedFlow(chain);
  assertNoOverlaps(chain, "wide chain nodes do not overlap");
  assertWiresGrowRight(chain);

  const branch = [
    { id: "root", type: "inject", name: "Root", w: 240, wires: [["left", "right"]] },
    { id: "left", type: "function", name: "Left branch", w: 280, wires: [[]] },
    { id: "right", type: "debug", name: "Right branch", w: 200, wires: [[]] }
  ];
  layoutGeneratedFlow(branch);
  assertNoOverlaps(branch, "branch rows do not overlap");
  assertWiresGrowRight(branch);
});

test("anchored insertion avoids every existing node, including a wide neighbor", () => {
  const existing = [
    { id: "anchor", type: "inject", name: "Anchor", x: 100, y: 120, w: 100, h: 30, z: "tab-1", wires: [[]] },
    { id: "wide", type: "debug", name: "Wide existing node", x: 560, y: 120, w: 280, h: 30, z: "tab-1", wires: [[]] }
  ];
  const env = makeRed(existing);
  const api = loadCore(env.red);
  const result = applyStep(api, {
    summary: "Add after the anchor",
    newNodes: [{ id: "new", type: "function", name: "New node", w: 280, wires: [[]] }],
    newWires: [{ from: "anchor", fromPort: 0, to: "new" }]
  });
  assert.equal(result.result.allPass, true);
  const added = Object.values(env.nodes).find((node) => node.type === "function");
  assert.ok(added);
  assertNoOverlaps(Object.values(env.nodes), "anchored insertion avoids existing rectangles");
  assert.ok(added.x > env.nodes.anchor.x, "anchored insertion remains after its neighbor");
});

test("a standalone add is placed on free space", () => {
  const existing = [{ id: "debug", type: "debug", name: "Existing", x: 160, y: 120, w: 280, h: 30, z: "tab-1", wires: [[]] }];
  const env = makeRed(existing);
  const api = loadCore(env.red);
  applyStep(api, { summary: "Add a comment", newNodes: [{ id: "comment", type: "comment", name: "Notes", wires: [] }] });
  const added = Object.values(env.nodes).find((node) => node.type === "comment");
  assert.ok(added);
  assertNoOverlaps(Object.values(env.nodes), "standalone add avoids the existing node");
});

test("result records list each created node and wire once", () => {
  const api = loadCore(makeRed().red);
  const model = api.buildResultCardModel({
    changedNodes: [
      { id: "n1", type: "inject", name: "Start", changeType: "added" },
      { id: "n1", type: "inject", name: "Start", changeType: "added" },
      { id: "n2", type: "debug", name: "Output", changeType: "added" }
    ],
    wireOutcome: {
      connected: [
        { from: "n1", fromPort: 0, to: "n2", fromName: "Start", toName: "Output" },
        { from: "n1", fromPort: 0, to: "n2", fromName: "Start", toName: "Output" }
      ]
    }
  });
  assert.equal(model.changedNodes.length, 2);
  assert.equal(model.wires.connected.length, 1);
});

test("creation budgets scale by planned nodes and stay bounded", () => {
  assert.equal(limits.deriveAgentLoopStepBudget(3), 8);
  assert.equal(limits.deriveAgentLoopStepBudget(6), 10);
  assert.equal(limits.deriveAgentLoopStepBudget(30), 20);
  assert.equal(limits.deriveAgentLoopStepBudget(null), 8);
});

test("creation instructions explain the one-write contract", () => {
  assert.match(flowpilotSource, /creation run/i);
  assert.match(flowpilotSource, /whole flow in one apply_step/i);
  assert.match(buildPrompt, /whole flow in one apply_step/i);
});

test("plan steps are not nodes: a 5-step plan accepts a complete 4-node write", () => {
  const state = { active: true, plannedNodeCount: null, planStepCount: 5, firstWriteComplete: false };
  assert.equal(limits.creationFirstWriteError({
    newNodes: [
      { id: "n1", type: "inject", wires: [["n2"]] },
      { id: "n2", type: "http request", wires: [["n3"]] },
      { id: "n3", type: "function", wires: [["n4"]] },
      { id: "n4", type: "debug", wires: [[]] }
    ]
  }, state), null);
  assert.equal(limits.deriveAgentLoopStepBudget(state.plannedNodeCount || state.planStepCount), 9);
});

test("a lone node or an unwired comment/config node is a valid first write", () => {
  const lone = { active: true, plannedNodeCount: null, planStepCount: 1, firstWriteComplete: false };
  assert.equal(limits.creationFirstWriteError({ newNodes: [{ id: "c1", type: "inject", wires: [[]] }] }, lone), null);
  assert.equal(limits.creationFirstWriteError({ newNodes: [{ id: "c1", type: "comment", info: "Explains the flow" }] },
    { active: true, firstWriteComplete: false }), null);
  assert.equal(limits.creationFirstWriteError({
    newNodes: [
      { id: "n1", type: "inject", wires: [["n2"]] },
      { id: "n2", type: "mqtt out", broker: "b1", wires: [] },
      { id: "b1", type: "mqtt-broker" },
      { id: "c1", type: "comment", name: "About" }
    ]
  }, { active: true, planStepCount: 3, firstWriteComplete: false }), null);
});

test("one node per call on a multi-step plan is still rejected", () => {
  const state = { active: true, plannedNodeCount: null, planStepCount: 4, firstWriteComplete: false };
  assert.match(limits.creationFirstWriteError({ newNodes: [{ id: "n1", type: "inject", wires: [["n2"]] }] }, state),
    /send the whole flow in one apply_step/);
  assert.match(limits.creationFirstWriteError({
    newNodes: [
      { id: "n1", type: "inject", wires: [["n2"]] },
      { id: "n2", type: "function", wires: [[]] },
      { id: "n3", type: "debug", wires: [[]] }
    ]
  }, state), /send the whole flow in one apply_step/);
});

test("validation fails a text-returning http request feeding a function that reads JSON fields", () => {
  const validateSource = fs.readFileSync(path.join(root, "lib", "core", "validate.js"), "utf8");
  const start = validateSource.indexOf("    var HTTP_TEXT_PAYLOAD_MEMBERS");
  const end = validateSource.indexOf("    function validationFlowNodes()");
  const check = new Function(validateSource.slice(start, end) + "; return validationHttpReturnsText;")();
  const fn = (func) => ({ id: "f1", type: "function", name: "Extract", func });
  const http = (ret) => ({ id: "h1", type: "http request", name: "Fetch", ret, wires: [["f1"]] });
  const reads = fn("var t = msg.payload.current_condition[0].temp_C; return msg;");
  assert.equal(check(http("txt"), { f1: reads }).status, "fail");
  assert.match(check(http(undefined), { f1: reads }).message, /set ret to "obj"/);
  assert.equal(check(http("obj"), { f1: reads }), null);
  assert.equal(check(http("txt"), { f1: fn("var d = JSON.parse(msg.payload); return msg;") }), null);
  assert.equal(check(http("txt"), { f1: fn("msg.payload = msg.payload.trim(); return msg;") }), null);
});

test("layout ignores a feedback wire into an inject and loop back-edges (live S10)", () => {
  const layoutGeneratedFlow = new Function("return " + functionSource(applyReviewSource, "layoutGeneratedFlow"))();
  const feedback = [
    { id: "i", type: "inject", name: "Animate Gradient", w: 180, wires: [["f"]] },
    { id: "f", type: "function", name: "Gradient Animator", w: 180, wires: [["d"], ["i"]] },
    { id: "d", type: "debug", name: "Gradient Debug", w: 160, wires: [] }
  ];
  layoutGeneratedFlow(feedback);
  assertNoOverlaps(feedback, "feedback flow nodes do not overlap");
  const x = Object.fromEntries(feedback.map((n) => [n.id, n.x]));
  assert.ok(x.i < x.f && x.f < x.d, "inject, function, debug run left to right: " + JSON.stringify(x));

  const loop = [
    { id: "a", type: "inject", name: "Start", w: 160, wires: [["b"]] },
    { id: "b", type: "function", name: "Step", w: 160, wires: [["c"]] },
    { id: "c", type: "delay", name: "Wait", w: 160, wires: [["b", "e"]] },
    { id: "e", type: "debug", name: "Out", w: 160, wires: [] }
  ];
  layoutGeneratedFlow(loop);
  assertNoOverlaps(loop, "loop nodes do not overlap");
  const lx = Object.fromEntries(loop.map((n) => [n.id, n.x]));
  assert.ok(lx.a < lx.b && lx.b < lx.c && lx.c < lx.e, "a loop keeps its forward order: " + JSON.stringify(lx));
});

test("an add-on node the user didn't ask for is refused; a named one is allowed", () => {
  const moduleOf = (type) => ({ inject: "node-red", function: "node-red", ui_gauge: "node-red-dashboard",
    ui_text: "node-red-dashboard", "telegram sender": "node-red-contrib-telegrambot" })[type] || null;
  const nodes = [{ type: "inject" }, { type: "function" }, { type: "ui_gauge" }, { type: "ui_text" }];
  const s10 = "Do something cool and unique, something I likely haven't seen before, but no http or exec nodes.";
  assert.deepEqual(limits.uninvitedContribNodes(nodes, s10, moduleOf).map((n) => n.type), ["ui_gauge", "ui_text"]);
  assert.deepEqual(limits.uninvitedContribNodes(nodes, "show the dice roll on a dashboard gauge", moduleOf), []);
  assert.deepEqual(limits.uninvitedContribNodes([{ type: "telegram sender" }], "send it to telegram", moduleOf), []);
  assert.deepEqual(limits.uninvitedContribNodes([{ type: "mystery" }], s10, moduleOf), [], "unknown module is allowed");
});

test("a final reply right after a failed validation is sent back to fix it (bounded)", () => {
  const modes = fs.readFileSync(path.join(root, "lib", "core", "modes.js"), "utf8");
  const fn = modes.slice(modes.indexOf("function nudgeValidationFix"), modes.indexOf("function nudgeBuildVerification"));
  // The fields the nudge reads must be ones continueWithResult stores (a
  // first version read validationError/error-text and never fired live).
  const stored = modes.slice(modes.indexOf("agentWriteResults.push({"), modes.indexOf("agentWriteResults.push({") + 900);
  (fn.match(/last\.(\w+)/g) || []).map((m) => m.slice(5)).forEach((field) => {
    assert.match(stored, new RegExp("\\b" + field + ":"), "write results store " + field);
  });
  assert.match(fn, /last\.validationFailed !== true && last\.error !== true/);
  assert.match(fn, /validationFixNudges >= VALIDATION_FIX_NUDGES_MAX \|\| step >= stepBudget/);
  assert.match(modes, /VALIDATION_FIX_NUDGES_MAX = 2;/);
  const finalBranch = modes.slice(modes.indexOf("if (!data.toolCalls || !data.toolCalls.length) {"));
  assert.ok(finalBranch.indexOf("nudgeValidationFix(finalMessages)") < finalBranch.indexOf("completeRun(data)"),
    "the fix nudge runs before the run completes");
});

test("a group in newNodes doesn't fail the step as an uninstalled node type (live S10)", () => {
  const env = makeRed();
  const api = loadCore(env.red);
  const state = { active: true, plannedNodeCount: null, planStepCount: 3, firstWriteComplete: false };
  const result = applyStep(api, {
    summary: "Build and group",
    newNodes: [
      { id: "n1", type: "inject", name: "Go", wires: [["n2"]] },
      { id: "n2", type: "debug", name: "Show", wires: [] },
      { id: "g1", type: "group", name: "Demo", nodes: ["n1", "n2"] }
    ]
  }, state).result;
  assert.equal(Object.keys(env.nodes).length, 2, "the two real nodes are added");
  assert.ok(!/not installed/.test(JSON.stringify(result)), "no 'Node type not installed: group'");
  assert.equal(Array.isArray(result.groups) && result.groups[0].name, "Demo");
});
