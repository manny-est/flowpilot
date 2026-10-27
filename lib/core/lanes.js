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
        // "this flow" / "the current tab" names the open tab, which the intake
        // carries (SF-2), so it's a resolved target for flow-level work.
        var activeTab = i.activeTab || (i.flags && i.flags.activeTab);
        var flowReference = !!(activeTab && activeTab.id) &&
            /\b(this|the current|current) (flow|tab|automation|flow tab)\b/.test(String(i.message || c.message || "").toLowerCase());
        var targetResolved = flowReference || c.targetResolved === true || c.target_resolved === true ||
            (target && Array.isArray(target.ids) && target.ids.length > 0) ||
            (Array.isArray(c.targets) && c.targets.length > 0) ||
            Array.isArray(i.targetIds) && i.targetIds.length > 0 ||
            Array.isArray(i.activeSelectionIds) && i.activeSelectionIds.length > 0;
        var planItems = Array.isArray(c.plan_items) ? c.plan_items :
            (Array.isArray(c.planItems) ? c.planItems : []);
        // Multi-part means plan items aimed at different targets. Plan items
        // don't carry targets yet, so only an explicit flag counts: several
        // selected nodes are one target set, not a multi-part request.
        var distinctTargets = c.distinctTargets === true;
        var text = String(i.message || c.message || "").toLowerCase();
        var crossTab = c.crossTab === true || c.cross_tab === true || /cross[- ]tab/.test(text);
        var subflowTemplate = c.subflowTemplate === true || c.subflow_template === true ||
            /subflow\s+template|template\s+subflow/.test(text);
        var crossTabLink = c.crossTabLink === true || c.cross_tab_link === true ||
            /cross[- ]tab.*link|link.*cross[- ]tab/.test(text);
        // ANSWER isn't a CHANGE lane (ADR-015 §2.1): it's reported as its own
        // label so lane accuracy can tell "answered" from "asked".
        if (letter === "A" || ["answer", "question", "chat"].indexOf(kind) !== -1) {
            return { lane: "ANSWER", reason: "question or explanation" };
        }
        var unclear = letter === "F" || c.unclear === true || c.clear === false ||
            ["unclear", "clarify", "f"].indexOf(kind) !== -1;
        var create = action === "generate" || action === "build" || kind === "create" || kind === "generate";
        var openEnded = /\b(new flow|fresh flow|flow that|flow which|flow from scratch|build me|whole flow|test flow)\b/.test(text);
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
        // Ruling C1: an anchored addition or a targeted behavior change is
        // DIRECT (runtime proof runs automatically when Auto is on); only
        // open-ended creation goes to PLAN.
        if (create && targetResolved && !openEnded) {
            return { lane: "DIRECT", reason: "anchored addition or targeted behavior change" };
        }
        if (create) {
            return { lane: "PLAN", reason: "open-ended creation" };
        }
        return { lane: "ASK", reason: "intent needs clarification" };
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { chooseLane: chooseLane };
    }
