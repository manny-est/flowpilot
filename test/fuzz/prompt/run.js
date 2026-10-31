#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const prompts = require("./prompts.json");
const codeJudge = require("./lib/code-judge.js");
const executor = require("./lib/executor.js");
const llmJudge = require("./lib/llm-judge.js");
const output = require("./lib/output.js");

const DELAY_MS = parseInt(process.env.DELAY_MS || "4000", 10);
const LIMIT = Number(process.env.LIMIT) > 0 ? Number(process.env.LIMIT) : prompts.length;
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, "results");

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function seededOrder(items, seed) {
  const result = items.slice();
  let state = Number(seed) || 1;
  function random() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  }
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const temp = result[i]; result[i] = result[j]; result[j] = temp;
  }
  return result;
}

function selectedPrompts() {
  const only = process.env.ONLY;
  const filtered = only ? prompts.filter(function (entry) { return only.split(",").indexOf(entry.id) !== -1; }) : prompts.slice();
  return seededOrder(filtered, process.env.SEED || "1").slice(0, LIMIT);
}

// The fuzzer runs inside the Node-RED container (staged like the corpora), so
// FlowPilot's settings file is local. FP_SETTINGS overrides the path.
function readSettingsFromContainer() {
  const file = process.env.FP_SETTINGS || "/data/flowpilot/settings.json";
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// The judge always uses OpenAI: JUDGE_PROVIDER names a provider id, otherwise
// "openai-test" (nodered-test) or the first provider whose base URL is
// api.openai.com (nodered's OpenAI provider has a generated id).
function judgeKeyFromSettings(settings) {
  const providers = Array.isArray(settings && settings.providers) ? settings.providers : [];
  const wanted = process.env.JUDGE_PROVIDER;
  const provider = providers.find(function (item) { return item && wanted && item.id === wanted; }) ||
    providers.find(function (item) {
      return item && (item.id === "openai-test" || item.providerName === "openai-test" || item.name === "openai-test");
    }) ||
    providers.find(function (item) { return item && /(^|\/\/)api\.openai\.com/.test(String(item.baseUrl || "")) && item.apiKey; });
  return provider && provider.apiKey;
}

// The result line names the model under test (the active provider's model),
// not the judge.
function modelUnderTest(settings) {
  if (process.env.MODEL_LABEL) { return process.env.MODEL_LABEL; }
  const providers = Array.isArray(settings && settings.providers) ? settings.providers : [];
  const active = providers.find(function (item) { return item && item.id === (settings && settings.activeProviderId); });
  return (active && active.model) || "unknown-model";
}

async function main() {
  const cases = selectedPrompts();
  const model = process.env.JUDGE_MODEL || "gpt-4.1";
  console.log("Prompt fuzzer: " + cases.length + " prompt(s), delay " + DELAY_MS + "ms, judge " + model);
  let token;
  try { token = await executor.getToken(); }
  catch (error) { console.error("Auth FAILED: " + error.message); process.exitCode = 1; return; }
  let judgeKey;
  let testedModel = "unknown-model";
  try {
    const settings = readSettingsFromContainer();
    judgeKey = judgeKeyFromSettings(settings);
    testedModel = modelUnderTest(settings);
  } catch (error) { console.error("OpenAI judge settings unavailable; no judge request was sent"); }
  const results = [];
  for (let index = 0; index < cases.length; index++) {
    const entry = cases[index];
    process.stdout.write(("[" + (index + 1) + "/" + cases.length + "] " + entry.id).padEnd(38) + " ... ");
    const started = Date.now();
    let result;
    try {
      const run = await executor.runPrompt(entry, token);
      const code = codeJudge.judgeCode(run.graph, { expect: entry.expect, actual: run.actual });
      result = Object.assign(run, { code: code, durationMs: Date.now() - started });
      if (judgeKey) {
        try {
          const expectAction = entry.expect && entry.expect.action;
          const expected = expectAction === "ask" ? "ask one clarifying question (no changes)" :
            expectAction === "answer" ? "a reply with no changes to the flow" :
            expectAction === "write" ? "change the flow as asked" : "";
          result.judge = await llmJudge.requestJudge({ prompt: entry.prompt, followUp: entry.followUp,
            graph: codeJudge.summarizeGraph(run.graph), finalText: run.finalText,
            outcome: run.actual && run.actual.action === "write" ? "changed the flow" :
              run.actual && run.actual.action === "ask" ? "asked a question" : "replied without changes",
            changes: (run.writes || []).filter(function (w) { return w && w.result && !w.result.error && !w.result.noChange; })
              .map(function (w) { return w.tool + ": " + String((w.args && w.args.summary) || "").slice(0, 160); }),
            expected: expected }, judgeKey, model);
        } catch (error) {
          result.judge = { did_what_was_asked: false, gaps: [llmJudge.redactJudgeError(error, judgeKey)] };
          result.error = result.error || "judge error";
        }
      } else {
        result.judge = { did_what_was_asked: false, gaps: ["OpenAI judge key is unavailable"] };
        result.error = result.error || "judge error";
      }
    } catch (error) {
      result = { id: entry.id, category: entry.category, prompt: entry.prompt, code: { pass: false, failures: [error.message] },
        judge: { did_what_was_asked: false, gaps: ["executor error"] }, error: "executor error", durationMs: Date.now() - started };
    }
    results.push(result);
    console.log((result.code && result.code.pass ? "code-pass" : "code-fail") + ", " +
      (result.judge && result.judge.did_what_was_asked ? "judge-pass" : "judge-fail"));
    if (index < cases.length - 1) { await sleep(DELAY_MS); }
  }
  const total = results.length;
  const codePassed = results.filter(function (result) { return result.code && result.code.pass; }).length;
  const judgePassed = results.filter(function (result) { return result.judge && result.judge.did_what_was_asked === true; }).length;
  const bothPassed = results.filter(function (result) { return result.code && result.code.pass && result.judge && result.judge.did_what_was_asked === true; }).length;
  const summary = { timestamp: new Date().toISOString(), model: testedModel, judgeModel: model, total: total, codePassed: codePassed,
    judgePassed: judgePassed, bothPassed: bothPassed, errors: results.filter(function (result) { return !!result.error; }).length,
    byCategory: output.categoryTable(results) };
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filename = path.join(OUTPUT_DIR, "results-" + Date.now() + ".json");
  fs.writeFileSync(filename, JSON.stringify({ summary: summary, results: results }, null, 2) + "\n");
  Object.keys(summary.byCategory).sort().forEach(function (category) {
    const row = summary.byCategory[category];
    console.log(category + ": code " + row.code + "/" + row.total + " · judge " + row.judge + "/" + row.total + " · both " + row.both + "/" + row.total);
  });
  console.log(output.formatResultLine(summary));
  console.log("Results → " + filename);
  if (summary.errors) { process.exitCode = 1; }
}

if (require.main === module) { main().catch(function (error) { console.error("Fatal: " + error.message); process.exitCode = 1; }); }

module.exports = { selectedPrompts: selectedPrompts, judgeKeyFromSettings: judgeKeyFromSettings, main: main };
