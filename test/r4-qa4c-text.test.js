"use strict";
// QA pass 4c: "(no content returned)" reached the chat (Spark S11a); a skip
// notice repeated the same step (gpt-4.1 S7).
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const modes = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");

test("no '(no content returned)' fallback reaches the chat", () => {
  assert.doesNotMatch(modes, /\|\| "\(no content returned\)"/);
  assert.match(modes, /var EMPTY_REPLY_TEXT = "The model didn't send an answer/);
});

test("skip notices list each step once, ignoring end punctuation", () => {
  const n = (modes.match(/all\.indexOf\(summary\) === i/g) || []).length;
  assert.equal(n, 2);
  assert.match(modes, /withoutTerminalPunctuation\(String\(result\.summary\)\.trim\(\)\)/);
});

test("a goal-check fix retry needs the run's own system prompt and request (Spark S10 'lost context')", () => {
  const block = modes.slice(modes.indexOf("function runGoalCheckBeforeDone"), modes.indexOf("function runGoalCheckBeforeDone") + 2600);
  assert.match(block, /hasRunContext = lastAgentMessages\.some\(function \(m\) \{ return m && m\.role === "system"; \}\)/);
  assert.match(block, /stepBudget - step >= 3 &&\s*hasRunContext\)/);
});
