    // R4-H: small, defensive helpers shared by the browser loop and the
    // engine-corpus tests. The provider-facing route uses the same parser
    // through the CommonJS export; the browser only needs the plain object
    // normalization and retry-budget loop.

    function goalCheckObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) { return null; }
        var gaps = Array.isArray(value.gaps) ? value.gaps.filter(function (gap) {
            return typeof gap === "string" && gap.trim();
        }).map(function (gap) { return gap.trim(); }) : [];
        return { done: value.done === true, gaps: gaps };
    }

    function parseGoalCheck(value) {
        var parsed = value;
        if (typeof value === "string") {
            var text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
            try {
                parsed = JSON.parse(text);
            } catch (e) {
                var start = text.indexOf("{");
                var end = text.lastIndexOf("}");
                if (start !== -1 && end > start) {
                    try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (e2) { parsed = null; }
                } else { parsed = null; }
            }
        }
        var normalized = goalCheckObject(parsed);
        if (!normalized) { return { done: true, gaps: [], unparseable: true }; }
        if (value && typeof value === "object" && value.unparseable === true) { normalized.unparseable = true; }
        return normalized;
    }

    // One fix budget is shared across all gaps. A malformed answer is a safe
    // success because a goal check must never turn a completed write into a
    // crash or an infinite retry loop.
    async function runGoalCheckLoop(options) {
        options = options || {};
        var maxFixAttempts = Number.isFinite(Number(options.maxFixAttempts))
            ? Math.max(0, Math.floor(Number(options.maxFixAttempts))) : 2;
        var fixAttempts = 0;
        var checks = 0;
        var last = null;
        while (true) {
            var answer = await options.check();
            checks++;
            last = parseGoalCheck(answer);
            if (last.unparseable || last.done || !last.gaps.length) {
                return Object.assign({}, last, { checks: checks, fixAttempts: fixAttempts });
            }
            if (fixAttempts >= maxFixAttempts || typeof options.fix !== "function") {
                return Object.assign({}, last, { checks: checks, fixAttempts: fixAttempts });
            }
            var gap = last.gaps[0];
            fixAttempts++;
            await options.fix(gap, fixAttempts);
        }
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { parseGoalCheck: parseGoalCheck, runGoalCheckLoop: runGoalCheckLoop };
    }
