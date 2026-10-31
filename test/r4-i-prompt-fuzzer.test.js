"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const root = path.join(__dirname, "fuzz", "prompt");
const prompts = require(path.join(root, "prompts.json"));
const executor = require(path.join(root, "lib", "executor.js"));
const codeJudge = require(path.join(root, "lib", "code-judge.js"));
const llmJudge = require(path.join(root, "lib", "llm-judge.js"));
const output = require(path.join(root, "lib", "output.js"));

function toolCall(id, name, args) {
  return { id: id, type: "function", function: { name: name, arguments: JSON.stringify(args || {}) } };
}

function fakePostFactory(responses, requests) {
  let index = 0;
  return async function fakePost(url, body) {
    requests.push({ path: new URL(url).pathname, body: body });
    return { status: 200, body: responses[index++] || { message: "done" } };
  };
}

test("prompt corpus has complete, diverse fixture-backed coverage", function () {
  assert.ok(prompts.length >= 120, "at least 120 prompts are required");
  const ids = new Set();
  const categories = {};
  prompts.forEach(function (entry) {
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(entry.id), "duplicate prompt id: " + entry.id);
    ids.add(entry.id);
    assert.ok(entry.fixture, entry.id + " needs a fixture");
    assert.ok(typeof entry.prompt === "string" && entry.prompt.length > 0, entry.id + " needs a prompt");
    assert.ok(entry.expect && typeof entry.expect === "object", entry.id + " needs expect");
    categories[entry.category] = (categories[entry.category] || 0) + 1;
    const fixture = path.join(root, "fixtures", entry.fixture + ".json");
    assert.ok(fs.existsSync(fixture), entry.id + " references missing fixture " + entry.fixture);
    assert.doesNotThrow(function () { JSON.parse(fs.readFileSync(fixture, "utf8")); }, entry.id + " fixture parses");
  });
  ["build", "existing", "config", "bug", "rename", "delete", "document", "multi", "constraint", "follow-up", "typo", "vague", "small-talk"].forEach(function (category) {
    assert.ok((categories[category] || 0) >= 10, category + " needs at least 10 prompts");
  });
});

test("every prompt starts through the browser chat front door", async function () {
  const requests = [];
  const post = fakePostFactory([{ message: "The flow is ready." }], requests);
  await executor.runPrompt({ id: "front-door", category: "document", fixture: "empty-tab", prompt: "Explain this flow." }, "token", { post: post });
  assert.strictEqual(requests[0].path, "/flowpilot/chat");
  assert.strictEqual(requests[0].body.strategy, "agent");
  assert.ok(requests[0].body.intake);
  assert.ok(requests[0].body.context);
});

test("a proposed modify action is approved and dispatched with its targets", async function () {
  const requests = [];
  const post = fakePostFactory([
    { toolCalls: [toolCall("proposal-1", "propose_action", {
      action: "modify", summary: "Rename Double to Twin", targets: ["function-1"],
      approvedOperations: [{ operation: "modify-config", nodeId: "function-1" }]
    })] },
    { message: "Renamed." }
  ], requests);
  await executor.runPrompt({ id: "proposal", category: "build", fixture: "inject-function-debug", prompt: "Rename Double to Twin." }, "token", { post: post });
  assert.deepStrictEqual(requests.map(function (request) { return request.path; }), ["/flowpilot/chat", "/flowpilot/modify"]);
  assert.deepStrictEqual(requests[1].body.targetLock.ids, ["function-1"]);
  assert.deepStrictEqual(requests[1].body.context.nodes.map(function (node) { return node.id; }), ["function-1"]);
  assert.deepStrictEqual(requests[1].body.approvedOperations, [{ operation: "modify-config", nodeId: "function-1" }]);
  assert.strictEqual(requests[1].body.creationRun, false);
});

test("follow-up is a chat turn with prior history and the touched index", async function () {
  const requests = [];
  const post = fakePostFactory([
    { toolCalls: [toolCall("proposal-follow", "propose_action", {
      action: "modify", summary: "Rename Double to Twin", targets: ["function-1"]
    })] },
    { toolCalls: [toolCall("write-follow", "rename_node", { nodeId: "function-1", name: "Twin" })] },
    { message: "Renamed Double to Twin." },
    { message: "The updated flow is ready." }
  ], requests);
  await executor.runPrompt({ id: "follow-up", category: "follow-up", fixture: "inject-function-debug",
    prompt: "Rename Double to Twin.", followUp: "Now explain the change." }, "token", { post: post });
  assert.strictEqual(requests[3].path, "/flowpilot/chat");
  assert.deepStrictEqual(requests[3].body.history, [
    { role: "user", content: "Rename Double to Twin." },
    { role: "assistant", content: "Renamed Double to Twin." }
  ]);
  assert.ok(requests[3].body.intake.touchedNodeIndex.runs.some(function (run) {
    return run.nodeIds.indexOf("function-1") !== -1;
  }));
});

