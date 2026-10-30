#!/usr/bin/env node
"use strict";

// FlowPilot engine corpus runner. Classic cases exercise the operational
// endpoints directly. Simple Flow cases exercise the browser-shaped agent
// loop, but answer reads from their fixture and only run the two browser
// gates; no write is ever executed here.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const vm = require("vm");

const NR_URL = process.env.NR_URL || "http://127.0.0.1:1880";
const NR_USER = process.env.NR_USER || "fp-test";
const NR_PASS = process.env.NR_PASS;
const DELAY_MS = parseInt(process.env.DELAY_MS || "4000", 10);
const MAX_STEPS = parseInt(process.env.AGENT_LOOP_MAX_STEPS || "8", 10);
const OUTPUT_DIR = process.env.OUTPUT_DIR || __dirname;
const CASES_FILE = path.join(__dirname, "cases.json");
const cases = JSON.parse(fs.readFileSync(CASES_FILE, "utf8"));
const CORPUS_SHA256 = crypto.createHash("sha256").update(fs.readFileSync(CASES_FILE)).digest("hex");

function expectMatches(expect, kind) {
  return Array.isArray(expect) ? expect.indexOf(kind) !== -1 : expect === kind;
}

function post(url, body, token) {
  return new Promise(function (resolve, reject) {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const raw = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) };
    if (token) { headers.Authorization = "Bearer " + token; }
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
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
    req.write(raw);
    req.end();
  });
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function getToken() {
  if (!NR_PASS) { throw new Error("NR_PASS is required"); }
  const result = await post(NR_URL + "/auth/token", {
    client_id: "node-red-admin", grant_type: "password", scope: "*",
    username: NR_USER, password: NR_PASS
  });
  if (result.status !== 200 || !result.body || !result.body.access_token) {
    throw new Error("Auth failed (HTTP " + result.status + "): " + JSON.stringify(result.body));
  }
  return result.body.access_token;
}

// consent.js is loaded exactly as the Node export is loaded by product code.
// diff-gate.js is a browser fragment, so load it in a vm context in the same
// spirit as build-core-script.js's shared closure.
function loadGateModules() {
  const consent = require(path.join(__dirname, "..", "..", "lib", "core", "consent.js"));
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "core", "diff-gate.js"), "utf8");
  const context = {};
  vm.runInNewContext(source + "\nthis.__flowPilotDiffGate = {" +
    "getDiffGateThreshold:getDiffGateThreshold," +
    "createDiffGateState:createDiffGateState," +
    "diffGateDecision:diffGateDecision," +
    "diffGateApproveScope:diffGateApproveScope," +
    "diffGateApprovePlan:diffGateApprovePlan" +
  "};", context, { filename: "lib/core/diff-gate.js" });
  return {
    consent: consent,
    diffGate: context.__flowPilotDiffGate,
    intake: require(path.join(__dirname, "..", "..", "lib", "core", "intake.js"))
  };
}

const GATES = loadGateModules();

function clone(value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }
function safeJsonParse(value) { if (typeof value !== "string") { return null; } try { return JSON.parse(value); } catch (err) { return null; } }
function toolName(call) { return call && call.function && call.function.name; }
function toolArgs(call) { return safeJsonParse(call && call.function && call.function.arguments) || {}; }

function buildConnections(nodes, allNodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = {};
  list.forEach(function (node) { if (node && node.id) { byId[node.id] = node; } });
  const inputs = {};
  list.forEach(function (node) { inputs[node.id] = []; });
  const edges = [];
  list.forEach(function (node) {
    (Array.isArray(node.wires) ? node.wires : []).forEach(function (targets, fromPort) {
      (Array.isArray(targets) ? targets : []).forEach(function (targetId) {
        if (!byId[targetId]) { return; }
        edges.push({ fromId: node.id, fromPort: fromPort, toId: targetId });
        inputs[targetId].push({ fromId: node.id, fromPort: fromPort });
      });
    });
  });
  return {
    nodes: list.map(clone), edges: edges,
    perNode: list.map(function (node) {
      return {
        id: node.id, label: (node.name || node.id) + " [" + node.type + "]", type: node.type,
        flowId: node.z || null, inputs: inputs[node.id] || [],
        outputs: (Array.isArray(node.wires) ? node.wires : []).map(function (targets, port) {
          return { port: port, to: (Array.isArray(targets) ? targets : []).filter(function (id) { return !!byId[id]; }) };
        })
      };
    }),
    scopeNodeCount: list.length,
    instanceNodeCount: Array.isArray(allNodes) ? allNodes.length : list.length
  };
}

