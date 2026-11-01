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
