    // SF-2 intake and touched-node state. This fragment is deliberately
    // environment-neutral enough for the small unit tests to require it,
    // while the browser bundle uses the same functions from its shared
    // closure.
    var DEFAULT_INTAKE_FLAGS = { auto: true, restricted: false };

    function intakeFlags(currentSettings) {
        var settings = currentSettings || {};
        return {
            auto: settings.auto === undefined ? DEFAULT_INTAKE_FLAGS.auto : settings.auto === true,
            restricted: settings.restricted === undefined
                ? DEFAULT_INTAKE_FLAGS.restricted : settings.restricted === true,
            planFirst: settings.planFirst === true || settings.plan_first === true,
            justDoIt: settings.justDoIt === true || settings.just_do_it === true
        };
    }

    function createTouchedNodeIndex() {
        var runs = [];
        var runCounter = 0;

        function unique(ids) {
            var seen = {};
            return (ids || []).filter(function (id) {
                if (typeof id !== "string" || !id || seen[id]) { return false; }
                seen[id] = true;
                return true;
            });
        }

        function idsFromValue(value, ids) {
            if (!value) { return; }
            if (typeof value === "string") { ids.push(value); return; }
            if (Array.isArray(value)) {
                value.forEach(function (item) { idsFromValue(item, ids); });
                return;
            }
            if (typeof value !== "object") { return; }
            if (typeof value.id === "string") { ids.push(value.id); }
            if (typeof value.nodeId === "string") { ids.push(value.nodeId); }
            if (typeof value.fromId === "string") { ids.push(value.fromId); }
            if (typeof value.toId === "string") { ids.push(value.toId); }
            if (value.node) { idsFromValue(value.node, ids); }
            if (value.nodes) { idsFromValue(value.nodes, ids); }
            if (value.groups) { idsFromValue(value.groups, ids); }
            if (value.changes) { idsFromValue(value.changes, ids); }
            if (value.newNodes) { idsFromValue(value.newNodes, ids); }
            if (value.newWires) { idsFromValue(value.newWires, ids); }
            if (value.removeNodes) { idsFromValue(value.removeNodes, ids); }
        }

        function idsFromHistory(events) {
            var ids = [];
            (events || []).forEach(function (event) {
                if (!event) { return; }
                if (event.t === "multi") {
                    idsFromHistory(event.events).forEach(function (id) { ids.push(id); });
                    return;
                }
                idsFromValue(event, ids);
            });
            return unique(ids);
        }

        return {
            beginRun: function () {
                runCounter++;
                return runCounter;
            },
            recordRun: function (events, runNumber) {
                var number = typeof runNumber === "number" ? runNumber : runCounter;
                var ids = idsFromHistory(events);
                if (ids.length) {
                    runs.push({ run: number, nodeIds: ids });
                    if (runs.length > 20) { runs.shift(); }
                }
                return ids;
            },
            reset: function () {
                runs = [];
                runCounter = 0;
            },
            resolveRecent: function (maxAge) {
                var age = typeof maxAge === "number" ? maxAge : 2;
                var latest = runs[runs.length - 1];
                if (!latest || runCounter - latest.run > age) { return []; }
                return latest.nodeIds.slice();
            },
            snapshot: function () {
                return {
                    run: runCounter,
                    runs: runs.map(function (entry) {
                        return { run: entry.run, nodeIds: entry.nodeIds.slice() };
                    })
                };
            },
            idsFromHistory: idsFromHistory
        };
    }

    function activeTabContext() {
        var id = (typeof RED !== "undefined" && RED.workspaces && RED.workspaces.active)
            ? RED.workspaces.active() : null;
        var tab = null;
        if (id && typeof RED !== "undefined" && RED.nodes) {
            if (RED.nodes.node) { tab = RED.nodes.node(id); }
            if (!tab && RED.nodes.workspace) { tab = RED.nodes.workspace(id); }
        }
        return {
            id: id || null,
            label: tab && (tab.label || tab.name) ? (tab.label || tab.name) : (id || "(unknown tab)")
        };
    }

    function nodeCandidates(tab) {
        if (typeof RED === "undefined" || !RED.nodes || !RED.nodes.eachNode) { return []; }
        var activeId = tab && tab.id;
        var active = [];
        var rest = [];
        RED.nodes.eachNode(function (node) {
            if (!node || !node.id || node.type === "tab" || node.type === "group") { return; }
            var candidate = { id: node.id, name: node.name || node.id, type: node.type, z: node.z || null };
            if (activeId && node.z === activeId) { active.push(candidate); }
            else { rest.push(candidate); }
        });
        return active.concat(rest).slice(0, 6);
    }

    function resolveIntakeTarget(message, selectionIds, candidates, touchedIndex) {
        var ids = Array.isArray(selectionIds) ? selectionIds.slice() : [];
        if (ids.length) { return { kind: "selection", ids: ids }; }
        var text = String(message || "");
        if (/\b(?:it|that|this node|that node)\b/i.test(text)) {
            var recent = touchedIndex && touchedIndex.resolveRecent ? touchedIndex.resolveRecent(2) : [];
            if (recent.length) { return { kind: "it", ids: recent }; }
        }
        var lower = text.toLowerCase();
        var named = (candidates || []).filter(function (candidate) {
            var name = String(candidate.name || "").toLowerCase();
            return name && (lower.indexOf(name) !== -1 ||
                new RegExp("\\b" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(text));
        });
        if (named.length) { return { kind: "named", ids: [named[0].id] }; }
        return { kind: "unresolved", ids: [] };
    }

    function buildIntake(message, currentSettings, options) {
        options = options || {};
        var selected = typeof options.activeSelectionIds === "function"
            ? options.activeSelectionIds() : (typeof activeSelectionIds === "function" ? activeSelectionIds() : []);
        selected = Array.isArray(selected) ? selected.slice() : [];
        var tab = options.activeTab || activeTabContext();
        var touched = options.touchedIndex || (typeof conversationTouchedIndex !== "undefined" ? conversationTouchedIndex : null);
        var candidates = (options.candidates || nodeCandidates(tab)).slice(0, 6);
        var target = resolveIntakeTarget(message, selected, candidates, touched);
        var flags = intakeFlags(currentSettings);
        return {
            message: String(message || ""),
            activeSelectionIds: selected,
            selectionIds: selected,
            activeTab: { id: tab && tab.id ? tab.id : null, label: tab && tab.label ? tab.label : "(unknown tab)" },
            touchedNodeIndex: touched && touched.snapshot ? touched.snapshot() : { run: 0, runs: [] },
            target: target,
            targetIds: target.ids.slice(),
            candidates: candidates,
            flags: flags,
            auto: flags.auto,
            restricted: flags.restricted,
            planFirst: flags.planFirst,
            justDoIt: flags.justDoIt
        };
    }

    function lockTargetIds(context) {
        var nodes = context && Array.isArray(context.nodes) ? context.nodes : [];
        return {
            ids: nodes.map(function (node) { return node && node.id; }).filter(Boolean),
            labels: nodes.map(function (node) {
                return node && (node.name || node.id) ? (node.name || node.id) : "(unnamed)";
            }).filter(Boolean)
        };
    }

    function pickerCandidates(intake) {
        var candidates = intake && Array.isArray(intake.candidates) ? intake.candidates : [];
        return candidates.slice(0, 6).map(function (candidate) {
            return (candidate.name || candidate.id) + " [" + candidate.type + "]";
        }).concat(["Something else (describe it)"]);
    }

    var conversationTouchedIndex = createTouchedNodeIndex();
    var pendingIntake = null;

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            DEFAULT_FLAGS: Object.assign({}, DEFAULT_INTAKE_FLAGS),
            intakeFlags: intakeFlags,
            createTouchedNodeIndex: createTouchedNodeIndex,
            activeTabContext: activeTabContext,
            buildIntake: buildIntake,
            resolveIntakeTarget: resolveIntakeTarget,
            lockTargetIds: lockTargetIds,
            pickerCandidates: pickerCandidates
        };
    }
