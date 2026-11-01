    // Runtime truth is deliberately read through Node-RED's Admin API. The
    // editor's in-memory RED.nodes registry is useful for editing, but it is
    // not evidence that a deploy reached the running runtime.

    var RUNTIME_TRUTH_LAYOUT_KEYS = {
        id: true, x: true, y: true, wires: true, dirty: true, changed: true,
        moved: true, valid: true, _def: true, l: true
    };

    function runtimeTruthError(value) {
        if (!value) { return "The Node-RED Admin API could not confirm the runtime flow."; }
        var text = typeof value === "string" ? value : value.message || value.error ||
            (value.status ? "The Node-RED Admin API returned status " + value.status + "." : String(value));
        return String(text).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }

    function runtimeTruthRequest(done) {
        var url = typeof flowpilotUrl === "function" ? flowpilotUrl("flows") : "flows";
        if (typeof $ === "undefined" || !$ || typeof $.ajax !== "function") {
            done(null, "The editor's Admin API client is unavailable.");
            return;
        }
        $.ajax({
            url: url,
            method: "GET",
            dataType: "json",
            headers: { "Node-RED-API-Version": "v2" },
            beforeSend: function (jqXHR) {
                if (typeof RED === "undefined" || !RED.settings || typeof RED.settings.get !== "function") { return; }
                var tokens = RED.settings.get("auth-tokens");
                if (tokens && tokens.access_token) {
                    jqXHR.setRequestHeader("Authorization", "Bearer " + tokens.access_token);
                }
            },
            success: function (data) {
                if (!data || data.rev === undefined || !Array.isArray(data.flows)) {
                    done(null, "Node-RED returned an invalid /flows response.");
                    return;
                }
                done({ rev: data.rev, flows: data.flows });
            },
            error: function (xhr, textStatus) {
                var detail = xhr && (xhr.responseJSON || xhr.responseText || xhr.statusText);
                done(null, runtimeTruthError(detail || textStatus || (xhr && xhr.status)));
            }
        });
    }

    // Optional request is only for deterministic tests. The browser path
    // always uses the editor's authenticated $.ajax client above.
    function fetchDeployedFlows(done, request) {
        var finish = typeof done === "function" ? done : function () {};
        if (typeof request === "function") {
            try {
                request(function (value) {
                    if (value && value.error && !Array.isArray(value.flows)) {
                        finish(null, runtimeTruthError(value));
                    } else {
                        finish(value);
                    }
                }, function (error) { finish(null, runtimeTruthError(error)); });
            } catch (e) {
                finish(null, runtimeTruthError(e));
            }
            return;
        }
        runtimeTruthRequest(finish);
    }

    function runtimeTruthNodeId(value) {
        return typeof value === "string" ? value : value && value.id;
    }

    function runtimeTruthWire(value) {
        var from = value && (value.from || value.sourceId || value.source);
        var to = value && (value.to || value.targetId || value.target);
        from = runtimeTruthNodeId(from);
        to = runtimeTruthNodeId(to);
        if (!from || !to) { return null; }
        return { from: from, fromPort: Number(value.fromPort !== undefined ? value.fromPort : value.sourcePort) || 0, to: to };
    }

    function runtimeTruthNodeConfig(node) {
        var config = {};
        Object.keys(node || {}).forEach(function (key) {
            if (RUNTIME_TRUTH_LAYOUT_KEYS[key]) { return; }
            config[key] = node[key];
        });
        return config;
    }

    function runtimeTruthValue(value) {
        if (value && typeof value === "object") {
            if (Array.isArray(value)) { return value.map(runtimeTruthValue); }
            var copy = {};
            Object.keys(value).sort().forEach(function (key) { copy[key] = runtimeTruthValue(value[key]); });
            return copy;
        }
        return value;
    }

    function runtimeTruthNodeDifferences(expected, actual) {
        var left = runtimeTruthNodeConfig(expected);
        var right = runtimeTruthNodeConfig(actual);
        var differences = [];
        Object.keys(left).concat(Object.keys(right)).filter(function (key, index, all) {
            return all.indexOf(key) === index;
        }).forEach(function (key) {
            if (JSON.stringify(runtimeTruthValue(left[key])) !== JSON.stringify(runtimeTruthValue(right[key]))) {
                differences.push({ key: key, expected: left[key], actual: right[key] });
            }
        });
        return differences;
    }

    function runtimeTruthDeployedWires(flows) {
        var wires = [];
        (Array.isArray(flows) ? flows : []).forEach(function (node) {
            (Array.isArray(node && node.wires) ? node.wires : []).forEach(function (targets, port) {
                (Array.isArray(targets) ? targets : []).forEach(function (target) {
                    var wire = runtimeTruthWire({ from: node.id, fromPort: port, to: target });
                    if (wire) { wires.push(wire); }
                });
            });
        });
        return wires;
    }

    function runtimeTruthSameWire(left, right) {
        return !!left && !!right && left.from === right.from &&
            left.fromPort === right.fromPort && left.to === right.to;
    }

    function compareRunToRuntime(runNodes, runWires, deployed) {
        var flows = deployed && Array.isArray(deployed.flows) ? deployed.flows : [];
        var byId = {};
        flows.forEach(function (node) { if (node && node.id) { byId[node.id] = node; } });
        var nodes = { present: [], missing: [], differ: [] };
        (Array.isArray(runNodes) ? runNodes : []).forEach(function (expected) {
            if (!expected || !expected.id) { return; }
            var actual = byId[expected.id];
            if (!actual) { nodes.missing.push(expected); return; }
            var differences = runtimeTruthNodeDifferences(expected, actual);
            if (differences.length) {
                nodes.differ.push({ id: expected.id, expected: expected, actual: actual, differences: differences });
            } else {
                nodes.present.push(expected.id);
            }
        });

        var actualWires = runtimeTruthDeployedWires(flows);
        var wires = { present: [], missing: [], differ: [] };
        (Array.isArray(runWires) ? runWires : []).map(runtimeTruthWire).filter(Boolean).forEach(function (expected) {
            if (actualWires.some(function (actual) { return runtimeTruthSameWire(expected, actual); })) {
                wires.present.push(expected);
                return;
            }
            var sameEndpoints = actualWires.filter(function (actual) {
                return actual.from === expected.from && actual.to === expected.to;
            });
            if (sameEndpoints.length) {
                wires.differ.push({ expected: expected, actual: sameEndpoints[0] });
            } else {
                wires.missing.push(expected);
            }
        });
        return { nodes: nodes, wires: wires };
    }

    function confirmDeploy(beforeRev, runNodes, runWires, done, request) {
        fetchDeployedFlows(function (deployed, error) {
            if (!deployed) {
                done({ confirmed: false, missing: { nodes: [], wires: [] }, rev: null,
                    reason: "couldn't read the runtime from GET /flows: " + runtimeTruthError(error) });
                return;
            }
            var comparison = compareRunToRuntime(runNodes, runWires, deployed);
            var hasChanges = (Array.isArray(runNodes) && runNodes.length > 0) ||
                (Array.isArray(runWires) && runWires.length > 0);
            // A node that's there with a different type or tab isn't the run's
            // node. Other config differences are reported, not fatal: the
            // editor's export and the runtime's copy can differ in defaults.
            var wrongNodes = comparison.nodes.differ.filter(function (item) {
                return item.differences.some(function (d) { return d.key === "type" || d.key === "z"; });
            });
            var missing = {
                nodes: comparison.nodes.missing.concat(wrongNodes),
                wires: comparison.wires.missing.concat(comparison.wires.differ)
            };
            var revChecked = beforeRev !== null && beforeRev !== undefined;
            var confirmed = (!hasChanges || !revChecked || String(deployed.rev) !== String(beforeRev)) &&
                missing.nodes.length === 0 && missing.wires.length === 0;
            var reason = "";
            if (hasChanges && revChecked && String(deployed.rev) === String(beforeRev)) {
                reason = "Node-RED kept revision " + String(deployed.rev) + "; it did not report a new deploy.";
            } else if (missing.nodes.length || missing.wires.length) {
                reason = "runtime is missing " + missing.nodes.length + " node(s) and " + missing.wires.length + " wire(s) from this run.";
            }
            done({ confirmed: confirmed, missing: missing, comparison: comparison, rev: deployed.rev, reason: reason });
        }, request);
    }

    function runtimeTruthProofOutcome(evidence, goal) {
        goal = goal || {};
        if (goal.runtimeConfirmed === false) {
            var invalid = goal.invalidNodeNames || [];
            var missing = goal.missingNodeNames || goal.goalNames || [];
            if (invalid.length) {
                return { state: "not-tested", label: "Not tested: " + invalid.join(", ") +
                    (invalid.length === 1 ? " is" : " are") + " invalid in Node-RED, so " +
                    (invalid.length === 1 ? "it" : "they") + " can't run", note: "runtime not confirmed" };
            }
            // With no names, the subject is "the flow" (QA pass 4: "Not
            // tested: the target aren't deployed").
            return { state: "not-tested", label: "Not tested: " + (missing.length ? missing.join(", ") +
                (missing.length === 1 ? " isn't" : " aren't") : "the flow isn't") + " deployed", note: "runtime not confirmed" };
        }
        if (Array.isArray(evidence) && evidence.length) {
            var last = evidence[evidence.length - 1] || {};
            var shown = typeof runtimeDescribeValue === "function" ? runtimeDescribeValue(last.value)
                : String(last.value === undefined ? "" : last.value);
            return { state: "observed", label: "Run: observed — " + shown +
                " (at " + (last.node || last.name || "goal") + ")" };
        }
        return { state: "no-output", label: "Ran, but no runtime output was observed", note: "Ran, but no runtime output was observed" };
    }

    function runtimeReloadNotice(referencedNodeIds, editorNodeIds, deployed, flowsLoaded) {
        if (!flowsLoaded) { return null; }
        var editor = {};
        (Array.isArray(editorNodeIds) ? editorNodeIds : []).forEach(function (id) { editor[id] = true; });
        var runtime = {};
        ((deployed && deployed.flows) || []).forEach(function (node) { if (node && node.id) { runtime[node.id] = true; } });
        var missing = (Array.isArray(referencedNodeIds) ? referencedNodeIds : []).filter(function (id) {
            return id && !/^fp-tap[-:]/.test(id) && !editor[id] && !runtime[id];
        });
        return missing.length ? "Some nodes from this chat weren't deployed and are gone after the reload." : null;
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            fetchDeployedFlows: fetchDeployedFlows,
            compareRunToRuntime: compareRunToRuntime,
            confirmDeploy: confirmDeploy,
            runtimeProofOutcome: runtimeTruthProofOutcome,
            runtimeReloadNotice: runtimeReloadNotice
        };
    }
