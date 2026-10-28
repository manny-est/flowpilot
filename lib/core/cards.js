    // SF-6 card models. These functions deliberately accept plain run/plan
    // records and return plain data. The DOM renderers use these models, so
    // a card can be reconstructed after a refresh or in the pop-out without
    // consulting model prose or the live editor.

    var CARD_FUNCTION_KEYS = ["func", "function", "initialize", "finalize", "onStart", "onStop"];

    function cardString(value) {
        return value === undefined || value === null ? "" : String(value);
    }

    function cardClone(value) {
        if (value === undefined) { return value; }
        if (value === null || typeof value !== "object") { return value; }
        if (Array.isArray(value)) { return value.map(cardClone); }
        var result = {};
        Object.keys(value).forEach(function (key) { result[key] = cardClone(value[key]); });
        return result;
    }

    function cardObservedValue(entry) {
        entry = entry || {};
        var value = entry.value;
        if (entry.valueType === "object" && typeof value === "string") {
            try { value = JSON.parse(value); } catch (e) { /* keep the value */ }
        }
        // Older/full-message taps may still hand us the complete message.
        // The runtime proof contract is msg.payload by default.
        if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "payload") &&
                Object.prototype.hasOwnProperty.call(value, "_msgid")) {
            value = value.payload;
        }
        if (value && typeof value === "object") {
            try { return JSON.stringify(value); } catch (e2) { return String(value); }
        }
        return value === undefined || value === null ? "" : String(value);
    }

    function cardValueEqual(left, right) {
        try { return JSON.stringify(left) === JSON.stringify(right); }
        catch (e) { return left === right; }
    }

    // A compact line diff using the longest common subsequence. It is small
    // enough for a sidebar card and avoids pulling a diff library into the
    // browser bundle.
    function cardLineDiff(before, after) {
        var oldLines = cardString(before).split("\n");
        var newLines = cardString(after).split("\n");
        if (before === undefined || before === null) { oldLines = []; }
        if (after === undefined || after === null) { newLines = []; }
        var rows = oldLines.length;
        var cols = newLines.length;
        var table = [];
        var i;
        var j;
        for (i = 0; i <= rows; i++) {
            table[i] = [];
            for (j = 0; j <= cols; j++) { table[i][j] = 0; }
        }
        for (i = rows - 1; i >= 0; i--) {
            for (j = cols - 1; j >= 0; j--) {
                table[i][j] = oldLines[i] === newLines[j]
                    ? table[i + 1][j + 1] + 1
                    : Math.max(table[i + 1][j], table[i][j + 1]);
            }
        }
        var diff = [];
        i = 0;
        j = 0;
        while (i < rows || j < cols) {
            if (i < rows && j < cols && oldLines[i] === newLines[j]) {
                diff.push({ kind: "same", text: oldLines[i] });
                i++;
                j++;
            } else if (i < rows && (j === cols || table[i + 1][j] >= table[i][j + 1])) {
                // Removed lines come before their replacements, as in a unified diff.
                diff.push({ kind: "remove", text: oldLines[i] });
                i++;
            } else {
                diff.push({ kind: "add", text: newLines[j] });
                j++;
            }
        }
        return diff;
    }

    function cardChangeKind(key) {
        return CARD_FUNCTION_KEYS.indexOf(key) !== -1 ? "function" : "property";
    }

    function cardNormalizePropertyChanges(node) {
        var before = node && (node.before || node.old || node.previous || {});
        var after = node && (node.after || node.new || node.current || {});
        var explicit = node && (node.propertyChanges || node.changes);
        var keys = [];
        if (Array.isArray(explicit)) {
            explicit.forEach(function (change) {
                var key = change && (change.key || change.property || change.name);
                if (key && keys.indexOf(key) === -1) { keys.push(key); }
            });
        } else if (explicit && typeof explicit === "object") {
            Object.keys(explicit).forEach(function (key) { if (keys.indexOf(key) === -1) { keys.push(key); } });
        }
        Object.keys(before || {}).concat(Object.keys(after || {})).forEach(function (key) {
            if (["id", "name", "type", "z"].indexOf(key) !== -1) { return; }
            if (keys.indexOf(key) === -1 && !cardValueEqual(before[key], after[key])) { keys.push(key); }
        });
        return keys.map(function (key) {
            var explicitChange = Array.isArray(explicit)
                ? explicit.filter(function (change) { return change && (change.key || change.property || change.name) === key; })[0]
                : (explicit && explicit[key]);
            var oldValue = explicitChange && explicitChange.oldVal !== undefined
                ? explicitChange.oldVal : (explicitChange && explicitChange.before !== undefined
                    ? explicitChange.before : before[key]);
            var newValue = explicitChange && explicitChange.newVal !== undefined
                ? explicitChange.newVal : (explicitChange && explicitChange.after !== undefined
                    ? explicitChange.after : after[key]);
            var change = {
                key: key,
                before: cardClone(oldValue),
                after: cardClone(newValue),
                kind: cardChangeKind(key)
            };
            if (change.kind === "function") {
                change.lines = cardLineDiff(oldValue, newValue);
            }
            return change;
        }).filter(function (change) {
            return !cardValueEqual(change.before, change.after);
        });
    }

    function cardNodeFromValue(value, fallback) {
        if (!value) { return fallback || {}; }
        if (typeof value === "string") { return { id: value }; }
        return value;
    }

    function cardNormalizeNode(node, kind) {
        node = node || {};
        var before = cardNodeFromValue(node.before || node.old || node.previous,
            kind === "removed" ? node : {});
        var after = cardNodeFromValue(node.after || node.new || node.current,
            kind === "removed" ? {} : node);
        var normalized = {
            id: node.id || after.id || before.id || null,
            name: node.name || after.name || before.name || "(unnamed)",
            type: node.type || after.type || before.type || "(unknown)",
            changeType: kind || node.changeType || "changed",
            added: Array.isArray(node.added) ? cardClone(node.added) : [],
            changed: (kind === "added" || kind === "removed") ? [] : cardNormalizePropertyChanges(node),
            removed: Array.isArray(node.removed) ? cardClone(node.removed) : [],
            before: cardClone(before),
            after: cardClone(after)
        };
        if (kind === "added" && !normalized.added.length) { normalized.added = Object.keys(after).filter(function (key) { return key !== "id"; }); }
        if (kind === "removed" && !normalized.removed.length) { normalized.removed = Object.keys(before).filter(function (key) { return key !== "id"; }); }
        return normalized;
    }

    function cardMergeNode(map, value, kind) {
        if (!value) { return; }
        var node = cardNormalizeNode(cardNodeFromValue(value), kind);
        var key = node.id || (node.type + ":" + node.name);
        if (!map[key]) { map[key] = node; return; }
        var current = map[key];
        ["added", "removed"].forEach(function (field) {
            (node[field] || []).forEach(function (item) {
                if (current[field].indexOf(item) === -1) { current[field].push(item); }
            });
        });
        if (node.changed.length) { current.changed = node.changed; }
        if (node.name !== "(unnamed)") { current.name = node.name; }
        if (node.type !== "(unknown)") { current.type = node.type; }
    }

    function cardChangedNodes(record) {
        record = record || {};
        var map = {};
        var explicit = record.changedNodes || record.nodesChanged || record.nodeChanges;
        if (Array.isArray(explicit)) { explicit.forEach(function (node) { cardMergeNode(map, node, node && node.changeType); }); }
        var changes = Array.isArray(record.changes) ? record.changes : [];
        changes.forEach(function (change) { cardMergeNode(map, change, change && change.changeType); });
        (Array.isArray(record.newNodes) ? record.newNodes : []).forEach(function (node) {
            cardMergeNode(map, node, "added");
        });
        var removed = record.removedNodes || record.removeNodes;
        (Array.isArray(removed) ? removed : []).forEach(function (node) {
            cardMergeNode(map, cardNodeFromValue(node, { id: node }), "removed");
        });
        (Array.isArray(record.events) ? record.events : []).forEach(function (event) {
            if (!event) { return; }
            if (Array.isArray(event.changeDetails)) { event.changeDetails.forEach(function (node) { cardMergeNode(map, node, node.changeType); }); }
            if (Array.isArray(event.changedNodes)) { event.changedNodes.forEach(function (node) { cardMergeNode(map, node, node.changeType); }); }
            if (event.node && (event.t === "change" || event.t === "changed" || event.t === "applied")) {
                cardMergeNode(map, event.node, event.node.changeType);
            }
            if (event.t === "applied" && event.changes) {
                (Array.isArray(event.changes) ? event.changes : [event.changes]).forEach(function (node) { cardMergeNode(map, node, node.changeType); });
            }
        });
        return Object.keys(map).map(function (key) { return map[key]; });
    }

    function cardValidationChecks(record) {
        record = record || {};
        // Validation runs after every write, so the same check on the same
        // node can be recorded several times in a run. Keep one row per
        // node+check, holding the latest result, in first-seen order.
        var checks = [];
        var indexByKey = {};
        function add(value) {
            if (Array.isArray(value)) { value.forEach(add); return; }
            if (!value) { return; }
            var status = value.status;
            if (status === "pass" || status === "ok" || value.ok === true || value.pass === true) { status = "pass"; }
            else if (status === "warning" || status === "warn" || value.warning) { status = "warning"; }
            else if (status === "fail" || status === "error" || value.ok === false || value.pass === false) { status = "fail"; }
            else { status = "warning"; }
            var row = {
                status: status,
                check: value.check || value.name || "validation",
                message: value.message || value.detail || "",
                nodeId: value.nodeId || ""
            };
            var key = row.nodeId + "\u0000" + row.check + "\u0000" + (value.port !== undefined ? value.port : "");
            if (Object.prototype.hasOwnProperty.call(indexByKey, key)) { checks[indexByKey[key]] = row; return; }
            indexByKey[key] = checks.length;
            checks.push(row);
        }
        add(record.validationChecks || record.validations || record.validation);
        (Array.isArray(record.events) ? record.events : []).forEach(function (event) {
            if (event && event.t === "validation") { add(event.checks); }
        });
        return checks;
    }

    // Only runtime verification counts as a run (verify_runtime results on
    // record.verifyResults). The per-write "verified" events are canvas
    // checks, not runs, so a plain Modify reads "Run: not run".
    function cardVerifyResults(record) {
        var results = record && record.verifyResults;
        if (!results) { return []; }
        return Array.isArray(results) ? results.slice() : [results];
    }

    function cardEvidenceQuote(result) {
        if (!result) { return ""; }
        var evidence = result.evidence || result.observed || result.outputs;
        if (Array.isArray(evidence) && evidence.length) {
            var debugEntries = evidence.filter(function (entry) { return entry && entry.kind === "debug"; });
            var first = debugEntries.length ? debugEntries[debugEntries.length - 1] : evidence[evidence.length - 1];
            var value = cardObservedValue(first);
            return value.length > 160 ? value.slice(0, 157) + "…" : value;
        }
        var fallback = result.observedValue || result.quote || result.observedOutput || result.output || result.value;
        if (fallback && typeof fallback === "object") {
            try { fallback = JSON.stringify(fallback); } catch (e) { fallback = String(fallback); }
        }
        fallback = cardString(fallback);
        return fallback ? (fallback.length > 160 ? fallback.slice(0, 157) + "…" : fallback) : "";
    }

    // Same rule as the run's own outcome (settleDoneOutcome): observed only when
    // the LAST runtime check observed something. An earlier observation
    // followed by a failing check isn't proof.
    function cardRunState(record) {
        var verifies = cardVerifyResults(record || {});
        if (!verifies.length) { return { state: "not-run", label: "Run: not run", quote: "" }; }
        var last = verifies[verifies.length - 1] || {};
        var observed = last.state === "observed" || (typeof last.evidenceCount === "number" ? last.evidenceCount > 0
            : !!cardEvidenceQuote(last));
        var quote = observed ? cardEvidenceQuote(last) : "";
        if (observed && quote) {
            var evidence = last.evidence || last.observed || last.outputs || [];
            var lastEvidence = Array.isArray(evidence) && evidence.length ? evidence[evidence.length - 1] : {};
            var node = last.observedNode || lastEvidence.node || lastEvidence.name || "goal";
            return { state: "observed", quote: quote, label: "Run: observed — " + quote + " (at " + node + ")" };
        }
        if (last.state === "no-output") {
            return { state: "no-output", quote: "", label: last.label || last.note || "Ran, but no output reached the goal" };
        }
        if (last.state === "not-observable" || last.restricted) {
            var unavailable = last.label || ("Run: not observable here — " + (last.reason || last.note || "runtime proof is unavailable"));
            return { state: "not-observable", quote: "", label: unavailable };
        }
        var reason = last.reason || last.note || (last.triggered && last.triggered.error) || "";
        return { state: "not-observable", quote: "", label: "Run: not observable here" + (reason ? " — " + reason : "") };
    }

    function cardTokenCount(record) {
        record = record || {};
        var usages = Array.isArray(record.usage) ? record.usage : (record.usage ? [record.usage] : []);
        var total = 0;
        usages.forEach(function (usage) {
            if (usage && typeof usage.total_tokens === "number") { total += usage.total_tokens; }
            else if (usage) { total += Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0); }
        });
        if (!usages.length && Array.isArray(record.events)) {
            record.events.forEach(function (event) {
                if (event && event.t === "usage") {
                    total += typeof event.total_tokens === "number" ? event.total_tokens : Number(event.prompt_tokens || 0) + Number(event.completion_tokens || 0);
                }
            });
        }
        if (!total && typeof record.tokenCount === "number") { total = record.tokenCount; }
        return total;
    }

    function buildResultCardModel(record) {
        record = record || {};
        return {
            changedNodes: cardChangedNodes(record),
            validation: cardValidationChecks(record),
            run: cardRunState(record),
            tokenCount: cardTokenCount(record),
            outcome: cardClone(record.outcome || null),
            deployed: Number(record.deployCount || record.deploys || 0)
        };
    }

    function cardHistoryTop(history) {
        if (!history) { return null; }
        if (typeof history.peek === "function") { return history.peek(); }
        if (typeof history.list === "function") {
            var list = history.list();
            return Array.isArray(list) ? list[list.length - 1] : null;
        }
        return null;
    }

    function undoResultCard(record, red) {
        var history = red && red.history;
        var entry = record && (record.historyEntry || record.history);
        if (!history || typeof history.pop !== "function" || !entry) {
            return { undone: false, message: "This run's history entry is no longer available." };
        }
        if (cardHistoryTop(history) !== entry) {
            return { undone: false, message: "Newer edits are on top of this run. Nothing was undone." };
        }
        history.pop();
        record.undone = true;
        return { undone: true, message: record.deployed
            ? "Undone in the editor. Deploy to apply."
            : "Undone in the editor." };
    }

    function planItemsFromRecord(record) {
        record = record || {};
        return Array.isArray(record.plan_items) ? record.plan_items.slice()
            : (Array.isArray(record.planItems) ? record.planItems.slice()
                : (Array.isArray(record.items) ? record.items.map(function (item) { return item && item.text ? item.text : item; }) : []));
    }

    function planTargetNodes(record, resolveNode) {
        record = record || {};
        var targets = record.targetNodes || record.targets || (record.context && record.context.nodes) || [];
        if (!Array.isArray(targets)) { targets = []; }
        return targets.map(function (target) {
            var id = typeof target === "string" ? target : target && target.id;
            var node = typeof target === "object" ? target : (resolveNode && resolveNode(id));
            return node || { id: id, type: "(unknown)" };
        }).filter(function (node) { return !!node; });
    }

    // Side-effecting node types a plan line can name; matches consent.js's
    // always-ask creates. Listed up front so Approve can cover them.
    var PLAN_SIDE_EFFECT_TYPES = [
        ["http request", /\bhttp request\b|\b(call|fetch|get|post)(es|s|ing)? (an? |the )?(api|url|endpoint)\b|\bhttps?:\/\//],
        ["mqtt out", /\bmqtt\b/], ["exec", /\bexec\b|\bshell command\b/],
        ["file", /\b(write|append) (to )?(a )?file\b|\bfile node\b/], ["e-mail", /\be-?mail\b/],
        ["serial out", /\bserial\b/], ["tcp out", /\btcp\b/], ["udp out", /\budp\b/],
        ["websocket out", /\bwebsocket\b/]
    ];

    function planRiskPrediction(record, resolveNode, consent) {
        var items = planItemsFromRecord(record);
        var risks = [];
        function add(operation, detail, nodeId, type, approvable) {
            var key = operation + ":" + (nodeId || type || "");
            if (risks.some(function (risk) { return risk.key === key; })) { return; }
            risks.push({ key: key, operation: operation, detail: detail, nodeId: nodeId || null, type: type || null,
                approvable: approvable !== false });
        }
        var pa = (record && (record.proposeAction || record.plan)) || {};
        var targets = planTargetNodes(record, resolveNode);
        if (pa.action === "build" || pa.deploy_verify === true) { add("deploy", "Deploy changes"); }
        // The summary is part of the plan the user approves; scan it too
        // (live: a Spark proposal with no plan items listed no risks at all).
        // Generate/Build text is creation by definition, so a side-effect
        // node it mentions is predicted without an "add"/"create" verb.
        var creating = pa.action === "generate" || pa.action === "build";
        var texts = items.slice();
        if (typeof pa.summary === "string" && pa.summary.trim()) { texts.push(pa.summary); }
        texts.forEach(function (item) {
            var text = cardString(item).toLowerCase();
            // "publish" means MQTT/HTTP output here, not a Node-RED deploy.
            if (/\bdeploy(?:ment|ed|ing)?\b/.test(text)) { add("deploy", "Deploy changes"); }
            if (/\b(delete|remove|drop|destroy)\b/.test(text)) {
                // Approvable only for a target the line names; otherwise it's
                // listed and still asked during the run.
                var named = targets.filter(function (node) {
                    return node && node.name && text.indexOf(String(node.name).toLowerCase()) !== -1;
                });
                if (named.length) {
                    named.forEach(function (node) {
                        add("delete", "Delete " + node.name, node.id, node.type);
                    });
                } else {
                    add("delete", "Delete nodes (FlowPilot will still ask which, during the run)", null, null, false);
                }
            }
            if (creating || /\b(add|create|insert|new)\b/.test(text)) {
                PLAN_SIDE_EFFECT_TYPES.forEach(function (entry) {
                    if (entry[1].test(text)) { add("create", "Add a " + entry[0] + " node", null, entry[0]); }
                });
            }
        });
        var decide = consent && (consent.decideConsent || consent);
        if (typeof decide !== "function" && typeof decideConsent === "function") { decide = decideConsent; }
        if (typeof decide !== "function") {
            var safeTypes = ["inject", "function", "change", "switch", "filter", "json", "xml", "csv",
                "base64", "html", "split", "join", "sort", "batch", "debug", "status", "comment",
                "link in", "link out", "link call", "junction"];
            decide = function (operation, type) {
                return safeTypes.indexOf(type) !== -1 && operation !== "delete" && operation !== "deploy" ? "auto" : "ask";
            };
        }
        targets.forEach(function (node) {
            var type = node && node.type;
            if (!type) { return; }
            var decision = decide("modify-config", type, {});
            if (decision === "ask") {
                add("modify-config", "Change " + type + (node.name ? " — " + node.name : ""), node.id, type);
            }
        });
        return risks;
    }

    function approvePlanCard(record, memory, taskId, resolveNode, consent) {
        record = record || {};
        var id = taskId || record.taskId || record.runId || "plan";
        var risks = planRiskPrediction(record, resolveNode, consent);
        var approved = risks.filter(function (risk) { return risk.approvable !== false; }).map(function (risk) {
            return { operation: risk.operation, nodeId: risk.nodeId || null, type: risk.type || null };
        });
        approved.forEach(function (risk) {
            if (!memory) { return; }
            // Node-less approvals are remembered only for deploy (consent.js).
            if (!risk.nodeId && risk.operation !== "deploy") { return; }
            if (typeof memory.rememberOperation === "function") {
                memory.rememberOperation(id, risk.operation, risk.nodeId || null);
            } else if (typeof memory.remember === "function") {
                memory.remember(id, risk.operation + (risk.nodeId ? ":" + risk.nodeId : ""));
            }
        });
        record.approvedOperations = approved;
        return { taskId: id, operations: approved };
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            cardLineDiff: cardLineDiff,
            cardChangedNodes: cardChangedNodes,
            cardValidationChecks: cardValidationChecks,
            cardRunState: cardRunState,
            cardTokenCount: cardTokenCount,
            buildResultCardModel: buildResultCardModel,
            undoResultCard: undoResultCard,
            planRiskPrediction: planRiskPrediction,
            approvePlanCard: approvePlanCard,
            predictPlanRisks: planRiskPrediction,
            approvePlan: approvePlanCard,
            resultCardModel: buildResultCardModel,
            buildResultCard: buildResultCardModel,
            undoRun: undoResultCard,
            planCardRiskPrediction: planRiskPrediction,
            approvePlanConsent: approvePlanCard
        };
    }
