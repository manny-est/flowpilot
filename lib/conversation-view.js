"use strict";

// Pure data helpers shared by the conversation persistence tests and the
// browser/server boundary. Functions are deliberately free of DOM and RED
// dependencies so a saved view can be checked before it is rendered.

const VIEW_RECORD_KINDS = new Set(["chat", "chip", "question", "review", "todo", "buildStep"]);

function cloneJson(value) {
  if (value === undefined) { return undefined; }
  return JSON.parse(JSON.stringify(value));
}

function serializableRecord(record) {
  if (!record || typeof record !== "object" || !VIEW_RECORD_KINDS.has(record.kind)) {
    return null;
  }
  return cloneJson(record);
}

function serializeVisibleRecords(records) {
  return (Array.isArray(records) ? records : [])
    .map(serializableRecord)
    .filter(Boolean);
}

function restoreVisibleView(view) {
  const records = serializeVisibleRecords(view && view.records);
  return { records };
}

function transcriptUserText(prompt, transcriptPrompt, fromAct) {
  if (fromAct && transcriptPrompt && String(transcriptPrompt).trim()) {
    return String(transcriptPrompt).trim();
  }
  return prompt && String(prompt).trim() ? String(prompt).trim() : null;
}

function referencedNodeIds(records) {
  const ids = new Set();
  function add(value) {
    if (!value) { return; }
    if (typeof value === "string") { ids.add(value); return; }
    if (Array.isArray(value)) { value.forEach(add); return; }
    if (typeof value !== "object") { return; }
    if (value.id && typeof value.id === "string") { ids.add(value.id); }
  }
  (Array.isArray(records) ? records : []).forEach(function (record) {
    if (!record || typeof record !== "object") { return; }
    add(record.nodeIds);
    add(record.changedNodes);
    add(record.targetLock && record.targetLock.ids);
    add(record.continuation);
    const proposal = record.proposeAction;
    if (proposal) {
      add(proposal.targets);
      add(proposal.continuation);
    }
    if (record.args) { add(record.args.nodeId); add(record.args.nodeIds); }
  });
  return Array.from(ids);
}

function missingReferencedNodeIds(records, nodeLookup) {
  return referencedNodeIds(records).filter(function (id) {
    return typeof nodeLookup !== "function" || !nodeLookup(id);
  });
}

function invalidDeployNodes(nodes, configNodes) {
  const all = [];
  (Array.isArray(nodes) ? nodes : []).concat(Array.isArray(configNodes) ? configNodes : [])
    .forEach(function (node) {
      if (node && node.valid === false && all.indexOf(node) === -1) { all.push(node); }
    });
  return all;
}

function deployValidationMessage(nodes) {
  const invalid = Array.isArray(nodes) ? nodes : [];
  if (!invalid.length) { return ""; }
  const labels = invalid.map(function (node) {
    return JSON.stringify(node.name || "(unnamed)") + " (" + (node.type || "unknown") + ")";
  }).join(", ");
  return "Can't deploy yet: Node-RED reports " + invalid.length +
    " node" + (invalid.length === 1 ? "" : "s") +
    " as not properly configured: " + labels +
    ". Fix them, or remove them, and try again.";
}

module.exports = {
  deployValidationMessage,
  invalidDeployNodes,
  missingReferencedNodeIds,
  referencedNodeIds,
  restoreVisibleView,
  serializeVisibleRecords,
  transcriptUserText
};