function fixtureParts(testCase) {
  const flow = Array.isArray(testCase.flow) ? testCase.flow : [];
  const tab = flow.find(function (node) { return node && node.type === "tab"; }) || { id: "corpus-tab", label: "Corpus tab" };
  const nodes = flow.filter(function (node) { return node && node.type !== "tab" && node.type !== "group"; }).map(clone);
  const allCandidates = nodes.filter(function (node) { return node.z === tab.id; }).map(function (node) {
    return { id: node.id, name: node.name || node.id, type: node.type, z: node.z || null,
      tabLabel: tab.label, inActiveTab: true };
  });
  const genericName = /^(debug|inject|function|change|switch|comment|node|template|delay|trigger|link in|link out|http request|http in|http response|mqtt in|mqtt out)$/;
  const lowerPrompt = String(testCase.prompt || "").toLowerCase();
  const matched = allCandidates.map(function (candidate) {
    const name = String(candidate.name || "").toLowerCase();
    const nameHit = !!name && lowerPrompt.indexOf(name) !== -1;
    const realName = nameHit && name !== String(candidate.type || "").toLowerCase() && !genericName.test(name);
    const typeHit = lowerPrompt.indexOf(String(candidate.type || "").toLowerCase()) !== -1;
    return { candidate: candidate, score: (realName ? 20 : nameHit ? 2 : 0) + (typeHit ? 1 : 0) };
  }).filter(function (entry) { return entry.score > 0; }).sort(function (a, b) { return b.score - a.score; });
  const candidates = (matched.length ? matched.map(function (entry) { return entry.candidate; }) : allCandidates).slice(0, 6);
  const selected = Array.isArray(testCase.selected) ? testCase.selected.slice() : [];
  const intake = GATES.intake.buildIntake(testCase.prompt, {}, {
    activeSelectionIds: function () { return selected.slice(); }, activeTab: { id: tab.id, label: tab.label }, candidates: candidates,
    touchedIndex: GATES.intake.createTouchedNodeIndex()
  });
  const contextIds = selected.length ? selected : intake.targetIds;
  const contextNodes = contextIds.map(function (id) {
    return nodes.find(function (node) { return node.id === id; });
  }).filter(Boolean).map(clone);
  const context = { nodes: contextNodes, connections: buildConnections(contextNodes, nodes),
    activeTab: { id: tab.id, label: tab.label } };
  return { flow: flow, tab: tab, nodes: nodes, candidates: candidates, intake: intake,
    context: context, targetLock: GATES.intake.lockTargetIds(context) };
}

function readTool(call, parts, context) {
  const name = toolName(call);
  const args = toolArgs(call);
  const nodes = parts.nodes;
  if (name === "read_node") {
    const node = (args.id && nodes.find(function (item) { return item.id === args.id; })) ||
      (args.name && nodes.find(function (item) { return item.name === args.name; }));
    return node ? clone(node) : { error: "No node found matching " + JSON.stringify(args) + "." };
  }
  if (name === "list_flows") { return { flows: [{ id: parts.tab.id, label: parts.tab.label, type: "tab", nodeCount: nodes.length }] }; }
  if (name === "search_flow") {
    const query = String(args.query || "").toLowerCase();
    const type = String(args.type || "").toLowerCase();
    return { results: nodes.filter(function (node) {
      return (!query || String(node.name || "").toLowerCase().indexOf(query) !== -1 || String(node.type || "").toLowerCase().indexOf(query) !== -1) &&
        (!type || String(node.type || "").toLowerCase().indexOf(type) !== -1);
    }).map(function (node) { return { id: node.id, name: node.name || "", type: node.type, flowId: node.z || null }; }) };
  }
  if (name === "get_connections") {
    if (args.id) {
      const node = nodes.find(function (item) { return item.id === args.id; });
      if (!node) { return { error: "No node found for id " + args.id + "." }; }
      const linked = [node];
      nodes.forEach(function (other) {
        const out = (other.wires || []).some(function (targets) { return (targets || []).indexOf(node.id) !== -1; });
        const inLink = (node.wires || []).some(function (targets) { return (targets || []).indexOf(other.id) !== -1; });
        if ((out || inLink) && linked.indexOf(other) === -1) { linked.push(other); }
      });
      return buildConnections(linked, nodes);
    }
    return buildConnections(context.nodes.length ? context.nodes : nodes, nodes);
  }
  if (name === "get_selection") {
    return context.nodes.length ? { selected: true, nodes: clone(context.nodes), groupCount: 0 } :
      { selected: false, message: "Nothing is currently selected in the editor." };
  }
  if (name === "read_debug") { return { messages: [], totalBuffered: 0 }; }
  return { error: "Unsupported read tool: " + name };
}

