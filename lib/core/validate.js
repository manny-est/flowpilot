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

    function validateWriteResult(toolResult, callback) {
        var allNodes = validationFlowNodes();
        var touched = validationTouchedNodes(toolResult);
        var liveById = {};
        allNodes.forEach(function (node) { if (node && node.id) { liveById[node.id] = node; } });
        var touchedNodes = touched.map(function (id) { return liveById[id] || (RED.nodes && RED.nodes.node ? RED.nodes.node(id) : null); })
            .filter(Boolean);
        var requestedNodes = [];
        var requested = toolResult && toolResult.requested && Array.isArray(toolResult.requested.newNodes)
            ? toolResult.requested.newNodes : [];
        requested.forEach(function (node) {
            if (!node || !node.id) { return; }
            var resolvedId = toolResult && toolResult.idMap && toolResult.idMap[node.id]
                ? toolResult.idMap[node.id] : node.id;
            if (!liveById[resolvedId]) {
                requestedNodes.push(Object.assign({}, node, { id: resolvedId }));
            }
        });
        var graphNodes = allNodes.concat(requestedNodes);
        var nodes = touchedNodes.concat(requestedNodes);
        // Only what this write touched is validated. A write with nothing
        // live left to check (e.g. remove_step) passes; the rest of the
        // user's instance is never held against the model's run.
        if (!nodes.length) {
            callback(validateFlow([], { allNodes: graphNodes }));
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
            callback(result);
            return;
        }
        requestFunctionChecks(functionNodes, function (functionResults) {
            callback(validateFlow(nodes, {
                allNodes: graphNodes,
                isInstalled: function (type) {
                    return !!(RED.nodes && typeof RED.nodes.getType === "function" && RED.nodes.getType(type));
                },
                functionResults: functionResults
            }));
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

