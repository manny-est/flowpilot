"use strict";
// QA pass 4c (Spark S4): Test it's card read "Run: observed —
// {"latitude":48.85,…"; raw JSON never reaches the chat.
const assert = require("node:assert/strict");
const test = require("node:test");
const { runtimeDescribeValue, runtimeProofOutcome } = require("../lib/core/runtime-proof.js");

test("observed values are described, never shown as JSON", () => {
  const api = JSON.stringify({ latitude: 48.85, longitude: 2.35, generationtime_ms: 0.1, utc_offset_seconds: 0, timezone: "GMT", elevation: 43 });
  assert.equal(runtimeDescribeValue(api), "an object with latitude, longitude, generationtime_ms, utc_offset_seconds and 2 more fields");
  assert.equal(runtimeDescribeValue({ temp: 14, unit: "C" }), "temp: 14, unit: C");
  assert.equal(runtimeDescribeValue([1, 2, 3]), "a list of 3 items");
  assert.equal(runtimeDescribeValue("hello"), "hello");
  assert.equal(runtimeDescribeValue("{not json"), "{not json");
});

test("the observed card line carries no JSON", () => {
  const out = runtimeProofOutcome([{ nodeId: "n1", node: "Store Temp", value: JSON.stringify({ latitude: 48.85, longitude: 2.35, a: 1, b: 2, c: 3 }), valueType: "object" }], {});
  assert.doesNotMatch(out.label, /[{}"]/);
  assert.match(out.label, /^Run: observed — an object with latitude/);
});
