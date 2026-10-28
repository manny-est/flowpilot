    // ---- Consent classifier (R11-8, ADR-010) ----------------------------
    // consent = f(operation, node_type, context) → "auto" | "ask". Designed
    // once and shared: the agent WRITE-tool gate (main.js), the classic
    // build consent gate (flowpilot.js, via require — see the export at the
    // bottom), converged Build's deploy step, and later X-Ray's hook halt
    // point (the "trigger" row). Replaces the two hand-synced
    // SAFE_NODE_TYPES copies.
    //
    // | operation      | safe types | side-effecting (and unknown) types |
    // |----------------|------------|------------------------------------|
    // | create         | auto       | ask                                |
    // | modify-config  | auto       | ask                                |
    // | rewire         | auto       | ask                                |
    // | delete         | ask        | ask                                |
    // | deploy         | auto when no own edits; ask otherwise         |
    // | trigger        | auto       | ask                                |
    //
    // context (all optional):
    //   hold     — pacing "hold at every step": ask regardless.
    //   memory   — a createConsentMemory() store; taskId + nodeId — a node
    //              the user already approved in this task isn't re-asked
    //              (never for delete; deploy uses own-edit accounting).
    var CONSENT_SAFE_NODE_TYPES = [
        "inject", "function", "change", "switch", "filter", "json", "xml", "csv",
        "base64", "html", "split", "join", "sort", "batch", "debug", "status",
        "comment", "link in", "link out", "link call", "junction"
    ];

    var CONSENT_OPERATIONS = ["create", "modify-config", "rewire", "delete", "deploy", "trigger"];
    var CONSENT_ALWAYS_ASK = ["delete", "deploy"];

    function isSafeNodeType(nodeType) {
        return typeof nodeType === "string" && CONSENT_SAFE_NODE_TYPES.indexOf(nodeType) !== -1;
    }

    function decideConsent(operation, nodeType, context) {
        context = context || {};
        if (CONSENT_OPERATIONS.indexOf(operation) === -1) { return "ask"; }
        if (context.hold === true) { return "ask"; }
        // An approved PLAN card may pre-authorize exactly the operations it
        // listed. Ordinary runs do not provide this allow-list, so delete
        // retains its always-ask behavior; deploy is accounted below.
        if (context.approvedOperations && context.approvedOperations.some(function (item) {
            return planApprovalMatches(item, operation, nodeType, context.nodeId);
        })) { return "auto"; }
        if (operation === "deploy" && context.ownEdits !== undefined) {
            if (context.restricted === true) { return "ask"; }
            return Number(context.ownEdits) > 0 ? "ask" : "auto";
        }
        if (CONSENT_ALWAYS_ASK.indexOf(operation) !== -1) { return "ask"; }
        if (isSafeNodeType(nodeType)) { return "auto"; }
        if (context.memory && context.memory.has(context.taskId, context.nodeId)) { return "auto"; }
        return "ask";
    }

    // Per-task memory of nodes the user approved. A new taskId starts empty,
    // so approval never carries across tasks.

    // What an approved plan item covers. Only deploy (not a per-node
    // operation) may be approved without a node; delete and config changes
    // need the exact node id; a create is approved for the listed node type.
    // A plan line like "remove the debug node" must never pre-approve
    // deleting any node the run touches.
    function planApprovalMatches(item, operation, nodeType, nodeId) {
        if (!item || item.operation !== operation || item.approvable === false) { return false; }
        if (operation === "deploy") { return true; }
        if (operation === "create") { return !!item.type && item.type === nodeType; }
        return !!item.nodeId && item.nodeId === nodeId;
    }

    function createConsentMemory() {
        var approved = {};
        var approvedOperations = {};
        return {
            remember: function (taskId, nodeId) {
                if (!taskId || !nodeId) { return; }
                (approved[taskId] = approved[taskId] || {})[nodeId] = true;
            },
            has: function (taskId, nodeId) {
                return !!(taskId && nodeId && approved[taskId] && approved[taskId][nodeId]);
            },
            rememberOperation: function (taskId, operation, nodeId) {
                if (!taskId || !operation) { return; }
                var key = operation + ":" + (nodeId || "");
                (approvedOperations[taskId] = approvedOperations[taskId] || {})[key] = true;
            },
            hasOperation: function (taskId, operation, nodeId) {
                if (!taskId || !operation || !approvedOperations[taskId]) { return false; }
                // A node-less approval only ever covers deploy (see
                // planApprovalMatches).
                return !!(approvedOperations[taskId][operation + ":" + (nodeId || "")] ||
                    (operation === "deploy" && approvedOperations[taskId]["deploy:"]));
            }
        };
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            SAFE_NODE_TYPES: CONSENT_SAFE_NODE_TYPES.slice(),
            OPERATIONS: CONSENT_OPERATIONS.slice(),
            isSafeNodeType: isSafeNodeType,
            decideConsent: decideConsent,
            createConsentMemory: createConsentMemory,
            planApprovalMatches: planApprovalMatches
        };
    }
