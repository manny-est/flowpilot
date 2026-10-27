    // SF-4: the diff gate is deliberately a small, data-oriented layer. The
    // run loop owns the pause/resume callbacks; this fragment only turns the
    // run's accumulated RED.history events into a stable touched-node ledger
    // and makes the gate decision. Keeping the decision pure makes it usable
    // by the client loop and by unit tests without a Node-RED instance.

    var DIFF_GATE_DEFAULT_THRESHOLD = 5;

    function getDiffGateThreshold(settings) {
        var n = Number(settings && settings.diffGateThreshold);
        return isFinite(n) && n >= 0 ? Math.floor(n) : DIFF_GATE_DEFAULT_THRESHOLD;
    }

    function diffGateAddNode(map, value, red) {
        if (!value) { return; }
        var node = typeof value === "object" ? value : null;
        var id = node && node.id ? node.id : value;
        if (!id) { return; }
        id = String(id);
        var live = node || (red && red.nodes && red.nodes.node ? red.nodes.node(id) : null);
        if (!live && red && red.nodes && red.nodes.group) { live = red.nodes.group(id); }
        if (!map[id]) {
            map[id] = {
                id: id,
                name: live && live.name ? String(live.name) : "(unnamed)",
                type: live && live.type ? String(live.type) : "(unknown)"
            };
        } else if (live) {
            if (map[id].name === "(unnamed)" && live.name) { map[id].name = String(live.name); }
            if (map[id].type === "(unknown)" && live.type) { map[id].type = String(live.type); }
        }
    }

    function diffGateAddLink(map, link, red) {
        if (!link) { return; }
        diffGateAddNode(map, link.source, red);
        diffGateAddNode(map, link.target, red);
    }

    function diffGateVisitHistoryEvent(map, event, red) {
        if (!event) { return; }
        if (event.t === "multi" && Array.isArray(event.events)) {
            event.events.forEach(function (child) { diffGateVisitHistoryEvent(map, child, red); });
            return;
        }
        if (Array.isArray(event.nodes)) {
            event.nodes.forEach(function (node) { diffGateAddNode(map, node, red); });
        }
        if (event.node) { diffGateAddNode(map, event.node, red); }
        if (Array.isArray(event.groups)) {
            event.groups.forEach(function (group) {
                diffGateAddNode(map, group, red);
                if (group && Array.isArray(group.nodes)) {
                    group.nodes.forEach(function (node) { diffGateAddNode(map, node, red); });
                }
            });
        }
        [event.links, event.removedLinks].forEach(function (links) {
            if (!Array.isArray(links)) { return; }
            links.forEach(function (link) { diffGateAddLink(map, link, red); });
        });
    }

    function deriveDiffGateTouchedNodes(historyEvents, red) {
        var map = {};
        (Array.isArray(historyEvents) ? historyEvents : []).forEach(function (event) {
            diffGateVisitHistoryEvent(map, event, red);
        });
        return Object.keys(map).map(function (id) { return map[id]; });
    }

    function diffGateNormalizeTargets(targets) {
        var map = {};
        (Array.isArray(targets) ? targets : []).forEach(function (id) {
            if (id !== undefined && id !== null && String(id)) { map[String(id)] = true; }
        });
        return map;
    }

    function createDiffGateState(lockedTargets, settings) {
        return {
            lockedTargets: diffGateNormalizeTargets(lockedTargets),
            threshold: getDiffGateThreshold(settings),
            allowedNodeIds: {},
            allowedChangedCount: 0
        };
    }

    // SF-2 can replace this one accessor with its authoritative lock without
    // changing the run loop. Until then, a run locks its starting targets
    // (the request's explicit targets, then its selection context).
    function getRunLockedTargets(payload) {
        payload = payload || {};
        if (Array.isArray(payload.lockedTargets)) { return payload.lockedTargets.slice(); }
        if (Array.isArray(payload.targets)) { return payload.targets.slice(); }
        if (payload.context && Array.isArray(payload.context.nodes)) {
            return payload.context.nodes.map(function (node) { return node && node.id; }).filter(Boolean);
        }
        return [];
    }

    function diffGateDecision(historyEventsOrLedger, lockedTargets, state, settings, red) {
        var rawLedger = Array.isArray(historyEventsOrLedger) && historyEventsOrLedger.length &&
            historyEventsOrLedger[0] && historyEventsOrLedger[0].t
            ? deriveDiffGateTouchedNodes(historyEventsOrLedger, red)
            : (Array.isArray(historyEventsOrLedger) ? historyEventsOrLedger.slice() : []);
        var ledgerById = {};
        rawLedger.forEach(function (node) {
            if (node && node.id && !ledgerById[node.id]) { ledgerById[node.id] = node; }
        });
        var ledger = Object.keys(ledgerById).map(function (id) { return ledgerById[id]; });
        state = state || createDiffGateState(lockedTargets, settings);
        if (lockedTargets) { state.lockedTargets = diffGateNormalizeTargets(lockedTargets); }
        if (state.threshold === undefined) { state.threshold = getDiffGateThreshold(settings); }

        var lockedTargetIds = Object.keys(state.lockedTargets);
        var hasLockedTargets = lockedTargetIds.length > 0;
        var outOfTarget = ledger.filter(function (node) {
            return hasLockedTargets && !state.lockedTargets[node.id] && !state.allowedNodeIds[node.id];
        });
        var newOutOfTarget = outOfTarget.filter(function (node, index, list) {
            return list.indexOf(node) === index;
        });
        var allowance = Math.max(state.threshold, state.allowedChangedCount || 0);
        var thresholdExceeded = ledger.length > allowance;
        var reasons = [];
        if (newOutOfTarget.length) { reasons.push("out-of-target"); }
        if (thresholdExceeded) { reasons.push("threshold"); }

        return {
            pause: reasons.length > 0,
            reason: reasons.join("+") || null,
            touchedNodes: ledger.map(function (node) {
                return Object.assign({}, node, {
                    outOfTarget: hasLockedTargets && !state.lockedTargets[node.id]
                });
            }),
            outOfTargetNodes: newOutOfTarget,
            changedNodeCount: ledger.length,
            threshold: state.threshold,
            allowance: allowance,
            state: state
        };
    }

    // Keep going accepts the complete current diff. Future writes still gate
    // when they add a new node or exceed the newly raised count allowance.
    function diffGateKeepGoing(state, decision) {
        state = state || {};
        decision = decision || { touchedNodes: [], changedNodeCount: 0 };
        state.allowedNodeIds = state.allowedNodeIds || {};
        (decision.touchedNodes || []).forEach(function (node) {
            if (node && node.id) { state.allowedNodeIds[node.id] = true; }
        });
        state.allowedChangedCount = Math.max(state.allowedChangedCount || 0, decision.changedNodeCount || 0);
        return state;
    }

    function diffGateHistoryMarker(red) {
        var history = red && red.history;
        if (!history) { return null; }
        var list = history.list;
        if (typeof list === "function") {
            try { list = list.call(history); } catch (e) { list = null; }
        }
        var length = Array.isArray(list) ? list.length : (typeof history.length === "number" ? history.length : "?");
        var depth = typeof history.depth === "number" ? history.depth : "?";
        var index = typeof history.index === "number" ? history.index : "?";
        return String(length) + ":" + String(depth) + ":" + String(index);
    }

    function diffGateNodeSnapshot(node) {
        if (!node || !node.id) { return null; }
        var snapshot = { id: node.id };
        Object.keys(node).sort().forEach(function (key) {
            var value = node[key];
            if (key === "_def" || key === "wires" || typeof value === "function") { return; }
            if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
                snapshot[key] = value;
            }
        });
        return snapshot;
    }

    function diffGateGraphMarker(red) {
        if (!red || !red.nodes) { return null; }
        var nodes = [];
        if (typeof red.nodes.eachNode === "function") {
            red.nodes.eachNode(function (node) {
                var snapshot = diffGateNodeSnapshot(node);
                if (snapshot) { nodes.push(snapshot); }
            });
        }
        nodes.sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
        var links = [];
        if (typeof red.nodes.eachLink === "function") {
            red.nodes.eachLink(function (link) {
                if (!link || !link.source || !link.target) { return; }
                links.push({ from: link.source.id, port: link.sourcePort || 0, to: link.target.id });
            });
        }
        links.sort(function (a, b) {
            return (String(a.from) + ":" + a.port + ":" + String(a.to)).localeCompare(String(b.from) + ":" + b.port + ":" + String(b.to));
        });
        return JSON.stringify({ nodes: nodes, links: links });
    }

    function captureDiffGateRunMarker(red) {
        return { history: diffGateHistoryMarker(red), graph: diffGateGraphMarker(red) };
    }

    function diffGateHasMidRunEdit(red, expectedMarker) {
        if (!expectedMarker) { return false; }
        var current = captureDiffGateRunMarker(red);
        return current.history !== expectedMarker.history || current.graph !== expectedMarker.graph;
    }

    // The accumulator is not flushed until the run ends. To undo a paused run
    // immediately, put the same compound event on Node-RED's native history
    // stack and use its own inverse implementation. This keeps deletes,
    // wires, groups, and future editor event shapes correct in one place.
    function undoDiffGateRun(red, historyEvents) {
        if (!red || !red.history || !Array.isArray(historyEvents) || !historyEvents.length) { return false; }
        var event = historyEvents.length === 1 ? historyEvents[0] : { t: "multi", events: historyEvents.slice() };
        if (typeof red.history.push !== "function" || typeof red.history.undo !== "function") { return false; }
        red.history.push(event);
        red.history.undo();
        return true;
    }
