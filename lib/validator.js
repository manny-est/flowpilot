"use strict";

// W2 — Class A validator / repair layer.
//
// Rules that are mechanically checkable or repairable belong here, not in
// the model's attention budget. For each repair implemented, the
// corresponding prompt rule is deleted or shortened in the same commit —
// the win is measured in prompt shrinkage + corpus improvement, not in
// code added.
//
// Server-side mirror of the client-side DIFF_SKIP in apply-review.js.
// When a field appears here, it is stripped from changes[].set before
// the diff reaches the client (rule A6). Keep this list in sync with
// DIFF_SKIP in apply-review.js.
const DIFF_SKIP_SERVER = {
  // Appearance-tab metadata (all node types)
  info: 1, inputLabels: 1, outputLabels: 1, icon: 1,
  // debug node display flags
  console: 1, tostatus: 1, targetType: 1, statusVal: 1, statusType: 1,
  // function node internal flags
  noerr: 1, initialize: 1, finalize: 1,
  // mqtt in/out retain handling
  rh: 1
};

// A1: missing wires on a non-comment node → inject [].
// A2: comment node with non-empty wires → force empty.
// A3: x/y/z present on a node → strip (editor handles placement).
// A4: tab/subflow type → remove from array entirely.
function repairFlowNodes(nodes, repairs) {
  if (!Array.isArray(nodes)) { return nodes; }
  const out = [];
  nodes.forEach(function (n) {
    if (!n || typeof n !== "object") { return; }

    // A4: reject tab/subflow — editor types, not importable nodes
    if (n.type === "tab" || n.type === "subflow") {
      repairs.push({ rule: "A4", detail: "removed " + n.type + " node id=" + (n.id || "?") });
      return;
    }

    const fixed = Object.assign({}, n);

    // A3: strip x/y/z (editor assigns positions on import; if present
    // they cause nodes to pile up at exact coordinates instead of
    // being auto-arranged)
    const stripped = [];
    ["x", "y", "z"].forEach(function (k) {
      if (k in fixed) { delete fixed[k]; stripped.push(k); }
    });
    if (stripped.length) {
      repairs.push({ rule: "A3", detail: "stripped " + stripped.join(",") + " from id=" + (n.id || "?") });
    }

    if (n.type === "comment") {
      // A2: comment nodes are passive annotations — wires must be empty
      if (Array.isArray(n.wires) && n.wires.some(function (p) { return Array.isArray(p) && p.length > 0; })) {
        fixed.wires = [];
        repairs.push({ rule: "A2", detail: "forced wires:[] on comment id=" + (n.id || "?") });
      } else if (!Array.isArray(n.wires)) {
        fixed.wires = [];
      }
    } else {
      // A1: every non-comment node must have a wires array
      if (!Array.isArray(n.wires)) {
        fixed.wires = [];
        repairs.push({ rule: "A1", detail: "injected wires:[] on id=" + (n.id || "?") + " type=" + (n.type || "?") });
      }
    }

    out.push(fixed);
  });
  return out;
}

// A5: http-request node headers in {key, value} shape → transform to
// {keyType, keyValue, valueType, valueValue}. The flat shape is silently
// ignored by Node-RED; the editor uses the keyed shape exclusively.
function repairHttpHeaders(headers) {
  if (!Array.isArray(headers)) { return headers; }
  return headers.map(function (h) {
    if (h && typeof h === "object" &&
        "key" in h && "value" in h &&
        !("keyType" in h)) {
      return {
        keyType: "other", keyValue: String(h.key || ""),
        valueType: "other", valueValue: String(h.value || "")
      };
    }
    return h;
  });
}

