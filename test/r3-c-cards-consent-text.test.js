"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { planRiskPrediction } = require("../lib/core/cards");
const { createConsentMemory } = require("../lib/core/consent");
const { sanitizeGeneratedNode } = require("../lib/core/generated-content");
const { load, buttons } = require("./p1-36-clear-ends-run.test");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "lib/core/main.js"), "utf8");
const modesSource = fs.readFileSync(path.join(__dirname, "..", "lib/core/modes.js"), "utf8");
const flowpilotSource = fs.readFileSync(path.join(__dirname, "..", "flowpilot.js"), "utf8");

function extractFunction(source, name, args) {
  const start = source.indexOf("function " + name + "(");
  assert.notStrictEqual(start, -1, "found " + name);
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") { depth++; }
    if (source[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  assert.notStrictEqual(end, -1, "closed " + name);
  return new Function("indefiniteArticle", "findLiveNode", "return (" + source.slice(start, end) + ");")(
    value => /^(?:http|https|mqtt|exec|inject|html|sql|xml|mcp)/i.test(value) || /^[aeiou]/i.test(value) ? "an" : "a",
    () => null
  );
}

const describeAgentToolCall = extractFunction(mainSource, "describeAgentToolCall", ["findLiveNode", "indefiniteArticle"]);

// Negated node types are constraints, not predicted side effects. A positive
// add/create request remains a risk.
{
  const risks = planRiskPrediction({
    plan_items: ["Do something cool and unique, but no http or exec nodes."],
    proposeAction: { action: "build", summary: "Do something cool and unique, but no http or exec nodes." }
  });
  assert.strictEqual(risks.some(risk => /http request|exec/.test(risk.type || "")), false,
    "negated http/exec types are not listed as risky operations");
  const positive = planRiskPrediction({
    plan_items: ["Add an exec node that runs ls."],
    proposeAction: { action: "modify", summary: "Add an exec node that runs ls." }
  });
  assert.ok(positive.some(risk => risk.type === "exec"), "positive exec creation remains risky");
}

// The consent label follows the same decision-producing node list, not the
// first new node in the step.
{
  const label = describeAgentToolCall("apply_step", {
    newNodes: [
      { id: "inject-1", type: "inject", name: "Every minute" },
      { id: "http-1", type: "http request", name: "Fetch Weather" },
      { id: "fn-1", type: "function", name: "Extract temperature" },
      { id: "debug-1", type: "debug", name: "Show temperature" }
    ]
  }, [{ op: "create", type: "http request", nodeId: "http-1", name: "Fetch Weather" }]);
  assert.match(label, /add an http request node "Fetch Weather"/i,
    "consent names the side-effecting node that triggered the ask");
  assert.doesNotMatch(label, /add an inject node/i,
    "consent does not name a safe first node as the reason for the ask");
}

// Answered controls are disabled in the real browser bundle's fake DOM.
{
  const h = load();
  let consentAnswer;
  h.api.consent({ name: "apply_step", args: { summary: "add it" }, onResume: value => { consentAnswer = value; } });
  const proceed = buttons(h.dom).find(button => button.textValue === "Proceed");
  assert.ok(proceed, "consent Proceed button rendered");
  proceed.handlers.click();
  assert.strictEqual(consentAnswer, true, "consent callback received Proceed");
  assert.strictEqual(proceed.props.disabled, true, "answered consent controls are disabled");

  let answer;
  h.api.ask({ question: "Which one?", options: ["This one"], onAnswer: value => { answer = value; } });
  const option = buttons(h.dom).find(button => button.textValue === "This one");
  assert.ok(option, "question option rendered");
  option.handlers.click();
  assert.strictEqual(answer, "This one", "question callback received the selected answer");
  assert.strictEqual(option.props.disabled, true, "answered question controls are disabled");
}

// Plan cards and suggested-action offers must settle the old controls too,
// so a mirrored/pop-out copy cannot remain actionable after the click.
assert.match(modesSource, /function disableRecordControls\(rec\)[\s\S]{0,260}prop\("disabled", true\)/,
  "approved plan controls are disabled before the settled rerender");
assert.match(modesSource, /rec\.decision\s*=\s*"used"[\s\S]{0,260}\.prop\("disabled", true\)/,
  "answered offer controls are disabled before dispatch");

// Skipping a multi-node step is remembered as the step decision, so a later
// render of the same step does not ask again while a new task starts empty.
{
  const memory = createConsentMemory();
  const args = { newNodes: [{ id: "http-1", type: "http request", name: "Fetch Weather" }] };
  memory.rememberSkippedStep("task-1", "apply_step", args);
  assert.strictEqual(memory.hasSkippedStep("task-1", "apply_step", args), true,
    "the skipped step is remembered");
  assert.strictEqual(memory.hasSkippedStep("task-2", "apply_step", args), false,
    "skip memory does not cross task boundaries");
}

// Generated node fields are content, so the persona tagline is scrubbed at
// the shared insertion boundary. Creation prompts also do not carry persona
// instructions that a model could echo into node fields.
{
  const node = sanitizeGeneratedNode({
    type: "comment",
    name: "Weather notes — You pick the destination, I help you get there.",
    info: "Fetches weather. You pick the destination, I help you get there.",
    func: "// You pick the destination, I help you get there.\nreturn msg;"
  });
  const serialized = JSON.stringify(node);
  assert.doesNotMatch(serialized, /You pick the destination, I help you get there/i,
    "persona tagline never lands in generated node fields");
}
assert.doesNotMatch(
  flowpilotSource.slice(flowpilotSource.indexOf("function buildGenerationContext("), flowpilotSource.indexOf("function extractSuggestedAction(")),
  /buildPersonaInstruction/,
  "creation prompt context does not inject persona text"
);

// Grammar, progress verbs, sentence joining, and delete-only result cards.
[
  ["inject", "an inject"], ["http request", "an http request"],
  ["exec", "an exec"], ["mqtt out", "an mqtt out"],
  ["function", "a function"], ["debug", "a debug"]
].forEach(([type, expected]) => {
  assert.match(describeAgentToolCall("apply_step", { newNodes: [{ type, name: "Node" }] },
    [{ op: "create", type, nodeId: "n1", name: "Node" }]),
    new RegExp(expected.replace(" ", "\\s+"), "i"), "article for " + type);
});
assert.match(describeAgentToolCall("apply_step", { newNodes: [{ type: "inject", name: "Start" }] }),
  /Adding Start \(inject\)…/, "new-node progress says Adding");
assert.match(describeAgentToolCall("remove_step", { nodeId: "n1" }),
  /Deleting .* \(.*\)…/, "delete progress says Deleting");
assert.match(describeAgentToolCall("apply_step", { changes: [{ id: "n1" }] }),
  /Changing .* \(.*\)…/, "change progress says Changing");
assert.doesNotMatch(modesSource, /together\.\. Nothing else was changed\./,
  "skip sentence does not contain a doubled period");
assert.match(modesSource, /var canTest = model\.changedNodes\.some\(function \(node\) \{\s*return node && node\.changeType !== "removed";/,
  "delete-only result cards do not offer Test it");

console.log("R3-C cards/consent/text tests passed");

// A negated clause ends at its own "node(s)": a later positive add in the
// same sentence is still predicted.
{
  const risks = planRiskPrediction({
    plan_items: ["Do not change the inject node, add an exec node that runs ls."],
    proposeAction: { action: "modify", summary: "Do not change the inject node, add an exec node that runs ls." }
  });
  assert.ok(risks.some(risk => risk.type === "exec"), "the positive exec add is still predicted");
}
