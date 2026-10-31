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

    function slashCommandIntent(raw) {
        var parsed = parseSlashCommand(raw) || { command: "", rest: "" };
        var modes = { "/generate": "generate", "/build": "build", "/plan": "plan",
            "/document": "document", "/modify": "modify" };
        return { command: parsed.command, rest: parsed.rest, mode: modes[parsed.command] || null,
            send: !!(modes[parsed.command] && parsed.rest) };
    }

    var EMPTY_NODE_TYPE_OPTIONS = ["inject", "debug", "function", "change", "http request", "Other"];

    function emptyRequestAction(message, candidates) {
        var text = String(message || "").trim();
        var hasCandidates = Array.isArray(candidates) && candidates.length > 0;
        if (!hasCandidates && /^(?:add|create|insert|make)\s+(?:a|an|one)?\s*node(?:\s+please)?[.!?]*$/i.test(text)) {
            return { kind: "node-type", options: EMPTY_NODE_TYPE_OPTIONS.slice() };
        }
        if (/^\/?modify\b/i.test(text) || (!text && !hasCandidates)) {
            return { kind: "modify-empty", message: "Select the node(s) to change, then send again." };
        }
        return null;
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

    function nodeCandidates(tab, message, selectionIds) {
        if (typeof RED === "undefined" || !RED.nodes ||
                (!RED.nodes.eachNode && !RED.nodes.eachGroup)) { return []; }
        var activeId = tab && tab.id;
        var selected = Array.isArray(selectionIds) ? selectionIds : [];
        var lower = String(message || "").toLowerCase();
        var matched = [];
        var tabNodes = [];
        var selectedNodes = [];
        function addCandidate(node) {
            if (!node || !node.id || node.type === "tab") { return; }
            var inTab = !!activeId && node.z === activeId;
            var inSelection = selected.indexOf(node.id) !== -1;
            // Name resolution is instance-wide so duplicate names on other
            // tabs can become an honest picker. Unrelated off-tab nodes are
            // still excluded below because only name/type matches enter the
            // matched list; the fallback remains the active tab.
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
            if (score > 0) {
                matched.push({ c: candidate, score: score + (inTab ? 10 : 0), realName: realName });
            }
            if (inTab) { tabNodes.push(candidate); }
            if (inSelection) { selectedNodes.push(candidate); }
        }
        if (RED.nodes.eachNode) { RED.nodes.eachNode(addCandidate); }
        // Groups are not returned by eachNode in Node-RED 5. A named group is
        // still a first-class target, so visit the separate group registry
        // when the editor exposes it.
        if (RED.nodes.eachGroup) { RED.nodes.eachGroup(addCandidate); }
        if (matched.length) {
            var nameCounts = {};
            matched.forEach(function (entry) {
                if (entry.realName) {
                    var key = String(entry.c.name || "").toLowerCase().trim();
                    nameCounts[key] = (nameCounts[key] || 0) + 1;
                }
            });
            // A real name the user typed counts on any tab: "rename Second
            // output" from tab one means that node (prompt fuzzer: ~10 misses).
            // Unnamed off-tab nodes still never become picker choices (SF-7).
            matched = matched.filter(function (entry) {
                return entry.c.inActiveTab || entry.realName;
            });
            if (matched.length) {
                matched.sort(function (x, y) { return y.score - x.score; });
                return matched.map(function (m) { return m.c; });
            }
        }
        return tabNodes.concat(selectedNodes.filter(function (candidate) {
            return !tabNodes.some(function (tabCandidate) { return tabCandidate.id === candidate.id; });
        })).slice(0, 6);
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
        // A typo in a node's name ("Temprature sensor", "Grouped triger") still
        // names it, but only when exactly one candidate is that close (prompt
        // fuzzer: these got a "Which node?" picker).
        var fuzzyIds = fuzzyNamedTargets(text, candidates);
        if (fuzzyIds.length === 1) { return { kind: "named", ids: fuzzyIds, fuzzy: true }; }
        // "Fix the weather flow", "this flow": the flow on the active tab.
        if (/\b(?:the|this|my|that)\s+(?:[a-z0-9_-]+\s+){0,2}flow\b/i.test(text) &&
                !/\b(?:new|another|a)\s+(?:[a-z0-9_-]+\s+){0,2}flow\b/i.test(text)) {
            var tabIds = (candidates || []).filter(function (c) { return c && c.inActiveTab === true && c.id; })
                .map(function (c) { return c.id; });
            if (tabIds.length) { return { kind: "tab", ids: tabIds }; }
        }
        return { kind: "unresolved", ids: [] };
    }

    function intakeEditDistance(a, b) {
        var prev = [], cur, i, j;
        for (j = 0; j <= b.length; j++) { prev[j] = j; }
        for (i = 1; i <= a.length; i++) {
            cur = [i];
            for (j = 1; j <= b.length; j++) {
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
            prev = cur;
        }
        return prev[b.length];
    }

    function fuzzyNamedTargets(text, candidates) {
        var words = String(text || "").toLowerCase().replace(/[^a-z0-9_ ]+/g, " ").split(/\s+/).filter(Boolean);
        var hits = [];
        (candidates || []).forEach(function (candidate) {
            var name = String(candidate && candidate.name || "").toLowerCase().trim();
            if (!name || name.length < 5 || name === candidate.id || INTAKE_GENERIC_NAME.test(name)) { return; }
            var nameWords = name.replace(/[^a-z0-9_ ]+/g, " ").split(/\s+/).filter(Boolean);
            var n = nameWords.length;
            var limit = name.length <= 8 ? 1 : 2;
            for (var i = 0; i + n <= words.length; i++) {
                var window = words.slice(i, i + n).join(" ");
                if (window !== name && Math.abs(window.length - name.length) <= limit &&
                        intakeEditDistance(window, name) <= limit) {
                    if (hits.indexOf(candidate.id) === -1) { hits.push(candidate.id); }
                    return;
                }
            }
        });
        return hits;
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
        // Every distinct name the message resolves is a target, wherever it
        // is (same-name duplicates were already settled per name above).
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
        var allCandidates = options.candidates || nodeCandidates(tab, message, selected);
        var candidates = allCandidates.slice(0, 6);
        var target = resolveIntakeTarget(message, selected, allCandidates, touched);
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
            allCandidates: allCandidates,
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

    // R4-A: creation is about the user's intent, not whether the current tab
    // happens to contain nodes. Keep this pure so the browser, server and
    // engine corpus all make the same decision.
    function idsFromTouchedSnapshot(touchedIndex) {
        if (!touchedIndex) { return []; }
        if (typeof touchedIndex.resolveRecent === "function") {
            return touchedIndex.resolveRecent(2).slice();
        }
        if (Array.isArray(touchedIndex.nodeIds)) { return touchedIndex.nodeIds.slice(); }
        var runs = Array.isArray(touchedIndex.runs) ? touchedIndex.runs : [];
        var latest = runs[runs.length - 1];
        return latest && Array.isArray(latest.nodeIds) ? latest.nodeIds.slice() : [];
    }

    function uniqueIds(ids) {
        var seen = {};
        return (Array.isArray(ids) ? ids : []).filter(function (id) {
            if (typeof id !== "string" || !id || seen[id]) { return false; }
            seen[id] = true;
            return true;
        });
    }

    function additiveWording(text) {
        text = String(text || "").toLowerCase();
        return /\b(?:also|too|log\s+it|and\s+add)\b/.test(text) ||
            /\badd\b[\s\S]*\b(?:after|before|to|next\s+to)\b/.test(text) ||
            /\badd\s+(?:a|an|the)?\s*comment(?:\s+node)?\s+(?:explaining|describing|about|for)\s+(?:the|this|that|my)\s+flow\b/.test(text) ||
            /\badd\b[\s\S]*\b(?:to|on|for|in)\s+(?:it|this|that|(?:the|this|that|my)\s+(?:flow|one))\b/.test(text) ||
            /\b(?:insert|place)\b[\s\S]*\b(?:after|before|next\s+to)\b/.test(text);
    }

    function standaloneCreationWording(text) {
        text = String(text || "").toLowerCase();
        return /\b(?:new|fresh|standalone|from\s+scratch|whole)\s+flow\b/.test(text) ||
            /\b(?:build|make|create|generate|set\s+up|start)\b[\s\S]*\bflow\b/.test(text) ||
            /\bflow\s+(?:that|which)\b/.test(text) ||
            /\b(?:fetch|get|poll|retrieve|watch)\b[\s\S]*\b(?:every|each)\b/.test(text);
    }

    // In the editor, a weak anchor counts only if that node is on the active
    // tab. The server (no editor registry) can't tell, so it says no and the
    // request needs additive wording.
    function anchorOnActiveTab(id, request) {
        if (request && typeof request.activeTabId === "string") {
            var tabOf = request.nodeTab && typeof request.nodeTab === "function" ? request.nodeTab(id) : null;
            return !!tabOf && tabOf === request.activeTabId;
        }
        if (typeof RED === "undefined" || !RED || !RED.nodes || typeof RED.nodes.node !== "function" ||
                !RED.workspaces || typeof RED.workspaces.active !== "function") { return false; }
        var node = RED.nodes.node(id);
        return !!node && node.z === RED.workspaces.active();
    }

    function classifyEditIntent(request) {
        request = request || {};
        var message = String(request.message || request.prompt || "").trim();
        var action = String(request.action || request.entry || "").toLowerCase();
        var isCreationAction = ["create", "build", "generate"].indexOf(action) !== -1;
        var selectionIds = request.selectionIds || request.activeSelectionIds || request.targets;
        var namedIds = request.namedTargetIds || request.namedIds;
        var inherited = request.inheritedRun || request.inheritedRunContext || null;
        var inheritedLock = inherited && inherited.targetLock;
        var inheritedIds = inheritedLock && inheritedLock.ids;
        var anchorIds = uniqueIds(selectionIds);
        var strongAnchor = anchorIds.length > 0;
        if (!anchorIds.length) { anchorIds = uniqueIds(namedIds); strongAnchor = anchorIds.length > 0; }
        // Touched/inherited ids are weak anchors: they're the conversation's
        // last work, possibly on another tab.
        var weakIds = [];
        if (!anchorIds.length) { weakIds = uniqueIds(idsFromTouchedSnapshot(request.touchedIndex)); }
        if (!anchorIds.length && !weakIds.length) { weakIds = uniqueIds((Array.isArray(inheritedIds) && inheritedIds.length) ? inheritedIds : (inherited && inherited.nodeIds)); }
        var weakOnActiveTab = weakIds.filter(function (id) { return anchorOnActiveTab(id, request); });
        var explicitCreation = standaloneCreationWording(message);
        var wordedAdditive = additiveWording(message);
        var additive = false;
        if (isCreationAction && !explicitCreation) {
            if (strongAnchor) {
                additive = true;
            } else if (wordedAdditive && weakIds.length) {
                // "also add a comment" clearly means the work just done
                // (a queued message inherits its run's tab).
                additive = true;
                anchorIds = weakIds;
            } else if (weakOnActiveTab.length) {
                // Neither clear: prefer additive only when the conversation's
                // last work is on the tab the user is looking at.
                additive = true;
                anchorIds = weakOnActiveTab;
            }
        }
        return {
            kind: additive ? "additive" : "creation",
            additive: additive,
            creation: !additive,
            targetIds: anchorIds,
            anchor: anchorIds.length ? "selection-or-name-or-touched-or-inherited" : null
        };
    }

    function creationRunForAction(action) {
        var args = action || {};
        if (["generate", "build", "create"].indexOf(String(args.action || "").toLowerCase()) === -1) {
            return false;
        }
        return classifyEditIntent({
            action: args.action,
            message: args.summary || args.prompt,
            selectionIds: args.targets,
            namedTargetIds: args.namedTargetIds,
            touchedIndex: args.touchedIndex,
            inheritedRun: args.inheritedRun || args.inheritedRunContext
        }).creation;
    }

    function cloneJson(value, fallback) {
        if (value === undefined || value === null) { return fallback; }
        try { return JSON.parse(JSON.stringify(value)); } catch (e) { return fallback; }
    }

    function snapshotRunContext(run) {
        run = run || {};
        var context = run.context || {};
        var intake = run.intake || {};
        var activeTab = context.activeTab || intake.activeTab || { id: null, label: "(unknown tab)" };
        var touched = context.touchedNodeIndex || intake.touchedNodeIndex || { run: 0, runs: [] };
        var targetLock = run.targetLock || { ids: [], labels: [] };
        return {
            runId: run.runId || null,
            context: {
                activeTab: cloneJson(activeTab, { id: null, label: "(unknown tab)" }),
                touchedNodeIndex: cloneJson(touched, { run: 0, runs: [] })
            },
            touchedNodeIndex: cloneJson(touched, { run: 0, runs: [] }),
            targetLock: cloneJson(targetLock, { ids: [], labels: [] }),
            inheritedRun: {
                runId: run.runId || null,
                targetLock: cloneJson(targetLock, { ids: [], labels: [] }),
                nodeIds: uniqueIds(targetLock.ids)
            }
        };
    }

    function queuedRunDispatch(entry, choice) {
        entry = entry || {};
        var snapshot = entry.runContext || {};
        var context = cloneJson(snapshot.context, { activeTab: { id: null, label: "(unknown tab)" }, touchedNodeIndex: { run: 0, runs: [] } });
        var targetLock = cloneJson(snapshot.targetLock, { ids: [], labels: [] });
        return {
            prompt: entry.text || "",
            choice: choice || null,
            context: context,
            targetLock: targetLock,
            inheritedRun: cloneJson(snapshot.inheritedRun, { runId: null, targetLock: targetLock, nodeIds: [] }),
            intake: {
                message: entry.text || "",
                activeTab: cloneJson(context.activeTab, { id: null, label: "(unknown tab)" }),
                touchedNodeIndex: cloneJson(snapshot.touchedNodeIndex || context.touchedNodeIndex, { run: 0, runs: [] }),
                targetIds: uniqueIds(targetLock.ids),
                target: { kind: "inherited-run", ids: uniqueIds(targetLock.ids) },
                inheritedRun: cloneJson(snapshot.inheritedRun, null)
            }
        };
    }

    function createQueueChoiceState() {
        var state = { disabled: false };
        state.choose = function (callback) {
            if (state.disabled) { return false; }
            state.disabled = true;
            if (typeof callback === "function") { callback(); }
            return true;
        };
        return state;
    }

    // Agent continuation requests are stateless, so each step re-sends the
    // whole transcript; on a long conversation (e.g. after two clarifying
    // questions) that multiplied the cumulative token count past the ceiling
    // before the build's first step (R4-A Spark trace). Compaction keeps the
    // system message, every earlier user and assistant TEXT (truncated, so
    // the original request and clarifying answers survive) and the current
    // turn's tool transcript intact. Only earlier tool transcripts go: their
    // tool messages and the tool_calls that requested them, together, so no
    // tool message is ever left without its call.
    var COMPACT_TEXT_LIMIT = 600;
    function compactAgentContinuationMessages(messages) {
        if (!Array.isArray(messages) || messages.length < 3) { return messages || []; }
        var firstToolCall = -1;
        for (var i = 1; i < messages.length; i++) {
            if (messages[i] && messages[i].role === "assistant" && Array.isArray(messages[i].tool_calls)) {
                firstToolCall = i;
                break;
            }
        }
        if (firstToolCall < 1) { return messages.slice(); }
        var currentUser = -1;
        for (var j = firstToolCall - 1; j >= 0; j--) {
            if (messages[j] && messages[j].role === "user") { currentUser = j; break; }
        }
        if (currentUser <= 0) { return messages.slice(); }
        var earlier = [];
        for (var k = 1; k < currentUser; k++) {
            var m = messages[k];
            if (!m || m.role === "tool") { continue; }
            if (m.role !== "user" && m.role !== "assistant") { continue; }
            var text = typeof m.content === "string" ? m.content : "";
            if (!text.trim()) { continue; }
            if (text.length > COMPACT_TEXT_LIMIT) { text = text.slice(0, COMPACT_TEXT_LIMIT) + " …"; }
            earlier.push({ role: m.role, content: text });
        }
        return [messages[0]].concat(earlier, messages.slice(currentUser));
    }

    function pickerCandidates(intake) {
        var candidates = intake && Array.isArray(intake.candidates) ? intake.candidates : [];
        var seen = {};
        var labels = [];
        candidates.slice(0, 6).forEach(function (candidate) {
            var label = (candidate.name || candidate.id) + " [" + candidate.type + "]";
            var key = label.toLowerCase();
            if (seen[key]) { return; }
            seen[key] = true;
            labels.push(label);
        });
        return labels.concat(["Something else (describe it)"]);
    }

    function askUserOptions(intake, args) {
        args = args || {};
        if (args.question_kind === "target") {
            return pickerCandidates(intake);
        }
        if (args.question_kind === "intent") {
            return Array.isArray(args.options) ? args.options.slice() : [];
        }
        if (Array.isArray(args.options) && args.options.length) {
            return args.options.slice();
        }
        if (intake && intake.target && intake.target.kind === "unresolved") {
            return pickerCandidates(intake);
        }
        return [];
    }

    var conversationTouchedIndex = createTouchedNodeIndex();
    var pendingIntake = null;

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            DEFAULT_FLAGS: Object.assign({}, DEFAULT_INTAKE_FLAGS),
            intakeFlags: intakeFlags,
            parseSlashCommand: parseSlashCommand,
            slashCommandIntent: slashCommandIntent,
            emptyRequestAction: emptyRequestAction,
            createTouchedNodeIndex: createTouchedNodeIndex,
            activeTabContext: activeTabContext,
            buildIntake: buildIntake,
            resolveIntakeTarget: resolveIntakeTarget,
            uniquelyNamedTargets: uniquelyNamedTargets,
            lockTargetIds: lockTargetIds,
            pickerCandidates: pickerCandidates,
            askUserOptions: askUserOptions,
            nodeCandidates: nodeCandidates,
            classifyEditIntent: classifyEditIntent,
            creationRunForAction: creationRunForAction,
            snapshotRunContext: snapshotRunContext,
            queuedRunDispatch: queuedRunDispatch,
            createQueueChoiceState: createQueueChoiceState,
            compactAgentContinuationMessages: compactAgentContinuationMessages
        };
    }
