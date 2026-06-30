// ---------------------------------------------------------------------
// Apply/review module (Phase 9 refactor seam 6) — Layer 2: the canvas-
// mutation machinery and diff/review rendering shared by all modes
// (Modify, Generate, Document, Build).
//
// Concatenated into the same shared closure as the rest of
// flowpilot-core.js (see lib/build-core-script.js). Cross-module
// dependencies reached via that shared closure (not imported):
//   addMessage, updateSelectionStatus, scrollMessagesToBottom,
//   pushHistory — declared in lib/core/main.js
//   sanitizeNode — declared in lib/core/redaction.js
//   RED.* — RED.nodes, RED.view.importNodes, RED.workspaces,
//            RED.history, RED.group, RED.nodes.junctions
//
// NOT extracted here despite living in the same line range (interleaved
// in the original file, left behind in main.js):
//   modifyFlow, addGeneratedJson — Layer 3 (mode-modify / error display)
//   activeBuildLoop + build-loop block — Layer 3 (mode-build)
//   copyToClipboard — multi-layer shared utility (also used by chat
//                     code-block copy buttons in initMainWindow)
//   bind*ApplyButtons, bindTabSwitching — Layer 4 (pop-out relay,
//     called only from initPopout; every action is window.opener.
//     postMessage, never a direct apply call)
// ---------------------------------------------------------------------

    var DIFF_SKIP = {
        x: 1, y: 1, z: 1, _def: 1, _: 1, changed: 1, dirty: 1, selected: 1,
        valid: 1, validationErrors: 1, _index: 1, resize: 1, moved: 1,
        w: 1, h: 1, l: 1, __outputs: 1, inputs: 1, g: 1,
        _config: 1, _orig: 1, credentials: 1,
        // "group" is a SYNTHETIC field sanitizeNode adds to context (the
        // real live property is "g", already skipped above) — informational
        // only. Live-confirmed gap: the model tried to "ungroup" by setting
        // group:null on member nodes via a "changes" patch; without this
        // skip, computeNodeDiff happily diffed a property that doesn't
        // exist on the real node object, and Tier 1 "applied" it by writing
        // a meaningless liveNode.group = null — reporting false success
        // while actually doing nothing to real membership (RED.nodes.node()
        // doesn't even read a key named "group"). Real ungrouping goes
        // through applyGroupChanges()/"newGroups" instead.
        group: 1,
        // "nodes" is a GROUP's live membership array — holds real node
        // OBJECT references, never ids. Live-confirmed data-corrupting gap
        // (2026-06-29): asked to "merge" several groups into one via plain
        // Modify, the model sent a "changes" patch targeting the group
        // entities directly (findLiveNode resolves a group by id) with a
        // "nodes" value shaped like a list of ID STRINGS instead of going
        // through applyGroupChanges()/"newGroups". Tier 1 wrote it
        // verbatim (liveNode.nodes = [...ids]), replacing real node
        // references with strings; NR's own redraw/export code calls
        // .id/.g on each "nodes" entry expecting an object, so this
        // corrupted the group immediately (canvas selection started
        // throwing) AND on disk (each string serializes with id
        // undefined -> null, confirmed via a live flows.json). Group
        // membership must only ever change through applyGroupChanges().
        nodes: 1
    };

    // Sentinel strings written by sanitizeNode (and redactDebugValue) for
    // values it couldn't include or had to redact. If the model echoes one
    // of these back, the field is opaque — skip it entirely; never write a
    // sentinel string into a live node property. "[redacted]" is the plain
    // top-level-secret-field sentinel; "[redacted: <kind>, <n> chars]" is the
    // informative value-shape sentinel from redactDebugValue.
    //
    // MUST be recursive: sentinels can be nested inside arrays/objects (e.g.
    // an inject node's "props" array, where individual v-fields are redacted).
    // Live-confirmed data-corrupting gap (2026-06-29): asked to "ungroup"
    // with a stale canvas state that showed group:null, the model echoed the
    // REDACTED props array back verbatim. Tier 1 compared the live props
    // (real values) vs the proposed props (sentinel strings nested inside)
    // and saw them as different — a false "change". The old flat sentinel
    // check returned false for the array itself, so the change was applied,
    // overwriting real API keys with "[redacted: secret field, N chars]"
    // strings in the live canvas. Disk was safe (user never deployed), but
    // a deploy would have lost the keys permanently.
    function isSanitizeSentinel(value) {
        if (typeof value === "string") {
            return value === "[unserializable]" || value === "[redacted]" || value.indexOf("[redacted:") === 0;
        }
        if (Array.isArray(value)) {
            return value.some(isSanitizeSentinel);
        }
        if (value !== null && typeof value === "object") {
            return Object.keys(value).some(function (k) { return isSanitizeSentinel(value[k]); });
        }
        return false;
    }

    function generateNodeId() {
        var chars = "0123456789abcdef";
        var id = "";
        for (var i = 0; i < 16; i++) { id += chars[Math.floor(Math.random() * 16)]; }
        return id;
    }

    // Resolve a newWires from/to reference to a display label.
    // ref is either a placeholder id present in newNodes or an existing node id.
    function resolveWireRef(ref, newNodes) {
        if (!ref) { return "(unknown)"; }
        // Check against newNodes placeholder ids.
        for (var i = 0; i < newNodes.length; i++) {
            if (newNodes[i] && newNodes[i].id === ref) {
                var n = newNodes[i];
                return (n.name || n.type || ref) + " [new]";
            }
        }
        // Existing node.
        var live = RED.nodes && RED.nodes.node ? RED.nodes.node(ref) : null;
        return live ? (live.name || live.type || ref) : ref;
    }

    // Insert new nodes into the live graph and add wires connecting them to
    // existing nodes. Uses RED.nodes.add (the same path Node-RED's undo uses
    // internally for t:"add" events) and pushes one compound history entry so
    // a single Ctrl+Z removes both the new nodes and their wires together.
    function applyInsertions(newNodes, newWires, contextNodeIds) {
        if (!newNodes || !newNodes.length) { return; }

        // Determine z (flow-tab id) from the active workspace.
        var z = "";
        if (RED.workspaces && RED.workspaces.active) {
            var ws = RED.workspaces.active();
            z = ws ? (typeof ws === "string" ? ws : ws.id || "") : "";
        }

        // Collect model placeholder ids to distinguish them from existing-node
        // ids when scanning newWires for spatial anchors.
        var placeholderIds = {};
        newNodes.forEach(function (n) { if (n.id) { placeholderIds[n.id] = true; } });

        // Group new nodes into connected clusters (by each node's own
        // "wires" plus any "newWires" edges between two placeholders), so
        // multiple unrelated insertions in one response are each anchored to
        // THEIR OWN existing-node connections instead of bunching together at
        // one shared location.
        var parent = {};
        newNodes.forEach(function (n) { parent[n.id] = n.id; });
        function findRoot(x) {
            while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        }
        function union(a, b) {
            if (parent[a] === undefined || parent[b] === undefined) { return; }
            parent[findRoot(a)] = findRoot(b);
        }
        newNodes.forEach(function (n) {
            (Array.isArray(n.wires) ? n.wires : []).forEach(function (port) {
                (Array.isArray(port) ? port : []).forEach(function (tid) {
                    if (placeholderIds[tid]) { union(n.id, tid); }
                });
            });
        });
        (newWires || []).forEach(function (wire) {
            if (placeholderIds[wire.from] && placeholderIds[wire.to]) {
                union(wire.from, wire.to);
            }
        });
        var componentOf = {};
        newNodes.forEach(function (n) { componentOf[n.id] = findRoot(n.id); });

        // Per-component anchors: existing-node connections (from newWires)
        // touching THIS component only. Split into "upstream" (existing node
        // feeds INTO this component) and "downstream" (this component feeds
        // INTO an existing node) — a wire's direction matters for where the
        // cluster should land.
        var componentAnchors = {};
        Object.keys(componentOf).forEach(function (id) {
            var c = componentOf[id];
            if (!componentAnchors[c]) { componentAnchors[c] = { upstream: [], downstream: [] }; }
        });
        (newWires || []).forEach(function (wire) {
            var fromIsNew = placeholderIds[wire.from];
            var toIsNew = placeholderIds[wire.to];
            if (!fromIsNew && toIsNew) {
                var src = RED.nodes.node(wire.from);
                if (src && typeof src.x === "number" && typeof src.y === "number") {
                    componentAnchors[componentOf[wire.to]].upstream.push(src);
                }
            } else if (fromIsNew && !toIsNew) {
                var tgt = RED.nodes.node(wire.to);
                if (tgt && typeof tgt.x === "number" && typeof tgt.y === "number") {
                    componentAnchors[componentOf[wire.from]].downstream.push(tgt);
                }
            }
        });

        // Fallback (Finding #18): a cluster with no existing-node connection
        // at all (e.g. "add a change node" with no wiring specified) anchors
        // on the user's current Modify selection instead of
        // layoutGeneratedFlow's hardcoded default (160,120), which can be far
        // outside the user's current viewport on a larger flow.
        var fallbackAnchors = [];
        if (Array.isArray(contextNodeIds)) {
            contextNodeIds.forEach(function (id) {
                var live = RED.nodes.node(id);
                if (live && typeof live.x === "number" && typeof live.y === "number") {
                    fallbackAnchors.push(live);
                }
            });
        }
        Object.keys(componentAnchors).forEach(function (c) {
            var a = componentAnchors[c];
            if (a.upstream.length === 0 && a.downstream.length === 0) {
                a.upstream = fallbackAnchors.slice();
            }
        });

        // Layout new nodes so they have x/y before adding to the graph.
        var toLayout = newNodes.map(function (n) {
            return Object.assign({}, n, { wires: Array.isArray(n.wires) ? n.wires : [[]] });
        });
        var laid = layoutGeneratedFlow(toLayout);

        // Position each cluster relative to ITS OWN anchors, centred on their
        // average Y, preserving that cluster's internal column/row layout
        // from layoutGeneratedFlow.
        // - If a cluster receives a connection FROM an existing node
        //   ("inserted after X" / "inserted between X and Y"), land 200px
        //   right of the rightmost such upstream anchor. This is correct
        //   even when downstream anchors exist further right (e.g. "insert
        //   a function between the inject and the existing debugs" should
        //   land right after the inject, not past the debugs).
        // - Otherwise (the cluster only feeds existing nodes, e.g. "add an
        //   inject that triggers this debug"), land 200px left of the
        //   leftmost downstream anchor.
        Object.keys(componentAnchors).forEach(function (c) {
            var a = componentAnchors[c];
            var anchorNodes = a.upstream.concat(a.downstream);
            if (!anchorNodes.length) { return; }

            var members = laid.filter(function (n) { return componentOf[n.id] === c; });
            var minX = members.reduce(function (m, n) { return Math.min(m, n.x); }, members[0].x);
            var minY = members.reduce(function (m, n) { return Math.min(m, n.y); }, members[0].y);

            var avgY = anchorNodes.reduce(function (s, n) { return s + n.y; }, 0) / anchorNodes.length;
            var targetX;
            if (a.upstream.length > 0) {
                var maxUpstreamX = a.upstream.reduce(function (m, n) { return Math.max(m, n.x); }, 0);
                targetX = maxUpstreamX + 200;
            } else {
                var minDownstreamX = a.downstream.reduce(function (m, n) { return Math.min(m, n.x); }, a.downstream[0].x);
                targetX = minDownstreamX - 200;
            }
            members.forEach(function (n) {
                n.x = n.x - minX + targetX;
                n.y = n.y - minY + avgY;
            });
        });

        // Build placeholder-id → real-id map and assign real ids + z.
        var idMap = {};
        laid.forEach(function (n) {
            var realId = generateNodeId();
            idMap[n.id] = realId; // n.id is the model's placeholder
            n.id = realId;
            n.z = z;
            if (!Array.isArray(n.wires)) { n.wires = [[]]; }
        });

        // Rewrite any intra-new-node wires to use real ids.
        laid.forEach(function (n) {
            n.wires = n.wires.map(function (port) {
                return Array.isArray(port) ? port.map(function (tid) {
                    return idMap[tid] || tid;
                }) : [];
            });
        });

        // Rewrite config-node references that point at another new node's
        // placeholder id — e.g. an "mqtt out" node's "broker" pointing at a
        // newly-inserted "mqtt-broker". The model reuses the same placeholder
        // ids for these as it does for wires, but only "wires" was rewritten
        // above; without this, the reference is left dangling on the
        // placeholder string and the node fails validation at Deploy.
        laid.forEach(function (n) {
            if (n.type === "junction") { return; }
            var typeDef = RED.nodes.getType(n.type);
            if (!typeDef || !typeDef.defaults) { return; }
            Object.keys(typeDef.defaults).forEach(function (k) {
                var def = typeDef.defaults[k];
                if (def && def.type && typeof n[k] === "string" && idMap[n[k]]) {
                    n[k] = idMap[n[k]];
                }
            });
        });

        // Add each node to the live graph.
        // RED.nodes.add requires _def (the type's registration object) to be
        // set on the node — it's what the undo system restores, not a raw cfg.
        var addedNodes = [];
        var addedJunctions = [];
        var insertFailed = false;
        laid.forEach(function (n) {
            // Junctions (wire-splice points) are NOT registered node types —
            // RED.nodes.getType("junction") returns undefined, so the regular
            // RED.nodes.add path below would reject them as "not installed".
            // They're added via RED.nodes.addJunction with a different shape
            // (no defaults/_def beyond a stub), mirroring the object NR's own
            // "split wire with junction" action builds (red.js addJunctionsToWires).
            if (n.type === "junction") {
                var junctionObj = {
                    _def: { defaults: {} },
                    type: "junction",
                    z: n.z,
                    id: n.id,
                    x: n.x,
                    y: n.y,
                    w: 0,
                    h: 0,
                    inputs: 1,
                    outputs: 1,
                    dirty: true,
                    moved: true
                };
                try {
                    junctionObj = RED.nodes.addJunction(junctionObj);
                    addedJunctions.push(junctionObj);
                } catch (e) {
                    addMessage("error", "Failed to add junction: " + (e.message || e));
                    insertFailed = true;
                }
                return;
            }

            var typeDef = RED.nodes.getType(n.type);
            if (!typeDef) {
                addMessage("error", "Node type not installed: " + n.type);
                insertFailed = true;
                return;
            }
            n._def = typeDef;
            // inputs/outputs are runtime state that add() reads from the node
            // object directly — it doesn't copy them from _def automatically.
            if (typeof n.inputs === "undefined") {
                n.inputs = typeDef.inputs !== undefined ? typeDef.inputs : 1;
            }
            if (typeof n.outputs === "undefined") {
                n.outputs = typeDef.outputs !== undefined
                    ? typeDef.outputs
                    : (Array.isArray(n.wires) ? n.wires.length : 0);
            }
            // Apply type-definition defaults for any property the model omitted.
            // This covers required fields (e.g. statusVal/statusType on debug)
            // that oneditsave would normally set, preventing a spurious triangle.
            if (typeDef.defaults) {
                Object.keys(typeDef.defaults).forEach(function (k) {
                    if (n[k] === undefined) {
                        var d = typeDef.defaults[k];
                        if (d && d.value !== undefined) { n[k] = d.value; }
                    }
                });
            }
            try {
                RED.nodes.add(n);
                // Try the public validator; if it isn't exposed or still leaves
                // the node invalid, clear the triangle explicitly — real
                // validation runs at edit-dialog-close and at Deploy.
                if (typeof RED.nodes.validateNode === "function") {
                    RED.nodes.validateNode(n);
                }
                if (!n.valid) { n.valid = true; n.validationErrors = []; }
                addedNodes.push(n);
            } catch (e) {
                addMessage("error", "Failed to add node '" + (n.type || "?") + "': " + (e.message || e));
                insertFailed = true;
            }
        });
        // Bug found via code-review archaeology (Phase 6 item #11, left open
        // and never revisited): bailing out entirely on ANY failure used to
        // discard whatever DID succeed before the failing node — those nodes
        // stayed on the live canvas (RED.nodes.add already ran) but with no
        // RED.history entry, so Ctrl+Z couldn't remove them, and no message
        // told the user anything had landed at all. Now only bail when
        // NOTHING succeeded; the history push and wiring below already only
        // reference addedNodes/addedJunctions/addedLinks (whatever's actually
        // there), so a partial success gets undo coverage same as a full one.
        if (!addedNodes.length && !addedJunctions.length) { return; }

        // Re-link config-node "users" now that all new nodes (including any
        // new config nodes, e.g. mqtt-broker) exist. addNode() ran this
        // per-node as it was added, but a node added BEFORE its config-node
        // dependency wouldn't have found it in configNodes yet — without this,
        // the config node shows 0 users and may not be included on Deploy.
        if (typeof RED.nodes.updateConfigNodeUsers === "function") {
            addedNodes.forEach(function (n) {
                RED.nodes.updateConfigNodeUsers(n, { action: "add" });
            });
        }

        // Resolve newWires refs and add link objects. findLiveNode (not
        // RED.nodes.node) because endpoints may be junctions we just added —
        // junctions live in RED.nodes.junctions(z), not the normal registry.
        var addedLinks = [];
        (newWires || []).forEach(function (wire) {
            var fromId = idMap[wire.from] || wire.from;
            var toId = idMap[wire.to] || wire.to;
            var fromNode = findLiveNode(fromId);
            var toNode = findLiveNode(toId);
            if (!fromNode || !toNode) {
                addMessage("error", "Cannot wire — node not found: " + (!fromNode ? fromId : toId));
                return;
            }
            var link = { source: fromNode, sourcePort: wire.fromPort || 0, target: toNode };
            try {
                RED.nodes.addLink(link);
                addedLinks.push(link);
            } catch (e) {
                addMessage("error", "Failed to add wire: " + (e.message || e));
            }
        });

        // Also process wires inside newNodes that reference existing nodes.
        // The model uses "wires" for intra-new-node connections and "newWires"
        // for cross-boundary connections, but it may also use "wires" to point
        // to existing nodes (e.g. a new junction wired to an existing debug).
        laid.forEach(function (newNode) {
            if (!newNode.wires || !Array.isArray(newNode.wires)) { return; }
            newNode.wires.forEach(function (portWires, portIndex) {
                if (!Array.isArray(portWires)) { return; }
                portWires.forEach(function (targetId) {
                    // Skip if this is an intra-new-node wire (placeholder id)
                    if (idMap[targetId]) { return; }
                    // This is a wire to an existing node - create the link
                    var fromNode = findLiveNode(newNode.id);
                    var toNode = findLiveNode(targetId);
                    if (!fromNode || !toNode) {
                        addMessage("error", "Cannot wire new node to existing node — node not found: " + (!fromNode ? newNode.id : targetId));
                        return;
                    }
                    var link = { source: fromNode, sourcePort: portIndex, target: toNode };
                    try {
                        RED.nodes.addLink(link);
                        addedLinks.push(link);
                    } catch (e) {
                        addMessage("error", "Failed to add wire: " + (e.message || e));
                    }
                });
            });
        });

        // One compound undo entry covers both the new nodes and their wires.
        // NB: for t:"add", ev.nodes must be an array of ID STRINGS — NR's undo
        // does RED.nodes.node(ev.nodes[i]) then reads .z, which throws (and
        // silently breaks Ctrl+Z) if given node objects instead of ids.
        RED.history.push({
            t: "add",
            nodes: addedNodes.map(function (n) { return n.id; }),
            links: addedLinks,
            groups: [],
            junctions: addedJunctions,
            subflow: { id: undefined, instances: [] },
            subflowInputs: [],
            subflowOutputs: [],
            dirty: RED.nodes.dirty()
        });

        RED.nodes.dirty(true);
        RED.view.redraw(true);

        // Ground follow-up turns in what was just inserted. Report partial
        // failure honestly instead of staying silent about it — the per-node
        // "Failed to add..." errors above already explain what didn't make
        // it, but without this the user has no summary tying it together.
        var insertedCount = addedNodes.length + addedJunctions.length;
        var insertedNote = insertFailed
            ? "Inserted " + insertedCount + " of " + laid.length + " node(s) — some failed " +
              "(see errors above). Ctrl+Z undoes what was added."
            : "Touchdown — inserted " + insertedCount + " node(s)" +
              (addedLinks.length ? " and added " + addedLinks.length + " wire connection(s)" : "") +
              ". Ctrl+Z to undo.";
        addMessage("assistant", insertedNote);
        pushHistory("assistant", insertedNote);
        updateSelectionStatus();

        // Returned so applyModifications can resolve Tier 3 wire-diff targets
        // that point at one of these placeholder ids (e.g. an existing node's
        // "wires" rewired to a brand-new node added in the same response).
        return idMap;
    }

    // Look up a live node by id, falling back to the per-tab junction
    // registry, then the group registry. Junction nodes (wire-splice
    // points) and groups are NOT in RED.nodes.node()'s normal registry —
    // confirmed via core source (red.js's getNode() only checks
    // configNodes/allNodes) — junctions live in RED.nodes.junctions(z),
    // groups in RED.nodes.group(id). Without these fallbacks, a
    // modNode/removeNodes id referring to either reads as "not found",
    // which (in addModifyReview) renders "⚠ Node not found in editor" and
    // blocks Apply entirely.
    function findLiveNode(id) {
        var node = (RED.nodes && RED.nodes.node) ? RED.nodes.node(id) : null;
        if (node) { return node; }
        if (RED.nodes.junctions && RED.workspaces && RED.workspaces.active) {
            var activeZ = RED.workspaces.active();
            var junctionsOnTab = RED.nodes.junctions(activeZ) || [];
            for (var i = 0; i < junctionsOnTab.length; i++) {
                if (junctionsOnTab[i].id === id) { return junctionsOnTab[i]; }
            }
        }
        if (RED.nodes.group) {
            var grp = RED.nodes.group(id);
            if (grp) { return grp; }
        }
        return null;
    }

    // Compare a live editor node against a returned (modified) node, key by
    // key. We only diff keys present in the returned node — internal editor
    // fields the model omits are untouched on apply and excluded from the diff.
    // `wires` is separated out so the review can flag it without applying it.
    function computeNodeDiff(liveNode, modNode) {
        var propertyChanges = [];
        var wiresChanged = false;
        Object.keys(modNode).forEach(function (k) {
            if (DIFF_SKIP[k]) { return; }
            var newRaw = modNode[k];
            // If the model echoed a sanitizer sentinel, the field is opaque —
            // we can't meaningfully compare or apply it, so skip entirely.
            if (isSanitizeSentinel(newRaw)) { return; }
            var oldRaw = liveNode ? liveNode[k] : undefined;
            var oldStr, newStr;
            try { oldStr = JSON.stringify(oldRaw); } catch (e) { oldStr = String(oldRaw); }
            try { newStr = JSON.stringify(newRaw); } catch (e) { newStr = String(newRaw); }
            if (oldStr === newStr) { return; }
            if (k === "wires") { wiresChanged = true; return; }
            propertyChanges.push({ key: k, oldVal: oldRaw, newVal: newRaw });
        });
        return { propertyChanges: propertyChanges, wiresChanged: wiresChanged };
    }

    // Diff outgoing wires for an existing node: compare what's live in the graph
    // against what the model returned. Returns { toRemove, toAdd } each an array
    // of { sourcePort, targetId }. Used by Tier 3 (rewire) to apply wire changes.
    //
    // validTargetIds is the set of node ids the model actually had in context
    // (i.e. ids present in the returned "flow"). The model can't see or preserve
    // connections to nodes outside its selection, so a live connection whose
    // target is NOT in validTargetIds is left alone even if it's missing from
    // modelWires — otherwise every out-of-context connection would look like an
    // unintended removal (e.g. a node wired to a debug node that wasn't selected).
    function computeWireDiff(nodeId, modelWires, validTargetIds) {
        var currentByPort = {};
        RED.nodes.eachLink(function (l) {
            if (l.source && l.source.id === nodeId) {
                var port = l.sourcePort || 0;
                if (!currentByPort[port]) { currentByPort[port] = []; }
                currentByPort[port].push(l.target.id);
            }
        });

        var desiredByPort = {};
        var wires = Array.isArray(modelWires) ? modelWires : [];
        wires.forEach(function (targets, port) {
            if (Array.isArray(targets) && targets.length > 0) {
                desiredByPort[port] = targets.slice();
            }
        });

        var toRemove = [];
        Object.keys(currentByPort).forEach(function (port) {
            var portNum = parseInt(port, 10);
            var curTargets = currentByPort[port];
            var desTargets = desiredByPort[portNum] || [];
            curTargets.forEach(function (tid) {
                if (desTargets.indexOf(tid) === -1 && validTargetIds && validTargetIds[tid]) {
                    toRemove.push({ sourcePort: portNum, targetId: tid });
                }
            });
        });

        var toAdd = [];
        Object.keys(desiredByPort).forEach(function (port) {
            var portNum = parseInt(port, 10);
            var desTargets = desiredByPort[port];
            var curTargets = currentByPort[portNum] || [];
            desTargets.forEach(function (tid) {
                if (curTargets.indexOf(tid) === -1) {
                    toAdd.push({ sourcePort: portNum, targetId: tid });
                }
            });
        });

        return { toRemove: toRemove, toAdd: toAdd };
    }

    function formatDiffVal(v) {
        if (v === undefined || v === null) { return "(none)"; }
        if (typeof v === "object") { return JSON.stringify(v); }
        return String(v);
    }

    // Tabbed diff review for a modify response. Shows property diffs for
    // existing nodes and, when the model also returned new nodes to insert,
    // a list of those plus the wire connections to be made. The Apply button
    // label adapts: "Apply Changes" / "Insert Nodes" / "Apply & Insert".
    // buildFixInfo: present only for a /build loop review's fix envelope
    // (handleBuildReviewResult) — `{ capReached }`, carried in the pop-out's
    // relay tag since applying there also needs the loop bookkeeping
    // applyBuildLoopFix does, not just applyModifications.
    // newGroups: Phase 8.5 C2 slice 3 — see applyGroupChanges.
    function addModifyReview(modifiedFlow, newNodes, newWires, removeNodes, applyCallback, buildFixInfo, newGroups) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }

        var nodes = Array.isArray(modifiedFlow) ? modifiedFlow : [];
        newNodes = Array.isArray(newNodes) ? newNodes : [];
        newWires = Array.isArray(newWires) ? newWires : [];
        removeNodes = Array.isArray(removeNodes) ? removeNodes : [];
        newGroups = Array.isArray(newGroups) ? newGroups : [];

        // Ids the model actually had in context (the returned "flow"). Used by
        // computeWireDiff to avoid flagging connections to out-of-context nodes
        // as removals — the model can't see or preserve those.
        var validTargetIds = {};
        nodes.forEach(function (n) { if (n && n.id) { validTargetIds[n.id] = true; } });

        // Match each returned node to its live counterpart and compute diffs.
        // wiresDiff is computed from the live graph via eachLink, not from
        // node.wires (which is empty in the live editor — export-time artifact).
        var nodeDiffs = nodes.map(function (modNode) {
            var liveNode = findLiveNode(modNode.id);
            var diff = computeNodeDiff(liveNode || {}, modNode);
            var wiresDiff = (diff.wiresChanged && liveNode)
                ? computeWireDiff(modNode.id, modNode.wires, validTargetIds)
                : { toRemove: [], toAdd: [] };
            return {
                modNode: modNode,
                liveNode: liveNode,
                propertyChanges: diff.propertyChanges,
                wiresChanged: diff.wiresChanged,
                wiresDiff: wiresDiff,
                name: modNode.name || (liveNode && liveNode.name) || "",
                type: modNode.type || (liveNode && liveNode.type) || ""
            };
        });

        var totalPropChanges = nodeDiffs.reduce(function (s, d) {
            return s + d.propertyChanges.length;
        }, 0);
        var nodesWithChanges = nodeDiffs.filter(function (d) {
            return d.propertyChanges.length > 0;
        }).length;
        var missingLive = nodeDiffs.some(function (d) { return !d.liveNode; });
        var hasPropChanges = totalPropChanges > 0;
        var hasWireChanges = nodeDiffs.some(function (d) {
            return d.wiresDiff && (d.wiresDiff.toRemove.length > 0 || d.wiresDiff.toAdd.length > 0);
        });
        var hasNewNodes = newNodes.length > 0;
        var hasRemoveNodes = removeNodes.length > 0;
        var hasNewGroups = newGroups.length > 0;
        var hasAnyChanges = hasPropChanges || hasWireChanges || hasNewNodes || hasRemoveNodes || hasNewGroups;

        var $msg = $("<div>").addClass("fp-message fp-review");
        $("<div>").addClass("fp-label").text("MODIFY FLOW — REVIEW CHANGES").appendTo($msg);

        var $tabSummary = $("<button>").addClass("fp-tab fp-tab-active").attr("type", "button").text("Summary");
        var $tabJson = $("<button>").addClass("fp-tab").attr("type", "button").text("JSON");
        $("<div>").addClass("fp-tabs").append($tabSummary, $tabJson).appendTo($msg);

        var $summaryPanel = $("<div>").addClass("fp-tab-panel");
        var $jsonPanel = $("<div>").addClass("fp-tab-panel fp-hidden");
        $msg.append($summaryPanel, $jsonPanel);

        // ---- Summary tab: property diffs for existing nodes ----
        // Only show this section when there are actual property changes —
        // "0 of N will change" is confusing when we're purely inserting or rewiring.
        if (hasPropChanges) {
            $("<div>").addClass("fp-review-count")
                .text(nodesWithChanges + " of " + nodes.length + " node(s) will change:")
                .appendTo($summaryPanel);
            nodeDiffs.forEach(function (d) {
                if (d.propertyChanges.length === 0) { return; }
                var $section = $("<div>").addClass("fp-diff-node").appendTo($summaryPanel);
                var title = d.type + (d.name ? " — \"" + d.name + "\"" : "");
                $("<div>").addClass("fp-diff-node-title").text(title).appendTo($section);
                if (!d.liveNode) {
                    $("<div>").addClass("fp-diff-warn")
                        .text("⚠ Node not found in editor (id: " + d.modNode.id + ")")
                        .appendTo($section);
                    return;
                }
                d.propertyChanges.forEach(function (c) {
                    var $row = $("<div>").addClass("fp-diff-row").appendTo($section);
                    $("<span>").addClass("fp-diff-key").text(c.key).appendTo($row);
                    $("<span>").addClass("fp-diff-old").text(formatDiffVal(c.oldVal)).appendTo($row);
                    $("<span>").addClass("fp-diff-arrow").text("→").appendTo($row);
                    $("<span>").addClass("fp-diff-new").text(formatDiffVal(c.newVal)).appendTo($row);
                });
            });
        }

        // ---- Summary tab: wiring changes (Tier 3) ----
        // Shown when model changed wires on existing nodes. Removed wires appear
        // in the old column (red strikethrough); added wires in the new column (green).
        if (hasWireChanges) {
            var sectionTop = hasPropChanges ? "12px" : "0";
            $("<div>").addClass("fp-review-count").css("margin-top", sectionTop)
                .text("Wiring changes:")
                .appendTo($summaryPanel);
            nodeDiffs.forEach(function (d) {
                var wd = d.wiresDiff;
                if (!wd || (!wd.toRemove.length && !wd.toAdd.length)) { return; }
                var $section = $("<div>").addClass("fp-diff-node").appendTo($summaryPanel);
                var title = d.type + (d.name ? " — \"" + d.name + "\"" : "");
                $("<div>").addClass("fp-diff-node-title").text(title).appendTo($section);
                wd.toRemove.forEach(function (entry) {
                    var tgt = RED.nodes.node ? RED.nodes.node(entry.targetId) : null;
                    var tgtLabel = tgt ? (tgt.name || tgt.type || entry.targetId) : entry.targetId;
                    var $row = $("<div>").addClass("fp-diff-row").appendTo($section);
                    $("<span>").addClass("fp-diff-key").text("port " + entry.sourcePort).appendTo($row);
                    $("<span>").addClass("fp-diff-old").text("→ " + tgtLabel).appendTo($row);
                    $("<span>").addClass("fp-diff-arrow").text("✕").appendTo($row);
                    $("<span>").addClass("fp-diff-new").text("").appendTo($row);
                });
                wd.toAdd.forEach(function (entry) {
                    var tgt = RED.nodes.node ? RED.nodes.node(entry.targetId) : null;
                    var tgtLabel = tgt ? (tgt.name || tgt.type || entry.targetId) : entry.targetId;
                    var $row = $("<div>").addClass("fp-diff-row").appendTo($section);
                    $("<span>").addClass("fp-diff-key").text("port " + entry.sourcePort).appendTo($row);
                    $("<span>").addClass("fp-diff-old").text("").appendTo($row);
                    $("<span>").addClass("fp-diff-arrow").text("→").appendTo($row);
                    $("<span>").addClass("fp-diff-new").text(tgtLabel).appendTo($row);
                });
            });
        }

        // ---- Summary tab: nodes to remove (Tier 4) ----
        if (hasRemoveNodes) {
            var rmTop = (hasPropChanges || hasWireChanges) ? "12px" : "0";
            $("<div>").addClass("fp-review-count fp-diff-warn").css("margin-top", rmTop)
                .text(removeNodes.length + " node(s) to remove:")
                .appendTo($summaryPanel);
            var $rmList = $("<ul>").addClass("fp-review-list").appendTo($summaryPanel);
            removeNodes.forEach(function (id) {
                var lv = RED.nodes.node ? RED.nodes.node(id) : null;
                var label = lv ? ((lv.name || lv.type || id) + " (" + id + ")") : id + " (not found)";
                $("<li>").addClass("fp-diff-warn").text("✕ " + label).appendTo($rmList);
            });
            $("<div>").addClass("fp-diff-warn").css("margin-top", "4px")
                .text("All wires to/from removed nodes will also be deleted.")
                .appendTo($summaryPanel);
        }

        // ---- Summary tab: new nodes to insert ----
        if (hasNewNodes) {
            var insTop = (hasPropChanges || hasWireChanges || hasRemoveNodes) ? "12px" : "0";
            $("<div>").addClass("fp-review-count").css("margin-top", insTop)
                .text(newNodes.length + " node(s) to insert:")
                .appendTo($summaryPanel);
            var $newList = $("<ul>").addClass("fp-review-list").appendTo($summaryPanel);
            newNodes.forEach(function (n) {
                $("<li>").text((n.type || "unknown") + (n.name ? " — \"" + n.name + "\"" : "")).appendTo($newList);
            });
            if (newWires.length > 0) {
                $("<div>").addClass("fp-review-count").css("margin-top", "8px")
                    .text(newWires.length + " wire connection(s):")
                    .appendTo($summaryPanel);
                var $wireList = $("<ul>").addClass("fp-review-list").appendTo($summaryPanel);
                newWires.forEach(function (wire) {
                    var fromLabel = resolveWireRef(wire.from, newNodes);
                    var toLabel = resolveWireRef(wire.to, newNodes);
                    var portNote = (wire.fromPort && wire.fromPort > 0) ? " [port " + wire.fromPort + "]" : "";
                    $("<li>").text(fromLabel + portNote + " → " + toLabel).appendTo($wireList);
                });
            }
        }

        // ---- Summary tab: groups to create/update ----
        if (hasNewGroups) {
            var grpTop = (hasPropChanges || hasWireChanges || hasRemoveNodes || hasNewNodes) ? "12px" : "0";
            $("<div>").addClass("fp-review-count").css("margin-top", grpTop)
                .text(newGroups.length + " group(s) to create/update:")
                .appendTo($summaryPanel);
            var $grpList = $("<ul>").addClass("fp-review-list").appendTo($summaryPanel);
            newGroups.forEach(function (g) {
                var label = (g.name ? "\"" + g.name + "\"" : "(unnamed group)") +
                    " — " + (Array.isArray(g.nodes) ? g.nodes.length : 0) + " node(s)";
                $("<li>").text(label).appendTo($grpList);
            });
        }

        // ---- JSON tab ----
        var jsonPayload = (hasNewNodes || hasRemoveNodes || hasNewGroups)
            ? { modifiedNodes: nodes, newNodes: newNodes, newWires: newWires, removeNodes: removeNodes, newGroups: newGroups }
            : nodes;
        var jsonText = JSON.stringify(jsonPayload, null, 2);
        var $copyBtn = $("<button>")
            .addClass("red-ui-button red-ui-button-small")
            .attr("type", "button")
            .text("Copy")
            .on("click", function () { copyToClipboard($copyBtn, jsonText); });
        $("<div>").addClass("fp-json-toolbar").append($copyBtn).appendTo($jsonPanel);
        $("<pre>").addClass("fp-json").text(jsonText).appendTo($jsonPanel);

        function activateTab(showSummary) {
            $tabSummary.toggleClass("fp-tab-active", showSummary);
            $tabJson.toggleClass("fp-tab-active", !showSummary);
            $summaryPanel.toggleClass("fp-hidden", !showSummary);
            $jsonPanel.toggleClass("fp-hidden", showSummary);
        }
        $tabSummary.on("click", function () { activateTab(true); });
        $tabJson.on("click", function () { activateTab(false); });

        // ---- Action row ----
        var $actions = $("<div>").addClass("fp-review-actions").appendTo($msg);
        if (!hasAnyChanges) {
            $("<div>").addClass("fp-review-hint")
                .text("No changes detected — nothing to apply.")
                .appendTo($actions);
        } else if (missingLive && (hasPropChanges || hasWireChanges)) {
            $("<div>").addClass("fp-warning")
                .text("One or more nodes could not be found in the editor. Cannot apply safely.")
                .appendTo($actions);
        } else {
            var hasMutations = hasPropChanges || hasWireChanges || hasRemoveNodes;
            var btnLabel = (hasMutations && hasNewNodes) ? "Apply & Insert"
                : hasMutations ? "Apply Changes"
                : hasNewNodes ? "Insert Nodes"
                : "Apply Changes"; // covers a request that ONLY creates/updates a group

            // Pop-out: tag this panel with everything applyInsertions/
            // applyModifications/applyGroupChanges need to re-run from a
            // relayed click — nodeDiffs re-serialized without liveNode (a
            // live RED node object, not JSON-safe; applyModifications
            // re-fetches it itself via findLiveNode anyway, so nothing is
            // lost). A plain Modify call (applyCallback is the bare
            // applyModifications reference) gets "data-fp-apply-modify"; a
            // /build loop fix (buildFixInfo set — see applyBuildLoopFix)
            // gets "data-fp-apply-build-fix" instead, carrying capReached
            // too since the relayed click needs to run the SAME loop
            // bookkeeping a local click would, not just applyModifications.
            var sharedApplyData = {
                nodeDiffs: nodeDiffs.map(function (d) {
                    return {
                        modNode: d.modNode,
                        propertyChanges: d.propertyChanges,
                        wiresChanged: d.wiresChanged,
                        wiresDiff: d.wiresDiff,
                        name: d.name,
                        type: d.type
                    };
                }),
                removeNodes: removeNodes,
                newNodes: newNodes,
                newWires: newWires,
                newGroups: newGroups,
                existingNodeIds: nodes.map(function (n) { return n.id; }),
                hasMutations: hasMutations
            };
            if (applyCallback === applyModifications) {
                $msg.attr("data-fp-apply-modify", JSON.stringify(sharedApplyData));
            } else if (buildFixInfo) {
                sharedApplyData.capReached = !!buildFixInfo.capReached;
                $msg.attr("data-fp-apply-build-fix", JSON.stringify(sharedApplyData));
            }

            var $applyBtn = $("<button>")
                .addClass("red-ui-button red-ui-button-primary")
                .attr("type", "button")
                .text(btnLabel)
                .on("click", function () {
                    $applyBtn.prop("disabled", true).text("Applying…");
                    // Insertions run FIRST so their placeholder→real-id map is
                    // available to applyModifications/applyGroupChanges — an
                    // existing node's rewired "wires" (Tier 3) or a new
                    // group's membership may point at a node being inserted
                    // in this same response.
                    var idMap = {};
                    if (hasNewNodes) {
                        idMap = applyInsertions(newNodes, newWires, nodes.map(function (n) { return n.id; })) || {};
                    }
                    if (hasMutations && applyCallback) { applyCallback(nodeDiffs, removeNodes, null, idMap); }
                    if (hasNewGroups) { applyGroupChanges(newGroups, idMap); }
                    $applyBtn.text("Done ✓");
                });
            $actions.append($applyBtn);
            var hintParts = [];
            if (hasPropChanges || hasWireChanges) { hintParts.push("changes mutate live nodes"); }
            if (hasRemoveNodes) { hintParts.push("removals delete nodes"); }
            if (hasNewGroups) { hintParts.push("groups are created/updated"); }
            if (hasNewNodes) { hintParts.push("insertions add new nodes"); }
            var hintText = "Review above — " + hintParts.join(", ") + ". Ctrl+Z to undo.";
            $("<span>").addClass("fp-review-hint").text(hintText).appendTo($actions);
        }

        $box.append($msg);
        scrollMessagesToBottom();
    }

    // Apply mechanism covering all modification tiers:
    //   Tier 1 — property changes: mutate live node + {t:"edit"} history entry
    //   Tier 3 — wire changes: removeLink/addLink + {t:"add", removedLinks} entry
    //   Tier 4 — node removals: collect links, removeLink, remove node + {t:"delete"} entry
    // One history entry per node per type so Ctrl+Z steps back through them cleanly.
    function applyModifications(nodeDiffs, removeNodes, $applyBtn, idMap) {
        idMap = idMap || {};
        var propApplied = 0;
        var wireNodesApplied = 0;
        var nodesRemoved = 0;
        var failed = [];
        removeNodes = Array.isArray(removeNodes) ? removeNodes : [];

        // --- Tier 1: property changes ---
        nodeDiffs.forEach(function (d) {
            if (d.propertyChanges.length === 0) { return; }
            var liveNode = findLiveNode(d.modNode.id);
            if (!liveNode) { failed.push(d.modNode.id); return; }

            var oldValues = {};
            d.propertyChanges.forEach(function (c) { oldValues[c.key] = liveNode[c.key]; });
            d.propertyChanges.forEach(function (c) { liveNode[c.key] = c.newVal; });

            // Switch nodes derive their port count from rules.length (the edit
            // dialog's "outputCount" map assigns each rule its own output and
            // writes the resulting count to node.outputs on save). FlowPilot's
            // direct mutation above changes "rules" but never touches
            // "outputs", leaving the canvas showing the old port count even
            // though the new wires/rules are correct. Recompute it here so
            // RED.view.redraw(true) (below) rebuilds the ports - the redraw
            // loop rebuilds a node's output ports whenever __outputs__.length
            // !== d.outputs.
            if (liveNode.type === "switch" && Array.isArray(liveNode.rules) &&
                    liveNode.rules.length !== liveNode.outputs) {
                if (!oldValues.hasOwnProperty("outputs")) { oldValues.outputs = liveNode.outputs; }
                liveNode.outputs = liveNode.rules.length;
            }

            liveNode.changed = true;
            liveNode.dirty = true;
            RED.history.push({
                t: "edit",
                node: liveNode,
                changes: oldValues,
                dirty: RED.nodes.dirty()
            });
            propApplied++;
        });

        // --- Tier 3: wire changes ---
        // removeLink old + addLink new, then push ONE {t:"add", removedLinks} entry
        // per node. NR's undo for this shape removes the new links AND restores
        // the old ones (removedLinks field is present on every "add" wire event).
        nodeDiffs.forEach(function (d) {
            var wd = d.wiresDiff;
            if (!wd || (!wd.toRemove.length && !wd.toAdd.length)) { return; }
            var liveNode = findLiveNode(d.modNode.id);
            if (!liveNode) { return; }

            var removedLinks = [];
            var addedLinks = [];

            wd.toRemove.forEach(function (entry) {
                var found = null;
                RED.nodes.eachLink(function (l) {
                    if (found) { return; }
                    if (l.source && l.source.id === d.modNode.id &&
                            (l.sourcePort || 0) === entry.sourcePort &&
                            l.target && l.target.id === entry.targetId) {
                        found = l;
                    }
                });
                if (found) {
                    RED.nodes.removeLink(found);
                    removedLinks.push(found);
                }
            });

            wd.toAdd.forEach(function (entry) {
                // entry.targetId may be a placeholder id for a node inserted
                // by the SAME response (e.g. "fp-new-0") — resolve it to the
                // real id applyInsertions just assigned, if any.
                var targetId = idMap[entry.targetId] || entry.targetId;
                var toNode = (RED.nodes && RED.nodes.node) ? RED.nodes.node(targetId) : null;
                if (!toNode) { return; }
                var link = { source: liveNode, sourcePort: entry.sourcePort, target: toNode };
                try {
                    RED.nodes.addLink(link);
                    addedLinks.push(link);
                } catch (e) {
                    addMessage("error", "Failed to add wire: " + (e.message || e));
                }
            });

            if (removedLinks.length || addedLinks.length) {
                RED.history.push({
                    t: "add",
                    links: addedLinks,
                    removedLinks: removedLinks,
                    dirty: RED.nodes.dirty()
                });
                wireNodesApplied++;
            }
        });

        // --- Tier 4: node removals ---
        // Collect connected links BEFORE removing anything (for the history entry),
        // then remove the node — RED.nodes.remove(id) cleans up its own links
        // internally. RED.nodes.remove(id) takes an ID STRING (not a node object —
        // confirmed via red.js: removeNode(id) does `allNodes.hasNode(id)`, which
        // a node object fails silently, making it a no-op with no error). Push one
        // compound {t:"delete"} entry per node so a single Ctrl+Z restores both
        // the node and its links.
        //
        // Junction nodes (wire-splice points) are removed via
        // RED.nodes.removeJunction(junctionObj) (object, not id), with the
        // history entry's junction going in `junctions`, not `nodes` —
        // findLiveNode's junction-registry fallback returns the junction
        // object itself, which doubles as the isJunction check via .type.
        removeNodes.forEach(function (id) {
            var liveNode = findLiveNode(id);
            var isJunction = !!(liveNode && liveNode.type === "junction");

            if (!liveNode) { failed.push(id); return; }

            var connectedLinks = [];
            RED.nodes.eachLink(function (l) {
                if ((l.source && l.source.id === id) || (l.target && l.target.id === id)) {
                    connectedLinks.push(l);
                }
            });

            try {
                if (isJunction) {
                    RED.nodes.removeJunction(liveNode);
                } else {
                    RED.nodes.remove(liveNode.id);
                }
            } catch (e) {
                addMessage("error", "Failed to remove node " + id + ": " + (e.message || e));
                return;
            }

            // RED.nodes.remove()/removeJunction() do NOT clean up group
            // membership at all (confirmed via core source — getNode()'s
            // removal path never touches .g or group.nodes). Node-RED's
            // own UI delete action does this extra bookkeeping itself
            // (red.js's deleteSelection(), ~line 27151) rather than baking
            // it into the data-model removal call — replicate it here so a
            // removed grouped node doesn't leave a dangling reference in
            // group.nodes with a stale bounding box.
            if (liveNode.g && RED.nodes.group) {
                var ownerGroup = RED.nodes.group(liveNode.g);
                if (ownerGroup) {
                    var memberIdx = ownerGroup.nodes.indexOf(liveNode);
                    if (memberIdx !== -1) { ownerGroup.nodes.splice(memberIdx, 1); }
                    RED.group.markDirty(ownerGroup);
                }
            }

            RED.history.push({
                t: "delete",
                nodes: isJunction ? [] : [liveNode],
                links: connectedLinks,
                groups: [],
                junctions: isJunction ? [liveNode] : [],
                subflow: { id: undefined, instances: [] },
                subflowInputs: [],
                subflowOutputs: [],
                dirty: RED.nodes.dirty()
            });
            nodesRemoved++;
        });

        RED.nodes.dirty(true);
        RED.view.redraw(true);

        if ($applyBtn) { $applyBtn.prop("disabled", true).text("Applied ✓"); }

        var parts = [];
        if (propApplied) { parts.push("changes to " + propApplied + " node(s)"); }
        if (wireNodesApplied) { parts.push("wiring updates on " + wireNodesApplied + " node(s)"); }
        if (nodesRemoved) { parts.push("removed " + nodesRemoved + " node(s)"); }

        if (failed.length) {
            addMessage("error",
                (parts.length ? "Applied: " + parts.join(", ") + ". " : "") +
                failed.length + " node(s) not found and skipped: " + failed.join(", "));
        } else if (parts.length) {
            // Ground follow-up turns ("now undo the topic
            // change") in what was actually applied.
            var appliedNote = "Touchdown — applied " + parts.join(", ") + ". Ctrl+Z to undo.";
            addMessage("assistant", appliedNote);
            pushHistory("assistant", appliedNote);
            updateSelectionStatus();
        }
    }

    // Reconciles a Modify response's "newGroups" entries (Phase 8.5 C2
    // slice 3) against live state. Each entry's "nodes" is the FULL
    // desired membership for that group id — declarative, like "changes"
    // — not a one-shot "add these" instruction:
    //   - If a LIVE group already exists with this id (the model learned
    //     about it via sanitizeNode's context "group" field), membership
    //     is diffed against what's actually there now and reconciled via
    //     RED.group.addToGroup/removeFromGroup (both confirmed via core
    //     source to handle bounding-box math + dirty-marking themselves —
    //     nothing to reimplement), and a changed "name" is applied as a
    //     direct property edit, same shape as Tier 1.
    //   - If no live group matches, RED.group.createGroup(memberNodes)
    //     makes a brand new one — it always assigns its OWN fresh id
    //     (RED.nodes.id()), unlike applyInsertions' regular nodes, so
    //     there's no idMap entry to register for it (nothing in v1 wires
    //     to a group afterward anyway).
    // One RED.history.push per discrete operation (matching how Node-RED's
    // own group UI actions push them separately too), not one giant batch.
    // RED.group.createGroup()/addToGroup() both require every member to
    // share the exact same STARTING .g (all currently ungrouped, or all
    // already in the identical group) — a mix is rejected by NR core
    // itself: createGroup silently console.warns and returns undefined;
    // addToGroup throws outright (and even then only tolerates ONE
    // pre-existing source group, and only if that node is at index 0).
    // Live-confirmed (2026-06-30): asked to group a mix of previously-
    // ungrouped comment nodes plus one already-grouped node, createGroup
    // returned undefined, and "newGroup.name = g.name" then threw on
    // that undefined — caught and reported as "Failed to create group".
    // Detach every member from whatever group it's CURRENTLY in first
    // (batched per distinct old group, so each is one clean undo step),
    // so every member starts from .g === undefined before create/extend
    // ever runs — handles members arriving from any mix of prior states.
    function detachFromCurrentGroups(nodes, exceptGroupId) {
        var byOldGroup = {};
        nodes.forEach(function (n) {
            if (n.g && n.g !== exceptGroupId) {
                (byOldGroup[n.g] = byOldGroup[n.g] || []).push(n);
            }
        });
        Object.keys(byOldGroup).forEach(function (oldGroupId) {
            var oldGroup = findLiveNode(oldGroupId);
            if (oldGroup && oldGroup.type === "group") {
                var detached = byOldGroup[oldGroupId];
                RED.group.removeFromGroup(oldGroup, detached, false);
                RED.history.push({ t: "removeFromGroup", group: oldGroup, nodes: detached, dirty: RED.nodes.dirty() });
            }
        });
    }

    function applyGroupChanges(newGroups, idMap) {
        idMap = idMap || {};
        newGroups = Array.isArray(newGroups) ? newGroups : [];
        var groupsApplied = 0;

        newGroups.forEach(function (g) {
            if (!g || !g.id) { return; }
            var memberIds = Array.isArray(g.nodes) ? g.nodes : [];
            var memberNodes = memberIds.map(function (ref) {
                return findLiveNode(idMap[ref] || ref);
            }).filter(function (n) { return !!n; });

            // An EXISTING group reconciling down to ZERO members is a
            // legitimate, meaningful request — "ungroup everyone in this
            // group" — so the empty-members case is only a no-op for the
            // CREATE branch below (RED.group.createGroup on nothing makes
            // no sense; an existing group going empty does).
            var liveGroup = findLiveNode(g.id);
            if (!memberNodes.length && !(liveGroup && liveGroup.type === "group")) { return; }

            if (liveGroup && liveGroup.type === "group") {
                if (!memberNodes.length) {
                    // Full disband. RED.group.removeFromGroup only empties
                    // .nodes - it never removes the group object itself, so
                    // looping it down to zero members leaves a tiny, dangling
                    // empty group on the canvas (confirmed live). The
                    // editor's own "Ungroup Selection" action uses a
                    // different API for this exact case - RED.group.ungroup
                    // reparents members (or clears their .g) AND calls
                    // RED.nodes.removeGroup to actually remove the group.
                    RED.group.ungroup(liveGroup);
                    RED.history.push({ t: "ungroup", groups: [liveGroup], dirty: RED.nodes.dirty() });
                    groupsApplied++;
                } else {
                    var desiredIds = {};
                    memberNodes.forEach(function (n) { desiredIds[n.id] = true; });
                    var currentIds = {};
                    liveGroup.nodes.forEach(function (n) { currentIds[n.id] = true; });
                    var toRemove = liveGroup.nodes.filter(function (n) { return !desiredIds[n.id]; });
                    var toAdd = memberNodes.filter(function (n) { return !currentIds[n.id]; });

                    if (toRemove.length) {
                        RED.group.removeFromGroup(liveGroup, toRemove, false);
                        RED.history.push({ t: "removeFromGroup", group: liveGroup, nodes: toRemove, dirty: RED.nodes.dirty() });
                    }
                    if (toAdd.length) {
                        detachFromCurrentGroups(toAdd, liveGroup.id);
                        RED.group.addToGroup(liveGroup, toAdd);
                        RED.history.push({ t: "addToGroup", group: liveGroup, nodes: toAdd, dirty: RED.nodes.dirty() });
                    }
                    if (g.name !== undefined && g.name !== liveGroup.name) {
                        var oldName = liveGroup.name;
                        liveGroup.name = g.name;
                        liveGroup.changed = true;
                        RED.history.push({ t: "edit", node: liveGroup, changes: { name: oldName }, dirty: RED.nodes.dirty() });
                    }
                    groupsApplied++;
                }
            } else {
                try {
                    detachFromCurrentGroups(memberNodes);
                    var newGroup = RED.group.createGroup(memberNodes);
                    if (g.name) { newGroup.name = g.name; }
                    RED.group.markDirty(newGroup);
                    RED.history.push({ t: "createGroup", groups: [newGroup], dirty: RED.nodes.dirty() });
                    groupsApplied++;
                } catch (e) {
                    addMessage("error", "Failed to create group: " + (e.message || e));
                }
            }
        });

        if (groupsApplied) {
            RED.nodes.dirty(true);
            RED.view.redraw(true);
            var groupNote = "Touchdown — created/updated " + groupsApplied +
                " group(s). Ctrl+Z to undo.";
            addMessage("assistant", groupNote);
            pushHistory("assistant", groupNote);
        }
        return groupsApplied;
    }

    var CORE_NODE_TYPES = {
        "inject": true, "debug": true, "complete": true, "catch": true, "status": true,
        "link in": true, "link out": true, "link call": true, "comment": true,
        "junction": true, "unknown": true, "group": true,
        "function": true, "switch": true, "change": true, "range": true, "template": true,
        "mqtt in": true, "mqtt out": true, "mqtt-broker": true,
        "http in": true, "http response": true, "http request": true,
        "websocket in": true, "websocket out": true,
        "websocket-listener": true, "websocket-client": true,
        "tcp in": true, "tcp out": true, "tcp request": true,
        "udp in": true, "udp out": true, "tls-config": true, "httpproxy": true,
        "split": true, "join": true, "sort": true, "batch": true,
        "csv": true, "html": true, "json": true, "xml": true, "yaml": true,
        "file": true, "file in": true, "watch": true, "tail": true,
        "exec": true, "delay": true, "trigger": true
    };

    // Checks the two things only the live editor can tell us before import:
    // (1) wire integrity — every wire target id must exist in the generated
    // set (the model can hallucinate ids); (2) node-type classification —
    // core / non-core-but-installed / not-installed, via RED.nodes.getType.
    // Returns per-node summary entries plus separated warning/problem lists
    // so the review UI can render them and decide whether import is offered.
    function validateGeneratedFlow(flow) {
        var nodes = Array.isArray(flow) ? flow : [];
        var ids = {};
        nodes.forEach(function (n) {
            if (n && n.id) { ids[n.id] = true; }
        });

        var summary = [];
        var typeWarnings = [];
        var brokenWires = [];
        var realWireCount = 0;

        nodes.forEach(function (n) {
            if (!n || !n.id || !n.type) { return; }

            var isCore = !!CORE_NODE_TYPES[n.type];
            var isInstalled = !!RED.nodes.getType(n.type);
            var status = isCore ? "core" : (isInstalled ? "non-core-installed" : "not-installed");

            var entry = { id: n.id, type: n.type, name: n.name || "", status: status };
            summary.push(entry);
            if (status !== "core") { typeWarnings.push(entry); }

            (Array.isArray(n.wires) ? n.wires : []).forEach(function (port) {
                (Array.isArray(port) ? port : []).forEach(function (targetId) {
                    if (!ids[targetId]) {
                        brokenWires.push({ from: n.id, type: n.type, target: targetId });
                    } else {
                        realWireCount++;
                    }
                });
            });
        });

        // A multi-node flow with zero connections anywhere is almost always
        // a generation slip (the model omitted "wires" on every node) rather
        // than something the user actually wanted — flag it, but don't
        // block import; a handful of genuinely independent nodes is rare
        // but not impossible.
        var nonCommentCount = nodes.filter(function (n) { return n && n.type !== "comment"; }).length;
        var noConnections = nonCommentCount > 1 && realWireCount === 0;

        return { summary: summary, typeWarnings: typeWarnings, brokenWires: brokenWires, noConnections: noConnections };
    }

    // The generation prompt deliberately omits x/y ("the editor assigns those
    // on import"), but RED.view.importNodes does NOT auto-arrange nodes that
    // lack coordinates — it just places them on top of each other. So we lay
    // them out ourselves:
    //
    // - Non-comment wired nodes are split into connected components (a
    //   component = nodes reachable from each other via wires, in either
    //   direction). Each component gets its own horizontal "band", stacked
    //   top to bottom, ordered by where its first node appears in `flow`.
    //   Within a band, columns are topological depth (longest path from an
    //   in-degree-0 node) and rows stack top-to-bottom within a column —
    //   same approach as before, just scoped to one component at a time so
    //   independent chains (e.g. a scheduler pipeline vs. an HTTP endpoint)
    //   don't get interleaved into the same rows.
    // - Comment nodes have no wires to anchor them, so each is matched to
    //   the nearest non-comment node adjacent to it in the `flow` array
    //   (forward, then backward) — models place a comment next to the
    //   section it describes — and placed in a header row above that node's
    //   column, in that node's component's band.
    //
    // Config nodes (no "wires" array — e.g. mqtt-broker) are left untouched;
    // they don't live on the canvas and have no x/y/z of their own.
    function layoutGeneratedFlow(flow) {
        var COL_WIDTH = 200;
        var ROW_HEIGHT = 90;
        var BASE_X = 160;
        var BASE_Y = 120;
        var BAND_GAP_ROWS = 1;

        var nodes = Array.isArray(flow) ? flow : [];
        var wiredNodes = nodes.filter(function (n) { return n && Array.isArray(n.wires) && n.type !== "comment"; });
        var commentNodes = nodes.filter(function (n) { return n && n.type === "comment"; });

        if (!wiredNodes.length) {
            // Nothing to anchor comments to — just stack everything.
            nodes.forEach(function (n, i) {
                if (!n) { return; }
                n.x = BASE_X;
                n.y = BASE_Y + i * ROW_HEIGHT;
            });
            return nodes;
        }

        var byId = {};
        wiredNodes.forEach(function (n) { byId[n.id] = n; });

        // ---- Connected components (undirected: wires in either direction) ----
        var adjacency = {};
        wiredNodes.forEach(function (n) { adjacency[n.id] = []; });
        wiredNodes.forEach(function (n) {
            n.wires.forEach(function (port) {
                (Array.isArray(port) ? port : []).forEach(function (targetId) {
                    if (!byId[targetId]) { return; }
                    adjacency[n.id].push(targetId);
                    adjacency[targetId].push(n.id);
                });
            });
        });

        var orderIndex = {};
        nodes.forEach(function (n, i) { if (n && n.id) { orderIndex[n.id] = i; } });

        var visited = {};
        var components = [];
        wiredNodes.forEach(function (start) {
            if (visited[start.id]) { return; }
            var stack = [start.id];
            var members = [];
            visited[start.id] = true;
            while (stack.length) {
                var id = stack.pop();
                members.push(id);
                adjacency[id].forEach(function (neighborId) {
                    if (!visited[neighborId]) { visited[neighborId] = true; stack.push(neighborId); }
                });
            }
            components.push(members);
        });

        // Order bands by where each component first appears in `flow`, so
        // the layout roughly follows generation order top to bottom.
        components.sort(function (a, b) {
            var minA = Math.min.apply(null, a.map(function (id) { return orderIndex[id]; }));
            var minB = Math.min.apply(null, b.map(function (id) { return orderIndex[id]; }));
            return minA - minB;
        });

        // Column = longest path from an in-degree-0 node, scoped to this
        // component only (so independent chains don't influence each other).
        function assignColumns(members) {
            var memberSet = {};
            members.forEach(function (id) { memberSet[id] = true; });

            var incoming = {};
            members.forEach(function (id) { incoming[id] = 0; });
            members.forEach(function (id) {
                byId[id].wires.forEach(function (port) {
                    (Array.isArray(port) ? port : []).forEach(function (targetId) {
                        if (memberSet[targetId]) { incoming[targetId] += 1; }
                    });
                });
            });

            var column = {};
            members.forEach(function (id) { column[id] = incoming[id] === 0 ? 0 : -1; });
            var changed = true;
            var guard = 0;
            while (changed && guard <= members.length) {
                changed = false;
                guard += 1;
                members.forEach(function (id) {
                    var fromCol = column[id] < 0 ? 0 : column[id];
                    byId[id].wires.forEach(function (port) {
                        (Array.isArray(port) ? port : []).forEach(function (targetId) {
                            if (!memberSet[targetId]) { return; }
                            if (column[targetId] < fromCol + 1) {
                                column[targetId] = fromCol + 1;
                                changed = true;
                            }
                        });
                    });
                });
            }
            members.forEach(function (id) { if (column[id] < 0) { column[id] = 0; } });
            return column;
        }

        // ---- Anchor each comment to the nearest non-comment node adjacent
        // to it in `flow` (forward, then backward). ----
        function nearestWiredNeighbor(commentIndex) {
            var i, candidate;
            for (i = commentIndex + 1; i < nodes.length; i++) {
                candidate = nodes[i];
                if (candidate && byId[candidate.id]) { return candidate.id; }
            }
            for (i = commentIndex - 1; i >= 0; i--) {
                candidate = nodes[i];
                if (candidate && byId[candidate.id]) { return candidate.id; }
            }
            return null;
        }

        var commentsByAnchor = {}; // wired-node id -> [comment nodes]
        var unanchoredComments = [];
        commentNodes.forEach(function (c) {
            var anchorId = nearestWiredNeighbor(nodes.indexOf(c));
            if (anchorId) {
                (commentsByAnchor[anchorId] = commentsByAnchor[anchorId] || []).push(c);
            } else {
                unanchoredComments.push(c);
            }
        });

        // ---- Lay out each component in its own band, leaving a header row
        // for any comments anchored within it. ----
        var nextBandY = BASE_Y;
        components.forEach(function (members) {
            var column = assignColumns(members);

            var headerCols = {};
            var hasHeader = false;
            members.forEach(function (id) {
                (commentsByAnchor[id] || []).forEach(function (c) {
                    headerCols[column[id]] = headerCols[column[id]] || [];
                    headerCols[column[id]].push(c);
                    hasHeader = true;
                });
            });
            var bodyOffset = hasHeader ? 1 : 0;

            var rowsUsed = {};
            var maxRows = 0;
            members.forEach(function (id) {
                var col = column[id];
                var row = rowsUsed[col] || 0;
                rowsUsed[col] = row + 1;
                maxRows = Math.max(maxRows, row + 1);
                var n = byId[id];
                n.x = BASE_X + col * COL_WIDTH;
                n.y = nextBandY + (bodyOffset + row) * ROW_HEIGHT;
            });

            Object.keys(headerCols).forEach(function (col) {
                headerCols[col].forEach(function (c, i) {
                    c.x = BASE_X + Number(col) * COL_WIDTH;
                    c.y = nextBandY + i * Math.round(ROW_HEIGHT / 2);
                });
            });

            nextBandY += (bodyOffset + maxRows + BAND_GAP_ROWS) * ROW_HEIGHT;
        });

        // Comments that couldn't be anchored (only possible if `flow` is
        // entirely comments, which the early-return above already handles)
        // are stacked below everything else as a fallback.
        unanchoredComments.forEach(function (c, i) {
            c.x = BASE_X;
            c.y = nextBandY + i * ROW_HEIGHT;
        });

        return nodes;
    }

    function importGeneratedFlow(nodes, onImported) {
        try {
            // importNodes returns { nodeMap }, mapping each input node's own
            // id to the real live node object Node-RED just created (ids are
            // regenerated since generateIds:true) — onImported (the /build
            // loop) needs this to know what it actually has on the canvas.
            var importResult = RED.view.importNodes(nodes, { generateIds: true });
            // Ground follow-up turns in what was just
            // imported (placement itself happens on the next canvas click).
            var n = Array.isArray(nodes) ? nodes.length : 0;
            var importedNote = "Landed — imported " + n + " node(s). Click the canvas to place them.";
            addMessage("assistant", importedNote);
            pushHistory("assistant", importedNote);
            updateSelectionStatus();
            if (typeof onImported === "function") { onImported(importResult); }
        } catch (e) {
            addMessage("error", "Import failed: " + (e && e.message ? e.message : String(e)));
        }
    }

    function addGeneratedReview(flow, onImported, buildGoal) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }

        var nodes = Array.isArray(flow) ? flow : [];
        var v = validateGeneratedFlow(nodes);

        var $msg = $("<div>").addClass("fp-message fp-review");
        // Pop-out slice 3 (plain Generate/Document, no onImported): tag
        // with the raw flow data so the relay can wire up a WORKING "Add
        // to workspace" button in the pop-out. /build's first proposal
        // (onImported set, buildGoal present) gets its own tag instead —
        // importing it also needs to start the loop (startBuildLoop),
        // which the parent does itself once it gets the relayed intent;
        // see the "applyBuild" handler in initMainWindow.
        if (!onImported) {
            $msg.attr("data-fp-apply-flow", JSON.stringify(nodes));
        } else if (buildGoal) {
            $msg.attr("data-fp-apply-build", JSON.stringify({ flow: nodes, goal: buildGoal }));
        }
        $("<div>").addClass("fp-label").text("GENERATED FLOW — REVIEW").appendTo($msg);

        var $tabSummary = $("<button>").addClass("fp-tab fp-tab-active").attr("type", "button").text("Summary");
        var $tabJson = $("<button>").addClass("fp-tab").attr("type", "button").text("JSON");
        $("<div>").addClass("fp-tabs").append($tabSummary, $tabJson).appendTo($msg);

        var $summaryPanel = $("<div>").addClass("fp-tab-panel");
        var $jsonPanel = $("<div>").addClass("fp-tab-panel fp-hidden");
        $msg.append($summaryPanel, $jsonPanel);

        // ---- Summary tab ----
        $("<div>").addClass("fp-review-count")
            .text("Generated " + nodes.length + " node" + (nodes.length === 1 ? "" : "s") + ":")
            .appendTo($summaryPanel);

        var $list = $("<ul>").addClass("fp-review-list").appendTo($summaryPanel);
        v.summary.forEach(function (item) {
            var $li = $("<li>").text(item.type + (item.name ? " — \"" + item.name + "\"" : ""));
            if (item.status === "not-installed") {
                $("<span>").addClass("fp-type-flag").text(" ⚠ not installed").appendTo($li);
            } else if (item.status === "non-core-installed") {
                $("<span>").addClass("fp-type-flag").text(" ⚠ non-core").appendTo($li);
            }
            $list.append($li);
        });

        if (v.noConnections) {
            var $wireWarn = $("<div>").addClass("fp-warning fp-review-warning").appendTo($summaryPanel);
            $("<strong>").text("⚠ These nodes aren't wired to each other.").appendTo($wireWarn);
            $("<div>").text("None of the " + nodes.length + " generated nodes connect to one another — " +
                "they'll land on the canvas disconnected. You can wire them manually, or ask FlowPilot " +
                "to regenerate.").appendTo($wireWarn);
        }

        if (v.typeWarnings.length) {
            var $warn = $("<div>").addClass("fp-warning fp-review-warning").appendTo($summaryPanel);
            $("<strong>").text("Type warnings — review before adding:").appendTo($warn);
            var $wlist = $("<ul>").appendTo($warn);
            v.typeWarnings.forEach(function (w) {
                var reason = w.status === "not-installed"
                    ? "not installed — will appear as a broken placeholder until the module is added"
                    : "installed, but not a core Node-RED type — may be less stable across versions";
                $("<li>").text(w.type + ": " + reason).appendTo($wlist);
            });
            $("<div>").text("You can add it anyway, or ask FlowPilot to regenerate using only core nodes.").appendTo($warn);
        }

        // ---- JSON tab ----
        var jsonText = JSON.stringify(nodes, null, 2);
        var $copyBtn = $("<button>")
            .addClass("red-ui-button red-ui-button-small")
            .attr("type", "button")
            .text("Copy")
            .on("click", function () { copyToClipboard($copyBtn, jsonText); });
        $("<div>").addClass("fp-json-toolbar").append($copyBtn).appendTo($jsonPanel);
        $("<pre>").addClass("fp-json").text(jsonText).appendTo($jsonPanel);

        function activateTab(showSummary) {
            $tabSummary.toggleClass("fp-tab-active", showSummary);
            $tabJson.toggleClass("fp-tab-active", !showSummary);
            $summaryPanel.toggleClass("fp-hidden", !showSummary);
            $jsonPanel.toggleClass("fp-hidden", showSummary);
        }
        $tabSummary.on("click", function () { activateTab(true); });
        $tabJson.on("click", function () { activateTab(false); });

        // ---- Action row ----
        var $actions = $("<div>").addClass("fp-review-actions").appendTo($msg);
        if (v.brokenWires.length) {
            $("<div>").addClass("fp-warning").text(
                "This flow has " + v.brokenWires.length + " wire(s) pointing to node ids " +
                "that don't exist in the generated set, so it can't be safely imported. " +
                "Try asking FlowPilot to regenerate it."
            ).appendTo($actions);
        } else if (!nodes.length) {
            $("<div>").addClass("fp-warning").text("No nodes were generated — nothing to add.").appendTo($actions);
        } else {
            var $addBtn = $("<button>")
                .addClass("red-ui-button red-ui-button-primary")
                .attr("type", "button")
                .text("Add to workspace")
                .on("click", function () {
                    $addBtn.prop("disabled", true).text("Click the canvas to place…");
                    importGeneratedFlow(nodes, onImported);
                });
            $actions.append($addBtn);
            $("<span>").addClass("fp-review-hint")
                .text("Opens Node-RED's normal place-at-cursor import — click the canvas to drop the nodes.")
                .appendTo($actions);
        }

        $box.append($msg);
        scrollMessagesToBottom();
        return $msg;
    }

