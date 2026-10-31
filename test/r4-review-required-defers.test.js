"use strict";
// Round 4 review (live S3 on nodered): a function node without noerr is valid in
// Node-RED (its validator accepts empty), but validate.js's fallback "required"
// check reported "noerr is required". Node-RED's verdict must win when present.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../lib/core/validate.js"), "utf8");
const api = new Function("RED", source + "\nreturn { validateFlow };")({
  nodes: { getType: function (type) { return type === "function" || type === "debug"; } }
});
function fn(extra) {
  return Object.assign({ id: "f", type: "function", func: "return msg;", outputs: 1, wires: [[]],
    _def: { inputs: 1, outputs: 1, defaults: { noerr: { value: 0, required: true } } } }, extra);
}
function requiredFail(result) {
  return result.checks.some(c => c.check === "required-config" && c.status === "fail");
}
test("Node-RED's own verdict wins over the fallback required check", () => {
  assert.equal(requiredFail(api.validateFlow([fn({ valid: true })])), false, "valid per Node-RED: no invented failure");
  assert.equal(requiredFail(api.validateFlow([fn({})])), true, "not validated by Node-RED: fallback still applies");
});
