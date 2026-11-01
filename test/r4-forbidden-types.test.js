"use strict";
// QA pass 4b (S10): "…but no http or exec nodes" — gpt-4.1's plan still
// listed "Add an exec node". Node kinds the user ruled out are refused at
// write time, before anything is created.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const L = require("../lib/core/limits.js");

test("ruled-out words come from the user's constraint phrase only", () => {
  assert.deepEqual(L.forbiddenNodeWords("Do something cool, but no http or exec nodes."), ["http", "exec"]);
  assert.deepEqual(L.forbiddenNodeWords("Keep it, but do not add another HTTP node."), ["http"]);
  assert.deepEqual(L.forbiddenNodeWords("Build it with no delay before the debug"), ["delay"]);
  assert.deepEqual(L.forbiddenNodeWords("Something with no function, change, or switch nodes"), ["function", "change", "switch"]);
  assert.deepEqual(L.forbiddenNodeWords("Add a debug node after this"), []);
});

test("new nodes of a ruled-out kind are found; others and near-words aren't", () => {
  const nodes = [{ type: "exec" }, { type: "http request" }, { type: "function" }, { type: "change" }, { type: "debug" }];
  assert.deepEqual(L.forbiddenNewNodes(nodes, "but no http or exec nodes").map(f => f.type), ["exec", "http request"]);
  assert.deepEqual(L.forbiddenNewNodes(nodes, "add a delay, no changes to the inject"), [], "'changes' isn't the change node");
});

test("the client's write precheck refuses them before creating anything", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "main.js"), "utf8");
  const src = main.match(/function applyStepPrecheck\(args, creationState\) \{[\s\S]*?\n    \}\n/)[0];
  const precheck = new Function("RED", "creationFirstWriteError", "uninvitedContribNodes", "forbiddenNewNodes",
    src + "return applyStepPrecheck;")({ nodes: { getType: () => ({}) } }, undefined, undefined, L.forbiddenNewNodes);
  const r = precheck({ newNodes: [{ id: "n1", type: "inject" }, { id: "n2", type: "exec" }] },
    { userPrompt: "Do something cool, but no http or exec nodes." });
  assert.ok(r && /ruled these out: exec/.test(r.error) && r.retryable === true);
  assert.equal(precheck({ newNodes: [{ id: "n1", type: "inject" }] }, { userPrompt: "no http or exec nodes" }), null);
});
