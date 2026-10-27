#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const NR_URL = process.env.NR_URL || "http://127.0.0.1:1880";
const NR_USER = process.env.NR_USER || "fp-test";
const NR_PASS = process.env.NR_PASS || "Flowpilot!";
const OUTPUT_DIR = process.env.OUTPUT_DIR || __dirname;
const LABEL = process.env.RUN_LABEL || "answer";
const MAX_STEPS = parseInt(process.env.AGENT_LOOP_MAX_STEPS || "8", 10);
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "answer-flow.json"), "utf8"));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "answer-cases.json"), "utf8"));
const fixtureTab = fixture.find(function (node) { return node && node.type === "tab"; });
const fixtureNodes = fixture.filter(function (node) { return node && node.type !== "tab"; });
// POST /flow gives the tab a new id (the fixture's is ignored); main() stores
// the real one here for the active-tab emulation and for cleanup.
let importedTabId = null;

function request(method, url, body, token) {
  return new Promise(function (resolve, reject) {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers = {};
    if (raw) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(raw);
    }
    if (token) { headers.Authorization = "Bearer " + token; }
    const req = client.request({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "https:" ? 443 : 80), path: parsed.pathname, method: method, headers: headers }, function (res) {
      let data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        let parsedBody = null;
        try { parsedBody = data ? JSON.parse(data) : null; } catch (err) { parsedBody = { _raw: data }; }
        resolve({ status: res.statusCode, body: parsedBody });
      });
    });
    req.on("error", reject);
    if (raw) { req.write(raw); }
    req.end();
  });
}

function safeJsonParse(value) {
  if (typeof value !== "string") { return null; }
  try { return JSON.parse(value); } catch (err) { return null; }
}

function scoreAnswer(answer, testCase) {
  const text = String(answer || "");
  const included = (testCase.mustInclude || []).map(function (source) {
    const matched = new RegExp(source, "i").test(text);
    return { pattern: source, matched: matched };
  });
  const excluded = (testCase.mustNotInclude || []).map(function (source) {
    const matched = new RegExp(source, "i").test(text);
    return { pattern: source, matched: matched };
  });
  return {
    pass: included.every(function (item) { return item.matched; }) && excluded.every(function (item) { return !item.matched; }),
    included: included,
    excluded: excluded
  };
}

async function getToken() {
  const result = await request("POST", NR_URL + "/auth/token", {
    client_id: "node-red-admin", grant_type: "password", scope: "*",
    username: NR_USER, password: NR_PASS
  });
  if (result.status !== 200 || !result.body || !result.body.access_token) {
    throw new Error("Auth failed (HTTP " + result.status + "): " + JSON.stringify(result.body));
  }
  return result.body.access_token;
}

async function fetchFlows(token) {
  const result = await request("GET", NR_URL + "/flows", undefined, token);
  if (result.status !== 200 || !Array.isArray(result.body)) {
    throw new Error("Unable to fetch /flows (HTTP " + result.status + ")");
  }
  return result.body;
}

function indexedFlows(flows) {
  const byId = {};
  (Array.isArray(flows) ? flows : []).forEach(function (node) { if (node && node.id) { byId[node.id] = node; } });
  return byId;
}

// Same shape as the client's get_connections result (selection-context.js
// buildConnections), ported from test/routing-corpus/routing-runner.js.
function buildConnections(nodes, allNodes) {
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const byId = {};
  nodeList.forEach(function (node) { if (node && node.id) { byId[node.id] = node; } });
  const edges = [];
  const inputs = {};
  nodeList.forEach(function (node) { inputs[node.id] = []; });
  nodeList.forEach(function (node) {
    (Array.isArray(node.wires) ? node.wires : []).forEach(function (targets, fromPort) {
      (Array.isArray(targets) ? targets : []).forEach(function (targetId) {
        if (!byId[targetId]) { return; }
        edges.push({ fromId: node.id, fromPort: fromPort, toId: targetId });
        inputs[targetId].push({ fromId: node.id, fromPort: fromPort });
      });
    });
  });
  return {
    nodes: nodeList.map(function (node) { return JSON.parse(JSON.stringify(node)); }),
    edges: edges,
    perNode: nodeList.map(function (node) {
      return {
        id: node.id,
        label: (node.name || node.id) + " [" + node.type + "]",
        type: node.type,
        flowId: node.z || null,
        inputs: inputs[node.id] || [],
        outputs: (Array.isArray(node.wires) ? node.wires : []).map(function (targets, index) {
          return { port: index, to: (Array.isArray(targets) ? targets : []).filter(function (id) { return !!byId[id]; }) };
        })
      };
    }),
    scopeNodeCount: nodeList.length,
    instanceNodeCount: Array.isArray(allNodes) ? allNodes.length : nodeList.length
  };
}

