    // SF-2 intake and touched-node state. This fragment is deliberately
    // environment-neutral enough for the small unit tests to require it,
    // while the browser bundle uses the same functions from its shared
    // closure.
    var DEFAULT_INTAKE_FLAGS = { auto: true, restricted: false };

    function intakeFlags(currentSettings, oneShot) {
        var settings = currentSettings || {};
        var once = oneShot || {};
        return {
            auto: settings.auto === undefined ? DEFAULT_INTAKE_FLAGS.auto : settings.auto === true,
            restricted: settings.restricted === undefined
                ? DEFAULT_INTAKE_FLAGS.restricted : settings.restricted === true,
            planFirst: once.planFirst === true || settings.planFirst === true || settings.plan_first === true,
            justDoIt: once.justDoIt === true || settings.justDoIt === true || settings.just_do_it === true
        };
    }

    function parseSlashCommand(raw) {
        var trimmed = String(raw || "").trim();
        if (trimmed.charAt(0) !== "/") { return null; }
        var command = trimmed.split(/\s+/)[0].toLowerCase();
        return { command: command, rest: trimmed.slice(command.length).trim() };
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

    // Picker candidates: nodes whose name or type the message mentions, open
    // tab first; when nothing matches, the open tab's nodes. Max 6.
    var INTAKE_GENERIC_NAME = /^(debug|inject|function|change|switch|comment|node|template|delay|trigger|link in|link out|http request|http in|http response|mqtt in|mqtt out)$/;

    function nodeCandidates(tab, message) {
        if (typeof RED === "undefined" || !RED.nodes || !RED.nodes.eachNode) { return []; }
        var activeId = tab && tab.id;
        var lower = String(message || "").toLowerCase();
        var matched = [];
        var tabNodes = [];
        RED.nodes.eachNode(function (node) {
            if (!node || !node.id || node.type === "tab" || node.type === "group") { return; }
            var inTab = !!activeId && node.z === activeId;
            // RED.nodes.node() doesn't return tabs or subflows, so off-tab
            // candidates had no label (live: "Weather Report [debug]" with
            // no tab next to two labelled ones).
            var tabNode = !node.z ? null
                : (RED.nodes.workspace && RED.nodes.workspace(node.z)) ||
                  (RED.nodes.subflow && RED.nodes.subflow(node.z)) ||
                  (RED.nodes.node && RED.nodes.node(node.z)) || null;
            var candidate = { id: node.id, name: node.name || node.id, type: node.type, z: node.z || null,
                tabLabel: tabNode && (tabNode.label || tabNode.name) || (inTab && tab && tab.label) || null,
                inActiveTab: inTab };
            var name = String(node.name || "").toLowerCase();
            // A real name the user typed outranks everything, the open tab
            // included (live: "after the Weather Report node" offered four
            // nodes from the open tab and neither Weather Report). Generic
            // names ("Debug") count like a type word.
            var nameHit = !!name && lower.indexOf(name) !== -1;
            var realName = nameHit && name !== String(node.type || "").toLowerCase() &&
                !INTAKE_GENERIC_NAME.test(name);
            var score = (realName ? 20 : nameHit ? 2 : 0) +
                (lower.indexOf(String(node.type || "").toLowerCase()) !== -1 ? 1 : 0);
            if (score > 0) { matched.push({ c: candidate, score: score + (inTab ? 10 : 0) }); }
            if (inTab) { tabNodes.push(candidate); }
        });
        if (matched.length) {
            matched.sort(function (x, y) { return y.score - x.score; });
            return matched.slice(0, 6).map(function (m) { return m.c; });
        }
        return tabNodes.slice(0, 6);
    }

    function resolveIntakeTarget(message, selectionIds, candidates, touchedIndex) {
        var ids = Array.isArray(selectionIds) ? selectionIds.slice() : [];
        var text = String(message || "");
        var namedIds = uniquelyNamedTargets(text, candidates);
        if (ids.length) {
            // Every real, unambiguous name in the message joins the current
            // selection. Live (SF-7): a run left a node on another tab
            // selected, and a queued "Rename the Shaper node…" still targets
            // Shaper as well as the selected node.
            // "this node", "these", "the selected…" point at the selection,
            // so a name in the same message is a reference, not the target
            // ("copy Shaper's code into this node").
            var pointsAtSelection = /\b(this|these|selected|selection)\b/i.test(text);
            if (namedIds.length && !pointsAtSelection) {
                var mergedIds = ids.concat(namedIds.filter(function (id) {
                    return ids.indexOf(id) === -1;
                }));
                return { kind: mergedIds.length === ids.length ? "selection" : "named", ids: mergedIds };
            }
            return { kind: "selection", ids: ids };
        }
        if (/\b(?:it|that|this node|that node)\b/i.test(text)) {
            var recent = touchedIndex && touchedIndex.resolveRecent ? touchedIndex.resolveRecent(2) : [];
            if (recent.length) { return { kind: "it", ids: recent }; }
        }
        if (namedIds.length) { return { kind: "named", ids: namedIds }; }
        return { kind: "unresolved", ids: [] };
    }

    // A name resolves the target only when it really is a name (not a
    // node-type word like "debug": live-found, "Rename the debug node"
    // resolved to a node called "Debug" on another tab) and only when it
    // each named target is unambiguous: duplicate names stay unresolved and
    // go to the picker; distinct names can be resolved together.
    function uniquelyNamedTargets(text, candidates) {
        var GENERIC = INTAKE_GENERIC_NAME;
        var named = (candidates || []).filter(function (candidate) {
            var name = String(candidate.name || "").toLowerCase().trim();
            if (!name || name === candidate.id || name === String(candidate.type || "").toLowerCase() || GENERIC.test(name)) {
                return false;
            }
            return new RegExp("(^|[^a-z0-9_])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9_]|$)", "i").test(text);
        });
        var byName = {};
        named.forEach(function (candidate) {
            var key = String(candidate.name || "").toLowerCase().trim();
            (byName[key] || (byName[key] = [])).push(candidate);
        });
        var resolved = [];
        Object.keys(byName).forEach(function (key) {
            var matches = byName[key];
            var active = matches.filter(function (candidate) { return candidate.inActiveTab === true; });
            if (active.length === 1) { resolved.push(active[0]); }
            else if (!active.length && matches.length === 1) { resolved.push(matches[0]); }
        });
        var inTab = resolved.filter(function (c) { return c.inActiveTab === true; });
        if (inTab.length) { return inTab.map(function (candidate) { return candidate.id; }); }
        return resolved.map(function (candidate) { return candidate.id; });
    }

    function uniquelyNamedTarget(text, candidates) {
        var ids = uniquelyNamedTargets(text, candidates);
        return ids.length === 1 ? ids[0] : null;
    }

    function buildIntake(message, currentSettings, options) {
        options = options || {};
        var selected = typeof options.activeSelectionIds === "function"
            ? options.activeSelectionIds() : (typeof activeSelectionIds === "function" ? activeSelectionIds() : []);
        selected = Array.isArray(selected) ? selected.slice() : [];
        var tab = options.activeTab || activeTabContext();
        var touched = options.touchedIndex || (typeof conversationTouchedIndex !== "undefined" ? conversationTouchedIndex : null);
        var candidates = (options.candidates || nodeCandidates(tab, message)).slice(0, 6);
        var target = resolveIntakeTarget(message, selected, candidates, touched);
        var flags = intakeFlags(currentSettings, options.oneShotFlags);
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

    function askUserOptions(intake, args) {
        args = args || {};
        if (args.question_kind === "intent") {
            return Array.isArray(args.options) ? args.options.slice() : [];
        }
        if (intake && intake.target && intake.target.kind === "unresolved") {
            return pickerCandidates(intake);
        }
        return Array.isArray(args.options) ? args.options.slice() : [];
    }

    var conversationTouchedIndex = createTouchedNodeIndex();
    var pendingIntake = null;

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            DEFAULT_FLAGS: Object.assign({}, DEFAULT_INTAKE_FLAGS),
            intakeFlags: intakeFlags,
            parseSlashCommand: parseSlashCommand,
            createTouchedNodeIndex: createTouchedNodeIndex,
            activeTabContext: activeTabContext,
            buildIntake: buildIntake,
            resolveIntakeTarget: resolveIntakeTarget,
            uniquelyNamedTargets: uniquelyNamedTargets,
            lockTargetIds: lockTargetIds,
            pickerCandidates: pickerCandidates,
            askUserOptions: askUserOptions,
            nodeCandidates: nodeCandidates
        };
    }
