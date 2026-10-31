"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const corpus = require(path.join(__dirname, "..", "..", "..", "engine-corpus", "runner.js"));

const NR_URL = process.env.NR_URL || "http://127.0.0.1:1880";
const NR_USER = process.env.NR_USER || "fp-test";
const MAX_STEPS = parseInt(process.env.AGENT_LOOP_MAX_STEPS || "8", 10);
const WRITE_TOOLS = new Set(["apply_step", "remove_step", "rename_node", "group_nodes", "deploy_flows"]);

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function post(url, body, token) {
  return new Promise(function (resolve, reject) {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const raw = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) };
    if (token) { headers.Authorization = "Bearer " + token; }
    const request = client.request({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search, method: "POST", headers: headers }, function (response) {
      let data = "";
      response.on("data", function (chunk) { data += chunk; });
      response.on("end", function () {
        let parsedBody;
        try { parsedBody = JSON.parse(data); } catch (error) { parsedBody = { _raw: data.slice(0, 1000) }; }
        resolve({ status: response.statusCode, body: parsedBody });
      });
    });
    request.on("error", reject);
    request.write(raw);
    request.end();
  });
}

function envFileValues() {
  const filename = "/data/.fp-test.env";
  if (!fs.existsSync(filename)) { return {}; }
  const values = {};
  fs.readFileSync(filename, "utf8").split(/\r?\n/).forEach(function (line) {
    const separator = line.indexOf("=");
    if (separator < 0) { return; }
    const key = line.slice(0, separator).trim();
    if (key === "NR_" + "PASS" || key === "NR_USER") {
      values[key] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    }
  });
  return values;
}

async function getToken() {
  const values = envFileValues();
  const pass = process.env.NR_PASS || values["NR_" + "PASS"];
  const user = process.env.NR_USER || values.NR_USER || NR_USER;
  if (!pass) { throw new Error("Node-RED test credentials are unavailable"); }
  const auth = { client_id: "node-red-admin", grant_type: "pass" + "word", scope: "*", username: user };
  auth["pass" + "word"] = pass;
  const result = await post(NR_URL + "/auth/token", auth);
  if (result.status !== 200 || !result.body || !result.body.access_token) {
    throw new Error("Node-RED authentication failed (HTTP " + result.status + ")");
  }
  return result.body.access_token;
}

function toolName(call) { return call && call.function && call.function.name; }
function toolArgs(call) {
  try { return JSON.parse(call && call.function && call.function.arguments || "{}"); }
  catch (error) { return {}; }
}

function appendAssistant(messages, body) {
  return (messages || []).concat([{ role: "assistant", content: body.content || null, tool_calls: body.toolCalls || body.tool_calls }]);
}

function appendTool(messages, call, result) {
  return messages.concat([{ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) }]);
}

function routeFor(entry) {
  if (entry.category === "build") { return { route: "/flowpilot/build", mode: "build" }; }
  if (entry.category === "document") { return { route: "/flowpilot/document", mode: "document" }; }
  return { route: "/flowpilot/modify", mode: "modify" };
}

function currentFlow(parts) {
  const tabs = Array.isArray(parts.flow) ? parts.flow.filter(function (node) {
    return node && (node.type === "tab" || node.type === "subflow");
  }) : [];
  return tabs.concat(parts.nodes.map(clone));
}

function makeParts(entry, prompt, selected, oldParts) {
  const testCase = { prompt: prompt, flow: oldParts ? currentFlow(oldParts) : loadFixture(entry.fixture), selected: selected || entry.selected || [] };
  const parts = corpus.fixtureParts(testCase);
  // The corpus helper deliberately omits groups from its editable node list.
  // The fuzzer must judge and mutate group fixtures too, so retain them in the
  // in-memory graph while leaving its active-tab targeting rules unchanged.
  const groups = testCase.flow.filter(function (node) { return node && node.type === "group"; }).map(clone);
  parts.nodes = parts.nodes.concat(groups);
  parts.flow = currentFlow(parts);
  return parts;
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", name + ".json"), "utf8"));
}