const WRITE_TOOLS = new Set(["apply_step", "remove_step", "rename_node", "group_nodes", "deploy_flows"]);

// Mirrors collectWriteToolConsentItems in lib/core/main.js:2452-2503.
// apply_step changes→modify-config, wires→rewire, newNodes→create;
// remove_step→delete, rename_node→modify-config, deploy_flows→deploy.
function consentItems(call, parts) {
  const name = toolName(call), args = toolArgs(call), byId = {};
  parts.nodes.forEach(function (node) { byId[node.id] = node; });
  function item(op, id, type) { return { op: op, nodeId: id || null, type: type || (byId[id] && byId[id].type) || null }; }
  if (name === "apply_step") {
    const items = [];
    (args.newNodes || []).forEach(function (node) { items.push(item("create", node && node.id, node && node.type)); });
    (args.newWires || []).forEach(function (wire) { if (wire) { items.push(item("rewire", wire.from)); items.push(item("rewire", wire.to)); } });
    (args.changes || []).forEach(function (change) { if (change) { items.push(item("modify-config", change.id)); } });
    return items;
  }
  if (name === "remove_step") {
    return (Array.isArray(args.nodeIds) ? args.nodeIds : [args.nodeId]).filter(Boolean).map(function (id) {
      return item("delete", id);
    });
  }
  if (name === "rename_node") { return [item("modify-config", args.nodeId)]; }
  if (name === "deploy_flows") { return [item("deploy", null, null)]; }
  // group_nodes is write-safe in the browser, so it intentionally has no
  // consent item even though it is still checked by the diff gate.
  return [];
}

function ledgerForWrite(call, parts) {
  const name = toolName(call), args = toolArgs(call), byId = {}, out = [], seen = {};
  parts.nodes.forEach(function (node) { byId[node.id] = node; });
  function add(id, created) {
    if (!id || seen[id]) { return; }
    seen[id] = true;
    out.push({ id: String(id), name: byId[id] ? (byId[id].name || "(unnamed)") : "(unnamed)",
      type: byId[id] ? byId[id].type : "(unknown)", created: !!created });
  }
  if (name === "apply_step") {
    (args.newNodes || []).forEach(function (node) { if (node) { add(node.id, true); } });
    (args.changes || []).forEach(function (change) { if (change) { add(change.id, false); } });
    // diff-gate's link ledger counts the source node, not the target node.
    (args.newWires || []).forEach(function (wire) { if (wire) { add(wire.from, false); } });
  } else if (name === "remove_step") {
    (Array.isArray(args.nodeIds) ? args.nodeIds : [args.nodeId]).forEach(function (id) { add(id, false); });
  } else if (name === "rename_node") { add(args.nodeId, false);
  } else if (name === "group_nodes") { (args.nodeIds || []).forEach(function (id) { add(id, false); }); }
  return out;
}

