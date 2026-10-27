"use strict";

const assert = require("assert");
const { scoreAnswer } = require("./answer-corpus/answer-runner");

const fixture = {
  mustInclude: ["Poll", "https://api\\.example\\.test/v1/status"],
  mustNotInclude: ["every 30 seconds"]
};
assert.strictEqual(scoreAnswer("Poll calls https://api.example.test/v1/status.", fixture).pass, true);
assert.strictEqual(scoreAnswer("Poll calls https://api.example.test/v1/status every 30 seconds.", fixture).pass, false);
assert.strictEqual(scoreAnswer("Poll calls another endpoint.", fixture).pass, false);
console.log("answer corpus scoring tests passed");
