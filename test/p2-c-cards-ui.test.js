"use strict";

// P2-C is intentionally source-level for the browser bundle: the client core
// is assembled in Node-RED's browser rather than exposed as a CommonJS app.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = process.env.P2_SOURCE_ROOT || path.join(__dirname, "..");
const applyReview = fs.readFileSync(path.join(root, "lib/core/apply-review.js"), "utf8");
const main = fs.readFileSync(path.join(root, "lib/core/main.js"), "utf8");
const modes = fs.readFileSync(path.join(root, "lib/core/modes.js"), "utf8");
const init = fs.readFileSync(path.join(root, "lib/core/init.js"), "utf8");
const markdown = fs.readFileSync(path.join(root, "lib/core/markdown.js"), "utf8");
const css = fs.readFileSync(path.join(root, "flowpilot-core.css"), "utf8");

// #35: the insertion path considers live nodes, and a pending forward wire
// contributes the existing endpoint as the next step's spatial anchor.
assert.ok(/RED\.nodes\.eachNode\(function \(existing\)/.test(applyReview), "layout checks existing canvas positions");
assert.ok(/runWireState && runWireState\.pending/.test(applyReview), "layout uses pending-wire anchors");
assert.ok(/Math\.abs\(p\.y - y\) < 90/.test(applyReview), "layout keeps a node-height gap");

// #17: the plan card no longer creates the old four-badge row.
assert.strictEqual(modes.indexOf("fp-propose-mode-row"), -1, "plan card badge row is gone");

// #18: proposals receive concrete fallback steps, while the echoed default
// PLAN path can skip the empty card. Explicit review flags remain protected.
assert.ok(/deriveProposalPlanItems/.test(modes), "proposal fallback steps exist");
assert.ok(/echoedRequest && !forcePlanCard && responseLane === "PLAN"/.test(modes), "echo-only PLAN card is skipped");
assert.ok(/planFirst === true \|\| proposalFlags\.auto === false/.test(modes), "explicit review flags keep the card");
assert.ok(/plan_items must contain concrete steps/.test(fs.readFileSync(path.join(root, "flowpilot.js"), "utf8")), "server asks once for missing steps");

// #20, #21, #22: result records are the visible write summary; consent text
// is direct; created-node cards render values instead of field-name dumps.
assert.strictEqual(modes.indexOf('addMessage("assistant", deterministicModifySummary'), -1, "no duplicate result checklist");
assert.strictEqual(modes.indexOf("Approved plan:"), -1, "no approved-plan echo");
assert.ok(/FlowPilot wants to add a /.test(main), "consent text names the operation");
assert.ok(/reaches outside Node-RED/.test(main), "external-node consent names the boundary");
assert.ok(/Proceed/.test(modes) && /Skip this step/.test(modes), "consent offers direct proceed/skip choices");
assert.ok(/resultCardAddedValues/.test(modes) && /wires/.test(modes), "result card filters bookkeeping fields");
assert.ok(/entry\.key \+ ": "/.test(modes), "result card shows values beside keys");

// #24: an ordered list interrupted by nested bullets resumes with an explicit
// start value rather than silently resetting to 1.
assert.ok(/<ol start=/.test(markdown), "ordered-list continuation emits start");

// #25: saved prompts are assembled before built-ins; internal commands are
// absent from the visible registry and Enter consumes the highlighted row.
assert.ok(init.indexOf("var commands = [];\n            saved.forEach") !== -1, "saved prompts are listed first");
assert.strictEqual(init.indexOf('{ cmd: "/query"'), -1, "query is hidden from slash menu");
assert.strictEqual(init.indexOf('{ cmd: "/refresh"'), -1, "refresh is hidden from slash menu");
assert.ok(init.indexOf("e.stopImmediatePropagation()") !== -1, "Enter selects the highlighted command");

// #26 and #37.
assert.ok(init.indexOf("Diagnostics ' +") !== -1, "settings capability text points to Diagnostics");
assert.ok(main.indexOf('A: "Full tool planning"') !== -1 && main.indexOf('C: "Classify first, then act"') !== -1,
    "routing text uses plain words");
assert.ok(/\.fp-send-menu-panel \{[^}]*left: 0;/.test(css), "send menu opens toward available side");
assert.ok(/fp-send-menu-open-left/.test(css) && /positionSendMenuPanel/.test(init), "send menu chooses side at runtime");

console.log("P2-C cards/UI tests passed");

// #18, review fix: real echoed summaries carry a prefix ("I will create as
// requested: <request>"), so an exact-equality check never fired live. Both
// copies (server and browser) strip it.
{
  const fsx = require("fs");
  const pathx = require("path");
  const P = "Create a nodered flow that gets data from an open weather api, an online joke db, and stores them to a global variable.";
  function load(file, name) {
    const src = fsx.readFileSync(pathx.join(__dirname, "..", file), "utf8");
    const start = src.indexOf("function " + name + "(");
    let depth = 0, end = start;
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      if (src[i] === "{") { depth++; }
      if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    return new Function("return " + src.slice(start, end))();
  }
  [["flowpilot.js", "proposalSummaryEchoesPrompt"], ["lib/core/modes.js", "proposalSummaryEchoesRequest"]].forEach(function (pair) {
    const echoes = load(pair[0], pair[1]);
    assert.strictEqual(echoes("I will create as requested: " + P, P), true, pair[0] + ": prefixed echo is an echo");
    assert.strictEqual(echoes("I will build as requested: " + P, P), true, pair[0] + ": any verb");
    assert.strictEqual(echoes(P, P), true, pair[0] + ": bare echo");
    assert.strictEqual(echoes("Fetch the weather every 5 minutes and store it in global", P), false,
      pair[0] + ": a real summary is not an echo");
  });
}

// #20, Stage 2 live check: a dispatched proposal no longer posts its summary
// as a user message ("YOU: I will create as requested: …").
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "core", "modes.js"), "utf8");
  assert.strictEqual((src.match(/addMessage\("user", label\);/g) || []).length, 1,
    "only addRequestEcho itself posts the label; every entry point calls it");
  const body = src.slice(src.indexOf("function dispatchProposedAction("), src.indexOf("setWorkingStatusPlan(pa.plan_items);"));
  assert.ok(/suppressDispatchEcho = true;/.test(body) && /suppressDispatchEcho = false;/.test(body),
    "dispatch suppresses one echo and resets the flag even if the entry point refused");
}
