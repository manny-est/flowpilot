"use strict";

// P2-D: the debug `complete` lint (#9) and the lane label only on
// propose_action (#31).
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "validate.js"), "utf8");
const api = new Function("RED", source + "\nreturn { validateFlow };")({
  nodes: { getType: function (type) { return type === "inject" || type === "debug"; } }
});
const installed = { isInstalled: function () { return true; } };
function debugNode(extra) {
  return Object.assign({ id: "d1", type: "debug", name: "Out", _def: { inputs: 1, outputs: 0 }, wires: [] }, extra);
}
function lint(node) {
  return api.validateFlow([node], installed).checks.filter(function (c) { return c.check === "debug-complete"; });
}

let checks = lint(debugNode({ complete: "msg", targetType: "msg" }));
assert.strictEqual(checks.length, 1, "complete: msg is flagged");
assert.strictEqual(checks[0].status, "warn", "it's a warning, not a blocker");
assert.ok(/shows msg\.msg; use 'true' for the whole message/.test(checks[0].message));
assert.strictEqual(api.validateFlow([debugNode({ complete: "msg" })], installed).ok, true, "the warning doesn't block");

["true", "false", "payload", "payload.temp", "topic"].forEach(function (value) {
  assert.strictEqual(lint(debugNode({ complete: value, targetType: "msg" })).length, 0, value + " is fine");
});
assert.strictEqual(lint(debugNode({ complete: "payload & ' ' & topic", targetType: "jsonata" })).length, 0,
  "a JSONata expression is not a property path, and it's valid");
checks = lint(debugNode({ complete: "pay load!", targetType: "msg" }));
assert.strictEqual(checks.length, 1);
assert.strictEqual(checks[0].status, "warn", "an unusual value warns, never fails");

// #31: the server stamps a lane only on responses that carry propose_action.
const server = fs.readFileSync(path.join(__dirname, "..", "flowpilot.js"), "utf8");
const laneFn = server.slice(server.indexOf("function laneForRequest("), server.indexOf("function laneFields("));
assert.ok(/if \(!proposal\) \{ return null; \}/.test(laneFn), "no propose_action, no lane");
assert.ok(!/kind: "unclear"/.test(laneFn), "ask_user and plain replies are no longer labelled ASK");

console.log("P2-D lint and lane tests passed");