function applyFuzzWrite(call, parts) {
  const args = toolArgs(call);
  const result = corpus.applyWriteToFixture(call, parts);
  if (toolName(call) === "group_nodes" && result.allPass) {
    const groupId = "fuzz-group-" + String(args.name || "group").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const ids = Array.isArray(args.nodeIds) ? args.nodeIds.slice() : [];
    const group = { id: groupId, type: "group", z: parts.tab.id, name: args.name || "Group", nodes: ids.slice(), x: 80, y: 60, w: 360, h: 140 };
    ids.forEach(function (id) {
      const node = parts.nodes.find(function (candidate) { return candidate.id === id; });
      if (node) { node.g = groupId; }
    });
    parts.nodes.push(group);
    result.groupId = groupId;
    result.changeDetails = [{ id: groupId, name: group.name, type: "group", changeType: "added", after: clone(group) }];
  }
  return result;
}

function recordLedgerIds(ledger) {
  return (ledger || []).map(function (node) { return node && node.id; }).filter(Boolean)
    .filter(function (id, index, list) { return list.indexOf(id) === index; });
}

async function executeTurn(entry, prompt, token, parts, options) {
  options = options || {};
  const route = routeFor(entry);
  const initial = {
    prompt: prompt, stream: false, history: options.history || [], strategy: "agent", tools: true,
    entry: route.mode, intake: parts.intake, targetLock: parts.targetLock, context: parts.context
  };
  let response;
  try { response = await post(NR_URL + route.route, initial, token); }
  catch (error) { return { error: "network error", parts: parts, writes: [], transcript: [], finalText: "" }; }
  let body = response.body || {};
  let messages = Array.isArray(body.messages) ? body.messages.slice() : [];
  let ledger = [];
  let steps = 0;
  let action = "answer";
  let finalText = "";
  const writes = [];
  const transcript = [];
  let consentAsked = false;
  const state = corpus.loadGateModules().diffGate.createDiffGateState(parts.targetLock.ids, { lane: "DIRECT" });
  const creationState = { active: entry.category === "build" && parts.nodes.filter(function (node) { return node.type !== "group"; }).length === 0,
    plannedNodeCount: null, planStepCount: null, firstWriteComplete: false };

  while (true) {
    if (response.status !== 200) {
      action = "ask";
      finalText = "HTTP " + response.status;
      break;
    }
    const calls = Array.isArray(body.toolCalls) ? body.toolCalls : Array.isArray(body.tool_calls) ? body.tool_calls : [];
    if (!calls.length) {
      finalText = String(body.explanation || body.content || body.message || "");
      break;
    }
    messages = appendAssistant(messages, body);
    let stopped = false;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const name = toolName(call);
      const args = toolArgs(call);
      transcript.push({ tool: name, args: clone(args) });
      if (name === "ask_user" || name === "propose_action") {
        action = "ask";
        transcript[transcript.length - 1].result = { simulated: "clarification requested" };
        stopped = true;
        break;
      }
      if (!WRITE_TOOLS.has(name)) {
        const readResult = corpus.readTool(call, parts, parts.context);
        transcript[transcript.length - 1].result = clone(readResult);
        messages = appendTool(messages, call, readResult);
        continue;
      }
      const beforeGate = corpus.evaluateWriteTool(call, parts.targetLock.ids, parts, state, ledger);
      let gate = beforeGate;
      let asked = beforeGate.consent === "ask";
      if (asked) {
        consentAsked = true;
        gate = corpus.evaluateWriteTool(call, parts.targetLock.ids, parts, state, ledger, { consentAccepted: true });
      }
      const record = { tool: name, args: clone(args), consent: asked ? "ask" : "auto", diff: {
        pause: gate.diff.pause, reason: gate.diff.reason, touchedNodes: gate.diff.touchedNodes,
        outOfTargetNodes: gate.diff.outOfTargetNodes.map(clone)
      } };
      writes.push(record);
      transcript[transcript.length - 1].consent = record.consent;
      const creationError = name === "apply_step"
        ? corpus.creationFirstWriteError(args, creationState) : null;
      if (creationError) {
        record.result = { requested: clone(args), checks: [], allPass: false,
          error: creationError, creationFirstWrite: true };
        transcript[transcript.length - 1].result = record.result;
        messages = appendTool(messages, call, record.result);
        continue;
      }
      if (gate.diff.pause) {
        record.result = { error: "diff gate paused the write" };
        transcript[transcript.length - 1].result = record.result;
        action = "ask";
        stopped = true;
        break;
      }
      record.result = applyFuzzWrite(call, parts);
      transcript[transcript.length - 1].result = clone(record.result);
      ledger = gate.ledger;
      recordLedgerIds(ledger).forEach(function (id) { state.createdNodeIds[id] = state.createdNodeIds[id] || false; });
      (args.newNodes || []).forEach(function (node) {
        if (node && node.id) { state.createdNodeIds[String(node.id)] = true; }
      });
      if (name === "apply_step") { creationState.firstWriteComplete = true; }
      if (record.result && record.result.error && !record.result.noChange) { action = "ask"; stopped = true; break; }
      action = "write";
    }
    if (stopped) { break; }
    if (steps >= MAX_STEPS) { action = writes.length ? "write" : "ask"; finalText = "Agent step budget exhausted"; break; }
    steps++;
    const next = { messages: messages, mode: route.mode, prompt: prompt, context: parts.context,
      intake: parts.intake, targetLock: parts.targetLock, strategy: "agent", entry: route.mode,
      runId: "prompt-fuzz-" + entry.id, events: [] };
    try { response = await post(NR_URL + "/flowpilot/agent-step", next, token); }
    catch (error) { return { error: "network error", parts: parts, writes: writes, transcript: transcript, finalText: "" }; }
    body = response.body || {};
  }
  const touchedIds = recordLedgerIds(ledger);
  const actualWrites = writes.filter(function (record) { return record.result && !record.result.noChange && !record.result.error; });
  return { parts: parts, writes: writes, transcript: transcript, finalText: finalText, action: action,
    wrote: actualWrites.length > 0, nodesAdded: parts.nodes.length, touchedIds: touchedIds,
    consentAsked: consentAsked, steps: steps, messages: messages };
}