function selectedContext(testCase) {
  const ids = Array.isArray(testCase.selection) ? testCase.selection : [];
  // The client sends the open tab with every Plan turn (SF-2); a tester would
  // have the fixture tab open.
  return {
    nodes: ids.map(function (id) { return fixtureNodes.find(function (node) { return node.id === id; }); }).filter(Boolean),
    activeTab: importedTabId ? { id: importedTabId, label: fixtureTab.label } : undefined
  };
}

async function executeReadTool(call, token, testCase) {
  const name = call && call.function && call.function.name;
  const args = safeJsonParse(call && call.function && call.function.arguments) || {};
  const flows = await fetchFlows(token);
  const byId = indexedFlows(flows);
  if (name === "read_node") {
    let node = args.id && byId[args.id];
    if (!node && args.name) { node = Object.keys(byId).map(function (id) { return byId[id]; }).find(function (item) { return item && item.name === args.name; }); }
    return node || { error: "No node found." };
  }
  if (name === "list_flows") {
    return { flows: Object.keys(byId).map(function (id) { return byId[id]; }).filter(function (node) { return node.type === "tab"; }).map(function (tab) {
      return { id: tab.id, label: tab.label, type: "tab", nodeCount: Object.keys(byId).filter(function (id) { return byId[id].z === tab.id; }).length };
    }) };
  }
  if (name === "search_flow") {
    const query = String(args.query || "").toLowerCase();
    return { results: Object.keys(byId).map(function (id) { return byId[id]; }).filter(function (node) {
      return node.type !== "tab" && (!query || String(node.name || "").toLowerCase().indexOf(query) !== -1 || String(node.type || "").toLowerCase().indexOf(query) !== -1);
    }).map(function (node) { return { id: node.id, name: node.name || "", type: node.type, flowId: node.z || null }; }) };
  }
  if (name === "get_connections") {
    // Mirrors the client tool: an id → that node plus the nodes wired to or
    // from it; no id → the selection; nothing selected → the active tab,
    // which for this corpus is the fixture tab (what a tester would have open).
    const all = Object.keys(byId).map(function (id) { return byId[id]; }).filter(function (node) { return node.type !== "tab"; });
    let scope;
    if (args.id) {
      const node = byId[args.id];
      if (!node) { return { error: "No node found for id " + args.id + "." }; }
      const linked = {};
      linked[node.id] = node;
      (node.wires || []).forEach(function (targets) {
        (targets || []).forEach(function (id) { if (byId[id]) { linked[id] = byId[id]; } });
      });
      all.forEach(function (other) {
        (other.wires || []).forEach(function (targets) {
          if ((targets || []).indexOf(node.id) !== -1) { linked[other.id] = other; }
        });
      });
      scope = Object.keys(linked).map(function (id) { return linked[id]; });
    } else if (Array.isArray(testCase.selection) && testCase.selection.length) {
      scope = testCase.selection.map(function (id) { return byId[id]; }).filter(Boolean);
    } else {
      scope = all.filter(function (node) { return node.z === importedTabId; });
    }
    return buildConnections(scope, all);
  }
  if (name === "get_selection") {
    return { nodes: (testCase.selection || []).map(function (id) { return byId[id]; }).filter(Boolean), groupCount: 0 };
  }
  if (name === "read_debug") { return { messages: [], totalBuffered: 0 }; }
  return { error: "Unsupported read tool: " + name };
}

