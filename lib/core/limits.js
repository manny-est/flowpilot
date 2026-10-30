// Agent-loop limits shared by the browser core and unit tests.
var AGENT_LOOP_DEFAULT_TOKEN_CEILING = 50000;
var AGENT_LOOP_CONTEXT_FRACTION = 0.65;
var AGENT_LOOP_CONTEXT_FLOOR = 8192;
var AGENT_LOOP_CONTEXT_CAP = 200000;

function numericContextWindow(provider) {
    provider = provider || {};
    var candidates = [
        provider.numCtx, provider.contextWindow, provider.contextWindowTokens,
        provider.context_window, provider.context_window_tokens,
        provider.probedNumCtx, provider.probedContextWindow,
        provider.presetContextSize, provider.presetContextWindow
    ];
    for (var i = 0; i < candidates.length; i++) {
        var value = candidates[i];
        if (typeof value === "string") { value = value.replace(/,/g, ""); }
        value = Number(value);
        if (isFinite(value) && value > 0) { return Math.floor(value); }
    }
    return 0;
}

function deriveAgentLoopTokenCeiling(settings, provider) {
    settings = settings || {};
    var configured = Number(settings.agentLoopTokenCeiling);
    if (!isFinite(configured) || configured <= 0) { configured = AGENT_LOOP_DEFAULT_TOKEN_CEILING; }
    // Older settings files have no explicitness bit. A non-default value is
    // necessarily a user choice; the bit preserves the less common explicit
    // choice of exactly 50,000 as well.
    if (settings.agentLoopTokenCeilingUserSet === true || configured !== AGENT_LOOP_DEFAULT_TOKEN_CEILING) {
        return Math.floor(configured);
    }
    var context = numericContextWindow(provider);
    if (!context) { return Math.floor(configured); }
    var derived = Math.floor(context * AGENT_LOOP_CONTEXT_FRACTION);
    var floor = Math.min(AGENT_LOOP_CONTEXT_FLOOR, Math.max(1, context - 1));
    return Math.min(AGENT_LOOP_CONTEXT_CAP, Math.max(floor, derived));
}

function displayStepTotal(step, plannedTotal) {
    var current = Number(step);
    var planned = Number(plannedTotal);
    if (!isFinite(current) || current < 0) { current = 0; }
    if (!isFinite(planned) || planned < 0) { planned = 0; }
    return Math.max(Math.floor(current), Math.floor(planned));
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        numericContextWindow: numericContextWindow,
        deriveAgentLoopTokenCeiling: deriveAgentLoopTokenCeiling,
        displayStepTotal: displayStepTotal
    };
}