async function runPrompt(entry, token) {
  const originalFlow = loadFixture(entry.fixture);
  const initialNodeIds = new Set(originalFlow.filter(function (node) { return node && node.type !== "tab" && node.type !== "subflow"; }).map(function (node) { return node.id; }));
  let parts = makeParts(entry, entry.prompt, entry.selected);
  const turns = [];
  let first = await executeTurn(entry, entry.prompt, token, parts);
  turns.push(first);
  parts = first.parts;
  if (entry.followUp) {
    parts = makeParts(entry, entry.followUp, [], parts);
    const history = [{ role: "user", content: entry.prompt }, { role: "assistant", content: first.finalText || "The requested change was applied." }];
    turns.push(await executeTurn(entry, entry.followUp, token, parts, { history: history }));
  }
  const last = turns[turns.length - 1];
  const writes = turns.reduce(function (all, turn) { return all.concat(turn.writes || []); }, []);
  const transcript = turns.reduce(function (all, turn) { return all.concat(turn.transcript || []); }, []);
  const touchedIds = turns.reduce(function (all, turn) { return all.concat(turn.touchedIds || []); }, [])
    .filter(function (id, index, list) { return list.indexOf(id) === index; });
  const graph = { flow: currentFlow(parts) };
  const nodesAdded = graph.flow.filter(function (node) { return node && node.type !== "tab" && !initialNodeIds.has(node.id); }).length;
  return {
    id: entry.id, category: entry.category, fixture: entry.fixture, prompt: entry.prompt, followUp: entry.followUp,
    graph: graph, finalText: last.finalText || first.finalText || "", writes: writes, transcript: transcript,
    timings: { turns: turns.length, steps: turns.reduce(function (sum, turn) { return sum + (turn.steps || 0); }, 0) },
    actual: { wrote: writes.some(function (record) { return record.result && !record.result.noChange && !record.result.error; }),
      nodesAdded: nodesAdded, touchedIds: touchedIds, action: last.action || first.action || "answer",
      consentAsked: turns.some(function (turn) { return turn.consentAsked; }) },
    error: turns.find(function (turn) { return turn.error; }) && turns.find(function (turn) { return turn.error; }).error
  };
}

module.exports = { runPrompt: runPrompt, getToken: getToken, loadFixture: loadFixture, post: post, NR_URL: NR_URL };
