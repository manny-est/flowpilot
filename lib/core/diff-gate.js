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

    // A wire is stored on its source node, so only the source changes; the
    // target's own config is untouched.
    function diffGateAddLink(map, link, red) {
        if (!link) { return; }
        diffGateAddNode(map, link.source, red);
    }

    function diffGateVisitHistoryEvent(map, event, red) {
        if (!event) { return; }
        if (event.t === "multi" && Array.isArray(event.events)) {
            event.events.forEach(function (child) { diffGateVisitHistoryEvent(map, child, red); });
            return;
        }
        if (Array.isArray(event.nodes)) {
            event.nodes.forEach(function (node) {
                diffGateAddNode(map, node, red);
                // Nodes this run created are bounded by the threshold, never
                // "outside the target": adding next to a target is in scope.
                if (event.t === "add") {
                    var addedId = node && typeof node === "object" ? node.id : node;
                    if (addedId && map[String(addedId)]) { map[String(addedId)].created = true; }
                }
            });
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
        // Deleting a node drops its wires with it. That is part of the
        // delete, not an edit to the node on the other end, so a wire whose
        // endpoint this event deleted doesn't count its source as touched
        // (deleting a target's only output wire falsely paused the run).
        var deletedIds = {};
        if (event.t === "delete" && Array.isArray(event.nodes)) {
            event.nodes.forEach(function (node) {
                var deletedId = node && typeof node === "object" ? node.id : node;
                if (deletedId) { deletedIds[String(deletedId)] = true; }
            });
        }
        function endpointId(end) {
            return end && typeof end === "object" ? end.id : end;
        }
        [event.links, event.removedLinks].forEach(function (links) {
            if (!Array.isArray(links)) { return; }
            links.forEach(function (link) {
                if (link && (deletedIds[String(endpointId(link.source))] ||
                    deletedIds[String(endpointId(link.target))])) { return; }
                diffGateAddLink(map, link, red);
            });
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

    // The run's locked targets: SF-2's target lock when present, else the
    // request's explicit targets, else its selection context.
    function getRunLockedTargets(payload) {
        payload = payload || {};
        if (payload.targetLock && Array.isArray(payload.targetLock.ids) && payload.targetLock.ids.length) {
            return payload.targetLock.ids.slice();
        }
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
            return hasLockedTargets && !node.created && !state.lockedTargets[node.id] && !state.allowedNodeIds[node.id];
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
                    outOfTarget: hasLockedTargets && !node.created && !state.lockedTargets[node.id]
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

    // Mid-run edit detection reads Node-RED's own undo history: every user
    // edit (move, edit dialog, delete, wire, Ctrl+Z) changes its length or its
    // top entry (replace() swaps the top in place, so identity is compared
    // too). The run's own writes go to the run accumulator, not RED.history,
    // until the run ends. Node property snapshots are deliberately NOT used:
    // selection, deploy and status flip flags like selected/dirty/changed,
    // which would read as user edits.
    function diffGateHistoryState(red) {
        var history = red && red.history;
        if (!history) { return null; }
        var list = null;
        if (typeof history.list === "function") {
            try { list = history.list(); } catch (e) { list = null; }
        }
        var top = null;
        if (typeof history.peek === "function") {
            try { top = history.peek(); } catch (e) { top = null; }
        }
        var length = Array.isArray(list) ? list.length
            : (typeof history.depth === "function" ? history.depth() : null);
        return { length: length, top: top };
    }
    function captureDiffGateRunMarker(red) {
        return diffGateHistoryState(red);
    }
    function diffGateHasMidRunEdit(red, expectedMarker) {
        if (!expectedMarker) { return false; }
        var current = diffGateHistoryState(red);
        if (!current) { return false; }
        return current.length !== expectedMarker.length || current.top !== expectedMarker.top;
    }
    // The accumulator is not flushed until the run ends. To undo a paused run
    // immediately, put the same compound event on Node-RED's native history
    // stack and use its own inverse implementation. This keeps deletes,
    // wires, groups, and future editor event shapes correct in one place.
    function undoDiffGateRun(red, historyEvents) {
        if (!red || !red.history || !Array.isArray(historyEvents) || !historyEvents.length) { return false; }
        var event = historyEvents.length === 1 ? historyEvents[0] : { t: "multi", events: historyEvents.slice() };
        // Node-RED 5.x undoes with RED.history.pop() ("core:undo" is bound to
        // it); undo is not exposed as a history.undo method. Live-found: the
        // old call was skipped and the run was reported undone while its
        // nodes stayed.
        var undoFn = typeof red.history.pop === "function" ? red.history.pop : null;
        if (typeof red.history.push !== "function" || !undoFn) { return false; }
        red.history.push(event);
        undoFn.call(red.history);
        return true;
    }
