"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const root = path.join(__dirname, "fuzz", "prompt");
const prompts = require(path.join(root, "prompts.json"));
const codeJudge = require(path.join(root, "lib", "code-judge.js"));
const llmJudge = require(path.join(root, "lib", "llm-judge.js"));
const output = require(path.join(root, "lib", "output.js"));

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
