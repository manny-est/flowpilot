    // ---------------------------------------------------------------------
    // Identifies this conversation for server-side transcript
    // persistence (chats/<conversationId>.jsonl). Kept in sessionStorage so
    // a page reload continues the same transcript; reset by clearChat()
    // ("start a fresh conversation" gets a fresh transcript file too).
    // ---------------------------------------------------------------------
    var FP_CONVERSATION_ID_KEY = "fp-conversation-id";
    var FP_RUN_MARKER_KEY = "fp-run-marker";

    function flowpilotStorageLog(level, event, data) {
        var logger = console[level] || console.log;
        try {
            logger.call(console, "[FlowPilot][storage] " + event, data || {});
        } catch (e) { /* console unavailable */ }
    }

    function flowpilotSessionStorage() {
        return window.sessionStorage;
    }

    function flowpilotStorageGet(key, reason) {
        try {
            var value = flowpilotSessionStorage().getItem(key);
            flowpilotStorageLog("log", "get", {
                key: key,
                reason: reason || "",
                value: value,
                href: location.href
            });
            return value;
        } catch (e) {
            flowpilotStorageLog("warn", "get-failed", {
                key: key,
                reason: reason || "",
                error: e && e.message ? e.message : String(e),
                href: location.href
            });
            return null;
        }
    }

    function flowpilotStorageSet(key, value, reason) {
        try {
            flowpilotSessionStorage().setItem(key, value);
            var readBack = flowpilotSessionStorage().getItem(key);
            flowpilotStorageLog("log", "set", {
                key: key,
                reason: reason || "",
                value: value,
                readBack: readBack,
                href: location.href
            });
            return true;
        } catch (e) {
            flowpilotStorageLog("warn", "set-failed", {
                key: key,
                reason: reason || "",
                value: value,
                error: e && e.message ? e.message : String(e),
                href: location.href
            });
            return false;
        }
    }

    function flowpilotStorageRemove(key, reason) {
        try {
            flowpilotSessionStorage().removeItem(key);
            flowpilotStorageLog("log", "remove", {
                key: key,
                reason: reason || "",
                href: location.href
            });
            return true;
        } catch (e) {
            flowpilotStorageLog("warn", "remove-failed", {
                key: key,
                reason: reason || "",
                error: e && e.message ? e.message : String(e),
                href: location.href
            });
            return false;
        }
    }

    function makeConversationId() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return window.crypto.randomUUID();
        }
        return "fp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    }

    function newConversationId() {
        var id = makeConversationId();
        flowpilotStorageSet(FP_CONVERSATION_ID_KEY, id, "newConversationId");
        return id;
    }

    function persistConversationId(id, reason) {
        if (!id) { return false; }
        return flowpilotStorageSet(FP_CONVERSATION_ID_KEY, String(id), reason || "persistConversationId");
    }

    function clearConversationId(reason) {
        return flowpilotStorageRemove(FP_CONVERSATION_ID_KEY, reason || "clearConversationId");
    }

    function readRunMarker() {
        var raw = flowpilotStorageGet(FP_RUN_MARKER_KEY, "readRunMarker");
        if (!raw) { return null; }
        try {
            return JSON.parse(raw);
        } catch (e) {
            flowpilotStorageLog("warn", "run-marker-parse-failed", {
                raw: raw,
                error: e && e.message ? e.message : String(e)
            });
            flowpilotStorageRemove(FP_RUN_MARKER_KEY, "invalid run marker json");
            return null;
        }
    }

    function writeRunMarker(marker, reason) {
        if (!marker) { return false; }
        return flowpilotStorageSet(FP_RUN_MARKER_KEY, JSON.stringify(marker), reason || "writeRunMarker");
    }

    function clearRunMarker(reason) {
        return flowpilotStorageRemove(FP_RUN_MARKER_KEY, reason || "clearRunMarker");
    }

    function renderInterruptedRunMessage(appliedCount) {
        addMessage("assistant",
            "⚠ This run was interrupted after step " + appliedCount +
            " — completed steps are applied (Ctrl+Z to undo). Re-send to continue from here.");
    }

    function restoreInterruptedRunMarker(expectedConversationId) {
        var marker = readRunMarker();
        if (!marker) { return; }
        flowpilotStorageLog("log", "restore-run-marker", {
            marker: marker,
            expectedConversationId: expectedConversationId || null
        });
        if (expectedConversationId && marker.conversationId && marker.conversationId !== expectedConversationId) {
            flowpilotStorageLog("warn", "run-marker-conversation-mismatch", {
                markerConversationId: marker.conversationId,
                expectedConversationId: expectedConversationId
            });
            clearRunMarker("run marker conversation mismatch");
            return;
        }
        renderInterruptedRunMessage(Number(marker.appliedCount) || 0);
        clearRunMarker("restored interrupted run banner");
    }

    // CLAUDE-029: whether conversationId above came from an existing
    // sessionStorage entry (a page reload continuing a prior conversation)
    // rather than being freshly minted — drives whether page init rehydrates
    // the Chat panel from the server. See rehydrateConversationOnLoad().
    var conversationIdWasRestored = false;

    var conversationId = (function () {
        flowpilotStorageLog("log", "conversation-id-init-enter", {
            href: location.href,
            readyState: document.readyState
        });
        var existing = flowpilotStorageGet(FP_CONVERSATION_ID_KEY, "conversationId init");
        if (existing) {
            conversationIdWasRestored = true;
            flowpilotStorageLog("log", "conversation-id-restored", { conversationId: existing });
            return existing;
        }
        var fresh = newConversationId();
        flowpilotStorageLog("log", "conversation-id-created", { conversationId: fresh });
        return fresh;
    })();

    // ---------------------------------------------------------------------
    // Client-held conversation history. The backend is stateless —
    // each request that should have continuity carries a capped slice of
    // this array. Cleared by clearChat() ("start a fresh conversation").
    // Entries are { role: "user" | "assistant", content: <string> }.
    // ---------------------------------------------------------------------
    var conversationHistory = [];

    function pushHistory(role, content) {
        if (!content) { return; }
        conversationHistory.push({ role: role, content: String(content) });
    }

    // Every turn pushes its "user" entry before the request goes out (see
    // send()'s comment), but a stopped/errored/empty turn never gets a
    // matching assistant reply. Left alone, that dangling "user" entry sits
    // at the end of conversationHistory and the NEXT turn's own "user" push
    // lands right after it — two consecutive "user" entries with no
    // assistant turn between them, corrupting the role-alternation shape of
    // every request built from history from then on. Called from every
    // failure exit (chat and generate/document/modify/build alike) to undo
    // exactly that push. Safe even if called when nothing needs undoing: it
    // only pops when the most recent entry is a "user" turn.
    function popDanglingUserHistory() {
        var last = conversationHistory[conversationHistory.length - 1];
        if (last && last.role === "user") {
            conversationHistory.pop();
        }
    }

    function getHistoryMaxExchanges() {
        var n = Number(currentSettings.historyMaxExchanges);
        return (isFinite(n) && n >= 0) ? n : 10;
    }

    // Returns the history to send with a request, plus whether anything has
    // ever been dropped. ONE place both /chat and the generate/modify/document
    // send paths call, so the cap and truncation behaviour can't drift
    // between them.
    //
    // B3: stepped (paged) truncation instead of a continuously-sliding
    // window. A plain slice(-maxMessages) would drop the oldest exchange and
    // append the newest on EVERY turn once the cap is reached — changing the
    // history prefix sent to the provider every request and invalidating its
    // prompt/KV cache for the (large, expensive) system prompt every time.
    // Instead, conversationHistory grows untrimmed — and the sent history is
    // a pure append, i.e. byte-stable except for new messages at the tail —
    // up to 2x the cap, then drops the oldest half in one shot. Sent history
    // size ranges between maxMessages and 2*maxMessages exchanges-worth of
    // messages; "truncated" (and HISTORY_TRUNCATION_NOTICE) flips at each of
    // those two points, not every turn.
    function buildHistoryPayload() {
        var maxMessages = getHistoryMaxExchanges() * 2;
        // maxMessages === 0 means memory is off by design — that's not
        // "truncation" and shouldn't trigger the omitted-messages notice (#10).
        if (maxMessages === 0) {
            return { messages: [], truncated: false };
        }

        if (conversationHistory.length > maxMessages * 2) {
            conversationHistory = conversationHistory.slice(-maxMessages);
        }

        var truncated = conversationHistory.length > maxMessages;
        return { messages: conversationHistory.slice(), truncated: truncated };
    }