// Applies a write that passed both gates to the case fixture and returns the
// result the browser would send back: buildWriteToolResult's shape plus the
// same changeDetails as executeApplyStepTool / executeRemoveStepTool /
// executeRenameNodeTool in lib/core/main.js. Like the browser, an unchanged
// write is reported as a no-op and never changes the fixture.
function applyWriteToFixture(call, parts) {
  const name = toolName(call), args = toolArgs(call), checks = [], changeDetails = [], extra = {};
  function find(id) { return parts.nodes.find(function (node) { return node.id === id; }); }
  function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
  function wireAlreadyExists(wire) {
    const from = find(wire && wire.from), port = wire && (wire.fromPort || 0);
    return !!(from && Array.isArray(from.wires) && Array.isArray(from.wires[port]) && from.wires[port].indexOf(wire.to) !== -1);
  }
  if (name === "apply_step" && !(args.newNodes || []).length) {
    const noOp = (args.changes || []).every(function (change) {
      const live = change && find(change.id);
      return !!live && change.set && Object.keys(change.set).every(function (key) {
        return key === "wires" ? same(live.wires || [], change.set.wires || []) : same(live[key], change.set[key]);
      });
    }) && (args.newWires || []).every(wireAlreadyExists);
    if (noOp && ((args.changes || []).length || (args.newWires || []).length)) {
      return { requested: clone(args), checks: [{ check: "exists", nodeId: "(no-op)", expected: true, actual: true, pass: true }], allPass: true,
        noChange: true, error: "No change: already applied" };
    }
  }
  if (name === "rename_node") {
    const live = find(args.nodeId);
    if (live && live.name === args.name) {
      return { requested: clone(args), checks: [{ check: "property", nodeId: args.nodeId, prop: "name",
        expected: args.name, actual: args.name, pass: true }], allPass: true,
        noChange: true, error: "No change: already applied" };
    }
  }
  if (name === "apply_step") {
    (args.newNodes || []).forEach(function (node) {
      if (!node) { return; }
      const added = clone(node);
      if (!added.z) { added.z = parts.tab.id; }
      parts.nodes.push(added);
      checks.push({ check: "exists", nodeId: added.id, expected: true, actual: true, pass: true });
      changeDetails.push({ id: added.id, name: added.name, type: added.type, changeType: "added", after: clone(added) });
    });
    if ((args.newNodes || []).length) { extra.newNodes = clone(args.newNodes); }
    (args.changes || []).forEach(function (change) {
      if (!change || !change.id || !change.set) { return; }
      const live = find(change.id);
      const propertyChanges = Object.keys(change.set).filter(function (key) { return key !== "wires"; }).map(function (key) {
        return { key: key, oldVal: live ? clone(live[key]) : undefined, newVal: clone(change.set[key]) };
      });
      if (live) {
        propertyChanges.forEach(function (pc) { live[pc.key] = clone(pc.newVal); });
        if (Object.prototype.hasOwnProperty.call(change.set, "wires")) { live.wires = clone(change.set.wires); }
      }
      propertyChanges.forEach(function (pc) {
        checks.push({ check: "property", nodeId: change.id, prop: pc.key, expected: pc.newVal, actual: live ? live[pc.key] : undefined, pass: !!live });
      });
      (change.set.wires || []).forEach(function (targets, port) {
        (targets || []).forEach(function (toId) { checks.push({ check: "wire", fromId: change.id, fromPort: port, toId: toId, expected: toId, actual: live ? toId : null, pass: !!live }); });
      });
      changeDetails.push({ id: change.id, name: live && live.name, type: live && live.type,
        before: propertyChanges.reduce(function (v, pc) { v[pc.key] = pc.oldVal; return v; }, {}),
        after: propertyChanges.reduce(function (v, pc) { v[pc.key] = pc.newVal; return v; }, {}),
        propertyChanges: propertyChanges });
    });
    (args.newWires || []).forEach(function (wire) {
      if (!wire) { return; }
      const from = find(wire.from), port = wire.fromPort || 0;
      if (from) {
        from.wires = Array.isArray(from.wires) ? from.wires : [];
        while (from.wires.length <= port) { from.wires.push([]); }
        if (from.wires[port].indexOf(wire.to) === -1) { from.wires[port].push(wire.to); }
      }
      checks.push({ check: "wire", fromId: wire.from, fromPort: port, toId: wire.to, expected: wire.to, actual: from ? wire.to : null, pass: !!from });
    });
  } else if (name === "remove_step") {
    const ids = Array.isArray(args.nodeIds) ? args.nodeIds.slice() : (args.nodeId ? [args.nodeId] : []);
    const liveById = {};
    ids.forEach(function (id) { liveById[id] = find(id); });
    parts.nodes = parts.nodes.filter(function (node) { return ids.indexOf(node.id) === -1; });
    parts.nodes.forEach(function (node) {
      node.wires = (node.wires || []).map(function (targets) { return (targets || []).filter(function (id) { return ids.indexOf(id) === -1; }); });
    });
    ids.forEach(function (id) {
      checks.push({ check: "absent", nodeId: id, expected: true, actual: true, pass: true });
      changeDetails.push({ id: id, changeType: "removed", before: liveById[id] ? clone(liveById[id]) : { id: id } });
    });
  } else if (name === "rename_node") {
    const live = find(args.nodeId), oldName = live ? live.name : undefined;
    if (live) { live.name = args.name; }
    checks.push({ check: "property", nodeId: args.nodeId, prop: "name", expected: args.name, actual: live ? live.name : undefined, pass: !!live });
    changeDetails.push({ id: args.nodeId, name: args.name, type: live && live.type, before: { name: oldName }, after: { name: args.name },
      propertyChanges: [{ key: "name", oldVal: oldName, newVal: args.name }] });
  } else if (name === "group_nodes") {
    checks.push({ check: "exists", nodeId: args.name, expected: true, actual: true, pass: true });
    extra.groupId = "corpus-group-" + String(args.name || "group");
  }
  if (!checks.length) { checks.push({ check: "exists", nodeId: "(write)", expected: true, actual: true, pass: true }); }
  if (changeDetails.length) { extra.changeDetails = changeDetails; }
  const allPass = checks.every(function (check) { return check.pass; });
  return Object.assign({ requested: clone(args), checks: checks, allPass: allPass }, extra);
}