function appendAssistant(messages, body) {
  return (messages || []).concat([{ role: "assistant", content: body.content || null, tool_calls: body.toolCalls }]);
}

async function resolveCase(testCase, token, first, conversationId) {
  let body = first.body;
  let messages = Array.isArray(body && body.messages) ? body.messages.slice() : [];
  let answerPhase = !!(body && body.answerPhase);
  let steps = 0;
  while (body && Array.isArray(body.toolCalls) && body.toolCalls.length && steps < MAX_STEPS) {
    if (body.toolCalls.some(function (call) { return call.function && call.function.name === "propose_action" || call.function && call.function.name === "ask_user"; })) { break; }
    messages = appendAssistant(messages, body);
    for (let i = 0; i < body.toolCalls.length; i++) {
      messages.push({ role: "tool", tool_call_id: body.toolCalls[i].id, content: JSON.stringify(await executeReadTool(body.toolCalls[i], token, testCase)) });
    }
    const payload = { messages: messages, mode: "chat", prompt: testCase.prompt, context: selectedContext(testCase), strategy: "agent", entry: "chat", conversationId: conversationId };
    if (answerPhase) { payload.answerPhase = true; }
    const next = await request("POST", NR_URL + "/flowpilot/agent-step", payload, token);
    body = next.body;
    answerPhase = answerPhase || !!(body && body.answerPhase);
    steps++;
  }
  return { body: body || {}, steps: steps, answerPhase: answerPhase };
}

async function main() {
  const token = await getToken();
  let imported = false;
  const results = [];
  try {
    const importResult = await request("POST", NR_URL + "/flow", {
      id: fixtureTab.id,
      label: fixtureTab.label,
      nodes: fixtureNodes
    }, token);
    if (importResult.status < 200 || importResult.status >= 300) { throw new Error("Fixture import failed (HTTP " + importResult.status + ")"); }
    imported = true;
    importedTabId = importResult.body && importResult.body.id;
    if (!importedTabId) { throw new Error("Fixture import returned no flow id."); }
    for (let i = 0; i < cases.length; i++) {
      const testCase = cases[i];
      const conversationId = "answer-" + testCase.id + "-" + Date.now().toString(36);
      const first = await request("POST", NR_URL + "/flowpilot/chat", {
        prompt: testCase.prompt, context: selectedContext(testCase), history: [], strategy: "agent", entry: "chat", tools: true, conversationId: conversationId
      }, token);
      const resolved = await resolveCase(testCase, token, first, conversationId);
      const answer = resolved.body.message || resolved.body.content || "";
      const score = scoreAnswer(answer, testCase);
      const pending = (resolved.body.toolCalls || []).map(function (c) {
        return { name: c.function && c.function.name, arguments: safeJsonParse(c.function && c.function.arguments) };
      });
      results.push({ id: testCase.id, prompt: testCase.prompt, answer: answer, pass: score.pass, score: score, status: first.status,
        steps: resolved.steps, answerPhase: resolved.answerPhase, endedOn: pending.length ? pending : undefined,
        error: resolved.body.error || undefined });
      console.log((i + 1) + "/" + cases.length + " " + (score.pass ? "PASS" : "FAIL") + " " + testCase.id);
    }
  } finally {
    if (imported) {
      const removed = await request("DELETE", NR_URL + "/flow/" + encodeURIComponent(importedTabId), undefined, token);
      if (removed.status < 200 || removed.status >= 300) { console.error("Warning: fixture cleanup failed (HTTP " + removed.status + ")"); }
    }
  }
  const passed = results.filter(function (result) { return result.pass; }).length;
  const output = path.join(OUTPUT_DIR, "answer-results-" + LABEL + ".json");
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ label: LABEL, generatedAt: new Date().toISOString(), summary: { passed: passed, total: results.length }, results: results }, null, 2) + "\n", "utf8");
  console.log("Summary: " + passed + "/" + cases.length);
  console.log("Results written to " + output);
}

if (require.main === module) {
  main().catch(function (err) { console.error(err.stack || err.message || String(err)); process.exitCode = 1; });
}

module.exports = { scoreAnswer: scoreAnswer };
