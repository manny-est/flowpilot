(function () {
    "use strict";

    var VERSION = "2.2-repair";

    // Idempotency guard: Node-RED can invoke a plugin's onadd more than once
    // in a single editor load. Without this, each call builds another #fp-root
    // and we end up with an orphaned detached copy alongside the live one.
    var initialised = false;

    // ---------------------------------------------------------------------
    // All state and DOM references are scoped to this closure.
    // We look elements up *within the inserted content* ($root.find(...))
    // rather than document.getElementById, so we are never coupled to global
    // IDs and never depend on global assignment timing.
    // ---------------------------------------------------------------------
    var $root = null;

    // Pop-out window (Phase 8.5 C1, v1 review-only): a detached browser
    // window showing a read-only mirror of the chat thread. null when no
    // pop-out is open. The same flowpilot-core.js loads in that window too
    // (see initPopout) — this var is only ever non-null in the MAIN
    // window's own execution context.
    var popoutWindow = null;
    var popoutObserver = null;

    // True only inside the pop-out window's OWN execution context (set at
    // the top of initPopout — never true in the main window). Checked in
    // the few places that would otherwise touch dead RED.* state: the
    // final dispatch in dispatchSend() and the /compact+/expand case in
    // handleSlashCommand(). Everything else (arming, slash-command text,
    // settings) is pure local state and needs no flag at all.
    var isPopoutContext = false;

    // Holds the most recently loaded settings so warning logic can read the
    // user's thresholds and suppression preference without refetching.
    var currentSettings = {};

    // JSON snapshot of collectSettings() as of the last load/save, used by
    // the explicit Save button to tell "no changes" from "saved" without
    // hitting the backend for a no-op write.
    var savedSettingsSnapshot = null;
    var saveStatusTimer = null;

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

    // ---------------------------------------------------------------------
    // Secret detection — shared by the node-selection sanitizer (below)
    // and the live debug-message redactor (next section). Two
    // complementary checks:
    //   - VALUE_SECRET_PATTERNS: the VALUE looks like a credential (bearer
    //     token, JWT, AWS key, high-entropy blob), regardless of field name.
    //   - SECRET_KEY: the field NAME looks secret-bearing (password, token,
    //     apiKey, ...) AND the value is a string long enough to plausibly be
    //     a real secret — short strings like `key: "ab"` or numbers like
    //     `keyCount: 3` are left alone.
    // Redaction is informative, not silent: placeholders carry the kind and
    // original length (`[redacted: bearer token, 211 chars]`) so the AI can
    // still reason about "an auth header was present" without seeing it.
    // ---------------------------------------------------------------------
    var SECRET_KEY = /pass|secret|token|apikey|api_key|key$|credential|auth|bearer/i;
    var SECRET_NAME_MIN_LEN = 8;

    var VALUE_SECRET_PATTERNS = [
        // Case-insensitive and tolerant of "Bearer: <token>" /
        // "bearer=<token>" variants, not just the strict HTTP-header form.
        { kind: "bearer token", re: /\bbearer\s*[:=]?\s+[A-Za-z0-9._\-]{8,}/i },
        { kind: "JWT", re: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/ },
        { kind: "AWS key", re: /\bAKIA[0-9A-Z]{16}\b/ },
        // Long high-entropy hex/base64-ish blob with no whitespace — catches
        // raw tokens/secrets that don't match a more specific pattern above.
        { kind: "token/secret", re: /^[A-Za-z0-9+/=_\-]{32,}$/ }
    ];

    function matchSecretValue(str) {
        for (var i = 0; i < VALUE_SECRET_PATTERNS.length; i++) {
            if (VALUE_SECRET_PATTERNS[i].re.test(str)) { return VALUE_SECRET_PATTERNS[i].kind; }
        }
        return null;
    }

    // Node-RED's "edit message properties" UI (Inject node's Properties list,
    // Change node's rules, etc.) stores each entry as
    // { p: "<property name>", v/to: "<value>", vt/tot: "<type>" } — the
    // secret-indicating NAME lives in `p`, but the secret VALUE lives in a
    // sibling `v`/`to` field. SECRET_KEY.test() against the object key alone
    // ("v"/"to") never matches, so a property literally named "auth" or
    // "apikey" sailed through untouched. Check `p` explicitly for these
    // known value-holding sibling keys.
    var DYNAMIC_PROPERTY_VALUE_KEYS = ["v", "to"];

    // Recursively redacts secret-shaped values out of a debug message / node
    // config value. `key` is the property name the value was found under
    // (undefined for array elements and the top-level value) — used only for
    // the name-based check. Structural data (numbers, booleans, short
    // strings, object/array shape) passes through untouched, preserving
    // diagnostic value.
    //
    // currentSettings.redactionEnabled defaults true (settings.json default,
    // and an empty {} before settings ever load) — explicitly opting OUT via
    // the type-to-confirm Settings toggle is required to disable this. The
    // Node-RED credentials field is a SEPARATE, always-on mechanism (dropped
    // entirely in sanitizeNode's INTERNAL_FIELDS) and is unaffected either way.
    function redactDebugValue(value, key) {
        if (currentSettings.redactionEnabled === false) { return value; }
        if (typeof value === "string") {
            var kind = matchSecretValue(value);
            if (kind) { return "[redacted: " + kind + ", " + value.length + " chars]"; }
            if (key !== undefined && SECRET_KEY.test(String(key)) && value.length > SECRET_NAME_MIN_LEN) {
                return "[redacted: secret field, " + value.length + " chars]";
            }
            return value;
        }
        if (Array.isArray(value)) {
            return value.map(function (v) { return redactDebugValue(v, key); });
        }
        if (value && typeof value === "object") {
            var out = {};
            var dynamicNameIsSecret = typeof value.p === "string" && SECRET_KEY.test(value.p);
            Object.keys(value).forEach(function (k) {
                if (dynamicNameIsSecret && DYNAMIC_PROPERTY_VALUE_KEYS.indexOf(k) !== -1 &&
                        typeof value[k] === "string" && value[k].length > SECRET_NAME_MIN_LEN) {
                    out[k] = "[redacted: secret field, " + value[k].length + " chars]";
                    return;
                }
                out[k] = redactDebugValue(value[k], k);
            });
            return out;
        }
        return value;
    }

    // ---------------------------------------------------------------------
    // Live debug-message context: a rolling local-only buffer of recent
    // Node-RED Debug sidebar output (populated via RED.comms "debug"
    // subscription, see plugin onadd), plus the subset the user has
    // explicitly attached as context for upcoming requests — "select it like
    // Recall messages" (sticky, like conversationHistory, until removed or
    // Clear Chat). Nothing here is sent anywhere until attached AND a
    // request is sent.
    // ---------------------------------------------------------------------
    var DEBUG_BUFFER_MAX = 50;
    // Two different caps for two different jobs. PREVIEW is just for the
    // scannable debug-log list (many short entries). SEND is what actually
    // gets attached/transmitted — much higher, because a value truncated
    // mid-JSON at 500 chars (e.g. cut inside a string or property name) can
    // arrive at the model as malformed JSON, which looks indistinguishable
    // from "the model ignored the attached data".
    var DEBUG_VALUE_PREVIEW_MAX_CHARS = 500;
    var DEBUG_VALUE_SEND_MAX_CHARS = 20000;
    var debugMessageBuffer = [];
    var attachedDebugMessages = [];
    var nextDebugMessageId = 1;

    function truncateForDebug(text, max) {
        text = String(text);
        return text.length > max ? text.slice(0, max - 1) + "…" : text;
    }

    // Best-effort stringify for a debug message's value — may be any type
    // (string, number, object, undefined for "complete msg" mode where the
    // value lives one level down, etc.).
    function stringifyDebugValue(value) {
        if (typeof value === "string") { return value; }
        try { return JSON.stringify(value); } catch (e) { return String(value); }
    }

    // RED.comms.subscribe callbacks receive (topic, msg) — the topic is
    // always "debug" here since that's the only topic we subscribed to.
    //
    // Secrets are redacted HERE, at capture time, before anything enters
    // debugMessageBuffer — the raw value is never buffered, let alone sent.
    // Redact first, then truncate, so a secret can't survive by being cut
    // off mid-value rather than recognized and replaced.
    function onDebugMessage(topic, msg) {
        if (!msg) { return; }
        var redactedValue = redactDebugValue(msg.msg, undefined);
        var redactedTopic = redactDebugValue(msg.topic || "", undefined);
        var stringified = stringifyDebugValue(redactedValue);
        var entry = {
            id: nextDebugMessageId++,
            timestamp: Date.now(),
            name: msg.name || msg.id || "(unnamed node)",
            topic: redactedTopic,
            // previewValue: short, for the scannable debug-log list only.
            // value: the much-less-truncated version that actually gets
            // attached/sent and shown by "Preview debug" — never the raw
            // unredacted value either way.
            previewValue: truncateForDebug(stringified, DEBUG_VALUE_PREVIEW_MAX_CHARS),
            value: truncateForDebug(stringified, DEBUG_VALUE_SEND_MAX_CHARS)
        };
        debugMessageBuffer.push(entry);
        if (debugMessageBuffer.length > DEBUG_BUFFER_MAX) {
            debugMessageBuffer = debugMessageBuffer.slice(-DEBUG_BUFFER_MAX);
        }

        // /build loop: auto-attach is gated to debug messages from a debug
        // NODE THE LOOP ITSELF BUILT (msg.id is the emitting debug node's
        // own id — see core 21-debug.js's sendDebug({id: node.id, ...})),
        // not just whatever debug message happens to arrive next. Without
        // this, an unrelated debug node firing elsewhere in the workspace
        // (a different flow tab, a startup error, etc.) could win the race
        // and get reviewed instead of the flow this loop actually built —
        // confirmed live: a Home Assistant node's unrelated error got
        // auto-attached and "reviewed" instead of the real output.
        //
        // Debounced rather than reviewing on the FIRST matching message —
        // confirmed live: a generated flow whose wiring forked/split before
        // the debug node fired it more than once per trigger, and the
        // review judged success against only the first (incomplete)
        // message, missing the goal entirely. A short window lets EVERY
        // message from one trigger accumulate into attachedDebugMessages
        // before review actually runs, so the model sees the full picture
        // instead of whichever message happened to arrive first.
        if (activeBuildLoop && activeBuildLoop.waypoint === "attach" &&
            activeBuildLoop.nodeIds.indexOf(msg.id) !== -1) {
            attachedDebugMessages.push(entry);
            updateDebugStatus();
            if (buildLoopAttachTimer) { clearTimeout(buildLoopAttachTimer); }
            buildLoopAttachTimer = setTimeout(function () {
                buildLoopAttachTimer = null;
                if (!activeBuildLoop || activeBuildLoop.waypoint !== "attach") { return; }
                activeBuildLoop.waypoint = "review";
                renderLoopStepper(activeBuildLoop);
                runBuildReview(activeBuildLoop);
            }, BUILD_LOOP_ATTACH_DEBOUNCE_MS);
        }
    }

    // The exact shape sent to the backend (and shown by "Preview debug") —
    // excludes previewValue, which exists only for the debug-log list.
    function buildDebugMessagesForSend() {
        return attachedDebugMessages.map(function (m) {
            return { id: m.id, timestamp: m.timestamp, name: m.name, topic: m.topic, value: m.value };
        });
    }

    // Merges any attached debug messages into a request's context object —
    // called right after collectSelectionContext() in send/generate/
    // documentFlow/modifyFlow. Leaves context untouched (including null) when
    // nothing is attached.
    function attachDebugContext(context) {
        if (!attachedDebugMessages.length) { return context; }
        context = context || { nodes: [], connections: {} };
        return Object.assign({}, context, { debugMessages: buildDebugMessagesForSend() });
    }

    // Updates the "🐛 N debug message(s) attached" indicator in the context
    // strip, shown only when something is attached.
    function updateDebugStatus() {
        var $status = el("#fp-debug-status");
        if (!$status.length) { return; }
        if (!attachedDebugMessages.length) {
            $status.addClass("fp-hidden").empty();
            relayStatusStripToPopout();
            return;
        }
        $status.removeClass("fp-hidden").empty();
        var n = attachedDebugMessages.length;
        $status.append(document.createTextNode("🐛 " + n + " debug message" + (n === 1 ? "" : "s") + " attached "));
        var $preview = $("<a>").attr("href", "#").text("preview").attr("title", "Show the exact debug payload that will be sent");
        $preview.on("click", function (ev) {
            ev.preventDefault();
            showJsonPreview("Debug payload preview — exactly what will be sent", buildDebugMessagesForSend());
        });
        $status.append($preview).append(document.createTextNode(" "));
        var $clear = $("<a>").attr("href", "#").text("✕").attr("title", "Remove all attached debug messages");
        $clear.on("click", function (ev) {
            ev.preventDefault();
            attachedDebugMessages = [];
            updateDebugStatus();
        });
        $status.append($clear);
        relayStatusStripToPopout();
    }

    // Diagnostic tool: dumps `data` as a fenced JSON code block into the chat
    // thread (UI-only — never added to conversationHistory). Lets the user
    // see exactly what a request would carry, instead of guessing whether
    // the model received it or silently ignored it.
    function showJsonPreview(title, data) {
        addMessage("assistant", "**" + title + "**\n\n```json\n" + JSON.stringify(data, null, 2) + "\n```");
    }

    // Resolves the node-selection context that would actually be sent right
    // now: the live canvas selection, or (while an Execute action is armed
    // with nothing currently selected) the pinned selection from when it was
    // armed. Used by "Preview JSON" so it can never show different context
    // than what Send actually uses.
    function resolveCurrentSelectionContext() {
        var sel = (RED.view && RED.view.selection) ? RED.view.selection() : null;
        var liveCount = (sel && sel.nodes) ? sel.nodes.length : 0;
        if (liveCount > 0) { return collectSelectionContext(); }
        if (armedExecuteAction && pinnedSelectionIds) {
            return collectSelectionContext(pinnedSelectionIds);
        }
        return null;
    }

    function getHistoryMaxExchanges() {
        var n = Number(currentSettings.historyMaxExchanges);
        return (isFinite(n) && n >= 0) ? n : 10;
    }

    function getAgentLoopMaxIterations() {
        var n = Number(currentSettings.agentLoopMaxIterations);
        return (isFinite(n) && n >= 1) ? n : 5;
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

    // Which Execute action (if any) Send currently triggers. null = ordinary
    // chat. Only one Execute action can be armed at a time — clicking an
    // armed one again disarms it back to chat.
    var armedExecuteAction = null;

    // ids of the selection PINNED for the current armed session. Set when
    // arming with a selection, or refreshed whenever the live selection
    // changes while armed (non-empty only — deselecting keeps the pin so
    // follow-up turns need no reselection). Cleared on disarm/Clear Chat.
    var pinnedSelectionIds = null;

    // Clicking a group's border/background in the editor selects the GROUP
    // itself — one object, type:"group" — not its members; RED.view.selection()
    // returns exactly that one entry, same as selecting a single regular
    // node. For context/counting purposes the user means "everything
    // inside it," so expand any group entries into their real member
    // nodes via RED.group.getNodes(group, recursive, excludeGroup) — the
    // editor's own public API for this (recursive: descend into nested
    // sub-groups too; excludeGroup: only real nodes in the result, not
    // the nested group containers themselves — nesting still isn't
    // authored by FlowPilot, but a member node of one shouldn't vanish
    // from context just because it's nested one level deeper).
    // Returns { nodes: [...real nodes, deduped], groupCount } so callers
    // needing just ids and callers needing the group count (the status
    // strip) share one expansion instead of two slightly different ones.
    function expandGroupSelection(rawNodes) {
        var expanded = [];
        var seen = {};
        var groupCount = 0;
        (rawNodes || []).forEach(function (n) {
            if (!n) { return; }
            if (n.type === "group") {
                groupCount++;
                var members = (RED.group && RED.group.getNodes) ? RED.group.getNodes(n, true, true) : [];
                members.forEach(function (m) {
                    if (m && !seen[m.id]) { seen[m.id] = true; expanded.push(m); }
                });
            } else if (!seen[n.id]) {
                seen[n.id] = true; expanded.push(n);
            }
        });
        return { nodes: expanded, groupCount: groupCount };
    }

    function pinCurrentSelection() {
        var sel = (RED.view && RED.view.selection) ? RED.view.selection() : null;
        var ids = expandGroupSelection((sel && sel.nodes) ? sel.nodes : []).nodes
            .map(function (n) { return n.id; });
        if (ids.length) { pinnedSelectionIds = ids; }
    }

    // The node ids to use for context: the live selection if non-empty,
    // else the pinned selection from earlier in this armed session (or null
    // if neither — Generate works fine with no context).
    function activeSelectionIds() {
        var sel = (RED.view && RED.view.selection) ? RED.view.selection() : null;
        var liveIds = (sel && sel.nodes && sel.nodes.length)
            ? expandGroupSelection(sel.nodes).nodes.map(function (n) { return n.id; })
            : null;
        return (liveIds && liveIds.length ? liveIds : null) || pinnedSelectionIds;
    }

    function disarmExecuteAction() {
        if (!armedExecuteAction) { return; }
        armedExecuteAction = null;
        pinnedSelectionIds = null;
        el("#fp-generate").removeClass("fp-action-armed");
        el("#fp-document").removeClass("fp-action-armed");
        el("#fp-modify").removeClass("fp-action-armed");
        el("#fp-send").text("Send").removeClass("fp-send-armed");
        el(".fp-compose").removeClass("fp-mode-execute");
    }

    function setArmedExecuteAction(action) {
        if (armedExecuteAction === action) { disarmExecuteAction(); return; }
        disarmQueryIntent();
        armedExecuteAction = action;
        pinCurrentSelection();
        el("#fp-generate").toggleClass("fp-action-armed", armedExecuteAction === "generate");
        el("#fp-document").toggleClass("fp-action-armed", armedExecuteAction === "document");
        el("#fp-modify").toggleClass("fp-action-armed", armedExecuteAction === "modify");
        var label = "Send";
        if (armedExecuteAction === "generate") { label = "Send (Generate)"; }
        else if (armedExecuteAction === "document") { label = "Send (Document)"; }
        else if (armedExecuteAction === "modify") { label = "Send (Modify)"; }
        else if (armedExecuteAction === "build") { label = "Send (Build)"; }
        el("#fp-send").text(label).addClass("fp-send-armed");
        el(".fp-compose").addClass("fp-mode-execute");
    }

    // Arms the given Execute action regardless of current
    // state. Unlike setArmedExecuteAction (which TOGGLES an already-armed
    // action back off), an action chip always means "switch to this mode" —
    // never "disarm."
    function armExecuteAction(action) {
        // A "chat" suggestion means "switch back to ordinary chat" — there's
        // no Execute button for it, so disarm whatever's currently armed
        // instead of trying to set armedExecuteAction to "chat".
        if (action === "chat") { disarmExecuteAction(); return; }
        if (armedExecuteAction === action) { return; }
        setArmedExecuteAction(action);
    }

    // Which Query intent (if any) is currently armed: lit button + the
    // amber "mode readout" border on #fp-prompt, mirroring the Execute
    // side's blue treatment. Identified by label since that's already
    // unique across built-in and custom intents (addCustomIntent enforces
    // it). One-shot — dispatchSend() disarms it, since Query intents are
    // just templated chat messages with no backend mode of their own.
    var armedQueryIntentLabel = null;
    var $armedQueryButton = null;

    function disarmQueryIntent() {
        if (!armedQueryIntentLabel) { return; }
        armedQueryIntentLabel = null;
        if ($armedQueryButton) { $armedQueryButton.removeClass("fp-action-armed"); }
        $armedQueryButton = null;
        el(".fp-compose").removeClass("fp-mode-query");
    }

    function armQueryIntent(intent, $btn) {
        if (armedQueryIntentLabel === intent.label) { disarmQueryIntent(); return; }
        disarmExecuteAction();
        disarmQueryIntent();
        armedQueryIntentLabel = intent.label;
        $armedQueryButton = $btn || null;
        if ($armedQueryButton) { $armedQueryButton.addClass("fp-action-armed"); }
        el(".fp-compose").addClass("fp-mode-query");
        applyIntentText(intent.text);
    }

    // ---- Intent modes ------------------------------------------------------
    // Single source of truth for the one-click intents. Each button is
    // generated from this list. Clicking a button fills the prompt box with
    // the instruction (the user can then edit before sending). Intent is
    // deliberately kept separate from "scope" (what gets sent) so future
    // scope modes (selected flow, entire instance) slot in without touching
    // this. To add an intent, add an entry here.
    var INTENTS = [
        {
            id: "explain",
            label: "Explain",
            text: "Explain what this selection does, step by step, in plain " +
                  "language. Describe the message path and what each node " +
                  "contributes."
        },
        {
            id: "troubleshoot",
            label: "Troubleshoot",
            text: "Help diagnose why this selection may not be working as " +
                  "intended. Point out disabled nodes, dead-end wires, outputs " +
                  "that never fire, and likely misconfigurations. Be specific " +
                  "about what you can and cannot see."
        },
        {
            id: "review",
            label: "Review",
            text: "Review this selection as an architecture and design " +
                  "critique: coupling, missing error handling, fragile " +
                  "patterns, and concrete suggestions to improve " +
                  "maintainability."
        },
        {
            id: "suggest",
            label: "Suggest",
            text: "Suggest improvements or relevant Node-RED nodes that would " +
                  "make this selection better, simpler, or more robust."
        }
    ];

    function applyIntentText(text) {
        if (!text) { return; }
        // Replace rather than append/prepend: appending let alternating
        // clicks between two intents stack both texts repeatedly (each click
        // only guarded against re-adding ITSELF, not the other one already
        // in the box). A clean replace is simple and predictable — use the
        // clear button (✕) if you want an empty box again.
        var $box = el("#fp-prompt");
        $box.val(text);
        $box.focus();
    }

    // Built-in intents + user-defined customIntents from settings. Custom
    // intents are { label, text } objects persisted in settings.json.
    function getAllIntents() {
        var custom = Array.isArray(currentSettings.customIntents)
            ? currentSettings.customIntents : [];
        var builtin = INTENTS.map(function (i) {
            return { id: i.id, label: i.label, text: i.text, custom: false };
        });
        var user = custom.filter(function (c) {
            return c && c.label && c.text;
        }).map(function (c) {
            return { label: c.label, text: c.text, custom: true };
        });
        return builtin.concat(user);
    }

    // Custom query actions beyond this count collapse into a "…" dropdown so
    // the action bar doesn't grow without bound as users add more.
    var INLINE_CUSTOM_INTENT_LIMIT = 2;

    // Cockpit pass: built-in Query intents render as icon buttons (tooltip
    // carries the label + template text, same as before). Custom intents
    // keep their text label — an icon would be ambiguous for an
    // arbitrary user-defined button.
    var QUERY_INTENT_ICONS = {
        explain: "fa-question-circle",
        troubleshoot: "fa-wrench",
        review: "fa-list-alt",
        suggest: "fa-lightbulb-o"
    };

    function renderIntents($container) {
        if (!$container || !$container.length) { $container = el("#fp-intents"); }
        if (!$container.length) { return; }
        $container.empty();

        function addIntentButton(intent) {
            var icon = !intent.custom && QUERY_INTENT_ICONS[intent.id];
            var $btn = $("<button>")
                .addClass("red-ui-button red-ui-button-small fp-intent-btn")
                .toggleClass("fp-intent-custom", !!intent.custom)
                .toggleClass("fp-icon-btn fp-icon-btn-query", !!icon)
                .toggleClass("fp-action-armed", armedQueryIntentLabel === intent.label)
                .attr("type", "button")
                .attr("title", icon ? (intent.label + " — " + intent.text) : intent.text)
                .on("click", function () { armQueryIntent(intent, $btn); })
                .appendTo($container);
            if (icon) {
                $("<i>").addClass("fa " + icon).appendTo($btn);
            } else {
                $btn.text(intent.label);
            }
            // Re-render (e.g. after editing custom intents) can recreate the
            // armed button — keep the tracked reference pointing at the live
            // element so disarmQueryIntent() can still find it.
            if (armedQueryIntentLabel === intent.label) { $armedQueryButton = $btn; }
        }

        var all = getAllIntents();
        var builtin = all.filter(function (i) { return !i.custom; });
        var custom = all.filter(function (i) { return i.custom; });

        builtin.forEach(addIntentButton);
        custom.slice(0, INLINE_CUSTOM_INTENT_LIMIT).forEach(addIntentButton);

        var overflow = custom.slice(INLINE_CUSTOM_INTENT_LIMIT);
        if (overflow.length) {
            var $menu = $("<div>").addClass("fp-intent-menu fp-hidden");
            overflow.forEach(function (intent) {
                $("<a>")
                    .attr("href", "#")
                    .attr("title", intent.text)
                    .text(intent.label)
                    .on("click", function (e) {
                        e.preventDefault();
                        $menu.addClass("fp-hidden");
                        armQueryIntent(intent, null);
                    })
                    .appendTo($menu);
            });
            var $toggle = $("<button>")
                .addClass("red-ui-button red-ui-button-small fp-intent-more fp-icon-btn fp-icon-btn-query")
                .attr("type", "button")
                .attr("title", "More query actions")
                .append($("<i>").addClass("fa fa-ellipsis-h"))
                .on("click", function (e) {
                    e.stopPropagation();
                    $(".fp-intent-menu").not($menu).addClass("fp-hidden");
                    $menu.toggleClass("fp-hidden");
                });
            $("<div>")
                .addClass("fp-intent-more-wrap")
                .append($toggle)
                .append($menu)
                .appendTo($container);
        }
    }

    // Working copy of custom intents while editing in settings. Seeded from
    // currentSettings each time the list is rendered, edited in place, and
    // read back by collectSettings().
    var editingCustomIntents = [];

    function renderCustomIntentList() {
        var $list = el("#fp-custom-intents");
        if (!$list.length) { return; }
        editingCustomIntents = Array.isArray(currentSettings.customIntents)
            ? currentSettings.customIntents.map(function (c) {
                return { label: c.label, text: c.text };
            })
            : [];
        $list.empty();
        if (!editingCustomIntents.length) {
            $("<div>").addClass("fp-consent-hint")
                .text("No custom buttons yet. Add one below.")
                .appendTo($list);
        }
        editingCustomIntents.forEach(function (item, idx) {
            var $row = $("<div>").addClass("fp-custom-intent-row");
            $("<span>").addClass("fp-custom-intent-label").text(item.label).appendTo($row);
            $("<button>")
                .addClass("red-ui-button red-ui-button-small")
                .attr("type", "button")
                .text("Remove")
                .on("click", function () {
                    editingCustomIntents.splice(idx, 1);
                    // Persist immediately so buttons update; reuses saveSettings.
                    currentSettings.customIntents = editingCustomIntents.slice();
                    saveSettings();
                })
                .appendTo($row);
            $row.appendTo($list);
        });
    }

    function addCustomIntent() {
        var label = (el("#fp-new-intent-label").val() || "").trim();
        var text = (el("#fp-new-intent-text").val() || "").trim();
        if (!label || !text) {
            addMessage("error", "A custom button needs both a label and instruction text.");
            return;
        }
        // Catch label collisions with the built-in Query buttons (Explain/
        // Troubleshoot/Review/Suggest) or an existing custom button — two
        // same-named buttons in the action bar are confusingly ambiguous.
        var list = Array.isArray(currentSettings.customIntents)
            ? currentSettings.customIntents.slice() : [];
        var taken = INTENTS.map(function (i) { return i.label.toLowerCase(); })
            .concat(list.map(function (c) { return (c.label || "").toLowerCase(); }));
        if (taken.indexOf(label.toLowerCase()) !== -1) {
            addMessage("error", "A button named \"" + label + "\" already exists. Choose a different label.");
            return;
        }
        list.push({ label: label, text: text });
        currentSettings.customIntents = list;
        el("#fp-new-intent-label").val("");
        el("#fp-new-intent-text").val("");
        saveSettings();
    }

    function el(sel) {
        return $root ? $root.find(sel) : $();
    }

    // ---- View switching -------------------------------------------------

    function showChat() {
        el("#fp-chat-panel").removeClass("fp-hidden");
        el("#fp-settings-panel").addClass("fp-hidden");
        el("#fp-history-panel").addClass("fp-hidden");
        el("#fp-show-chat").addClass("fp-active");
        el("#fp-show-settings").removeClass("fp-active");
        el("#fp-show-history").removeClass("fp-active");
    }

    function showSettings() {
        el("#fp-settings-panel").removeClass("fp-hidden");
        el("#fp-chat-panel").addClass("fp-hidden");
        el("#fp-history-panel").addClass("fp-hidden");
        el("#fp-show-settings").addClass("fp-active");
        el("#fp-show-chat").removeClass("fp-active");
        el("#fp-show-history").removeClass("fp-active");
    }

    function showHistory() {
        el("#fp-history-panel").removeClass("fp-hidden");
        el("#fp-chat-panel").addClass("fp-hidden");
        el("#fp-settings-panel").addClass("fp-hidden");
        el("#fp-show-history").addClass("fp-active");
        el("#fp-show-chat").removeClass("fp-active");
        el("#fp-show-settings").removeClass("fp-active");
        loadConversationList();
    }

    // Clears the visible chat AND resets the conversation history the model
    // sees — "start a fresh conversation".
    function clearChat() {
        el("#fp-messages").empty();
        relayClearMessagesToPopout();
        conversationHistory = [];
        attachedDebugMessages = [];
        activeBuildLoop = null;
        disarmExecuteAction(); // also clears pinnedSelectionIds
        conversationId = newConversationId();
        fpChatSnappedToBottom = true;
        updateSelectionStatus();
        updateDebugStatus();
        showChat();
    }

    // "Flight log" — a conversation list layered over the per-conversation
    // transcript files. Loading a conversation rehydrates conversationHistory and the
    // visible chat from its saved transcript, so a follow-up message picks
    // up that conversation's memory rather than starting a fresh one.
    function formatRelativeTime(timestamp) {
        var then = new Date(timestamp).getTime();
        if (!isFinite(then)) { return ""; }
        var seconds = Math.max(0, (Date.now() - then) / 1000);
        if (seconds < 60) { return "just now"; }
        var minutes = seconds / 60;
        if (minutes < 60) { return Math.floor(minutes) + " min ago"; }
        var hours = minutes / 60;
        if (hours < 24) { return Math.floor(hours) + " hr ago"; }
        var days = hours / 24;
        if (days < 30) { return Math.floor(days) + " day" + (Math.floor(days) === 1 ? "" : "s") + " ago"; }
        return new Date(timestamp).toLocaleDateString();
    }

    function loadConversationList() {
        var $list = el("#fp-history-list");
        if (!$list.length) { return; }
        $list.empty().append($("<div>").addClass("fp-consent-hint").text("Loading…"));

        ajaxJson("GET", "flowpilot/conversations", null, function (data) {
            renderHistoryList(data.conversations || []);
        }, function (msg) {
            $list.empty();
            $("<div>").addClass("fp-consent-hint").text("Unable to load conversation list: " + msg).appendTo($list);
        });
    }

    function deleteAllConversations() {
        if (!window.confirm("Delete ALL saved conversation transcripts? This can't be undone.")) { return; }
        ajaxJson("DELETE", "flowpilot/conversations", null, function () {
            loadConversationList();
        });
    }

    function renderHistoryList(conversations) {
        var $list = el("#fp-history-list");
        if (!$list.length) { return; }
        $list.empty();

        if (!conversations.length) {
            $("<div>").addClass("fp-consent-hint").text("No saved conversations yet.").appendTo($list);
            return;
        }

        conversations.forEach(function (c) {
            var $item = $("<div>").addClass("fp-history-item");
            if (c.id === conversationId) { $item.addClass("fp-history-current"); }

            var $main = $("<div>").addClass("fp-history-main");
            $("<div>").addClass("fp-history-title").text(c.title || "(untitled)").appendTo($main);
            var meta = c.exchangeCount + (c.exchangeCount === 1 ? " exchange" : " exchanges") +
                " · " + formatRelativeTime(c.lastTimestamp);
            $("<div>").addClass("fp-history-meta").text(meta).appendTo($main);
            $main.on("click", function () { loadConversation(c.id); });
            $item.append($main);

            var $del = $("<button>").addClass("fp-history-delete red-ui-button red-ui-button-small")
                .attr("type", "button").attr("title", "Delete this conversation's saved transcript permanently")
                .append($("<i>").addClass("fa fa-trash"));
            $del.on("click", function (ev) {
                ev.stopPropagation();
                if (!window.confirm("Delete this conversation's saved transcript? This can't be undone.")) { return; }
                ajaxJson("DELETE", "flowpilot/conversations/" + encodeURIComponent(c.id), null, function () {
                    loadConversationList();
                });
            });
            $item.append($del);

            $list.append($item);
        });
    }

    // Switches to a past conversation: rebuilds conversationHistory and the
    // visible chat from its saved transcript, and continues using its
    // conversationId so new turns append to the same transcript file.
    function loadConversation(id) {
        ajaxJson("GET", "flowpilot/conversations/" + encodeURIComponent(id), null, function (data) {
            conversationId = id;
            try { sessionStorage.setItem("fp-conversation-id", id); } catch (e) { /* storage unavailable */ }

            conversationHistory = [];
            el("#fp-messages").empty();
            fpChatSnappedToBottom = true;
            (data.messages || []).forEach(function (m) {
                if (m.role !== "user" && m.role !== "assistant") { return; }
                conversationHistory.push({ role: m.role, content: String(m.content || "") });
                addMessage(m.role, m.content);
            });

            pinnedSelectionIds = null;
            updateSelectionStatus();
            showChat();
        });
    }

    // Recall — searches OTHER past conversations' transcripts for the
    // text currently in the prompt box, and shows matches in the chat for the
    // user to read/reference. Nothing is sent automatically; each result has
    // a "Use this" button that the user can click to add that exchange
    // to conversationHistory, so the model sees it on the next message.
    function recallSearch() {
        showChat();
        var $promptBox = el("#fp-prompt");
        var query = $promptBox.length ? $promptBox.val().trim() : "";
        if (!query) {
            addMessage("error", "Type what you're looking for, then click Recall.");
            return;
        }

        setBusy(true);
        showPending();
        ajaxJson("POST", "flowpilot/recall", { query: query, conversationId: conversationId }, function (data) {
            hidePending();
            renderRecallResults(data.results);
            setBusy(false);
        }, function (msg) {
            hidePending();
            addMessage("error", msg);
            setBusy(false);
        });
    }

    // Renders Recall's results as a special message — date/mode per match,
    // plus the user prompt and assistant reply that matched (truncated).
    function renderRecallResults(results) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }

        if (!results || results.length === 0) {
            addMessage("assistant", "No matching earlier conversations found.");
            return;
        }

        function truncate(text, max) {
            text = String(text || "");
            return text.length > max ? text.slice(0, max - 1) + "…" : text;
        }

        var $msg = $("<div>").addClass("fp-message fp-recall");
        $("<div>").addClass("fp-label").text("RECALLED").appendTo($msg);

        results.forEach(function (r) {
            var $item = $("<div>").addClass("fp-recall-item");
            var when = r.timestamp ? new Date(r.timestamp).toLocaleString() : "";
            var meta = when + (r.mode ? " · " + r.mode : "");
            $("<div>").addClass("fp-recall-meta").text(meta).appendTo($item);
            if (r.user) { $("<div>").addClass("fp-recall-text").text("You: " + truncate(r.user, 200)).appendTo($item); }
            if (r.assistant) { $("<div>").addClass("fp-recall-text").text("FlowPilot: " + truncate(r.assistant, 300)).appendTo($item); }

            var $use = $("<button>").addClass("fp-recall-use red-ui-button red-ui-button-small")
                .attr("type", "button").text("Use this");
            $use.on("click", function () {
                if (r.user) { conversationHistory.push({ role: "user", content: String(r.user) }); }
                if (r.assistant) { conversationHistory.push({ role: "assistant", content: String(r.assistant) }); }
                $use.prop("disabled", true).text("Added to context");
            });
            $item.append($use);

            $msg.append($item);
        });

        $box.append($msg);
        scrollMessagesToBottom();
    }

    // Debug log: shows the recent Debug-sidebar messages buffered via
    // RED.comms (most recent first), each with an "Attach" button — same
    // interaction as Recall's "Use this" (renderRecallResults above), per
    // the user's preference for that pattern. Attaching adds the entry to
    // attachedDebugMessages, which is merged into the next request(s)'
    // context by attachDebugContext().
    function showDebugMessages() {
        showChat();
        var $box = el("#fp-messages");
        if (!$box.length) { return; }

        if (!debugMessageBuffer.length) {
            addMessage("assistant", "No debug messages captured yet. Trigger a flow with a Debug node wired to the sidebar, then try again.");
            return;
        }

        var attachedIds = {};
        attachedDebugMessages.forEach(function (m) { attachedIds[m.id] = true; });

        var $msg = $("<div>").addClass("fp-message fp-recall");
        $("<div>").addClass("fp-label").text("DEBUG LOG").appendTo($msg);
        $("<div>").addClass("fp-debug-warning").text("Debug payloads can contain credentials from connected " +
            "systems. Common secret patterns are redacted automatically, but review before attaching.").appendTo($msg);

        // Oldest first, newest last — matches the chat panel's natural
        // top-to-bottom, auto-scroll-to-bottom behavior, so the most recent
        // message is immediately visible without scrolling up past everything
        // else. debugMessageBuffer is already append-ordered (oldest-first).
        debugMessageBuffer.slice().forEach(function (entry) {
            var $item = $("<div>").addClass("fp-recall-item");
            var when = new Date(entry.timestamp).toLocaleTimeString();
            var meta = when + " · " + entry.name + (entry.topic ? " · topic: " + entry.topic : "");
            $("<div>").addClass("fp-recall-meta").text(meta).appendTo($item);
            $("<div>").addClass("fp-recall-text").text(entry.previewValue).appendTo($item);

            var already = !!attachedIds[entry.id];
            var $use = $("<button>").addClass("fp-recall-use red-ui-button red-ui-button-small")
                .attr("type", "button")
                .prop("disabled", already)
                .text(already ? "Attached" : "Attach");
            $use.on("click", function () {
                attachedDebugMessages.push(entry);
                $use.prop("disabled", true).text("Attached");
                updateDebugStatus();
            });
            $item.append($use);

            $msg.append($item);
        });

        $box.append($msg);
        scrollMessagesToBottom();
    }

    // ---- Markdown rendering -----------------------------------------------
    // Chat bubbles render a small, safe subset of markdown. All text is
    // HTML-escaped before any tags are introduced, and only the fixed set of
    // tags this code itself emits ever reaches the DOM — raw HTML from the
    // model or the user is never interpreted, so no separate HTML sanitizer
    // (e.g. DOMPurify) is needed.
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    // Inline markdown within a single (already-escaped) line: `code`,
    // **bold**, *italic*, and [text](http(s) url) links. Code spans are
    // split out first so their contents are immune to further markup.
    function renderInlineMarkdown(escaped) {
        var parts = escaped.split(/(`[^`]+`)/);
        return parts.map(function (part, i) {
            if (i % 2 === 1) {
                return "<code>" + part.slice(1, -1) + "</code>";
            }
            return part
                .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
                .replace(/\*([^*]+)\*/g, "<em>$1</em>")
                .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        }).join("");
    }

    // Unique per-block id so the delegated copy-button handler (bound once,
    // see content.find("#fp-messages").on("click", ".fp-code-copy", ...))
    // can find the right <pre> — chat messages are injected as raw HTML
    // strings via .html(), so a per-element .on() bind at construction time
    // isn't possible here the way it is for the Generate review panel's
    // JSON-tab copy button.
    var nextCodeBlockId = 1;

    // GFM table helpers, used by renderMarkdown below.
    function isTableSeparatorRow(line) {
        var trimmed = line.trim();
        if (!trimmed) { return false; }
        return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(trimmed);
    }

    function splitTableRow(line) {
        var trimmed = line.trim();
        if (trimmed.charAt(0) === "|") { trimmed = trimmed.slice(1); }
        if (trimmed.charAt(trimmed.length - 1) === "|") { trimmed = trimmed.slice(0, -1); }
        return trimmed.split("|").map(function (c) { return c.trim(); });
    }

    // Block-level markdown: fenced code blocks, headings, tables,
    // bullet/numbered lists, and paragraphs (consecutive lines joined with
    // <br>).
    function renderMarkdown(raw) {
        var lines = String(raw || "").split("\n");
        var html = "";
        var listType = null;
        var paraLines = [];

        function flushPara() {
            if (paraLines.length) {
                html += "<p>" + paraLines.map(function (l) {
                    return renderInlineMarkdown(escapeHtml(l));
                }).join("<br>") + "</p>";
                paraLines = [];
            }
        }
        function closeList() {
            if (listType) { html += "</" + listType + ">"; listType = null; }
        }

        var i = 0;
        while (i < lines.length) {
            var line = lines[i];

            // Leading whitespace allowed: models commonly indent a fenced
            // block nested under a numbered/bulleted list item (e.g. "1. Try
            // this:\n   ```bash\n   curl ...\n   ```"). An anchored-at-column-0
            // regex misses that entirely, so the fence markers and everything
            // inside fall through to plain paragraph text instead of a code
            // block — exactly the "code blocks failed to load" bug.
            var fence = line.match(/^\s*```(\w*)\s*$/);
            if (fence) {
                flushPara(); closeList();
                var codeLines = [];
                i++;
                while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
                    codeLines.push(lines[i]);
                    i++;
                }
                var codeBlockId = "fp-code-" + (nextCodeBlockId++);
                html += "<div class=\"fp-code-toolbar\">" +
                    "<button class=\"fp-code-copy red-ui-button red-ui-button-small\" type=\"button\" data-code-id=\"" + codeBlockId + "\">Copy</button>" +
                    "</div>" +
                    "<pre id=\"" + codeBlockId + "\"><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>";
                i++;
                continue;
            }

            var heading = line.match(/^(#{1,6})\s+(.*)$/);
            if (heading) {
                flushPara(); closeList();
                var level = Math.min(6, heading[1].length + 2);
                html += "<h" + level + ">" + renderInlineMarkdown(escapeHtml(heading[2])) + "</h" + level + ">";
                i++;
                continue;
            }

            // GFM-style pipe table: a header row immediately followed by a
            // separator row (---/:--/--:), then zero or more body rows. Models
            // reach for tables constantly in comparison-style answers; without
            // this, every row just fell through to a paragraph line, showing
            // the raw "| a | b |" syntax verbatim.
            if (line.indexOf("|") !== -1 && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
                flushPara(); closeList();
                var headerCells = splitTableRow(line);
                i += 2;
                var bodyRows = [];
                while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") !== -1) {
                    bodyRows.push(splitTableRow(lines[i]));
                    i++;
                }
                html += "<table><thead><tr>" +
                    headerCells.map(function (c) {
                        return "<th>" + renderInlineMarkdown(escapeHtml(c)) + "</th>";
                    }).join("") +
                    "</tr></thead><tbody>" +
                    bodyRows.map(function (row) {
                        return "<tr>" + row.map(function (c) {
                            return "<td>" + renderInlineMarkdown(escapeHtml(c)) + "</td>";
                        }).join("") + "</tr>";
                    }).join("") +
                    "</tbody></table>";
                continue;
            }

            var bullet = line.match(/^\s*[-*]\s+(.*)$/);
            if (bullet) {
                flushPara();
                if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
                html += "<li>" + renderInlineMarkdown(escapeHtml(bullet[1])) + "</li>";
                i++;
                continue;
            }

            var numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
            if (numbered) {
                flushPara();
                if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
                html += "<li>" + renderInlineMarkdown(escapeHtml(numbered[1])) + "</li>";
                i++;
                continue;
            }

            flushPara(); closeList();

            if (line.trim()) { paraLines.push(line); }
            i++;
        }
        flushPara(); closeList();
        return html;
    }

    // ---- Messages -------------------------------------------------------

    // Whether the chat should auto-follow new content. Starts true (a fresh
    // chat is at the bottom); the #fp-messages "scroll" handler keeps this in
    // sync as the user scrolls. While "Cruising…"/streaming, repeated
    // scroll-to-bottom calls otherwise fight any attempt to scroll up to
    // re-read earlier messages.
    var fpChatSnappedToBottom = true;
    var FP_SCROLL_SNAP_PX = 24;

    // Scrolls #fp-messages to the bottom if the user is currently snapped
    // there (or if `force` — used when the user sends a new message, which
    // should always jump to the bottom and resume auto-follow).
    function scrollMessagesToBottom(force) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }
        if (force || fpChatSnappedToBottom) {
            $box.scrollTop($box[0].scrollHeight);
            fpChatSnappedToBottom = true;
        }
    }

    function addMessage(role, text) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }

        var label = role === "user" ? "YOU" : role === "error" ? "ERROR" : "FLOWPILOT";
        var cls = "fp-message" + (role === "user" ? " fp-user" : role === "error" ? " fp-error" : "");

        var $msg = $("<div>").addClass(cls);
        $("<div>").addClass("fp-label").text(label).appendTo($msg);
        $("<div>").addClass("fp-md").html(renderMarkdown(text || "")).appendTo($msg);

        $box.append($msg);
        // Sending a message always jumps to the bottom and resumes
        // auto-follow; an incoming message only follows if already snapped.
        scrollMessagesToBottom(role === "user");
    }

    // Pending "typing" indicator shown in the thread while awaiting a reply.
    // Lives where the answer will appear, so the eye is already there. Always
    // removed in both the success and error paths so it can't get stuck.
    // showStop adds a "Stop" button, used by the agent loop
    // (runAgentChat) so the user can interrupt a multi-step tool-call run.
    function showPending(showStop) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }
        // Guard against duplicates (e.g. fast double-send).
        $box.find("#fp-pending").remove();

        var $msg = $("<div>").addClass("fp-message").attr("id", "fp-pending");
        $("<div>").addClass("fp-label").text("FLOWPILOT").appendTo($msg);
        var $dots = $("<div>").addClass("fp-typing").attr("title", "Working…");
        $dots.append($("<span>"), $("<span>"), $("<span>"));
        $dots.append($("<span>").addClass("fp-typing-label").text("Cruising…"));
        if (showStop) {
            $dots.append($("<button>")
                .addClass("fp-agent-stop red-ui-button red-ui-button-small")
                .attr("type", "button")
                .text("Stop")
                .on("click", function () {
                    fpAgentStopRequested = true;
                    $(this).prop("disabled", true).text("Stopping…");
                }));
        }
        $msg.append($dots);

        $box.append($msg);
        scrollMessagesToBottom();
    }

    function hidePending() {
        el("#fp-messages").find("#fp-pending").remove();
    }

    // Updates the narration text shown in the pending indicator while the
    // agent loop runs (see runAgentChat / describeAgentToolCall).
    function setAgentNarration(text) {
        el("#fp-pending .fp-typing-label").text(text);
    }

    // Cost transparency for a completed agent-loop turn.
    // Appended just before the final response when at least one tool round
    // trip happened, so the user can see what exploration cost without
    // digging into the audit log.
    function addAgentStatsNote(steps, totalTokens) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }
        var text = "🔧 " + steps + " tool call step" + (steps === 1 ? "" : "s") +
            " · ~" + totalTokens.toLocaleString() + " tokens this turn";
        $("<div>").addClass("fp-consent-hint fp-agent-stats").text(text).appendTo($box);
        scrollMessagesToBottom();
    }

    // ---- Server communication -------------------------------------------
    // Note: no leading slash. Node-RED serves admin endpoints under a base
    // path (httpAdminRoot) that may not be "/". A relative URL respects it.

    // jQuery's $.ajax (used by ajaxJson) gets the admin-API auth token
    // attached automatically by Node-RED's editor via $.ajaxSetup, but raw
    // fetch() calls (used for SSE streaming below) do not. On instances with
    // adminAuth enabled, an unauthenticated fetch() gets a 401 even though
    // ajaxJson() calls (preflight, models, settings) succeed.
    function fetchHeaders() {
        var headers = { "Content-Type": "application/json" };
        var tokens = RED.settings.get("auth-tokens");
        if (tokens && tokens.access_token) {
            headers.Authorization = "Bearer " + tokens.access_token;
            headers["Node-RED-API-Version"] = "v2";
        }
        return headers;
    }

    // Every FlowPilot route is registered at an ABSOLUTE path under the
    // admin root (e.g. RED.httpAdmin.get("/flowpilot/settings", ...)). A
    // bare relative string like "flowpilot/settings" only resolves
    // correctly when the CURRENT PAGE happens to sit at the admin root
    // itself — true for the main editor, but NOT for the pop-out (served
    // from the nested /flowpilot/popout/view.html route), where the same
    // relative string resolves one level too deep
    // (/flowpilot/popout/flowpilot/settings) and 404s. Confirmed live:
    // loadSettings() failing in the pop-out with exactly that 404. Always
    // anchor to root instead, regardless of which page is calling.
    function flowpilotUrl(path) {
        return path.charAt(0) === "/" ? path : ("/" + path);
    }

    function ajaxJson(method, url, payload, onSuccess, onError) {
        $.ajax({
            url: flowpilotUrl(url),
            method: method,
            contentType: "application/json",
            data: payload ? JSON.stringify(payload) : undefined,
            success: onSuccess,
            error: function (xhr) {
                var msg = (xhr.responseJSON && xhr.responseJSON.error) ||
                          xhr.responseText || xhr.statusText || "Unknown error";
                if (onError) { onError(msg, xhr); }
                else { addMessage("error", msg); }
            }
        });
    }

    // ---- Settings -------------------------------------------------------

    // Helpers for the providers list living in currentSettings.
    function providersList() {
        return Array.isArray(currentSettings.providers) ? currentSettings.providers : [];
    }
    function activeProvider() {
        var list = providersList();
        if (!list.length) { return null; }
        var found = list.filter(function (p) { return p.id === currentSettings.activeProviderId; })[0];
        return found || list[0];
    }

    function renderProviderDropdown() {
        var $sel = el("#fp-provider-select");
        if (!$sel.length) { return; }
        $sel.empty();
        providersList().forEach(function (p) {
            $("<option>")
                .attr("value", p.id)
                .text(p.providerName + (p.model ? (" / " + p.model) : " (no model)"))
                .appendTo($sel);
        });
        var active = activeProvider();
        if (active) { $sel.val(active.id); }
    }

    // Write the form fields from a given provider profile.
    function fillProviderFields(p) {
        p = p || {};
        el("#fp-provider-name").val(p.providerName || "");
        el("#fp-base-url").val(p.baseUrl || "");
        el("#fp-api-key").val(p.apiKey || "");
        el("#fp-model").val(p.model || "");
        el("#fp-temperature").val(p.temperature !== undefined ? p.temperature : 0.2);
        // Test provider is disabled until this provider has a model.
        el("#fp-test-provider").prop("disabled", !(p.model && String(p.model).trim()));
    }

    // Short descriptive band shown under the Personality slider, matching
    // the reference points lib/persona-prompt.js gives the model.
    function personaLabelFor(n) {
        n = Number(n);
        if (n <= 1) { return "Plain engineer — no aviation language at all."; }
        if (n <= 4) { return "Subtle co-pilot (default) — light, occasional flavor."; }
        if (n <= 7) { return "Noticeable captain energy — more frequent, more colorful."; }
        if (n <= 9) { return "Heavy captain energy — leans hard into the bit."; }
        return "Full captain — comically over-the-top.";
    }

    function updatePersonaLabel() {
        var n = el("#fp-persona-intensity").val();
        el("#fp-persona-value").text(n);
        el("#fp-persona-label").text(personaLabelFor(n));
    }

    function fillSettings(settings) {
        settings = settings || {};
        currentSettings = settings;

        renderProviderDropdown();
        fillProviderFields(activeProvider());

        el("#fp-system-prompt").val(settings.systemPrompt || "");
        el("#fp-persona-intensity").val(settings.personaIntensity !== undefined ? settings.personaIntensity : 3);
        updatePersonaLabel();
        el("#fp-warn-tokens").val(settings.contextWarnTokens || 4000);
        el("#fp-high-tokens").val(settings.contextHighTokens || 8000);
        el("#fp-history-max").val(settings.historyMaxExchanges !== undefined ? settings.historyMaxExchanges : 10);
        el("#fp-streaming-enabled").prop("checked", !!settings.streamingEnabled);
        el("#fp-request-timeout").val(Math.round((settings.requestTimeoutMs !== undefined ? settings.requestTimeoutMs : 180000) / 1000));
        el("#fp-agent-loop-max-iterations").val(settings.agentLoopMaxIterations !== undefined ? settings.agentLoopMaxIterations : 5);
        el("#fp-suppress-warnings").prop("checked", !!settings.suppressContextWarnings);
        el("#fp-redaction-disabled").prop("checked", settings.redactionEnabled === false);

        // The dev/test banner is part of the warning set the user can silence
        // via the type-to-confirm acknowledgement.
        if (settings.suppressContextWarnings) {
            el("#fp-dev-banner").addClass("fp-hidden");
        } else {
            el("#fp-dev-banner").removeClass("fp-hidden");
        }

        // Custom intents may have changed; rebuild buttons and the editor list.
        renderIntents(el("#fp-intents"));
        renderCustomIntentList();

        var ap = activeProvider();
        var providerText = (ap && ap.model)
            ? (ap.providerName + " / " + ap.model)
            : ((ap ? ap.providerName : "Provider") + ": model not configured");
        el("#fp-provider-status").text("Provider: " + providerText);

        // Anchor point for "no changes to save" detection — this is the form
        // state as of the last successful load/save.
        savedSettingsSnapshot = JSON.stringify(collectSettings());
    }

    // Shows a short-lived status message next to the Save settings button.
    // Only used for that explicit, user-initiated action — the many internal
    // saveSettings() calls (Pre-flight check, Refresh models, custom intent
    // add/remove) have their own dedicated feedback elsewhere and would just
    // add noise here.
    function showSaveStatus(text, isError) {
        var $status = el("#fp-save-status");
        clearTimeout(saveStatusTimer);
        $status.text(text).toggleClass("fp-save-status-error", !!isError).removeClass("fp-hidden");
        saveStatusTimer = setTimeout(function () {
            $status.addClass("fp-hidden");
        }, 4000);
    }

    // Read the form's provider fields back into the active provider profile.
    function captureProviderFields() {
        var list = providersList();
        var ap = activeProvider();
        if (!ap) { return; }
        ap.providerName = el("#fp-provider-name").val() || "Provider";
        ap.baseUrl = el("#fp-base-url").val() || "";
        ap.apiKey = el("#fp-api-key").val() || "";
        ap.model = el("#fp-model").val() || "";
        ap.temperature = Number(el("#fp-temperature").val() || 0.2);
        currentSettings.providers = list;
    }

    function collectSettings() {
        // Only honour the suppression toggle if the confirmation phrase was
        // typed exactly. Otherwise warnings stay on regardless of the checkbox.
        var wantSuppress = el("#fp-suppress-warnings").prop("checked");
        var typed = (el("#fp-suppress-confirm").val() || "").trim();
        var suppress = wantSuppress && typed === "I understand the risk";

        // Same type-to-confirm gate as suppressContextWarnings above, and for
        // the same reason: the confirm box is never pre-filled from settings,
        // so disabling redaction stays off unless re-confirmed on every save —
        // "off-able, not off-by-accident".
        var wantRedactionOff = el("#fp-redaction-disabled").prop("checked");
        var redactionTyped = (el("#fp-redaction-confirm").val() || "").trim();
        var redactionEnabled = !(wantRedactionOff && redactionTyped === "disable redaction");

        // Fold the form's provider fields back into the active profile first.
        captureProviderFields();

        var historyMax = Number(el("#fp-history-max").val());
        if (!isFinite(historyMax) || historyMax < 0) { historyMax = 10; }

        var requestTimeoutSec = Number(el("#fp-request-timeout").val());
        if (!isFinite(requestTimeoutSec) || requestTimeoutSec < 5) { requestTimeoutSec = 180; }

        var personaIntensity = Number(el("#fp-persona-intensity").val());
        if (!isFinite(personaIntensity) || personaIntensity < 1 || personaIntensity > 10) { personaIntensity = 3; }

        var agentLoopMaxIterations = Number(el("#fp-agent-loop-max-iterations").val());
        if (!isFinite(agentLoopMaxIterations) || agentLoopMaxIterations < 1) { agentLoopMaxIterations = 5; }

        return {
            providers: providersList(),
            activeProviderId: currentSettings.activeProviderId,
            systemPrompt: el("#fp-system-prompt").val(),
            personaIntensity: personaIntensity,
            contextWarnTokens: Number(el("#fp-warn-tokens").val() || 4000),
            contextHighTokens: Number(el("#fp-high-tokens").val() || 8000),
            historyMaxExchanges: historyMax,
            streamingEnabled: el("#fp-streaming-enabled").prop("checked"),
            requestTimeoutMs: Math.round(requestTimeoutSec * 1000),
            agentLoopMaxIterations: agentLoopMaxIterations,
            suppressContextWarnings: suppress,
            redactionEnabled: redactionEnabled,
            customIntents: Array.isArray(currentSettings.customIntents)
                ? currentSettings.customIntents : []
        };
    }

    // Switch which provider the form edits. Captures the current form into the
    // outgoing provider first, so unsaved edits aren't lost when switching.
    function switchProvider(newId) {
        captureProviderFields();
        currentSettings.activeProviderId = newId;
        fillProviderFields(activeProvider());
    }

    function addProvider() {
        captureProviderFields();
        var list = providersList();
        // Generate a unique default name so adding several doesn't immediately
        // collide (the save-time check enforces uniqueness, but this avoids the
        // obvious "New provider" / "New provider" clash up front).
        var base = "New provider";
        var name = base;
        var n = 1;
        var taken = {};
        list.forEach(function (p) {
            taken[String(p.providerName || "").trim().toLowerCase()] = true;
        });
        while (taken[name.toLowerCase()]) { n += 1; name = base + " " + n; }

        var id = "p" + Date.now().toString(36);
        list.push({
            id: id,
            providerName: name,
            baseUrl: "http://localhost:8080",
            apiKey: "",
            model: "",
            temperature: 0.2
        });
        currentSettings.providers = list;
        currentSettings.activeProviderId = id;
        renderProviderDropdown();
        fillProviderFields(activeProvider());
    }

    function removeProvider() {
        var list = providersList();
        if (list.length <= 1) {
            addMessage("error", "At least one provider is required.");
            return;
        }
        var ap = activeProvider();
        currentSettings.providers = list.filter(function (p) { return p.id !== ap.id; });
        currentSettings.activeProviderId = currentSettings.providers[0].id;
        renderProviderDropdown();
        fillProviderFields(activeProvider());
    }

    // Replace the System Prompt textarea with FlowPilot's current built-in
    // default. Settings.json can carry a snapshot saved by an older version
    // that predates newer instructions (chips, clarifying questions, etc.) —
    // this lets the user pick up those updates without losing the ability to
    // customize the prompt afterwards. Not saved until the user clicks Save.
    function resetSystemPrompt() {
        if (!window.confirm("Replace the System Prompt text with FlowPilot's current default? This discards any customizations in the box until you save.")) {
            return;
        }
        ajaxJson("GET", "flowpilot/default-system-prompt", null, function (data) {
            el("#fp-system-prompt").val(data.systemPrompt || "");
            addMessage("assistant", "System prompt reset to the current default. Click Save Settings to apply.");
        }, function (msg) {
            addMessage("error", "Unable to load the default system prompt: " + msg);
        });
    }

    // Models dropdown: populate #fp-model-options from a /flowpilot/models
    // result, and show a hint explaining what happened. #fp-model stays
    // free-text (list="fp-model-options") — providers that don't implement
    // /v1/models (or return nothing useful) just leave the field as-is.
    function populateModelOptions(models, error) {
        var $list = el("#fp-model-options");
        $list.empty();
        (models || []).forEach(function (m) {
            $("<option>").attr("value", m).appendTo($list);
        });
        var $hint = el("#fp-models-hint").removeClass("fp-hidden");
        if (error) {
            $hint.text("Couldn't load model list: " + error + ". You can still type a model name manually.");
        } else if (!models || !models.length) {
            $hint.text("Provider returned no models. You can still type a model name manually.");
        } else {
            $hint.text(models.length + " model(s) loaded — pick from the dropdown or type your own.");
        }
    }

    // Refresh models: save the form first (like Pre-flight check, so the
    // backend queries the provider the user is looking at), then fetch
    // GET /v1/models via the backend and populate the datalist.
    function refreshModels() {
        saveSettings(function () {
            var $btn = el("#fp-refresh-models");
            $btn.prop("disabled", true);
            ajaxJson("POST", "flowpilot/models", {}, function (data) {
                $btn.prop("disabled", false);
                populateModelOptions(data.models, data.error);
            }, function (msg) {
                $btn.prop("disabled", false);
                populateModelOptions([], msg);
            });
        });
    }

    // Test provider: switch to chat, fill the test prompt, and send it.
    function testProvider() {
        // Make sure the active provider reflects unsaved form edits, then save
        // so the backend tests what the user sees, then run the test.
        saveSettings(function () {
            showChat();
            send("test", "Say hello from FlowPilot. Keep it brief.");
        });
    }

    function loadSettings() {
        ajaxJson("GET", "flowpilot/settings", null, function (data) {
            fillSettings(data);
            maybeShowFirstRun(data);
            updateSelectionStatus();
        }, function (msg) {
            addMessage("error", "Unable to load FlowPilot settings: " + msg);
            el("#fp-provider-status").text("Provider: settings load failed");
        });
    }

    // `announce` is true only for the explicit Save settings button — the
    // many internal callers (Pre-flight check, Refresh models, custom intent
    // add/remove) save as a side effect of some other action and already
    // have their own feedback, so they stay silent here.
    function saveSettings(callback, announce) {
        var payload = collectSettings();
        var list = payload.providers || [];

        // Validation 1: every provider needs a base URL (the one field a
        // provider cannot function without).
        var noUrl = list.filter(function (p) {
            return !p.baseUrl || !String(p.baseUrl).trim();
        });
        if (noUrl.length) {
            var urlNames = noUrl.map(function (p) { return p.providerName || "(unnamed)"; }).join(", ");
            var noUrlMsg = "Cannot save: these provider(s) need a Base URL: " + urlNames + ".";
            addMessage("error", noUrlMsg);
            if (announce) { showSaveStatus(noUrlMsg, true); }
            showSettings();
            return;
        }

        // Validation 2: provider names must be present and unique. Name is the
        // identity of a provider — base URL / model / key may all legitimately
        // repeat (e.g. same endpoint, different billing key), so the name is
        // what must distinguish them.
        var blankName = list.filter(function (p) {
            return !p.providerName || !String(p.providerName).trim();
        });
        if (blankName.length) {
            var blankNameMsg = "Cannot save: every provider needs a name.";
            addMessage("error", blankNameMsg);
            if (announce) { showSaveStatus(blankNameMsg, true); }
            showSettings();
            return;
        }
        var seen = {};
        var dupes = [];
        list.forEach(function (p) {
            var key = String(p.providerName).trim().toLowerCase();
            if (seen[key]) {
                if (dupes.indexOf(p.providerName) === -1) { dupes.push(p.providerName); }
            }
            seen[key] = true;
        });
        if (dupes.length) {
            var dupesMsg = "Cannot save: provider names must be unique. Duplicate: " + dupes.join(", ") + ".";
            addMessage("error", dupesMsg);
            if (announce) { showSaveStatus(dupesMsg, true); }
            showSettings();
            return;
        }

        // Nothing changed since the last load/save — skip the round trip.
        if (announce && savedSettingsSnapshot !== null && JSON.stringify(payload) === savedSettingsSnapshot) {
            showSaveStatus("No changes to save.");
            if (callback) { callback(); }
            return;
        }

        ajaxJson("POST", "flowpilot/settings", payload, function (data) {
            fillSettings(data);
            addMessage("assistant", "Settings saved.");
            if (announce) { showSaveStatus("Settings saved."); }
            updateSelectionStatus();
            if (callback) { callback(); }
        }, function (msg) {
            addMessage("error", "Unable to save FlowPilot settings: " + msg);
            if (announce) { showSaveStatus("Unable to save: " + msg, true); }
        });
    }

    // ---- Selection context -------------------------------------------------
    // We read the user's current node selection and build a SANITIZED copy to
    // send to the AI. Two reasons we never send raw nodes:
    //   1. Node objects are proxies carrying editor-internal fields (geometry,
    //      validation state, i18n functions) that waste tokens and mean nothing
    //      to the model.
    //   2. Config nodes can hold secrets (broker passwords, API keys). We drop
    //      anything whose field name looks secret-bearing.
    // The user only ever sees how many nodes are attached, and nothing is sent
    // unless they have an active selection — staying within "user-initiated"
    // and "complete visibility".

    var INTERNAL_FIELDS = {
        _def: 1, _: 1, changed: 1, moved: 1, dirty: 1, selected: 1, valid: 1,
        validationErrors: 1, _index: 1, resize: 1, x: 1, y: 1, w: 1, h: 1, l: 1,
        __outputs: 1, inputs: 1, outputs: 1, g: 1, _config: 1, _orig: 1,
        credentials: 1
    };

    function sanitizeNode(n) {
        var out = {};
        Object.keys(n).forEach(function (k) {
            if (INTERNAL_FIELDS[k]) { return; }
            var v = n[k];
            if (typeof v === "function") { return; }
            // A secret-shaped field NAME (password/token/apikey/auth/...) only
            // means "redact" when the value is itself a string long enough to
            // plausibly BE a secret. Short strings under such names are usually
            // enum/selector fields (e.g. an HTTP request node's authType:
            // "basic"/"bearer"/"digest"/"") — hiding those gives the model no
            // way to reason about (or fix) auth configuration while protecting
            // nothing. Real credential VALUES are already excluded entirely via
            // INTERNAL_FIELDS.credentials.
            if (currentSettings.redactionEnabled !== false &&
                    SECRET_KEY.test(k) && typeof v === "string" && v.length > SECRET_NAME_MIN_LEN) {
                out[k] = "[redacted: secret field, " + v.length + " chars]";
                return;
            }
            // JSON round-trip strips the proxy wrapper and drops anything
            // non-serializable, leaving plain config values (incl. props).
            try { v = JSON.parse(JSON.stringify(v)); }
            catch (e) { out[k] = "[unserializable]"; return; }
            // Defense-in-depth: catch secrets hiding in objects/arrays under a
            // secret-shaped name (recurses and redacts only the actual secret
            // sub-fields), or in an innocuously-named field by value shape
            // (e.g. a "data" field holding a JWT).
            out[k] = redactDebugValue(v, k);
        });
        // "g" itself (the bare group id) is skipped above like x/y/w/h —
        // meaningless to the model on its own. But WHICH group a node
        // belongs to, and that group's name, is real semantic information
        // (Phase 8.5 C2) — resolve it via RED.nodes.group(), one level
        // deep only (a node's immediate group, not its ancestor chain if
        // nested groups are in play). Distinct from buildConnections()'s
        // "subFlow" numbering below, which is connectivity-based ("are
        // these wired together"), not an actual visual group.
        if (n.g && RED.nodes.group) {
            var grp = RED.nodes.group(n.g);
            if (grp) { out.group = { id: grp.id, name: grp.name || "" }; }
        }
        return out;
    }

    // Build readable connections from the editor's LIVE wiring model.
    // Important: in the editor, node.wires is NOT populated — that's an
    // export-time artifact. Live wiring lives as separate link objects, which
    // RED.view.selection() hands us in sel.links. Each link is already an
    // explicit edge: { source: <node>, sourcePort: <int>, target: <node> }.
    // This handles multi-output and multi-input naturally — each is just
    // another link object.
    function nodeLabel(n) {
        if (!n) { return "(unknown node)"; }
        var nm = (n.name && n.name.length) ? n.name : "(unnamed)";
        return nm + " [" + n.type + "]";
    }

    function buildConnections(nodes, links) {
        var selectedIds = nodes.map(function (n) { return n.id; });
        links = Array.isArray(links) ? links : [];

        var edges = links.map(function (l) {
            var srcId = l.source && l.source.id;
            var tgtId = l.target && l.target.id;
            return {
                fromId: srcId,
                from: nodeLabel(l.source),
                fromPort: (typeof l.sourcePort === "number") ? l.sourcePort : 0,
                toId: tgtId,
                to: nodeLabel(l.target),
                sourceInSelection: selectedIds.indexOf(srcId) !== -1,
                targetInSelection: selectedIds.indexOf(tgtId) !== -1
            };
        });

        // Group selected nodes into connected sub-flows (undirected connected
        // components over the links). This turns "are these separate flows?"
        // from a reasoning task into a lookup for the model. Two nodes share a
        // group if a link connects them either way; an unlinked selected node
        // forms its own group.
        var parent = {};
        nodes.forEach(function (n) { parent[n.id] = n.id; });
        function find(x) {
            while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        }
        edges.forEach(function (e) {
            if (parent[e.fromId] === undefined || parent[e.toId] === undefined) { return; }
            parent[find(e.fromId)] = find(e.toId);
        });
        var rootToGroup = {};
        var nextGroup = 1;
        var groupOf = {};
        nodes.forEach(function (n) {
            var r = find(n.id);
            if (rootToGroup[r] === undefined) { rootToGroup[r] = nextGroup++; }
            groupOf[n.id] = rootToGroup[r];
        });
        var subFlowCount = nextGroup - 1;

        // Per-node summary of inputs and outputs, reconstructed from edges so
        // multi-input nodes are legible without the model cross-referencing.
        // Each node is tagged with its sub-flow group.
        var perNode = nodes.map(function (n) {
            var outs = edges.filter(function (e) { return e.fromId === n.id; })
                            .map(function (e) { return "port " + e.fromPort + " -> " + e.to; });
            var ins = edges.filter(function (e) { return e.toId === n.id; })
                           .map(function (e) { return e.from + " (port " + e.fromPort + ")"; });
            return { node: nodeLabel(n), subFlow: groupOf[n.id], inputs: ins, outputs: outs };
        });

        // B4: "edges" and "perNode" otherwise duplicate the same from/to
        // labels — perNode already carries the readable "Name [type]" labels,
        // so trim edges down to ids + port + selection flags (the part
        // perNode doesn't have) to avoid sending the same labels twice.
        var compactEdges = edges.map(function (e) {
            return {
                fromId: e.fromId,
                fromPort: e.fromPort,
                toId: e.toId,
                sourceInSelection: e.sourceInSelection,
                targetInSelection: e.targetInSelection
            };
        });

        return { edges: compactEdges, perNode: perNode, subFlowCount: subFlowCount };
    }

    // Returns { nodes, connections } or null if nothing selected.
    // With nodeIds (an array of node ids — e.g. a pinned selection),
    // builds context from those live nodes via RED.nodes instead of the
    // current view selection. Nodes that no longer exist are dropped; links
    // are gathered from the workspace's full link list, same shape as
    // RED.view.selection().links (sourceInSelection/targetInSelection in
    // buildConnections still works against this nodeIds set).
    // Gathers every link touching any node in the given list, scanning the
    // workspace's full link set directly rather than trusting
    // RED.view.selection().links — needed whenever the node list didn't
    // come from a literal click-drag selection (an explicit nodeIds array,
    // or a group's expanded membership, whose internal wiring was never
    // part of any selection.links to begin with).
    function linksTouchingNodes(nodes) {
        var idSet = nodes.map(function (n) { return n.id; });
        var links = [];
        if (RED.nodes.eachLink) {
            RED.nodes.eachLink(function (l) {
                var srcId = l.source && l.source.id;
                var tgtId = l.target && l.target.id;
                if (idSet.indexOf(srcId) !== -1 || idSet.indexOf(tgtId) !== -1) {
                    links.push(l);
                }
            });
        }
        return links;
    }

    function collectSelectionContext(nodeIds) {
        var rawNodes, rawLinks;
        if (Array.isArray(nodeIds)) {
            rawNodes = nodeIds.map(function (id) { return RED.nodes.node(id); })
                              .filter(function (n) { return !!n; });
            if (!rawNodes.length) { return null; }
            rawLinks = linksTouchingNodes(rawNodes);
        } else {
            var sel = (RED.view && RED.view.selection) ? RED.view.selection() : null;
            var expandedSel = expandGroupSelection((sel && sel.nodes) ? sel.nodes : []);
            rawNodes = expandedSel.nodes;
            if (!rawNodes.length) { return null; }
            // A literal click-drag selection's sel.links already has the
            // right shape — but it never reflects a SELECTED GROUP's
            // internal wiring (those nodes were never individually
            // selected), so gather links directly whenever a group was
            // part of the selection instead of trusting sel.links.
            rawLinks = expandedSel.groupCount > 0
                ? linksTouchingNodes(rawNodes)
                : ((sel && sel.links) ? sel.links : []);
        }
        return {
            nodes: rawNodes.map(sanitizeNode),
            connections: buildConnections(rawNodes, rawLinks)
        };
    }

    // ---- Tier-1 read tools ---------------------------------------------
    // Executed CLIENT-SIDE against RED.nodes (the only place this data
    // lives) when the model calls a tool during runAgentChat()'s loop.
    // Results pass through sanitizeNode(), same as selection context, so a
    // tool result can never carry a raw secret.

    function executeReadNodeTool(args) {
        args = args || {};
        var node = null;
        if (args.id) { node = RED.nodes.node(args.id); }
        if (!node && args.name) {
            RED.nodes.eachNode(function (n) {
                if (!node && n.name === args.name) { node = n; }
            });
        }
        if (!node) {
            return { error: "No node found matching " + JSON.stringify(args) + "." };
        }
        return sanitizeNode(node);
    }

    function executeListFlowsTool() {
        var flows = [];
        var counts = {};
        RED.nodes.eachNode(function (n) {
            counts[n.z] = (counts[n.z] || 0) + 1;
        });
        RED.nodes.eachWorkspace(function (ws) {
            flows.push({
                id: ws.id,
                label: ws.label,
                type: "tab",
                disabled: !!ws.disabled,
                nodeCount: counts[ws.id] || 0
            });
        });
        // Subflow definitions live in their own tabs ("[Subflow] <name>" in
        // the editor) and are NOT included in eachWorkspace — list them
        // separately so a subflow can be found by name/id without the model
        // having to guess it exists.
        if (RED.nodes.eachSubflow) {
            RED.nodes.eachSubflow(function (sf) {
                flows.push({
                    id: sf.id,
                    label: "[Subflow] " + (sf.name || sf.id),
                    type: "subflow",
                    nodeCount: counts[sf.id] || 0,
                    inputs: (sf.in || []).length,
                    outputs: (sf.out || []).length
                });
            });
        }
        return { flows: flows };
    }

    var SEARCH_FLOW_MAX_RESULTS = 50;

    function executeSearchFlowTool(args) {
        args = args || {};
        var query = args.query ? String(args.query).toLowerCase() : "";
        var typeFilter = args.type ? String(args.type).toLowerCase() : "";
        var flowFilter = args.flowId || "";
        var results = [];
        var truncated = false;

        function pushResult(entry) {
            if (results.length >= SEARCH_FLOW_MAX_RESULTS) { truncated = true; return; }
            results.push(entry);
        }

        // Subflow definitions behave like named "flows" but aren't nodes
        // themselves — match them by name so e.g. "the Dad joke subflow" can
        // be found even though no individual node is named "Dad joke".
        if (!flowFilter && !typeFilter && RED.nodes.eachSubflow) {
            RED.nodes.eachSubflow(function (sf) {
                var name = String(sf.name || "").toLowerCase();
                if (query && name.indexOf(query) === -1) { return; }
                pushResult({ id: sf.id, name: sf.name || "", type: "subflow", flowId: null });
            });
        }

        RED.nodes.eachNode(function (n) {
            if (flowFilter && n.z !== flowFilter) { return; }
            var type = String(n.type || "").toLowerCase();
            if (typeFilter && type.indexOf(typeFilter) === -1) { return; }
            var name = String(n.name || "").toLowerCase();
            // Subflow-instance nodes (type "subflow:<id>") often have no
            // name of their own; fall back to the referenced subflow's name
            // so the instance can be found by that name too.
            if (!name && type.indexOf("subflow:") === 0 && RED.nodes.subflow) {
                var sf = RED.nodes.subflow(n.type.slice("subflow:".length));
                if (sf && sf.name) { name = String(sf.name).toLowerCase(); }
            }
            if (query && name.indexOf(query) === -1 && type.indexOf(query) === -1) { return; }
            pushResult({ id: n.id, name: n.name || "", type: n.type, flowId: n.z });
        });

        var out = { results: results };
        if (truncated) {
            out.truncated = true;
            out.note = "Results truncated at " + SEARCH_FLOW_MAX_RESULTS + ". Narrow the search with " +
                "a more specific query, type, or flowId.";
        }
        return out;
    }

    function executeGetConnectionsTool(args) {
        args = args || {};
        var nodes, links;

        if (args.id) {
            var node = RED.nodes.node(args.id);
            if (!node) { return { error: "No node found for id " + args.id + "." }; }
            nodes = [node];
            links = [];
            if (RED.nodes.eachLink) {
                RED.nodes.eachLink(function (l) {
                    var srcId = l.source && l.source.id;
                    var tgtId = l.target && l.target.id;
                    if (srcId === node.id || tgtId === node.id) { links.push(l); }
                });
            }
            return buildConnections(nodes, links);
        }

        var sel = (RED.view && RED.view.selection) ? RED.view.selection() : null;
        if (sel && sel.nodes && sel.nodes.length) {
            return buildConnections(sel.nodes, sel.links || []);
        }

        // Nothing selected and no id given: describe the whole active flow tab.
        var activeId = RED.workspaces && RED.workspaces.active ? RED.workspaces.active() : null;
        nodes = [];
        RED.nodes.eachNode(function (n) { if (n.z === activeId) { nodes.push(n); } });
        var ids = nodes.map(function (n) { return n.id; });
        links = [];
        if (RED.nodes.eachLink) {
            RED.nodes.eachLink(function (l) {
                var srcId = l.source && l.source.id;
                var tgtId = l.target && l.target.id;
                if (ids.indexOf(srcId) !== -1 || ids.indexOf(tgtId) !== -1) { links.push(l); }
            });
        }
        return buildConnections(nodes, links);
    }

    var READ_DEBUG_DEFAULT_LIMIT = 10;
    var READ_DEBUG_MAX_LIMIT = 50;

    function executeReadDebugTool(args) {
        args = args || {};
        var limit = parseInt(args.limit, 10);
        if (!limit || limit < 1) { limit = READ_DEBUG_DEFAULT_LIMIT; }
        limit = Math.min(limit, READ_DEBUG_MAX_LIMIT);
        return {
            messages: debugMessageBuffer.slice(-limit).slice().reverse(),
            totalBuffered: debugMessageBuffer.length
        };
    }

    function executeGetSelectionTool() {
        var context = collectSelectionContext();
        if (!context) {
            return { selected: false, message: "Nothing is currently selected in the editor." };
        }
        return Object.assign({ selected: true }, context);
    }

    // Per-step narration: a short human-readable description of what a tool
    // call is about to do, shown in the pending indicator (see runAgentChat).
    function describeAgentToolCall(name, args) {
        args = args || {};
        switch (name) {
            case "read_node":
                return "Reading node " + JSON.stringify(args.name || args.id || "?") + "…";
            case "list_flows":
                return "Listing flows…";
            case "search_flow":
                return "Searching the flow" + (args.query ? " for " + JSON.stringify(args.query) : "") + "…";
            case "get_connections":
                return "Checking connections…";
            case "read_debug":
                return "Checking the debug log…";
            case "get_selection":
                return "Checking the current selection…";
            default:
                return "Running " + (name || "a tool") + "…";
        }
    }

    // Shared by executeAgentToolCall (execution) and runAgentChat
    // (narration). Malformed/missing arguments fall back to {} so the tool
    // can still run and report what it can't find, rather than erroring.
    function parseToolCallArgs(call) {
        try { return JSON.parse((call.function && call.function.arguments) || "{}"); }
        catch (e) { return {}; }
    }

    function executeAgentToolCall(call) {
        var name = call && call.function && call.function.name;
        var args = parseToolCallArgs(call);
        switch (name) {
            case "read_node":
                return executeReadNodeTool(args);
            case "list_flows":
                return executeListFlowsTool();
            case "search_flow":
                return executeSearchFlowTool(args);
            case "get_connections":
                return executeGetConnectionsTool(args);
            case "read_debug":
                return executeReadDebugTool(args);
            case "get_selection":
                return executeGetSelectionTool();
            default:
                return { error: "Unknown tool: " + name };
        }
    }

    // Rough token estimate. ~4 chars per token is the standard cheap
    // approximation; good enough for an advisory size warning. We measure the
    // serialized context (nodes + connections) exactly as it will be sent.
    function estimateTokens(context) {
        if (!context) { return 0; }
        var chars = 0;
        try { chars = JSON.stringify(context).length; } catch (e) { chars = 0; }
        return Math.ceil(chars / 4);
    }

    // Live indicator so the user knows what will be sent BEFORE they hit Send.
    // Driven by the "view:selection-changed" editor event. Shows three things:
    // the selection count, a size estimate with advisory tier, and a standing
    // secrets reminder (unless the user has suppressed it in settings).
    function updateSelectionStatus() {
        var $status = el("#fp-selection-status");
        if (!$status.length) { return; }

        var sel = (RED.view && RED.view.selection) ? RED.view.selection() : null;
        var expandedSel = expandGroupSelection((sel && sel.nodes) ? sel.nodes : []);
        var liveCount = expandedSel.nodes.length;
        var liveGroupCount = expandedSel.groupCount;

        var $size = el("#fp-size-status");
        var $secrets = el("#fp-secrets-status");

        // While armed, a pinned selection is sent as context even with
        // nothing currently selected — re-resolve against live nodes so
        // deleted nodes drop out of the count.
        var pinnedContext = (armedExecuteAction && liveCount === 0 && pinnedSelectionIds)
            ? collectSelectionContext(pinnedSelectionIds) : null;
        var pinnedCount = pinnedContext ? pinnedContext.nodes.length : 0;
        var count = liveCount || pinnedCount;

        // pinnedSelectionIds is already flattened to real node ids (see
        // pinCurrentSelection/expandGroupSelection) — group membership
        // isn't tracked once pinned, so the group count only ever applies
        // to a CURRENTLY live selection, not a pinned fallback one.
        var groupNote = liveCount > 0 && liveGroupCount > 0
            ? (", " + liveGroupCount + " group" + (liveGroupCount === 1 ? "" : "s"))
            : "";

        if (count === 0) {
            $status.text("No nodes selected").removeClass("fp-has-selection");
        } else if (liveCount === 0 && pinnedCount > 0) {
            var actionLabel = armedExecuteAction === "generate" ? "Generate"
                : armedExecuteAction === "document" ? "Document"
                : armedExecuteAction === "modify" ? "Modify"
                : armedExecuteAction === "build" ? "Build" : "Execute";
            $status.text("Pinned: " + count + (count === 1 ? " node" : " nodes") +
                         " for " + actionLabel + " — will be sent as context")
                   .addClass("fp-has-selection");
        } else {
            $status.text(count + (count === 1 ? " node" : " nodes") + groupNote +
                         " selected — will be sent as context")
                   .addClass("fp-has-selection");
        }

        el("#fp-preview-nodes").toggleClass("fp-hidden", count === 0);

        // Size line: selection context + attached debug messages +
        // conversation history.
        var contextTokens = liveCount > 0 ? estimateTokens(collectSelectionContext())
            : pinnedContext ? estimateTokens(pinnedContext) : 0;
        var debugTokens = attachedDebugMessages.length ? estimateTokens(buildDebugMessagesForSend()) : 0;
        var historyPayload = buildHistoryPayload();
        var historyTokens = estimateTokens(historyPayload.messages);
        var tokens = contextTokens + debugTokens + historyTokens;

        if (tokens === 0) {
            $size.text("").addClass("fp-hidden");
        } else {
            var warnAt = Number(currentSettings.contextWarnTokens) || 4000;
            var highAt = Number(currentSettings.contextHighTokens) || 8000;

            var parts = [];
            if (contextTokens) { parts.push("context ~" + contextTokens.toLocaleString()); }
            if (debugTokens) { parts.push("debug ~" + debugTokens.toLocaleString()); }
            if (historyTokens) {
                parts.push("history ~" + historyTokens.toLocaleString() +
                    (historyPayload.truncated ? " (earlier messages omitted)" : ""));
            }
            var sizeText = "~" + tokens.toLocaleString() + " tokens" +
                (parts.length ? " (" + parts.join(", ") + ")" : "");

            $size.removeClass("fp-hidden fp-size-warn fp-size-high");
            if (tokens >= highAt) {
                $size.text(sizeText + " — large; may exceed smaller local models. " +
                           "Consider selecting fewer nodes, clearing chat history, or splitting your request.")
                     .addClass("fp-size-high");
            } else if (tokens >= warnAt) {
                $size.text(sizeText + " — getting large; consider selecting fewer nodes or clearing chat history.")
                     .addClass("fp-size-warn");
            } else {
                $size.text(sizeText);
            }
        }

        // Secrets reminder (suppressible) — only relevant when a selection is
        // attached as context. When redaction is actually OFF, this can't be
        // suppressed and gets a starker tooltip — at that point the warning is
        // no longer "just in case", it's literally true.
        var redactionOff = currentSettings.redactionEnabled === false;
        if (count === 0 || (currentSettings.suppressContextWarnings && !redactionOff)) {
            $secrets.addClass("fp-hidden");
        } else {
            $secrets.removeClass("fp-hidden").toggleClass("fp-secrets-status-off", redactionOff);
            $secrets.attr("title", redactionOff
                ? "Redaction is OFF — secret-shaped values are sent as-is, unredacted. Don't send credentials or proprietary data unless you trust this AI provider."
                : "Context may include node config and code. Don't send credentials or proprietary data. Local/private AI recommended.");
        }

        relayStatusStripToPopout();
    }

    // First-run welcome + cockpit tour. Shows in the chat until the user
    // saves settings once (saveSettings stamps firstRunAcknowledged
    // server-side) — saving happens automatically as part of Pre-flight
    // check, so adding and testing a provider is enough to dismiss this.
    function maybeShowFirstRun(settings) {
        if (settings && settings.firstRunAcknowledged) { return; }

        addMessage("assistant",
            "Welcome to FlowPilot. You pick the destination, I help you get there.\n\n" +
            "FlowPilot sends your selected Node-RED nodes — including their " +
            "configuration and any code inside function or template nodes — to " +
            "the AI provider you configure. Please keep in mind:\n\n" +
            "- Do not include credentials, API keys, or proprietary information " +
            "in anything you send.\n" +
            "- A local or private AI provider (e.g. LocalAI, Ollama) is strongly " +
            "recommended over a cloud provider.\n" +
            "- Generate/Modify/Document changes are always shown as a review or " +
            "diff first — nothing is applied until you click Apply or import.");

        addMessage("assistant",
            "### Quick tour of the cockpit\n\n" +
            "- **Compose box** (bottom) — type a question or instruction, then " +
            "**Send** (Enter to send, Shift+Enter for a new line).\n" +
            "- **Query buttons** (orange, left of the prompt) — Explain / " +
            "Troubleshoot / Review / Suggest: one-click prompts about your " +
            "current selection.\n" +
            "- **Execute buttons** (blue, right of the prompt) — Document / " +
            "Generate / Modify: arm one, describe what you want, then Send. " +
            "Every change is shown as a review before anything is applied.\n" +
            "- **Header icons** — eraser clears the chat, magnifying glass " +
            "searches past conversations (Recall), bug icon attaches recent " +
            "Debug sidebar output, paper-plane returns to Chat, clock opens " +
            "your Flight log (past conversations), and the gear opens " +
            "Settings.\n" +
            "- Type `/help` any time for the full briefing, or `/demo` to see " +
            "Generate in action.");

        addMessage("assistant",
            "### One more thing before takeoff\n\n" +
            "FlowPilot needs an AI provider to talk to. Click **Settings** " +
            "(gear icon) and add one — base URL, optional API key, and a " +
            "model name. Then hit **Pre-flight check** to save and test it. " +
            "Once that succeeds, you're all set.");

        renderChip("Open Settings", "fa fa-cog", showSettings);
    }

    // ---- Slash commands ---------------------------------------------------
    // Typed in the compose box and handled entirely client-side: never sent
    // to the model, never recorded in conversation history.
    var HELP_TEXT = "## Captain's briefing\n\n" +
        "You pick the destination, I help you get there. Here's everything on the panel.\n\n" +
        "### Modes (one armed at a time)\n\n" +
        "- **Query** (default) — chat about your flow, ask questions, get explanations. Nothing changes.\n" +
        "- **Generate** — describe a flow and I'll draft it. Review the diff, then Apply.\n" +
        "- **Document** — select node(s) and I'll explain what they do.\n" +
        "- **Modify** — select node(s), tell me what to change, review the diff, then Apply.\n\n" +
        "The compose area glows orange in Query and blue when an Execute mode is armed, so you always know which one you're flying.\n\n" +
        "### Shortcuts\n\n" +
        "- `/help` — show this briefing\n" +
        "- `/generate` — arm Generate mode\n" +
        "- `/document` — arm Document mode\n" +
        "- `/modify` — arm Modify mode\n" +
        "- `/query` — back to Query (disarm)\n" +
        "- `/clear` — start a fresh conversation (clears chat and memory)\n" +
        "- `/history` — open the Flight log (past conversations)\n" +
        "- `/settings` — open the Hangar (providers, behavior, safety)\n\n" +
        "Typing a shortcut with extra text, e.g. `/modify add a debug node`, switches mode and leaves the rest in the box so you can review before sending.\n\n" +
        "- `/demo` — load a sample Generate request (a dad joke flow) into the compose box\n" +
        "- `/feedback` — bug report / feature request info\n" +
        "- `/compact` — hide labels on the selected node(s) (icon-only); `/expand` restores them. Instant, no AI involved — one Ctrl+Z undoes it.\n\n" +
        "### Also worth knowing\n\n" +
        "- Action chips (paper-plane buttons) offer a one-click follow-up — review and send, nothing fires automatically.\n" +
        "- When I ask a clarifying question, I'll often offer quick-reply buttons (plus \"Other\" for your own answer) — clicking one sends it right away.\n" +
        "- \"Pre-flight check\" in the Hangar tests a provider before you rely on it.\n" +
        "- \"Touchdown\"/\"Landed\" notes confirm an applied or imported change. Ctrl+Z undoes an applied change.";

    // /demo: a ready-made Generate request, used to show off FlowPilot's
    // flow-generation capability end to end (HTTP request, status, debug)
    // with a small, fast-to-generate flow.
    var DEMO_PROMPT = "Using an online dad joke API (e.g. https://icanhazdadjoke.com/ with an \"Accept: application/json\" header), make an API call for a dad joke when triggered by an inject node. Set the node's status to show the joke text, and wire a debug node to output the joke itself.";

    // /feedback: links back to the repo/issues, shown entirely client-side.
    var FEEDBACK_TEXT = "## Thanks for flying with FlowPilot\n\n" +
        "Bug? Rough edge? Idea for a feature? I'd love to hear about it — the " +
        "human crew reads every report.\n\n" +
        "- **Report an issue**: https://github.com/manny-est/flowpilot/issues\n" +
        "- **Browse the repo**: https://github.com/manny-est/flowpilot\n\n" +
        "A good report travels light but packs the essentials: your Node-RED " +
        "version, the provider/model you're flying with, and the steps to " +
        "reproduce. That's usually enough to get a fix off the ground.\n\n" +
        "Safe travels.";

    var demoTypeTimer = null;

    // Streams `text` into the prompt box a few characters at a time, as if
    // it were being typed, then calls `onDone`. Disabled while typing so the
    // user doesn't fight the animation; cancels any in-progress run first.
    function typeIntoPrompt(text, onDone) {
        var $promptBox = el("#fp-prompt");
        if (demoTypeTimer) { clearInterval(demoTypeTimer); demoTypeTimer = null; }
        if (!$promptBox.length) { if (onDone) { onDone(); } return; }
        $promptBox.val("").prop("disabled", true);
        var i = 0;
        var CHARS_PER_TICK = 3;
        demoTypeTimer = setInterval(function () {
            i = Math.min(text.length, i + CHARS_PER_TICK);
            $promptBox.val(text.slice(0, i));
            $promptBox.scrollTop($promptBox[0].scrollHeight);
            if (i >= text.length) {
                clearInterval(demoTypeTimer);
                demoTypeTimer = null;
                $promptBox.prop("disabled", false).focus();
                if (onDone) { onDone(); }
            }
        }, 12);
    }

    // Returns true if `raw` was a recognized "/command" and has been fully
    // handled (compose box updated, mode/panel switched, etc.) — callers
    // should NOT also dispatch it as a normal chat/generate/document/modify
    // send.
    function handleSlashCommand(raw) {
        var trimmed = (raw || "").trim();
        if (trimmed.charAt(0) !== "/") { return false; }

        var command = trimmed.split(/\s+/)[0].toLowerCase();
        var rest = trimmed.slice(command.length).trim();
        var $promptBox = el("#fp-prompt");

        switch (command) {
            case "/help":
            case "/?":
                addMessage("assistant", HELP_TEXT);
                if ($promptBox.length) { $promptBox.val(""); }
                break;
            case "/generate":
                armExecuteAction("generate");
                addMessage("assistant", "Cleared for **Generate** — describe the flow you'd like me to build, then send.");
                if ($promptBox.length) { $promptBox.val(rest); }
                break;
            case "/build":
                armExecuteAction("build");
                addMessage("assistant", "Cleared for **Build** — describe the goal. I'll plan, propose a first step, " +
                    "and after you apply/deploy/test it, walk through fix cycles with you until it works or we hit the attempt limit.");
                if ($promptBox.length) { $promptBox.val(rest); }
                break;
            case "/document":
                armExecuteAction("document");
                addMessage("assistant", "Cleared for **Document** — select the node(s) you want explained, then send.");
                if ($promptBox.length) { $promptBox.val(rest); }
                break;
            case "/modify":
                armExecuteAction("modify");
                addMessage("assistant", "Cleared for **Modify** — select the node(s) you want changed, describe the change, then send.");
                if ($promptBox.length) { $promptBox.val(rest); }
                break;
            case "/query":
            case "/chat":
                disarmExecuteAction();
                addMessage("assistant", "Back to **Query** — ask away.");
                if ($promptBox.length) { $promptBox.val(rest); }
                break;
            case "/clear":
                clearChat();
                if ($promptBox.length) { $promptBox.val(""); }
                break;
            case "/history":
                showHistory();
                if ($promptBox.length) { $promptBox.val(""); }
                break;
            case "/settings":
                showSettings();
                if ($promptBox.length) { $promptBox.val(""); }
                break;
            case "/demo":
                armExecuteAction("generate");
                addMessage("assistant", "Cleared for **Generate** — loading a demo request into the compose box.");
                typeIntoPrompt(DEMO_PROMPT, function () {
                    el("#fp-send").addClass("fp-send-breathe");
                });
                break;
            case "/feedback":
                addMessage("assistant", FEEDBACK_TEXT);
                if ($promptBox.length) { $promptBox.val(""); }
                break;
            // Deterministic, no LLM round-trip: just invokes Node-RED's own
            // native "show/hide selected node labels" action (RED.actions
            // "core:show-selected-node-labels" / "core:hide-selected-node-
            // labels", confirmed present in both NR4 and NR5 — the same
            // action a right-click context menu item triggers). Reusing it
            // outright means group-member expansion, no-op skipping, and
            // batching every affected node into ONE compound undo step are
            // already handled correctly — nothing to reimplement.
            case "/compact":
            case "/expand":
                // These two need a live RED.view selection + RED.actions.invoke
                // — dead in the pop-out's disconnected window. Relay the raw
                // command to the parent and let it run this exact same case
                // for real, instead of duplicating the selection-check/invoke
                // logic here.
                if (isPopoutContext) {
                    if (window.opener && !window.opener.closed) {
                        try { window.opener.postMessage({ event: "runSlashCommand", command: command }, location.origin); } catch (e) { /* ignore */ }
                    }
                    if ($promptBox.length) { $promptBox.val(""); }
                    break;
                }
                var sel = (RED.view && RED.view.selection) ? RED.view.selection() : null;
                var selCount = (sel && sel.nodes) ? sel.nodes.length : 0;
                if (selCount === 0) {
                    addMessage("error", "Select one or more nodes first.");
                    if ($promptBox.length) { $promptBox.val(""); }
                    break;
                }
                if (command === "/expand") {
                    RED.actions.invoke("core:show-selected-node-labels");
                    addMessage("assistant", "Touchdown — expanded " + selCount +
                        " node label" + (selCount === 1 ? "" : "s") + ". Ctrl+Z to undo.");
                } else {
                    RED.actions.invoke("core:hide-selected-node-labels");
                    addMessage("assistant", "Touchdown — compacted " + selCount +
                        " node label" + (selCount === 1 ? "" : "s") + ". Ctrl+Z to undo.");
                }
                if ($promptBox.length) { $promptBox.val(""); }
                break;
            default:
                addMessage("assistant", "Unrecognized command `" + command + "`. Type `/help` for the full list.");
                if ($promptBox.length) { $promptBox.val(""); }
                break;
        }

        return true;
    }

    // Single dispatch point for "Send" (button click and Enter key): slash
    // commands are handled locally first; otherwise route to the armed
    // Execute action, or a normal chat message. Bound identically in both
    // the main window and the pop-out (see initPopout) — arming/disarming/
    // slash commands are pure local state either way, but the FINAL
    // generate/document/modify/build/chat dispatch needs live RED.*
    // context that only the main window has, so the pop-out relays
    // instead of calling those functions locally (see isPopoutContext
    // below and the "dispatchSend" handler in initMainWindow).
    function dispatchSend() {
        el("#fp-send").removeClass("fp-send-breathe");
        var $promptBox = el("#fp-prompt");
        var raw = $promptBox.length ? $promptBox.val() : "";
        if (handleSlashCommand(raw)) { return; }

        // Query intents are one-shot: the template text has done its job
        // once Send is pressed, so disarm back to the default amber chat
        // mode (mutual exclusion already guarantees armedExecuteAction is
        // null whenever a Query intent is armed).
        disarmQueryIntent();

        if (isPopoutContext) {
            var mode = armedExecuteAction || "chat";
            var prompt = $promptBox.length ? $promptBox.val().trim() : "";
            if (!prompt) {
                addMessage("error", mode === "chat" ? "Enter a prompt first." : "Describe what you'd like to " + mode + " first.");
                return;
            }
            if (window.opener && !window.opener.closed) {
                try { window.opener.postMessage({ event: "dispatchSend", mode: mode, prompt: prompt }, location.origin); } catch (e) { /* ignore */ }
            }
            $promptBox.val("");
            return;
        }

        if (armedExecuteAction === "generate") {
            generate();
        } else if (armedExecuteAction === "build") {
            buildFlow();
        } else if (armedExecuteAction === "document") {
            documentFlow();
        } else if (armedExecuteAction === "modify") {
            modifyFlow();
        } else {
            send("chat");
        }
    }

    // ---- Prompting ------------------------------------------------------

    function setBusy(busy) {
        el("#fp-send").prop("disabled", busy);
        // Allow arming/disarming execute buttons while busy so users can
        // prepare their next message during a response.
        // el("#fp-generate").prop("disabled", busy);
        // el("#fp-document").prop("disabled", busy);
        // el("#fp-modify").prop("disabled", busy);
        el("#fp-test-provider").prop("disabled", busy);
        el("#fp-recall").prop("disabled", busy);
    }

    // Shared so chat and generate describe an attached selection identically —
    // "[+ N node(s), M connection(s) attached as context]".
    function contextAttachmentNote(context) {
        var nodeCount = (context && context.nodes) ? context.nodes.length : 0;
        var connCount = (context && context.connections && context.connections.edges)
            ? context.connections.edges.length : 0;
        var debugCount = (context && context.debugMessages) ? context.debugMessages.length : 0;

        var parts = [];
        if (nodeCount) {
            parts.push(nodeCount + " node(s)" + (connCount ? ", " + connCount + " connection(s)" : ""));
        }
        if (debugCount) {
            parts.push(debugCount + " debug message(s)");
        }
        return parts.length ? "\n\n[+ " + parts.join(", ") + " attached as context]" : "";
    }

    // endpoint is "chat" (real prompt) or "test" (connectivity check)
    function send(endpoint, promptOverride) {
        var $promptBox = el("#fp-prompt");
        var prompt = promptOverride || ($promptBox.length ? $promptBox.val().trim() : "");

        if (!prompt) {
            addMessage("error", "Enter a prompt first.");
            return;
        }

        // Connectivity test never carries flow context or conversation
        // history; keep it minimal and out of the conversation entirely.
        var isChat = endpoint === "chat";
        var context = (endpoint === "test") ? null : attachDebugContext(collectSelectionContext());
        var note = contextAttachmentNote(context);
        addMessage("user", prompt + note);
        // Build the history payload BEFORE pushing this turn, so
        // "history" means "everything before this turn" — the backend
        // appends this turn separately as the final user message.
        var historyPayload = isChat ? buildHistoryPayload() : { messages: [], truncated: false };
        if (isChat) { pushHistory("user", prompt + note); }
        if (!promptOverride) { $promptBox.val(""); }

        var ap = activeProvider();
        var isAgentLoop = isChat && ap && ap.supportsTools;

        setBusy(true);
        showPending(isAgentLoop);
        var payload = {
            prompt: prompt,
            context: context,
            history: historyPayload.messages,
            historyTruncated: historyPayload.truncated,
            conversationId: conversationId
        };

        function handleSendResult(data) {
            hidePending();
            var message = data.message || JSON.stringify(data, null, 2);
            // Test Provider also reports tool-calling support, used by
            // the agentic path.
            if (data.capability && data.capability.label) {
                message += "\n\n" + data.capability.label;
            }
            if (endpoint === "test") {
                message += "\n\nAll set — try `/help` for the full briefing and shortcut list.";
            }
            addMessage("assistant", message);
            if (isChat) {
                pushHistory("assistant", data.message || "");
                renderActionChip(data.suggestedAction);
                renderClarifyingQuestion(data.questionOptions);
            }
            setBusy(false);
            updateSelectionStatus();
        }

        function handleSendError(msg) {
            hidePending();
            if (isChat) { popDanglingUserHistory(); }
            addMessage("error", msg);
            setBusy(false);
        }

        // When the active provider supports tool/function calling,
        // the chat turn is offered the Tier-1 read tools and run through the
        // bounded agent loop instead of a single request.
        if (isAgentLoop) {
            runAgentChat(payload, handleSendResult, handleSendError);
            return;
        }

        if (isChat && currentSettings.streamingEnabled) {
            payload.stream = true;
            sendChatStream(payload);
            return;
        }

        ajaxJson("POST", "flowpilot/" + endpoint, payload, handleSendResult, handleSendError);
    }

    // ---------------------------------------------------------------------
    // Bounded read-tool loop, shared by chat and
    // generate/document/modify ("explore-then-propose"). Sends the
    // first turn to firstEndpoint with tools:true; if the model returns
    // tool_calls instead of a final response, executes each call locally
    // (executeAgentToolCall, against RED.nodes — see above), appends the
    // assistant tool-call message and the tool results, and continues via
    // /flowpilot/agent-step (with stepExtra merged into the body — e.g.
    // { mode: "modify", context, prompt } so the backend can parse/validate
    // the final envelope the same way the non-streaming routes do). A
    // malformed/missing tool result is still sent back as a {"error": "..."}
    // tool message so the model can recover or answer anyway, rather than
    // the request erroring out.
    //
    // Bounds, all per turn:
    //  - AGENT_LOOP_MAX_STEPS: max number of tool round-trips.
    //  - AGENT_LOOP_TOKEN_CEILING: cumulative usage.total_tokens across all
    //    steps (provider-reported; null/missing usage doesn't count against
    //    it, so this is a best-effort guard, not a hard limit).
    //  - fpAgentStopRequested: set by the "Stop" button in showPending(true);
    //    checked before each further round-trip.
    //
    // If the model's tool_calls are too malformed to continue the
    // tool/assistant message round-trip (missing id or function.name), the
    // turn falls back to a plain (no-tools) request to firstEndpoint rather
    // than erroring out.
    // ---------------------------------------------------------------------
    var AGENT_LOOP_MAX_STEPS = 8;
    var AGENT_LOOP_TOKEN_CEILING = 50000;

    var fpAgentStopRequested = false;

    function runAgentLoop(firstEndpoint, payload, stepExtra, onDone, onError) {
        var step = 0;
        var totalTokens = 0;
        fpAgentStopRequested = false;

        function addUsage(usage) {
            if (usage && typeof usage.total_tokens === "number") {
                totalTokens += usage.total_tokens;
            }
        }

        function fallbackToPlain() {
            setAgentNarration("Continuing without tools…");
            ajaxJson("POST", firstEndpoint, payload, onDone, onError);
        }

        function handleStep(data, messages) {
            addUsage(data.usage);

            if (!data.toolCalls || !data.toolCalls.length) {
                if (step > 0) { addAgentStatsNote(step, totalTokens); }
                onDone(data);
                return;
            }

            var malformed = data.toolCalls.some(function (call) {
                return !call || !call.id || !call.function || typeof call.function.name !== "string";
            });
            if (malformed) {
                fallbackToPlain();
                return;
            }

            step++;
            if (step > AGENT_LOOP_MAX_STEPS) {
                onError("FlowPilot stopped after " + AGENT_LOOP_MAX_STEPS +
                    " tool call(s) without a final answer. Try breaking your " +
                    "request into smaller steps, or be more specific about " +
                    "which node(s) or flow you mean.");
                return;
            }
            if (totalTokens > AGENT_LOOP_TOKEN_CEILING) {
                onError("FlowPilot stopped after using " + totalTokens +
                    " tokens on this turn without a final answer. Try " +
                    "selecting fewer nodes, or asking a more specific " +
                    "question so fewer tool calls are needed.");
                return;
            }
            if (fpAgentStopRequested) {
                onError("Stopped after " + (step - 1) + " tool call step(s) at your request.");
                return;
            }

            var nextMessages = (messages || data.messages || []).slice();
            nextMessages.push({ role: "assistant", content: data.content || null, tool_calls: data.toolCalls });
            data.toolCalls.forEach(function (call) {
                setAgentNarration(describeAgentToolCall(call.function.name, parseToolCallArgs(call)) +
                    " (step " + step + "/" + AGENT_LOOP_MAX_STEPS + ")");
                nextMessages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: JSON.stringify(executeAgentToolCall(call))
                });
            });
            setAgentNarration("Thinking… (step " + step + "/" + AGENT_LOOP_MAX_STEPS + ")");
            var stepPayload = Object.assign({
                messages: nextMessages,
                conversationId: payload.conversationId
            }, stepExtra);
            ajaxJson("POST", "flowpilot/agent-step", stepPayload,
                function (stepData) { handleStep(stepData, nextMessages); }, onError);
        }

        var firstPayload = Object.assign({}, payload, { tools: true });
        ajaxJson("POST", firstEndpoint, firstPayload, function (data) {
            handleStep(data, null);
        }, function () {
            // The provider was probed as
            // supportsTools, but the very first tools:true request failed
            // outright — e.g. the model was swapped since the last probe, or
            // this provider errors on an unrecognized "tools" field instead
            // of ignoring it. Retry once without tools so the turn still
            // completes the same way it would for a non-capable provider,
            // rather than surfacing a hard error for what would otherwise be
            // a normal request.
            fallbackToPlain();
        });
    }

    // Chat: mode defaults to "chat" server-side, so no stepExtra.
    function runAgentChat(payload, onDone, onError) {
        runAgentLoop("flowpilot/chat", payload, {}, onDone, onError);
    }

    // Streaming chat. Posts with stream:true and reads the
    // SSE response body incrementally via fetch's ReadableStream. The
    // bouncing "pending" indicator (already in the DOM from showPending)
    // stays up until the first real delta arrives, then ensureBubble()
    // swaps it for the assistant bubble that gets filled in as chunks
    // arrive — generate/modify/document never call this; their JSON envelope
    // can't be rendered until complete.
    function sendChatStream(payload) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }

        // Bug #4: this used to grab the just-shown #fp-pending indicator and
        // convert it into an empty bubble right here, synchronously, before
        // fetch() even started — so the dots were destroyed in the same tick
        // they were created and never got a chance to render. $msg/$text now
        // start null and ensureBubble() (below) does the conversion lazily,
        // on the FIRST actual delta — the dots stay visible for the entire
        // wait until real content starts arriving.
        var $msg = null;
        var $text = null;

        var fullText = "";
        var finalData = null;

        function ensureBubble() {
            if ($text) { return; }
            hidePending();
            addMessage("assistant", "");
            $msg = $box.find(".fp-message").last();
            $text = $msg.find("div").last();
        }

        function finish() {
            hidePending();
            if (!fullText) {
                if ($msg && $msg.length) { $msg.remove(); }
                popDanglingUserHistory();
                addMessage("error", "No response received from the provider.");
            } else {
                pushHistory("assistant", fullText);
                if (finalData) {
                    renderActionChip(finalData.suggestedAction);
                    renderClarifyingQuestion(finalData.questionOptions);
                }
            }
            setBusy(false);
            updateSelectionStatus();
        }

        function fail(err) {
            hidePending();
            if ($msg && $msg.length) { $msg.remove(); }
            popDanglingUserHistory();
            addMessage("error", (err && err.message) ? err.message : String(err));
            setBusy(false);
        }

        if (typeof fetch !== "function") {
            fail(new Error("Streaming requires a browser with fetch() support. " +
                "Disable streaming in Settings to use chat."));
            return;
        }

        // Shared SSE-line parser: handles `data: {"delta":"..."}` /
        // `data: {"final":{...}}` / `data: {"error":"..."}` / `data: [DONE]`
        // lines, appending deltas to fullText and rendering them. Used by
        // both the streaming pump() loop (called per-chunk with the trailing
        // partial line held back) and the non-getReader fallback (#12,
        // called once with the full body split into lines), so neither path
        // can drift or show raw SSE text. The backend withholds any trailing
        // <<<FLOWPILOT_DATA>>> block from `delta`s entirely and relays its
        // parsed suggestedAction/questionOptions as a single `final` event.
        function processSseLines(lines) {
            lines.forEach(function (line) {
                line = line.trim();
                if (line.indexOf("data:") !== 0) { return; }
                var dataStr = line.slice(5).trim();
                if (!dataStr || dataStr === "[DONE]") { return; }
                var evt;
                try { evt = JSON.parse(dataStr); } catch (e) { return; }
                if (evt.error) { throw new Error(evt.error); }
                if (evt.delta) {
                    fullText += evt.delta;
                    ensureBubble();
                    $text.html(renderMarkdown(fullText));
                    scrollMessagesToBottom();
                } else if (evt.final) {
                    finalData = evt.final;
                }
            });
        }

        fetch(flowpilotUrl("flowpilot/chat"), {
            method: "POST",
            headers: fetchHeaders(),
            body: JSON.stringify(payload)
        }).then(function (resp) {
            if (!resp.ok) {
                return resp.text().then(function (text) {
                    var msg = text;
                    try { msg = JSON.parse(text).error || text; } catch (e) { /* not JSON */ }
                    throw new Error(msg || resp.statusText);
                });
            }
            if (!resp.body || !resp.body.getReader) {
                // No streaming support in this environment — parse the full
                // SSE response body with the same logic as pump() below, so
                // the user sees the parsed reply, not raw `data: {...}` lines.
                return resp.text().then(function (text) {
                    processSseLines(text.split("\n"));
                });
            }

            var reader = resp.body.getReader();
            var decoder = new TextDecoder();
            var buf = "";

            function pump() {
                return reader.read().then(function (step) {
                    if (step.done) { return; }
                    buf += decoder.decode(step.value, { stream: true });
                    var lines = buf.split("\n");
                    buf = lines.pop();
                    processSseLines(lines);
                    return pump();
                });
            }
            return pump();
        }).then(finish, fail);
    }

    // Incrementally extracts the value of the JSON envelope's
    // "explanation" key from raw streamed text. All three generation system
    // prompts put "explanation" first, so its closing quote arrives well
    // before any other key streams in. Handles JSON string escapes
    // (including \uXXXX) that may be split across chunks. push() returns the
    // decoded text so far, or null if the "explanation" key hasn't started
    // yet (nothing to render) — e.g. for a prose-only response with no JSON
    // envelope at all, which never starts.
    function createExplanationExtractor() {
        var buffer = "";
        var phase = "seeking"; // seeking -> in_string -> done
        var text = "";
        var ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

        return {
            push: function (delta) {
                if (phase === "done") { return text; }
                buffer += delta;

                if (phase === "seeking") {
                    var m = buffer.match(/"explanation"\s*:\s*"/);
                    if (!m) { return null; }
                    buffer = buffer.slice(m.index + m[0].length);
                    phase = "in_string";
                }

                var i = 0;
                while (i < buffer.length) {
                    var ch = buffer[i];
                    if (ch === "\\") {
                        if (i + 1 >= buffer.length) { break; } // incomplete escape, wait for more
                        var esc = buffer[i + 1];
                        if (esc === "u") {
                            if (i + 6 > buffer.length) { break; } // incomplete \uXXXX
                            text += String.fromCharCode(parseInt(buffer.slice(i + 2, i + 6), 16));
                            i += 6;
                            continue;
                        }
                        text += (ESCAPES[esc] !== undefined ? ESCAPES[esc] : esc);
                        i += 2;
                        continue;
                    }
                    if (ch === '"') {
                        phase = "done";
                        i += 1;
                        break;
                    }
                    text += ch;
                    i += 1;
                }
                buffer = buffer.slice(i);
                return text;
            },
            isDone: function () { return phase === "done"; }
        };
    }

    // Shared error handler for Generate/Document/Modify, used by both the
    // non-streaming (ajaxJson) and streaming (sendExecuteStream) paths. A 422
    // with raw text means the model replied but we couldn't parse/validate a
    // flow; show the raw so the user can see what happened.
    function handleExecuteError(msg, raw) {
        popDanglingUserHistory();
        addMessage("error", msg);
        if (raw) { addGeneratedJson(raw, true); }
        setBusy(false);
    }

    // Clicking an action chip switches Send to the suggested
    // mode and pre-fills the compose box with the prepared prompt. The user
    // reviews it and hits Send themselves — nothing is sent automatically,
    // and the change still goes through the normal diff review like any
    // other Execute action.
    function applySuggestedAction(suggestedAction) {
        if (!suggestedAction || !suggestedAction.mode || !suggestedAction.prompt) { return; }
        armExecuteAction(suggestedAction.mode);
        var $promptBox = el("#fp-prompt");
        if ($promptBox.length) {
            $promptBox.val(suggestedAction.prompt);
            $promptBox.focus();
        }
    }

    // Renders an optional "suggestedAction" (action chip) below
    // the latest message — a tappable next-step the model proposed. Same
    // chip shape/renderer regardless of whether an envelope or a
    // tool call produced it.
    function renderActionChip(suggestedAction) {
        if (!suggestedAction || !suggestedAction.mode || !suggestedAction.prompt) { return; }
        var $box = el("#fp-messages");
        if (!$box.length) { return; }

        var modeLabel = suggestedAction.mode === "generate" ? "Generate"
            : suggestedAction.mode === "document" ? "Document"
            : suggestedAction.mode === "modify" ? "Modify"
            : suggestedAction.mode === "chat" ? "Chat" : suggestedAction.mode;

        var preview = suggestedAction.prompt.length > 60
            ? suggestedAction.prompt.slice(0, 57) + "…"
            : suggestedAction.prompt;

        var isChatMode = suggestedAction.mode === "chat";
        var titleText = isChatMode ? "Switch to Chat" : "Cleared for takeoff — " + modeLabel;

        var $row = $("<div>").addClass("fp-chip-row");
        var $card = $("<button>")
            .addClass("fp-chip fp-chip-card")
            .attr("type", "button")
            .attr("title", suggestedAction.prompt)
            .on("click", function () { applySuggestedAction(suggestedAction); });
        $("<span>").addClass("fp-chip-icon")
            .append($("<i>").addClass(isChatMode ? "fa fa-comment" : "fa fa-paper-plane"))
            .appendTo($card);
        var $body = $("<span>").addClass("fp-chip-body").appendTo($card);
        $("<span>").addClass("fp-chip-title").text(titleText).appendTo($body);
        $("<span>").addClass("fp-chip-sub").text(preview).appendTo($body);
        $("<span>").addClass("fp-chip-go").html("&rsaquo;").appendTo($card);
        $card.appendTo($row);

        if (suggestedAction.selectionHint) {
            $("<div>").addClass("fp-chip-hint").text("Tip: " + suggestedAction.selectionHint).appendTo($row);
        }

        $box.append($row);
        scrollMessagesToBottom();
    }

    // Renders a single-button call-to-action chip below the latest message
    // — used by first-run onboarding to jump straight to Settings. Same
    // big icon-tile card as renderActionChip, just without a sub-line.
    function renderChip(label, iconClass, onClick) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }

        var $row = $("<div>").addClass("fp-chip-row");
        var $card = $("<button>")
            .addClass("fp-chip fp-chip-card")
            .attr("type", "button")
            .on("click", onClick);
        $("<span>").addClass("fp-chip-icon").append($("<i>").addClass(iconClass)).appendTo($card);
        $("<span>").addClass("fp-chip-body")
            .append($("<span>").addClass("fp-chip-title").text(label))
            .appendTo($card);
        $("<span>").addClass("fp-chip-go").html("&rsaquo;").appendTo($card);
        $card.appendTo($row);

        $box.append($row);
        scrollMessagesToBottom();
    }

    // Renders a clarifying question's quick-reply options as one-click
    // buttons, plus a free-text "Other" option, below the latest message.
    // Picking an option (or submitting "Other") fills the compose box with
    // that text and sends it immediately via dispatchSend() — which routes
    // to whatever's currently armed (Generate/Document/Modify follow-up, or
    // a normal Query/chat message) exactly as if the user had typed and sent
    // it themselves.
    function renderClarifyingQuestion(options) {
        if (!Array.isArray(options) || !options.length) { return; }
        var $box = el("#fp-messages");
        if (!$box.length) { return; }

        var $row = $("<div>").addClass("fp-chip-row fp-question-row");
        var $otherRow; // assigned below; declared here so answer() can reach it

        function answer(text) {
            $row.find("button, input").prop("disabled", true);
            if ($otherRow) { $otherRow.find("button, input").prop("disabled", true); }
            el("#fp-prompt").val(text);
            dispatchSend();
        }

        options.forEach(function (opt) {
            $("<button>")
                .addClass("red-ui-button red-ui-button-small fp-chip fp-question-option")
                .attr("type", "button")
                .text(opt)
                .on("click", function () { answer(opt); })
                .appendTo($row);
        });

        $otherRow = $("<div>").addClass("fp-question-other-row fp-hidden");
        var $otherInput = $("<input>")
            .attr("type", "text")
            .attr("placeholder", "Type your own answer…")
            .addClass("fp-question-other-input");
        var $otherSend = $("<button>")
            .addClass("red-ui-button red-ui-button-small")
            .attr("type", "button")
            .append($("<i>").addClass("fa fa-paper-plane"));

        function submitOther() {
            var val = $otherInput.val().trim();
            if (!val) { return; }
            answer(val);
        }
        $otherSend.on("click", submitOther);
        $otherInput.on("keydown", function (e) { if (e.key === "Enter") { submitOther(); } });
        $otherRow.append($otherInput).append($otherSend);

        $("<button>")
            .addClass("red-ui-button red-ui-button-small fp-chip fp-question-other")
            .attr("type", "button")
            .text("Other…")
            .on("click", function () {
                $otherRow.removeClass("fp-hidden");
                $otherInput.focus();
            })
            .appendTo($row);

        $box.append($row).append($otherRow);
        scrollMessagesToBottom();
    }

    // Shared by Generate/Document/Modify result handlers: renders the model's
    // clarifying-question or prose-only envelope as a normal assistant
    // message and leaves the action armed for a follow-up. Returns true if it
    // handled the response (caller should stop there), false if the caller
    // should proceed to its own success rendering (flow review, etc).
    function renderQuestionOrProse(data) {
        if (data.question) {
            var qText = (data.explanation ? data.explanation + "\n\n" : "") + data.question;
            addMessage("assistant", qText);
            pushHistory("assistant", qText);
            renderActionChip(data.suggestedAction);
            renderClarifyingQuestion(data.questionOptions);
            setBusy(false);
            updateSelectionStatus();
            return true;
        }
        if (data.prose) {
            addMessage("assistant", data.explanation || "(no content returned)");
            pushHistory("assistant", data.explanation || "");
            renderActionChip(data.suggestedAction);
            renderClarifyingQuestion(data.questionOptions);
            setBusy(false);
            updateSelectionStatus();
            return true;
        }
        return false;
    }

    // Shared result handler for /generate and /document — used by both the
    // non-streaming (ajaxJson) and streaming (sendExecuteStream) paths so
    // review rendering, history, and busy/selection state can't drift between
    // the two.
    function handleSimpleGenerationResult(data) {
        hidePending();
        if (renderQuestionOrProse(data)) { return; }

        // Lay nodes out before review/import — see layoutGeneratedFlow for why.
        var flow = Array.isArray(data.flow) ? layoutGeneratedFlow(data.flow) : data.flow;
        addMessage("assistant", data.explanation || "(no explanation returned)");
        pushHistory("assistant", data.explanation || "(no explanation returned)");
        addGeneratedReview(flow);
        renderActionChip(data.suggestedAction);
        setBusy(false);
        updateSelectionStatus();
    }

    // Shared result handler for /modify — used by both the non-streaming
    // (ajaxJson) and streaming (sendExecuteStream) paths.
    function handleModifyResult(data) {
        hidePending();
        if (renderQuestionOrProse(data)) { return; }

        addMessage("assistant", data.explanation || "(no explanation returned)");
        pushHistory("assistant", data.explanation || "(no explanation returned)");
        addModifyReview(data.flow, data.newNodes || [], data.newWires || [], data.removeNodes || [], applyModifications, null, data.newGroups || []);
        renderActionChip(data.suggestedAction);
        setBusy(false);
        updateSelectionStatus();
    }

    // Streaming variant of Generate/Document/Modify. Posts with
    // stream:true and progressively renders the envelope's "explanation"
    // field into a bubble as deltas arrive (via createExplanationExtractor),
    // using the same getReader/fallback pattern as sendChatStream. Once the
    // stream ends, removes the streaming bubble and hands the validated
    // `final` result to resultHandler — the same function the non-streaming
    // path uses, so review rendering, history, and busy/selection state stay
    // identical either way.
    function sendExecuteStream(endpoint, payload, resultHandler) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }

        // See the matching comment in sendChatStream — same fix, same bug
        // (#4): don't pre-convert #fp-pending before any data has arrived.
        var $msg = null;
        var $text = null;

        var extractor = createExplanationExtractor();
        var finalData = null;
        var finalStatus = null;
        var errorData = null;
        var generatingShown = false;

        function ensureBubble() {
            if ($text) { return; }
            hidePending();
            addMessage("assistant", "");
            $msg = $box.find(".fp-message").last();
            $text = $msg.find("div").last();
        }

        function fail(err) {
            hidePending();
            if ($msg && $msg.length) { $msg.remove(); }
            handleExecuteError((err && err.message) ? err.message : String(err), null);
        }

        if (typeof fetch !== "function") {
            fail(new Error("Streaming requires a browser with fetch() support. Disable streaming in Settings to use Generate/Document/Modify."));
            return;
        }

        function processSseLines(lines) {
            lines.forEach(function (line) {
                line = line.trim();
                if (line.indexOf("data:") !== 0) { return; }
                var dataStr = line.slice(5).trim();
                if (!dataStr || dataStr === "[DONE]") { return; }
                var evt;
                try { evt = JSON.parse(dataStr); } catch (e) { return; }

                if (evt.delta) {
                    var text = extractor.push(evt.delta);
                    if (text !== null) {
                        ensureBubble();
                        $text.html(renderMarkdown(text));
                        scrollMessagesToBottom();
                    }
                    // The explanation has fully arrived but the rest of the
                    // envelope (the "flow" JSON etc.) is still streaming in
                    // and buffered — show a pending indicator below the
                    // explanation so the wait for the review block doesn't
                    // look like nothing is happening.
                    if (extractor.isDone() && !generatingShown) {
                        generatingShown = true;
                        showPending();
                    }
                } else if (evt.final) {
                    finalData = evt.final;
                    finalStatus = evt.status;
                } else if (evt.error) {
                    errorData = evt.error;
                }
            });
        }

        fetch(flowpilotUrl("flowpilot/" + endpoint), {
            method: "POST",
            headers: fetchHeaders(),
            body: JSON.stringify(payload)
        }).then(function (resp) {
            if (!resp.ok) {
                return resp.text().then(function (text) {
                    var msg = text;
                    try { msg = JSON.parse(text).error || text; } catch (e) { /* not JSON */ }
                    throw new Error(msg || resp.statusText);
                });
            }
            if (!resp.body || !resp.body.getReader) {
                return resp.text().then(function (text) {
                    processSseLines(text.split("\n"));
                });
            }

            var reader = resp.body.getReader();
            var decoder = new TextDecoder();
            var buf = "";

            function pump() {
                return reader.read().then(function (step) {
                    if (step.done) { return; }
                    buf += decoder.decode(step.value, { stream: true });
                    var lines = buf.split("\n");
                    buf = lines.pop();
                    processSseLines(lines);
                    return pump();
                });
            }
            return pump();
        }).then(function () {
            hidePending();
            if ($msg && $msg.length) { $msg.remove(); }

            if (errorData) {
                handleExecuteError(errorData.error, errorData.raw);
                return;
            }
            if (!finalData) {
                handleExecuteError("No response received from the provider.", null);
                return;
            }
            // finalize() can return a non-2xx status (e.g. 422 for invalid
            // wire/id references) even on the "final" event, since an SSE
            // response can't change its HTTP status after headers are sent.
            // Route those to the error renderer instead of treating
            // {error, raw} as a success body.
            if (finalStatus && finalStatus >= 400) {
                handleExecuteError(finalData.error || "Request failed.", finalData.raw);
                return;
            }
            resultHandler(finalData);
        }, fail);
    }

    // Request a generated flow fragment and show it for review, validation,
    // and import via addGeneratedReview.
    // Shared by Generate and Build — Build's first step is Generate-shaped
    // (see lib/build-system-prompt.js): same envelope, same review/import
    // pipeline. Only the endpoint, audit-mode name, and the "user" chat
    // bubble's label prefix differ.
    function runGenerateLikeAction(endpointName, mode, labelPrefix, onResult) {
        var $promptBox = el("#fp-prompt");
        var prompt = $promptBox.length ? $promptBox.val().trim() : "";
        if (!prompt) {
            addMessage("error", "Describe what you'd like to " + mode + " first.");
            return;
        }

        // Selection context lets the model generate something that fits with
        // the nodes you've selected (e.g. "wire this into my MQTT setup").
        // Falls back to the pinned selection if nothing is currently
        // selected, so follow-up turns need no reselection.
        var context = attachDebugContext(collectSelectionContext(activeSelectionIds()));
        var label = labelPrefix + prompt + contextAttachmentNote(context);
        addMessage("user", label);
        if (prompt === DEMO_PROMPT) {
            addMessage("assistant", "This is a large request — AI providers may take 20+ seconds to respond.");
        }
        // Snapshot history before pushing this turn (see send()).
        var historyPayload = buildHistoryPayload();
        pushHistory("user", label);
        $promptBox.val("");

        var ap = activeProvider();
        var isAgentLoop = ap && ap.supportsTools;

        setBusy(true);
        showPending(isAgentLoop);
        var payload = {
            prompt: prompt, context: context,
            history: historyPayload.messages, historyTruncated: historyPayload.truncated,
            conversationId: conversationId
        };

        function onError(msg, xhr) {
            hidePending();
            // 422 with raw text means the model replied but we couldn't parse a
            // flow; show the raw so the user can see what happened.
            var raw = xhr && xhr.responseJSON && xhr.responseJSON.raw;
            handleExecuteError(msg, raw);
        }

        // Wraps onResult so callers (currently just buildFlow(), for the
        // /build loop) can see the original prompt text alongside the
        // response — without changing the single-argument calling
        // convention that runAgentLoop/sendExecuteStream/ajaxJson all share
        // across every other mode.
        function wrappedOnResult(data) { onResult(data, prompt); }

        var fullEndpoint = "flowpilot/" + endpointName;

        // Explore-then-propose: the model may call read
        // tools (e.g. read_node, search_flow) before producing the
        // generation envelope; the loop's final response still goes through
        // the same validate/review pipeline via onResult.
        if (isAgentLoop) {
            runAgentLoop(fullEndpoint, payload,
                { mode: mode, context: context, prompt: prompt },
                wrappedOnResult, onError);
            return;
        }

        // Stream the envelope's "explanation" as it's generated; the
        // "flow" JSON is buffered server-side and arrives as a single
        // validated `final` event, handled identically to the non-streaming
        // path via onResult.
        if (currentSettings.streamingEnabled) {
            payload.stream = true;
            sendExecuteStream(endpointName, payload, wrappedOnResult);
            return;
        }

        ajaxJson("POST", fullEndpoint, payload, wrappedOnResult, onError);
    }

    function generate() {
        runGenerateLikeAction("generate", "generate", "Generate: ", handleSimpleGenerationResult);
    }

    // /build's first step. Reuses Generate's pipeline wholesale for the
    // proposal itself (review/import), but on a successful import also
    // starts the build loop (startBuildLoop) — unlike plain Generate, a
    // build proposal is the first waypoint of a longer apply -> deploy ->
    // attach debug -> review -> fix/done cycle, not a one-shot. The loop
    // only starts once an actual flow lands, not on a clarifying question
    // or prose-only reply (renderQuestionOrProse handles those the same as
    // Generate/Document, with no loop involved).
    function buildFlow() {
        runGenerateLikeAction("build", "build", "Build: ", handleBuildResult);
    }

    function handleBuildResult(data, goalPrompt) {
        hidePending();
        if (renderQuestionOrProse(data)) { return; }

        // Lay nodes out before review/import — see layoutGeneratedFlow for why.
        var flow = Array.isArray(data.flow) ? layoutGeneratedFlow(data.flow) : data.flow;
        addMessage("assistant", data.explanation || "(no explanation returned)");
        pushHistory("assistant", data.explanation || "(no explanation returned)");
        addGeneratedReview(flow, function (importResult) { startBuildLoop(goalPrompt, flow, importResult); }, goalPrompt);
        renderActionChip(data.suggestedAction);
        setBusy(false);
        updateSelectionStatus();
    }

    // Document feature: explain the SELECTED nodes and produce a single
    // comment node (prose + Mermaid diagram in its "info" field) to drop onto
    // the canvas. Reuses the same validate -> review -> import pipeline as
    // Generate — a comment node is just a regular flow-JSON node, so there's
    // nothing import-mechanism-specific to build here. The prompt box holds
    // OPTIONAL notes to steer the explanation; the selection is the real input.
    function documentFlow() {
        // Falls back to the pinned selection if nothing is currently
        // selected, so follow-up turns need no reselection.
        var context = collectSelectionContext(activeSelectionIds());
        if (!context || !Array.isArray(context.nodes) || context.nodes.length === 0) {
            addMessage("error", "Select the node(s) you want documented first.");
            return;
        }
        context = attachDebugContext(context);

        var $promptBox = el("#fp-prompt");
        var notes = $promptBox.length ? $promptBox.val().trim() : "";
        var label = "Document selection" + (notes ? ": " + notes : "") + contextAttachmentNote(context);
        addMessage("user", label);
        // Snapshot history before pushing this turn (see send()).
        var historyPayload = buildHistoryPayload();
        pushHistory("user", label);
        $promptBox.val("");

        var ap = activeProvider();
        var isAgentLoop = ap && ap.supportsTools;

        setBusy(true);
        showPending(isAgentLoop);
        var payload = {
            prompt: notes, context: context,
            history: historyPayload.messages, historyTruncated: historyPayload.truncated,
            conversationId: conversationId
        };

        function onDocumentError(msg, xhr) {
            hidePending();
            var raw = xhr && xhr.responseJSON && xhr.responseJSON.raw;
            handleExecuteError(msg, raw);
        }

        // Explore-then-propose, same as generate().
        if (isAgentLoop) {
            runAgentLoop("flowpilot/document", payload,
                { mode: "document", context: context, prompt: notes },
                handleSimpleGenerationResult, onDocumentError);
            return;
        }

        // Stream the envelope's "explanation" as it's generated; see
        // generate() for details.
        if (currentSettings.streamingEnabled) {
            payload.stream = true;
            sendExecuteStream("document", payload, handleSimpleGenerationResult);
            return;
        }

        ajaxJson("POST", "flowpilot/document", payload, handleSimpleGenerationResult, onDocumentError);
    }

    // ---- Modify flow ------------------------------------------------------
    // Fields we never include in a property diff: internal editor state that
    // the model correctly omits and that we must never overwrite on apply.
    // "outputs" is intentionally NOT skipped: for node types like "function"
    // it's a real, user-meaningful defaults field (port count) that the model
    // is expected to change when asked for "N outputs" — skipping it silently
    // dropped that change while the func code already returned an N-element
    // array. (Switch nodes derive "outputs" from rules.length separately, in
    // applyModifications's Tier 1 block, so this doesn't conflict.)
    var DIFF_SKIP = {
        x: 1, y: 1, z: 1, _def: 1, _: 1, changed: 1, dirty: 1, selected: 1,
        valid: 1, validationErrors: 1, _index: 1, resize: 1, moved: 1,
        w: 1, h: 1, l: 1, __outputs: 1, inputs: 1, g: 1,
        _config: 1, _orig: 1, credentials: 1
    };

    // Sentinel strings written by sanitizeNode (and redactDebugValue) for
    // values it couldn't include or had to redact. If the model echoes one
    // of these back, the field is opaque — skip it entirely; never write a
    // sentinel string into a live node property. "[redacted]" is the plain
    // top-level-secret-field sentinel; "[redacted: <kind>, <n> chars]" is the
    // informative value-shape sentinel from redactDebugValue.
    function isSanitizeSentinel(value) {
        return typeof value === "string" &&
            (value === "[unserializable]" || value === "[redacted]" || value.indexOf("[redacted:") === 0);
    }

    function generateNodeId() {
        var chars = "0123456789abcdef";
        var id = "";
        for (var i = 0; i < 16; i++) { id += chars[Math.floor(Math.random() * 16)]; }
        return id;
    }

    // Resolve a newWires from/to reference to a display label.
    // ref is either a placeholder id present in newNodes or an existing node id.
    function resolveWireRef(ref, newNodes) {
        if (!ref) { return "(unknown)"; }
        // Check against newNodes placeholder ids.
        for (var i = 0; i < newNodes.length; i++) {
            if (newNodes[i] && newNodes[i].id === ref) {
                var n = newNodes[i];
                return (n.name || n.type || ref) + " [new]";
            }
        }
        // Existing node.
        var live = RED.nodes && RED.nodes.node ? RED.nodes.node(ref) : null;
        return live ? (live.name || live.type || ref) : ref;
    }

    // Insert new nodes into the live graph and add wires connecting them to
    // existing nodes. Uses RED.nodes.add (the same path Node-RED's undo uses
    // internally for t:"add" events) and pushes one compound history entry so
    // a single Ctrl+Z removes both the new nodes and their wires together.
    function applyInsertions(newNodes, newWires, contextNodeIds) {
        if (!newNodes || !newNodes.length) { return; }

        // Determine z (flow-tab id) from the active workspace.
        var z = "";
        if (RED.workspaces && RED.workspaces.active) {
            var ws = RED.workspaces.active();
            z = ws ? (typeof ws === "string" ? ws : ws.id || "") : "";
        }

        // Collect model placeholder ids to distinguish them from existing-node
        // ids when scanning newWires for spatial anchors.
        var placeholderIds = {};
        newNodes.forEach(function (n) { if (n.id) { placeholderIds[n.id] = true; } });

        // Group new nodes into connected clusters (by each node's own
        // "wires" plus any "newWires" edges between two placeholders), so
        // multiple unrelated insertions in one response are each anchored to
        // THEIR OWN existing-node connections instead of bunching together at
        // one shared location.
        var parent = {};
        newNodes.forEach(function (n) { parent[n.id] = n.id; });
        function findRoot(x) {
            while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        }
        function union(a, b) {
            if (parent[a] === undefined || parent[b] === undefined) { return; }
            parent[findRoot(a)] = findRoot(b);
        }
        newNodes.forEach(function (n) {
            (Array.isArray(n.wires) ? n.wires : []).forEach(function (port) {
                (Array.isArray(port) ? port : []).forEach(function (tid) {
                    if (placeholderIds[tid]) { union(n.id, tid); }
                });
            });
        });
        (newWires || []).forEach(function (wire) {
            if (placeholderIds[wire.from] && placeholderIds[wire.to]) {
                union(wire.from, wire.to);
            }
        });
        var componentOf = {};
        newNodes.forEach(function (n) { componentOf[n.id] = findRoot(n.id); });

        // Per-component anchors: existing-node connections (from newWires)
        // touching THIS component only. Split into "upstream" (existing node
        // feeds INTO this component) and "downstream" (this component feeds
        // INTO an existing node) — a wire's direction matters for where the
        // cluster should land.
        var componentAnchors = {};
        Object.keys(componentOf).forEach(function (id) {
            var c = componentOf[id];
            if (!componentAnchors[c]) { componentAnchors[c] = { upstream: [], downstream: [] }; }
        });
        (newWires || []).forEach(function (wire) {
            var fromIsNew = placeholderIds[wire.from];
            var toIsNew = placeholderIds[wire.to];
            if (!fromIsNew && toIsNew) {
                var src = RED.nodes.node(wire.from);
                if (src && typeof src.x === "number" && typeof src.y === "number") {
                    componentAnchors[componentOf[wire.to]].upstream.push(src);
                }
            } else if (fromIsNew && !toIsNew) {
                var tgt = RED.nodes.node(wire.to);
                if (tgt && typeof tgt.x === "number" && typeof tgt.y === "number") {
                    componentAnchors[componentOf[wire.from]].downstream.push(tgt);
                }
            }
        });

        // Fallback (Finding #18): a cluster with no existing-node connection
        // at all (e.g. "add a change node" with no wiring specified) anchors
        // on the user's current Modify selection instead of
        // layoutGeneratedFlow's hardcoded default (160,120), which can be far
        // outside the user's current viewport on a larger flow.
        var fallbackAnchors = [];
        if (Array.isArray(contextNodeIds)) {
            contextNodeIds.forEach(function (id) {
                var live = RED.nodes.node(id);
                if (live && typeof live.x === "number" && typeof live.y === "number") {
                    fallbackAnchors.push(live);
                }
            });
        }
        Object.keys(componentAnchors).forEach(function (c) {
            var a = componentAnchors[c];
            if (a.upstream.length === 0 && a.downstream.length === 0) {
                a.upstream = fallbackAnchors.slice();
            }
        });

        // Layout new nodes so they have x/y before adding to the graph.
        var toLayout = newNodes.map(function (n) {
            return Object.assign({}, n, { wires: Array.isArray(n.wires) ? n.wires : [[]] });
        });
        var laid = layoutGeneratedFlow(toLayout);

        // Position each cluster relative to ITS OWN anchors, centred on their
        // average Y, preserving that cluster's internal column/row layout
        // from layoutGeneratedFlow.
        // - If a cluster receives a connection FROM an existing node
        //   ("inserted after X" / "inserted between X and Y"), land 200px
        //   right of the rightmost such upstream anchor. This is correct
        //   even when downstream anchors exist further right (e.g. "insert
        //   a function between the inject and the existing debugs" should
        //   land right after the inject, not past the debugs).
        // - Otherwise (the cluster only feeds existing nodes, e.g. "add an
        //   inject that triggers this debug"), land 200px left of the
        //   leftmost downstream anchor.
        Object.keys(componentAnchors).forEach(function (c) {
            var a = componentAnchors[c];
            var anchorNodes = a.upstream.concat(a.downstream);
            if (!anchorNodes.length) { return; }

            var members = laid.filter(function (n) { return componentOf[n.id] === c; });
            var minX = members.reduce(function (m, n) { return Math.min(m, n.x); }, members[0].x);
            var minY = members.reduce(function (m, n) { return Math.min(m, n.y); }, members[0].y);

            var avgY = anchorNodes.reduce(function (s, n) { return s + n.y; }, 0) / anchorNodes.length;
            var targetX;
            if (a.upstream.length > 0) {
                var maxUpstreamX = a.upstream.reduce(function (m, n) { return Math.max(m, n.x); }, 0);
                targetX = maxUpstreamX + 200;
            } else {
                var minDownstreamX = a.downstream.reduce(function (m, n) { return Math.min(m, n.x); }, a.downstream[0].x);
                targetX = minDownstreamX - 200;
            }
            members.forEach(function (n) {
                n.x = n.x - minX + targetX;
                n.y = n.y - minY + avgY;
            });
        });

        // Build placeholder-id → real-id map and assign real ids + z.
        var idMap = {};
        laid.forEach(function (n) {
            var realId = generateNodeId();
            idMap[n.id] = realId; // n.id is the model's placeholder
            n.id = realId;
            n.z = z;
            if (!Array.isArray(n.wires)) { n.wires = [[]]; }
        });

        // Rewrite any intra-new-node wires to use real ids.
        laid.forEach(function (n) {
            n.wires = n.wires.map(function (port) {
                return Array.isArray(port) ? port.map(function (tid) {
                    return idMap[tid] || tid;
                }) : [];
            });
        });

        // Rewrite config-node references that point at another new node's
        // placeholder id — e.g. an "mqtt out" node's "broker" pointing at a
        // newly-inserted "mqtt-broker". The model reuses the same placeholder
        // ids for these as it does for wires, but only "wires" was rewritten
        // above; without this, the reference is left dangling on the
        // placeholder string and the node fails validation at Deploy.
        laid.forEach(function (n) {
            if (n.type === "junction") { return; }
            var typeDef = RED.nodes.getType(n.type);
            if (!typeDef || !typeDef.defaults) { return; }
            Object.keys(typeDef.defaults).forEach(function (k) {
                var def = typeDef.defaults[k];
                if (def && def.type && typeof n[k] === "string" && idMap[n[k]]) {
                    n[k] = idMap[n[k]];
                }
            });
        });

        // Add each node to the live graph.
        // RED.nodes.add requires _def (the type's registration object) to be
        // set on the node — it's what the undo system restores, not a raw cfg.
        var addedNodes = [];
        var addedJunctions = [];
        var insertFailed = false;
        laid.forEach(function (n) {
            // Junctions (wire-splice points) are NOT registered node types —
            // RED.nodes.getType("junction") returns undefined, so the regular
            // RED.nodes.add path below would reject them as "not installed".
            // They're added via RED.nodes.addJunction with a different shape
            // (no defaults/_def beyond a stub), mirroring the object NR's own
            // "split wire with junction" action builds (red.js addJunctionsToWires).
            if (n.type === "junction") {
                var junctionObj = {
                    _def: { defaults: {} },
                    type: "junction",
                    z: n.z,
                    id: n.id,
                    x: n.x,
                    y: n.y,
                    w: 0,
                    h: 0,
                    inputs: 1,
                    outputs: 1,
                    dirty: true,
                    moved: true
                };
                try {
                    junctionObj = RED.nodes.addJunction(junctionObj);
                    addedJunctions.push(junctionObj);
                } catch (e) {
                    addMessage("error", "Failed to add junction: " + (e.message || e));
                    insertFailed = true;
                }
                return;
            }

            var typeDef = RED.nodes.getType(n.type);
            if (!typeDef) {
                addMessage("error", "Node type not installed: " + n.type);
                insertFailed = true;
                return;
            }
            n._def = typeDef;
            // inputs/outputs are runtime state that add() reads from the node
            // object directly — it doesn't copy them from _def automatically.
            if (typeof n.inputs === "undefined") {
                n.inputs = typeDef.inputs !== undefined ? typeDef.inputs : 1;
            }
            if (typeof n.outputs === "undefined") {
                n.outputs = typeDef.outputs !== undefined
                    ? typeDef.outputs
                    : (Array.isArray(n.wires) ? n.wires.length : 0);
            }
            // Apply type-definition defaults for any property the model omitted.
            // This covers required fields (e.g. statusVal/statusType on debug)
            // that oneditsave would normally set, preventing a spurious triangle.
            if (typeDef.defaults) {
                Object.keys(typeDef.defaults).forEach(function (k) {
                    if (n[k] === undefined) {
                        var d = typeDef.defaults[k];
                        if (d && d.value !== undefined) { n[k] = d.value; }
                    }
                });
            }
            try {
                RED.nodes.add(n);
                // Try the public validator; if it isn't exposed or still leaves
                // the node invalid, clear the triangle explicitly — real
                // validation runs at edit-dialog-close and at Deploy.
                if (typeof RED.nodes.validateNode === "function") {
                    RED.nodes.validateNode(n);
                }
                if (!n.valid) { n.valid = true; n.validationErrors = []; }
                addedNodes.push(n);
            } catch (e) {
                addMessage("error", "Failed to add node '" + (n.type || "?") + "': " + (e.message || e));
                insertFailed = true;
            }
        });
        if (insertFailed || (!addedNodes.length && !addedJunctions.length)) { return; }

        // Re-link config-node "users" now that all new nodes (including any
        // new config nodes, e.g. mqtt-broker) exist. addNode() ran this
        // per-node as it was added, but a node added BEFORE its config-node
        // dependency wouldn't have found it in configNodes yet — without this,
        // the config node shows 0 users and may not be included on Deploy.
        if (typeof RED.nodes.updateConfigNodeUsers === "function") {
            addedNodes.forEach(function (n) {
                RED.nodes.updateConfigNodeUsers(n, { action: "add" });
            });
        }

        // Resolve newWires refs and add link objects. findLiveNode (not
        // RED.nodes.node) because endpoints may be junctions we just added —
        // junctions live in RED.nodes.junctions(z), not the normal registry.
        var addedLinks = [];
        (newWires || []).forEach(function (wire) {
            var fromId = idMap[wire.from] || wire.from;
            var toId = idMap[wire.to] || wire.to;
            var fromNode = findLiveNode(fromId);
            var toNode = findLiveNode(toId);
            if (!fromNode || !toNode) {
                addMessage("error", "Cannot wire — node not found: " + (!fromNode ? fromId : toId));
                return;
            }
            var link = { source: fromNode, sourcePort: wire.fromPort || 0, target: toNode };
            try {
                RED.nodes.addLink(link);
                addedLinks.push(link);
            } catch (e) {
                addMessage("error", "Failed to add wire: " + (e.message || e));
            }
        });

        // Also process wires inside newNodes that reference existing nodes.
        // The model uses "wires" for intra-new-node connections and "newWires"
        // for cross-boundary connections, but it may also use "wires" to point
        // to existing nodes (e.g. a new junction wired to an existing debug).
        laid.forEach(function (newNode) {
            if (!newNode.wires || !Array.isArray(newNode.wires)) { return; }
            newNode.wires.forEach(function (portWires, portIndex) {
                if (!Array.isArray(portWires)) { return; }
                portWires.forEach(function (targetId) {
                    // Skip if this is an intra-new-node wire (placeholder id)
                    if (idMap[targetId]) { return; }
                    // This is a wire to an existing node - create the link
                    var fromNode = findLiveNode(newNode.id);
                    var toNode = findLiveNode(targetId);
                    if (!fromNode || !toNode) {
                        addMessage("error", "Cannot wire new node to existing node — node not found: " + (!fromNode ? newNode.id : targetId));
                        return;
                    }
                    var link = { source: fromNode, sourcePort: portIndex, target: toNode };
                    try {
                        RED.nodes.addLink(link);
                        addedLinks.push(link);
                    } catch (e) {
                        addMessage("error", "Failed to add wire: " + (e.message || e));
                    }
                });
            });
        });

        // One compound undo entry covers both the new nodes and their wires.
        // NB: for t:"add", ev.nodes must be an array of ID STRINGS — NR's undo
        // does RED.nodes.node(ev.nodes[i]) then reads .z, which throws (and
        // silently breaks Ctrl+Z) if given node objects instead of ids.
        RED.history.push({
            t: "add",
            nodes: addedNodes.map(function (n) { return n.id; }),
            links: addedLinks,
            groups: [],
            junctions: addedJunctions,
            subflow: { id: undefined, instances: [] },
            subflowInputs: [],
            subflowOutputs: [],
            dirty: RED.nodes.dirty()
        });

        RED.nodes.dirty(true);
        RED.view.redraw(true);

        // Ground follow-up turns in what was just inserted.
        var insertedNote = "Touchdown — inserted " + (addedNodes.length + addedJunctions.length) + " node(s)" +
            (addedLinks.length ? " and added " + addedLinks.length + " wire connection(s)" : "") +
            ". Ctrl+Z to undo.";
        addMessage("assistant", insertedNote);
        pushHistory("assistant", insertedNote);
        updateSelectionStatus();

        // Returned so applyModifications can resolve Tier 3 wire-diff targets
        // that point at one of these placeholder ids (e.g. an existing node's
        // "wires" rewired to a brand-new node added in the same response).
        return idMap;
    }

    // Look up a live node by id, falling back to the per-tab junction
    // registry, then the group registry. Junction nodes (wire-splice
    // points) and groups are NOT in RED.nodes.node()'s normal registry —
    // confirmed via core source (red.js's getNode() only checks
    // configNodes/allNodes) — junctions live in RED.nodes.junctions(z),
    // groups in RED.nodes.group(id). Without these fallbacks, a
    // modNode/removeNodes id referring to either reads as "not found",
    // which (in addModifyReview) renders "⚠ Node not found in editor" and
    // blocks Apply entirely.
    function findLiveNode(id) {
        var node = (RED.nodes && RED.nodes.node) ? RED.nodes.node(id) : null;
        if (node) { return node; }
        if (RED.nodes.junctions && RED.workspaces && RED.workspaces.active) {
            var activeZ = RED.workspaces.active();
            var junctionsOnTab = RED.nodes.junctions(activeZ) || [];
            for (var i = 0; i < junctionsOnTab.length; i++) {
                if (junctionsOnTab[i].id === id) { return junctionsOnTab[i]; }
            }
        }
        if (RED.nodes.group) {
            var grp = RED.nodes.group(id);
            if (grp) { return grp; }
        }
        return null;
    }

    // Compare a live editor node against a returned (modified) node, key by
    // key. We only diff keys present in the returned node — internal editor
    // fields the model omits are untouched on apply and excluded from the diff.
    // `wires` is separated out so the review can flag it without applying it.
    function computeNodeDiff(liveNode, modNode) {
        var propertyChanges = [];
        var wiresChanged = false;
        Object.keys(modNode).forEach(function (k) {
            if (DIFF_SKIP[k]) { return; }
            var newRaw = modNode[k];
            // If the model echoed a sanitizer sentinel, the field is opaque —
            // we can't meaningfully compare or apply it, so skip entirely.
            if (isSanitizeSentinel(newRaw)) { return; }
            var oldRaw = liveNode ? liveNode[k] : undefined;
            var oldStr, newStr;
            try { oldStr = JSON.stringify(oldRaw); } catch (e) { oldStr = String(oldRaw); }
            try { newStr = JSON.stringify(newRaw); } catch (e) { newStr = String(newRaw); }
            if (oldStr === newStr) { return; }
            if (k === "wires") { wiresChanged = true; return; }
            propertyChanges.push({ key: k, oldVal: oldRaw, newVal: newRaw });
        });
        return { propertyChanges: propertyChanges, wiresChanged: wiresChanged };
    }

    // Diff outgoing wires for an existing node: compare what's live in the graph
    // against what the model returned. Returns { toRemove, toAdd } each an array
    // of { sourcePort, targetId }. Used by Tier 3 (rewire) to apply wire changes.
    //
    // validTargetIds is the set of node ids the model actually had in context
    // (i.e. ids present in the returned "flow"). The model can't see or preserve
    // connections to nodes outside its selection, so a live connection whose
    // target is NOT in validTargetIds is left alone even if it's missing from
    // modelWires — otherwise every out-of-context connection would look like an
    // unintended removal (e.g. a node wired to a debug node that wasn't selected).
    function computeWireDiff(nodeId, modelWires, validTargetIds) {
        var currentByPort = {};
        RED.nodes.eachLink(function (l) {
            if (l.source && l.source.id === nodeId) {
                var port = l.sourcePort || 0;
                if (!currentByPort[port]) { currentByPort[port] = []; }
                currentByPort[port].push(l.target.id);
            }
        });

        var desiredByPort = {};
        var wires = Array.isArray(modelWires) ? modelWires : [];
        wires.forEach(function (targets, port) {
            if (Array.isArray(targets) && targets.length > 0) {
                desiredByPort[port] = targets.slice();
            }
        });

        var toRemove = [];
        Object.keys(currentByPort).forEach(function (port) {
            var portNum = parseInt(port, 10);
            var curTargets = currentByPort[port];
            var desTargets = desiredByPort[portNum] || [];
            curTargets.forEach(function (tid) {
                if (desTargets.indexOf(tid) === -1 && validTargetIds && validTargetIds[tid]) {
                    toRemove.push({ sourcePort: portNum, targetId: tid });
                }
            });
        });

        var toAdd = [];
        Object.keys(desiredByPort).forEach(function (port) {
            var portNum = parseInt(port, 10);
            var desTargets = desiredByPort[port];
            var curTargets = currentByPort[portNum] || [];
            desTargets.forEach(function (tid) {
                if (curTargets.indexOf(tid) === -1) {
                    toAdd.push({ sourcePort: portNum, targetId: tid });
                }
            });
        });

        return { toRemove: toRemove, toAdd: toAdd };
    }

    function formatDiffVal(v) {
        if (v === undefined || v === null) { return "(none)"; }
        if (typeof v === "object") { return JSON.stringify(v); }
        return String(v);
    }

    // Tabbed diff review for a modify response. Shows property diffs for
    // existing nodes and, when the model also returned new nodes to insert,
    // a list of those plus the wire connections to be made. The Apply button
    // label adapts: "Apply Changes" / "Insert Nodes" / "Apply & Insert".
    // buildFixInfo: present only for a /build loop review's fix envelope
    // (handleBuildReviewResult) — `{ capReached }`, carried in the pop-out's
    // relay tag since applying there also needs the loop bookkeeping
    // applyBuildLoopFix does, not just applyModifications.
    // newGroups: Phase 8.5 C2 slice 3 — see applyGroupChanges.
    function addModifyReview(modifiedFlow, newNodes, newWires, removeNodes, applyCallback, buildFixInfo, newGroups) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }

        var nodes = Array.isArray(modifiedFlow) ? modifiedFlow : [];
        newNodes = Array.isArray(newNodes) ? newNodes : [];
        newWires = Array.isArray(newWires) ? newWires : [];
        removeNodes = Array.isArray(removeNodes) ? removeNodes : [];
        newGroups = Array.isArray(newGroups) ? newGroups : [];

        // Ids the model actually had in context (the returned "flow"). Used by
        // computeWireDiff to avoid flagging connections to out-of-context nodes
        // as removals — the model can't see or preserve those.
        var validTargetIds = {};
        nodes.forEach(function (n) { if (n && n.id) { validTargetIds[n.id] = true; } });

        // Match each returned node to its live counterpart and compute diffs.
        // wiresDiff is computed from the live graph via eachLink, not from
        // node.wires (which is empty in the live editor — export-time artifact).
        var nodeDiffs = nodes.map(function (modNode) {
            var liveNode = findLiveNode(modNode.id);
            var diff = computeNodeDiff(liveNode || {}, modNode);
            var wiresDiff = (diff.wiresChanged && liveNode)
                ? computeWireDiff(modNode.id, modNode.wires, validTargetIds)
                : { toRemove: [], toAdd: [] };
            return {
                modNode: modNode,
                liveNode: liveNode,
                propertyChanges: diff.propertyChanges,
                wiresChanged: diff.wiresChanged,
                wiresDiff: wiresDiff,
                name: modNode.name || (liveNode && liveNode.name) || "",
                type: modNode.type || (liveNode && liveNode.type) || ""
            };
        });

        var totalPropChanges = nodeDiffs.reduce(function (s, d) {
            return s + d.propertyChanges.length;
        }, 0);
        var nodesWithChanges = nodeDiffs.filter(function (d) {
            return d.propertyChanges.length > 0;
        }).length;
        var missingLive = nodeDiffs.some(function (d) { return !d.liveNode; });
        var hasPropChanges = totalPropChanges > 0;
        var hasWireChanges = nodeDiffs.some(function (d) {
            return d.wiresDiff && (d.wiresDiff.toRemove.length > 0 || d.wiresDiff.toAdd.length > 0);
        });
        var hasNewNodes = newNodes.length > 0;
        var hasRemoveNodes = removeNodes.length > 0;
        var hasNewGroups = newGroups.length > 0;
        var hasAnyChanges = hasPropChanges || hasWireChanges || hasNewNodes || hasRemoveNodes || hasNewGroups;

        var $msg = $("<div>").addClass("fp-message fp-review");
        $("<div>").addClass("fp-label").text("MODIFY FLOW — REVIEW CHANGES").appendTo($msg);

        var $tabSummary = $("<button>").addClass("fp-tab fp-tab-active").attr("type", "button").text("Summary");
        var $tabJson = $("<button>").addClass("fp-tab").attr("type", "button").text("JSON");
        $("<div>").addClass("fp-tabs").append($tabSummary, $tabJson).appendTo($msg);

        var $summaryPanel = $("<div>").addClass("fp-tab-panel");
        var $jsonPanel = $("<div>").addClass("fp-tab-panel fp-hidden");
        $msg.append($summaryPanel, $jsonPanel);

        // ---- Summary tab: property diffs for existing nodes ----
        // Only show this section when there are actual property changes —
        // "0 of N will change" is confusing when we're purely inserting or rewiring.
        if (hasPropChanges) {
            $("<div>").addClass("fp-review-count")
                .text(nodesWithChanges + " of " + nodes.length + " node(s) will change:")
                .appendTo($summaryPanel);
            nodeDiffs.forEach(function (d) {
                if (d.propertyChanges.length === 0) { return; }
                var $section = $("<div>").addClass("fp-diff-node").appendTo($summaryPanel);
                var title = d.type + (d.name ? " — \"" + d.name + "\"" : "");
                $("<div>").addClass("fp-diff-node-title").text(title).appendTo($section);
                if (!d.liveNode) {
                    $("<div>").addClass("fp-diff-warn")
                        .text("⚠ Node not found in editor (id: " + d.modNode.id + ")")
                        .appendTo($section);
                    return;
                }
                d.propertyChanges.forEach(function (c) {
                    var $row = $("<div>").addClass("fp-diff-row").appendTo($section);
                    $("<span>").addClass("fp-diff-key").text(c.key).appendTo($row);
                    $("<span>").addClass("fp-diff-old").text(formatDiffVal(c.oldVal)).appendTo($row);
                    $("<span>").addClass("fp-diff-arrow").text("→").appendTo($row);
                    $("<span>").addClass("fp-diff-new").text(formatDiffVal(c.newVal)).appendTo($row);
                });
            });
        }

        // ---- Summary tab: wiring changes (Tier 3) ----
        // Shown when model changed wires on existing nodes. Removed wires appear
        // in the old column (red strikethrough); added wires in the new column (green).
        if (hasWireChanges) {
            var sectionTop = hasPropChanges ? "12px" : "0";
            $("<div>").addClass("fp-review-count").css("margin-top", sectionTop)
                .text("Wiring changes:")
                .appendTo($summaryPanel);
            nodeDiffs.forEach(function (d) {
                var wd = d.wiresDiff;
                if (!wd || (!wd.toRemove.length && !wd.toAdd.length)) { return; }
                var $section = $("<div>").addClass("fp-diff-node").appendTo($summaryPanel);
                var title = d.type + (d.name ? " — \"" + d.name + "\"" : "");
                $("<div>").addClass("fp-diff-node-title").text(title).appendTo($section);
                wd.toRemove.forEach(function (entry) {
                    var tgt = RED.nodes.node ? RED.nodes.node(entry.targetId) : null;
                    var tgtLabel = tgt ? (tgt.name || tgt.type || entry.targetId) : entry.targetId;
                    var $row = $("<div>").addClass("fp-diff-row").appendTo($section);
                    $("<span>").addClass("fp-diff-key").text("port " + entry.sourcePort).appendTo($row);
                    $("<span>").addClass("fp-diff-old").text("→ " + tgtLabel).appendTo($row);
                    $("<span>").addClass("fp-diff-arrow").text("✕").appendTo($row);
                    $("<span>").addClass("fp-diff-new").text("").appendTo($row);
                });
                wd.toAdd.forEach(function (entry) {
                    var tgt = RED.nodes.node ? RED.nodes.node(entry.targetId) : null;
                    var tgtLabel = tgt ? (tgt.name || tgt.type || entry.targetId) : entry.targetId;
                    var $row = $("<div>").addClass("fp-diff-row").appendTo($section);
                    $("<span>").addClass("fp-diff-key").text("port " + entry.sourcePort).appendTo($row);
                    $("<span>").addClass("fp-diff-old").text("").appendTo($row);
                    $("<span>").addClass("fp-diff-arrow").text("→").appendTo($row);
                    $("<span>").addClass("fp-diff-new").text(tgtLabel).appendTo($row);
                });
            });
        }

        // ---- Summary tab: nodes to remove (Tier 4) ----
        if (hasRemoveNodes) {
            var rmTop = (hasPropChanges || hasWireChanges) ? "12px" : "0";
            $("<div>").addClass("fp-review-count fp-diff-warn").css("margin-top", rmTop)
                .text(removeNodes.length + " node(s) to remove:")
                .appendTo($summaryPanel);
            var $rmList = $("<ul>").addClass("fp-review-list").appendTo($summaryPanel);
            removeNodes.forEach(function (id) {
                var lv = RED.nodes.node ? RED.nodes.node(id) : null;
                var label = lv ? ((lv.name || lv.type || id) + " (" + id + ")") : id + " (not found)";
                $("<li>").addClass("fp-diff-warn").text("✕ " + label).appendTo($rmList);
            });
            $("<div>").addClass("fp-diff-warn").css("margin-top", "4px")
                .text("All wires to/from removed nodes will also be deleted.")
                .appendTo($summaryPanel);
        }

        // ---- Summary tab: new nodes to insert ----
        if (hasNewNodes) {
            var insTop = (hasPropChanges || hasWireChanges || hasRemoveNodes) ? "12px" : "0";
            $("<div>").addClass("fp-review-count").css("margin-top", insTop)
                .text(newNodes.length + " node(s) to insert:")
                .appendTo($summaryPanel);
            var $newList = $("<ul>").addClass("fp-review-list").appendTo($summaryPanel);
            newNodes.forEach(function (n) {
                $("<li>").text((n.type || "unknown") + (n.name ? " — \"" + n.name + "\"" : "")).appendTo($newList);
            });
            if (newWires.length > 0) {
                $("<div>").addClass("fp-review-count").css("margin-top", "8px")
                    .text(newWires.length + " wire connection(s):")
                    .appendTo($summaryPanel);
                var $wireList = $("<ul>").addClass("fp-review-list").appendTo($summaryPanel);
                newWires.forEach(function (wire) {
                    var fromLabel = resolveWireRef(wire.from, newNodes);
                    var toLabel = resolveWireRef(wire.to, newNodes);
                    var portNote = (wire.fromPort && wire.fromPort > 0) ? " [port " + wire.fromPort + "]" : "";
                    $("<li>").text(fromLabel + portNote + " → " + toLabel).appendTo($wireList);
                });
            }
        }

        // ---- Summary tab: groups to create/update ----
        if (hasNewGroups) {
            var grpTop = (hasPropChanges || hasWireChanges || hasRemoveNodes || hasNewNodes) ? "12px" : "0";
            $("<div>").addClass("fp-review-count").css("margin-top", grpTop)
                .text(newGroups.length + " group(s) to create/update:")
                .appendTo($summaryPanel);
            var $grpList = $("<ul>").addClass("fp-review-list").appendTo($summaryPanel);
            newGroups.forEach(function (g) {
                var label = (g.name ? "\"" + g.name + "\"" : "(unnamed group)") +
                    " — " + (Array.isArray(g.nodes) ? g.nodes.length : 0) + " node(s)";
                $("<li>").text(label).appendTo($grpList);
            });
        }

        // ---- JSON tab ----
        var jsonPayload = (hasNewNodes || hasRemoveNodes || hasNewGroups)
            ? { modifiedNodes: nodes, newNodes: newNodes, newWires: newWires, removeNodes: removeNodes, newGroups: newGroups }
            : nodes;
        var jsonText = JSON.stringify(jsonPayload, null, 2);
        var $copyBtn = $("<button>")
            .addClass("red-ui-button red-ui-button-small")
            .attr("type", "button")
            .text("Copy")
            .on("click", function () { copyToClipboard($copyBtn, jsonText); });
        $("<div>").addClass("fp-json-toolbar").append($copyBtn).appendTo($jsonPanel);
        $("<pre>").addClass("fp-json").text(jsonText).appendTo($jsonPanel);

        function activateTab(showSummary) {
            $tabSummary.toggleClass("fp-tab-active", showSummary);
            $tabJson.toggleClass("fp-tab-active", !showSummary);
            $summaryPanel.toggleClass("fp-hidden", !showSummary);
            $jsonPanel.toggleClass("fp-hidden", showSummary);
        }
        $tabSummary.on("click", function () { activateTab(true); });
        $tabJson.on("click", function () { activateTab(false); });

        // ---- Action row ----
        var $actions = $("<div>").addClass("fp-review-actions").appendTo($msg);
        if (!hasAnyChanges) {
            $("<div>").addClass("fp-review-hint")
                .text("No changes detected — nothing to apply.")
                .appendTo($actions);
        } else if (missingLive && (hasPropChanges || hasWireChanges)) {
            $("<div>").addClass("fp-warning")
                .text("One or more nodes could not be found in the editor. Cannot apply safely.")
                .appendTo($actions);
        } else {
            var hasMutations = hasPropChanges || hasWireChanges || hasRemoveNodes;
            var btnLabel = (hasMutations && hasNewNodes) ? "Apply & Insert"
                : hasMutations ? "Apply Changes"
                : hasNewNodes ? "Insert Nodes"
                : "Apply Changes"; // covers a request that ONLY creates/updates a group

            // Pop-out: tag this panel with everything applyInsertions/
            // applyModifications/applyGroupChanges need to re-run from a
            // relayed click — nodeDiffs re-serialized without liveNode (a
            // live RED node object, not JSON-safe; applyModifications
            // re-fetches it itself via findLiveNode anyway, so nothing is
            // lost). A plain Modify call (applyCallback is the bare
            // applyModifications reference) gets "data-fp-apply-modify"; a
            // /build loop fix (buildFixInfo set — see applyBuildLoopFix)
            // gets "data-fp-apply-build-fix" instead, carrying capReached
            // too since the relayed click needs to run the SAME loop
            // bookkeeping a local click would, not just applyModifications.
            var sharedApplyData = {
                nodeDiffs: nodeDiffs.map(function (d) {
                    return {
                        modNode: d.modNode,
                        propertyChanges: d.propertyChanges,
                        wiresChanged: d.wiresChanged,
                        wiresDiff: d.wiresDiff,
                        name: d.name,
                        type: d.type
                    };
                }),
                removeNodes: removeNodes,
                newNodes: newNodes,
                newWires: newWires,
                newGroups: newGroups,
                existingNodeIds: nodes.map(function (n) { return n.id; }),
                hasMutations: hasMutations
            };
            if (applyCallback === applyModifications) {
                $msg.attr("data-fp-apply-modify", JSON.stringify(sharedApplyData));
            } else if (buildFixInfo) {
                sharedApplyData.capReached = !!buildFixInfo.capReached;
                $msg.attr("data-fp-apply-build-fix", JSON.stringify(sharedApplyData));
            }

            var $applyBtn = $("<button>")
                .addClass("red-ui-button red-ui-button-primary")
                .attr("type", "button")
                .text(btnLabel)
                .on("click", function () {
                    $applyBtn.prop("disabled", true).text("Applying…");
                    // Insertions run FIRST so their placeholder→real-id map is
                    // available to applyModifications/applyGroupChanges — an
                    // existing node's rewired "wires" (Tier 3) or a new
                    // group's membership may point at a node being inserted
                    // in this same response.
                    var idMap = {};
                    if (hasNewNodes) {
                        idMap = applyInsertions(newNodes, newWires, nodes.map(function (n) { return n.id; })) || {};
                    }
                    if (hasMutations && applyCallback) { applyCallback(nodeDiffs, removeNodes, null, idMap); }
                    if (hasNewGroups) { applyGroupChanges(newGroups, idMap); }
                    $applyBtn.text("Done ✓");
                });
            $actions.append($applyBtn);
            var hintParts = [];
            if (hasPropChanges || hasWireChanges) { hintParts.push("changes mutate live nodes"); }
            if (hasRemoveNodes) { hintParts.push("removals delete nodes"); }
            if (hasNewGroups) { hintParts.push("groups are created/updated"); }
            if (hasNewNodes) { hintParts.push("insertions add new nodes"); }
            var hintText = "Review above — " + hintParts.join(", ") + ". Ctrl+Z to undo.";
            $("<span>").addClass("fp-review-hint").text(hintText).appendTo($actions);
        }

        $box.append($msg);
        scrollMessagesToBottom();
    }

    // Apply mechanism covering all modification tiers:
    //   Tier 1 — property changes: mutate live node + {t:"edit"} history entry
    //   Tier 3 — wire changes: removeLink/addLink + {t:"add", removedLinks} entry
    //   Tier 4 — node removals: collect links, removeLink, remove node + {t:"delete"} entry
    // One history entry per node per type so Ctrl+Z steps back through them cleanly.
    function applyModifications(nodeDiffs, removeNodes, $applyBtn, idMap) {
        idMap = idMap || {};
        var propApplied = 0;
        var wireNodesApplied = 0;
        var nodesRemoved = 0;
        var failed = [];
        removeNodes = Array.isArray(removeNodes) ? removeNodes : [];

        // --- Tier 1: property changes ---
        nodeDiffs.forEach(function (d) {
            if (d.propertyChanges.length === 0) { return; }
            var liveNode = findLiveNode(d.modNode.id);
            if (!liveNode) { failed.push(d.modNode.id); return; }

            var oldValues = {};
            d.propertyChanges.forEach(function (c) { oldValues[c.key] = liveNode[c.key]; });
            d.propertyChanges.forEach(function (c) { liveNode[c.key] = c.newVal; });

            // Switch nodes derive their port count from rules.length (the edit
            // dialog's "outputCount" map assigns each rule its own output and
            // writes the resulting count to node.outputs on save). FlowPilot's
            // direct mutation above changes "rules" but never touches
            // "outputs", leaving the canvas showing the old port count even
            // though the new wires/rules are correct. Recompute it here so
            // RED.view.redraw(true) (below) rebuilds the ports - the redraw
            // loop rebuilds a node's output ports whenever __outputs__.length
            // !== d.outputs.
            if (liveNode.type === "switch" && Array.isArray(liveNode.rules) &&
                    liveNode.rules.length !== liveNode.outputs) {
                if (!oldValues.hasOwnProperty("outputs")) { oldValues.outputs = liveNode.outputs; }
                liveNode.outputs = liveNode.rules.length;
            }

            liveNode.changed = true;
            liveNode.dirty = true;
            RED.history.push({
                t: "edit",
                node: liveNode,
                changes: oldValues,
                dirty: RED.nodes.dirty()
            });
            propApplied++;
        });

        // --- Tier 3: wire changes ---
        // removeLink old + addLink new, then push ONE {t:"add", removedLinks} entry
        // per node. NR's undo for this shape removes the new links AND restores
        // the old ones (removedLinks field is present on every "add" wire event).
        nodeDiffs.forEach(function (d) {
            var wd = d.wiresDiff;
            if (!wd || (!wd.toRemove.length && !wd.toAdd.length)) { return; }
            var liveNode = findLiveNode(d.modNode.id);
            if (!liveNode) { return; }

            var removedLinks = [];
            var addedLinks = [];

            wd.toRemove.forEach(function (entry) {
                var found = null;
                RED.nodes.eachLink(function (l) {
                    if (found) { return; }
                    if (l.source && l.source.id === d.modNode.id &&
                            (l.sourcePort || 0) === entry.sourcePort &&
                            l.target && l.target.id === entry.targetId) {
                        found = l;
                    }
                });
                if (found) {
                    RED.nodes.removeLink(found);
                    removedLinks.push(found);
                }
            });

            wd.toAdd.forEach(function (entry) {
                // entry.targetId may be a placeholder id for a node inserted
                // by the SAME response (e.g. "fp-new-0") — resolve it to the
                // real id applyInsertions just assigned, if any.
                var targetId = idMap[entry.targetId] || entry.targetId;
                var toNode = (RED.nodes && RED.nodes.node) ? RED.nodes.node(targetId) : null;
                if (!toNode) { return; }
                var link = { source: liveNode, sourcePort: entry.sourcePort, target: toNode };
                try {
                    RED.nodes.addLink(link);
                    addedLinks.push(link);
                } catch (e) {
                    addMessage("error", "Failed to add wire: " + (e.message || e));
                }
            });

            if (removedLinks.length || addedLinks.length) {
                RED.history.push({
                    t: "add",
                    links: addedLinks,
                    removedLinks: removedLinks,
                    dirty: RED.nodes.dirty()
                });
                wireNodesApplied++;
            }
        });

        // --- Tier 4: node removals ---
        // Collect connected links BEFORE removing anything (for the history entry),
        // then remove the node — RED.nodes.remove(id) cleans up its own links
        // internally. RED.nodes.remove(id) takes an ID STRING (not a node object —
        // confirmed via red.js: removeNode(id) does `allNodes.hasNode(id)`, which
        // a node object fails silently, making it a no-op with no error). Push one
        // compound {t:"delete"} entry per node so a single Ctrl+Z restores both
        // the node and its links.
        //
        // Junction nodes (wire-splice points) are removed via
        // RED.nodes.removeJunction(junctionObj) (object, not id), with the
        // history entry's junction going in `junctions`, not `nodes` —
        // findLiveNode's junction-registry fallback returns the junction
        // object itself, which doubles as the isJunction check via .type.
        removeNodes.forEach(function (id) {
            var liveNode = findLiveNode(id);
            var isJunction = !!(liveNode && liveNode.type === "junction");

            if (!liveNode) { failed.push(id); return; }

            var connectedLinks = [];
            RED.nodes.eachLink(function (l) {
                if ((l.source && l.source.id === id) || (l.target && l.target.id === id)) {
                    connectedLinks.push(l);
                }
            });

            try {
                if (isJunction) {
                    RED.nodes.removeJunction(liveNode);
                } else {
                    RED.nodes.remove(liveNode.id);
                }
            } catch (e) {
                addMessage("error", "Failed to remove node " + id + ": " + (e.message || e));
                return;
            }

            // RED.nodes.remove()/removeJunction() do NOT clean up group
            // membership at all (confirmed via core source — getNode()'s
            // removal path never touches .g or group.nodes). Node-RED's
            // own UI delete action does this extra bookkeeping itself
            // (red.js's deleteSelection(), ~line 27151) rather than baking
            // it into the data-model removal call — replicate it here so a
            // removed grouped node doesn't leave a dangling reference in
            // group.nodes with a stale bounding box.
            if (liveNode.g && RED.nodes.group) {
                var ownerGroup = RED.nodes.group(liveNode.g);
                if (ownerGroup) {
                    var memberIdx = ownerGroup.nodes.indexOf(liveNode);
                    if (memberIdx !== -1) { ownerGroup.nodes.splice(memberIdx, 1); }
                    RED.group.markDirty(ownerGroup);
                }
            }

            RED.history.push({
                t: "delete",
                nodes: isJunction ? [] : [liveNode],
                links: connectedLinks,
                groups: [],
                junctions: isJunction ? [liveNode] : [],
                subflow: { id: undefined, instances: [] },
                subflowInputs: [],
                subflowOutputs: [],
                dirty: RED.nodes.dirty()
            });
            nodesRemoved++;
        });

        RED.nodes.dirty(true);
        RED.view.redraw(true);

        if ($applyBtn) { $applyBtn.prop("disabled", true).text("Applied ✓"); }

        var parts = [];
        if (propApplied) { parts.push("changes to " + propApplied + " node(s)"); }
        if (wireNodesApplied) { parts.push("wiring updates on " + wireNodesApplied + " node(s)"); }
        if (nodesRemoved) { parts.push("removed " + nodesRemoved + " node(s)"); }

        if (failed.length) {
            addMessage("error",
                (parts.length ? "Applied: " + parts.join(", ") + ". " : "") +
                failed.length + " node(s) not found and skipped: " + failed.join(", "));
        } else if (parts.length) {
            // Ground follow-up turns ("now undo the topic
            // change") in what was actually applied.
            var appliedNote = "Touchdown — applied " + parts.join(", ") + ". Ctrl+Z to undo.";
            addMessage("assistant", appliedNote);
            pushHistory("assistant", appliedNote);
            updateSelectionStatus();
        }
    }

    // Reconciles a Modify response's "newGroups" entries (Phase 8.5 C2
    // slice 3) against live state. Each entry's "nodes" is the FULL
    // desired membership for that group id — declarative, like "changes"
    // — not a one-shot "add these" instruction:
    //   - If a LIVE group already exists with this id (the model learned
    //     about it via sanitizeNode's context "group" field), membership
    //     is diffed against what's actually there now and reconciled via
    //     RED.group.addToGroup/removeFromGroup (both confirmed via core
    //     source to handle bounding-box math + dirty-marking themselves —
    //     nothing to reimplement), and a changed "name" is applied as a
    //     direct property edit, same shape as Tier 1.
    //   - If no live group matches, RED.group.createGroup(memberNodes)
    //     makes a brand new one — it always assigns its OWN fresh id
    //     (RED.nodes.id()), unlike applyInsertions' regular nodes, so
    //     there's no idMap entry to register for it (nothing in v1 wires
    //     to a group afterward anyway).
    // One RED.history.push per discrete operation (matching how Node-RED's
    // own group UI actions push them separately too), not one giant batch.
    function applyGroupChanges(newGroups, idMap) {
        idMap = idMap || {};
        newGroups = Array.isArray(newGroups) ? newGroups : [];
        var groupsApplied = 0;

        newGroups.forEach(function (g) {
            if (!g || !g.id) { return; }
            var memberIds = Array.isArray(g.nodes) ? g.nodes : [];
            var memberNodes = memberIds.map(function (ref) {
                return findLiveNode(idMap[ref] || ref);
            }).filter(function (n) { return !!n; });
            if (!memberNodes.length) { return; }

            var liveGroup = findLiveNode(g.id);
            if (liveGroup && liveGroup.type === "group") {
                var desiredIds = {};
                memberNodes.forEach(function (n) { desiredIds[n.id] = true; });
                var currentIds = {};
                liveGroup.nodes.forEach(function (n) { currentIds[n.id] = true; });
                var toRemove = liveGroup.nodes.filter(function (n) { return !desiredIds[n.id]; });
                var toAdd = memberNodes.filter(function (n) { return !currentIds[n.id]; });

                if (toRemove.length) {
                    RED.group.removeFromGroup(liveGroup, toRemove, false);
                    RED.history.push({ t: "removeFromGroup", group: liveGroup, nodes: toRemove, dirty: RED.nodes.dirty() });
                }
                if (toAdd.length) {
                    RED.group.addToGroup(liveGroup, toAdd);
                    RED.history.push({ t: "addToGroup", group: liveGroup, nodes: toAdd, dirty: RED.nodes.dirty() });
                }
                if (g.name !== undefined && g.name !== liveGroup.name) {
                    var oldName = liveGroup.name;
                    liveGroup.name = g.name;
                    liveGroup.changed = true;
                    RED.history.push({ t: "edit", node: liveGroup, changes: { name: oldName }, dirty: RED.nodes.dirty() });
                }
                groupsApplied++;
            } else {
                try {
                    var newGroup = RED.group.createGroup(memberNodes);
                    if (g.name) { newGroup.name = g.name; }
                    RED.group.markDirty(newGroup);
                    RED.history.push({ t: "createGroup", groups: [newGroup], dirty: RED.nodes.dirty() });
                    groupsApplied++;
                } catch (e) {
                    addMessage("error", "Failed to create group: " + (e.message || e));
                }
            }
        });

        if (groupsApplied) {
            RED.nodes.dirty(true);
            RED.view.redraw(true);
            var groupNote = "Touchdown — created/updated " + groupsApplied +
                " group(s). Ctrl+Z to undo.";
            addMessage("assistant", groupNote);
            pushHistory("assistant", groupNote);
        }
        return groupsApplied;
    }

    function modifyFlow() {
        // Falls back to the pinned selection if nothing is currently
        // selected, so follow-up turns need no reselection.
        var context = collectSelectionContext(activeSelectionIds());
        if (!context || !Array.isArray(context.nodes) || context.nodes.length === 0) {
            addMessage("error", "Select the node(s) you want to modify first.");
            return;
        }
        context = attachDebugContext(context);
        var $promptBox = el("#fp-prompt");
        var instruction = $promptBox.length ? $promptBox.val().trim() : "";
        if (!instruction) {
            addMessage("error", "Describe what you want to change.");
            return;
        }
        var label = "Modify: " + instruction + contextAttachmentNote(context);
        addMessage("user", label);
        // Snapshot history before pushing this turn (see send()).
        var historyPayload = buildHistoryPayload();
        pushHistory("user", label);
        $promptBox.val("");

        var ap = activeProvider();
        var isAgentLoop = ap && ap.supportsTools;

        setBusy(true);
        showPending(isAgentLoop);
        var payload = {
            prompt: instruction, context: context,
            history: historyPayload.messages, historyTruncated: historyPayload.truncated,
            conversationId: conversationId
        };

        function onModifyError(msg, xhr) {
            hidePending();
            var raw = xhr && xhr.responseJSON && xhr.responseJSON.raw;
            handleExecuteError(msg, raw);
        }

        // Explore-then-propose, same as generate(). The
        // model may call read tools (e.g. to re-check the selected node's
        // current config) before producing the modify envelope; the final
        // diff still goes through finalizeModifyResult via handleModifyResult.
        if (isAgentLoop) {
            runAgentLoop("flowpilot/modify", payload,
                { mode: "modify", context: context, prompt: instruction },
                handleModifyResult, onModifyError);
            return;
        }

        // Stream the envelope's "explanation" as it's generated; see
        // generate() for details.
        if (currentSettings.streamingEnabled) {
            payload.stream = true;
            sendExecuteStream("modify", payload, handleModifyResult);
            return;
        }

        ajaxJson("POST", "flowpilot/modify", payload, handleModifyResult, onModifyError);
    }

    // Render generated flow JSON in a preformatted, copyable block. Used for
    // the raw-response fallback when the model's reply couldn't be parsed.
    function addGeneratedJson(flowOrRaw, isRaw) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }
        var text = isRaw ? String(flowOrRaw)
            : JSON.stringify(flowOrRaw, null, 2);

        var $msg = $("<div>").addClass("fp-message");
        $("<div>").addClass("fp-label").text(isRaw ? "RAW RESPONSE" : "GENERATED FLOW (JSON)").appendTo($msg);
        $("<pre>").addClass("fp-json").text(text).appendTo($msg);
        $box.append($msg);
        scrollMessagesToBottom();
    }

    // ---- Pre-import validation ---------------------------------------------
    // Static list of Node-RED's built-in node types, used only to classify a
    // generated type as "core" vs "non-core but installed". The editor's node
    // registry can tell us whether a type is INSTALLED (RED.nodes.getType),
    // but not whether it ships with Node-RED itself — there is no documented
    // API for that, so a maintained list is the simple, stable answer (it
    // mirrors the same set the generation prompt steers the model toward).
    var CORE_NODE_TYPES = {
        "inject": true, "debug": true, "complete": true, "catch": true, "status": true,
        "link in": true, "link out": true, "link call": true, "comment": true,
        "junction": true, "unknown": true, "group": true,
        "function": true, "switch": true, "change": true, "range": true, "template": true,
        "mqtt in": true, "mqtt out": true, "mqtt-broker": true,
        "http in": true, "http response": true, "http request": true,
        "websocket in": true, "websocket out": true,
        "websocket-listener": true, "websocket-client": true,
        "tcp in": true, "tcp out": true, "tcp request": true,
        "udp in": true, "udp out": true, "tls-config": true, "httpproxy": true,
        "split": true, "join": true, "sort": true, "batch": true,
        "csv": true, "html": true, "json": true, "xml": true, "yaml": true,
        "file": true, "file in": true, "watch": true, "tail": true,
        "exec": true, "delay": true, "trigger": true
    };

    // Checks the two things only the live editor can tell us before import:
    // (1) wire integrity — every wire target id must exist in the generated
    // set (the model can hallucinate ids); (2) node-type classification —
    // core / non-core-but-installed / not-installed, via RED.nodes.getType.
    // Returns per-node summary entries plus separated warning/problem lists
    // so the review UI can render them and decide whether import is offered.
    function validateGeneratedFlow(flow) {
        var nodes = Array.isArray(flow) ? flow : [];
        var ids = {};
        nodes.forEach(function (n) {
            if (n && n.id) { ids[n.id] = true; }
        });

        var summary = [];
        var typeWarnings = [];
        var brokenWires = [];
        var realWireCount = 0;

        nodes.forEach(function (n) {
            if (!n || !n.id || !n.type) { return; }

            var isCore = !!CORE_NODE_TYPES[n.type];
            var isInstalled = !!RED.nodes.getType(n.type);
            var status = isCore ? "core" : (isInstalled ? "non-core-installed" : "not-installed");

            var entry = { id: n.id, type: n.type, name: n.name || "", status: status };
            summary.push(entry);
            if (status !== "core") { typeWarnings.push(entry); }

            (Array.isArray(n.wires) ? n.wires : []).forEach(function (port) {
                (Array.isArray(port) ? port : []).forEach(function (targetId) {
                    if (!ids[targetId]) {
                        brokenWires.push({ from: n.id, type: n.type, target: targetId });
                    } else {
                        realWireCount++;
                    }
                });
            });
        });

        // A multi-node flow with zero connections anywhere is almost always
        // a generation slip (the model omitted "wires" on every node) rather
        // than something the user actually wanted — flag it, but don't
        // block import; a handful of genuinely independent nodes is rare
        // but not impossible.
        var nonCommentCount = nodes.filter(function (n) { return n && n.type !== "comment"; }).length;
        var noConnections = nonCommentCount > 1 && realWireCount === 0;

        return { summary: summary, typeWarnings: typeWarnings, brokenWires: brokenWires, noConnections: noConnections };
    }

    // The generation prompt deliberately omits x/y ("the editor assigns those
    // on import"), but RED.view.importNodes does NOT auto-arrange nodes that
    // lack coordinates — it just places them on top of each other. So we lay
    // them out ourselves:
    //
    // - Non-comment wired nodes are split into connected components (a
    //   component = nodes reachable from each other via wires, in either
    //   direction). Each component gets its own horizontal "band", stacked
    //   top to bottom, ordered by where its first node appears in `flow`.
    //   Within a band, columns are topological depth (longest path from an
    //   in-degree-0 node) and rows stack top-to-bottom within a column —
    //   same approach as before, just scoped to one component at a time so
    //   independent chains (e.g. a scheduler pipeline vs. an HTTP endpoint)
    //   don't get interleaved into the same rows.
    // - Comment nodes have no wires to anchor them, so each is matched to
    //   the nearest non-comment node adjacent to it in the `flow` array
    //   (forward, then backward) — models place a comment next to the
    //   section it describes — and placed in a header row above that node's
    //   column, in that node's component's band.
    //
    // Config nodes (no "wires" array — e.g. mqtt-broker) are left untouched;
    // they don't live on the canvas and have no x/y/z of their own.
    function layoutGeneratedFlow(flow) {
        var COL_WIDTH = 200;
        var ROW_HEIGHT = 90;
        var BASE_X = 160;
        var BASE_Y = 120;
        var BAND_GAP_ROWS = 1;

        var nodes = Array.isArray(flow) ? flow : [];
        var wiredNodes = nodes.filter(function (n) { return n && Array.isArray(n.wires) && n.type !== "comment"; });
        var commentNodes = nodes.filter(function (n) { return n && n.type === "comment"; });

        if (!wiredNodes.length) {
            // Nothing to anchor comments to — just stack everything.
            nodes.forEach(function (n, i) {
                if (!n) { return; }
                n.x = BASE_X;
                n.y = BASE_Y + i * ROW_HEIGHT;
            });
            return nodes;
        }

        var byId = {};
        wiredNodes.forEach(function (n) { byId[n.id] = n; });

        // ---- Connected components (undirected: wires in either direction) ----
        var adjacency = {};
        wiredNodes.forEach(function (n) { adjacency[n.id] = []; });
        wiredNodes.forEach(function (n) {
            n.wires.forEach(function (port) {
                (Array.isArray(port) ? port : []).forEach(function (targetId) {
                    if (!byId[targetId]) { return; }
                    adjacency[n.id].push(targetId);
                    adjacency[targetId].push(n.id);
                });
            });
        });

        var orderIndex = {};
        nodes.forEach(function (n, i) { if (n && n.id) { orderIndex[n.id] = i; } });

        var visited = {};
        var components = [];
        wiredNodes.forEach(function (start) {
            if (visited[start.id]) { return; }
            var stack = [start.id];
            var members = [];
            visited[start.id] = true;
            while (stack.length) {
                var id = stack.pop();
                members.push(id);
                adjacency[id].forEach(function (neighborId) {
                    if (!visited[neighborId]) { visited[neighborId] = true; stack.push(neighborId); }
                });
            }
            components.push(members);
        });

        // Order bands by where each component first appears in `flow`, so
        // the layout roughly follows generation order top to bottom.
        components.sort(function (a, b) {
            var minA = Math.min.apply(null, a.map(function (id) { return orderIndex[id]; }));
            var minB = Math.min.apply(null, b.map(function (id) { return orderIndex[id]; }));
            return minA - minB;
        });

        // Column = longest path from an in-degree-0 node, scoped to this
        // component only (so independent chains don't influence each other).
        function assignColumns(members) {
            var memberSet = {};
            members.forEach(function (id) { memberSet[id] = true; });

            var incoming = {};
            members.forEach(function (id) { incoming[id] = 0; });
            members.forEach(function (id) {
                byId[id].wires.forEach(function (port) {
                    (Array.isArray(port) ? port : []).forEach(function (targetId) {
                        if (memberSet[targetId]) { incoming[targetId] += 1; }
                    });
                });
            });

            var column = {};
            members.forEach(function (id) { column[id] = incoming[id] === 0 ? 0 : -1; });
            var changed = true;
            var guard = 0;
            while (changed && guard <= members.length) {
                changed = false;
                guard += 1;
                members.forEach(function (id) {
                    var fromCol = column[id] < 0 ? 0 : column[id];
                    byId[id].wires.forEach(function (port) {
                        (Array.isArray(port) ? port : []).forEach(function (targetId) {
                            if (!memberSet[targetId]) { return; }
                            if (column[targetId] < fromCol + 1) {
                                column[targetId] = fromCol + 1;
                                changed = true;
                            }
                        });
                    });
                });
            }
            members.forEach(function (id) { if (column[id] < 0) { column[id] = 0; } });
            return column;
        }

        // ---- Anchor each comment to the nearest non-comment node adjacent
        // to it in `flow` (forward, then backward). ----
        function nearestWiredNeighbor(commentIndex) {
            var i, candidate;
            for (i = commentIndex + 1; i < nodes.length; i++) {
                candidate = nodes[i];
                if (candidate && byId[candidate.id]) { return candidate.id; }
            }
            for (i = commentIndex - 1; i >= 0; i--) {
                candidate = nodes[i];
                if (candidate && byId[candidate.id]) { return candidate.id; }
            }
            return null;
        }

        var commentsByAnchor = {}; // wired-node id -> [comment nodes]
        var unanchoredComments = [];
        commentNodes.forEach(function (c) {
            var anchorId = nearestWiredNeighbor(nodes.indexOf(c));
            if (anchorId) {
                (commentsByAnchor[anchorId] = commentsByAnchor[anchorId] || []).push(c);
            } else {
                unanchoredComments.push(c);
            }
        });

        // ---- Lay out each component in its own band, leaving a header row
        // for any comments anchored within it. ----
        var nextBandY = BASE_Y;
        components.forEach(function (members) {
            var column = assignColumns(members);

            var headerCols = {};
            var hasHeader = false;
            members.forEach(function (id) {
                (commentsByAnchor[id] || []).forEach(function (c) {
                    headerCols[column[id]] = headerCols[column[id]] || [];
                    headerCols[column[id]].push(c);
                    hasHeader = true;
                });
            });
            var bodyOffset = hasHeader ? 1 : 0;

            var rowsUsed = {};
            var maxRows = 0;
            members.forEach(function (id) {
                var col = column[id];
                var row = rowsUsed[col] || 0;
                rowsUsed[col] = row + 1;
                maxRows = Math.max(maxRows, row + 1);
                var n = byId[id];
                n.x = BASE_X + col * COL_WIDTH;
                n.y = nextBandY + (bodyOffset + row) * ROW_HEIGHT;
            });

            Object.keys(headerCols).forEach(function (col) {
                headerCols[col].forEach(function (c, i) {
                    c.x = BASE_X + Number(col) * COL_WIDTH;
                    c.y = nextBandY + i * Math.round(ROW_HEIGHT / 2);
                });
            });

            nextBandY += (bodyOffset + maxRows + BAND_GAP_ROWS) * ROW_HEIGHT;
        });

        // Comments that couldn't be anchored (only possible if `flow` is
        // entirely comments, which the early-return above already handles)
        // are stacked below everything else as a fallback.
        unanchoredComments.forEach(function (c, i) {
            c.x = BASE_X;
            c.y = nextBandY + i * ROW_HEIGHT;
        });

        return nodes;
    }

    // ---- /build loop: state machine + stepper ------------------------------
    // /build's first proposal reuses Generate's pipeline verbatim (see
    // buildFlow() below); this is what turns that one-shot proposal into a
    // build -> apply -> deploy -> attach -> review -> fix/done cycle. Every
    // proposed change (including fix iterations, added in a later step)
    // still goes through the normal diff-review-then-Apply UI — this state
    // machine only sequences WHEN the next request happens, never what
    // happens to the canvas directly.
    //
    // null when no loop is active. waypoint is one of:
    //   "apply"  — proposal imported, waiting for the user to place + Deploy.
    //   "attach" — deployed, waiting for debug output to try it.
    //   "review" — debug output attached; review request not yet wired up
    //              (next step) so this is currently the end of the line.
    //   "done"/"stopped" — terminal; activeBuildLoop is cleared instead of
    //              held in these states.
    var activeBuildLoop = null;

    // How long onDebugMessage's auto-attach waits, after each matching
    // message, for another one to arrive before locking in and running
    // the review — see onDebugMessage for why (a forked/split flow can
    // fire its debug node more than once per trigger).
    var BUILD_LOOP_ATTACH_DEBOUNCE_MS = 1200;
    var buildLoopAttachTimer = null;

    var BUILD_LOOP_WAYPOINTS = [
        { id: "apply", label: "Deploy" },
        { id: "attach", label: "Attach debug" },
        { id: "review", label: "Review" },
        { id: "done", label: "Done" }
    ];

    // The single exit point for every way a build loop ends — Touchdown,
    // the cap being reached, pausing on a clarifying question, or the user
    // clicking Stop. Releases Build mode and its pinned selection too: once
    // the loop is over, there's no reason to keep the original arm-time
    // selection pinned — the user can just select fresh nodes for whatever
    // comes next.
    function stopBuildLoop(note) {
        activeBuildLoop = null;
        if (buildLoopAttachTimer) { clearTimeout(buildLoopAttachTimer); buildLoopAttachTimer = null; }
        el("#fp-loop-stepper").remove();
        disarmExecuteAction();
        if (note) { addMessage("assistant", note); }
    }

    // Applies a build-loop review's fix envelope, then keeps the loop's
    // tracked node ids in sync and advances/stops it. Factored out of
    // handleBuildReviewResult's addModifyReview callback (rather than left
    // as an inline closure) so the EXACT same logic can run whether the
    // Apply click happened in the main window or was relayed from the
    // pop-out — see the "applyBuildFix" handler in initMainWindow.
    function applyBuildLoopFix(nodeDiffs, removeNodesArg, idMap, capReached) {
        applyModifications(nodeDiffs, removeNodesArg, null, idMap);
        if (!activeBuildLoop) { return; }
        var loop = activeBuildLoop;
        if (idMap) {
            Object.keys(idMap).forEach(function (placeholderId) {
                var realId = idMap[placeholderId];
                if (realId && loop.nodeIds.indexOf(realId) === -1) { loop.nodeIds.push(realId); }
            });
        }
        if (Array.isArray(removeNodesArg) && removeNodesArg.length) {
            loop.nodeIds = loop.nodeIds.filter(function (id) { return removeNodesArg.indexOf(id) === -1; });
        }
        // Each iteration should review its OWN fresh debug output, not a
        // stale message from a prior failed attempt.
        attachedDebugMessages = [];
        updateDebugStatus();
        if (capReached) {
            stopBuildLoop("Couldn't fully verify after " + loop.maxIterations +
                " attempt(s) — applied this last fix, but stopping the auto-loop " +
                "here. Keep iterating manually with Modify if needed.");
        } else {
            loop.iteration++;
            loop.waypoint = "apply";
            renderLoopStepper(loop);
        }
    }

    // Re-rendered (replacing any previous one, not stacked) every time the
    // loop advances a waypoint — the chat log above it already shows the
    // turn-by-turn history, so only the CURRENT state needs to be visible
    // here. Modeled on addGeneratedReview's look (.fp-review) rather than a
    // new visual language.
    function renderLoopStepper(loop) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }
        $box.find("#fp-loop-stepper").remove();

        var $msg = $("<div>").addClass("fp-message fp-review").attr("id", "fp-loop-stepper");
        $("<div>").addClass("fp-label")
            .text("BUILD LOOP — ITERATION " + loop.iteration + "/" + loop.maxIterations)
            .appendTo($msg);

        var $steps = $("<div>").addClass("fp-loop-steps").appendTo($msg);
        BUILD_LOOP_WAYPOINTS.forEach(function (wp, i) {
            var $step = $("<span>").addClass("fp-loop-step").text((i + 1) + ". " + wp.label);
            if (wp.id === loop.waypoint) { $step.addClass("fp-loop-step-active"); }
            $steps.append($step);
        });

        var hint = "";
        if (loop.waypoint === "apply") {
            hint = "Click the canvas to place the new node(s), then Deploy — I'll move on automatically once you deploy.";
        } else if (loop.waypoint === "attach") {
            hint = "Trigger the flow, then check the Debug sidebar — I'll attach the next debug message automatically.";
        } else if (loop.waypoint === "review") {
            hint = "Debug output attached — reviewing against the goal…";
        }
        if (hint) { $("<div>").addClass("fp-loop-hint").text(hint).appendTo($msg); }

        var $actions = $("<div>").addClass("fp-loop-actions").appendTo($msg);
        $("<button>").addClass("red-ui-button red-ui-button-small").attr("type", "button")
            .text("Stop build loop")
            .on("click", function () { stopBuildLoop("Build loop stopped. Whatever's already applied stays as-is."); })
            .appendTo($actions);

        $box.append($msg);
        scrollMessagesToBottom();
    }

    // Called once the first build proposal is actually imported (not on a
    // clarifying question or prose-only reply — see handleBuildResult). goal
    // is the original prompt text, kept verbatim so the review step can
    // compare debug output against what the user actually asked for rather
    // than re-deriving it from the model's own "explanation".
    //
    // proposedNodes/importResult let us recover the REAL node ids Node-RED
    // just generated: importGeneratedFlow calls RED.view.importNodes with
    // generateIds:true, so the model's own placeholder ids (e.g. "n1") never
    // end up on the canvas — importResult.nodeMap maps each placeholder id
    // to the real live node object, which is the only way later review/fix
    // requests can target the right nodes via collectSelectionContext.
    function startBuildLoop(goal, proposedNodes, importResult) {
        var nodeMap = importResult && importResult.nodeMap;
        var nodeIds = [];
        if (nodeMap && Array.isArray(proposedNodes)) {
            proposedNodes.forEach(function (n) {
                var real = n && n.id && nodeMap[n.id];
                if (real && real.id) { nodeIds.push(real.id); }
            });
        }
        activeBuildLoop = {
            goal: goal,
            nodeIds: nodeIds,
            iteration: 1,
            maxIterations: getAgentLoopMaxIterations(),
            waypoint: "apply",
            conversationId: conversationId
        };
        renderLoopStepper(activeBuildLoop);
    }

    // Auto-fires once the loop reaches the "review" waypoint (see
    // onDebugMessage's auto-attach). Reuses the EXISTING /flowpilot/modify
    // route and its "Diagnostic / review instructions" handling verbatim —
    // the same path that already answers "Review this"/"What's wrong here?"
    // requests by either replying in plain text (nothing to fix) or
    // proposing a changes/newNodes/etc envelope. No new backend route or
    // prompt needed; only the instruction text and context (the loop's own
    // node ids instead of the live/pinned canvas selection) are synthetic.
    function runBuildReview(loop) {
        var context = collectSelectionContext(loop.nodeIds);
        context = attachDebugContext(context);
        var instruction = "Review the attached debug output against this build goal: \"" +
            loop.goal + "\". Before concluding anything, list out every distinct " +
            "piece of data or behavior the goal actually requires, then check the " +
            "attached debug payload(s) contain EACH one — a payload that's merely " +
            "plausible-looking, or that satisfies only PART of the goal (e.g. the " +
            "goal asked to combine two things but the payload only shows one), " +
            "does NOT fully satisfy it. If more than one debug message is " +
            "attached, treat them together as the full picture from one trigger, " +
            "not as separate independent attempts. If it fully satisfies the goal, " +
            "say so in plain text — no changes needed. If something's wrong " +
            "(including a node that never fired, or a value that's missing/empty " +
            "when the goal needed it), propose the fix directly as a patch in " +
            "this same response, exactly as you would for any other review " +
            "request — respond with ONLY the {\"explanation\", \"changes\", " +
            "...} JSON object, no sentence of analysis before it. Put your " +
            "diagnosis of what's wrong INSIDE \"explanation\" — never write it as " +
            "prose first and the JSON second; that produces no diff for the user " +
            "to review.";

        var historyPayload = buildHistoryPayload();
        var label = "Build review (iteration " + loop.iteration + "/" + loop.maxIterations + ")";
        addMessage("user", label);
        pushHistory("user", label);

        var ap = activeProvider();
        var isAgentLoop = ap && ap.supportsTools;
        setBusy(true);
        showPending(isAgentLoop);

        var payload = {
            prompt: instruction, context: context,
            history: historyPayload.messages, historyTruncated: historyPayload.truncated,
            conversationId: loop.conversationId
        };

        function onReviewError(msg, xhr) {
            hidePending();
            var raw = xhr && xhr.responseJSON && xhr.responseJSON.raw;
            handleExecuteError(msg, raw);
            // Loop stays at "review" — the next debug message (or Stop) is
            // still available; nothing to roll back since nothing changed.
        }

        if (isAgentLoop) {
            runAgentLoop("flowpilot/modify", payload,
                { mode: "modify", context: context, prompt: instruction },
                handleBuildReviewResult, onReviewError);
            return;
        }
        if (currentSettings.streamingEnabled) {
            payload.stream = true;
            sendExecuteStream("modify", payload, handleBuildReviewResult);
            return;
        }
        ajaxJson("POST", "flowpilot/modify", payload, handleBuildReviewResult, onReviewError);
    }

    // Result handler for runBuildReview — three possible shapes, same as any
    // /flowpilot/modify response: a clarifying question, a prose-only reply
    // (nothing to fix — the loop is done), or a changes/newNodes/etc fix
    // envelope (routed through the same addModifyReview/applyModifications
    // diff-then-Apply pipeline as a manual Modify, then the loop advances
    // back to "apply" for the next deploy/test cycle, or stops if the
    // iteration cap is reached).
    function handleBuildReviewResult(data) {
        hidePending();
        var loop = activeBuildLoop;
        if (!loop) {
            // Stopped while this request was in flight — nothing loop-
            // specific left to do, just render the response normally.
            handleModifyResult(data);
            return;
        }

        if (data.question) {
            var qText = (data.explanation ? data.explanation + "\n\n" : "") + data.question;
            addMessage("assistant", qText);
            pushHistory("assistant", qText);
            renderClarifyingQuestion(data.questionOptions);
            stopBuildLoop("Build loop paused — the review needs your input above. " +
                "Answer it, then continue manually with Modify, or start a fresh /build.");
            setBusy(false);
            updateSelectionStatus();
            return;
        }

        if (data.prose) {
            addMessage("assistant", data.explanation || "(no content returned)");
            pushHistory("assistant", data.explanation || "");
            renderActionChip(data.suggestedAction);
            stopBuildLoop("Touchdown — the debug output matches the goal.");
            setBusy(false);
            updateSelectionStatus();
            return;
        }

        var capReached = loop.iteration >= loop.maxIterations;
        addMessage("assistant", data.explanation || "(no explanation returned)");
        pushHistory("assistant", data.explanation || "(no explanation returned)");
        addModifyReview(data.flow, data.newNodes || [], data.newWires || [], data.removeNodes || [],
            function (nodeDiffs, removeNodesArg, $applyBtn, idMap) {
                applyBuildLoopFix(nodeDiffs, removeNodesArg, idMap, capReached);
            },
            { capReached: capReached }, data.newGroups || []);
        renderActionChip(data.suggestedAction);
        setBusy(false);
        updateSelectionStatus();
    }

    // ---- Tabbed review + import --------------------------------------------
    // Hands validated flow JSON to Node-RED's own import mechanism — the same
    // path the editor's Import menu uses (confirmed live: RED.view.importNodes
    // exists, attaches the new nodes to the cursor for the user to place with
    // one click, and registers the whole add as a single native undo step).
    // generateIds avoids id clashes with existing nodes, matching the behavior
    // already validated via manual import of a generated flow.
    // onImported: optional, called only after a successful import — used by
    // the /build loop to advance to the "apply" waypoint once the proposal
    // actually lands. Plain Generate passes nothing, so it's a no-op there.
    function importGeneratedFlow(nodes, onImported) {
        try {
            // importNodes returns { nodeMap }, mapping each input node's own
            // id to the real live node object Node-RED just created (ids are
            // regenerated since generateIds:true) — onImported (the /build
            // loop) needs this to know what it actually has on the canvas.
            var importResult = RED.view.importNodes(nodes, { generateIds: true });
            // Ground follow-up turns in what was just
            // imported (placement itself happens on the next canvas click).
            var n = Array.isArray(nodes) ? nodes.length : 0;
            var importedNote = "Landed — imported " + n + " node(s). Click the canvas to place them.";
            addMessage("assistant", importedNote);
            pushHistory("assistant", importedNote);
            updateSelectionStatus();
            if (typeof onImported === "function") { onImported(importResult); }
        } catch (e) {
            addMessage("error", "Import failed: " + (e && e.message ? e.message : String(e)));
        }
    }

    // Copies text to the clipboard and gives the triggering button brief
    // "Copied!" feedback. Tries the modern Clipboard API first — but that
    // requires a "secure context" (HTTPS or localhost), which this editor may
    // not be served over — and falls back to the long-supported
    // execCommand("copy") approach via a temporary off-screen textarea, which
    // works regardless of context. Plain clipboard access is a generic browser
    // feature, not an editor capability, so there's nothing Node-RED-specific
    // to reuse here.
    function copyToClipboard($btn, text) {
        var original = $btn.data("fp-label");
        if (original === undefined) {
            original = $btn.text();
            $btn.data("fp-label", original);
        }

        function showCopied() {
            $btn.text("Copied!");
            setTimeout(function () { $btn.text(original); }, 1500);
        }

        function legacyCopy() {
            var $ta = $("<textarea>").val(text)
                .css({ position: "fixed", top: "-1000px", left: "-1000px" });
            $("body").append($ta);
            $ta[0].select();
            var ok = false;
            try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
            $ta.remove();
            if (ok) { showCopied(); }
            else { addMessage("error", "Couldn't copy to clipboard."); }
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(showCopied, legacyCopy);
        } else {
            legacyCopy();
        }
    }

    // Tabbed Summary/JSON review for a generated flow, modeled on the look of
    // Node-RED's Export dialog but built from FlowPilot's own bespoke markup
    // (fp-tab) themed with the editor's --red-ui-* variables — see the handoff
    // doc for why we don't reuse Node-RED's internal tab/export classes.
    // Summary lists each node with type warnings flagged inline plus a
    // detail box; JSON shows the raw, copyable flow. Broken wire references
    // block the "Add to workspace" action (the JSON itself is malformed, not
    // a normal "node not installed" situation); type warnings do not — the
    // user is informed and decides whether to proceed or regenerate.
    // buildGoal: present only for the /build loop's first-step proposal
    // (handleBuildResult) — lets the pop-out's Apply tag carry what
    // startBuildLoop needs (the original goal text) alongside the flow,
    // since plain Generate/Document have no goal/loop to start.
    function addGeneratedReview(flow, onImported, buildGoal) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }

        var nodes = Array.isArray(flow) ? flow : [];
        var v = validateGeneratedFlow(nodes);

        var $msg = $("<div>").addClass("fp-message fp-review");
        // Pop-out slice 3 (plain Generate/Document, no onImported): tag
        // with the raw flow data so the relay can wire up a WORKING "Add
        // to workspace" button in the pop-out. /build's first proposal
        // (onImported set, buildGoal present) gets its own tag instead —
        // importing it also needs to start the loop (startBuildLoop),
        // which the parent does itself once it gets the relayed intent;
        // see the "applyBuild" handler in initMainWindow.
        if (!onImported) {
            $msg.attr("data-fp-apply-flow", JSON.stringify(nodes));
        } else if (buildGoal) {
            $msg.attr("data-fp-apply-build", JSON.stringify({ flow: nodes, goal: buildGoal }));
        }
        $("<div>").addClass("fp-label").text("GENERATED FLOW — REVIEW").appendTo($msg);

        var $tabSummary = $("<button>").addClass("fp-tab fp-tab-active").attr("type", "button").text("Summary");
        var $tabJson = $("<button>").addClass("fp-tab").attr("type", "button").text("JSON");
        $("<div>").addClass("fp-tabs").append($tabSummary, $tabJson).appendTo($msg);

        var $summaryPanel = $("<div>").addClass("fp-tab-panel");
        var $jsonPanel = $("<div>").addClass("fp-tab-panel fp-hidden");
        $msg.append($summaryPanel, $jsonPanel);

        // ---- Summary tab ----
        $("<div>").addClass("fp-review-count")
            .text("Generated " + nodes.length + " node" + (nodes.length === 1 ? "" : "s") + ":")
            .appendTo($summaryPanel);

        var $list = $("<ul>").addClass("fp-review-list").appendTo($summaryPanel);
        v.summary.forEach(function (item) {
            var $li = $("<li>").text(item.type + (item.name ? " — \"" + item.name + "\"" : ""));
            if (item.status === "not-installed") {
                $("<span>").addClass("fp-type-flag").text(" ⚠ not installed").appendTo($li);
            } else if (item.status === "non-core-installed") {
                $("<span>").addClass("fp-type-flag").text(" ⚠ non-core").appendTo($li);
            }
            $list.append($li);
        });

        if (v.noConnections) {
            var $wireWarn = $("<div>").addClass("fp-warning fp-review-warning").appendTo($summaryPanel);
            $("<strong>").text("⚠ These nodes aren't wired to each other.").appendTo($wireWarn);
            $("<div>").text("None of the " + nodes.length + " generated nodes connect to one another — " +
                "they'll land on the canvas disconnected. You can wire them manually, or ask FlowPilot " +
                "to regenerate.").appendTo($wireWarn);
        }

        if (v.typeWarnings.length) {
            var $warn = $("<div>").addClass("fp-warning fp-review-warning").appendTo($summaryPanel);
            $("<strong>").text("Type warnings — review before adding:").appendTo($warn);
            var $wlist = $("<ul>").appendTo($warn);
            v.typeWarnings.forEach(function (w) {
                var reason = w.status === "not-installed"
                    ? "not installed — will appear as a broken placeholder until the module is added"
                    : "installed, but not a core Node-RED type — may be less stable across versions";
                $("<li>").text(w.type + ": " + reason).appendTo($wlist);
            });
            $("<div>").text("You can add it anyway, or ask FlowPilot to regenerate using only core nodes.").appendTo($warn);
        }

        // ---- JSON tab ----
        var jsonText = JSON.stringify(nodes, null, 2);
        var $copyBtn = $("<button>")
            .addClass("red-ui-button red-ui-button-small")
            .attr("type", "button")
            .text("Copy")
            .on("click", function () { copyToClipboard($copyBtn, jsonText); });
        $("<div>").addClass("fp-json-toolbar").append($copyBtn).appendTo($jsonPanel);
        $("<pre>").addClass("fp-json").text(jsonText).appendTo($jsonPanel);

        function activateTab(showSummary) {
            $tabSummary.toggleClass("fp-tab-active", showSummary);
            $tabJson.toggleClass("fp-tab-active", !showSummary);
            $summaryPanel.toggleClass("fp-hidden", !showSummary);
            $jsonPanel.toggleClass("fp-hidden", showSummary);
        }
        $tabSummary.on("click", function () { activateTab(true); });
        $tabJson.on("click", function () { activateTab(false); });

        // ---- Action row ----
        var $actions = $("<div>").addClass("fp-review-actions").appendTo($msg);
        if (v.brokenWires.length) {
            $("<div>").addClass("fp-warning").text(
                "This flow has " + v.brokenWires.length + " wire(s) pointing to node ids " +
                "that don't exist in the generated set, so it can't be safely imported. " +
                "Try asking FlowPilot to regenerate it."
            ).appendTo($actions);
        } else if (!nodes.length) {
            $("<div>").addClass("fp-warning").text("No nodes were generated — nothing to add.").appendTo($actions);
        } else {
            var $addBtn = $("<button>")
                .addClass("red-ui-button red-ui-button-primary")
                .attr("type", "button")
                .text("Add to workspace")
                .on("click", function () {
                    $addBtn.prop("disabled", true).text("Click the canvas to place…");
                    importGeneratedFlow(nodes, onImported);
                });
            $actions.append($addBtn);
            $("<span>").addClass("fp-review-hint")
                .text("Opens Node-RED's normal place-at-cursor import — click the canvas to drop the nodes.")
                .appendTo($actions);
        }

        $box.append($msg);
        scrollMessagesToBottom();
        return $msg;
    }

    // ---- Pop-out window (Phase 8.5 C1) ------------------------------------
    // Mirrors how Node-RED 5's own Debug panel pops out (confirmed against
    // @node-red/nodes/core/common/21-debug.html / debug.js): the SAME
    // renderer (this whole file) loads in both windows; canvas-touching
    // pieces (importGeneratedFlow et al.) stay running in the MAIN window
    // always — the pop-out only ever proxies an intent back via
    // postMessage, never calls RED.* itself. addMessage() and everything it
    // calls runs completely unmodified in either window. Unlike NR5's own
    // reference code (which uses "*" everywhere), every postMessage here
    // pins targetOrigin to location.origin.
    //
    // Slice 1: read-only chat mirror. Slice 2: sending chat from the
    // pop-out (now generalized into the "dispatchSend" intent — see
    // dispatchSend() — covering every mode, not just chat). Slice 3
    // (below): a plain Generate/Document review panel's "Add to
    // workspace" button becomes functional in the pop-out too — Modify
    // and the /build loop are NOT covered by THIS mechanism (Modify's diff
    // is computed against LIVE RED.nodes state, which the pop-out doesn't
    // have; the build loop's import has loop-
    // state follow-up that can't be safely re-triggered from a relayed
    // click) — both stay inert-HTML-only for now, known gaps.

    // Relays one newly-added top-level #fp-messages child to the pop-out by
    // its rendered HTML. Event handlers don't survive serialization, so the
    // mirrored copy is inert (buttons/links render but do nothing) — exactly
    // right for a display-only v1.
    function relayAppendToPopout(html) {
        if (!popoutWindow || popoutWindow.closed) { return; }
        try {
            popoutWindow.postMessage({ event: "appendMessage", html: html }, location.origin);
        } catch (e) { /* pop-out may be navigating/closing — drop silently */ }
    }

    // Relays a removal (e.g. renderLoopStepper replacing the previous
    // stepper, or the pending "typing" indicator being cleared) so the
    // mirror doesn't accumulate stale copies of elements that get replaced
    // in place rather than appended fresh.
    function relayRemoveToPopout(id) {
        if (!popoutWindow || popoutWindow.closed || !id) { return; }
        try {
            popoutWindow.postMessage({ event: "removeMessage", id: id }, location.origin);
        } catch (e) { /* ignore, same as above */ }
    }

    // clearChat()'s el("#fp-messages").empty() removes every bubble at
    // once, but the generic MutationObserver relay only relays a removal
    // when the removed node has an `id` (ordinary chat bubbles don't) —
    // so a bulk clear would silently NOT mirror. Explicit, dedicated event
    // instead of trying to make the generic observer handle bulk removal.
    function relayClearMessagesToPopout() {
        if (!popoutWindow || popoutWindow.closed) { return; }
        try {
            popoutWindow.postMessage({ event: "clearMessages" }, location.origin);
        } catch (e) { /* ignore */ }
    }

    // Mirrors the status-strip's live-selection-dependent pieces into the
    // pop-out — sent as plain text/class values, NOT outerHTML, since
    // those elements sit in the SAME .fp-status-strip as the pop-out's own
    // bound Send/Clear buttons (a blind HTML swap would clobber them).
    // Called from the end of updateSelectionStatus()/updateDebugStatus()
    // (both parent-only in practice — only the main window has a live
    // RED.view.selection() to report on). The debug line is rebuilt from
    // attachedDebugMessages directly rather than read from the DOM, since
    // the live element also contains a "preview" link whose text would
    // otherwise bleed into the relayed string (that link's click-through
    // needs live context data and isn't relayed at all — known v1 gap,
    // same as the Preview JSON link below).
    function relayStatusStripToPopout() {
        if (!popoutWindow || popoutWindow.closed) { return; }
        var debugCount = attachedDebugMessages.length;
        var payload = {
            selectionText: el("#fp-selection-status").text(),
            hasSelection: el("#fp-selection-status").hasClass("fp-has-selection"),
            previewVisible: !el("#fp-preview-nodes").hasClass("fp-hidden"),
            sizeText: el("#fp-size-status").text(),
            sizeHidden: el("#fp-size-status").hasClass("fp-hidden"),
            sizeWarn: el("#fp-size-status").hasClass("fp-size-warn"),
            sizeHigh: el("#fp-size-status").hasClass("fp-size-high"),
            secretsHidden: el("#fp-secrets-status").hasClass("fp-hidden"),
            secretsOff: el("#fp-secrets-status").hasClass("fp-secrets-status-off"),
            secretsTitle: el("#fp-secrets-status").attr("title") || "",
            debugHidden: debugCount === 0,
            debugText: debugCount
                ? ("🐛 " + debugCount + " debug message" + (debugCount === 1 ? "" : "s") + " attached")
                : ""
        };
        try {
            popoutWindow.postMessage({ event: "statusStripSync", data: payload }, location.origin);
        } catch (e) { /* ignore */ }
    }

    // Started once the pop-out is open. Only watches direct children of
    // #fp-messages (childList) — an existing bubble's content changing in
    // place (e.g. a streaming reply filling in) is NOT relayed in v1; the
    // mirror catches up once the next sibling message is added. Known,
    // accepted limitation for the smallest first slice — not a regression
    // for tool-capable providers, which never stream today anyway.
    function startPopoutRelay() {
        var box = el("#fp-messages")[0];
        if (!box || popoutObserver) { return; }
        popoutObserver = new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                m.removedNodes.forEach(function (node) {
                    if (node.nodeType === 1 && node.id) { relayRemoveToPopout(node.id); }
                });
                m.addedNodes.forEach(function (node) {
                    if (node.nodeType === 1) { relayAppendToPopout(node.outerHTML); }
                });
            });
        });
        popoutObserver.observe(box, { childList: true });
    }

    function stopPopoutRelay() {
        if (popoutObserver) { popoutObserver.disconnect(); popoutObserver = null; }
    }

    // Opens (or focuses, if already open — named window target) the
    // detached mirror, mirroring 21-debug.html's window.open call exactly
    // (same options string shape). Sends a one-time snapshot of the
    // CURRENT #fp-messages content once the pop-out finishes loading, then
    // starts the live relay for everything after that point.
    function openPopout() {
        if (popoutWindow && !popoutWindow.closed) {
            popoutWindow.focus();
            return;
        }
        popoutWindow = window.open(
            document.location.toString().replace(/[?#].*$/, "") + "flowpilot/popout/view.html" + document.location.search,
            "flowpilotPopout",
            "menubar=no,location=no,toolbar=no,chrome,height=700,width=480"
        );
        if (!popoutWindow) { return; }
        popoutWindow.onload = function () {
            var html = el("#fp-messages").length ? el("#fp-messages").html() : "";
            try {
                popoutWindow.postMessage({ event: "initialSync", html: html }, location.origin);
            } catch (e) { /* ignore */ }
            startPopoutRelay();
        };
    }

    // Entry point for the pop-out's own page (lib/popout/view.html, loaded
    // via this SAME script). Builds the SAME cockpit shell as the main
    // window's action-bar/compose/status-strip (same ids/classes, so the
    // existing CSS and functions below apply unmodified) and relays any
    // user-initiated close/reopen back via window.opener so the main
    // window's "the pop-out is closed" state (popoutWindow.closed) stays
    // accurate without polling.
    //
    // Full cockpit parity (2026-06-26): arming/disarming Generate/Document/
    // Modify, Query intents, and every slash command except /compact+
    // /expand are pure local state (setArmedExecuteAction/
    // handleSlashCommand/armQueryIntent have zero RED.* calls) and work
    // completely unmodified here — only dispatchSend()'s FINAL dispatch and
    // /compact+/expand need to relay instead of touching dead RED.* state
    // (see isPopoutContext, checked inside those two functions). Settings
    // are loaded independently via the pop-out's OWN loadSettings() call
    // (plain ajaxJson, zero RED.* coupling) — gives a correct Provider-
    // status line and working custom Query intents for free via the
    // existing fillSettings(), which jQuery no-ops harmlessly on the
    // Settings-panel field ids this pop-out doesn't render this slice.
    //
    // conversationId/conversationHistory/attachedDebugMessages/
    // activeBuildLoop stay PARENT-OWNED — this window never keeps its own
    // copies. Sending (any mode) and Clear Chat are relayed asks; the
    // selection-status strip is a relayed MIRROR (relayStatusStripToPopout,
    // called from the parent's updateSelectionStatus/updateDebugStatus).

    // Slice 3: relayed HTML for a plain Generate/Document review panel
    // (addGeneratedReview tags these with data-fp-apply-flow — see there
    // for why the /build loop's panels are excluded) carries the flow data
    // right in the markup, since outerHTML serializes every attribute.
    // Re-validating/re-rendering in the pop-out isn't needed (and wouldn't
    // work anyway — RED.nodes.getType has no installed types in this
    // window) — the parent already validated everything before the
    // snapshot was relayed. This just rebinds ONE button to ask the parent
    // to do exactly what it would do if the same button were clicked in
    // the sidebar.
    function bindApplyButtons($scope) {
        // appendMessage's scope IS the tagged panel itself (a single newly
        // relayed top-level element); initialSync's scope is the container
        // around many descendants — cover both with filter()+find().
        $scope.filter("[data-fp-apply-flow]").add($scope.find("[data-fp-apply-flow]")).each(function () {
            var $panel = $(this);
            if ($panel.data("fp-apply-bound")) { return; }
            $panel.data("fp-apply-bound", true);
            var flow;
            try { flow = JSON.parse($panel.attr("data-fp-apply-flow")); } catch (e) { return; }
            $panel.find(".fp-review-actions button.red-ui-button-primary").on("click", function () {
                var $btn = $(this);
                $btn.prop("disabled", true).text("Click the canvas to place…");
                if (!window.opener || window.opener.closed) { return; }
                try {
                    window.opener.postMessage({ event: "applyGenerated", flow: flow }, location.origin);
                } catch (e) { /* ignore */ }
            });
        });
    }

    // Same idea as bindApplyButtons, but for a relayed PLAIN Modify review
    // panel (addModifyReview tags these with data-fp-apply-modify; a
    // /build loop fix gets a separate tag — see bindBuildFixApplyButtons).
    // nodeDiffs/removeNodes/newNodes/newWires already reflect the diff the
    // parent computed against live RED.nodes state at review time; the
    // pop-out doesn't recompute anything, it just asks the parent to run
    // applyInsertions/applyModifications with this exact data, same as a
    // sidebar click would.
    function bindModifyApplyButtons($scope) {
        $scope.filter("[data-fp-apply-modify]").add($scope.find("[data-fp-apply-modify]")).each(function () {
            var $panel = $(this);
            if ($panel.data("fp-apply-modify-bound")) { return; }
            $panel.data("fp-apply-modify-bound", true);
            var applyData;
            try { applyData = JSON.parse($panel.attr("data-fp-apply-modify")); } catch (e) { return; }
            $panel.find(".fp-review-actions button.red-ui-button-primary").on("click", function () {
                var $btn = $(this);
                $btn.prop("disabled", true).text("Applying…");
                if (!window.opener || window.opener.closed) { return; }
                try {
                    window.opener.postMessage({ event: "applyModify", data: applyData }, location.origin);
                } catch (e) { /* ignore */ }
            });
        });
    }

    // /build loop, first proposal: addGeneratedReview tags this panel
    // (onImported set AND a buildGoal — plain Generate/Document panels get
    // data-fp-apply-flow instead, bound above) with the flow plus the
    // original goal text. The parent's "applyBuild" handler runs
    // importGeneratedFlow then startBuildLoop with it, exactly like
    // handleBuildResult's own onImported closure would.
    function bindBuildApplyButtons($scope) {
        $scope.filter("[data-fp-apply-build]").add($scope.find("[data-fp-apply-build]")).each(function () {
            var $panel = $(this);
            if ($panel.data("fp-apply-build-bound")) { return; }
            $panel.data("fp-apply-build-bound", true);
            var applyData;
            try { applyData = JSON.parse($panel.attr("data-fp-apply-build")); } catch (e) { return; }
            $panel.find(".fp-review-actions button.red-ui-button-primary").on("click", function () {
                var $btn = $(this);
                $btn.prop("disabled", true).text("Click the canvas to place…");
                if (!window.opener || window.opener.closed) { return; }
                try {
                    window.opener.postMessage({ event: "applyBuild", data: applyData }, location.origin);
                } catch (e) { /* ignore */ }
            });
        });
    }

    // /build loop, fix iterations: addModifyReview tags this panel with
    // data-fp-apply-build-fix (instead of data-fp-apply-modify) when
    // buildFixInfo was passed — see applyBuildLoopFix. The parent's
    // "applyBuildFix" handler runs applyInsertions/applyBuildLoopFix
    // with the relayed data, same loop bookkeeping a local click would do.
    function bindBuildFixApplyButtons($scope) {
        $scope.filter("[data-fp-apply-build-fix]").add($scope.find("[data-fp-apply-build-fix]")).each(function () {
            var $panel = $(this);
            if ($panel.data("fp-apply-build-fix-bound")) { return; }
            $panel.data("fp-apply-build-fix-bound", true);
            var applyData;
            try { applyData = JSON.parse($panel.attr("data-fp-apply-build-fix")); } catch (e) { return; }
            $panel.find(".fp-review-actions button.red-ui-button-primary").on("click", function () {
                var $btn = $(this);
                $btn.prop("disabled", true).text("Applying…");
                if (!window.opener || window.opener.closed) { return; }
                try {
                    window.opener.postMessage({ event: "applyBuildFix", data: applyData }, location.origin);
                } catch (e) { /* ignore */ }
            });
        });
    }

    // The loop stepper's "Stop build loop" button is relayed the same
    // generic way as any other chat message (renderLoopStepper appends/
    // replaces a #fp-loop-stepper element, which the MutationObserver
    // relay already mirrors via plain add/remove) — but like every other
    // relayed button, it loses its click handler on the way over. Rebind
    // it to ask the parent to do exactly what a local click would.
    function bindStopLoopButton($scope) {
        $scope.filter("#fp-loop-stepper").add($scope.find("#fp-loop-stepper")).each(function () {
            var $stepper = $(this);
            if ($stepper.data("fp-stop-loop-bound")) { return; }
            $stepper.data("fp-stop-loop-bound", true);
            $stepper.find(".fp-loop-actions button").on("click", function () {
                if (!window.opener || window.opener.closed) { return; }
                try {
                    window.opener.postMessage({ event: "stopBuildLoop" }, location.origin);
                } catch (e) { /* ignore */ }
            });
        });
    }

    // The Summary/JSON tab toggle (addGeneratedReview, addModifyReview,
    // and anything else using the same .fp-tabs/.fp-tab-panel pattern) is
    // purely local DOM show/hide — unlike Apply, it needs no parent
    // access at all, so this works for EVERY relayed review panel. Lost
    // the same way Apply's original handler did (relayed HTML has no
    // event listeners) — this just rebinds the toggle.
    function bindTabSwitching($scope) {
        $scope.filter(".fp-tabs").add($scope.find(".fp-tabs")).each(function () {
            var $tabs = $(this);
            if ($tabs.data("fp-tabs-bound")) { return; }
            $tabs.data("fp-tabs-bound", true);
            var $tabButtons = $tabs.find(".fp-tab");
            var $panels = $tabs.siblings(".fp-tab-panel");
            $tabButtons.each(function (i) {
                $(this).on("click", function () {
                    $tabButtons.removeClass("fp-tab-active");
                    $(this).addClass("fp-tab-active");
                    $panels.addClass("fp-hidden");
                    $panels.eq(i).removeClass("fp-hidden");
                });
            });
        });
    }

    // Matches Node-RED 5's own debug pop-out (debug.js) exactly: the dark/
    // light preference lives in localStorage under "view-dark-theme"
    // ("dark" / "auto" / anything else = light), shared with the main
    // window since both are same-origin. red/style.min.css's dark-mode
    // variable overrides are scoped under the SAME nr-theme-dark class the
    // main editor toggles on <html> — without this, the pop-out always
    // rendered light regardless of the editor's actual theme.
    function applyPopoutTheme() {
        var themeVariant = localStorage.getItem("view-dark-theme");
        var isDark = false;
        if (themeVariant === "dark") {
            isDark = true;
        } else if (themeVariant === "auto") {
            isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
        }
        document.documentElement.classList.toggle("nr-theme-dark", isDark);
    }

    function initPopout() {
        isPopoutContext = true;
        applyPopoutTheme();
        var content = $(
            '<div id="fp-root">' +
            '  <div class="fp-header">' +
            '    <div class="fp-header-row">' +
            '      <div class="fp-logo">FP</div>' +
            '      <div class="fp-heading">' +
            '        <div class="fp-title">FlowPilot</div>' +
            '        <div class="fp-subtitle">AI flow assistant</div>' +
            '      </div>' +
            '      <div class="fp-view-buttons">' +
            '        <button id="fp-clear-chat" class="red-ui-button red-ui-button-small" type="button" title="Clear chat and start a fresh conversation (resets memory)"><i class="fa fa-eraser"></i></button>' +
            '      </div>' +
            '    </div>' +
            '  </div>' +
            '  <div id="fp-chat-panel" class="fp-panel">' +
            '    <div id="fp-messages" class="fp-messages"></div>' +
            '    <div class="fp-compose">' +
            '      <div class="fp-action-bar">' +
            '        <div class="fp-action-group">' +
            '          <div id="fp-intents" class="fp-intents fp-intents-query"></div>' +
            '        </div>' +
            '        <div class="fp-action-divider"></div>' +
            '        <div class="fp-action-group">' +
            '          <div class="fp-intents fp-intents-execute">' +
            '            <button id="fp-document" class="red-ui-button red-ui-button-small fp-icon-btn fp-icon-btn-execute" type="button" title="Document — select nodes, optionally add notes, then hit Send to generate a comment-node explanation"><i class="fa fa-file-text-o"></i></button>' +
            '            <button id="fp-generate" class="red-ui-button red-ui-button-small fp-icon-btn fp-icon-btn-execute" type="button" title="Generate — describe a flow, then hit Send to draft it"><i class="fa fa-magic"></i></button>' +
            '            <button id="fp-modify" class="red-ui-button red-ui-button-small fp-icon-btn fp-icon-btn-execute" type="button" title="Modify — select node(s) in the MAIN window, describe the change, then hit Send"><i class="fa fa-pencil"></i></button>' +
            '          </div>' +
            '        </div>' +
            '      </div>' +
            '      <div class="fp-prompt-wrap">' +
            '        <textarea id="fp-prompt" placeholder="Select nodes in the main window for context, or just type a question…"></textarea>' +
            '      </div>' +
            '      <div class="fp-status-strip">' +
            '        <span id="fp-selection-status" class="fp-selection-status">No nodes selected</span>' +
            '        <a href="#" id="fp-preview-nodes" class="fp-preview-link fp-hidden" title="Open this from the main window to see the exact sanitized node JSON">Preview JSON</a>' +
            '        <span id="fp-size-status" class="fp-size-status fp-hidden"></span>' +
            '        <span id="fp-secrets-status" class="fp-secrets-status fp-hidden" title="Context may include node config and code. Don\'t send credentials or proprietary data. Local/private AI recommended.">⚠</span>' +
            '        <span id="fp-debug-status" class="fp-debug-status fp-hidden"></span>' +
            '        <span class="fp-status-spacer"></span>' +
            '        <div id="fp-provider-status">Provider: not loaded</div>' +
            '        <button id="fp-clear-prompt" class="red-ui-button" type="button" title="Clear prompt box">Clear</button>' +
            '        <button id="fp-send" class="red-ui-button red-ui-button-primary" type="button">Send</button>' +
            '      </div>' +
            '    </div>' +
            '  </div>' +
            '</div>'
        );
        $("#fp-popout-root").append(content);
        $root = content;

        // Arming/disarming/Send dispatch reuse the EXISTING functions
        // verbatim — see the comment above this function for why that's
        // safe (pure local state except dispatchSend's final step, which
        // checks isPopoutContext itself).
        el("#fp-generate").on("click", function () { setArmedExecuteAction("generate"); });
        el("#fp-document").on("click", function () { setArmedExecuteAction("document"); });
        el("#fp-modify").on("click", function () { setArmedExecuteAction("modify"); });
        el("#fp-send").on("click", function () { dispatchSend(); });
        el("#fp-prompt").on("keydown", function (e) {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                dispatchSend();
            }
        });
        el("#fp-clear-prompt").on("click", function () {
            el("#fp-prompt").val("").focus();
        });
        // Clear Chat resets PARENT-owned conversationId/conversationHistory/
        // activeBuildLoop — always relayed, never run locally (this window
        // keeps no conversation state of its own to reset).
        el("#fp-clear-chat").on("click", function () {
            if (window.opener && !window.opener.closed) {
                try { window.opener.postMessage({ event: "clearChat" }, location.origin); } catch (e) { /* ignore */ }
            }
        });
        el("#fp-preview-nodes").on("click", function (ev) {
            ev.preventDefault();
            addMessage("error", "Preview JSON isn't available in the pop-out yet — open it from the main window.");
        });

        // Built-ins show immediately; loadSettings()'s fillSettings() call
        // re-renders once custom intents (if any) are loaded, same
        // two-step sequence initMainWindow uses.
        renderIntents(el("#fp-intents"));
        loadSettings();

        window.addEventListener("message", function (evt) {
            if (evt.origin !== location.origin) { return; }
            var data = evt.data || {};
            if (data.event === "initialSync") {
                el("#fp-messages").html(data.html);
                bindApplyButtons(el("#fp-messages"));
                bindModifyApplyButtons(el("#fp-messages"));
                bindBuildApplyButtons(el("#fp-messages"));
                bindBuildFixApplyButtons(el("#fp-messages"));
                bindStopLoopButton(el("#fp-messages"));
                bindTabSwitching(el("#fp-messages"));
                scrollMessagesToBottom(true);
            } else if (data.event === "appendMessage") {
                el("#fp-messages").append(data.html);
                bindApplyButtons(el("#fp-messages").children().last());
                bindModifyApplyButtons(el("#fp-messages").children().last());
                bindBuildApplyButtons(el("#fp-messages").children().last());
                bindBuildFixApplyButtons(el("#fp-messages").children().last());
                bindStopLoopButton(el("#fp-messages").children().last());
                bindTabSwitching(el("#fp-messages").children().last());
                scrollMessagesToBottom();
            } else if (data.event === "removeMessage") {
                el("#" + data.id).remove();
            } else if (data.event === "clearMessages") {
                el("#fp-messages").empty();
            } else if (data.event === "statusStripSync") {
                var s = data.data || {};
                el("#fp-selection-status").text(s.selectionText || "").toggleClass("fp-has-selection", !!s.hasSelection);
                el("#fp-preview-nodes").toggleClass("fp-hidden", !s.previewVisible);
                el("#fp-size-status").text(s.sizeText || "")
                    .toggleClass("fp-hidden", !!s.sizeHidden)
                    .toggleClass("fp-size-warn", !!s.sizeWarn)
                    .toggleClass("fp-size-high", !!s.sizeHigh);
                el("#fp-secrets-status").toggleClass("fp-hidden", !!s.secretsHidden)
                    .toggleClass("fp-secrets-status-off", !!s.secretsOff)
                    .attr("title", s.secretsTitle || "");
                el("#fp-debug-status").text(s.debugText || "").toggleClass("fp-hidden", !!s.debugHidden);
            }
        });
    }

    // ---- Plugin registration --------------------------------------------

    function initMainWindow() {
            // If onadd has already run this session, do nothing. This is the
            // primary fix for the duplicate #fp-root: the second invocation
            // returns before building or inserting any DOM.
            if (initialised) { return; }
            initialised = true;

            // Belt-and-suspenders: clear any orphan left by a prior version
            // before this guard existed. Harmless once the guard is in place.
            try { RED.sidebar.removeTab("flowpilot"); } catch (e) {}
            $("#fp-root").remove();

            var content = $(
                '<div id="fp-root">' +
                '  <div class="fp-header">' +
                '    <div class="fp-header-row">' +
                '      <div class="fp-logo">FP</div>' +
                '      <div class="fp-heading">' +
                '        <div class="fp-title">FlowPilot</div>' +
                '        <div class="fp-subtitle">AI flow assistant</div>' +
                '      </div>' +
                '      <div class="fp-view-buttons">' +
                '        <button id="fp-clear-chat" class="red-ui-button red-ui-button-small" type="button" title="Clear chat and start a fresh conversation (resets memory)"><i class="fa fa-eraser"></i></button>' +
                '        <button id="fp-recall" class="red-ui-button red-ui-button-small" type="button" title="Recall: search earlier conversations for the text in the prompt box"><i class="fa fa-search"></i></button>' +
                '        <button id="fp-debug-log" class="red-ui-button red-ui-button-small" type="button" title="Debug log: view recent Debug sidebar output and attach messages as context"><i class="fa fa-bug"></i></button>' +
                '        <button id="fp-show-chat" class="red-ui-button red-ui-button-small" type="button" title="Chat"><i class="fa fa-comments"></i></button>' +
                '        <button id="fp-show-history" class="red-ui-button red-ui-button-small" type="button" title="Flight log — past conversations"><i class="fa fa-history"></i></button>' +
                '        <button id="fp-popout" class="red-ui-button red-ui-button-small" type="button" title="Open in a separate window (read-only mirror — v1)"><i class="fa fa-external-link"></i></button>' +
                '        <button id="fp-show-settings" class="red-ui-button red-ui-button-small" type="button" title="Settings"><i class="fa fa-cog"></i></button>' +
                '      </div>' +
                '    </div>' +
                '  </div>' +

                '  <div id="fp-chat-panel" class="fp-panel">' +
                '    <div id="fp-dev-banner" class="fp-warning">' +
                '      <strong>Development/test only.</strong> ' +
                '      Anything you send may leave this Node-RED instance. ' +
                '      Don\'t include credentials or proprietary data; local/private AI recommended.' +
                '    </div>' +
                '    <div id="fp-messages" class="fp-messages"></div>' +
                '    <div class="fp-compose">' +
                '      <div class="fp-action-bar">' +
                '        <div class="fp-action-group">' +
                '          <div id="fp-intents" class="fp-intents fp-intents-query"></div>' +
                '        </div>' +
                '        <div class="fp-action-divider"></div>' +
                '        <div class="fp-action-group">' +
                '          <div class="fp-intents fp-intents-execute">' +
                '            <button id="fp-document" class="red-ui-button red-ui-button-small fp-icon-btn fp-icon-btn-execute" type="button" title="Document — select nodes, optionally add notes, then hit Send to generate a comment-node explanation"><i class="fa fa-file-text-o"></i></button>' +
                '            <button id="fp-generate" class="red-ui-button red-ui-button-small fp-icon-btn fp-icon-btn-execute" type="button" title="Generate — describe a flow, then hit Send to draft it"><i class="fa fa-magic"></i></button>' +
                '            <button id="fp-modify" class="red-ui-button red-ui-button-small fp-icon-btn fp-icon-btn-execute" type="button" title="Modify — select node(s), describe the change, then hit Send"><i class="fa fa-pencil"></i></button>' +
                '          </div>' +
                '        </div>' +
                '      </div>' +
                '      <div class="fp-prompt-wrap">' +
                '        <textarea id="fp-prompt" placeholder="Select nodes for context, or just type a question…"></textarea>' +
                '        <div id="fp-prompt-resize" class="fp-resize-handle" title="Drag to resize"><i class="fa fa-arrows-v"></i></div>' +
                '      </div>' +
                '      <div class="fp-status-strip">' +
                '        <span id="fp-selection-status" class="fp-selection-status">No nodes selected</span>' +
                '        <a href="#" id="fp-preview-nodes" class="fp-preview-link fp-hidden" title="Show the exact sanitized node JSON that will be sent">Preview JSON</a>' +
                '        <span id="fp-size-status" class="fp-size-status fp-hidden"></span>' +
                '        <span id="fp-secrets-status" class="fp-secrets-status fp-hidden" title="Context may include node config and code. Don\'t send credentials or proprietary data. Local/private AI recommended.">⚠</span>' +
                '        <span id="fp-debug-status" class="fp-debug-status fp-hidden"></span>' +
                '        <span class="fp-status-spacer"></span>' +
                '        <div id="fp-provider-status">Provider: not loaded</div>' +
                '        <button id="fp-clear-prompt" class="red-ui-button" type="button" title="Clear prompt box">Clear</button>' +
                '        <button id="fp-send" class="red-ui-button red-ui-button-primary" type="button">Send</button>' +
                '      </div>' +
                '    </div>' +
                '  </div>' +

                '  <div id="fp-settings-panel" class="fp-panel fp-hidden">' +
                '    <div class="fp-form">' +

                '      <details class="fp-settings-group" open>' +
                '      <summary title="Hangar — where your AI providers are configured">Providers</summary>' +
                '      <div class="fp-warning">' +
                '        <strong>Provider settings.</strong><br>' +
                '        Stored locally under the Node-RED user directory in <code>flowpilot/settings.json</code>.' +
                '      </div>' +
                '      <label>Active provider</label>' +
                '      <select id="fp-provider-select"></select>' +
                '      <div class="fp-provider-actions">' +
                '        <button id="fp-add-provider" class="red-ui-button red-ui-button-small" type="button">+ Add</button>' +
                '        <button id="fp-remove-provider" class="red-ui-button red-ui-button-small" type="button">Remove</button>' +
                '      </div>' +
                '      <label>Provider Name</label>' +
                '      <input id="fp-provider-name" type="text" placeholder="LocalAI">' +
                '      <label>Base URL</label>' +
                '      <input id="fp-base-url" type="text" placeholder="http://localhost:8080">' +
                '      <label>API Key</label>' +
                '      <input id="fp-api-key" type="password" placeholder="Optional">' +
                '      <label>Model</label>' +
                '      <input id="fp-model" type="text" list="fp-model-options" placeholder="Model name for this provider">' +
                '      <datalist id="fp-model-options"></datalist>' +
                '      <div id="fp-models-hint" class="fp-consent-hint fp-hidden"></div>' +
                '      <label>Temperature</label>' +
                '      <input id="fp-temperature" type="number" min="0" max="2" step="0.1" placeholder="0.2">' +
                '      <div class="fp-consent-hint">Controls randomness. Lower (e.g. 0.2) is more ' +
                '        focused and consistent; higher is more creative and varied. 0.2 is a good ' +
                '        default for flow generation.</div>' +
                '      <div class="fp-settings-actions">' +
                '        <button id="fp-test-provider" class="red-ui-button" type="button" title="Pre-flight check — save and send a quick test to this provider">Pre-flight check</button>' +
                '        <button id="fp-refresh-models" class="red-ui-button" type="button" title="Save settings, then fetch this provider\'s model list via GET /v1/models">Refresh models</button>' +
                '      </div>' +
                '      </details>' +

                '      <details class="fp-settings-group">' +
                '      <summary>Behavior</summary>' +
                '      <div class="fp-settings-section">System Prompt</div>' +
                '      <textarea id="fp-system-prompt"></textarea>' +
                '      <div class="fp-settings-actions">' +
                '        <button id="fp-reset-system-prompt" class="red-ui-button" type="button" title="Replace this text with FlowPilot\'s current built-in default — useful after an update adds new instructions">Reset to default</button>' +
                '      </div>' +

                '      <div class="fp-settings-section">Personality</div>' +
                '      <label>Persona intensity: <span id="fp-persona-value">3</span>/10</label>' +
                '      <input id="fp-persona-intensity" type="range" min="1" max="10" step="1">' +
                '      <div id="fp-persona-label" class="fp-consent-hint"></div>' +
                '      <div class="fp-consent-hint">Chat only. Scales the AI\'s voice at greetings, ' +
                '        capability questions, and brief transitions — 1 is a plain Node-RED engineer, ' +
                '        10 is a comically over-the-top airline captain who happens to be a Node-RED ' +
                '        expert. Explanations, troubleshooting, and errors always stay plain regardless ' +
                '        of this setting. Generate, Document, and Modify are unaffected.</div>' +

                '      <div class="fp-settings-section">Conversation memory</div>' +
                '      <label>Remember last N exchanges</label>' +
                '      <input id="fp-history-max" type="number" min="0" step="1" placeholder="10">' +
                '      <div class="fp-consent-hint">How much of the visible chat is sent back to the ' +
                '        AI as conversation history with each request (0 = no memory). Older messages ' +
                '        drop off and the AI is told when that happens. Clear chat (eraser icon) ' +
                '        resets this entirely.</div>' +
                '      <label class="fp-checkbox-row">' +
                '        <input id="fp-streaming-enabled" type="checkbox"> ' +
                '        Stream chat replies as they generate' +
                '      </label>' +
                '      <div class="fp-consent-hint">Applies to every mode (Chat, Generate, ' +
                '        Document, Modify, Build) the same way — but only when the active ' +
                '        provider doesn\'t support tool/function calling. Tool-capable ' +
                '        providers always wait for the full response regardless of this ' +
                '        setting, since the read-tool loop has no streaming variant.</div>' +

                '      <div class="fp-settings-section">Request timeout</div>' +
                '      <label>Give up after (seconds)</label>' +
                '      <input id="fp-request-timeout" type="number" min="5" step="5" placeholder="180">' +
                '      <div class="fp-consent-hint">How long to wait for a provider response before ' +
                '        giving up. Raise this if you\'re running a large local model on slow hardware ' +
                '        (e.g. Ollama without a GPU) and seeing timeout errors.</div>' +

                '      <div class="fp-settings-section">Agentic build loop</div>' +
                '      <label>Max build/fix attempts</label>' +
                '      <input id="fp-agent-loop-max-iterations" type="number" min="1" max="20" step="1" placeholder="5">' +
                '      <div class="fp-consent-hint">When using <code>/build</code>, how many build → deploy → ' +
                '        test → fix cycles to try before stopping with an honest "couldn\'t fully verify" ' +
                '        instead of proposing another fix.</div>' +

                '      <div class="fp-settings-section">Custom intent buttons</div>' +
                '      <div class="fp-consent-hint">Add your own one-click prompt buttons. ' +
                '        They appear next to the built-in ones above the prompt.</div>' +
                '      <div id="fp-custom-intents" class="fp-custom-intents"></div>' +
                '      <label>New button label</label>' +
                '      <input id="fp-new-intent-label" type="text" placeholder="e.g. Security review">' +
                '      <label>Instruction text</label>' +
                '      <textarea id="fp-new-intent-text" placeholder="What should this button ask the AI to do?"></textarea>' +
                '      <div class="fp-settings-actions">' +
                '        <button id="fp-add-intent" class="red-ui-button" type="button">Add button</button>' +
                '      </div>' +
                '      </details>' +

                '      <details class="fp-settings-group">' +
                '      <summary>Context &amp; Safety</summary>' +
                '      <div class="fp-settings-section">Context size warnings</div>' +
                '      <label>Warn above (estimated tokens)</label>' +
                '      <input id="fp-warn-tokens" type="number" min="0" step="500" placeholder="4000">' +
                '      <label>Strong warning above (estimated tokens)</label>' +
                '      <input id="fp-high-tokens" type="number" min="0" step="500" placeholder="8000">' +

                '      <div class="fp-settings-section">Risk warnings</div>' +
                '      <label class="fp-checkbox-row">' +
                '        <input id="fp-suppress-warnings" type="checkbox"> ' +
                '        Hide the recurring credentials/size warning bar' +
                '      </label>' +
                '      <div class="fp-consent-hint">To hide the warning, check the box and type ' +
                '        <strong>I understand the risk</strong> below. ' +
                '        Anything you send may leave this Node-RED instance.</div>' +
                '      <input id="fp-suppress-confirm" type="text" placeholder="Type: I understand the risk">' +

                '      <div class="fp-settings-section">Redaction</div>' +
                '      <label class="fp-checkbox-row">' +
                '        <input id="fp-redaction-disabled" type="checkbox"> ' +
                '        Disable secret-shaped-value redaction' +
                '      </label>' +
                '      <div class="fp-consent-hint">By default, values that look like secrets ' +
                '        (passwords, tokens, API keys) are replaced with a placeholder before sending. ' +
                '        This opt-out is intended for environments using local or private AIs. Debug ' +
                '        nodes and context may share confidential data, including secret keys, and ' +
                '        credentials. Use at your own risk! Node-RED\'s own credential store is never ' +
                '        sent either way. To disable, check the box and type ' +
                '        <strong>disable redaction</strong> below.</div>' +
                '      <input id="fp-redaction-confirm" type="text" placeholder="Type: disable redaction">' +
                '      </details>' +

                '      <div class="fp-settings-actions">' +
                '        <button id="fp-save-settings" class="red-ui-button red-ui-button-primary" type="button">Save settings</button>' +
                '        <span id="fp-save-status" class="fp-save-status fp-hidden"></span>' +
                '      </div>' +
                '    </div>' +
                '  </div>' +

                '  <div id="fp-history-panel" class="fp-panel fp-hidden">' +
                '    <div class="fp-form">' +
                '      <div class="fp-settings-section">Flight log — past conversations</div>' +
                '      <div class="fp-consent-hint">Click a conversation to load it back into Chat — ' +
                '        new messages continue that conversation\'s memory. Deleting a conversation ' +
                '        removes its saved transcript permanently.</div>' +
                '      <div class="fp-settings-actions">' +
                '        <button id="fp-history-delete-all" class="red-ui-button red-ui-button-small" type="button" title="Delete all saved conversation transcripts permanently"><i class="fa fa-trash"></i> Delete all</button>' +
                '      </div>' +
                '      <div id="fp-history-list" class="fp-history-list"></div>' +
                '    </div>' +
                '  </div>' +
                '</div>'
            );

            // Keep the closure reference to the *inserted* content.
            $root = content;

            // ---- Settings accordion: only one section expanded at a time.
            // Bind once on the parent (event delegation) rather than per-summary.
            content.find(".fp-settings-group > summary").on("click", function () {
                // Close all other details elements
                content.find(".fp-settings-group").not($(this).closest(".fp-settings-group")).removeAttr("open");
            });

            // ---- Bind events here, after the DOM exists. No inline onclick.
            content.find("#fp-show-chat").on("click", showChat);
            content.find("#fp-show-settings").on("click", showSettings);
            content.find("#fp-show-history").on("click", showHistory);
            content.find("#fp-popout").on("click", openPopout);
            content.find("#fp-history-delete-all").on("click", deleteAllConversations);
            content.find("#fp-clear-chat").on("click", clearChat);
            content.find("#fp-recall").on("click", recallSearch);
            content.find("#fp-debug-log").on("click", showDebugMessages);
            content.find("#fp-preview-nodes").on("click", function (ev) {
                ev.preventDefault();
                showJsonPreview("Node JSON preview — exactly what will be sent", resolveCurrentSelectionContext());
            });

            // Subscribe once to the same RED.comms "debug" topic the built-in
            // Debug sidebar uses, to buffer recent messages locally for
            // optional attachment (showDebugMessages/attachDebugContext).
            // Nothing is sent to the backend until the user explicitly
            // attaches a message and sends a request.
            try { RED.comms.subscribe("debug", onDebugMessage); } catch (e) { /* comms unavailable */ }

            // Track whether the user is scrolled to the bottom of the chat,
            // so "Cruising…"/streaming updates only auto-follow when they
            // haven't scrolled up to read earlier messages.
            content.find("#fp-messages").on("scroll", function () {
                fpChatSnappedToBottom = (this.scrollHeight - this.scrollTop - this.clientHeight) <= FP_SCROLL_SNAP_PX;
            });

            // Delegated: code blocks are injected as raw HTML (renderMarkdown
            // -> .html()), so individual buttons never exist at bind time.
            content.find("#fp-messages").on("click", ".fp-code-copy", function () {
                var $btn = $(this);
                var $pre = el("#" + $btn.attr("data-code-id"));
                if ($pre.length) { copyToClipboard($btn, $pre.text()); }
            });

            content.find("#fp-clear-prompt").on("click", function () {
                el("#fp-prompt").val("").focus();
            });

            content.find("#fp-send").on("click", function () {
                dispatchSend();
            });
            content.find("#fp-generate").on("click", function () {
                setArmedExecuteAction("generate");
            });
            content.find("#fp-document").on("click", function () {
                setArmedExecuteAction("document");
            });
            content.find("#fp-modify").on("click", function () {
                setArmedExecuteAction("modify");
            });

            // Close the "more query actions" dropdown on any click outside it.
            // Bound once here (onadd guard above) rather than per-render.
            $(document).on("click.fpIntentMenu", function () {
                $(".fp-intent-menu").addClass("fp-hidden");
            });

            // Provider management.
            content.find("#fp-provider-select").on("change", function () {
                switchProvider($(this).val());
            });
            content.find("#fp-add-provider").on("click", function () { addProvider(); });
            content.find("#fp-remove-provider").on("click", function () { removeProvider(); });
            content.find("#fp-test-provider").on("click", function () { testProvider(); });
            content.find("#fp-refresh-models").on("click", function () { refreshModels(); });
            content.find("#fp-reset-system-prompt").on("click", function () { resetSystemPrompt(); });
            content.find("#fp-persona-intensity").on("input", updatePersonaLabel);

            // Re-enable Test provider live as the user types a model.
            content.find("#fp-model").on("input", function () {
                el("#fp-test-provider").prop("disabled", !($(this).val() || "").trim());
            });

            content.find("#fp-save-settings").on("click", function () {
                saveSettings(null, true);
            });
            content.find("#fp-add-intent").on("click", function () {
                addCustomIntent();
            });

            // Enter-to-send (Shift+Enter for newline) on the prompt box.
            content.find("#fp-prompt").on("keydown", function (e) {
                if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    dispatchSend();
                }
            });

            // /demo's "breathe" cue on Send is meant to draw the eye right
            // after the prompt is filled in — once the user starts editing
            // it themselves, the nudge has done its job.
            content.find("#fp-prompt").on("input", function () {
                el("#fp-send").removeClass("fp-send-breathe");
            });

            // Custom resize handle (top-right of the prompt box) — drag up to
            // grow the prompt, down to shrink it. Replaces the native
            // bottom-right `resize: vertical` grip, which sat right against
            // the Send/Clear buttons and was fiddly to grab.
            (function () {
                var PROMPT_MIN_HEIGHT = 88;
                var PROMPT_MAX_HEIGHT = 480;
                var dragStartY = null;
                var dragStartHeight = null;

                function onDrag(e) {
                    if (dragStartY === null) { return; }
                    var clientY = e.touches ? e.touches[0].clientY : e.clientY;
                    var next = dragStartHeight + (dragStartY - clientY);
                    next = Math.min(PROMPT_MAX_HEIGHT, Math.max(PROMPT_MIN_HEIGHT, next));
                    el("#fp-prompt").css("height", next + "px");
                    e.preventDefault();
                }

                function endDrag() {
                    dragStartY = null;
                    el("#fp-prompt-resize").removeClass("fp-resizing");
                    $(document)
                        .off("mousemove", onDrag).off("mouseup", endDrag)
                        .off("touchmove", onDrag).off("touchend", endDrag);
                }

                function startDrag(e) {
                    var clientY = e.touches ? e.touches[0].clientY : e.clientY;
                    dragStartY = clientY;
                    dragStartHeight = el("#fp-prompt")[0].offsetHeight;
                    el("#fp-prompt-resize").addClass("fp-resizing");
                    $(document)
                        .on("mousemove", onDrag).on("mouseup", endDrag)
                        .on("touchmove", onDrag).on("touchend", endDrag);
                    e.preventDefault();
                }

                content.find("#fp-prompt-resize").on("mousedown touchstart", startDrag);
            })();

            // Live selection indicator. RED.events fires this whenever the
            // user changes what's selected on the canvas. While armed, a
            // new non-empty selection refreshes the pinned context (an empty
            // selection does NOT clear it — that's what lets follow-ups skip
            // reselection).
            RED.events.on("view:selection-changed", function () {
                if (armedExecuteAction) { pinCurrentSelection(); }
                updateSelectionStatus();
            });

            // /build loop: "deploy" only fires on a SUCCESSFUL deploy (no
            // native "deploy failed" event exists — a failed deploy just
            // shows the user a notification, nothing programmatic), so a
            // failed deploy simply leaves the loop waiting at "apply"
            // rather than advancing — exactly what we want.
            RED.events.on("deploy", function () {
                if (activeBuildLoop && activeBuildLoop.waypoint === "apply") {
                    activeBuildLoop.waypoint = "attach";
                    renderLoopStepper(activeBuildLoop);
                }
            });

            // Pop-out: closing/refreshing the main editor also closes the
            // detached mirror, so it can never be left open and orphaned —
            // same as 21-debug.html's beforeunload handling.
            $(window).on("beforeunload", function () {
                if (popoutWindow) {
                    try { popoutWindow.close(); } catch (e) { /* ignore */ }
                }
            });

            // Pop-out child->parent intents: full Send dispatch
            // ("dispatchSend" — mode + prompt text, the pop-out's own
            // dispatchSend() relays here instead of calling
            // generate/document/modify/build/chat locally, since only the
            // main window has live RED.* context), "/compact"+"/expand"
            // ("runSlashCommand" — same reason), "import this already-
            // reviewed Generate/Document flow", "apply this already-
            // reviewed Modify diff", the /build loop's own apply/fix/stop
            // intents, and "clear the real conversation" (Clear Chat).
            // None of these run anything in the pop-out's own window — all
            // just ask the main window to do exactly what the equivalent
            // sidebar action would. Replies/confirmations reach the
            // pop-out via the existing #fp-messages relay, same as any
            // other new message.
            window.addEventListener("message", function (evt) {
                if (evt.origin !== location.origin) { return; }
                if (evt.source !== popoutWindow) { return; }
                var data = evt.data || {};
                if (data.event === "dispatchSend" && data.prompt) {
                    el("#fp-prompt").val(data.prompt);
                    if (data.mode === "generate") { generate(); }
                    else if (data.mode === "build") { buildFlow(); }
                    else if (data.mode === "document") { documentFlow(); }
                    else if (data.mode === "modify") { modifyFlow(); }
                    else { send("chat"); }
                } else if (data.event === "runSlashCommand" && data.command) {
                    handleSlashCommand(data.command);
                } else if (data.event === "applyGenerated" && Array.isArray(data.flow)) {
                    importGeneratedFlow(data.flow);
                } else if (data.event === "applyModify" && data.data) {
                    var ad = data.data;
                    var idMap = {};
                    if (Array.isArray(ad.newNodes) && ad.newNodes.length) {
                        idMap = applyInsertions(ad.newNodes, ad.newWires || [], ad.existingNodeIds || []) || {};
                    }
                    if (ad.hasMutations) {
                        applyModifications(ad.nodeDiffs || [], ad.removeNodes || [], null, idMap);
                    }
                    if (Array.isArray(ad.newGroups) && ad.newGroups.length) {
                        applyGroupChanges(ad.newGroups, idMap);
                    }
                } else if (data.event === "applyBuild" && data.data && Array.isArray(data.data.flow)) {
                    var bd = data.data;
                    importGeneratedFlow(bd.flow, function (importResult) {
                        startBuildLoop(bd.goal, bd.flow, importResult);
                    });
                } else if (data.event === "applyBuildFix" && data.data) {
                    var bf = data.data;
                    var fixIdMap = {};
                    if (Array.isArray(bf.newNodes) && bf.newNodes.length) {
                        fixIdMap = applyInsertions(bf.newNodes, bf.newWires || [], bf.existingNodeIds || []) || {};
                    }
                    if (bf.hasMutations) {
                        applyBuildLoopFix(bf.nodeDiffs || [], bf.removeNodes || [], fixIdMap, !!bf.capReached);
                    }
                    if (Array.isArray(bf.newGroups) && bf.newGroups.length) {
                        applyGroupChanges(bf.newGroups, fixIdMap);
                    }
                } else if (data.event === "stopBuildLoop") {
                    stopBuildLoop("Build loop stopped. Whatever's already applied stays as-is.");
                } else if (data.event === "clearChat") {
                    clearChat();
                }
            });

            // Build intent buttons from built-in INTENTS plus any user-defined
            // customIntents (loaded from settings). Rebuilt after settings load
            // /save via renderIntents() so new custom buttons appear without a
            // reload.
            renderIntents(content.find("#fp-intents"));

            RED.sidebar.addTab({
                id: "flowpilot",
                label: "FlowPilot",
                name: "FlowPilot",
                iconClass: "fa fa-paper-plane",
                content: content
            });

            loadSettings();
            updateSelectionStatus();
            showChat();
    }

    window.FlowPilotCore = { initMainWindow: initMainWindow, initPopout: initPopout };
})();
