"use strict";
// Prompt fuzzer (typo-01, cc0a0e0): the goal check misread "Rname Start to
// Tmr." and the model renamed the node back. Runs that only rename or change
// properties of existing nodes, all verified, skip the goal check.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const modes = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");

test("property-only runs skip the goal check; builds still get it", () => {
  const fnSrc = modes.match(/function propertyEditsOnly\(\) \{[\s\S]*?\n        \}\n/)[0];
  const check = writes => new Function("agentWriteResults", fnSrc + "return propertyEditsOnly();")(writes);
  assert.equal(check([{ tool: "rename_node", propertyOnly: true, allPass: true }]), true);
  assert.equal(check([{ tool: "apply_step", propertyOnly: true, allPass: true }, { tool: "rename_node", propertyOnly: true, allPass: true }]), true);
  assert.equal(check([{ tool: "apply_step", propertyOnly: false, allPass: true }]), false, "a build is still checked");
  assert.equal(check([{ tool: "rename_node", propertyOnly: true, allPass: false }]), false, "an unverified edit is still checked");
  assert.equal(check([]), false);
  assert.match(modes, /if \(propertyEditsOnly\(\)\) \{ return false; \}/);
});
