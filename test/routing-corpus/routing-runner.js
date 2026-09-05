#!/usr/bin/env node
"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const NR_URL = process.env.NR_URL || "http://127.0.0.1:1880";
const NR_USER = process.env.NR_USER || "fp-test";
const NR_PASS = process.env.NR_PASS || "Flowpilot!";
const DELAY_MS = parseInt(process.env.DELAY_MS || "2000", 10);
const OUTPUT_DIR = process.env.OUTPUT_DIR || __dirname;
const RESULTS_DIR = path.join(__dirname, "results");
const LABEL = process.env.RUN_LABEL || "routing";
const AGENT_LOOP_MAX_STEPS = parseInt(process.env.AGENT_LOOP_MAX_STEPS || "8", 10);

const CASES_FILE = path.join(__dirname, "routing-cases.json");
const cases = JSON.parse(fs.readFileSync(CASES_FILE, "utf8"));

function post(url, body, token) {
  return new Promise(function (resolve, reject) {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(bodyStr)
    };
    if (token) { headers.Authorization = "Bearer " + token; }

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname,
      method: "POST",
      headers: headers
    }, function (res) {
      let data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        let parsedBody;
        try { parsedBody = JSON.parse(data); } catch (err) { parsedBody = { _raw: data }; }
        resolve({ status: res.statusCode, body: parsedBody });
      });
    });

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function get(url, token) {
  return new Promise(function (resolve, reject) {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const headers = token ? { Authorization: "Bearer " + token } : {};

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname,
      method: "GET",
      headers: headers
    }, function (res) {
      let data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        let parsedBody;
        try { parsedBody = JSON.parse(data); } catch (err) { parsedBody = { _raw: data }; }
        resolve({ status: res.statusCode, body: parsedBody });
      });
    });

    req.on("error", reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function getToken() {
  const res = await post(NR_URL + "/auth/token", {
    client_id: "node-red-admin",
    grant_type: "password",
    scope: "*",
    username: NR_USER,
    password: NR_PASS
  });
  if (res.status !== 200 || !res.body.access_token) {
    throw new Error("Auth failed (HTTP " + res.status + "): " + JSON.stringify(res.body));
  }
  return res.body.access_token;
}

function safeJsonParse(value) {
  if (!value || typeof value !== "string") { return null; }
  try { return JSON.parse(value); } catch (err) { return null; }
}

async function fetchFlows(token) {
  const res = await get(NR_URL + "/flows", token);
  if (res.status !== 200 || !Array.isArray(res.body)) {
    throw new Error("Unable to fetch /flows (HTTP " + res.status + ")");
  }
  return res.body;
}

function indexFlows(flows) {
  const all = Array.isArray(flows) ? flows : [];
  const tabs = all.filter(function (node) { return node && node.type === "tab"; });
  const subflows = all.filter(function (node) { return node && node.type === "subflow"; });
  const nodes = all.filter(function (node) {
    return node && node.type !== "tab" && node.type !== "subflow";
  });
  const byId = {};
  nodes.concat(subflows).concat(tabs).forEach(function (node) {
    if (node && node.id) { byId[node.id] = node; }
  });
  return { all: all, tabs: tabs, subflows: subflows, nodes: nodes, byId: byId };
}

function sanitizedNode(node) {
  if (!node || typeof node !== "object") { return null; }
  return JSON.parse(JSON.stringify(node));
}

function buildConnections(nodes, allNodes) {
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const byId = {};
  nodeList.forEach(function (node) {
    if (node && node.id) { byId[node.id] = node; }
  });
  const edges = [];
  const inputs = {};
  nodeList.forEach(function (node) {
    inputs[node.id] = [];
  });

  nodeList.forEach(function (node) {
    const wires = Array.isArray(node && node.wires) ? node.wires : [];
    wires.forEach(function (targets, fromPort) {
      (Array.isArray(targets) ? targets : []).forEach(function (targetId) {
        if (!byId[targetId]) { return; }
        edges.push({ fromId: node.id, fromPort: fromPort, toId: targetId });
        inputs[targetId].push({ fromId: node.id, fromPort: fromPort });
      });
    });
  });

  const perNode = nodeList.map(function (node) {
    return {
      id: node.id,
      label: (node.name || node.id) + " [" + node.type + "]",
      type: node.type,
      flowId: node.z || null,
      inputs: inputs[node.id] || [],
      outputs: (Array.isArray(node.wires) ? node.wires : []).map(function (targets, index) {
        return {
          port: index,
          to: (Array.isArray(targets) ? targets : []).filter(function (targetId) { return !!byId[targetId]; })
        };
      })
    };
  });

  const distinctFlows = new Set(nodeList.map(function (node) { return node.z || ""; }).filter(Boolean));
  return {
    nodes: nodeList.map(sanitizedNode),
    edges: edges,
    perNode: perNode,
    subFlowCount: distinctFlows.size || 1,
    scopeNodeCount: nodeList.length,
    instanceNodeCount: Array.isArray(allNodes) ? allNodes.length : nodeList.length
  };
}

async function executeReadTool(call, token, testCase) {
  const name = call && call.function && call.function.name;
  const args = safeJsonParse(call && call.function && call.function.arguments) || {};
  const flows = await fetchFlows(token);
  const indexed = indexFlows(flows);

  if (name === "read_node") {
    let node = null;
    if (args.id && indexed.byId[args.id]) { node = indexed.byId[args.id]; }
    if (!node && args.name) {
      node = indexed.nodes.find(function (entry) { return entry && entry.name === args.name; }) || null;
    }
    return node ? sanitizedNode(node) : { error: "No node found matching " + JSON.stringify(args) + "." };
  }

  if (name === "list_flows") {
    const counts = {};
    indexed.nodes.forEach(function (node) {
      if (node && node.z) { counts[node.z] = (counts[node.z] || 0) + 1; }
    });
    return {
      flows: indexed.tabs.map(function (tab) {
        return {
          id: tab.id,
          label: tab.label,
          type: "tab",
          disabled: !!tab.disabled,
          nodeCount: counts[tab.id] || 0
        };
      }).concat(indexed.subflows.map(function (sf) {
        return {
          id: sf.id,
          label: "[Subflow] " + (sf.name || sf.id),
          type: "subflow",
          nodeCount: counts[sf.id] || 0,
          inputs: Array.isArray(sf.in) ? sf.in.length : 0,
          outputs: Array.isArray(sf.out) ? sf.out.length : 0
        };
      }))
    };
  }

  if (name === "search_flow") {
    const query = args.query ? String(args.query).toLowerCase() : "";
    const typeFilter = args.type ? String(args.type).toLowerCase() : "";
    const flowFilter = args.flowId ? String(args.flowId) : "";
    const results = [];

    indexed.subflows.forEach(function (sf) {
      const sfName = String(sf.name || "").toLowerCase();
      if (!flowFilter && !typeFilter && (!query || sfName.indexOf(query) !== -1)) {
        results.push({ id: sf.id, name: sf.name || "", type: "subflow", flowId: null });
      }
    });

    indexed.nodes.forEach(function (node) {
      if (flowFilter && node.z !== flowFilter) { return; }
      const type = String(node.type || "").toLowerCase();
      const nameText = String(node.name || "").toLowerCase();
      if (typeFilter && type.indexOf(typeFilter) === -1) { return; }
      if (query && nameText.indexOf(query) === -1 && type.indexOf(query) === -1) { return; }
      results.push({ id: node.id, name: node.name || "", type: node.type, flowId: node.z || null });
    });

    return { results: results.slice(0, 50), truncated: results.length > 50 };
  }

  if (name === "get_connections") {
    if (args.id && indexed.byId[args.id]) {
      return buildConnections([indexed.byId[args.id]], indexed.nodes);
    }
    return Object.assign(
      { selected: false, message: "No editor selection is available in headless corpus mode." },
      buildConnections(indexed.nodes, indexed.nodes)
    );
  }

  if (name === "read_debug") {
    return {
      messages: [],
      totalBuffered: 0,
      note: "Debug sidebar data is unavailable in headless corpus mode."
    };
  }

  if (name === "get_selection") {
    const context = caseContext(testCase);
    if (context && Array.isArray(context.nodes) && context.nodes.length > 0) {
      return { selected: true, nodes: context.nodes.map(sanitizedNode) };
    }
    return { selected: false, message: "Nothing is currently selected in headless corpus mode." };
  }

  return { error: "Unsupported tool in routing corpus: " + name };
}

function caseContext(testCase) {
  return testCase && testCase.context && typeof testCase.context === "object"
    ? JSON.parse(JSON.stringify(testCase.context))
    : undefined;
}

function classify(body) {
  if (!body || Array.isArray(body)) {
    return { kind: "error", detail: "non-object response" };
  }
  if (Array.isArray(body.toolCalls) && body.toolCalls.length > 0) {
    const propose = body.toolCalls.find(function (call) {
      return call && call.function && call.function.name === "propose_action";
    });
    if (propose) {
      const args = safeJsonParse(propose.function && propose.function.arguments) || {};
      return {
        kind: typeof args.action === "string" ? args.action : "propose_action",
        detail: args
      };
    }
    const ask = body.toolCalls.find(function (call) {
      return call && call.function && call.function.name === "ask_user";
    });
    if (ask) {
      return { kind: "clarify", detail: safeJsonParse(ask.function && ask.function.arguments) || {} };
    }
    return { kind: "other_tool", detail: body.toolCalls };
  }

  const message = String(body.message || "").trim();
  if (!message) {
    return { kind: "error", detail: body };
  }
  return { kind: "answer", detail: message };
}

function decidedBy(body) {
  const calls = Array.isArray(body && body.toolCalls) ? body.toolCalls : [];
  const propose = calls.find(function (call) {
    return call && call.function && call.function.name === "propose_action";
  });
  if (propose && typeof propose.id === "string" && propose.id.indexOf("prerouter-") === 0) {
    return "prerouter";
  }
  return "model";
}

function appendAssistantToolCall(messages, body) {
  const next = Array.isArray(messages) ? messages.slice() : [];
  next.push({
    role: "assistant",
    content: Object.prototype.hasOwnProperty.call(body, "content") ? body.content : null,
    tool_calls: body.toolCalls
  });
  return next;
}

async function resolveAgentLoop(testCase, token, initialResponse, conversationId) {
  let status = initialResponse.status;
  let body = initialResponse.body;
  let messages = Array.isArray(body.messages) ? body.messages.slice() : [];
  let loopSteps = 0;

  while (Array.isArray(body.toolCalls) && body.toolCalls.length > 0 && loopSteps < AGENT_LOOP_MAX_STEPS) {
    const toolCalls = body.toolCalls;
    const propose = toolCalls.find(function (call) {
      return call && call.function && call.function.name === "propose_action";
    });
    if (propose) { return { status: status, body: body, loopSteps: loopSteps }; }
    const askUser = toolCalls.find(function (call) {
      return call && call.function && call.function.name === "ask_user";
    });
    if (askUser) { return { status: status, body: body, loopSteps: loopSteps }; }

    messages = appendAssistantToolCall(messages, body);
    for (let i = 0; i < toolCalls.length; i++) {
      const result = await executeReadTool(toolCalls[i], token, testCase);
      messages.push({
        role: "tool",
        tool_call_id: toolCalls[i].id,
        content: JSON.stringify(result)
      });
    }

    const next = await post(NR_URL + "/flowpilot/agent-step", {
      messages: messages,
      mode: "chat",
      prompt: testCase.prompt,
      context: caseContext(testCase),
      strategy: "agent",
      entry: "chat",
      conversationId: conversationId
    }, token);
    status = next.status;
    body = next.body;
    loopSteps += 1;
  }

  if (Array.isArray(body.toolCalls) && body.toolCalls.length > 0) {
    return {
      status: status,
      body: { message: "", toolCalls: body.toolCalls, loopExhausted: true },
      loopSteps: loopSteps
    };
  }

  return { status: status, body: body, loopSteps: loopSteps };
}

async function runCase(testCase, token) {
  const started = Date.now();
  const conversationId = "routing-" + testCase.id + "-" + Date.now().toString(36);
  try {
    const first = await post(NR_URL + "/flowpilot/chat", {
      prompt: testCase.prompt,
      context: caseContext(testCase),
      stream: false,
      history: [],
      strategy: "agent",
      entry: "chat",
      tools: true,
      conversationId: conversationId
    }, token);
    const resolved = await resolveAgentLoop(testCase, token, first, conversationId);
    const actual = classify(resolved.body);
    const kind = resolved.body && resolved.body.loopExhausted ? "loop_exhausted" : actual.kind;
    return {
      id: testCase.id,
      expected: testCase.expected,
      actual: kind,
      pass: kind === testCase.expected,
      status: resolved.status,
      note: testCase.note,
      durationMs: Date.now() - started,
      loopSteps: resolved.loopSteps,
      decidedBy: decidedBy(resolved.body),
      loopExhausted: !!(resolved.body && resolved.body.loopExhausted),
      detail: actual.detail
    };
  } catch (err) {
    return {
      id: testCase.id,
      expected: testCase.expected,
      actual: "network_error",
      pass: false,
      status: 0,
      note: testCase.note,
      durationMs: Date.now() - started,
      decidedBy: "model",
      detail: err.message
    };
  }
}

function summarize(results) {
  const total = results.length;
  const passed = results.filter(function (r) { return r.pass; }).length;
  const accuracy = total ? (passed / total) * 100 : 0;
  const negativeCases = results.filter(function (r) {
    return r.expected === "answer" || r.expected === "clarify";
  });
  const falsePositives = negativeCases.filter(function (r) {
    return ["generate", "modify", "document", "build", "propose_action"].indexOf(r.actual) !== -1;
  }).length;
  const falsePositiveRate = negativeCases.length ? (falsePositives / negativeCases.length) * 100 : 0;
  const prerouterDecided = results.filter(function (r) { return r.decidedBy === "prerouter"; }).length;
  const modelDecided = results.filter(function (r) { return r.decidedBy === "model"; }).length;

  return {
    total: total,
    passed: passed,
    accuracy: Number(accuracy.toFixed(1)),
    falsePositives: falsePositives,
    falsePositiveRate: Number(falsePositiveRate.toFixed(1)),
    decidedBy: {
      prerouter: prerouterDecided,
      model: modelDecided
    }
  };
}

async function main() {
  const token = await getToken();
  const results = [];

  for (let i = 0; i < cases.length; i++) {
    const result = await runCase(cases[i], token);
    results.push(result);
    const mark = result.pass ? "PASS" : "FAIL";
    console.log(
      (i + 1).toString().padStart(2, "0") + "/" + cases.length +
      "  " + mark.padEnd(4, " ") +
      "  " + result.id +
      "  expected=" + result.expected +
      "  actual=" + result.actual +
      "  http=" + result.status
    );
    if (i < cases.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  const summary = summarize(results);
  console.log("");
  console.log("Accuracy: " + summary.passed + "/" + summary.total + " (" + summary.accuracy + "%)");
  console.log("False-positive proposal rate: " + summary.falsePositives + "/" +
    results.filter(function (r) { return r.expected === "answer" || r.expected === "clarify"; }).length +
    " (" + summary.falsePositiveRate + "%)");
  console.log("Decided by pre-router: " + summary.decidedBy.prerouter + "/" + summary.total);
  console.log("Reached model path: " + summary.decidedBy.model + "/" + summary.total);

  const payload = {
    label: LABEL,
    generatedAt: new Date().toISOString(),
    nrUrl: NR_URL,
    summary: summary,
    results: results
  };
  const outFile = path.join(
    OUTPUT_DIR,
    "routing-results-" + LABEL + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json"
  );
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  const durableFile = path.join(RESULTS_DIR, path.basename(outFile));
  if (path.resolve(durableFile) !== path.resolve(outFile)) {
    fs.copyFileSync(outFile, durableFile);
  }
  console.log("Results written to " + outFile);
  if (path.resolve(durableFile) !== path.resolve(outFile)) {
    console.log("Results mirrored to " + durableFile);
  }
}

main().catch(function (err) {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
