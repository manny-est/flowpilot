    // SF-3 validation. This fragment deliberately contains no parser or
    // evaluator: function code is checked by the authenticated server route
    // (C3), because the editor's CSP must not require eval/new Function.
    var VALIDATION_MAX_ATTEMPTS = 3;

    var VALIDATION_CORE_ALTERNATIVES = {
        "node-red-dashboard": "change or template",
        "ui_": "template or dashboard-free core nodes",
        "unknown": "function or change",
        "default": "function or change"
    };

    function validationOutputCount(node) {
        if (!node) { return 0; }
        if (typeof node.outputs === "number") { return node.outputs; }
        if (node._def && typeof node._def.outputs === "number") { return node._def.outputs; }
        if (node.type === "switch" && Array.isArray(node.rules)) { return node.rules.length; }
        return 1;
    }

    function validationInputCount(node) {
        if (!node) { return 0; }
        if (typeof node.inputs === "number") { return node.inputs; }
        if (node._def && typeof node._def.inputs === "number") { return node._def.inputs; }
        return node.type === "comment" || node.type === "group" ? 0 : 1;
    }

    function validationTypePackage(node, options) {
        var def = node && node._def;
        if (def && (def.module || def.palette)) { return def.module || def.palette; }
        if (options && options.palettePackages && node && options.palettePackages[node.type]) {
            return options.palettePackages[node.type];
        }
        return null;
    }

    function validationInstalled(node, options) {
        if (!node || !node.type) { return false; }
        // These are editor entities, not palette node types. RED.nodes.getType
        // quite correctly returns nothing for them, but treating that as a
        // missing add-on is false and sends a bad repair request to the model.
        if (node.type === "group" || node.type === "junction") { return true; }
        if (options && typeof options.isInstalled === "function") {
            return !!options.isInstalled(node.type, node);
        }
        if (options && options.installedTypes) {
            return !!options.installedTypes[node.type];
        }
        if (node._def) { return true; }
        return false;
    }

    function validationCheck(status, name, message, extra) {
        return Object.assign({ status: status, check: name, message: message }, extra || {});
    }

    function validationErrorList(node) {
        var errors = node && node.validationErrors;
        if (Array.isArray(errors)) { return errors.map(String); }
        if (errors && typeof errors === "object") {
            return Object.keys(errors).map(function (key) {
                return key + ": " + String(errors[key]);
            });
        }
        return errors ? [String(errors)] : [];
    }

    function validationValueMissing(value) {
        return value === undefined || value === null || value === "";
    }

    function validationCredentialIssue(node, errors) {
        if (!node) { return false; }
        if (node.credentialsMissing === true || node.missingCredentials === true) { return true; }
        return errors.some(function (error) {
            return /credential|password|secret|token|api[ -]?key/i.test(error);
        });
    }

    function validationFunctionWarning(node) {
        if (!node || node.type !== "function" || typeof node.func !== "string") { return []; }
        var body = node.func.replace(/^\s+|\s+$/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").trim();
        var warnings = [];
        if (Number(node.outputs) > 1 && /^return\s+msg\s*;?$/m.test(body) &&
                body.replace(/^return\s+msg\s*;?$/m, "").trim() === "") {
            warnings.push("This function has multiple outputs but only returns msg; use return [msg, ...] or reduce outputs.");
        }
        if (Number(node.outputs) === 1 && /^return\s*\[\s*msg\s*\]\s*;?$/m.test(body) &&
                body.replace(/^return\s*\[\s*msg\s*\]\s*;?$/m, "").trim() === "") {
            warnings.push("This function returns [msg] with one output; return msg instead.");
        }
        if (/^msg(?:\.[A-Za-z_$][\w$]*|\[['"][^'"]+['"]\])\s*=/.test(body) &&
                /return\s+msg\s*;?$/.test(body)) {
            warnings.push("This is a plain message property assignment; a Change node is clearer and avoids a Function node.");
        } else if (/^if\s*\([\s\S]+\)\s*return\s+msg/.test(body) &&
                /return\s+(?:null|msg)\s*;?/.test(body)) {
            warnings.push("This is simple routing; consider a Switch node instead of a Function node.");
        }
        return warnings;
    }

    function validationDebugComplete(node) {
        if (!node || node.type !== "debug" || !Object.prototype.hasOwnProperty.call(node, "complete")) {
            return null;
        }
        var complete = node.complete;
        if (complete === "true" || complete === "false") { return null; }
        // With targetType "jsonata", complete holds an expression, not a path.
        if (node.targetType === "jsonata") { return null; }
        var label = node.name || node.id || "unnamed";
        if (complete === "msg") {
            return {
                status: "warn",
                message: "Debug '" + label + "' shows msg.msg; use 'true' for the whole message",
                suggestion: "Use 'true' to show the whole message."
            };
        }
        var propertyPath = typeof complete === "string" &&
            /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(complete);
        if (propertyPath) { return null; }
        // A warning, never a blocker: the ticket's rule, and an unusual value
        // may still be one Node-RED accepts.
        return {
            status: "warn",
            message: "Debug '" + label + "' has an unusual output setting; use 'true', 'false', or a property path.",
            suggestion: "Use 'true' for the whole message, or a property path such as 'payload'."
        };
    }

    // An http request returns a string unless ret is "obj", so a downstream
    // function reading msg.payload.<field> gets undefined (live, round 3:
    // Spark's weather build observed "Could not parse weather data"). String
    // members such as .length or .split are fine on text.
    var HTTP_TEXT_PAYLOAD_MEMBERS = /^(?:length|split|trim|toString|match|replace|indexOf|includes|slice|substring|substr|toLowerCase|toUpperCase|startsWith|endsWith|charAt|concat|padStart|padEnd|search|lastIndexOf)$/;
    function validationHttpReturnsText(node, byId) {
        if (!node || node.type !== "http request") { return null; }
        if (node.ret === "obj" || node.ret === "bin") { return null; }
        var label = node.name || node.id || "unnamed";
        var reader = null;
        (Array.isArray(node.wires) ? node.wires : []).forEach(function (targets) {
            (Array.isArray(targets) ? targets : []).forEach(function (targetId) {
                var target = byId[targetId];
                if (reader || !target || target.type !== "function" || typeof target.func !== "string") { return; }
                if (/JSON\.parse\s*\(/.test(target.func)) { return; }
                var re = /msg\.payload\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[)/g, m;
                while ((m = re.exec(target.func))) {
                    if (!m[1] || !HTTP_TEXT_PAYLOAD_MEMBERS.test(m[1])) { reader = target; return; }
                }
            });
        });
        if (!reader) { return null; }
        return {
            status: "fail",
            message: "HTTP request '" + label + "' returns text, but function '" + (reader.name || reader.id) +
                "' reads fields from msg.payload; set ret to \"obj\" so it returns a parsed JSON object.",
            suggestion: "Set the http request's ret to \"obj\" (a parsed JSON object)."
        };
    }

    function validationFlowNodes() {
        var nodes = [];
        if (typeof RED !== "undefined" && RED.nodes && typeof RED.nodes.eachNode === "function") {
            RED.nodes.eachNode(function (node) { nodes.push(node); });
        }
        if (typeof RED !== "undefined" && RED.nodes && typeof RED.nodes.eachConfig === "function") {
            RED.nodes.eachConfig(function (node) { if (nodes.indexOf(node) === -1) { nodes.push(node); } });
        }
        return nodes;
    }

    // Pure structural validation. `options` is intentionally injectable so
    // fixture tests can model installed palettes without duplicating this
    // implementation; the live path supplies RED.nodes.getType.
    function validateFlow(nodes, options) {
        options = options || {};
        nodes = Array.isArray(nodes) ? nodes : [];
        var byId = {};
        (Array.isArray(options.allNodes) ? options.allNodes : nodes).forEach(function (node) {
            if (node && node.id) { byId[node.id] = node; }
        });
        var checks = [];
        var perNode = {};
        var failures = [];
        var needsYou = [];
        var warnings = [];

        function add(node, check) {
            var id = node && node.id ? node.id : "(unknown)";
            if (!perNode[id]) { perNode[id] = { id: id, type: node && node.type, checks: [] }; }
            perNode[id].checks.push(check);
            checks.push(Object.assign({ nodeId: id }, check));
            if (check.status === "fail") {
                failures.push(checks[checks.length - 1]);
            } else if (check.status === "needs-you") {
                needsYou.push(checks[checks.length - 1]);
            } else if (check.status === "warn") {
                warnings.push(checks[checks.length - 1]);
            }
        }

        nodes.forEach(function (node) {
            if (!node || !node.id) { return; }
            var installed = validationInstalled(node, options);
            if (!installed) {
                var packageName = validationTypePackage(node, options);
                var packageNote = packageName ? " Palette package: " + packageName + "." : "";
                var alternative = VALIDATION_CORE_ALTERNATIVES[node.type] || VALIDATION_CORE_ALTERNATIVES.default;
                add(node, validationCheck("fail", "node-type-installed",
                    "Node type not installed: " + (node.type || "unknown") + "." + packageNote +
                    " FlowPilot will not install it; use a core alternative such as " + alternative + ".",
                    { retryable: true }));
            } else {
                add(node, validationCheck("pass", "node-type-installed", "Node type is installed."));
            }

            var wires = Array.isArray(node.wires) ? node.wires : [];
            var outputCount = validationOutputCount(node);
            wires.forEach(function (targets, port) {
                if (port >= outputCount) {
                    add(node, validationCheck("fail", "wire-port",
                        "Wire uses output port " + port + ", but " + (node.type || "node") + " has " + outputCount + " output port(s).",
                        { port: port, retryable: true }));
                    return;
                }
                (Array.isArray(targets) ? targets : []).forEach(function (targetId) {
                    var target = byId[targetId];
                    if (!target) {
                        add(node, validationCheck("fail", "wire-target",
                            "Wire points to missing node " + targetId + ".", { targetId: targetId, retryable: true }));
                    } else if (validationInputCount(target) < 1) {
                        add(node, validationCheck("fail", "wire-input",
                            "Wire points to node " + targetId + ", which has no input port.", { targetId: targetId, retryable: true }));
                    } else {
                        add(node, validationCheck("pass", "wire", "Wire port " + port + " points to a real input.", { targetId: targetId }));
                    }
                });
            });

            var errors = validationErrorList(node);
            if (node.valid === false && !errors.length) { errors.push("Node-RED reports this node as invalid"); }
            var defDefaults = node._def && node._def.defaults;
            var missingConfigCredential = false;
            if (defDefaults) {
                Object.keys(defDefaults).forEach(function (key) {
                    var definition = defDefaults[key] || {};
                    if (definition.required === true && validationValueMissing(node[key])) {
                        errors.push(key + " is required");
                    }
                    if (definition.type && /config|node-red-config|broker|credentials?/i.test(String(definition.type)) &&
                            node[key] && !byId[node[key]] && options.checkConfigRefs !== false) {
                        errors.push(key + " refers to missing config node " + node[key]);
                        missingConfigCredential = true;
                    }
                });
            }
            if (errors.length) {
                var credential = missingConfigCredential || validationCredentialIssue(node, errors);
                add(node, validationCheck(credential ? "needs-you" : "fail", "required-config",
                    credential ? "Needs you: configure the missing credential for " + (node.name || node.type) + ". This will not be retried." :
                        "Required configuration is invalid: " + errors.join("; "),
                    { properties: errors.slice(), retryable: !credential, needsYou: credential }));
            } else {
                add(node, validationCheck("pass", "required-config", "Required configuration is valid."));
            }

            validationFunctionWarning(node).forEach(function (message) {
                add(node, validationCheck("warn", "lint", message, { suggestion: message }));
            });
            var httpText = validationHttpReturnsText(node, byId);
            if (httpText) {
                add(node, validationCheck(httpText.status, "http-returns-text", httpText.message, {
                    suggestion: httpText.suggestion, retryable: true
                }));
            }
            var debugComplete = validationDebugComplete(node);
            if (debugComplete) {
                add(node, validationCheck(debugComplete.status, "debug-complete", debugComplete.message, {
                    suggestion: debugComplete.suggestion, retryable: debugComplete.retryable
                }));
            }
        });

        var functionResults = options.functionResults || {};
        nodes.forEach(function (node) {
            if (!node || node.type !== "function") { return; }
            var result = functionResults[node.id];
            if (!result) {
                add(node, validationCheck("pass", "function-parse", "Function code queued for server compile check.", { pending: true }));
            } else if (result.unchecked) {
                // The check itself failed (route/network), not the user's code:
                // never spend one of the model's attempts on it.
                add(node, validationCheck("warn", "function-parse",
                    "Couldn't run the function syntax check: " + (result.message || "no response") + "."));
            } else if (result.ok) {
                add(node, validationCheck("pass", "function-parse", "Function code parses."));
            } else {
                add(node, validationCheck("fail", "function-parse",
                    "Function code" + (result.part ? " (" + result.part + ")" : "") + " does not parse: " + (result.message || "syntax error") +
                    (result.line ? " (line " + result.line + ")" : ""),
                    { line: result.line, retryable: true }));
            }
        });

        return {
            ok: failures.length === 0 && needsYou.length === 0,
            checks: checks,
            perNode: perNode,
            failures: failures,
            retryableFailures: failures.filter(function (failure) { return failure.retryable !== false; }),
            needsYou: needsYou,
            warnings: warnings
        };
    }

    function validationFailureText(result) {
        var list = (result && result.retryableFailures) || [];
        return list.map(function (failure) {
            return (failure.nodeId ? failure.nodeId + ": " : "") + failure.message;
        }).join(" ");
    }

    // Compact form for the tool result sent back to the model: passing checks
    // are omitted (they cost tokens on every write and change nothing).
    function validationForModel(result) {
        result = result || {};
        function messages(list) {
            return (list || []).map(function (c) { return (c.nodeId ? c.nodeId + ": " : "") + c.message; });
        }
        var out = { ok: !!result.ok };
        var failures = messages(result.retryableFailures);
        var needsYou = messages(result.needsYou);
        var warnings = messages(result.warnings);
        if (failures.length) { out.failures = failures; }
        if (needsYou.length) { out.needsYou = needsYou; }
        if (warnings.length) { out.warnings = warnings; }
        return out;
    }

    function validationOutcomeForAttempt(attempt, result) {
        if (result && result.needsYou && result.needsYou.length) { return "needs-you"; }
        if (result && !result.ok && attempt >= VALIDATION_MAX_ATTEMPTS) { return "out-of-tries"; }
        if (result && !result.ok) { return "retry"; }
        return "pass";
    }

    function validationTouchedNodes(toolResult) {
        var args = toolResult && toolResult.requested ? toolResult.requested : {};
        var ids = [];
        function addId(id) {
            if (typeof id !== "string") { return; }
            var resolved = toolResult && toolResult.idMap && toolResult.idMap[id] ? toolResult.idMap[id] : id;
            if (ids.indexOf(resolved) === -1) { ids.push(resolved); }
        }
        (Array.isArray(args.newNodes) ? args.newNodes : []).forEach(function (node) { addId(node && node.id); });
        (Array.isArray(args.changes) ? args.changes : []).forEach(function (change) { addId(change && change.id); });
        addId(args.nodeId);
        (Array.isArray(args.nodeIds) ? args.nodeIds : []).forEach(addId);
        return ids;
    }

    // Compile-checks every function node's On Message / On Start / On Stop code
    // on the server (ruling C3) and reports one result per node id.
    function requestFunctionChecks(functionNodes, done) {
        var functionResults = {};
        var pending = functionNodes.length;
        var PART_LABELS = { func: "On Message", initialize: "On Start", finalize: "On Stop" };
        functionNodes.forEach(function (node) {
            ajaxJson("POST", "flowpilot/validate-function", {
                code: node.func || "", initialize: node.initialize || "", finalize: node.finalize || ""
            }, function (response) {
                var checks = response && response.checks;
                if (!checks) {
                    functionResults[node.id] = { unchecked: true, message: "unexpected response" };
                } else {
                    var failed = ["func", "initialize", "finalize"].filter(function (part) {
                        return checks[part] && checks[part].ok === false;
                    })[0];
                    functionResults[node.id] = failed
                        ? Object.assign({ part: PART_LABELS[failed] }, checks[failed])
                        : { ok: true };
                }
                pending--;
                if (!pending) { done(functionResults); }
            }, function (message) {
                functionResults[node.id] = { unchecked: true, message: message || "server compile check failed" };
                pending--;
                if (!pending) { done(functionResults); }
            });
        });
    }

    // In the live editor a node's .wires isn't maintained: wiring lives in
    // RED.nodes' link table, and .wires can still hold the placeholder ids
    // the model used (e.g. "fp-dbg-1"). Validate a copy whose wires are
    // rebuilt from the real links.
    function validationLiveWires(node) {
        var wires = [];
        var outputs = validationOutputCount(node);
        for (var i = 0; i < outputs; i++) { wires.push([]); }
        var links = [];
        if (RED.nodes && typeof RED.nodes.filterLinks === "function") {
            links = RED.nodes.filterLinks({ source: node }) || [];
        } else if (RED.nodes && typeof RED.nodes.eachLink === "function") {
            RED.nodes.eachLink(function (l) { if (l && l.source && l.source.id === node.id) { links.push(l); } });
        }
        links.forEach(function (l) {
            var port = Number(l.sourcePort) || 0;
            while (wires.length <= port) { wires.push([]); }
            if (l.target && l.target.id) { wires[port].push(l.target.id); }
        });
        return Object.assign({}, node, { wires: wires });
    }

    // ---- Editor truth after a write ---------------------------------------
    // This is intentionally one read-back gate for every WRITE front door.
    // The model's tool result is only a claim; RED.nodes and RED.editor are
    // authoritative after the mutation has happened.
    var EDITOR_STATE_FIELDS = {
        valid: 1, validationErrors: 1, changed: 1, dirty: 1, moved: 1,
        selected: 1, _index: 1, resize: 1, x: 1, y: 1, w: 1, h: 1,
        l: 1, inputs: 1, outputs: 1, __outputs: 1, g: 1, _config: 1,
        _orig: 1, credentials: 1
    };

    function editorReadBackNode(id) {
        if (!id || !RED.nodes) { return null; }
        var node = typeof RED.nodes.node === "function" ? RED.nodes.node(id) : null;
        if (node) { return node; }
        if (typeof RED.nodes.group === "function") {
            try { node = RED.nodes.group(id); } catch (e) { node = null; }
            if (node) { return node; }
        }
        if (typeof RED.nodes.junctions === "function" && RED.workspaces &&
                typeof RED.workspaces.active === "function") {
            var junctions = RED.nodes.junctions(RED.workspaces.active()) || [];
            for (var i = 0; i < junctions.length; i++) {
                if (junctions[i] && junctions[i].id === id) { return junctions[i]; }
            }
        }
        return null;
    }

    function editorNodeLabel(node, id) {
        return (node && (node.name || node.type)) || id || "node";
    }

    function editorPropertySnapshot(node) {
        var snapshot = {};
        if (!node) { return snapshot; }
        Object.keys(node).forEach(function (key) {
            if (key[0] !== "_") { snapshot[key] = node[key]; }
        });
        return snapshot;
    }

    function editorRect(node) {
        var width = Number(node && node.w) || Math.max(120,
            80 + String((node && (node.name || node.type)) || "").length * 8);
        var height = Number(node && node.h) || 30;
        return {
            left: Number(node.x) - width / 2,
            right: Number(node.x) + width / 2,
            top: Number(node.y) - height / 2,
            bottom: Number(node.y) + height / 2
        };
    }

    function editorRectsOverlap(left, right) {
        return left.left < right.right && right.left < left.right &&
            left.top < right.bottom && right.top < left.bottom;
    }

    function verifyWriteAgainstEditor(claim) {
        claim = claim || {};
        var errors = [];
        var nodeIds = Array.isArray(claim.nodeIds) ? claim.nodeIds : [];
        var before = claim.before || {};
        var explicitKeys = claim.explicitKeys || {};
        var liveNodes = {};

        nodeIds.forEach(function (id) {
            var node = editorReadBackNode(id);
            if (!node) {
                errors.push("Editor read-back: missing node " + id + ".");
                return;
            }
            liveNodes[id] = node;
        });

        (Array.isArray(claim.wires) ? claim.wires : []).forEach(function (wire) {
            var found = false;
            if (RED.nodes && typeof RED.nodes.eachLink === "function") {
                RED.nodes.eachLink(function (link) {
                    if (found || !link || !link.source || !link.target) { return; }
                    if (link.source.id === wire.from && link.target.id === wire.to &&
                            (Number(link.sourcePort) || 0) === (Number(wire.fromPort) || 0)) {
                        found = true;
                    }
                });
            }
            if (!found) {
                errors.push("Editor read-back: missing wire " + wire.from + " -> " + wire.to +
                    " (port " + (Number(wire.fromPort) || 0) + ").");
            }
        });

        var activeTab = RED.workspaces && typeof RED.workspaces.active === "function"
            ? RED.workspaces.active() : null;
        var tabNodes = [];
        if (RED.nodes && typeof RED.nodes.eachNode === "function") {
            RED.nodes.eachNode(function (node) {
                if (!node || node.type === "tab" || node.type === "subflow") { return; }
                if (activeTab && node.z && node.z !== activeTab) { return; }
                if (typeof node.x === "number" && typeof node.y === "number") { tabNodes.push(node); }
            });
        }
        // Only overlaps this write could have caused count: at least one of
        // the pair is a node the write touched. Groups contain their members
        // by design, and the user's own overlapping nodes aren't ours.
        tabNodes = tabNodes.filter(function (node) { return node.type !== "group" && node.type !== "junction"; });
        var touchedSet = {};
        nodeIds.forEach(function (id) { touchedSet[id] = true; });
        for (var i = 0; i < tabNodes.length; i++) {
            for (var j = i + 1; j < tabNodes.length; j++) {
                if (!touchedSet[tabNodes[i].id] && !touchedSet[tabNodes[j].id]) { continue; }
                if (editorRectsOverlap(editorRect(tabNodes[i]), editorRect(tabNodes[j]))) {
                    errors.push("Editor read-back: nodes " + tabNodes[i].id + " and " + tabNodes[j].id + " overlap.");
                }
            }
        }

        Object.keys(liveNodes).forEach(function (id) {
            var node = liveNodes[id];
            if (node.type !== "group" && node.type !== "junction" && RED.editor &&
                    typeof RED.editor.validateNode === "function") {
                RED.editor.validateNode(node);
            }
            var nodeErrors = node.valid === false ? validationErrorList(node) : [];
            // A missing credential or config node is the user's to supply:
            // SF-3 reports it as "Needs you" and never retries it, so the
            // read-back must not turn it into a retryable failure.
            var userToFix = node.valid === false && (validationCredentialIssue(node, nodeErrors) ||
                nodeErrors.some(function (error) { return /config|broker|server|credential/i.test(String(error)); }));
            if (node.valid === false && !userToFix) {
                errors.push("Editor validation failed for " + editorNodeLabel(node, id) +
                    " (" + id + "): " + (nodeErrors.length ? nodeErrors.join("; ") : "Node-RED reports this node as invalid") + ".");
            }

            var prior = before[id];
            if (!prior) { return; }
            var allowed = Array.isArray(explicitKeys[id]) ? explicitKeys[id] : [];
            Object.keys(node).forEach(function (key) {
                if (key[0] === "_" || EDITOR_STATE_FIELDS[key] ||
                        Object.prototype.hasOwnProperty.call(prior, key) || allowed.indexOf(key) !== -1) { return; }
                errors.push("Editor read-back: unexpected property " + key + " was added to node " + id + ".");
            });
        });

        return { ok: errors.length === 0, errors: errors };
    }

    function validateWriteResult(toolResult, callback) {
        var allNodes = validationFlowNodes();
        var touched = validationTouchedNodes(toolResult);
        var liveById = {};
        allNodes.forEach(function (node) { if (node && node.id) { liveById[node.id] = node; } });
        var touchedNodes = touched.map(function (id) { return liveById[id] || (RED.nodes && RED.nodes.node ? RED.nodes.node(id) : null); })
            .filter(Boolean).map(validationLiveWires);
        var requestedNodes = [];
        var requested = toolResult && toolResult.requested && Array.isArray(toolResult.requested.newNodes)
            ? toolResult.requested.newNodes : [];
        requested.forEach(function (node) {
            if (!node || !node.id) { return; }
            var resolvedId = toolResult && toolResult.idMap && toolResult.idMap[node.id]
                ? toolResult.idMap[node.id] : node.id;
            if (!liveById[resolvedId]) {
                var idMap = (toolResult && toolResult.idMap) || {};
                var mappedWires = (Array.isArray(node.wires) ? node.wires : []).map(function (targets) {
                    return (Array.isArray(targets) ? targets : []).map(function (t) { return idMap[t] || t; });
                });
                requestedNodes.push(Object.assign({}, node, { id: resolvedId, wires: mappedWires }));
            }
        });
        var graphNodes = allNodes.concat(requestedNodes);
        var nodes = touchedNodes.concat(requestedNodes);
        // Only what this write touched is validated. A write with nothing
        // live left to check (e.g. remove_step) passes; the rest of the
        // user's instance is never held against the model's run.
        var writeBefore = (toolResult && toolResult.beforeSnapshots) || {};
        // An unresolved id in a refused/no-op tool result is not a landed
        // write, and the pre-existing validation contract deliberately does
        // not hold the rest of the user's graph against it. Existing nodes
        // that actually participated in a write have a before snapshot;
        // inserted nodes are added below from newNodes/idMap.
        var readbackIds = touched.filter(function (id) {
            return !!liveById[id] || Object.prototype.hasOwnProperty.call(writeBefore, id);
        });
        requested.forEach(function (node) {
            if (!node || !node.id) { return; }
            var id = toolResult && toolResult.idMap && toolResult.idMap[node.id]
                ? toolResult.idMap[node.id] : node.id;
            if (readbackIds.indexOf(id) === -1) { readbackIds.push(id); }
        });
        // A removal intentionally makes its claimed nodes absent; every other
        // write must prove that its claimed nodes still exist in the editor.
        if (toolResult && toolResult.removal === true) { readbackIds = []; }
        var readbackIdMap = (toolResult && toolResult.idMap) || {};
        var readbackWires = ((toolResult && toolResult.wires && toolResult.wires.expected) || []).map(function (wire) {
            return Object.assign({}, wire, {
                from: readbackIdMap[wire.from] || wire.from,
                to: readbackIdMap[wire.to] || wire.to
            });
        });
        var needsEditorReadback = readbackIds.length || readbackWires.length ||
            (toolResult && toolResult.removal === true);
        var readback = needsEditorReadback
            ? verifyWriteAgainstEditor({
                nodeIds: readbackIds,
                wires: readbackWires,
                before: writeBefore,
                explicitKeys: toolResult && toolResult.explicitKeys
            })
            : { ok: true, errors: [] };
        function addReadbackFailure(result) {
            if (readback.ok) { return result; }
            readback.errors.forEach(function (message) {
                result.checks.push(validationCheck("fail", "editor-readback", message, { retryable: true }));
            });
            result.failures = result.checks.filter(function (check) { return check.status === "fail"; });
            result.retryableFailures = result.failures.filter(function (failure) { return failure.retryable !== false; });
            result.ok = false;
            return result;
        }
        if (!nodes.length) {
            callback(addReadbackFailure(validateFlow([], { allNodes: graphNodes })));
            return;
        }
        var result = validateFlow(nodes, {
            allNodes: graphNodes,
            isInstalled: function (type) {
                return !!(RED.nodes && typeof RED.nodes.getType === "function" && RED.nodes.getType(type));
            }
        });
        var functionNodes = touchedNodes.filter(function (node) { return node.type === "function"; });
        if (!functionNodes.length || typeof ajaxJson !== "function") {
            callback(addReadbackFailure(result));
            return;
        }
        requestFunctionChecks(functionNodes, function (functionResults) {
            callback(addReadbackFailure(validateFlow(nodes, {
                allNodes: graphNodes,
                isInstalled: function (type) {
                    return !!(RED.nodes && typeof RED.nodes.getType === "function" && RED.nodes.getType(type));
                },
                functionResults: functionResults
            })));
        });
    }

    function validateGeneratedFlowAsync(nodes, callback) {
        nodes = Array.isArray(nodes) ? nodes : [];
        // Generated flows may wire to, or reference config nodes in, the
        // existing editor graph; those aren't "missing".
        var options = {
            allNodes: validationFlowNodes().concat(nodes),
            isInstalled: function (type) {
                return !!(RED.nodes && typeof RED.nodes.getType === "function" && RED.nodes.getType(type));
            }
        };
        var functionNodes = nodes.filter(function (node) { return node && node.type === "function"; });
        if (!functionNodes.length || typeof ajaxJson !== "function") {
            callback(validateFlow(nodes, options));
            return;
        }
        requestFunctionChecks(functionNodes, function (functionResults) {
            callback(validateFlow(nodes, Object.assign({ functionResults: functionResults }, options)));
        });
    }
