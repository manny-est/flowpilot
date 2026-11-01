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
  const check = (writes, prompt) => new Function("agentWriteResults", "payload", fnSrc + "return propertyEditsOnly();")(writes, { prompt: prompt });
  const rename = (name, extra) => Object.assign({ tool: "rename_node", propertyOnly: true, allPass: true, writtenValues: [name] }, extra || {});
  assert.equal(check([rename("Tmr.")], "Rname Start to Tmr."), true, "typo-01: the new name is in the request");
  assert.equal(check([rename("Twin"), { tool: "apply_step", propertyOnly: true, allPass: true, writtenValues: ["5"] }], "Rename Double to Twin and set it to 5"), true);
  assert.equal(check([rename("Result from zen API")], "That failed, fix it so it actually works"), false,
    "QA 4b: a 'fix it' run that only renamed something is still checked");
  assert.equal(check([{ tool: "apply_step", propertyOnly: false, allPass: true, writtenValues: [] }], "x"), false, "a build is still checked");
  assert.equal(check([rename("Twin", { allPass: false })], "Rename to Twin"), false, "an unverified edit is still checked");
  assert.equal(check([], "x"), false);
  assert.match(modes, /if \(propertyEditsOnly\(\)\) \{ return false; \}/);
});
