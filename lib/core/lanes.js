    // SF-2 lane choice. Keep this pure: the browser bundle and Node-side
    // corpus runner both load this function.
    function chooseLane(intake, classification) {
        var i = intake || {};
        var c = classification || {};
        var flags = Object.assign({}, i.flags || {}, i);
        var letter = String(c.letter || c.classification || "").toUpperCase();
        var kind = String(c.kind || c.intent || c.action || "").toLowerCase();
        var action = String(c.action || c.kind || "").toLowerCase();
        var target = c.target || i.target || {};
        var targetResolved = c.targetResolved === true || c.target_resolved === true ||
            (target && Array.isArray(target.ids) && target.ids.length > 0) ||
            (Array.isArray(c.targets) && c.targets.length > 0) ||
            Array.isArray(i.targetIds) && i.targetIds.length > 0 ||
            Array.isArray(i.activeSelectionIds) && i.activeSelectionIds.length > 0;
        var planItems = Array.isArray(c.plan_items) ? c.plan_items :
            (Array.isArray(c.planItems) ? c.planItems : []);
        var distinctTargets = c.distinctTargets === true ||
            (Array.isArray(c.targets) && new Set(c.targets.map(String)).size > 1);
        var text = String(i.message || c.message || "").toLowerCase();
        var crossTab = c.crossTab === true || c.cross_tab === true || /cross[- ]tab/.test(text);
        var subflowTemplate = c.subflowTemplate === true || c.subflow_template === true ||
            /subflow\s+template|template\s+subflow/.test(text);
        var crossTabLink = c.crossTabLink === true || c.cross_tab_link === true ||
            /cross[- ]tab.*link|link.*cross[- ]tab/.test(text);
        var unclear = letter === "F" || c.unclear === true || c.clear === false ||
            ["unclear", "clarify", "question", "answer", "chat", "f"].indexOf(kind) !== -1;
        var change = action === "modify" || action === "change" || action === "document" ||
            kind === "change" || kind === "modify";

        if (unclear) { return { lane: "ASK", reason: "unclear request" }; }
        if (flags.restricted === true) { return { lane: "PLAN", reason: "restricted mode" }; }
        if (flags.auto === false) { return { lane: "PLAN", reason: "Auto is off" }; }
        if (flags.planFirst === true) { return { lane: "PLAN", reason: "Plan first override" }; }
        if (crossTab || subflowTemplate || crossTabLink) {
            return { lane: "PLAN", reason: "cross-tab or subflow work" };
        }
        if (change && !targetResolved) {
            return { lane: "ASK", reason: "change target is unresolved" };
        }
        if (planItems.length > 1 && distinctTargets) {
            return { lane: "PLAN", reason: "multiple plan items have distinct targets" };
        }
        if (flags.justDoIt === true) {
            return { lane: "DIRECT", reason: "Just do it override" };
        }
        if (change && targetResolved) {
            return { lane: "DIRECT", reason: "target resolved" };
        }
        if (action === "generate" || action === "build" || kind === "create" ||
            kind === "generate" || /\b(create|new flow|open-ended)\b/.test(text)) {
            return { lane: "PLAN", reason: "open-ended creation" };
        }
        return { lane: "ASK", reason: "intent needs clarification" };
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { chooseLane: chooseLane };
    }
