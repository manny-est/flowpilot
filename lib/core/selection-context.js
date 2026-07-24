    // Resolves the node-selection context that would actually be sent right
    // now: the live canvas selection, or (while an Execute action is armed
    // with nothing currently selected) the pinned selection from when it was
    // armed. Used by "Preview JSON" so it can never show different context
    // than what Send actually uses.
    function resolveCurrentSelectionContext() {
        var sel = (RED.view && RED.view.selection) ? RED.view.selection() : null;
        var liveCount = (sel && sel.nodes) ? sel.nodes.length : 0;
        if (liveCount > 0) { return collectSelectionContext(); }
        if (armedExecuteAction && pinnedSelectionIds) {
            return collectSelectionContext(pinnedSelectionIds);
        }
        return null;
    }

    // Clicking a group's border/background in the editor selects the GROUP
    // itself — one object, type:"group" — not its members; RED.view.selection()
    // returns exactly that one entry, same as selecting a single regular
    // node. For context/counting purposes the user means "everything
    // inside it," so expand any group entries into their real member
    // nodes via RED.group.getNodes(group, recursive, excludeGroup) — the
    // editor's own public API for this (recursive: descend into nested
    // sub-groups too; excludeGroup: only real nodes in the result, not
    // the nested group containers themselves — nesting still isn't
    // authored by FlowPilot, but a member node of one shouldn't vanish
    // from context just because it's nested one level deeper).
    // Returns { nodes: [...real nodes, deduped], groupCount } so callers
    // needing just ids and callers needing the group count (the status
    // strip) share one expansion instead of two slightly different ones.
    function expandGroupSelection(rawNodes) {
        var expanded = [];
        var seen = {};
        var groupCount = 0;
        (rawNodes || []).forEach(function (n) {
            if (!n) { return; }
            if (n.type === "group") {
                groupCount++;
                var members = (RED.group && RED.group.getNodes) ? RED.group.getNodes(n, true, true) : [];
                members.forEach(function (m) {
                    if (m && !seen[m.id]) { seen[m.id] = true; expanded.push(m); }
                });
            } else if (!seen[n.id]) {
                seen[n.id] = true; expanded.push(n);
            }
        });
        return { nodes: expanded, groupCount: groupCount };
    }

    function pinCurrentSelection() {
        var sel = (RED.view && RED.view.selection) ? RED.view.selection() : null;
        var ids = expandGroupSelection((sel && sel.nodes) ? sel.nodes : []).nodes
            .map(function (n) { return n.id; });
        if (ids.length) { pinnedSelectionIds = ids; }
    }

    // The node ids to use for context: the live selection if non-empty,
    // else the pinned selection from earlier in this armed session (or null
    // if neither — Generate works fine with no context).
    function activeSelectionIds() {
        var sel = (RED.view && RED.view.selection) ? RED.view.selection() : null;
        var liveIds = (sel && sel.nodes && sel.nodes.length)
            ? expandGroupSelection(sel.nodes).nodes.map(function (n) { return n.id; })
            : null;
        return (liveIds && liveIds.length ? liveIds : null) || pinnedSelectionIds;
    }

    // ---- Selection context -------------------------------------------------
    // We read the user's current node selection and build a context payload
    // to send to the AI: sanitized node configs (sanitizeNode, lib/core/
    // redaction.js) plus their wiring (buildConnections below). Nothing is
    // sent unless the user has an active selection — staying within
    // "user-initiated" and "complete visibility".

    // Build readable connections from the editor's LIVE wiring model.
    // Important: in the editor, node.wires is NOT populated — that's an
    // export-time artifact. Live wiring lives as separate link objects, which
    // RED.view.selection() hands us in sel.links. Each link is already an
    // explicit edge: { source: <node>, sourcePort: <int>, target: <node> }.
    // This handles multi-output and multi-input naturally — each is just
    // another link object.
    function nodeLabel(n) {
        if (!n) { return "(unknown node)"; }
        var nm = (n.name && n.name.length) ? n.name : "(unnamed)";
        return nm + " [" + n.type + "]";
    }

    function buildConnections(nodes, links) {
        var selectedIds = nodes.map(function (n) { return n.id; });
        links = Array.isArray(links) ? links : [];

        var edges = links.map(function (l) {
            var srcId = l.source && l.source.id;
            var tgtId = l.target && l.target.id;
            return {
                fromId: srcId,
                from: nodeLabel(l.source),
                fromPort: (typeof l.sourcePort === "number") ? l.sourcePort : 0,
                toId: tgtId,
                to: nodeLabel(l.target),
                sourceInSelection: selectedIds.indexOf(srcId) !== -1,
                targetInSelection: selectedIds.indexOf(tgtId) !== -1
            };
        });

        // Group selected nodes into connected sub-flows (undirected connected
        // components over the links). This turns "are these separate flows?"
        // from a reasoning task into a lookup for the model. Two nodes share a
        // group if a link connects them either way; an unlinked selected node
        // forms its own group.
        var parent = {};
        nodes.forEach(function (n) { parent[n.id] = n.id; });
        function find(x) {
            while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        }
        edges.forEach(function (e) {
            if (parent[e.fromId] === undefined || parent[e.toId] === undefined) { return; }
            parent[find(e.fromId)] = find(e.toId);
        });
        var rootToGroup = {};
        var nextGroup = 1;
        var groupOf = {};
        nodes.forEach(function (n) {
            var r = find(n.id);
            if (rootToGroup[r] === undefined) { rootToGroup[r] = nextGroup++; }
            groupOf[n.id] = rootToGroup[r];
        });
        var subFlowCount = nextGroup - 1;

        // Per-node summary of inputs and outputs, reconstructed from edges so
        // multi-input nodes are legible without the model cross-referencing.
        // Each node is tagged with its sub-flow group.
        var perNode = nodes.map(function (n) {
            var outs = edges.filter(function (e) { return e.fromId === n.id; })
                            .map(function (e) { return "port " + e.fromPort + " -> " + e.to; });
            var ins = edges.filter(function (e) { return e.toId === n.id; })
                           .map(function (e) { return e.from + " (port " + e.fromPort + ")"; });
            return { node: nodeLabel(n), subFlow: groupOf[n.id], inputs: ins, outputs: outs };
        });

        // B4: "edges" and "perNode" otherwise duplicate the same from/to
        // labels — perNode already carries the readable "Name [type]" labels,
        // so trim edges down to ids + port + selection flags (the part
        // perNode doesn't have) to avoid sending the same labels twice.
        var compactEdges = edges.map(function (e) {
            return {
                fromId: e.fromId,
                fromPort: e.fromPort,
                toId: e.toId,
                sourceInSelection: e.sourceInSelection,
                targetInSelection: e.targetInSelection
            };
        });

        return { edges: compactEdges, perNode: perNode, subFlowCount: subFlowCount };
    }

    // Returns { nodes, connections } or null if nothing selected.
    // With nodeIds (an array of node ids — e.g. a pinned selection),
    // builds context from those live nodes via RED.nodes instead of the
    // current view selection. Nodes that no longer exist are dropped; links
    // are gathered from the workspace's full link list, same shape as
    // RED.view.selection().links (sourceInSelection/targetInSelection in
    // buildConnections still works against this nodeIds set).
    // Gathers every link touching any node in the given list, scanning the
    // workspace's full link set directly rather than trusting
    // RED.view.selection().links — needed whenever the node list didn't
    // come from a literal click-drag selection (an explicit nodeIds array,
    // or a group's expanded membership, whose internal wiring was never
    // part of any selection.links to begin with).
    function linksTouchingNodes(nodes) {
        var idSet = nodes.map(function (n) { return n.id; });
        var links = [];
        if (RED.nodes.eachLink) {
            RED.nodes.eachLink(function (l) {
                var srcId = l.source && l.source.id;
                var tgtId = l.target && l.target.id;
                if (idSet.indexOf(srcId) !== -1 || idSet.indexOf(tgtId) !== -1) {
                    links.push(l);
                }
            });
        }
        return links;
    }

    function collectSelectionContext(nodeIds) {
        var rawNodes, rawLinks;
        if (Array.isArray(nodeIds)) {
            rawNodes = nodeIds.map(function (id) { return RED.nodes.node(id); })
                              .filter(function (n) { return !!n; });
            if (!rawNodes.length) { return null; }
            rawLinks = linksTouchingNodes(rawNodes);
        } else {
            var sel = (RED.view && RED.view.selection) ? RED.view.selection() : null;
            var expandedSel = expandGroupSelection((sel && sel.nodes) ? sel.nodes : []);
            rawNodes = expandedSel.nodes;
            if (!rawNodes.length) { return null; }
            // A literal click-drag selection's sel.links already has the
            // right shape — but it never reflects a SELECTED GROUP's
            // internal wiring (those nodes were never individually
            // selected), so gather links directly whenever a group was
            // part of the selection instead of trusting sel.links.
            rawLinks = expandedSel.groupCount > 0
                ? linksTouchingNodes(rawNodes)
                : ((sel && sel.links) ? sel.links : []);
        }
        // Collect config nodes (mqtt-broker, tls-config, etc.) that the
        // selected nodes reference. Config nodes are shared configuration
        // objects not on the canvas — the model needs their ids and
        // non-credential properties to reference or create them in Modify.
        // Detected via each live node's _def.defaults: any property whose
        // propDef.type is a type name (rather than a value type like "str")
        // is a config-node reference; n[k] is the referenced node's id.
        var configNodeMap = {};
        rawNodes.forEach(function (n) {
            var typeDef = n._def;
            if (!typeDef || !typeDef.defaults) { return; }
            Object.keys(typeDef.defaults).forEach(function (k) {
                var propDef = typeDef.defaults[k];
                if (propDef && propDef.type && typeof n[k] === "string" && n[k] &&
                        !configNodeMap[n[k]]) {
                    var configNode = RED.nodes.node(n[k]);
                    if (configNode && configNode.type) {
                        configNodeMap[n[k]] = configNode;
                    }
                }
            });
        });
        var configNodes = Object.keys(configNodeMap).map(function (id) {
            return sanitizeNode(configNodeMap[id]);
        });

        return {
            nodes: rawNodes.map(sanitizeNode),
            connections: buildConnections(rawNodes, rawLinks),
            configNodes: configNodes.length ? configNodes : undefined
        };
    }
