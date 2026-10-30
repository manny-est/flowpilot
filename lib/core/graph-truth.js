    // P10-E (ADR-005): the single implementation of graph truth. Every
    // verification consumer — runSingleVerifyCheck's per-check-type
    // dispatch (modes.js), the WRITE-tool tool_result checks
    // (runChecksForToolResult, main.js), verifyImportedNodes (modes.js),
    // and group_nodes's post-check (main.js) — delegates here instead of
    // re-reading RED.nodes/RED.nodes.eachLink locally. Wires are read
    // exclusively via RED.nodes.eachLink, never node.wires: addLink/
    // removeLink never re-sync a live node's own .wires array mid-session
    // (CLAUDE-010 — the drift this module exists to prevent from
    // recurring). Diff computation (apply-review.js's computeWireDiff and
    // its own eachLink scans) is a different concern — "what changed" vs.
    // "is this true right now" — and stays out of scope per ADR-005.

    // Groups live outside RED.nodes.node() (Node-RED keeps them in
    // RED.nodes.group()), so a check against a group id — group_nodes'
    // own "exists" and "name" checks — always failed before this lookup.
    function liveGraphItem(id) {
        return RED.nodes.node(id) || (RED.nodes.group ? RED.nodes.group(id) : null) || null;
    }

    function nodeExists(id) {
        return !!liveGraphItem(id);
    }

    function nodeAbsent(id) {
        return !liveGraphItem(id);
    }

    function propertyEquals(id, key, want) {
        var node = liveGraphItem(id);
        return !!node && node[key] === want;
    }

    // Read-only counterpart to propertyEquals, for diagnostics that need to
    // show the actual current value alongside the expected one (CLAUDE-018)
    // rather than just a boolean match. Returns { exists, value } — value is
    // undefined when the node doesn't exist so callers can tell "no node"
    // apart from "property is actually undefined".
    function readProperty(id, key) {
        var node = liveGraphItem(id);
        return { exists: !!node, value: node ? node[key] : undefined };
    }

    function wireExists(fromId, port, toId) {
        var found = false;
        RED.nodes.eachLink(function (l) {
            if (found) { return; }
            if (l.source && l.source.id === fromId &&
                    (l.sourcePort || 0) === (port || 0) &&
                    l.target && l.target.id === toId) {
                found = true;
            }
        });
        return found;
    }

    function wireAbsent(fromId, port, toId) {
        return !wireExists(fromId, port, toId);
    }

    // Read back the exact wire requests made by a run from the live link
    // registry.  The request may still use a model placeholder id; callers
    // provide the run's placeholder -> editor id map.  This is intentionally
    // independent of node.wires: Node-RED's addNode does not create links
    // from that property, and it can therefore describe a link that is not on
    // the canvas.
    function readWireOutcome(expected, idMap) {
        var connected = [];
        var failed = [];
        var seen = {};
        var map = idMap || {};
        function resolve(id) { return map[id] || id; }
        function liveName(id, fallback) {
            var node = liveGraphItem(resolve(id));
            if (node) { return node.name || node.type || fallback || "a node that wasn't created"; }
            return fallback || "a node that wasn't created";
        }
        function key(wire) {
            return String(wire.from) + "\u0000" + String(wire.fromPort || 0) + "\u0000" + String(wire.to);
        }
        (Array.isArray(expected) ? expected : []).forEach(function (wire) {
            if (!wire || !wire.from || !wire.to || seen[key(wire)]) { return; }
            seen[key(wire)] = true;
            var fromId = resolve(wire.from);
            var toId = resolve(wire.to);
            var fromName = liveName(wire.from, wire.fromName);
            var toName = liveName(wire.to, wire.toName);
            var record = {
                from: wire.from,
                fromPort: wire.fromPort || 0,
                to: wire.to,
                fromId: fromId,
                toId: toId,
                fromName: fromName,
                toName: toName
            };
            if (wireExists(fromId, wire.fromPort || 0, toId)) {
                connected.push(record);
            } else {
                record.reason = "Not connected: " + fromName + " \u2192 " + toName;
                failed.push(record);
            }
        });
        return { connected: connected, pending: [], failed: failed };
    }

    // ids: a single node id or an array of ids — true only if every one of
    // them currently belongs to groupId (per its live .g ref).
    function groupContains(groupId, ids) {
        var list = Array.isArray(ids) ? ids : [ids];
        if (!list.length) { return false; }
        return list.every(function (id) {
            var node = RED.nodes.node(id);
            return !!node && node.g === groupId;
        });
    }
