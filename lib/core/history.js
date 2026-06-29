// ---------------------------------------------------------------------
// Conversation-history module (Phase 9 refactor seam 3).
//
// Concatenated into the same shared closure as the rest of
// flowpilot-core.js (see lib/build-core-script.js) - referenced directly
// by name from main.js and other fragments, same as if this were still
// one file. Depends on `currentSettings` (declared in main.js), reached
// via that shared closure.
// ---------------------------------------------------------------------

    // ---------------------------------------------------------------------
    // Identifies this conversation for server-side transcript
    // persistence (chats/<conversationId>.jsonl). Kept in sessionStorage so
    // a page reload continues the same transcript; reset by clearChat()
    // ("start a fresh conversation" gets a fresh transcript file too).
    // ---------------------------------------------------------------------
    function makeConversationId() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return window.crypto.randomUUID();
        }
        return "fp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    }

    function newConversationId() {
        var id = makeConversationId();
        try { sessionStorage.setItem("fp-conversation-id", id); } catch (e) { /* storage unavailable */ }
        return id;
    }

    var conversationId = (function () {
        try {
            var existing = sessionStorage.getItem("fp-conversation-id");
            if (existing) { return existing; }
        } catch (e) { /* storage unavailable */ }
        return newConversationId();
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
