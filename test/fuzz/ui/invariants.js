"use strict";

const INVARIANT_NAMES = [
  "idle-controls",
  "console-errors",
  "chat-safety",
  "live-controls",
  "cards-agree-with-canvas",
  "no-overlapping-nodes",
  "no-duplicates",
  "popout-conversation",
  "reload-restores",
  "touched-nodes-valid"
];

// This function intentionally contains its helpers so its source can be sent
// directly to OpenClaw's in-page evaluator. The only network read it makes is
// the editor-authenticated GET /flows through the editor's own $.ajax.
async function evaluateInPage(expected, injected) {
  const wanted = expected || {};
  const page = injected || {
    document: globalThis.document,
    RED: globalThis.RED,
    $: globalThis.$,
    consoleErrors: globalThis.__fpFuzzConsoleErrors || [],
    touchedNodeIds: globalThis.__fpFuzzTouchedNodeIds || []
  };
  const doc = page.document;
  const red = page.RED || {};
  const get = id => doc && doc.getElementById ? doc.getElementById(id) : null;
  const all = selector => {
    if (!doc || !doc.querySelectorAll) return [];
    const found = doc.querySelectorAll(selector);
    return Array.prototype.slice.call(found || []);
  };
  const visible = element => !!element && element.offsetParent !== null && !element.disabled;
  const text = element => String(element && (element.innerText || element.textContent || "") || "");
  const messagesFromDom = () => all("#fp-messages > *").map((element, index) => ({
    id: element.getAttribute && (element.getAttribute("data-fp-record-id") || element.id) || "dom-" + index,
    text: text(element).replace(/\s+/g, " ").trim()
  }));
  const messageList = page.messages || messagesFromDom();
  const nodeList = red.nodes && typeof red.nodes.filterNodes === "function"
    ? (red.nodes.filterNodes({ z: red.nodes.workspace && red.nodes.workspace.id }) || [])
    : (page.nodes || []);
  let deployedFlows = page.deployedFlows;
  if (deployedFlows === undefined && page.$ && typeof page.$.ajax === "function" && wanted.fetchFlows !== false) {
    deployedFlows = await new Promise(resolve => {
      let finished = false;
      const done = value => { if (!finished) { finished = true; resolve(value); } };
      try {
        page.$.ajax({ url: "flows", method: "GET", type: "GET", success: done, error: () => done(null) });
      } catch (error) { done(null); }
    });
  }
  deployedFlows = Array.isArray(deployedFlows) ? deployedFlows : [];
  const nodeIds = new Set(nodeList.map(node => String(node.id)));
  const touchedIds = new Set(((wanted.touchedNodeIds !== undefined ? wanted.touchedNodeIds : page.touchedNodeIds) || []).map(String));
  const violations = [];
  const evidence = {};
  const report = (name, bad, detail) => {
    evidence[name] = detail;
    if (bad) violations.push({ invariant: name, message: detail.message, evidence: detail });
  };

  const send = get("fp-send");
  const prompt = get("fp-prompt");
  const working = get("fp-working-status");
  const stopButtons = all("#fp-root button.fp-working-stop").filter(visible);
  const idle = stopButtons.length === 0;
  const placeholder = String(prompt && prompt.placeholder || "");
  const normalPlaceholder = placeholder.length > 0 && !/(working|loading|error|stack)/i.test(placeholder);
  report("idle-controls", idle && (!send || send.disabled || !normalPlaceholder || (working && working.offsetParent !== null)), {
    message: idle ? "idle controls are not ready" : "run is active",
    idle, sendEnabled: !!send && !send.disabled, placeholder, workingVisible: !!working && working.offsetParent !== null
  });

  const consoleErrors = Array.isArray(wanted.consoleErrors) ? wanted.consoleErrors :
    (Array.isArray(page.consoleErrors) ? page.consoleErrors : []);
  report("console-errors", consoleErrors.length > 0, {
    message: consoleErrors.length ? "FlowPilot console errors were reported" : "no FlowPilot console errors",
    errors: consoleErrors.slice(0, 20)
  });

  const allChatText = messageList.map(item => String(item.text || "")).join("\n");
  const rawHtml = /<[^>]+>/.test(allChatText);
  const rawJson = /\{\s*["'][^}]+["']\s*:/.test(allChatText);
  const stackTrace = /(Error:|TypeError:|ReferenceError:|at [^\n]+\([^\n]+\))/i.test(allChatText);
  const visibleNodeId = nodeList.some(node => node.id && allChatText.indexOf(String(node.id)) !== -1);
  const internalText = /(data-fp-record|propose-act|agentTool|tool_call|internal error|stack trace)/i.test(allChatText);
  report("chat-safety", rawHtml || rawJson || stackTrace || visibleNodeId || internalText, {
    message: "chat contains internal or raw provider output",
    rawHtml, rawJson, stackTrace, visibleNodeId, internalText
  });

  const liveButtons = all("#fp-messages button[data-fp-record-action]").filter(element => {
    if (!visible(element)) return false;
    const ownerText = text(element.parentNode);
    const state = element.getAttribute && element.getAttribute("data-fp-state");
    return state === "answered" || state === "approved" || /approved|answered/i.test(ownerText);
  });
  const settledChips = all("#fp-messages .fp-question-row button").filter(element => visible(element) && /✓/.test(text(element)));
  report("live-controls", liveButtons.length > 0 || settledChips.length > 0, {
    message: liveButtons.length || settledChips.length ? "an answered or approved control remains live" : "answered and approved controls are inert",
    controls: liveButtons.concat(settledChips).map(text)
  });

  const cards = page.cards || all(".fp-result-card").map(card => {
    let ids = [];
    try { ids = JSON.parse(card.getAttribute("data-fp-node-ids") || "[]"); } catch (error) { ids = []; }
    return { nodeIds: ids, deployed: card.getAttribute("data-fp-deployed") === "true" };
  });
  const deployedIds = new Set(deployedFlows.map(flow => String(flow.id)));
  const badCard = cards.some(card => (card.nodeIds || []).some(id => !nodeIds.has(String(id)) || (card.deployed && !deployedIds.has(String(id)))));
  report("cards-agree-with-canvas", badCard, {
    message: badCard ? "a result card disagrees with editor/runtime truth" : "result cards agree with editor/runtime truth",
    cards, editorNodeIds: Array.from(nodeIds), deployedNodeIds: Array.from(deployedIds)
  });

  const geometryNodes = nodeList.filter(node => !touchedIds.size || touchedIds.has(String(node.id)));
  const overlaps = [];
  const bounds = node => ({
    left: Number(node.x || 0) - Number(node.w || 100) / 2,
    right: Number(node.x || 0) + Number(node.w || 100) / 2,
    top: Number(node.y || 0) - Number(node.h || 30) / 2,
    bottom: Number(node.y || 0) + Number(node.h || 30) / 2
  });
  for (let i = 0; i < geometryNodes.length; i += 1) {
    for (let j = i + 1; j < geometryNodes.length; j += 1) {
      const a = bounds(geometryNodes[i]);
      const b = bounds(geometryNodes[j]);
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
        overlaps.push([geometryNodes[i].id, geometryNodes[j].id]);
      }
    }
  }
  report("no-overlapping-nodes", overlaps.length > 0, {
    message: overlaps.length ? "FlowPilot-touched nodes overlap" : "FlowPilot-touched nodes do not overlap",
    overlaps
  });

  const seenIds = new Set();
  const duplicateMessages = [];
  messageList.forEach(item => {
    const key = String(item.id || "") + "\u0000" + String(item.text || "");
    if (seenIds.has(key)) duplicateMessages.push(key);
    seenIds.add(key);
  });
  report("no-duplicates", duplicateMessages.length > 0, {
    message: duplicateMessages.length ? "duplicate cards or messages are visible" : "no duplicate cards or messages",
    duplicates: duplicateMessages
  });

  const sameMessages = (left, right) => JSON.stringify((left || []).map(item => ({ id: item.id, text: item.text }))) ===
    JSON.stringify((right || []).map(item => ({ id: item.id, text: item.text })));
  const popoutMessages = wanted.popoutMessages !== undefined ? wanted.popoutMessages : page.popoutMessages;
  const popoutMismatch = popoutMessages !== undefined && !sameMessages(messageList, popoutMessages);
  report("popout-conversation", popoutMismatch, {
    message: popoutMismatch ? "main and pop-out conversations differ" : "main and pop-out conversations match",
    main: messageList, popout: popoutMessages === undefined ? null : popoutMessages
  });

  const reloadMessages = wanted.reloadMessages !== undefined ? wanted.reloadMessages : page.reloadMessages;
  const reloadMismatch = wanted.afterReload === true && reloadMessages !== undefined && !sameMessages(messageList, reloadMessages);
  report("reload-restores", reloadMismatch, {
    message: reloadMismatch ? "reload did not restore the visible conversation" : "reload restored the visible conversation",
    before: reloadMessages === undefined ? null : reloadMessages, after: messageList
  });

  const invalid = nodeList.filter(node => touchedIds.has(String(node.id)) && node.valid === false).map(node => node.id);
  report("touched-nodes-valid", invalid.length > 0, {
    message: invalid.length ? "a FlowPilot-touched node is invalid" : "all FlowPilot-touched nodes are valid",
    invalid
  });
  return { violations, evidence };
}

function buildInPageEvaluator(expected) {
  return "(" + evaluateInPage.toString() + ")(" + JSON.stringify(expected || {}) + ")";
}

module.exports = {
  INVARIANT_NAMES,
  buildInPageEvaluator,
  evaluateInPage
};