function evaluateWriteTool(call, lockedTargets, parts, state, priorLedger) {
  const options = arguments.length > 5 && arguments[5] ? arguments[5] : {};
  const items = consentItems(call, parts);
  const decisions = toolName(call) === "group_nodes" ? ["auto"] : (items.length ? items.map(function (item) {
    return GATES.consent.decideConsent(item.op, item.type, { nodeId: item.nodeId });
  }) : ["ask"]);
  const consent = decisions.indexOf("ask") !== -1 ? "ask" : "auto";
  // Corpus callers can model the user clicking Proceed without inventing a
  // second gate implementation. Multi-node consent covers every item in the
  // accepted call, including all nodes in a delete batch.
  if (options.consentAccepted === true && consent === "ask") {
    GATES.diffGate.diffGateApproveScope(state, items.map(function (item) { return item.nodeId; }).filter(Boolean));
  }
  if (Array.isArray(options.approvedScopeNodeIds)) {
    GATES.diffGate.diffGateApproveScope(state, options.approvedScopeNodeIds);
  }
  if (options.planApproved === true) {
    GATES.diffGate.diffGateApprovePlan(state, options.planNodeIds || []);
  }
  const ledger = (priorLedger || []).concat(ledgerForWrite(call, parts));
  const diff = GATES.diffGate.diffGateDecision(ledger, lockedTargets, state, {
    lane: options.lane || state.lane || "DIRECT",
    planApproved: options.planApproved === true
  });
  return { consent: consent, consentItems: items, diff: diff, ledger: ledger };
}

function classifyCannedToolCall(call, parts, lockedTargets) {
  const name = toolName(call);
  if (name === "ask_user") { return "ask_target"; }
  if (name === "propose_action") { return toolArgs(call).needs_selection === true ? "ask_target" : "refused"; }
  const state = GATES.diffGate.createDiffGateState(lockedTargets, {});
  const gate = evaluateWriteTool(call, lockedTargets, parts, state, []);
  if (gate.consent === "ask") { return "consent_ask"; }
  if (gate.diff.pause) { return "diff_gate_pause"; }
  return "write_allowed";
}

function appendAssistant(messages, body) { return (messages || []).concat([{ role: "assistant", content: body.content || null, tool_calls: body.toolCalls }]); }
function appendTool(messages, call, result) { return messages.concat([{ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) }]); }