// A6: forbidden fields in changes[].set → strip (server-side DIFF_SKIP).
// A7: group inside set → strip (group membership changes via newGroups only).
// A8: http-request headers {key,value} shape → transform.
// A9: same id in changes AND removeNodes → drop from changes.
//
// Note: redaction-placeholder stripping (formerly A8 in planning notes)
// was implemented as W0.2 (stripRedactionPlaceholders in flowpilot.js)
// and runs after this function — no duplication needed here.
function repairChanges(changes, removeNodes, repairs) {
  if (!Array.isArray(changes)) { return changes; }
  const removeSet = new Set(Array.isArray(removeNodes) ? removeNodes : []);

  return changes.filter(function (entry) {
    if (!entry || typeof entry !== "object") { return false; }
    // A9: id appears in both changes and removeNodes — removeNodes wins
    if (entry.id && removeSet.has(entry.id)) {
      repairs.push({ rule: "A9", detail: "dropped id=" + entry.id + " from changes (also in removeNodes)" });
      return false;
    }
    return true;
  }).map(function (entry) {
    if (!entry.set || typeof entry.set !== "object") { return entry; }
    const cleanSet = {};
    const droppedA6 = [];
    let droppedGroup = false;

    Object.keys(entry.set).forEach(function (k) {
      // A6: forbidden internal fields
      if (DIFF_SKIP_SERVER[k]) { droppedA6.push(k); return; }
      // A7: group is informational context, not settable via changes
      if (k === "group") { droppedGroup = true; return; }

      let v = entry.set[k];
      // A5: http-request node headers on the modify path
      if (k === "headers") { v = repairHttpHeaders(v); }

      cleanSet[k] = v;
    });

    if (droppedA6.length) {
      repairs.push({ rule: "A6", detail: "stripped " + droppedA6.join(",") + " from set on id=" + entry.id });
    }
    if (droppedGroup) {
      repairs.push({ rule: "A7", detail: "stripped group from set on id=" + entry.id });
    }

    return Object.assign({}, entry, { set: cleanSet });
  });
}

// Switch rules/wires mismatch — detect, do not repair. The rule
// alignment is a semantic contract (rules[i] corresponds to output port
// i); auto-repairing the wrong choice would silently misroute messages.
// Instead, surface as a targeted retry so the model sees exactly what's
// wrong and can fix it in one shot.
// Returns an array of { id, rulesLen, wiresLen } — empty when all clean.
function detectSwitchMismatches(changes) {
  const mismatches = [];
  (Array.isArray(changes) ? changes : []).forEach(function (entry) {
    if (!entry || !entry.set) { return; }
    const rules = entry.set.rules;
    const wires = entry.set.wires;
    if (Array.isArray(rules) && Array.isArray(wires) && rules.length !== wires.length) {
      mismatches.push({ id: entry.id, rulesLen: rules.length, wiresLen: wires.length });
    }
  });
  return mismatches;
}

// Top-level entry point. Takes a parsed envelope object and returns:
//   { envelope, repairs, switchMismatches }
//
// - envelope: repaired copy (original not mutated)
// - repairs: array of { rule, detail } for each repair applied
// - switchMismatches: array of { id, rulesLen, wiresLen } for switch
//   nodes whose rules/wires arrays have different lengths (targeted retry
//   candidates — callers surface these as skippedNotes or 422 bounces)
function repairEnvelope(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return { envelope: parsed, repairs: [], switchMismatches: [] };
  }

  const repairs = [];
  const out = Object.assign({}, parsed);

  // Flow array (Generate/Build): A1, A2, A3, A4
  if (Array.isArray(out.flow)) {
    out.flow = repairFlowNodes(out.flow, repairs);
  }

  // newNodes (Modify): A1, A2, A3, A4
  if (Array.isArray(out.newNodes)) {
    out.newNodes = repairFlowNodes(out.newNodes, repairs);
  }

  // changes (Modify): A5, A6, A7, A9
  if (Array.isArray(out.changes)) {
    out.changes = repairChanges(out.changes, out.removeNodes, repairs);
  }

  // Switch alignment check (detect only, not repair)
  const switchMismatches = detectSwitchMismatches(out.changes);

  return { envelope: out, repairs: repairs, switchMismatches: switchMismatches };
}

module.exports = {
  repairEnvelope: repairEnvelope,
  repairFlowNodes: repairFlowNodes,
  repairChanges: repairChanges,
  detectSwitchMismatches: detectSwitchMismatches,
  DIFF_SKIP_SERVER: DIFF_SKIP_SERVER
};
