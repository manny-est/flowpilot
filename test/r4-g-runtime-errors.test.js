"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const proof = require("../lib/core/runtime-proof.js");
const cards = require("../lib/core/cards.js");

function makeComms() {
  const subscriptions = new Map();
  const calls = { subscribe: [], unsubscribe: [] };
  return {
    calls,
    subscribe(topic, fn) {
      calls.subscribe.push({ topic, fn });
      subscriptions.set(topic, fn);
    },
    unsubscribe(topic, fn) {
      calls.unsubscribe.push({ topic, fn });
      if (subscriptions.get(topic) === fn) subscriptions.delete(topic);
    },
    publish(topic, message) {
      const fn = subscriptions.get(topic) || subscriptions.get(topic.split("/")[0]) || subscriptions.get("status/#");
      if (fn) fn(topic, message);
    }
  };
}

function observerFor(comms, options) {
  return proof.createRuntimeProofObserver({ comms }, options);
}

test("a touched-node debug error is retryable and a clean re-test proves", () => {
  const comms = makeComms();
  const observer = observerFor(comms, {
    touchedIds: ["fn-1"],
    nodeInfo: { "fn-1": { name: "Format", type: "function" } }
  });
  observer.subscribe();
  comms.publish("debug", { id: "fn-1", name: "Format", level: 20, msg: "TypeError: bad value\n    at line 1" });
  const failed = proof.runtimeProofOutcome([], { goalNames: ["Output"], runtimeErrors: observer.snapshot().errors });
  assert.equal(failed.state, "runtime-error");
  assert.equal(failed.retryable, true);
  assert.equal(failed.label, "Format (function) threw: TypeError: bad value");
  assert.equal(proof.runtimeProofRetryDecision(failed, 1, 2).retry, true);

  observer.reset();
  comms.publish("debug", { id: "fn-1", name: "Format", level: 10, msg: "clean output" });
  const clean = proof.runtimeProofOutcome([
    { kind: "debug", nodeId: "fn-1", value: "clean output", node: "Format" }
  ], { goalNames: ["Output"] });
  assert.equal(clean.state, "observed");
  assert.equal(proof.runtimeProofRetryDecision(clean, 2, 2).retry, false);
  observer.unsubscribe();
});

test("two failed attempts end with a plain failure line, not Ran", () => {
  const failed = proof.runtimeProofOutcome([], {
    goalNames: ["Output"],
    runtimeErrors: [{ nodeId: "fn-1", nodeName: "Format", nodeType: "function", message: "ECONNREFUSED" }]
  });
  assert.equal(proof.runtimeProofRetryDecision(failed, 2, 2).retry, false);
  assert.match(failed.label, /^Format \(function\) threw: ECONNREFUSED$/);
  assert.doesNotMatch(failed.label, /Ran/);
});

test("no output is retryable and names the last node that produced output", () => {
  const outcome = proof.runtimeProofOutcome([], {
    state: "no-output",
    goalNames: ["Output"],
    lastOutputNode: "Format",
    lastOutputValue: "before-end"
  });
  assert.equal(outcome.state, "no-output");
  assert.equal(outcome.retryable, true);
  assert.equal(outcome.label, "No output reached Output; Format last produced before-end");
  const retry = proof.runtimeProofRetryDecision(outcome, 1, 2);
  assert.equal(retry.retry, true);
  assert.match(retry.message, /Got nothing:.*Format last produced before-end/);
});

test("proof subscriptions are removed and unrelated errors are ignored", () => {
  const comms = makeComms();
  const observer = observerFor(comms, {
    touchedIds: ["touched"],
    nodeInfo: { touched: { name: "Touched", type: "function" } }
  });
  observer.subscribe();
  comms.publish("debug", { id: "elsewhere", name: "Elsewhere", level: 20, msg: "unrelated" });
  assert.deepEqual(observer.snapshot().errors, []);
  comms.publish("status/touched", { fill: "red", shape: "dot", text: "failed" });
  assert.equal(observer.snapshot().errors[0].message, "failed");
  assert.equal(observer.snapshot().errors[0].count, 1);
  assert.deepEqual(observer.snapshot().statuses[0], {
    nodeId: "touched", nodeName: "Touched", nodeType: "function",
    fill: "red", shape: "dot", text: "failed", at: observer.snapshot().statuses[0].at
  });
  comms.publish("status/touched", { fill: "green", shape: "ring", text: "ready" });
  assert.deepEqual(observer.snapshot().statuses[0], {
    nodeId: "touched", nodeName: "Touched", nodeType: "function",
    fill: "green", shape: "ring", text: "ready", at: observer.snapshot().statuses[0].at
  });
  observer.unsubscribe();
  assert.deepEqual(comms.calls.subscribe.map((call) => call.topic), ["debug", "status/#"]);
  assert.deepEqual(comms.calls.unsubscribe.map((call) => call.topic), ["debug", "status/#"]);
  assert.equal(comms.calls.unsubscribe[0].fn, comms.calls.subscribe[0].fn);
  assert.equal(comms.calls.unsubscribe[1].fn, comms.calls.subscribe[1].fn);
});

test("main proof wiring subscribes, confirms no-tap runtime, and cleans up", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "main.js"), "utf8");
  const modes = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");
  assert.match(main, /createRuntimeProofObserver\(typeof RED/);
  assert.match(main, /buildRuntimeObserver\.subscribe\(\)/);
  assert.match(main, /buildRuntimeObserver\.snapshot\(\)/);
  assert.match(main, /buildRuntimeObserver\.unsubscribe/);
  assert.match(main, /confirmDeploy\(null, expected\.runNodes, expected\.runWires/);
  assert.match(main, /runtimeProofOutcome\(\[\], goal\)\.label/);
  assert.match(modes, /runtimeProofRetryDecision\(resultObj, buildRuntimeFailureAttempts, runtimeRetryLimit\)/);
  assert.match(modes, /Math\.min\(buildMaxDeploys, 2\)/);
});

test("the final run card prefers a runtime error over stale evidence", () => {
  const run = cards.buildResultCardModel({ verifyResults: [{
    state: "runtime-error",
    label: "Format (function) threw: TypeError: bad value",
    evidenceCount: 1,
    evidence: [{ kind: "status", node: "Format", value: "green — ready" }]
  }] }).run;
  assert.equal(run.label, "Format (function) threw: TypeError: bad value");
  assert.doesNotMatch(run.label, /green|Run: observed|Ran/);
});

console.log("R4-G runtime error tests loaded");
