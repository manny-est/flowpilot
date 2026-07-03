
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
            if (buildLoopNoDebugTimer) { clearTimeout(buildLoopNoDebugTimer); buildLoopNoDebugTimer = null; }
            if (buildLoopAttachTimer) { clearTimeout(buildLoopAttachTimer); }
            buildLoopAttachTimer = setTimeout(function () {
                buildLoopAttachTimer = null;
                if (!activeBuildLoop || activeBuildLoop.waypoint !== "attach") { return; }
                activeBuildLoop.waypoint = "review";
                renderLoopStepper(activeBuildLoop);
                if (currentSettings.loopHoldStep) {
                    renderLoopCheckpoint(activeBuildLoop);
                } else {
                    runBuildReview(activeBuildLoop);
                }
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

    function getAgentLoopMaxIterations() {
        var n = Number(currentSettings.agentLoopMaxIterations);
        return (isFinite(n) && n >= 1) ? n : 5;
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

        if (isPopoutContext) {
            if (window.opener && !window.opener.closed) {
                try { window.opener.postMessage({ event: "requestConversationList" }, location.origin); } catch (e) { /* ignore */ }
            }
            return;
        }
        ajaxJson("GET", "flowpilot/conversations", null, function (data) {
            renderHistoryList(data.conversations || []);
        }, function (msg) {
            $list.empty();
            $("<div>").addClass("fp-consent-hint").text("Unable to load conversation list: " + msg).appendTo($list);
        });
    }

    function deleteAllConversations() {
        if (!window.confirm("Delete ALL saved conversation transcripts? This can't be undone.")) { return; }
        if (isPopoutContext) {
            if (window.opener && !window.opener.closed) {
                try { window.opener.postMessage({ event: "deleteAllConversations" }, location.origin); } catch (e) { /* ignore */ }
            }
            return;
        }
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
            $main.on("click", function () {
                if (isPopoutContext) {
                    showChat();
                    if (window.opener && !window.opener.closed) {
                        try { window.opener.postMessage({ event: "loadConversation", id: c.id }, location.origin); } catch (e) { /* ignore */ }
                    }
                } else {
                    loadConversation(c.id);
                }
            });
            $item.append($main);

            var $del = $("<button>").addClass("fp-history-delete red-ui-button red-ui-button-small")
                .attr("type", "button").attr("title", "Delete this conversation's saved transcript permanently")
                .append($("<i>").addClass("fa fa-trash"));
            $del.on("click", function (ev) {
                ev.stopPropagation();
                if (!window.confirm("Delete this conversation's saved transcript? This can't be undone.")) { return; }
                if (isPopoutContext) {
                    if (window.opener && !window.opener.closed) {
                        try { window.opener.postMessage({ event: "deleteConversation", id: c.id }, location.origin); } catch (e) { /* ignore */ }
                    }
                    return;
                }
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
            relayClearMessagesToPopout();
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
        if (isPopoutContext) {
            if (window.opener && !window.opener.closed) {
                try { window.opener.postMessage({ event: "requestRecallSearch", query: query }, location.origin); } catch (e) { /* ignore */ }
            }
            return;
        }
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
                if (isPopoutContext) {
                    if (window.opener && !window.opener.closed) {
                        try { window.opener.postMessage({ event: "useRecallItem", user: r.user || null, assistant: r.assistant || null }, location.origin); } catch (e) { /* ignore */ }
                    }
                } else {
                    if (r.user) { conversationHistory.push({ role: "user", content: String(r.user) }); }
                    if (r.assistant) { conversationHistory.push({ role: "assistant", content: String(r.assistant) }); }
                }
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
                .attr("data-fp-debug-id", entry.id)
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

    // Node-RED's editor auto-attaches the admin-API auth token to $.ajax
    // calls via a global $.ajaxSetup beforeSend (red.js) — but ONLY for a
    // bare relative URL ("flowpilot/settings"); it explicitly skips any
    // URL starting with "/", "http(s):", or ".". flowpilotUrl() below
    // always returns a leading-slash absolute path (needed so the pop-out's
    // nested route still resolves correctly), which means neither $.ajax
    // (ajaxJson, below) nor raw fetch() (SSE streaming) ever got the token
    // attached automatically — confirmed live as "Unable to load FlowPilot
    // settings: Unauthorized" on an adminAuth-enabled instance (v0.4.1).
    // Both attach it themselves instead, via this same lookup.
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
            beforeSend: function (jqXHR) {
                var tokens = RED.settings.get("auth-tokens");
                if (tokens && tokens.access_token) {
                    jqXHR.setRequestHeader("Authorization", "Bearer " + tokens.access_token);
                }
            },
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
        el("#fp-loop-hold-step").prop("checked", !!settings.loopHoldStep);
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
            loopHoldStep: el("#fp-loop-hold-step").prop("checked"),
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
        if (isPopoutContext) {
            if (window.opener && !window.opener.closed) {
                try { window.opener.postMessage({ event: "requestSettings" }, location.origin); } catch (e) { /* ignore */ }
            }
            return;
        }
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
        "- `/build` — describe a goal; I'll plan, propose, and walk an iterative build → deploy → debug → review → fix loop with you\n" +
        "- `/compact` — hide labels on the selected node(s) (icon-only); `/expand` restores them. Instant, no AI involved — one Ctrl+Z undoes it.\n" +
        "- `/disable` — disable the selected node(s) (skipped on Deploy); `/enable` re-enables them. Instant, no AI involved — one Ctrl+Z undoes it.\n\n" +
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
            // Same deterministic pattern as /compact+/expand above, just
            // toggling the "d" (disabled) flag instead of label visibility —
            // Node-RED's own native "core:enable-selected-nodes"/
            // "core:disable-selected-nodes" actions (confirmed present in
            // both NR4 and NR5, the same actions the right-click context menu
            // uses) already batch every affected node into one compound undo
            // step and skip no-ops, so there's nothing to reimplement here.
            case "/disable":
            case "/enable":
                if (isPopoutContext) {
                    if (window.opener && !window.opener.closed) {
                        try { window.opener.postMessage({ event: "runSlashCommand", command: command }, location.origin); } catch (e) { /* ignore */ }
                    }
                    if ($promptBox.length) { $promptBox.val(""); }
                    break;
                }
                var dSel = (RED.view && RED.view.selection) ? RED.view.selection() : null;
                var dSelCount = (dSel && dSel.nodes) ? dSel.nodes.length : 0;
                if (dSelCount === 0) {
                    addMessage("error", "Select one or more nodes first.");
                    if ($promptBox.length) { $promptBox.val(""); }
                    break;
                }
                if (command === "/enable") {
                    RED.actions.invoke("core:enable-selected-nodes");
                    addMessage("assistant", "Touchdown — enabled " + dSelCount +
                        " node" + (dSelCount === 1 ? "" : "s") + ". Ctrl+Z to undo.");
                } else {
                    RED.actions.invoke("core:disable-selected-nodes");
                    addMessage("assistant", "Touchdown — disabled " + dSelCount +
                        " node" + (dSelCount === 1 ? "" : "s") + ". Ctrl+Z to undo.");
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

    // Rebinds the "Attach" buttons in a relayed debug-log panel. The
    // original handlers (closures over debugMessageBuffer entries) don't
    // survive outerHTML serialization — same problem Apply buttons had.
    // Each button carries data-fp-debug-id; clicking relays the entry id
    // to the parent, which finds it in its own debugMessageBuffer and
    // pushes it to attachedDebugMessages (then calls updateDebugStatus,
    // which already calls relayStatusStripToPopout to sync the counter).
    function bindDebugAttachButtons($scope) {
        $scope.filter("[data-fp-debug-id]").add($scope.find("[data-fp-debug-id]")).each(function () {
            var $btn = $(this);
            if ($btn.data("fp-debug-attach-bound")) { return; }
            $btn.data("fp-debug-attach-bound", true);
            var entryId = $btn.attr("data-fp-debug-id");
            $btn.on("click", function () {
                if (!window.opener || window.opener.closed) { return; }
                $btn.prop("disabled", true).text("Attached");
                try { window.opener.postMessage({ event: "attachDebug", entryId: entryId }, location.origin); } catch (e) { /* ignore */ }
            });
        });
    }

    function bindPromptResize() {
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

        el("#fp-prompt-resize").on("mousedown touchstart", startDrag);
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
            '        <button id="fp-recall" class="red-ui-button red-ui-button-small" type="button" title="Recall: search earlier conversations for the text in the prompt box"><i class="fa fa-search"></i></button>' +
            '        <button id="fp-debug-log" class="red-ui-button red-ui-button-small" type="button" title="Debug log: view recent Debug sidebar output and attach messages as context"><i class="fa fa-bug"></i></button>' +
            '        <button id="fp-show-chat" class="red-ui-button red-ui-button-small" type="button" title="Chat"><i class="fa fa-comments"></i></button>' +
            '        <button id="fp-show-history" class="red-ui-button red-ui-button-small" type="button" title="Flight log — past conversations"><i class="fa fa-history"></i></button>' +
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
            '        <div id="fp-prompt-resize" class="fp-resize-handle" title="Drag to resize"><i class="fa fa-arrows-v"></i></div>' +
            '      </div>' +
            '      <div class="fp-status-strip">' +
            '        <span id="fp-selection-status" class="fp-selection-status">No nodes selected</span>' +
            '        <a href="#" id="fp-preview-nodes" class="fp-preview-link fp-hidden" title="Open this from the main window to see the exact sanitized node JSON">Preview JSON</a>' +
            '        <span id="fp-size-status" class="fp-size-status fp-hidden"></span>' +
            '        <span id="fp-secrets-status" class="fp-secrets-status fp-hidden" title="Context may include node config and code. Don\'t send credentials or proprietary data. Local/private AI recommended.">⚠</span>' +
            '        <span id="fp-debug-status" class="fp-debug-status fp-hidden"></span>' +
            '        <a href="#" id="fp-debug-clear" class="fp-hidden" title="Remove all attached debug messages">✕</a>' +
            '        <span class="fp-status-spacer"></span>' +
            '        <div id="fp-provider-status">Provider: not loaded</div>' +
            '        <button id="fp-clear-prompt" class="red-ui-button" type="button" title="Clear prompt box">Clear</button>' +
            '        <button id="fp-send" class="red-ui-button red-ui-button-primary" type="button">Send</button>' +
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
        el("#fp-show-chat").on("click", showChat);
        el("#fp-show-history").on("click", showHistory);
        el("#fp-history-delete-all").on("click", deleteAllConversations);
        el("#fp-recall").on("click", recallSearch);
        el("#fp-debug-log").on("click", function () {
            if (window.opener && !window.opener.closed) {
                try { window.opener.postMessage({ event: "requestDebugBuffer" }, location.origin); } catch (e) { /* ignore */ }
            }
        });
        el("#fp-debug-clear").on("click", function (ev) {
            ev.preventDefault();
            if (window.opener && !window.opener.closed) {
                try { window.opener.postMessage({ event: "clearAttachedDebug" }, location.origin); } catch (e) { /* ignore */ }
            }
        });
        el("#fp-preview-nodes").on("click", function (ev) {
            ev.preventDefault();
            addMessage("error", "Preview JSON isn't available in the pop-out yet — open it from the main window.");
        });
        bindPromptResize();

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
                bindDebugAttachButtons(el("#fp-messages"));
                scrollMessagesToBottom(true);
            } else if (data.event === "appendMessage") {
                el("#fp-messages").append(data.html);
                bindApplyButtons(el("#fp-messages").children().last());
                bindModifyApplyButtons(el("#fp-messages").children().last());
                bindBuildApplyButtons(el("#fp-messages").children().last());
                bindBuildFixApplyButtons(el("#fp-messages").children().last());
                bindStopLoopButton(el("#fp-messages").children().last());
                bindTabSwitching(el("#fp-messages").children().last());
                bindDebugAttachButtons(el("#fp-messages").children().last());
                scrollMessagesToBottom();
            } else if (data.event === "removeMessage") {
                el("#" + data.id).remove();
            } else if (data.event === "clearMessages") {
                el("#fp-messages").empty();
            } else if (data.event === "debugBufferSnapshot") {
                showChat();
                var entries = data.entries || [];
                var attachedSet = {};
                (data.attachedIds || []).forEach(function (id) { attachedSet[id] = true; });
                if (!entries.length) {
                    addMessage("assistant", "No debug messages captured yet. Trigger a flow with a Debug node wired to the sidebar, then try again.");
                    return;
                }
                var $dbgMsg = $("<div>").addClass("fp-message fp-recall");
                $("<div>").addClass("fp-label").text("DEBUG LOG").appendTo($dbgMsg);
                $("<div>").addClass("fp-debug-warning").text("Debug payloads can contain credentials from connected " +
                    "systems. Common secret patterns are redacted automatically, but review before attaching.").appendTo($dbgMsg);
                entries.forEach(function (entry) {
                    var $item = $("<div>").addClass("fp-recall-item");
                    var when = new Date(entry.timestamp).toLocaleTimeString();
                    var meta = when + " · " + entry.name + (entry.topic ? " · topic: " + entry.topic : "");
                    $("<div>").addClass("fp-recall-meta").text(meta).appendTo($item);
                    $("<div>").addClass("fp-recall-text").text(entry.previewValue).appendTo($item);
                    var already = !!attachedSet[entry.id];
                    var $btn = $("<button>").addClass("fp-recall-use red-ui-button red-ui-button-small")
                        .attr("type", "button").prop("disabled", already).text(already ? "Attached" : "Attach");
                    $btn.on("click", function () {
                        $btn.prop("disabled", true).text("Attached");
                        if (window.opener && !window.opener.closed) {
                            try { window.opener.postMessage({ event: "attachDebug", entryId: entry.id }, location.origin); } catch (e) { /* ignore */ }
                        }
                    });
                    $item.append($btn);
                    $dbgMsg.append($item);
                });
                el("#fp-messages").append($dbgMsg);
                scrollMessagesToBottom();
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
                el("#fp-debug-clear").toggleClass("fp-hidden", !!s.debugHidden);
            } else if (data.event === "recallResults") {
                hidePending();
                setBusy(false);
                renderRecallResults(data.results || []);
            } else if (data.event === "recallError") {
                hidePending();
                setBusy(false);
                addMessage("error", data.msg || "Recall search failed.");
            } else if (data.event === "conversationList") {
                renderHistoryList(data.conversations || []);
            } else if (data.event === "settingsLoaded") {
                fillSettings(data.settings);
                renderIntents(el("#fp-intents"));
                updateSelectionStatus();
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
                '      <div class="fp-consent-hint">When using the deploy-verify loop, how many build → deploy → ' +
                '        test → fix cycles to try before stopping with an honest "couldn\'t fully verify" ' +
                '        instead of proposing another fix.</div>' +
                '      <label class="fp-checkbox-row">' +
                '        <input id="fp-loop-hold-step" type="checkbox"> ' +
                '        Hold at each loop checkpoint (wait for confirmation before AI review)' +
                '      </label>' +
                '      <div class="fp-consent-hint">When checked, the loop pauses after auto-attaching debug ' +
                '        output and shows a "Continue review / Stop" prompt before sending to the AI. ' +
                '        When unchecked (default), the loop advances automatically.</div>' +

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

            bindPromptResize();

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
                    // Start a timer so flows with no debug nodes (e.g. HTTP
                    // endpoints) don't leave the loop stuck silently waiting.
                    buildLoopNoDebugTimer = setTimeout(function () {
                        buildLoopNoDebugTimer = null;
                        if (!activeBuildLoop || activeBuildLoop.waypoint !== "attach") { return; }
                        addMessage("assistant",
                            "No debug output detected yet. If this flow doesn't produce " +
                            "automatic debug output (e.g. it's an HTTP endpoint), trigger " +
                            "it and paste the response here — or describe what happened " +
                            "and I'll review from that.");
                    }, BUILD_LOOP_NO_DEBUG_TIMEOUT_MS);
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
                    stopBuildLoop("Build loop stopped — applied nodes remain as-is.");
                } else if (data.event === "clearChat") {
                    clearChat();
                } else if (data.event === "requestDebugBuffer") {
                    var snapshot = debugMessageBuffer.slice();
                    var attachedIds = attachedDebugMessages.map(function (e) { return e.id; });
                    try { popoutWindow.postMessage({ event: "debugBufferSnapshot", entries: snapshot, attachedIds: attachedIds }, location.origin); } catch (e) { /* ignore */ }
                } else if (data.event === "attachDebug" && data.entryId) {
                    var found = null;
                    for (var i = 0; i < debugMessageBuffer.length; i++) {
                        if (debugMessageBuffer[i].id === data.entryId) { found = debugMessageBuffer[i]; break; }
                    }
                    if (found) {
                        var alreadyIn = attachedDebugMessages.some(function (e) { return e.id === data.entryId; });
                        if (!alreadyIn) { attachedDebugMessages.push(found); updateDebugStatus(); }
                    }
                } else if (data.event === "useRecallItem") {
                    if (data.user) { conversationHistory.push({ role: "user", content: String(data.user) }); }
                    if (data.assistant) { conversationHistory.push({ role: "assistant", content: String(data.assistant) }); }
                    updateSelectionStatus();
                } else if (data.event === "loadConversation" && data.id) {
                    loadConversation(data.id);
                } else if (data.event === "requestRecallSearch" && data.query) {
                    ajaxJson("POST", "flowpilot/recall", { query: data.query, conversationId: conversationId }, function (result) {
                        try { popoutWindow.postMessage({ event: "recallResults", results: result.results || [] }, location.origin); } catch (e) { /* ignore */ }
                    }, function (msg) {
                        try { popoutWindow.postMessage({ event: "recallError", msg: msg }, location.origin); } catch (e) { /* ignore */ }
                    });
                } else if (data.event === "requestConversationList") {
                    ajaxJson("GET", "flowpilot/conversations", null, function (result) {
                        try { popoutWindow.postMessage({ event: "conversationList", conversations: result.conversations || [] }, location.origin); } catch (e) { /* ignore */ }
                    }, function () {
                        try { popoutWindow.postMessage({ event: "conversationList", conversations: [] }, location.origin); } catch (e) { /* ignore */ }
                    });
                } else if (data.event === "deleteConversation" && data.id) {
                    ajaxJson("DELETE", "flowpilot/conversations/" + encodeURIComponent(data.id), null, function () {
                        ajaxJson("GET", "flowpilot/conversations", null, function (result) {
                            try { popoutWindow.postMessage({ event: "conversationList", conversations: result.conversations || [] }, location.origin); } catch (e) { /* ignore */ }
                        });
                    });
                } else if (data.event === "deleteAllConversations") {
                    ajaxJson("DELETE", "flowpilot/conversations", null, function () {
                        try { popoutWindow.postMessage({ event: "conversationList", conversations: [] }, location.origin); } catch (e) { /* ignore */ }
                    });
                } else if (data.event === "clearAttachedDebug") {
                    attachedDebugMessages = [];
                    updateDebugStatus();
                } else if (data.event === "requestSettings") {
                    ajaxJson("GET", "flowpilot/settings", null, function (result) {
                        try { popoutWindow.postMessage({ event: "settingsLoaded", settings: result }, location.origin); } catch (e) { /* ignore */ }
                    });
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
