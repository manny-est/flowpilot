"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const corpus = require(path.join(__dirname, "..", "..", "..", "engine-corpus", "runner.js"));
const intake = require(path.join(__dirname, "..", "..", "..", "..", "lib", "core", "intake.js"));
const lanes = require(path.join(__dirname, "..", "..", "..", "..", "lib", "core", "lanes.js"));
const codeJudge = require(path.join(__dirname, "code-judge.js"));

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

const LIMITS = require("../../../../lib/core/limits.js");

function toolName(call) { return call && call.function && call.function.name; }
function toolArgs(call) {
  try { return JSON.parse(call && call.function && call.function.arguments || "{}"); }
  catch (error) { return {}; }
}

// Mirrors lib/core/modes.js: a tool-call turn may have null content, but a
// final reply is pushed as text (content || message || ""). Pushing null
// without tool_calls drew "HTTP 400: Invalid value for 'content'" (existing-09).
function appendAssistant(messages, body) {
  const calls = body.toolCalls || body.tool_calls;
  if (Array.isArray(calls) && calls.length) {
    return (messages || []).concat([{ role: "assistant", content: body.content || null, tool_calls: calls }]);
  }
  return (messages || []).concat([{ role: "assistant", content: body.content || body.message || "" }]);
}

function appendTool(messages, call, result) {
  return messages.concat([{ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) }]);
}

function routeForAction(action) {
  action = String(action || "").toLowerCase();
  if (action === "generate" || action === "create" || action === "build") {
    return { route: "/flowpilot/" + (action === "generate" || action === "create" ? "generate" : "build"), mode: action === "create" ? "generate" : action };
  }
  if (action === "modify") { return { route: "/flowpilot/modify", mode: "modify" }; }
  if (action === "document") { return { route: "/flowpilot/document", mode: "document" }; }
  return null;
}

function currentFlow(parts) {
  const tabs = Array.isArray(parts.flow) ? parts.flow.filter(function (node) {
    return node && (node.type === "tab" || node.type === "subflow");
  }) : [];
  return tabs.concat(parts.nodes.map(clone));
}

function planEnvelopeText(content) {
  const text = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (text.charAt(0) !== "{") { return null; }
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && (typeof obj.summary === "string" || typeof obj.explanation === "string")) {
      return String(obj.summary || obj.explanation || "");
    }
  } catch (e) { return null; }
  return null;
}

function rebuildTouchedIndex(snapshot) {
  const index = intake.createTouchedNodeIndex();
  if (snapshot && typeof snapshot === "object") {
    for (let run = 0; run < Number(snapshot.run || 0); run++) { index.beginRun(); }
    (snapshot.runs || []).forEach(function (record) {
      index.recordRun((record.nodeIds || []).map(function (id) { return { id: id }; }), record.run);
    });
  }
  return index;
}

