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
            // Another start node (an inject nothing feeds) is its own entry
            // point, not a part this trigger failed to reach (live round 3
            // Spark S10: "not reached: Heartbeat (10 Hz)").
            var nodeId = runtimeNodeId(node);
            if (node.type === "inject" && !(incoming[nodeId] || []).length) { return false; }
            return !reachable[nodeId];
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

    // Node-RED's comms send an Error as {"__enc__":true,"type":"error",
    // "data":{name,message,stack}} (often as a JSON string). Shown raw, a
    // result card printed that JSON and the stack (QA pass 4, exploratory:
    // "Call localhost:9 (http request) threw: {"__enc__":true,…"). Only the
    // error's message is user-facing; the stack never is.
    function runtimeProofDecodeError(value, depth) {
        if ((depth || 0) > 3 || value === undefined || value === null) { return value; }
        if (typeof value === "string") {
            var trimmed = value.trim();
            if (trimmed.charAt(0) !== "{") { return value; }
            try { return runtimeProofDecodeError(JSON.parse(trimmed), (depth || 0) + 1); } catch (e) { return value; }
        }
        if (typeof value !== "object") { return value; }
        if (value.__enc__ === true && value.type === "error" && value.data) {
            return runtimeProofDecodeError(value.data, (depth || 0) + 1);
        }
        if (typeof value.message === "string" && value.message) {
            return (value.name && value.name !== "Error" ? value.name + ": " : "") + value.message;
        }
        if (value.error !== undefined) { return runtimeProofDecodeError(value.error, (depth || 0) + 1); }
        // An error with an empty message (got's RequestError for ECONNREFUSED)
        // still reads as name and code, never as the object and its stack
        // (QA pass 4c, exploratory: the whole object and stack were shown).
        if (value.code || value.name || value.stack || value.cause) {
            var parts = [];
            if (value.name && value.name !== "Error") { parts.push(String(value.name)); }
            if (value.code) { parts.push(String(value.code)); }
            if (!parts.length && typeof value.cause === "string") { parts.push(value.cause); }
            return parts.length ? parts.join(": ") : "node reported an error";
        }
        return value;
    }

    function runtimeProofMessageText(value) {
        value = runtimeProofDecodeError(value, 0);
        if (value === undefined || value === null) { return ""; }
        if (typeof value === "object") {
            try { value = JSON.stringify(value); } catch (e) { value = String(value); }
        }
        return String(value).split(/\r?\n/)[0].trim();
    }

    function runtimeProofNodeId(msg) {
        if (!msg) { return null; }
        if (typeof msg.id === "string" && msg.id) { return msg.id; }
        if (typeof msg.nodeId === "string" && msg.nodeId) { return msg.nodeId; }
        return msg.source && typeof msg.source.id === "string" ? msg.source.id : null;
    }

    function runtimeProofNodeInfo(nodeId, options, message) {
        var info = options && options.nodeInfo;
        info = typeof info === "function" ? info(nodeId) : info && info[nodeId];
        info = info || {};
        return {
            name: info.name || message && message.name || nodeId || "unknown node",
            type: info.type || message && message.type || "node"
        };
    }

    // A proof has its own short-lived comms subscription. The sidebar's
    // permanent debug subscription is for user-attached context; it must not
    // decide whether this run failed, and it cannot be used to guarantee that
    // an unrelated status/error was outside this run's evidence window.
    function createRuntimeProofObserver(red, options) {
        options = options || {};
        var touched = {};
        (Array.isArray(options.touchedIds) ? options.touchedIds : Object.keys(options.touchedIds || {})).forEach(function (id) {
            if (id) { touched[id] = true; }
        });
        var errors = {};
        var statuses = {};
        var lastOutput = null;
        var subscribed = false;

        function safeMessageText(value) {
            if (typeof options.redact === "function") {
                try { value = options.redact(value, undefined); } catch (e) { /* keep the proof alive */ }
            }
            return runtimeProofMessageText(value);
        }

        function errorFor(nodeId, message, fallback) {
            var info = runtimeProofNodeInfo(nodeId, options, message);
            var text = safeMessageText(fallback || message && (message.msg || message.message || message.error || message.text));
            if (!text) { text = "node reported an error"; }
            if (!errors[nodeId]) {
                errors[nodeId] = { nodeId: nodeId, nodeName: info.name, nodeType: info.type, message: text, count: 0 };
            }
            errors[nodeId].count += 1;
        }

        function onDebug(topic, message) {
            var nodeId = runtimeProofNodeId(message);
            if (!nodeId || !touched[nodeId]) { return; }
            if (Number(message && message.level) === 20) {
                errorFor(nodeId, message);
                return;
            }
            var info = runtimeProofNodeInfo(nodeId, options, message);
            var value = message && (message.msg !== undefined ? message.msg : message.payload);
            lastOutput = { nodeId: nodeId, nodeName: info.name, value: safeMessageText(value), at: Date.now() };
        }

        function onStatus(topic, message) {
            var parts = String(topic || "").split("/");
            var nodeId = parts[0] === "status" ? parts[1] : null;
            if (!nodeId || !touched[nodeId] || !message) { return; }
            var info = runtimeProofNodeInfo(nodeId, options, message);
            statuses[nodeId] = {
                nodeId: nodeId, nodeName: info.name, nodeType: info.type,
                fill: message.fill || "", shape: message.shape || "", text: message.text || "",
                at: Date.now()
            };
            if (message.fill === "red") {
                errorFor(nodeId, message, message.text || "red status");
            }
        }

        function subscribe() {
            if (subscribed || !red || !red.comms) { return; }
            red.comms.subscribe("debug", onDebug);
            red.comms.subscribe("status/#", onStatus);
            subscribed = true;
        }

        function unsubscribe() {
            if (!subscribed || !red || !red.comms) { return; }
            red.comms.unsubscribe("debug", onDebug);
            red.comms.unsubscribe("status/#", onStatus);
            subscribed = false;
        }

        function reset() {
            errors = {};
            statuses = {};
            lastOutput = null;
        }

        return {
            subscribe: subscribe,
            unsubscribe: unsubscribe,
            reset: reset,
            snapshot: function () {
                return {
                    errors: Object.keys(errors).map(function (id) { return errors[id]; }),
                    statuses: Object.keys(statuses).map(function (id) { return statuses[id]; }),
                    lastOutput: lastOutput
                };
            }
        };
    }

    // Common network failures in plain words, with the code kept in brackets
    // (QA pass 4d: "threw: RequestError: ECONNREFUSED" wasn't a sentence).
    var RUNTIME_ERROR_WORDS = [
        [/ECONNREFUSED/, "the connection was refused (nothing is listening at that address)"],
        [/ENOTFOUND|EAI_AGAIN/, "the host name couldn't be found"],
        [/ETIMEDOUT|ESOCKETTIMEDOUT|timed? ?out/i, "the request timed out"],
        [/ECONNRESET/, "the connection was dropped"],
        [/EHOSTUNREACH|ENETUNREACH/, "that address can't be reached from Node-RED"],
        [/CERT_|self[- ]signed|certificate/i, "the server's certificate wasn't accepted"]
    ];
    function runtimeProofPlainError(text) {
        var raw = String(text || "");
        for (var i = 0; i < RUNTIME_ERROR_WORDS.length; i++) {
            if (RUNTIME_ERROR_WORDS[i][0].test(raw)) {
                var code = (raw.match(/\b(E[A-Z_]{3,}|CERT_[A-Z_]+)\b/) || [])[1];
                return RUNTIME_ERROR_WORDS[i][1] + (code ? " (" + code + ")" : "");
            }
        }
        return raw;
    }

    function runtimeProofErrorLabel(errors) {
        return (Array.isArray(errors) ? errors : []).slice(0, 5).map(function (error) {
            return (error.nodeName || error.node || error.nodeId || "unknown node") + " (" +
                (error.nodeType || error.type || "node") + ") failed: " +
                runtimeProofPlainError(runtimeProofMessageText(error.message || error.text || "node reported an error"));
        }).join("\n");
    }

    function runtimeProofRetryDecision(outcome, attempt, maxAttempts) {
        var limit = Number(maxAttempts);
        if (!(limit >= 1)) { limit = 2; }
        var retryable = !!(outcome && outcome.retryable === true &&
            (outcome.state === "runtime-error" || outcome.state === "no-output"));
        var message = outcome && (outcome.label || outcome.note) || "Runtime proof failed";
        if (outcome && outcome.state === "no-output") { message = "Got nothing: " + message; }
        return {
            retry: retryable && Number(attempt) < limit,
            message: message
        };
    }

    // What the user reads on a card: never raw JSON (QA pass 4c, Spark S4:
    // "Run: observed — {"latitude":48.85,…"). A small flat object reads as
    // "temp: 14, unit: C"; a larger one names its fields; a list its size.
    function runtimeDescribeValue(value) {
        if (typeof value === "string") {
            var trimmed = value.trim();
            if (!/^[\[{]/.test(trimmed)) { return value; }
            try { value = JSON.parse(trimmed); } catch (e) { return value; }
        }
        if (value === undefined || value === null) { return ""; }
        if (Array.isArray(value)) {
            return "a list of " + value.length + (value.length === 1 ? " item" : " items");
        }
        if (typeof value !== "object") { return String(value); }
        var keys = Object.keys(value);
        if (!keys.length) { return "an empty object"; }
        var simple = keys.length <= 3 && keys.every(function (k) {
            var v = value[k];
            return v === null || ((typeof v === "number" || typeof v === "boolean" || typeof v === "string") && String(v).length <= 40);
        });
        if (simple) {
            return keys.map(function (k) { return k + ": " + String(value[k]); }).join(", ");
        }
        var shown = keys.slice(0, 4).join(", ");
        return "an object with " + shown + (keys.length > 4 ? " and " + (keys.length - 4) + " more field" + (keys.length - 4 === 1 ? "" : "s") : "");
    }

    function runtimeFormatObservedValue(value, valueType) {
        return runtimeDescribeValue(value);
    }

    function runtimeProofOutcome(evidence, goal) {
        goal = goal || {};
        if (goal.runtimeConfirmed === false) {
            var invalid = goal.invalidNodeNames || [];
            var missing = goal.missingNodeNames || goal.goalNames || [];
            if (invalid.length) {
                return { state: "not-tested", label: "Not tested: " + invalid.join(", ") +
                    (invalid.length === 1 ? " is" : " are") + " invalid in Node-RED, so " +
                    (invalid.length === 1 ? "it" : "they") + " can't run", note: "runtime not confirmed" };
            }
            // With no names, the subject is "the flow" (QA pass 4: "Not
            // tested: the target aren't deployed").
            return { state: "not-tested", label: "Not tested: " + (missing.length ? missing.join(", ") +
                (missing.length === 1 ? " isn't" : " aren't") : "the flow isn't") + " deployed", note: "runtime not confirmed" };
        }
        var runtimeErrors = Array.isArray(goal.runtimeErrors) ? goal.runtimeErrors :
            (Array.isArray(evidence) ? evidence.filter(function (entry) { return entry && entry.kind === "error"; }) : []);
        if (runtimeErrors.length) {
            var errorLabel = runtimeProofErrorLabel(runtimeErrors);
            return { state: "runtime-error", retryable: true, label: errorLabel,
                note: errorLabel, errors: runtimeErrors.slice(0, 5) };
        }
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
        if (goal.state === "no-output" && !goal.noOutputReason) {
            var goalName = goal.goalNames && goal.goalNames.length ? goal.goalNames.join(" or ") : "the goal";
            var lastNode = goal.lastOutputNode || "no node";
            var lastValue = goal.lastOutputValue === undefined || goal.lastOutputValue === ""
                ? "output" : runtimeProofMessageText(goal.lastOutputValue);
            var noOutput = "No output reached " + goalName + "; " + lastNode + " last produced " + lastValue;
            return { state: "no-output", retryable: true, label: noOutput, note: noOutput };
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
            createRuntimeProofObserver: createRuntimeProofObserver,
            runtimeProofMessageText: runtimeProofMessageText,
            runtimeProofRetryDecision: runtimeProofRetryDecision,
            runtimeFormatObservedValue: runtimeFormatObservedValue,
            runtimeDescribeValue: runtimeDescribeValue,
            runtimeProofErrorLabel: runtimeProofErrorLabel,
            runtimeProofPlainError: runtimeProofPlainError,
            runtimeProofOutcome: runtimeProofOutcome,
            runtimeBuildCanConverge: runtimeBuildCanConverge,
            runtimeDeployConsent: runtimeDeployConsent
        };
    }
