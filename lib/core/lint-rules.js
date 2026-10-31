    // R4-F policy: every Node-RED-shaped bug found by QA or the fuzzers gets
    // a rule and a fixture here in the same commit as its fix.
    //
    // This fragment is intentionally pure and non-executing. It is included
    // in the browser bundle and also exports the same table for Node tests.
    function lintNodeLabel(node) {
        return (node && (node.name || node.id)) || "unnamed";
    }

    function lintResult(status, message, suggestion, retryable) {
        var result = { status: status, message: message, suggestion: suggestion };
        if (retryable !== undefined) { result.retryable = retryable; }
        return result;
    }

    function lintHasValue(value) {
        return value !== undefined && value !== null && value !== "";
    }

    function lintStripComments(code) {
        return String(code || "")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/.*$/gm, "")
            .trim();
    }

    // An http request returns a string unless ret is "obj", so a downstream
    // function reading msg.payload.<field> gets undefined. String members
    // such as .length or .split are fine on text.
    var HTTP_TEXT_PAYLOAD_MEMBERS = /^(?:length|split|trim|toString|match|replace|indexOf|includes|slice|substring|substr|toLowerCase|toUpperCase|startsWith|endsWith|charAt|concat|padStart|padEnd|search|lastIndexOf)$/;
    function validationHttpReturnsText(node, ctx) {
        if (!node || node.type !== "http request" || node.ret === "obj" || node.ret === "bin") { return []; }
        var byId = (ctx && ctx.byId) || {};
        var reader = null;
        (Array.isArray(node.wires) ? node.wires : []).forEach(function (targets) {
            (Array.isArray(targets) ? targets : []).forEach(function (targetId) {
                var target = byId[targetId];
                if (reader || !target || target.type !== "function" || typeof target.func !== "string") { return; }
                if (/JSON\.parse\s*\(/.test(target.func)) { return; }
                var re = /msg\.payload\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[)/g;
                var match;
                while ((match = re.exec(target.func))) {
                    if (!match[1] || !HTTP_TEXT_PAYLOAD_MEMBERS.test(match[1])) { reader = target; return; }
                }
            });
        });
        if (!reader) { return []; }
        var label = lintNodeLabel(node);
        return [lintResult("fail", "HTTP request '" + label + "' returns text, but function '" +
            lintNodeLabel(reader) + "' reads fields from msg.payload; set ret to \"obj\" so it returns a parsed JSON object.",
            "Set the http request's ret to \"obj\" (a parsed JSON object).", true)];
    }

    function validationFunctionWarning(node) {
        if (!node || node.type !== "function" || typeof node.func !== "string") { return []; }
        var body = lintStripComments(node.func);
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
        return warnings.map(function (message) {
            return lintResult("warn", message, message);
        });
    }

    function validationDebugComplete(node) {
        if (!node || node.type !== "debug" || !Object.prototype.hasOwnProperty.call(node, "complete")) { return []; }
        var complete = node.complete;
        if (complete === "true" || complete === "false" || node.targetType === "jsonata") { return []; }
        var propertyPath = typeof complete === "string" &&
            /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(complete) &&
            complete !== "msg" && complete.indexOf("msg.") !== 0;
        if (propertyPath) { return []; }
        var label = lintNodeLabel(node);
        if (complete === "msg") {
            return [lintResult("warn", "Debug '" + label + "' shows msg.msg; use 'true' for the whole message",
                "Use 'true' to show the whole message.")];
        }
        return [lintResult("warn", "Debug '" + label + "' has an invalid output setting; use 'true', 'false', or a msg property path.",
            "Use 'true' for the whole message, or a property path such as 'payload'.")];
    }

    function validationSwitchOutputs(node) {
        if (!node || node.type !== "switch") { return []; }
        var rules = Array.isArray(node.rules) ? node.rules : [];
        var otherwise = rules.some(function (rule) { return rule && rule.t === "else"; });
        var expected = rules.length + (String(node.checkall) === "false" && otherwise ? 1 : 0);
        var outputs = Number(node.outputs);
        var wires = Array.isArray(node.wires) ? node.wires : [];
        if (outputs === expected && wires.length === outputs) { return []; }
        var label = lintNodeLabel(node);
        return [lintResult("fail", "Switch '" + label + "' must have " + expected + " output(s) for " +
            rules.length + " rule(s)" + (otherwise && String(node.checkall) === "false" ? " and its otherwise output" : "") +
            "; it has outputs=" + String(node.outputs) + " and wires.length=" + wires.length + ".",
            "Set outputs and the wires array length to " + expected + " to match the switch rules.", true)];
    }

    function lintArrayLength(code, open) {
        var depth = 0;
        var items = 0;
        var itemHasValue = false;
        var quote = null;
        for (var i = open; i < code.length; i++) {
            var ch = code.charAt(i);
            if (quote) {
                if (ch === "\\") { i++; }
                else if (ch === quote) { quote = null; }
                continue;
            }
            if (ch === "'" || ch === '"' || ch === "`") { quote = ch; itemHasValue = true; continue; }
            if (ch === "[") { depth++; if (depth > 1) { itemHasValue = true; } continue; }
            if (ch === "]") {
                depth--;
                if (depth === 0) { return { length: items + (itemHasValue ? 1 : 0), end: i }; }
                continue;
            }
            if (depth === 1 && ch === ",") {
                if (itemHasValue) { items++; }
                itemHasValue = false;
                continue;
            }
            if (depth >= 1 && !/\s/.test(ch)) { itemHasValue = true; }
        }
        return null;
    }

    function validationFunctionReturnShape(node) {
        if (!node || node.type !== "function" || typeof node.func !== "string") { return []; }
        var outputs = Number(node.outputs);
        if (!isFinite(outputs) || outputs < 1) { return []; }
        var body = lintStripComments(node.func);
        var results = [];
        if (outputs > 1 && /\breturn\s+msg\s*;?/.test(body)) {
            results.push(lintResult("warn", "Function '" + lintNodeLabel(node) + "' has " + outputs +
                " outputs but returns msg; return an array with one entry per output.",
                "Use return [msg, ...] for multiple outputs, or reduce outputs."));
        }
        var returnArray = /\breturn\s*\[/g;
        var match;
        while ((match = returnArray.exec(body))) {
            var parsed = lintArrayLength(body, match.index + match[0].lastIndexOf("["));
            if (!parsed) { continue; }
            if ((outputs > 1 && parsed.length !== outputs) || (outputs === 1 && parsed.length > 1)) {
                results.push(lintResult("warn", "Function '" + lintNodeLabel(node) + "' returns an array with " +
                    parsed.length + " item(s), but has " + outputs + " output(s).",
                    "Return one array item per output, or set the function's outputs to match."));
            }
            returnArray.lastIndex = parsed.end + 1;
        }
        return results;
    }

    function validationInjectRepeat(node) {
        if (!node || node.type !== "inject") { return []; }
        var label = lintNodeLabel(node);
        var results = [];
        if (lintHasValue(node.repeat)) {
            var repeat = Number(node.repeat);
            if (isFinite(repeat) && repeat < 1) {
                results.push(lintResult("fail", "Inject '" + label + "' repeats every " + String(node.repeat) +
                    " second(s), below the safe 1 second minimum.",
                    "Set repeat to a string containing at least \"1\" second, or leave it empty to disable repeating.", true));
            } else if (isFinite(repeat) && repeat >= 1000 && repeat % 1000 === 0 && !lintHasValue(node.crontab)) {
                results.push(lintResult("warn", "Inject '" + label + "' repeat=" + String(node.repeat) +
                    " looks like milliseconds, but Node-RED repeat values are seconds.",
                    "Use repeat \"" + String(repeat / 1000) + "\" seconds."));
            }
        }
        if ((node.once === true || node.once === "true") && lintHasValue(node.onceDelay) && Number(node.onceDelay) < 0.1) {
            results.push(lintResult("fail", "Inject '" + label + "' has onceDelay below 0.1 second.",
                "Set onceDelay to at least \"0.1\" seconds when once is enabled.", true));
        }
        return results;
    }

    function validationChangeRuleTarget(node) {
        if (!node || node.type !== "change") { return []; }
        var rules = Array.isArray(node.rules) ? node.rules : [];
        var validTypes = { set: true, change: true, "delete": true, move: true };
        var validPropertyTypes = { msg: true, flow: true, global: true };
        var label = lintNodeLabel(node);
        var results = [];
        rules.forEach(function (rule, index) {
            rule = rule || {};
            var problems = [];
            if (!validTypes[rule.t]) { problems.push("t must be set, change, delete, or move"); }
            if (!lintHasValue(rule.p)) { problems.push("p must name a target property"); }
            if (!validPropertyTypes[rule.pt]) { problems.push("pt must be msg, flow, or global"); }
            if (rule.t === "set" && !lintHasValue(rule.tot)) { problems.push("set rules need tot"); }
            if (rule.t === "move" && !lintHasValue(rule.to)) { problems.push("move rules need to"); }
            if (problems.length) {
                results.push(lintResult("fail", "Change '" + label + "' rule " + (index + 1) + " is invalid: " + problems.join("; ") + ".",
                    "Set each change rule's t, p, pt, and required value fields to valid Node-RED values.", true));
            }
        });
        return results;
    }

    function lintIsConfigType(type) {
        return /config|node-red-config|broker|credentials?/i.test(String(type || ""));
    }

    function validationMissingConfigNode(node, ctx) {
        if (!node || !node._def || !node._def.defaults) { return []; }
        var byId = (ctx && ctx.byId) || {};
        var results = [];
        Object.keys(node._def.defaults).forEach(function (key) {
            var definition = node._def.defaults[key] || {};
            if (!lintIsConfigType(definition.type)) { return; }
            var value = node[key];
            if (!lintHasValue(value) && definition.required === true) {
                results.push(lintResult("fail", "Node '" + lintNodeLabel(node) + "' requires config property '" + key + "'.",
                    "Select or create the required " + String(definition.type) + " config node for '" + key + "'.", true));
            } else if (lintHasValue(value) && !byId[value] && (!ctx || ctx.checkConfigRefs !== false)) {
                results.push(lintResult("fail", "Node '" + lintNodeLabel(node) + "' property '" + key + "' points to missing config node '" +
                    String(value) + "'.", "Create or select the config node referenced by '" + key + "'.", false));
            }
        });
        return results;
    }

    var LINT_RULES = [
        { id: "http-returns-text", appliesTo: function (node) { return !!node && node.type === "http request"; }, check: validationHttpReturnsText },
        { id: "lint", appliesTo: function (node) { return !!node && node.type === "function"; }, check: validationFunctionWarning },
        { id: "debug-complete", appliesTo: function (node) { return !!node && node.type === "debug"; }, check: validationDebugComplete },
        { id: "switch-outputs", appliesTo: function (node) { return !!node && node.type === "switch"; }, check: validationSwitchOutputs },
        { id: "function-return-shape", appliesTo: function (node) { return !!node && node.type === "function"; }, check: validationFunctionReturnShape },
        { id: "inject-repeat", appliesTo: function (node) { return !!node && node.type === "inject"; }, check: validationInjectRepeat },
        { id: "change-rule-target", appliesTo: function (node) { return !!node && node.type === "change"; }, check: validationChangeRuleTarget },
        { id: "missing-config-node", appliesTo: function (node) { return !!node && !!node._def && !!node._def.defaults; }, check: validationMissingConfigNode }
    ];

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            LINT_RULES: LINT_RULES,
            validationHttpReturnsText: validationHttpReturnsText,
            validationFunctionWarning: validationFunctionWarning
        };
    }
