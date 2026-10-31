// Generated node fields are user-visible content. Keep FlowPilot's persona
// voice out of those fields even when a provider echoes prompt guidance.
var FLOWPILOT_PERSONA_TAGLINE = "You pick the destination, I help you get there.";

function stripFlowPilotPersonaText(value) {
    if (typeof value !== "string") { return value; }
    return value
        .replace(/\s*You pick the destination, I help you get there\.?\s*/gi, " ")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+([,.;!?])/g, "$1")
        .trim();
}

function sanitizeGeneratedValue(value) {
    if (typeof value === "string") { return stripFlowPilotPersonaText(value); }
    if (Array.isArray(value)) { return value.map(sanitizeGeneratedValue); }
    if (value && typeof value === "object") {
        var copy = {};
        Object.keys(value).forEach(function (key) {
            copy[key] = sanitizeGeneratedValue(value[key]);
        });
        return copy;
    }
    return value;
}

function sanitizeGeneratedNode(node) {
    return sanitizeGeneratedValue(node || {});
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        FLOWPILOT_PERSONA_TAGLINE: FLOWPILOT_PERSONA_TAGLINE,
        stripFlowPilotPersonaText: stripFlowPilotPersonaText,
        sanitizeGeneratedValue: sanitizeGeneratedValue,
        sanitizeGeneratedNode: sanitizeGeneratedNode
    };
}
