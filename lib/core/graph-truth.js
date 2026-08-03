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

    function nodeExists(id) {
        return !!RED.nodes.node(id);
    }

    function nodeAbsent(id) {
        return !RED.nodes.node(id);
    }

    function propertyEquals(id, key, want) {
        var node = RED.nodes.node(id);
        return !!node && node[key] === want;
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