function makeParts(entry, prompt, selected, oldParts) {
  const priorForIntake = oldParts && oldParts.touchedIndex ? oldParts.touchedIndex.snapshot()
    : oldParts && oldParts.intake && oldParts.intake.touchedNodeIndex;
  // Intake (and its target, which builds the context) sees the touched index,
  // so a follow-up's "it" resolves as in the browser instead of a picker.
  const testCase = { prompt: prompt, flow: oldParts ? currentFlow(oldParts) : loadFixture(entry.fixture), selected: selected || entry.selected || [],
    touchedIndex: priorForIntake ? rebuildTouchedIndex(priorForIntake) : undefined };
  const parts = corpus.fixtureParts(testCase);
  // The corpus helper deliberately omits groups from its editable node list.
  // The fuzzer must judge and mutate group fixtures too, so retain them in the
  // in-memory graph while leaving its active-tab targeting rules unchanged.
  const groups = testCase.flow.filter(function (node) { return node && node.type === "group"; }).map(clone);
  parts.nodes = parts.nodes.concat(groups);
  parts.flow = currentFlow(parts);
  const priorSnapshot = oldParts && oldParts.touchedIndex
    ? oldParts.touchedIndex.snapshot()
    : oldParts && oldParts.intake && oldParts.intake.touchedNodeIndex;
  parts.touchedIndex = intake.createTouchedNodeIndex();
  if (priorSnapshot && typeof priorSnapshot === "object") {
    const snapshot = priorSnapshot;
    for (let run = 0; run < Number(snapshot.run || 0); run++) { parts.touchedIndex.beginRun(); }
    (snapshot.runs || []).forEach(function (record) {
      parts.touchedIndex.recordRun((record.nodeIds || []).map(function (id) { return { id: id }; }), record.run);
    });
  }
  parts.intake.touchedNodeIndex = parts.touchedIndex.snapshot();
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

function uniqueIds(ids) {
  return (ids || []).filter(function (id, index, all) { return id && all.indexOf(id) === index; });
}

function graphDiff(before, after) {
  const beforeById = {};
  const afterById = {};
  (before || []).forEach(function (node) { if (node && node.id) { beforeById[node.id] = node; } });
  (after || []).forEach(function (node) { if (node && node.id) { afterById[node.id] = node; } });
  const addedNodeIds = Object.keys(afterById).filter(function (id) { return !beforeById[id]; });
  const removedNodeIds = Object.keys(beforeById).filter(function (id) { return !afterById[id]; });
  const changedNodeIds = Object.keys(afterById).filter(function (id) {
    return beforeById[id] && JSON.stringify(beforeById[id]) !== JSON.stringify(afterById[id]);
  });
  return { addedNodeIds: addedNodeIds, removedNodeIds: removedNodeIds, changedNodeIds: changedNodeIds,
    nodeIds: uniqueIds(addedNodeIds.concat(changedNodeIds)) };
}

function mergeGraphTruth(target, diff) {
  target = target || { addedNodeIds: [], changedNodeIds: [], removedNodeIds: [], nodeIds: [] };
  ["addedNodeIds", "changedNodeIds", "removedNodeIds", "nodeIds"].forEach(function (key) {
    target[key] = uniqueIds(target[key].concat(diff && diff[key] || []));
  });
  return target;
}

function proposalDispatch(proposal, prompt, parts) {
  const action = String(proposal.action || "").toLowerCase();
  const route = routeForAction(action);
  const targets = Array.isArray(proposal.targets) ? proposal.targets.filter(Boolean) : [];
  const targetNodes = targets.map(function (id) {
    return parts.nodes.find(function (node) { return node && node.id === id; });
  }).filter(Boolean).map(clone);
  const context = Object.assign({}, parts.context, {
    nodes: targetNodes,
    connections: corpus.fixtureParts({ prompt: prompt, flow: currentFlow({ nodes: targetNodes }), selected: targets }).context.connections
  });
  const targetLock = {
    ids: targets.slice(),
    labels: targetNodes.map(function (node) { return node.name || node.id; })
  };
  const approvedOperations = Array.isArray(proposal.approvedOperations) ? proposal.approvedOperations.slice() : [];
  const approvedScopeNodeIds = uniqueIds(targets.concat(approvedOperations.map(function (item) { return item && item.nodeId; })));
  const decision = intake.classifyEditIntent({ action: action, message: proposal.summary || prompt,
    selectionIds: targets, touchedIndex: proposal.touchedNodeIndex, inheritedRun: proposal.inheritedRun });
  const creationRun = ["generate", "build", "create"].indexOf(action) !== -1 && decision.creation === true;
  const lane = String(proposal.lane || lanes.chooseLane(parts.intake, Object.assign({}, proposal, { action: action })).lane || "ASK").toUpperCase();
  parts.context = context;
  parts.targetLock = targetLock;
  return { route: route, prompt: proposal.summary || prompt, context: context, targetLock: targetLock,
    approvedOperations: approvedOperations, approvedScopeNodeIds: approvedScopeNodeIds,
    creationRun: creationRun, lane: lane, planShown: lane === "PLAN",
    planApproved: lane === "PLAN", proposal: proposal };
}

function askedOptions(args, parts) {
  if (Array.isArray(args.options)) { return args.options.slice(); }
  if (args.question_kind === "target" && parts.intake && Array.isArray(parts.intake.candidates)) {
    return parts.intake.candidates.slice(0, 6).map(function (candidate) {
      return (candidate.name || candidate.id) + " [" + candidate.type + "]";
    }).concat(["Something else (describe it)"]);
  }
  return [];
}

function candidateNames(parts) {
  return (parts && parts.intake && Array.isArray(parts.intake.candidates) ? parts.intake.candidates : [])
    .slice(0, 6).map(function (candidate) { return candidate.name || candidate.id; }).filter(Boolean);
}

function questionText(question, options) {
  const text = String(question || "What would you like FlowPilot to do?").trim();
  const values = (Array.isArray(options) ? options : []).map(String).filter(function (value) { return value.length > 0; });
  return values.length ? text + " [" + values.join(" | ") + "]" : text;
}

function outcomeAction(wrote, asked) {
  return wrote ? "write" : asked ? "ask" : "answer";
}

async function executeTurn(entry, prompt, token, parts, options) {
  options = options || {};
  const requestPost = options.post || post;
  const initial = {
    prompt: prompt, stream: false, history: options.history || [], strategy: "agent", tools: true,
    entry: "chat", intake: parts.intake, context: parts.context
  };
  let response;
  try { response = await requestPost(NR_URL + "/flowpilot/chat", initial, token); }
  catch (error) { return { error: "network error", parts: parts, writes: [], transcript: [], finalText: "", action: "answer" }; }
  let body = response.body || {};
  let messages = Array.isArray(body.messages) ? body.messages.slice() : [];
  let ledger = [];
  let steps = 0;
  let finalText = "";
  const writes = [];
  const transcript = [];
  let consentAsked = false;
  let asked = false;
  let askedOptionsValue = [];
  let goalChecks = [];
  let goalCheckFixAttempts = 0;
  let planOnlyNudged = false;
  const MAX_GOAL_CHECK_FIX_ATTEMPTS = 2;
  let lane = null;
  let planShown = false;
  let graphTruth = { addedNodeIds: [], changedNodeIds: [], removedNodeIds: [], nodeIds: [] };
  let activeRoute = { mode: "chat" };
  let activePrompt = prompt;
  const state = corpus.loadGateModules().diffGate.createDiffGateState(parts.targetLock.ids, { lane: "DIRECT" });
  const creationState = { active: false,
    plannedNodeCount: null, planStepCount: null, firstWriteComplete: false };

  async function requestAgentStep() {
    if (steps >= MAX_STEPS) { return false; }
    steps++;
    const next = { messages: messages, mode: activeRoute.mode, prompt: activePrompt, context: parts.context,
      intake: parts.intake, targetLock: parts.targetLock, strategy: "agent", entry: activeRoute.mode,
      runId: "prompt-fuzz-" + entry.id, events: [] };
    try { response = await requestPost(NR_URL + "/flowpilot/agent-step", next, token); }
    catch (error) { return false; }
    body = response.body || {};
    return true;
  }

  async function runGoalCheck() {
    // Text, like the browser's summarizeRunGraph: the route stringifies an
    // object as "[object Object]" and the checker then reports "summary
    // missing" for every prompt (first full run).
    const summary = goalCheckSummaryText(codeJudge.summarizeGraph({ flow: currentFlow(parts) }));
    let checkResponse;
    try {
      checkResponse = await requestPost(NR_URL + "/flowpilot/goal-check", {
        request: prompt, summary: summary, runId: "prompt-fuzz-" + entry.id
      }, token);
    } catch (error) {
      const unavailable = { done: true, gaps: [], unavailable: true };
      goalChecks.push(unavailable);
      return false;
    }
    const answer = checkResponse && checkResponse.body && typeof checkResponse.body === "object"
      ? checkResponse.body : {};
    const gaps = Array.isArray(answer.gaps) ? answer.gaps.map(String).filter(Boolean) : [];
    const check = { done: answer.done === true, gaps: gaps };
    goalChecks.push(check);
    if (gaps.length && goalCheckFixAttempts < MAX_GOAL_CHECK_FIX_ATTEMPTS && steps < MAX_STEPS) {
      goalCheckFixAttempts++;
      messages = messages.concat([
        { role: "assistant", content: finalText },
        { role: "user", content: "Goal check: " + gaps[0] + ". Fix this specific gap with the existing flow; do not recreate nodes. Then give a short final summary." }
      ]);
      return requestAgentStep();
    }
    return false;
  }

  while (true) {
    if (response.status !== 200) {
      asked = true;
      finalText = "HTTP " + response.status + (response.body && (response.body.error || response.body.message) ? ": " + String(response.body.error || response.body.message).slice(0, 300) : "");
      break;
    }
    const calls = Array.isArray(body.toolCalls) ? body.toolCalls : Array.isArray(body.tool_calls) ? body.tool_calls : [];
    if (!calls.length) {
      finalText = String(body.explanation || body.content || body.message || "");
      const hasActualWrite = writes.some(function (record) {
        return record.result && !record.result.noChange && !record.result.error;
      });
      // Mirrors lib/core/modes.js propertyEditsOnly(): renames and property
      // changes on existing nodes, all verified, skip the goal check.
      const landed = writes.filter(function (record) { return record.result && !record.result.noChange && !record.result.skipped; });
      const propertyEditsOnly = landed.length > 0 && landed.every(function (record) {
        const a = record.args || {};
        const propertyOnly = record.tool === "rename_node" || (record.tool === "apply_step" &&
          !(Array.isArray(a.newNodes) && a.newNodes.length) && !(Array.isArray(a.newWires) && a.newWires.length) &&
          Array.isArray(a.changes) && a.changes.length > 0);
        return propertyOnly && record.result.allPass;
      });
      if (hasActualWrite && !propertyEditsOnly && await runGoalCheck()) { continue; }
      // Mirror the browser's nudgePlanOnlyReply (lib/core/modes.js): a change
      // run that answers with a {summary, plan_items} envelope and wrote
      // nothing is told once to act; the user never sees the raw JSON.
      const envelope = planEnvelopeText(finalText);
      if (envelope !== null && !hasActualWrite && !planOnlyNudged && activeRoute && activeRoute.mode !== "chat") {
        planOnlyNudged = true;
        messages = appendAssistant(messages, body).concat([{ role: "user", content: "Don't describe the plan: the user already asked for this. " +
          "Do it now with the write tools (apply_step / rename_node / remove_step), then give a short final summary." }]);
        if (await requestAgentStep()) { continue; }
      }
      if (envelope !== null) { finalText = envelope; }
      break;
    }
    messages = appendAssistant(messages, body);
    let stopped = false;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const name = toolName(call);
      const args = toolArgs(call);
      transcript.push({ tool: name, args: clone(args) });
      if (name === "ask_user") {
        asked = true;
        askedOptionsValue = askedOptions(args, parts);
        finalText = questionText(args.question, askedOptionsValue);
        transcript[transcript.length - 1].result = { simulated: "clarification requested" };
        stopped = true;
        break;
      }
      if (name === "propose_action") {
        const proposedAction = String(args.action || "").toLowerCase();
        const proposedTargets = Array.isArray(args.targets) ? args.targets.filter(Boolean) : [];
        const validProposedTargets = proposedTargets.filter(function (id) {
          return parts.nodes.some(function (node) { return node && node.id === id; });
        });
        if (proposedAction === "modify" && (args.needs_selection === true || validProposedTargets.length === 0)) {
          asked = true;
          askedOptionsValue = candidateNames(parts);
          finalText = questionText("Which node should I modify?", askedOptionsValue);
          transcript[transcript.length - 1].result = { action: "ask", askedOptions: askedOptionsValue };
          stopped = true;
          break;
        }
        const dispatch = proposalDispatch(args, prompt, parts);
        if (!dispatch.route) {
          asked = true;
          askedOptionsValue = [];
          transcript[transcript.length - 1].result = { error: "Unsupported proposed action" };
          stopped = true;
          break;
        }
        lane = dispatch.lane;
        planShown = planShown || dispatch.planShown;
        creationState.active = dispatch.creationRun;
        activeRoute = dispatch.route;
        activePrompt = dispatch.prompt;
        transcript[transcript.length - 1].result = { approved: true, lane: dispatch.lane, planShown: dispatch.planShown };
        const proposalBody = {
          prompt: dispatch.prompt, stream: false, history: messages, strategy: "agent", tools: true,
          entry: dispatch.route.mode, intake: parts.intake, context: dispatch.context,
          targetLock: dispatch.targetLock, approvedOperations: dispatch.approvedOperations,
          approvedScopeNodeIds: dispatch.approvedScopeNodeIds, planApproved: dispatch.planApproved,
          lane: dispatch.lane, creationRun: dispatch.creationRun
        };
        if (dispatch.planApproved) { proposalBody.fromAct = true; }
        if (args.transcriptPrompt) { proposalBody.transcriptPrompt = args.transcriptPrompt; }
        if (Array.isArray(args.continuation) && args.continuation.length) {
          proposalBody.continuation = args.continuation.map(function (node) {
            return Object.assign({}, node, { wires: Array.isArray(node.wires) ? node.wires.slice() : [] });
          });
        }
        try { response = await requestPost(NR_URL + dispatch.route.route, proposalBody, token); }
        catch (error) { return { error: "network error", parts: parts, writes: writes, transcript: transcript, finalText: "", action: outcomeAction(writes.length > 0, asked) }; }
        body = response.body || {};
        messages = Array.isArray(body.messages) ? body.messages.slice() : messages;
        stopped = false;
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
      let consentWasAsked = beforeGate.consent === "ask";
      if (consentWasAsked) {
        consentAsked = true;
        gate = corpus.evaluateWriteTool(call, parts.targetLock.ids, parts, state, ledger, { consentAccepted: true });
      }
      const record = { tool: name, args: clone(args), consent: consentWasAsked ? "ask" : "auto", diff: {
        pause: gate.diff.pause, reason: gate.diff.reason, touchedNodes: gate.diff.touchedNodes,
        outOfTargetNodes: gate.diff.outOfTargetNodes.map(clone)
      } };
      writes.push(record);
      transcript[transcript.length - 1].consent = record.consent;
      // Mirrors applyStepPrecheck (lib/core/main.js): node kinds the user
      // ruled out ("but no http or exec nodes") are refused before creation.
      const ruledOut = name === "apply_step" ? LIMITS.forbiddenNewNodes(args.newNodes, prompt) : [];
      const creationError = name === "apply_step"
        ? (corpus.creationFirstWriteError(args, creationState) || (ruledOut.length
          ? "The user ruled these out: " + ruledOut.map(function (f) { return f.type; }).join(", ") +
            ". Nothing from this step was created; send it again without them." : null)) : null;
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
        asked = true;
        stopped = true;
        break;
      }
      const beforeNodes = parts.nodes.map(clone);
      record.result = applyFuzzWrite(call, parts);
      transcript[transcript.length - 1].result = clone(record.result);
      // Every tool call gets its tool reply, as in the browser loop; a missing
      // one made the next step an OpenAI 400 ("tool_calls must be followed
      // by tool messages").
      messages = appendTool(messages, call, record.result);
      if (record.result && !record.result.noChange && !record.result.error) {
        record.graphTruth = graphDiff(beforeNodes, parts.nodes);
        graphTruth = mergeGraphTruth(graphTruth, record.graphTruth);
      }
      ledger = gate.ledger;
      recordLedgerIds(ledger).forEach(function (id) { state.createdNodeIds[id] = state.createdNodeIds[id] || false; });
      (args.newNodes || []).forEach(function (node) {
        if (node && node.id) { state.createdNodeIds[String(node.id)] = true; }
      });
      if (name === "apply_step") { creationState.firstWriteComplete = true; }
      if (record.result && record.result.error && !record.result.noChange) { asked = true; stopped = true; break; }
    }
    if (!stopped && calls.some(function (call) { return toolName(call) === "propose_action"; })) { continue; }
    if (stopped) { break; }
    if (steps >= MAX_STEPS) { asked = writes.length === 0; finalText = "Agent step budget exhausted"; break; }
    if (!await requestAgentStep()) {
      asked = writes.length === 0;
      if (!finalText) { finalText = "Agent step budget exhausted"; }
      break;
    }
  }
  const touchedIds = recordLedgerIds(ledger);
  const actualWrites = writes.filter(function (record) { return record.result && !record.result.noChange && !record.result.error; });
  if (parts.touchedIndex && graphTruth.nodeIds.length) {
    const run = parts.touchedIndex.beginRun();
    parts.touchedIndex.recordRun(graphTruth.nodeIds.map(function (id) { return { id: id }; }), run);
    parts.intake.touchedNodeIndex = parts.touchedIndex.snapshot();
  }
  return { parts: parts, writes: writes, transcript: transcript, finalText: finalText,
    action: outcomeAction(actualWrites.length > 0, asked), asked: asked, askedOptions: askedOptionsValue,
    wrote: actualWrites.length > 0, nodesAdded: parts.nodes.length, touchedIds: touchedIds,
    graphTruth: graphTruth, lane: lane, planShown: planShown, consentAsked: consentAsked, steps: steps, messages: messages,
    goalCheck: { checks: goalChecks, gaps: goalChecks.reduce(function (all, check) {
      return all.concat(check.gaps || []).filter(function (gap, index, list) { return list.indexOf(gap) === index; });
    }, []), fixAttempts: goalCheckFixAttempts, maxFixAttempts: MAX_GOAL_CHECK_FIX_ATTEMPTS } };
}

