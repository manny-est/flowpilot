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

    function runtimeNodeId(value) {
        return typeof value === "string" ? value : value && value.id;
    }

    function runtimeLinkId(value) {
        return runtimeNodeId(value);
    }

    // Select the ends of the path being checked, rather than every node that
    // happens to have an output. A debug/sink node has no output to tap, so
    // its incoming node (or the sink's own status/debug stream) represents
    // the goal instead.
    function runtimeGoalObserve(nodes, links, triggerId, explicitObserve) {
        var list = Array.isArray(nodes) ? nodes.filter(function (node) { return !!runtimeNodeId(node); }) : [];
        var byId = {};
        list.forEach(function (node) { byId[runtimeNodeId(node)] = node; });
        var edgeList = Array.isArray(links) ? links : [];
        var outgoing = {};
        var incoming = {};
        edgeList.forEach(function (link) {
            var from = runtimeLinkId(link && link.source) || (link && (link.from || link.sourceId));
            var to = runtimeLinkId(link && link.target) || (link && (link.to || link.targetId));
            if (!from || !to || !byId[from] || !byId[to]) { return; }
            (outgoing[from] || (outgoing[from] = [])).push(to);
            (incoming[to] || (incoming[to] = [])).push(from);
        });
        Object.keys(outgoing).forEach(function (id) {
            outgoing[id] = outgoing[id].filter(function (target, index, all) { return all.indexOf(target) === index; });
        });
        Object.keys(incoming).forEach(function (id) {
            incoming[id] = incoming[id].filter(function (source, index, all) { return all.indexOf(source) === index; });
        });

        var trigger = triggerId && byId[triggerId] ? triggerId : null;
        var reachable = {};
        if (trigger) {
            var queue = [trigger];
            reachable[trigger] = true;
            while (queue.length) {
                var current = queue.shift();
                (outgoing[current] || []).forEach(function (target) {
                    if (!reachable[target]) { reachable[target] = true; queue.push(target); }
                });
            }
        } else {
            list.forEach(function (node) { reachable[runtimeNodeId(node)] = true; });
        }

        var explicit = Array.isArray(explicitObserve) ? explicitObserve.map(function (item) {
            return runtimeNodeId(item && item.id ? item.id : item);
        }).filter(Boolean) : null;
        // Without a trigger, a node nothing feeds is a source, not a goal: an
        // isolated inject that fires on its own must not prove an unwired flow.
        var isGoalCandidate = function (id) {
            return !!trigger || list.length === 1 || (incoming[id] || []).length > 0;
        };
        var selected = explicit ? explicit.filter(function (id, index, all) {
            return reachable[id] && isGoalCandidate(id) && all.indexOf(id) === index;
        }) : Object.keys(reachable).filter(function (id) {
            return isGoalCandidate(id) && !(outgoing[id] || []).some(function (target) { return reachable[target]; });
        });
        // Nodes of the run the trigger never reaches are named, so a partly
        // wired flow doesn't read as a full success.
        // Comments, groups and config nodes never carry messages, so they're
        // never "not reached" (live round 3 S10 listed a comment).
        var PASSIVE_TYPES = { "comment": 1, "group": 1, "junction": 1 };
        var unreachedNames = trigger ? list.filter(function (node) {
            if (!node || PASSIVE_TYPES[node.type] || /(?:-broker|-config|-server|-client)$/.test(String(node.type || ""))) { return false; }
            return !reachable[runtimeNodeId(node)];
        }).map(function (node) { return node.name || node.type || runtimeNodeId(node); }) : [];

        // With a trigger, an unconnected trigger is a distinct honest result.
        var triggerHasPath = !trigger || (outgoing[trigger] || []).some(function (target) { return reachable[target]; });
        // A trigger alone proves nothing (its own output isn't the goal),
        // so an unconnected trigger is reported as such even on its own.
        if (trigger && !triggerHasPath) {
            return {
                observeIds: [], tapNodeIds: [], statusNodeIds: [], debugNodeIds: [],
                goalIds: [], goalNames: [], reachableIds: Object.keys(reachable),
                triggerId: trigger, triggerHasPath: false,
                noOutputReason: (byId[trigger].name || byId[trigger].type || trigger) + " isn't wired to anything"
            };
        }

        var tapNodeIds = [];
        var statusNodeIds = [];
        var debugNodeIds = [];
        var goalIds = [];
        var evidenceNodeNames = {};
        function addUnique(array, id) { if (id && array.indexOf(id) === -1) { array.push(id); } }
        selected.forEach(function (id) {
            var node = byId[id];
            if (!node) { return; }
            var outputCount = runtimeOutputCount(node);
            if (outputCount > 0 && id !== trigger) {
                addUnique(tapNodeIds, id);
                addUnique(goalIds, id);
                evidenceNodeNames[id] = node.name || node.type || id;
                return;
            }
            // Existing debug nodes can be used directly. Other terminal
            // zero-output nodes are observed through their status stream.
            if (node.type === "debug") { addUnique(debugNodeIds, id); }
            else { addUnique(statusNodeIds, id); }
            addUnique(goalIds, id);
            evidenceNodeNames[id] = node.name || node.type || id;
        });

        // A zero-output terminal's incoming wire is the only tap-able point
        // for nodes such as a function used as a sink. Do not turn a trigger
        // into a goal tap merely because it feeds a zero-output node.
        selected.forEach(function (id) {
            var node = byId[id];
            if (!node || runtimeOutputCount(node) > 0) { return; }
            (incoming[id] || []).forEach(function (source) {
                if (source !== trigger && reachable[source]) { addUnique(tapNodeIds, source); }
                if (source !== trigger && reachable[source] && !evidenceNodeNames[source]) {
                    evidenceNodeNames[source] = byId[source].name || byId[source].type || source;
                }
            });
        });

        return {
            observeIds: tapNodeIds.slice(),
            tapNodeIds: tapNodeIds,
            statusNodeIds: statusNodeIds,
            debugNodeIds: debugNodeIds,
            goalIds: goalIds,
            goalNames: goalIds.map(function (id) { return byId[id].name || byId[id].type || id; }),
            evidenceNodeNames: evidenceNodeNames,
            reachableIds: Object.keys(reachable),
            triggerId: trigger,
            triggerHasPath: triggerHasPath,
            unreachedNames: unreachedNames,
            noOutputReason: selected.length || !list.length ? null : "nothing in this flow is wired to an output"
        };
    }

    function runtimeDefaultObserve(nodes, outgoingByNode, triggerId) {
        var links = [];
        Object.keys(outgoingByNode || {}).forEach(function (source) {
            (outgoingByNode[source] || []).forEach(function (target) {
                links.push({ source: { id: source }, target: { id: runtimeNodeId(target) || target } });
            });
        });
        return runtimeGoalObserve(nodes, links, triggerId, null).tapNodeIds;
    }

    // Only a message from one of this run's taps is debug evidence. Status is
    // deliberately narrower too: it may come from a node the run created or
    // changed, never from an unrelated node that happened to report status.
    function runtimeEvidenceForRun(evidence, tapIds, statusIds, debugIds) {
        var taps = tapIds || {};
        var statuses = statusIds || {};
        var debugs = debugIds || {};
        return (Array.isArray(evidence) ? evidence : []).filter(function (entry) {
            if (!entry) { return false; }
            if (entry.kind === "debug") { return !!(entry.nodeId && (taps[entry.nodeId] || debugs[entry.nodeId])); }
            if (entry.kind === "status") { return !!(entry.nodeId && statuses[entry.nodeId]); }
            return false;
        });
    }

    function runtimeFormatObservedValue(value, valueType) {
        if (valueType === "object" || (value && typeof value === "object")) {
            try { return JSON.stringify(value); } catch (e) { return String(value); }
        }
        return value === undefined || value === null ? "" : String(value);
    }

    function runtimeProofOutcome(evidence, goal) {
        goal = goal || {};
        if (Array.isArray(evidence) && evidence.length) {
            var last = evidence[evidence.length - 1] || {};
            var value = runtimeFormatObservedValue(last.value, last.valueType);
            var node = goal.evidenceNodeNames && goal.evidenceNodeNames[last.nodeId] ||
                last.node || last.name || goal.goalNames && goal.goalNames[0] || "goal";
            var unreached = goal.unreachedNames && goal.unreachedNames.length
                ? " · not reached: " + goal.unreachedNames.join(", ") : "";
            return { state: "observed", label: "Run: observed — " + value + " (at " + node + ")" + unreached,
                observedValue: value, observedNode: node, unreachedNames: goal.unreachedNames || [] };
        }
        var reason = goal.noOutputReason || (goal.goalNames && goal.goalNames.length
            ? "no output reached " + goal.goalNames.join(" or ") : "no runtime output was observed");
        if (goal.noOutputReason || goal.state === "no-output" || (goal.goalNames && goal.goalNames.length)) {
            return { state: "no-output", label: "Ran, but " + reason, note: "Ran, but " + reason };
        }
        return { state: "not-observable", label: "Run: not observable here — " + reason, note: reason };
    }

    function runtimeBuildCanConverge(lastVerify, goalMet) {
        return !!(lastVerify && lastVerify.state === "observed" && lastVerify.evidenceCount && goalMet === true);
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
            runtimeGoalObserve: runtimeGoalObserve,
            runtimeDefaultObserve: runtimeDefaultObserve,
            runtimeEvidenceForRun: runtimeEvidenceForRun,
            runtimeFormatObservedValue: runtimeFormatObservedValue,
            runtimeProofOutcome: runtimeProofOutcome,
            runtimeBuildCanConverge: runtimeBuildCanConverge,
            runtimeDeployConsent: runtimeDeployConsent
        };
    }