test("action precedence reports writes over later questions", async function () {
  const requests = [];
  const post = fakePostFactory([
    { toolCalls: [toolCall("proposal-2", "propose_action", {
      action: "modify", summary: "Rename Double to Twin", targets: ["function-1"]
    })] },
    { toolCalls: [toolCall("write-1", "rename_node", { nodeId: "function-1", name: "Twin" })] },
    { toolCalls: [toolCall("question-1", "ask_user", { question: "Continue?", options: ["yes", "no"] })] }
  ], requests);
  const result = await executor.runPrompt({ id: "write-then-ask", category: "existing", fixture: "inject-function-debug", prompt: "Rename Double to Twin." }, "token", { post: post });
  assert.strictEqual(result.actual.action, "write");

  const askRequests = [];
  const askResult = await executor.runPrompt({ id: "question-only", category: "vague", fixture: "empty-tab", prompt: "Make it better." }, "token", {
    post: fakePostFactory([{ toolCalls: [toolCall("question-2", "ask_user", { question: "Which flow?", options: ["one", "two"] })] }], askRequests)
  });
  assert.strictEqual(askResult.actual.action, "ask");
  assert.deepStrictEqual(askResult.actual.askedOptions, ["one", "two"]);

  const answerRequests = [];
  const answerResult = await executor.runPrompt({ id: "answer-only", category: "build", fixture: "empty-tab", prompt: "Hi there!" }, "token", {
    post: fakePostFactory([{ message: "Hello!" }], answerRequests)
  });
  assert.strictEqual(answerResult.actual.action, "answer");
});

test("graph truth ignores an orphaned pre-existing node but checks run-added nodes", function () {
  const orphanedFixture = { flow: [
    { id: "tab-1", type: "tab", label: "Test" },
    { id: "inject-1", type: "inject", z: "tab-1", wires: [[]] },
    { id: "old-debug", type: "debug", z: "tab-1", complete: "msg", wires: [] }
  ] };
  const orphaned = codeJudge.judgeCode(orphanedFixture, { actual: { graphTruth: { nodeIds: ["inject-1"] } } });
  assert.strictEqual(orphaned.pass, true, JSON.stringify(orphaned));

  const addedUnwired = codeJudge.judgeCode({ flow: orphanedFixture.flow.concat([
    { id: "new-debug", type: "debug", z: "tab-1", complete: "true", wires: [] }
  ]) }, { actual: { graphTruth: { nodeIds: ["new-debug"], addedNodeIds: ["new-debug"] } } });
  assert.strictEqual(addedUnwired.pass, false, "an unwired node added by the run must fail graph truth");
  assert.ok(addedUnwired.failures.some(function (failure) { return failure.indexOf("new-debug") !== -1; }));
});

test("all prompt fixtures are lint-clean before execution", function () {
  const fixtureDir = path.join(root, "fixtures");
  fs.readdirSync(fixtureDir).filter(function (name) { return name.endsWith(".json"); }).forEach(function (name) {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8"));
    const result = codeJudge.judgeCode({ flow: fixture });
    assert.strictEqual(result.validation.failures.length, 0, name + " validation failures");
    assert.strictEqual(result.validation.warnings.length, 0, name + " lint warnings");
  });
});

test("code judge catches forbidden types and unwired nodes while accepting clean graphs", function () {
  const base = {
    flow: [
      { id: "tab-1", type: "tab", label: "Test" },
      { id: "inject-1", type: "inject", z: "tab-1", wires: [["debug-1"]] },
      { id: "debug-1", type: "debug", z: "tab-1", wires: [] }
    ]
  };
  const clean = codeJudge.judgeCode(base, { expect: { mustContainTypes: ["inject", "debug"] } });
  assert.strictEqual(clean.pass, true, JSON.stringify(clean));
  const forbidden = codeJudge.judgeCode({ flow: base.flow.concat([
    { id: "http-1", type: "http request", z: "tab-1", wires: [["debug-1"]] }
  ]) }, { expect: { mustNotContainTypes: ["http request"] } });
  assert.strictEqual(forbidden.pass, false, "a graph containing a forbidden type must fail");
  const unwired = codeJudge.judgeCode({ flow: base.flow.map(function (node) {
    return node.id === "inject-1" ? Object.assign({}, node, { wires: [[]] }) : node;
  }) }, { expect: { mustContainTypes: ["inject", "debug"] } });
  assert.strictEqual(unwired.pass, false, "a required-input node with no incoming edge must fail graph truth");
});

test("judge request never carries the API key and redacts it from errors", function () {
  const secret = "judge-test-key-123";
  const request = llmJudge.buildJudgeRequest({
    prompt: "make a flow",
    finalText: "Done",
    graph: { nodes: [{ id: "n1", type: "inject" }], wires: [] }
  }, "gpt-4.1", secret);
  assert.strictEqual(JSON.stringify(request).includes(secret), false);
  const error = llmJudge.redactJudgeError(new Error("request failed for " + secret), secret);
  assert.strictEqual(error.includes(secret), false);
  assert.ok(error.includes("[redacted]"));
});

test("result line has the required exact shape", function () {
  assert.strictEqual(output.formatResultLine({
    model: "gpt-4.1", codePassed: 9, total: 10, judgePassed: 8, bothPassed: 7, errors: 1
  }), "PROMPT-FUZZ RESULT: gpt-4.1 code 9/10 (90.0%) · judge 8/10 (80.0%) · both 7/10 (70.0%) · errors 1");
});
