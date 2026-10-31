// Agent-loop limits shared by the browser core and unit tests.
var AGENT_LOOP_DEFAULT_TOKEN_CEILING = 50000;

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

// The ceiling caps the tokens a whole turn uses, summed over every step
// (each step re-sends the conversation). So it scales with the step budget
// times one step's size: the model's context when known (capped, so a huge
// context doesn't mean an unbounded bill), a default when unknown (local
// models often report numCtx 0). Never below the old flat default, and an
// explicit user setting always wins (#7, architect ruling round 2).
var AGENT_LOOP_DEFAULT_STEPS = 8;
var AGENT_LOOP_STEP_CONTEXT_CAP = 32768;
var AGENT_LOOP_STEP_CONTEXT_UNKNOWN = 16384;

// beta.3 wrote the default 50,000 value with the explicitness bit set on
// every Settings save. A second marker distinguishes a deliberate 50,000
// choice made by this version from that bad historical bit. Non-default
// values remain explicit for compatibility with older settings files that
// had no explicitness marker at all.
function agentLoopTokenCeilingUserSet(settings, configured) {
    settings = settings || {};
    if (settings.agentLoopTokenCeilingUserSet !== true) {
        return configured !== AGENT_LOOP_DEFAULT_TOKEN_CEILING;
    }
    return configured !== AGENT_LOOP_DEFAULT_TOKEN_CEILING ||
        settings.agentLoopTokenCeilingUserSetV2 === true;
}

// Convert the Settings form value into the persisted shape. The UI leaves an
// automatic ceiling blank, so an empty value must clear a previous override.
// `settings` is the last loaded/saved object; comparing against its effective
// form value lets 50,000 become an explicit choice only when the user typed it
// after having an automatic field.
function readAgentLoopTokenCeilingSettings(settings, fieldValue) {
    settings = settings || {};
    var configured = Number(settings.agentLoopTokenCeiling);
    if (!isFinite(configured) || configured <= 0) { configured = AGENT_LOOP_DEFAULT_TOKEN_CEILING; }
    configured = Math.floor(configured);
    var loadedUserSet = agentLoopTokenCeilingUserSet(settings, configured);
    var loadedFieldValue = loadedUserSet ? String(configured) : "";
    var text = fieldValue === undefined ? loadedFieldValue : String(fieldValue == null ? "" : fieldValue).trim();
    if (!text) {
        return {
            agentLoopTokenCeiling: AGENT_LOOP_DEFAULT_TOKEN_CEILING,
            agentLoopTokenCeilingUserSet: false,
            agentLoopTokenCeilingUserSetV2: false
        };
    }
    var value = Number(text);
    if (!isFinite(value) || value <= 0 || Math.floor(value) !== value) {
        return {
            agentLoopTokenCeiling: value,
            agentLoopTokenCeilingUserSet: true,
            agentLoopTokenCeilingUserSetV2: true
        };
    }
    var userSet = loadedUserSet || text !== loadedFieldValue;
    return {
        agentLoopTokenCeiling: Math.floor(value),
        agentLoopTokenCeilingUserSet: userSet,
        agentLoopTokenCeilingUserSetV2: userSet
    };
}

function deriveAgentLoopTokenCeiling(settings, provider, steps) {
    settings = settings || {};
    var configured = Number(settings.agentLoopTokenCeiling);
    if (!isFinite(configured) || configured <= 0) { configured = AGENT_LOOP_DEFAULT_TOKEN_CEILING; }
    // Older settings files have no explicitness bit. A non-default value is
    // necessarily a user choice; the bit preserves the less common explicit
    // choice of exactly 50,000 as well.
    if (agentLoopTokenCeilingUserSet(settings, configured) || configured !== AGENT_LOOP_DEFAULT_TOKEN_CEILING) {
        return Math.floor(configured);
    }
    var stepCount = Number(steps);
    if (!isFinite(stepCount) || stepCount < 1) { stepCount = AGENT_LOOP_DEFAULT_STEPS; }
    var context = numericContextWindow(provider);
    var perStep = context ? Math.min(context, AGENT_LOOP_STEP_CONTEXT_CAP) : AGENT_LOOP_STEP_CONTEXT_UNKNOWN;
    return Math.max(AGENT_LOOP_DEFAULT_TOKEN_CEILING, Math.floor(stepCount * perStep));
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
        agentLoopTokenCeilingUserSet: agentLoopTokenCeilingUserSet,
        readAgentLoopTokenCeilingSettings: readAgentLoopTokenCeilingSettings,
        deriveAgentLoopTokenCeiling: deriveAgentLoopTokenCeiling,
        displayStepTotal: displayStepTotal
    };
}