function goalCheckSummaryText(graph) {
  const nodes = (graph && graph.nodes) || [];
  const byId = {};
  nodes.forEach(function (node) { byId[node.id] = node; });
  const label = function (node) { return node ? node.type + (node.name ? " \"" + node.name + "\"" : "") : "(missing node)"; };
  const lines = nodes.filter(function (node) { return node.type !== "tab"; }).map(function (node) {
    const cfg = Object.keys(node.keyConfig || {}).filter(function (key) { return key[0] !== "_"; }).map(function (key) {
      let value = node.keyConfig[key];
      if (typeof value !== "string") { try { value = JSON.stringify(value); } catch (e) { value = String(value); } }
      return key + "=" + String(value).slice(0, 120);
    });
    return label(node) + (cfg.length ? " [" + cfg.join(", ") + "]" : "");
  });
  ((graph && graph.wires) || []).forEach(function (wire) {
    lines.push("wire: " + label(byId[wire.from]) + " -> " + label(byId[wire.to]));
  });
  return lines.join("\n") || "No nodes";
}

async function runPrompt(entry, token, options) {
  options = options || {};
  const originalFlow = loadFixture(entry.fixture);
  const initialNodeIds = new Set(originalFlow.filter(function (node) { return node && node.type !== "tab" && node.type !== "subflow"; }).map(function (node) { return node.id; }));
  let parts = makeParts(entry, entry.prompt, entry.selected);
  const turns = [];
  let first = await executeTurn(entry, entry.prompt, token, parts, { post: options.post });
  turns.push(first);
  parts = first.parts;
  if (entry.followUp) {
    parts = makeParts(entry, entry.followUp, [], parts);
    const history = [{ role: "user", content: entry.prompt }, { role: "assistant", content: first.finalText || "The requested change was applied." }];
    turns.push(await executeTurn(entry, entry.followUp, token, parts, { history: history, post: options.post }));
  }
  const last = turns[turns.length - 1];
  const writes = turns.reduce(function (all, turn) { return all.concat(turn.writes || []); }, []);
  const transcript = turns.reduce(function (all, turn) { return all.concat(turn.transcript || []); }, []);
  const touchedIds = turns.reduce(function (all, turn) { return all.concat(turn.touchedIds || []); }, [])
    .filter(function (id, index, list) { return list.indexOf(id) === index; });
  const graphTruth = turns.reduce(function (all, turn) { return mergeGraphTruth(all, turn.graphTruth); },
    { addedNodeIds: [], changedNodeIds: [], removedNodeIds: [], nodeIds: [] });
  const goalCheckTurns = turns.map(function (turn) { return turn.goalCheck; }).filter(function (check) {
    return check && check.checks && check.checks.length;
  });
  const goalCheck = {
    checks: goalCheckTurns.reduce(function (all, check) { return all.concat(check.checks); }, []),
    gaps: goalCheckTurns.reduce(function (all, check) { return all.concat(check.gaps || []); }, [])
      .filter(function (gap, index, all) { return all.indexOf(gap) === index; }),
    fixAttempts: goalCheckTurns.reduce(function (count, check) { return count + Number(check.fixAttempts || 0); }, 0),
    maxFixAttempts: 2
  };
  const wrote = writes.some(function (record) { return record.result && !record.result.noChange && !record.result.error; });
  const asked = turns.some(function (turn) { return turn.asked; });
  const lastAsked = turns.slice().reverse().find(function (turn) { return turn.asked; });
  const lastLane = turns.slice().reverse().find(function (turn) { return turn.lane; });
  const graph = { flow: currentFlow(parts) };
  const nodesAdded = graph.flow.filter(function (node) { return node && node.type !== "tab" && !initialNodeIds.has(node.id); }).length;
  return {
    id: entry.id, category: entry.category, fixture: entry.fixture, prompt: entry.prompt, followUp: entry.followUp,
    graph: graph, finalText: last.finalText || first.finalText || "", writes: writes, transcript: transcript,
    goalCheck: goalCheck,
    timings: { turns: turns.length, steps: turns.reduce(function (sum, turn) { return sum + (turn.steps || 0); }, 0) },
    actual: { wrote: wrote, nodesAdded: nodesAdded, touchedIds: touchedIds, addedNodeIds: (graphTruth && graphTruth.addedNodeIds) || [], action: outcomeAction(wrote, asked),
      askedOptions: lastAsked ? lastAsked.askedOptions : [], lane: lastLane && lastLane.lane,
      planShown: turns.some(function (turn) { return turn.planShown; }), graphTruth: graphTruth,
      consentAsked: turns.some(function (turn) { return turn.consentAsked; }) },
    error: turns.find(function (turn) { return turn.error; }) && turns.find(function (turn) { return turn.error; }).error
  };
}

module.exports = { runPrompt: runPrompt, getToken: getToken, loadFixture: loadFixture, post: post, NR_URL: NR_URL,
  routeForAction: routeForAction, proposalDispatch: proposalDispatch, outcomeAction: outcomeAction };
