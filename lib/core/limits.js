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
var AGENT_LOOP_MAX_STEPS = 20;
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

// A new-flow write needs one tool turn to place the nodes, then a small
// allowance for validation/runtime work. Keep the fallback useful for an
// unknown proposal, but bound a very large proposal so a malformed plan
// cannot create an unbounded browser loop.
function deriveAgentLoopStepBudget(plannedNodeCount) {
    var count = Number(plannedNodeCount);
    if (!isFinite(count) || count < 1) { return AGENT_LOOP_DEFAULT_STEPS; }
    return Math.min(AGENT_LOOP_MAX_STEPS, Math.max(AGENT_LOOP_DEFAULT_STEPS, Math.floor(count) + 4));
}

// Nodes that never carry wires: comments, and config nodes (mqtt-broker,
// tls-config, ...), which have no canvas ports. A flow's first write may
// include them unwired.
function creationNodeNeedsWire(node) {
    var type = String(node && node.type || "");
    if (!type || type === "comment" || type === "group" || type === "junction") { return false; }
    if (typeof RED !== "undefined" && RED.nodes && typeof RED.nodes.getType === "function") {
        var def = null;
        try { def = RED.nodes.getType(type); } catch (e) { def = null; }
        if (def && def.category === "config") { return false; }
        if (def && Number(def.inputs || 0) === 0 && Number(def.outputs || 0) === 0) { return false; }
    }
    return !/(?:-broker|-config|-server|-client)$/.test(type);
}

// ADR-015 Amendment 2: a creation run's first write carries the whole flow.
// Rejected as partial: fewer nodes than an explicitly known node count; a
// lone node when the plan has 3+ steps (the one-node-per-call pattern); or a
// multi-node write that leaves a wireable node unwired. Plan steps are not
// nodes, so the step count is never compared to the node count.
function creationFirstWriteError(args, state) {
    state = state || {};
    if (state.active !== true || state.firstWriteComplete === true) { return null; }
    args = args || {};
    var newNodes = Array.isArray(args.newNodes) ? args.newNodes : [];
    var planned = Number(state.plannedNodeCount);
    var knownCount = isFinite(planned) && planned > 0 ? Math.floor(planned) : null;
    var steps = Number(state.planStepCount);
    var planSteps = isFinite(steps) && steps > 0 ? Math.floor(steps) : 0;
    var wireEndpoints = {};
    var remember = function (from, to) {
        if (from) { wireEndpoints[String(from)] = true; }
        if (to) { wireEndpoints[String(to)] = true; }
    };
    (Array.isArray(args.newWires) ? args.newWires : []).forEach(function (wire) {
        if (wire) { remember(wire.from, wire.to); }
    });
    newNodes.forEach(function (node) {
        (Array.isArray(node && node.wires) ? node.wires : []).forEach(function (targets) {
            (Array.isArray(targets) ? targets : []).forEach(function (target) {
                remember(node && node.id, target);
            });
        });
    });
    var wireable = newNodes.filter(creationNodeNeedsWire);
    var unwired = wireable.length >= 2 && wireable.some(function (node) {
        return !(node && node.id && wireEndpoints[String(node.id)]);
    });
    var tooFew = knownCount !== null ? newNodes.length < knownCount
        : (newNodes.length === 1 && planSteps >= 3);
    if (newNodes.length === 0 || tooFew || unwired) {
        return "This is a new flow: send the whole flow in one apply_step — " +
            (knownCount === null ? "all planned nodes" : "all " + knownCount + " planned nodes") +
            " and their wires.";
    }
    return null;
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
        deriveAgentLoopStepBudget: deriveAgentLoopStepBudget,
        creationFirstWriteError: creationFirstWriteError,
        deriveAgentLoopTokenCeiling: deriveAgentLoopTokenCeiling,
        displayStepTotal: displayStepTotal
    };
}
