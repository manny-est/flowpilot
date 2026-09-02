"use strict";

// ---------------------------------------------------------------------
// The agent-strategy contract: a "strategy":"agent" turn is only ever
// allowed to mutate the flow via a WRITE tool call, never via the classic
// JSON-envelope mutation fields (changes/newNodes/newWires/removeNodes/
// newGroups for Modify; flow for Generate/Document/Build — Generate's own
// envelope shape uses "flow", not "newNodes"/"newWires", found live during
// the 0.6.0 FINISH-list pass: the field was missing from this list entirely,
// so an agent-strategy Generate final turn with no tool calls could emit a
// full flow array completely unprotected). If a model still emits those
// fields on a turn that made no tool calls, strip them before the response
// reaches the client and log
// what was stripped — the two mutation code paths (classic envelope vs.
// agentic WRITE tools) must stay mutually exclusive per agent turn.
// Classic-strategy turns and turns that DID make tool calls are untouched
// by design (guard clause below) — this only fires on the one contract-
// violating shape it exists to catch.
// ---------------------------------------------------------------------

const AGENT_MUTATION_FIELDS = ["changes", "newNodes", "newWires", "removeNodes", "newGroups", "flow"];

function enforceAgentContract(result, execution, hasToolCalls) {
  if (!result || !execution || execution.strategy !== "agent" || hasToolCalls) {
    return result;
  }

  const strippedFields = [];
  const counts = {};
  AGENT_MUTATION_FIELDS.forEach(function (field) {
    if (!Object.prototype.hasOwnProperty.call(result, field)) { return; }
    strippedFields.push(field);
    counts[field] = Array.isArray(result[field]) ? result[field].length : 1;
    delete result[field];
  });

  if (strippedFields.length) {
    result.strippedFields = strippedFields;
    console.warn(
      "[FlowPilot] agent contract stripped mutation fields strategy=%s entry=%s conversationId=%s counts=%s",
      execution.strategy,
      execution.entry,
      execution.conversationId || "none",
      JSON.stringify(counts)
    );
  }
  return result;
}

module.exports = { enforceAgentContract, AGENT_MUTATION_FIELDS };
