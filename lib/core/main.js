
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

