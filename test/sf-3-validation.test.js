"use strict";

// SF-3 fixtures exercise the real client validation fragment and the real
// authenticated server route. The client fragment is evaluated as the
// assembled browser code would be, rather than copied into a test helper.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadRuntime, call, provider } = require("./helpers/route-harness");

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "validate.js"), "utf8");
const reviewSource = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "apply-review.js"), "utf8");
assert.ok(!/if \(!n\.valid\)\s*\{\s*n\.valid\s*=\s*true/.test(reviewSource), "invalid nodes are not forced valid");
const api = new Function("RED", source + "\nreturn { validateFlow, validationOutcomeForAttempt };" )({
  nodes: { getType: function (type) { return type === "inject" || type === "debug" || type === "function"; } }
});

function installedNode(id, type, extra) {
  return Object.assign({ id: id, type: type, _def: { inputs: 1, outputs: type === "debug" ? 0 : 1 }, wires: [] }, extra || {});
}

let result = api.validateFlow([
  installedNode("inject-1", "inject", { wires: [["debug-1"]] }),
  installedNode("debug-1", "debug")
], { isInstalled: function (type) { return type === "inject" || type === "debug"; } });
assert.strictEqual(result.ok, true, "installed nodes and valid wire pass");
assert.ok(result.checks.some(function (check) { return check.status === "pass" && check.check === "wire"; }));

result = api.validateFlow([
  { id: "custom-1", type: "contrib-widget", wires: [], _def: { module: "node-red-contrib-widget" } }
], { isInstalled: function () { return false; } });
assert.strictEqual(result.ok, false, "uninstalled node blocks");
assert.ok(/node-red-contrib-widget/.test(result.failures[0].message), "palette package is named");
assert.ok(/core alternative/.test(result.failures[0].message), "core alternative is offered");

result = api.validateFlow([
  installedNode("source", "inject", { outputs: 1, wires: [[], ["missing"]] }),
  installedNode("sink", "debug")
], { isInstalled: function () { return true; } });
assert.strictEqual(result.ok, false, "bad target and port block");
assert.ok(result.failures.some(function (check) { return check.check === "wire-port"; }));
result = api.validateFlow([
  installedNode("source", "inject", { wires: [["missing"]] })
], { isInstalled: function () { return true; } });
assert.ok(result.failures.some(function (check) { return check.check === "wire-target"; }));

result = api.validateFlow([
  installedNode("required", "inject", { _def: { inputs: 1, outputs: 1, defaults: { topic: { required: true } } } }),
  installedNode("credential", "inject", { validationErrors: ["missing credential"] })
], { isInstalled: function () { return true; } });
assert.strictEqual(result.ok, false, "invalid required config blocks");
assert.ok(result.failures.some(function (check) { return check.check === "required-config"; }));
assert.strictEqual(result.needsYou.length, 1, "credential issue is a Needs you stop");
assert.ok(/not be retried/i.test(result.needsYou[0].message));

result = api.validateFlow([
  installedNode("multi", "function", { outputs: 2, func: "return msg;" }),
  installedNode("single", "function", { outputs: 1, func: "msg.payload = 1;\\nreturn msg;" }),
  installedNode("array", "function", { outputs: 1, func: "return [msg];" })
], { isInstalled: function () { return true; } });
assert.strictEqual(result.ok, true, "warnings do not block");
assert.ok(result.warnings.length >= 3, "common mistake and built-in lint warnings are reported");
assert.ok(result.warnings.some(function (check) { return /multiple outputs/.test(check.message); }));
assert.ok(result.warnings.some(function (check) { return /Change node/.test(check.message); }));

assert.strictEqual(api.validationOutcomeForAttempt(1, { ok: false, retryableFailures: [{}], needsYou: [] }), "retry");
assert.strictEqual(api.validationOutcomeForAttempt(3, { ok: false, retryableFailures: [{}], needsYou: [] }), "out-of-tries");
assert.strictEqual(api.validationOutcomeForAttempt(3, { ok: false, retryableFailures: [], needsYou: [{}] }), "needs-you");

(async function () {
  const runtime = loadRuntime({ activeProviderId: "p1", providers: [provider(1)] });
  const harmless = await call(runtime, "POST", "/flowpilot/validate-function", {
    code: "process.exit(99);\nreturn msg;",
    initialize: "throw new Error('would run');",
    finalize: "process.exit(98);"
  });
  assert.strictEqual(harmless.status, 200, "compile-only route responds");
  assert.strictEqual(harmless.body.ok, true, "throw/process.exit bodies compile without executing");

  const bad = await call(runtime, "POST", "/flowpilot/validate-function", {
    code: "msg.payload = ;\nreturn msg;"
  });
  assert.strictEqual(bad.status, 200, "syntax errors are validation results, not route crashes");
  assert.strictEqual(bad.body.ok, false);
  assert.ok(bad.body.checks.func.message, "syntax error message returned");
  assert.strictEqual(typeof bad.body.checks.func.line, "number", "syntax error line returned");
  assert.ok(bad.body.checks.func.line >= 1);

  const empty = await call(runtime, "POST", "/flowpilot/validate-function", {});
  assert.strictEqual(empty.status, 400, "empty validation request rejected");
  console.log("sf-3 validation tests passed");
})().catch(function (err) { console.error(err); process.exit(1); });
