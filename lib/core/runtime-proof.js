    // SF-8 runtime proof primitives. The editor loop owns the live RED.*
    // operations; these helpers keep identity and consent decisions small,
    // deterministic, and testable without a browser.

    // A tap's run id. Node-RED exports only a node type's declared defaults,
    // so the in-memory fpTap tag is dropped by deploy and reload. The saved
    // copy lives in the debug node's statusVal ("fp-tap:<runId>"), which the
    // runtime ignores while tostatus is false. Cleanup-on-load depends on it.
    var FP_TAP_STATUS_PREFIX = "fp-tap:";

    function runtimeTapRunId(node) {
        if (!node) { return null; }
        if (typeof node.fpTap === "string" && node.fpTap) { return node.fpTap; }
        if (node.type === "debug" && typeof node.statusVal === "string" &&
            node.statusVal.indexOf(FP_TAP_STATUS_PREFIX) === 0 && node.statusVal.length > FP_TAP_STATUS_PREFIX.length) {
            return node.statusVal.slice(FP_TAP_STATUS_PREFIX.length);
        }
        return null;
    }

    function isFlowPilotTap(node) {
        return !!runtimeTapRunId(node);
    }

    function runtimeTapIdSet(nodes, runId) {
        var ids = {};
        (Array.isArray(nodes) ? nodes : []).forEach(function (node) {
            if (node && node.id && runtimeTapRunId(node) === runId) { ids[node.id] = true; }
        });
        return ids;
    }

    function runtimeOutputCount(node) {
        if (!node || node.type === "group") { return 0; }
        if (typeof node.outputs === "number") { return node.outputs; }
        return node._def && typeof node._def.outputs === "number" ? node._def.outputs : 1;
    }

    function runtimeDefaultObserve(nodes, outgoingByNode) {
        var result = [];
        (Array.isArray(nodes) ? nodes : []).forEach(function (node) {
            if (!node || !node.id || runtimeOutputCount(node) < 1) { return; }
            var outgoing = outgoingByNode && outgoingByNode[node.id];
            if (!outgoing || !outgoing.length) { result.push(node.id); }
        });
        return result;
    }

    // Only a message from one of this run's taps is debug evidence. Status is
    // deliberately narrower too: it may come from a node the run created or
    // changed, never from an unrelated node that happened to report status.
    function runtimeEvidenceForRun(evidence, tapIds, statusIds) {
        var taps = tapIds || {};
        var statuses = statusIds || {};
        return (Array.isArray(evidence) ? evidence : []).filter(function (entry) {
            if (!entry) { return false; }
            if (entry.kind === "debug") { return !!(entry.nodeId && taps[entry.nodeId]); }
            if (entry.kind === "status") { return !!(entry.nodeId && statuses[entry.nodeId]); }
            return false;
        });
    }

    // Restricted mode is a hard refusal. Otherwise a deploy is silent when
    // there are no user-owned undeployed edits, unless the approved plan has
    // explicitly covered deploy. An undefined count means the caller has not
    // done the editor-side accounting yet and retains the conservative ask.
    function runtimeDeployConsent(ownEdits, planApproved, restricted) {
        if (restricted === true) { return "restricted"; }
        if (planApproved === true) { return "auto"; }
        if (typeof ownEdits !== "number" || ownEdits < 0) { return "ask"; }
        return ownEdits > 0 ? "ask" : "auto";
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            isFlowPilotTap: isFlowPilotTap,
            runtimeTapRunId: runtimeTapRunId,
            FP_TAP_STATUS_PREFIX: FP_TAP_STATUS_PREFIX,
            runtimeTapIdSet: runtimeTapIdSet,
            runtimeOutputCount: runtimeOutputCount,
            runtimeDefaultObserve: runtimeDefaultObserve,
            runtimeEvidenceForRun: runtimeEvidenceForRun,
            runtimeDeployConsent: runtimeDeployConsent
        };
    }
