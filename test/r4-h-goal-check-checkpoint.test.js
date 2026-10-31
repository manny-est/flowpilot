"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const cards = require("../lib/core/cards.js");

function fakeHistory(entries) {
  return {
    _entries: entries,
    depth() { return this._entries.length; },
    peek() { return this._entries[this._entries.length - 1]; },
    push(entry) { this._entries.push(entry); },
    pop() { return this._entries.pop(); }
  };
}

test("summarizeRunGraph is readable, id-free, includes config/proof, and redacts secrets", () => {
  const summary = cards.summarizeRunGraph({ timer: "real-timer", request: "real-request" }, [
    { t: "add", nodes: [
      { id: "real-timer", type: "inject", name: "Timer", repeat: "300", wires: [["real-request"]] },
      { id: "real-request", type: "http request", method: "GET", url: "https://api.example.test", password: "super-secret-value", wires: [] }
    ], links: [{ source: "real-timer", target: "real-request" }] }
  ], { state: "observed", observedValue: "72", error: null });

  assert.match(summary, /inject "Timer".*repeat 300s/);
  assert.match(summary, /http request GET https:\/\/api\.example\.test/);
  assert.match(summary, /72/);
  assert.match(summary, /redacted/i);
  assert.doesNotMatch(summary, /real-timer|real-request/);
  assert.doesNotMatch(summary, /super-secret-value/);
});

test("a goal-check gap gets one shared-budget fix attempt and is checked again", async () => {
  const { runGoalCheckLoop } = require("../lib/core/goal-check.js");
  const answers = [
    { done: false, gaps: ["contains an http request node but the user said no http"] },
    { done: true, gaps: [] }
  ];
  const fixes = [];
  const result = await runGoalCheckLoop({
    maxFixAttempts: 2,
    check: async () => answers.shift(),
    fix: async (gap) => { fixes.push(gap); }
  });
  assert.deepEqual(fixes, ["contains an http request node but the user said no http"]);
  assert.equal(result.done, true);
  assert.equal(result.checks, 2);
});

test("an unparseable goal-check answer is safe and counts as done", async () => {
  const { parseGoalCheck } = require("../lib/core/goal-check.js");
  assert.deepEqual(parseGoalCheck("not json"), { done: true, gaps: [], unparseable: true });
  const { runGoalCheckLoop } = require("../lib/core/goal-check.js");
  let checks = 0;
  const result = await runGoalCheckLoop({
    check: async () => { checks++; return parseGoalCheck("not json"); },
    fix: async () => { throw new Error("must not fix an unparseable answer"); }
  });
  assert.equal(checks, 1);
  assert.equal(result.done, true);
  assert.equal(result.unparseable, true);
});

test("answer-only and no-write paths do not schedule a goal check", () => {
  const modes = fs.readFileSync(path.join(__dirname, "../lib/core/modes.js"), "utf8");
  assert.match(modes, /runAnswerPhase[\s\S]{0,1200}goalCheck/);
  assert.match(modes, /agentWriteResults\.length[\s\S]{0,500}goalCheck/);
});

test("failed run card offers checkpoint rollback and preserves history before the run", () => {
  const before = { t: "edit", node: "before-run" };
  const runEntry = { t: "multi", events: [{ t: "add", node: "created" }] };
  const history = fakeHistory([before, runEntry]);
  const record = { historyEntry: runEntry, checkpointDepth: 1, failed: true };
  const result = cards.undoResultCard(record, { history });
  assert.equal(result.undone, true);
  assert.equal(result.message, "Put back");
  assert.deepEqual(history._entries, [before]);
  assert.equal(record.undone, true);
});

test("the assembled bundle includes the goal-check fragment", () => {
  const { buildCoreScript, FRAGMENT_ORDER } = require("../lib/build-core-script.js");
  assert.ok(FRAGMENT_ORDER.includes("goal-check.js"));
  assert.match(buildCoreScript(), /function parseGoalCheck\(/);
});

console.log("R4-H regression tests loaded");