function classify(endpoint, status, body) {
  if (status === 0) { return "network_error"; }
  if (status === 400 && body && body.error === "strategy_required") { return "strategy_required"; }
  if (status === 409 && body && body.error === "agent_strategy_unavailable") { return "agent_strategy_unavailable"; }
  if (status >= 500) { return "server_error"; }
  if (status === 400) { return "bad_request"; }
  if (status === 422) {
    const error = (body && body.error) || "";
    if (/did not contain a.+flow|recognizable modify fields/i.test(error)) { return "wrong_envelope"; }
    if (/not in the selection|wire references|group references/i.test(error)) { return "wrong_content"; }
    return "parse_error";
  }
  if (status !== 200) { return "http_error"; }
  if (body && body.prose === true) {
    if (body.suggestedAction && body.suggestedAction.mode) { return "mode_redirect"; }
    return /\b(should\s+i|would\s+you\s+like|shall\s+i|do\s+you\s+want|want\s+me\s+to|may\s+i)\b/i.test(String(body.explanation || ""))
      ? "asked_permission" : "prose";
  }
  if (body && body.question) { return "question"; }
  if (endpoint === "generate" || endpoint === "build" || endpoint === "document") { return body && Array.isArray(body.flow) && body.flow.length ? "success" : "empty_flow"; }
  if (endpoint === "modify") {
    if (body && body.suggestedAction && body.suggestedAction.mode && body.suggestedAction.mode !== "modify") { return "mode_redirect"; }
    const hasWork = (body && Array.isArray(body.flow) && body.flow.length) || (body && Array.isArray(body.newNodes) && body.newNodes.length) || (body && Array.isArray(body.removeNodes) && body.removeNodes.length);
    return hasWork ? "success" : "no_changes";
  }
  return "unknown";
}

function finalAgentKind(body, wrote) {
  if (wrote) { return "write_allowed"; }
  // A text reply is never the ASK picker. The browser shows the picker only
  // for propose_action (needs_selection, or the server's ASK lane) and ask_user.
  return "refused";
}

// The server lane applies only to propose_action, as in the browser
// (processToolCallsFrom → dispatchForLane in lib/core/modes.js).
function proposalKind(call, wrote, lane) {
  if (wrote) { return "write_allowed"; }
  return toolArgs(call).needs_selection === true || String(lane || "").toUpperCase() === "ASK" ? "ask_target" : "refused";
}

function makeResult(testCase, kind, started, extras) {
  const pass = testCase.expect === null || testCase.expect === undefined ? null : expectMatches(testCase.expect, kind);
  return Object.assign({ id: testCase.id, endpoint: testCase.endpoint, description: testCase.description,
    expect: testCase.expect !== undefined ? testCase.expect : null, kind: kind, pass: pass,
    status: 200, durationMs: Date.now() - started }, extras || {});
}

async function runClassicCase(testCase, token) {
  const started = Date.now();
  const body = { prompt: testCase.prompt, stream: false, history: [], strategy: "classic", entry: testCase.endpoint };
  if (testCase.request && typeof testCase.request === "object") { Object.assign(body, testCase.request); }
  if (Array.isArray(testCase.omitFields)) { testCase.omitFields.forEach(function (field) { delete body[field]; }); }
  if (testCase.context) { body.context = testCase.context; }
  let response;
  try { response = await post(NR_URL + "/flowpilot/" + testCase.endpoint, body, token); }
  catch (err) { return makeResult(testCase, "network_error", started, { status: 0, networkError: err.message }); }
  const kind = classify(testCase.endpoint, response.status, response.body);
  const result = makeResult(testCase, kind, started, { status: response.status });
  if (response.body && response.body.explanation) { result.explanation = response.body.explanation; }
  if (kind !== "success") { result.raw = response.body; }
  return result;
}

