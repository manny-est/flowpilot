"use strict";
// QA pass 4 (exploratory): a runtime error reached the result card as
// Node-RED's encoded Error JSON, stack and all.
const assert = require("node:assert/strict");
const test = require("node:test");
const { runtimeProofMessageText } = require("../lib/core/runtime-proof.js");

test("an encoded Node-RED Error shows only its message", () => {
  const enc = JSON.stringify({ __enc__: true, type: "error", data: { name: "Error", message: "connect ECONNREFUSED 127.0.0.1:9",
    stack: "Error: connect ECONNREFUSED 127.0.0.1:9\n    at TCPConnectWrap.afterConnect (node:net:1611:16)" } });
  const text = runtimeProofMessageText(enc);
  assert.equal(text, "connect ECONNREFUSED 127.0.0.1:9");
  assert.doesNotMatch(text, /__enc__|stack|TCPConnectWrap|[{}]/);
});

test("error objects and plain strings stay readable", () => {
  assert.equal(runtimeProofMessageText({ message: "boom", stack: "x\n at y (z.js:1:2)" }), "boom");
  assert.equal(runtimeProofMessageText({ name: "TypeError", message: "x is undefined" }), "TypeError: x is undefined");
  assert.equal(runtimeProofMessageText("RequestError: timeout"), "RequestError: timeout");
  assert.equal(runtimeProofMessageText({ error: { message: "inner" } }), "inner");
});
