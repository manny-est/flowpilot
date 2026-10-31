    // Pure re-plan reduction helpers. The browser keeps ids for execution,
    // but the user-facing continuation only gets names/types.
    function replanNodeLabel(node) {
        node = node || {};
        return String(node.name || node.type || "a node that no longer exists").trim() ||
            "a node that no longer exists";
    }

    function replanNodeNames(nodes) {
        var seen = {};
        return (Array.isArray(nodes) ? nodes : []).map(replanNodeLabel).filter(function (label) {
            var key = label.toLowerCase();
            if (seen[key]) { return false; }
            seen[key] = true;
            return true;
        });
    }

    function itemMentionsNode(item, node) {
        var text = String(item || "").toLowerCase();
        var name = String(node && node.name || "").toLowerCase().trim();
        var type = String(node && node.type || "").toLowerCase().trim();
        return (name && name.length > 1 && text.indexOf(name) !== -1) ||
            (type && new RegExp("(^|[^a-z0-9])" + type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9]|$)", "i").test(text));
    }

    function reducePlan(planItems, createdNodes, options) {
        options = options || {};
        var items = (Array.isArray(planItems) ? planItems : []).map(function (item) {
            return typeof item === "string" ? { text: item, status: "pending" } : (item || { text: "", status: "pending" });
        });
        var nodes = Array.isArray(createdNodes) ? createdNodes.filter(Boolean) : [];
        var doneIndexes = {};
        (Array.isArray(options.doneIndexes) ? options.doneIndexes : []).forEach(function (index) {
            doneIndexes[index] = true;
        });
        var completedCount = Number(options.completedCount);
        if (isFinite(completedCount) && completedCount > 0) {
            for (var i = 0; i < Math.min(items.length, completedCount); i++) { doneIndexes[i] = true; }
        }
        items.forEach(function (item, index) {
            if (item.status === "done") { doneIndexes[index] = true; }
            if (doneIndexes[index]) { return; }
            if (nodes.some(function (node) { return itemMentionsNode(item.text, node); })) {
                doneIndexes[index] = true;
            }
        });
        return {
            remaining: items.filter(function (_, index) { return !doneIndexes[index]; }).map(function (item) { return item.text; }),
            alreadyBuilt: replanNodeNames(nodes)
        };
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { replanNodeLabel: replanNodeLabel, replanNodeNames: replanNodeNames, reducePlan: reducePlan };
    }