async function runAgentCase(testCase, token) {
  const started = Date.now(), parts = fixtureParts(testCase);
  const initial = { prompt: testCase.prompt, stream: false, history: [], strategy: "agent", tools: true,
    entry: testCase.entry, intake: parts.intake, targetLock: parts.targetLock, context: parts.context };
  let response;
  try { response = await post(NR_URL + testCase.route, initial, token); }
  catch (err) { return makeResult(testCase, "network_error", started, { status: 0, networkError: err.message, writes: [] }); }
  let body = response.body || {}, messages = Array.isArray(body.messages) ? body.messages.slice() : [], steps = 0;
  let ledger = [], kind = null, terminalStatus = response.status, terminalBody = body;
  const writes = [], state = GATES.diffGate.createDiffGateState(parts.targetLock.ids, {});
  let noOpWriteStreak = 0;
  while (true) {
    terminalStatus = response.status; terminalBody = response.body || {};
    if (response.status !== 200) { kind = classify(testCase.entry, response.status, response.body); break; }
    const calls = Array.isArray(body.toolCalls) ? body.toolCalls : [];
    if (!calls.length) { kind = finalAgentKind(body, writes.length > 0); break; }
    messages = appendAssistant(messages, body);
    let stopped = false;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i], name = toolName(call);
      if (name === "propose_action") { kind = proposalKind(call, writes.length > 0, body.lane); stopped = true; break; }
      if (name === "ask_user") { kind = writes.length > 0 ? "write_allowed" : "ask_target"; stopped = true; break; }
      if (!WRITE_TOOLS.has(name)) { messages = appendTool(messages, call, readTool(call, parts, parts.context)); continue; }
      const gate = evaluateWriteTool(call, parts.targetLock.ids, parts, state, ledger);
      const record = { tool: name, args: clone(toolArgs(call)), consent: gate.consent, consentItems: gate.consentItems,
        diff: { pause: gate.diff.pause, reason: gate.diff.reason, touchedNodes: gate.diff.touchedNodes,
          outOfTargetNodes: gate.diff.outOfTargetNodes.map(clone) } };
      writes.push(record);
      if (gate.consent === "ask") { kind = "consent_ask"; stopped = true; break; }
      if (gate.diff.pause) { kind = "diff_gate_pause"; stopped = true; break; }
      record.result = applyWriteToFixture(call, parts); ledger = gate.ledger; messages = appendTool(messages, call, record.result);
      if (record.result.noChange) { noOpWriteStreak++; } else { noOpWriteStreak = 0; }
      if (noOpWriteStreak >= 2) { kind = "write_allowed"; stopped = true; break; }
    }
    if (stopped) { break; }
    // Reaching the step limit is a failure even after clean writes: a run
    // that keeps writing costs time and tokens (architect's call, step b;
    // the product guard is polish item #32).
    if (steps >= MAX_STEPS) { kind = "loop_exhausted"; break; }
    steps++;
    const stepBody = { messages: messages, mode: testCase.entry, prompt: testCase.prompt, context: parts.context,
      intake: parts.intake, targetLock: parts.targetLock, strategy: "agent", entry: testCase.entry,
      runId: "corpus-" + testCase.id, events: [] };
    try { response = await post(NR_URL + "/flowpilot/agent-step", stepBody, token); }
    catch (err) { kind = "network_error"; terminalStatus = 0; terminalBody = null; break; }
    body = response.body || {};
  }
  const result = makeResult(testCase, kind || "loop_exhausted", started, { status: terminalStatus, steps: steps,
    targetLock: parts.targetLock, writes: writes,
    touchedIds: ledger.filter(function (node) { return !node.created; }).map(function (node) { return node.id; })
      .filter(function (id, index, list) { return list.indexOf(id) === index; }),
    raw: kind === "write_allowed" ? undefined : terminalBody });
  if (kind === "write_allowed" && Array.isArray(testCase.expectTouched)) {
    const actual = result.touchedIds.slice().sort(), expected = testCase.expectTouched.slice().sort();
    result.targetCheck = { expected: expected, actual: actual, pass: JSON.stringify(expected) === JSON.stringify(actual) };
    if (!result.targetCheck.pass) { result.pass = false; }
  }
  if (kind === "ask_target" && writes.length) { result.pass = false; }
  return result;
}

function validateFixedToolResult(name, result) {
  const checks = new Set(["property", "exists", "absent", "wire"]);
  if (name === "ask_user") { return result && typeof result.answer === "string" && result.answer.length > 0 ? null : "ask_user result requires a non-empty answer"; }
  if (!["apply_step", "remove_step", "rename_node"].includes(name)) { return "unsupported scripted tool " + name; }
  if (!result || !Array.isArray(result.checks) || !result.checks.length) { return "WRITE result requires non-empty checks"; }
  for (const check of result.checks) {
    if (!check || !checks.has(check.check) || typeof check.pass !== "boolean" || !Object.prototype.hasOwnProperty.call(check, "expected") || !Object.prototype.hasOwnProperty.call(check, "actual")) { return "invalid check vocabulary"; }
    if (check.check === "wire" && (!check.fromId || !Number.isInteger(check.fromPort) || !check.toId)) { return "wire check requires fromId/fromPort/toId"; }
    if (check.check !== "wire" && !check.nodeId) { return check.check + " check requires nodeId"; }
    if (check.check === "property" && !check.prop) { return "property check requires prop"; }
  }
  return null;
}

