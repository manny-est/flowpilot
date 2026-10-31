"use strict";
// Live Spark S3 + first full prompt-fuzz run: the goal checker invented
// non-graph gaps; each cost a fix attempt and correct runs ended as failed.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const fp = fs.readFileSync(path.join(__dirname, "../flowpilot.js"), "utf8");
const modes = fs.readFileSync(path.join(__dirname, "../lib/core/modes.js"), "utf8");
test("goal-check prompt and filter exclude non-graph gaps", () => {
  assert.match(fp, /Never report missing tests, explanations, comments, documentation/);
  const m = fp.match(/const NOT_A_GAP = (\/.*\/i);/);
  assert.ok(m);
  const re = eval(m[1]);
  ["No test case provided to verify the fix", "Original buggy code not included for comparison",
   "Graph summary missing; cannot verify", "Cannot confirm if Start sends 7"].forEach(g => assert.ok(re.test(g), g));
  ["contains an http request node but the user said no http", "Second output was not renamed to Beta log",
   "No one second delay after the Double function"].forEach(g => assert.ok(!re.test(g), g));
});
test("a goal-check fix starts only with step headroom", () => {
  assert.match(modes, /goalCheckFixAttempts < 2 && stepBudget - step >= 3/);
});

test("the goal-check summary carries the whole function body, not three lines", () => {
  const cards = require("../lib/core/cards.js");
  const func = "if (typeof msg.payload === 'string') {\n  msg.payload = msg.payload.toUpperCase();\n}\nreturn msg;";
  const out = cards.summarizeRunGraph({}, [], null, [{ changeDetails: [{ id: "f1", type: "function", name: "Upper", after: { id: "f1", type: "function", name: "Upper", func: func, wires: [[]] } }] }]);
  assert.match(out, /return msg;/);
});