function runFixedScriptCase(testCase) {
  const started = Date.now(), script = testCase.fixedScript;
  if (!script || !script.call || !script.result) { return makeResult(testCase, "fixed_script_error", started, { status: 0, networkError: "malformed fixedScript" }); }
  const messages = [{ role: "assistant", content: null, tool_calls: [{ id: script.call.id, type: "function",
    function: { name: script.call.name, arguments: JSON.stringify(script.call.arguments || {}) } }] },
    { role: "tool", tool_call_id: script.call.id, content: JSON.stringify(script.result) }];
  let error = validateFixedToolResult(script.call.name, script.result);
  let parsed;
  try { parsed = JSON.parse(messages[1].content); } catch (err) { error = "tool result did not round-trip as JSON"; }
  if (!error && JSON.stringify(parsed) !== JSON.stringify(script.result)) { error = "tool result changed during message round-trip"; }
  return makeResult(testCase, error ? "fixed_script_error" : "fixed_script_success", started, { status: 0, networkError: error || undefined });
}

async function main() {
  console.log("══ FlowPilot Engine Corpus Runner ═══════════════════════");
  console.log("NR_URL  :", NR_URL); console.log("Cases   :", cases.length); console.log("SHA256  :", CORPUS_SHA256); console.log("Delay   :", DELAY_MS + "ms between requests");
  let token;
  try { token = await getToken(); } catch (err) { console.error("Auth FAILED:", err.message); process.exitCode = 1; return; }
  const results = [], counts = {};
  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i]; process.stdout.write(("[" + (i + 1) + "/" + cases.length + "] " + testCase.id).padEnd(40) + " ... ");
    let result;
    if (testCase.fixedScript) { result = runFixedScriptCase(testCase); }
    else if (testCase.endpoint === "agent") { result = await runAgentCase(testCase, token); }
    else { result = await runClassicCase(testCase, token); }
    results.push(result); counts[result.kind] = (counts[result.kind] || 0) + 1;
    console.log(result.kind + (result.pass === false ? " (UNEXPECTED, expected=" + result.expect + ")" : ""));
    if (i < cases.length - 1) { await sleep(DELAY_MS); }
  }
  const unexpected = results.filter(function (result) { return result.pass === false; });
  const scored = results.filter(function (result) { return result.pass !== null; });
  const summary = { timestamp: new Date().toISOString(), nrUrl: NR_URL, total: results.length,
    passed: scored.filter(function (result) { return result.pass === true; }).length, scored: scored.length,
    unexpected: unexpected.length, informational: results.filter(function (result) { return result.pass === null; }).length, byKind: counts };
  const outFile = path.join(OUTPUT_DIR, "results-" + Date.now() + ".json");
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ corpusSha256: CORPUS_SHA256, summary: summary, results: results }, null, 2) + "\n");
  unexpected.forEach(function (result) { console.log("UNEXPECTED:", result.id, "expected=" + result.expect, "got=" + result.kind); });
  console.log("RESULT: " + summary.passed + "/" + summary.scored + " scored cases pass · " + summary.unexpected + " unexpected · " + summary.informational + " informational (not scored) · total " + summary.total);
  console.log("Results → " + outFile); if (summary.unexpected) { process.exitCode = 1; }
}

if (require.main === module) { main().catch(function (err) { console.error("\nFatal:", err.stack || err.message); process.exitCode = 1; }); }

module.exports = { applyWriteToFixture: applyWriteToFixture, readTool: readTool, proposalKind: proposalKind, cases: cases, corpusSha256: CORPUS_SHA256, expectMatches: expectMatches, fixtureParts: fixtureParts,
  loadGateModules: loadGateModules, evaluateWriteTool: evaluateWriteTool, classifyCannedToolCall: classifyCannedToolCall,
  classify: classify, runAgentCase: runAgentCase };
