
    var VERSION = "0.5.1";

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

    // ---------------------------------------------------------------------
    // Shadow record store (Phase 10, Workstream 0A).
    // Every code path that appends DOM to #fp-messages also appends a record
    // here. refreshView() clears the message container and re-renders from
    // records, restoring interactive elements without losing conversation.
    // Records are in-memory only — no full sessionStorage persistence.
    // Only the minimal interrupted-run marker is persisted separately.
    // ---------------------------------------------------------------------
    var messageRecords = [];
    var _nextRecordId = 0;

    // P10-D1 (ADR-001 R5): per-conversation map of opId -> already-applied
    // WRITE tool result. opId = runId + ":" + call.id (runId minted per
    // runAgentLoop run, modes.js). A repeat opId (duplicate delivery, a
    // retry, or the model repeating a call) returns the SAME result without
    // re-invoking the executor — the graph is mutated at most once per
    // opId. Keyed first by conversationId so switching conversations
    // (clearChat / loading a saved transcript) can't cross-contaminate;
    // cleared for the outgoing conversationId at those same points. In-
    // memory only, matching messageRecords/conversationHistory's existing
    // volatility (ADR-001: "persistence is minimal and schema-ready this
    // phase" — full state-machine persistence is deferred to phase close).
    var appliedOpsByConversation = {};

    function getAppliedOp(convId, opId) {
        var ops = appliedOpsByConversation[convId];
        return ops ? ops[opId] : undefined;
    }

    function recordAppliedOp(convId, opId, result) {
        if (!appliedOpsByConversation[convId]) { appliedOpsByConversation[convId] = {}; }
        appliedOpsByConversation[convId][opId] = result;
    }

    function addRecord(kind, payload) {
        var rec = { id: _nextRecordId++, ts: Date.now(), kind: kind };
        if (payload) {
            Object.keys(payload).forEach(function (k) { rec[k] = payload[k]; });
        }
        messageRecords.push(rec);
        return rec;
    }

    // Phase 11 (Plan/Act) dev hook: exercise the Act chip from a fixture
    // payload without a live propose_action tool call. Gated behind
    // debugLogging so it never surfaces outside an explicit test session.
    // Remove once real Act dispatch wiring makes this unnecessary.
    window.__flowpilotDebugRenderProposeAction = function (payload) {
        if (!currentSettings.debugLogging) {
            console.warn("__flowpilotDebugRenderProposeAction requires debugLogging to be enabled in Settings.");
            return;
        }
        var rec = addRecord("chip", { chipType: "proposeAction", proposeAction: payload, decision: null });
        renderProposeActionChip(rec);
    };

    function refreshView() {
        var records = messageRecords.slice();
        var $box = el("#fp-messages");
        if (!$box.length) { return; }
        messageRecords = [];
        $box.empty();
        records.forEach(rerenderRecord);
        scrollMessagesToBottom(true);
        // Sync pop-out: cheapest approach is a full re-sync of the
        // refreshed HTML (same as the initial pop-out open sync).
        if (popoutWindow && !popoutWindow.closed) {
            try {
                popoutWindow.postMessage({
                    event: "initialSync",
                    html: el("#fp-messages").html()
                }, location.origin);
            } catch (e) { /* ignore */ }
        }
    }

    function rerenderRecord(rec) {
        if (!rec) { return; }
        switch (rec.kind) {
            case "chat":
                addMessage(rec.role || "assistant", rec.text || "");
                break;
            case "chip":
                if (rec.chipType === "suggestedAction") { renderActionChip(rec.suggestedAction); }
                else if (rec.chipType === "proposeAction") { renderProposeActionChip(rec); }
                break;
            case "question":
                if (rec.loopCheckpoint) {
                    renderLoopCheckpoint(activeBuildLoop);
                } else if (rec.diffGatePause) {
                    renderDiffGatePause(rec);
                } else if (rec.buildConsentGate) {
                    renderBuildConsentGate(rec);
                } else if (rec.agentToolConsent) {
                    renderAgentToolConsentGate(rec);
                } else if (rec.askUserTool) {
                    renderAskUserQuestion(rec);
                } else {
                    renderClarifyingQuestion(rec.options || []);
                }
                break;
            case "review":
                rerenderReviewRecord(rec);
                break;
            case "buildStep":
                rerenderBuildStepRecord(rec);
                break;
            case "todo":
                rerenderTodoRecord(rec);
                break;
        }
    }

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
            sourceKind: "debug",
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
        if (buildRuntimeEvidence && buildRuntimeTapIds && buildRuntimeTapIds[msg.id]) {
            buildRuntimeEvidence.push({ kind: "debug", nodeId: msg.id || null, name: entry.name, value: entry.value, at: entry.timestamp });
        }
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
        // WS4: a Skip decision at the build consent gate excludes this tap's
        // real id from skipCheckpointTapIds — its messages still arrive here
        // (still shown in the debug-log list/updateDebugStatus above) but
        // don't drive the auto-attach/auto-review transition, so the loop
        // falls back to manual confirmation or the honest-timeout instead.
        if (activeBuildLoop && activeBuildLoop.waypoint === "attach" &&
            activeBuildLoop.nodeIds.indexOf(msg.id) !== -1 &&
            (activeBuildLoop.skipCheckpointTapIds || []).indexOf(msg.id) === -1) {
            attachedDebugMessages.push(entry);
            updateDebugStatus();
            if (buildLoopNoDebugTimer) { clearTimeout(buildLoopNoDebugTimer); buildLoopNoDebugTimer = null; }
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

    // W3: node-status stream evidence path.
    // Fires for every deployed node that sets a status (fill/text via
    // node.status() in user function code, or core nodes like http-request
    // reporting "200 OK" / error text). Topic is "status/<nodeId>".
    // Used as fallback evidence when the loop is waiting at "attach" but no
    // debug node exists (HTTP endpoints, background workers, etc.) — gives
    // the model something real to review instead of the loop hanging until
    // the 20-second honest-timeout fires.
    // Only used when no debug payload has arrived yet; if debug output is
    // coming the richer payload data wins — let that path take over.
    function onNodeStatus(topic, msg) {
        if (buildRuntimeEvidence && buildRuntimeStatusIds && msg && msg.fill !== "blue") {
            var sid = String(topic || "").split("/")[1] || null;
            var stext = [msg.fill, msg.text].filter(Boolean).join(" — ");
            var sn = sid && typeof RED !== "undefined" ? RED.nodes.node(sid) : null;
            if (stext && buildRuntimeStatusIds[sid]) {
                buildRuntimeEvidence.push({ kind: "status", nodeId: sid, name: (sn && (sn.name || sn.type)) || sid, value: stext, at: Date.now() });
            }
        }
        if (!activeBuildLoop || activeBuildLoop.waypoint !== "attach") { return; }
        var nodeId = topic.split("/")[1];
        if (!nodeId || activeBuildLoop.nodeIds.indexOf(nodeId) === -1) { return; }
        // WS4: same Skip-decision gate as onDebugMessage, keyed on the
        // side-effecting node's own real id here (status events report the
        // node itself, not a debug tap wired to it).
        if ((activeBuildLoop.skipCheckpointNodeIds || []).indexOf(nodeId) !== -1) { return; }
        if (freshBuildLoopEvidence(activeBuildLoop).length > 0) { return; }

        // Skip in-progress ("blue") statuses — e.g. http-request emits
        // fill:"blue" text:"requesting" before any response arrives. Locking
        // in this early status starts the debounce before the actual error or
        // response has a chance to land, so the model reviews a placeholder
        // rather than the real result. Only terminal states (red=error,
        // green=success, or no fill) are useful evidence.
        if (msg && msg.fill === "blue") { return; }

        var statusText = [msg && msg.fill, msg && msg.text].filter(Boolean).join(" — ");
        if (!statusText) { return; }

        var entry = {
            id: nextDebugMessageId++,
            timestamp: Date.now(),
            sourceKind: "status",
            name: nodeId + " (node status)",
            topic: "node-status",
            previewValue: statusText,
            value: "Node " + nodeId + " reported status: " + statusText
        };
        attachedDebugMessages.push(entry);
        updateDebugStatus();

        if (buildLoopNoDebugTimer) { clearTimeout(buildLoopNoDebugTimer); buildLoopNoDebugTimer = null; }
        if (buildLoopAttachTimer) { clearTimeout(buildLoopAttachTimer); }
        buildLoopAttachTimer = setTimeout(function () {
            buildLoopAttachTimer = null;
            if (!activeBuildLoop || activeBuildLoop.waypoint !== "attach") { return; }
            activeBuildLoop.waypoint = "review";
            renderLoopStepper(activeBuildLoop);
            runBuildReview(activeBuildLoop);
        }, BUILD_LOOP_ATTACH_DEBOUNCE_MS);
    }

    // CLAUDE-025: attachedDebugMessages is deliberately STICKY across turns
    // (see the block comment above — "sticky, like conversationHistory,
    // until removed or Clear Chat"), which is exactly right for ordinary
    // chat/generate/modify context. But the /build loop's own verification
    // step must NOT inherit that stickiness: reviewing against a debug
    // message left over from an earlier Build attempt (or one attached
    // manually via the popout, or a still-running unrelated flow) as if it
    // were evidence for THIS attempt's own goal is how a later attempt can
    // declare Touchdown without ever having deployed or checked its own
    // output. loop.deployedAt is stamped (see init.js's "deploy" listener)
    // the moment THIS attempt's own "apply"->"attach" transition fires, so
    // filtering on it scopes evidence to messages that arrived at or after
    // that specific redeploy — never null (build review only runs once the
    // loop has reached "attach", which requires deployedAt to be set).
    function freshBuildLoopEvidence(loop) {
        if (!loop || typeof loop.deployedAt !== "number") { return []; }
        return attachedDebugMessages.filter(function (m) {
            return m.timestamp >= loop.deployedAt;
        });
    }

    // The exact shape sent to the backend (and shown by "Preview debug") —
    // excludes previewValue, which exists only for the debug-log list.
    function buildDebugMessagesForSend() {
        return attachedDebugMessages.map(function (m) {
            return {
                id: m.id,
                timestamp: m.timestamp,
                sourceKind: m.sourceKind,
                name: m.name,
                topic: m.topic,
                value: m.value
            };
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
    // One-shot Send-menu choice. Unlike settings.auto/restricted this is
    // deliberately memory-only and is consumed by the next real send.
    var nextSendFlags = null;

    function setNextSendFlags(flags) {
        nextSendFlags = Object.assign({}, nextSendFlags || {}, flags || {});
        renderNextSendFlags();
    }

    // The ▾ menu: one choice at a time, replacing any earlier one;
    // "normal" clears it.
    function chooseNextSendFlag(choice) {
        nextSendFlags = null;
        if (choice === "planFirst" || choice === "justDoIt") {
            var flags = {};
            flags[choice] = true;
            setNextSendFlags(flags);
            return;
        }
        renderNextSendFlags();
    }

    function consumeNextSendFlags() {
        var flags = nextSendFlags || {};
        nextSendFlags = null;
        renderNextSendFlags();
        return flags;
    }

    // The armed one-shot choice shows on the ▾ button until the next send
    // uses it, so the user can see what that send will do (live: picking
    // "Plan first" left no visible trace).
    function renderNextSendFlags() {
        var flags = nextSendFlags || {};
        var label = flags.planFirst ? "Plan first" : flags.justDoIt ? "Just do it" : "";
        el("#fp-send-menu")
            .text(label ? "▾ " + label : "▾")
            .toggleClass("fp-send-menu-armed", !!label)
            .attr("title", label ? "Next send: " + label + " (click to change)" : "Choose how the next send is handled");
    }

    // ids of the selection PINNED for the current armed session. Set when
    // arming with a selection, or refreshed whenever the live selection
    // changes while armed (non-empty only — deselecting keeps the pin so
    // follow-up turns need no reselection). Cleared on disarm/Clear Chat.
    var pinnedSelectionIds = null;

    function disarmExecuteAction() {
        if (!armedExecuteAction) { return; }
        armedExecuteAction = null;
        pinnedSelectionIds = null;
        el("#fp-generate, #fp-document, #fp-modify, #fp-build").removeClass("fp-action-armed");
        el("#fp-send").text("Send").removeClass("fp-send-armed");
        el(".fp-compose").removeClass("fp-mode-execute");
    }

    function setArmedExecuteAction(action) {
        if (armedExecuteAction === action) { disarmExecuteAction(); return; }
        disarmQueryIntent();
        armedExecuteAction = action;
        pinCurrentSelection();
        ["generate", "document", "modify", "build"].forEach(function (m) {
            el("#fp-" + m).toggleClass("fp-action-armed", armedExecuteAction === m);
        });
        el("#fp-send").text("Send").addClass("fp-send-armed");
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
    // side's blue treatment. Identified by label since built-in labels are
    // unique. One-shot — dispatchSend() disarms it, since Query intents are
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

    // Built-in query intents remain action-bar buttons. User-defined prompts
    // are saved slash prompts and are intentionally not rendered as buttons.
    function getAllIntents() {
        return INTENTS.map(function (i) {
            return { id: i.id, label: i.label, text: i.text, custom: false };
        });
    }

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

        getAllIntents().forEach(addIntentButton);
    }

    function renderEmptyState() {
        var $box = el("#fp-messages");
        if (!$box.length || messageRecords.length) { return; }
        var examples = [
            { label: "Explain what this flow does", text: "Explain what this flow does" },
            { label: "Add a debug node after the selected node", text: "Add a debug node after the selected node" },
            { label: "Make this inject fire every 5 seconds", text: "Make this inject fire every 5 seconds" },
            { label: "Document the selected nodes", text: "Document the selected nodes" }
        ];
        var saved = Array.isArray(currentSettings.savedPrompts) ? currentSettings.savedPrompts : [];
        saved.forEach(function (prompt) {
            if (prompt && prompt.name && prompt.text !== undefined) {
                examples.push({ label: prompt.name, text: prompt.text });
            }
        });
        var $state = $box.find("#fp-empty-state");
        if (!$state.length) {
            $state = $("<div>").attr("id", "fp-empty-state").addClass("fp-empty-state");
            $("<div>").addClass("fp-empty-title").text("Start with an example").appendTo($state);
            $state.appendTo($box);
        }
        var $examples = $state.find(".fp-empty-examples");
        if (!$examples.length) { $examples = $("<div>").addClass("fp-empty-examples").appendTo($state); }
        $examples.empty();
        examples.forEach(function (example) {
            $("<button>").attr("type", "button").addClass("fp-empty-example")
                .text(example.label).attr("title", "Fill the prompt; review before sending")
                .attr("data-fp-example", example.text).appendTo($examples);
        });
    }

    // Working copy of saved prompts while editing in Settings. Each prompt
    // is { name: "/slug", text: "..." } and is sent with the next save.
    var editingSavedPrompts = [];

    function renderSavedPromptList() {
        var $list = el("#fp-saved-prompts");
        if (!$list.length) { return; }
        editingSavedPrompts = Array.isArray(currentSettings.savedPrompts)
            ? currentSettings.savedPrompts.map(function (p) {
                return { name: p.name, text: p.text };
            })
            : [];
        $list.empty();
        if (!editingSavedPrompts.length) {
            $("<div>").addClass("fp-consent-hint")
                .text("No saved prompts yet. Add one below.")
                .appendTo($list);
        }
        editingSavedPrompts.forEach(function (item, idx) {
            var $row = $("<div>").addClass("fp-saved-prompt-row");
            var $name = $("<input>").attr("type", "text").attr("placeholder", "/prompt-name").val(item.name);
            var $text = $("<textarea>").attr("placeholder", "Prompt text").val(item.text);
            $name.on("input", function () { item.name = $(this).val(); });
            $text.on("input", function () { item.text = $(this).val(); });
            $row.append($name).append($text);
            $("<button>")
                .addClass("red-ui-button red-ui-button-small")
                .attr("type", "button")
                .text("Delete")
                .on("click", function () {
                    editingSavedPrompts.splice(idx, 1);
                    currentSettings.savedPrompts = editingSavedPrompts.slice();
                    renderSavedPromptList();
                    renderEmptyState();
                    saveSettings();
                })
                .appendTo($row);
            $row.appendTo($list);
        });
    }

    function savedPromptName(raw, index, taken) {
        var name = String(raw || "prompt-" + (index + 1)).trim().toLowerCase()
            .replace(/^\/+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "prompt";
        if (SLASH_COMMANDS.some(function (command) { return command.cmd === "/" + name; })) { name += "-prompt"; }
        var full = "/" + name;
        var suffix = 2;
        while (taken[full]) { full = "/" + name + "-" + suffix++; }
        taken[full] = true;
        return full;
    }

    function normalizedSavedPrompts(list) {
        var taken = {};
        return (Array.isArray(list) ? list : []).map(function (prompt, index) {
            prompt = prompt || {};
            return { name: savedPromptName(prompt.name, index, taken), text: String(prompt.text === undefined ? "" : prompt.text) };
        });
    }

    function addSavedPrompt() {
        var name = (el("#fp-new-prompt-name").val() || "").trim();
        var text = el("#fp-new-prompt-text").val() || "";
        if (!name || !text.trim()) {
            addMessage("error", "A saved prompt needs both a name and prompt text.");
            return;
        }
        editingSavedPrompts.push({ name: name, text: text });
        currentSettings.savedPrompts = normalizedSavedPrompts(editingSavedPrompts);
        el("#fp-new-prompt-name").val("");
        el("#fp-new-prompt-text").val("");
        renderSavedPromptList();
        renderEmptyState();
        saveSettings();
    }

    function el(sel) {
        return $root ? $root.find(sel) : $();
    }

    // ---- View switching -------------------------------------------------

    // CLAUDE-024: every mode-tab switch disarms whatever Execute action
    // (Generate/Document/Modify) or Query intent was armed before the
    // switch. Without this, arming Modify then tabbing away and back to
    // Chat left armedExecuteAction pointing at the stale mutating action,
    // so a plain question typed on what LOOKS like a fresh Chat tab still
    // dispatched through Modify/Generate/Document on Send — a real
    // unintended-mutation bug (reproduced: an unwanted node deletion).
    // Send must always route to whatever is actually visible.
    function disarmForModeSwitch() {
        disarmExecuteAction();
        disarmQueryIntent();
    }

    function showChat() {
        disarmForModeSwitch();
        el("#fp-chat-panel").removeClass("fp-hidden");
        el("#fp-settings-panel").addClass("fp-hidden");
        el("#fp-history-panel").addClass("fp-hidden");
        el("#fp-show-chat").addClass("fp-active");
        el("#fp-show-settings").removeClass("fp-active");
        el("#fp-show-history").removeClass("fp-active");
    }

    function showSettings() {
        disarmForModeSwitch();
        el("#fp-settings-panel").removeClass("fp-hidden");
        el("#fp-chat-panel").addClass("fp-hidden");
        el("#fp-history-panel").addClass("fp-hidden");
        el("#fp-show-settings").addClass("fp-active");
        el("#fp-show-chat").removeClass("fp-active");
        el("#fp-show-history").removeClass("fp-active");
    }

    function showHistory() {
        disarmForModeSwitch();
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
        flowpilotStorageLog("log", "clearChat-enter", {
            conversationId: conversationId,
            messageCount: messageRecords.length,
            href: location.href
        });
        endActiveRun("clear-chat");
        el("#fp-messages").empty();
        messageRecords = [];
        relayClearMessagesToPopout();
        conversationHistory = [];
        attachedDebugMessages = [];
        activeBuildLoop = null;
        activeActRun = null;
        recentActBuild = null;
        queuedMessage = null;
        updateQueuedIndicator();
        disarmExecuteAction(); // also clears pinnedSelectionIds
        delete appliedOpsByConversation[conversationId];
        if (conversationTouchedIndex && conversationTouchedIndex.reset) { conversationTouchedIndex.reset(); }
        conversationId = newConversationId();
        clearRunMarker("clearChat");
        fpChatSnappedToBottom = true;
        updateSelectionStatus();
        updateDebugStatus();
        showChat();
        renderEmptyState();
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
    // onError: optional — CLAUDE-029's page-load rehydration passes one to
    // stay quiet (no chat error bubble) and clear a stale sessionStorage
    // entry on 404, instead of the ajaxJson default of addMessage("error", …).
    function loadConversation(id, onError, onLoaded, options) {
        options = options || {};
        flowpilotStorageLog("log", "loadConversation-start", {
            requestedConversationId: id,
            currentConversationId: conversationId,
            href: location.href
        });
        ajaxJson("GET", "flowpilot/conversations/" + encodeURIComponent(id), null, function (data) {
            delete appliedOpsByConversation[conversationId];
            conversationId = id;
            persistConversationId(id, "loadConversation success");
            if (!options.preserveRunMarker) { clearRunMarker("loadConversation"); }

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
            if (conversationTouchedIndex && conversationTouchedIndex.reset) { conversationTouchedIndex.reset(); }
            updateSelectionStatus();
            showChat();
            if (onLoaded) { onLoaded(data); }
        }, onError);
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
        $box.find("#fp-empty-state").remove();

        var label = role === "user" ? "YOU" : role === "error" ? "ERROR" : "FLOWPILOT";
        var cls = "fp-message" + (role === "user" ? " fp-user" :
            role === "error" ? " fp-error" :
            role === "fp-notice" ? " fp-secondary" : "");

        var $msg = $("<div>").addClass(cls);
        $("<div>").addClass("fp-label").text(label).appendTo($msg);
        $("<div>").addClass("fp-md").html(renderMarkdown(text || "")).appendTo($msg);

        $box.append($msg);
        var _rec = addRecord("chat", { role: role, text: text || "" });
        // Sending a message always jumps to the bottom and resumes
        // auto-follow; an incoming message only follows if already snapped.
        scrollMessagesToBottom(role === "user");
        return _rec;
    }

    // Pending "typing" indicator shown in the thread while awaiting a reply.
    // Lives where the answer will appear, so the eye is already there. Always
    // removed in both the success and error paths so it can't get stuck.
    // showStop adds a "Stop" button, used by the agent loop
    // (runAgentChat) so the user can interrupt a multi-step tool-call run.
    //
    // fpPendingStartedAt / fpPendingElapsedInterval drive the live elapsed-time
    // counter (.fp-typing-elapsed). Real timing data (corpus + live browser
    // testing, ~150+ requests) is bimodal: the overwhelming majority finish in
    // 2-13s, with rare genuine outliers around 73-77s and nothing observed in
    // between. FP_PENDING_SLOW_MS picks 25s as the "this is a slow one"
    // threshold — comfortably past every normal request, comfortably before
    // the real outliers, so the reassurance text only ever appears when it's
    // actually warranted.
    var fpPendingStartedAt = null;
    var fpPendingElapsedInterval = null;
    var FP_PENDING_SLOW_MS = 25000;
    var FP_LOCAL_SPEED_HINT_MS = 45000;
    var fpWorkingStatus = {
        target: "your flow", step: 1, total: null, showStop: false,
        speedHintShown: false, speedHint: false
    };

    function renderWorkingStatus() {
        var $status = el("#fp-working-status");
        if (!$status.length) { return; }
        $status.empty();
        if (!fpWorkingStatus.visible) {
            $status.addClass("fp-hidden");
            relayWorkingStatusToPopout();
            return;
        }
        var text = "Working on " + (fpWorkingStatus.target || "your flow") + " · step " + fpWorkingStatus.step;
        if (fpWorkingStatus.total) { text += " of " + fpWorkingStatus.total; }
        if (fpWorkingStatus.speedHint) { text += " · Local models can take a minute or more per step."; }
        $status.removeClass("fp-hidden").append(document.createTextNode(text + " · "));
        if (fpWorkingStatus.showStop) {
            $("<button>").addClass("red-ui-button red-ui-button-small fp-working-stop")
                .attr("type", "button").text("Stop").on("click", function () {
                    endActiveRun("stop-button");
                    $(this).prop("disabled", true).text("Stopping…");
                }).appendTo($status);
        }
        relayWorkingStatusToPopout();
    }

    function beginWorkingStatus(showStop, target) {
        var continuing = !!fpWorkingStatus.visible;
        fpWorkingStatus = {
            visible: true,
            target: target || "your flow",
            step: 1,
            total: null,
            showStop: !!showStop,
            speedHintShown: continuing && fpWorkingStatus.speedHintShown,
            speedHint: continuing && fpWorkingStatus.speedHint
        };
        renderWorkingStatus();
    }

    function setWorkingStatusTarget(target) {
        if (target) { fpWorkingStatus.target = target; }
        renderWorkingStatus();
    }

    function setWorkingStatusPlan(items) {
        fpWorkingStatus.total = Array.isArray(items) && items.length ? items.length : null;
        renderWorkingStatus();
    }

    function fpFormatElapsed(ms) {
        var totalSeconds = Math.floor(ms / 1000);
        var text;
        if (totalSeconds < 60) {
            text = totalSeconds + "s";
        } else {
            var mins = Math.floor(totalSeconds / 60);
            var secs = totalSeconds % 60;
            text = mins + "m " + secs + "s";
        }
        if (ms >= FP_PENDING_SLOW_MS) {
            text += " — still working, some requests take a minute or more";
        }
        return text;
    }

    function maybeShowLocalSpeedHint() {
        if (!fpPendingStartedAt || !shouldShowLocalSpeedHint(
            activeProvider(), Date.now() - fpPendingStartedAt, fpWorkingStatus.speedHintShown
        )) { return; }
        fpWorkingStatus.speedHintShown = true;
        fpWorkingStatus.speedHint = true;
        renderWorkingStatus();
    }

    function showPending(showStop) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }
        beginWorkingStatus(showStop, "your flow");
        // Guard against duplicates (e.g. fast double-send).
        $box.find("#fp-pending").remove();
        if (fpPendingElapsedInterval) {
            clearInterval(fpPendingElapsedInterval);
            fpPendingElapsedInterval = null;
        }

        var $msg = $("<div>").addClass("fp-message").attr("id", "fp-pending");
        $("<div>").addClass("fp-label").text("FLOWPILOT").appendTo($msg);
        var $dots = $("<div>").addClass("fp-typing").attr("title", "Working…");
        $dots.append($("<span>"), $("<span>"), $("<span>"));
        $dots.append($("<span>").addClass("fp-typing-label").text("Cruising…"));
        var $elapsed = $("<span>").addClass("fp-typing-elapsed");
        $dots.append($elapsed);
        $msg.append($dots);

        $box.append($msg);
        scrollMessagesToBottom();

        fpPendingStartedAt = Date.now();
        fpPendingElapsedInterval = setInterval(function () {
            var $label = el("#fp-pending .fp-typing-elapsed");
            if (!$label.length) {
                // Panel closed / #fp-pending gone without hidePending firing;
                // stop polling instead of leaking the interval forever.
                clearInterval(fpPendingElapsedInterval);
                fpPendingElapsedInterval = null;
                return;
            }
            $label.text(" · " + fpFormatElapsed(Date.now() - fpPendingStartedAt));
            maybeShowLocalSpeedHint();
        }, 1000);
    }

    function hidePending() {
        el("#fp-messages").find("#fp-pending").remove();
        if (fpPendingElapsedInterval) {
            clearInterval(fpPendingElapsedInterval);
            fpPendingElapsedInterval = null;
        }
        fpPendingStartedAt = null;
        fpWorkingStatus.visible = false;
        renderWorkingStatus();
    }

    // Updates the narration text shown in the pending indicator while the
    // agent loop runs (see runAgentChat / describeAgentToolCall).
    function setAgentNarration(text) {
        el("#fp-pending .fp-typing-label").text(text);
        var stepMatch = String(text || "").match(/step (\d+)\s*\/\s*(\d+)/i);
        if (stepMatch) {
            fpWorkingStatus.step = Number(stepMatch[1]);
            renderWorkingStatus();
        }
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
    // always returns an admin-root-anchored absolute path (needed so the
    // pop-out's nested route still resolves correctly), which means neither $.ajax
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

    // Every FlowPilot route is registered under the admin root
    // (RED.httpAdmin.get("/flowpilot/settings", ...) is served at
    // <httpAdminRoot>flowpilot/settings). A bare relative string like
    // "flowpilot/settings" only resolves correctly when the CURRENT PAGE
    // sits at the admin root itself — true for the main editor, but NOT for
    // the pop-out (served from the nested flowpilot/popout/view.html
    // route), where it resolves one level too deep and 404s. Anchoring to
    // "/" instead (0.6.3 and earlier) fixed the pop-out but ignored
    // httpAdminRoot, breaking every request under e.g. /manage (issue #12).
    //
    // So every URL is built from an explicit admin base, following Node-
    // RED's own editor convention (@node-red/editor-client red.js: admin
    // URLs are relative to the editor page — which editor-api's ensureSlash
    // always serves at "<httpAdminRoot>/" — prefixed by
    // RED.settings.apiRootUrl when set). The pop-out can't derive that from
    // its own page, so the editor passes it explicitly (fpAdminBase query
    // param, see openPopout) and popoutAdminBase() reads it back.
    var POPOUT_PAGE_PATH = "flowpilot/popout/view.html";

    function editorAdminBase(pathname, apiRootUrl) {
        var pageDir = String(pathname || "/").replace(/[^\/]*$/, "");
        if (!apiRootUrl) { return pageDir; }
        var root = /\/$/.test(apiRootUrl) ? apiRootUrl : (apiRootUrl + "/");
        return /^(https?:|\/)/.test(root) ? root : (pageDir + root);
    }

    // Only a same-origin absolute PATH is accepted from the query string
    // (never a scheme/host, "//host" or backslash form), since the admin
    // bearer token gets attached to whatever this base points at. Anything
    // else falls back to stripping the pop-out's own known route suffix.
    function popoutAdminBase(pathname, search) {
        var m = /[?&]fpAdminBase=([^&]*)/.exec(String(search || ""));
        var passed = null;
        if (m) { try { passed = decodeURIComponent(m[1]); } catch (e) { passed = null; } }
        if (passed && /^\/(?![\/\\])[^\\?#]*\/$/.test(passed)) { return passed; }
        var page = String(pathname || "/");
        var idx = page.lastIndexOf(POPOUT_PAGE_PATH);
        return idx >= 0 ? page.slice(0, idx) : page.replace(/[^\/]*$/, "");
    }

    function flowpilotAdminBase() {
        if (isPopoutContext) {
            return popoutAdminBase(window.location.pathname, window.location.search);
        }
        return editorAdminBase(window.location.pathname, RED.settings.apiRootUrl);
    }

    function flowpilotUrl(path) {
        return flowpilotAdminBase() + String(path).replace(/^\/+/, "");
    }

    function stripHtmlForDisplay(value) {
        return String(value || "")
            .replace(/<[^>]*>/g, " ")
            .replace(/[<>]/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    // Keep proxy, server, jQuery, and fetch failures on one readable
    // surface. Raw HTML and non-JSON response bodies never reach the UI.
    function readableRequestError(status, body, statusText, textStatus) {
        var numericStatus = Number(status) || 0;
        var data = body;
        if (typeof data === "string") {
            try { data = JSON.parse(data); } catch (e) { data = null; }
        }
        if (numericStatus === 504) {
            return "The model took too long and the connection was closed by a proxy (504). Try again, or use a faster model. Long requests on slow local models can hit your proxy's time limit.";
        }
        if (numericStatus === 502) {
            return "Couldn't reach the server behind the proxy (502).";
        }
        if (numericStatus === 401) {
            return "Authentication failed (401). Please sign in again.";
        }
        if (numericStatus === 403) {
            return "You don't have permission to use FlowPilot (403).";
        }
        if (textStatus === "timeout" || String(statusText || "").toLowerCase() === "timeout") {
            return "Request timed out. Try again, or use a faster model.";
        }

        var detail = data && typeof data === "object" ? (data.message || data.error) : null;
        detail = stripHtmlForDisplay(detail);
        if (detail) {
            return numericStatus
                ? "Request failed (status " + numericStatus + "): " + detail
                : detail;
        }
        if (numericStatus) { return "Request failed (status " + numericStatus + ")."; }
        return "Couldn't reach FlowPilot. Check your connection and try again.";
    }

    function readableRequestException(err) {
        if (err && err.fpReadable) { return stripHtmlForDisplay(err.message); }
        if (err && (err.name === "TypeError" || /fetch|network|connection/i.test(String(err.message || "")))) {
            return readableRequestError(0, null, "", "error");
        }
        return stripHtmlForDisplay(err && err.message) || "Request failed.";
    }

    function ajaxJson(method, url, payload, onSuccess, onError) {
        return $.ajax({
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
            success: function (data, textStatus, xhr) {
                // C5 late failures are HTTP 200 so the keepalive can finish
                // with JSON. Route them through the ordinary error path.
                if (data && data.error && data.code) {
                    var lateXhr = xhr || {};
                    lateXhr.status = Number(data.code) || 500;
                    lateXhr.responseJSON = data;
                    lateXhr.responseText = JSON.stringify(data);
                    handleAjaxError(lateXhr, "error");
                    return;
                }
                if (onSuccess) { onSuccess(data); }
            },
            error: function (xhr, textStatus) {
                handleAjaxError(xhr, textStatus);
            }
        });

        function handleAjaxError(xhr, textStatus) {
            xhr = xhr || {};
            var msg = readableRequestError(xhr.status, xhr.responseJSON || xhr.responseText,
                xhr.statusText, textStatus);
            if (onError) { onError(msg, xhr); }
            else { addMessage("error", msg); }
        }
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

    function toggleAnthropicHint(type) {
        var isAnthropic = type === "anthropic";
        el("#fp-base-url-hint").toggleClass("fp-hidden", !isAnthropic);
        el("#fp-base-url").attr("placeholder", isAnthropic ? "Leave blank for api.anthropic.com" : "http://localhost:8080");
    }

    // Mirrors lib/provider-openai-compatible.js's chatCompletionsUrl rules
    // EXACTLY (ADR-012, pre-beta.1 addition) so the "FlowPilot will call:"
    // hint under Base URL always matches what a real request would hit:
    // (a) a value already ending in /chat/completions is used verbatim —
    // no "/v1" ever forced in; (b) a value ending in /v1 gets only the
    // path appended; (c) anything else gets "/v1/chat/completions"
    // appended. Keep both copies in sync if either changes.
    function resolveChatCompletionsUrlForDisplay(rawBaseUrl) {
        var trimmed = String(rawBaseUrl || "").trim().replace(/\/+$/, "");
        if (/\/chat\/completions$/.test(trimmed)) { return trimmed; }
        var base = trimmed.replace(/\/(chat\/completions|models)$/, "").replace(/\/+$/, "");
        if (!/\/v1$/.test(base)) { base = base + "/v1"; }
        return base + "/chat/completions";
    }

    // Anthropic's own adapter doesn't use this resolution at all (fixed,
    // well-known endpoint) — the hint only makes sense for openai-compatible
    // providers with something actually typed in Base URL.
    function updateResolvedEndpointHint() {
        var $hint = el("#fp-resolved-endpoint-hint");
        if (!$hint.length) { return; }
        var type = el("#fp-provider-type").val();
        var raw = el("#fp-base-url").val();
        if (type === "anthropic" || !String(raw || "").trim()) {
            $hint.addClass("fp-hidden").text("");
            return;
        }
        $hint.removeClass("fp-hidden").text("FlowPilot will call: " + resolveChatCompletionsUrlForDisplay(raw));
    }

    // 0.6.3 §2C: presets are DATA (lib/provider-presets.js) — fetched once
    // from the server (the client can't require() that module directly,
    // see the matching comment on the GET route in flowpilot.js) and cached
    // here for the life of the sidebar. Never hardcode preset values here;
    // this cache plus presetById() are the only things that read them.
    var providerPresetsCache = [];

    function presetById(id) {
        for (var i = 0; i < providerPresetsCache.length; i++) {
            if (providerPresetsCache[i].id === id) { return providerPresetsCache[i]; }
        }
        return null;
    }

    // Mirrors flowpilot.js's isPrivateNetworkHost/isLocalDeployment exactly
    // (ADR-013) — needed here only so the "Assistant capability" status
    // line can describe the right REASON for Tier C without a round trip;
    // the server's own copy is what actually decides the tier. Keep both
    // in sync if either changes.
    function isPrivateNetworkHost(rawBaseUrl) {
        var hostname;
        try {
            hostname = new URL(String(rawBaseUrl || "")).hostname.toLowerCase();
        } catch (e) {
            return false;
        }
        if (!hostname) { return false; }
        if (hostname === "localhost" || hostname.indexOf(".localhost", hostname.length - 10) !== -1) { return true; }
        if (hostname === "::1") { return true; }
        if (hostname.indexOf("fe80:") === 0 || hostname.indexOf("fc") === 0 || hostname.indexOf("fd") === 0) { return true; }
        var ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (!ipv4) { return false; }
        var octets = [Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4])];
        if (octets.some(function (n) { return n > 255; })) { return false; }
        var a = octets[0], b = octets[1];
        if (a === 127) { return true; }
        if (a === 10) { return true; }
        if (a === 172 && b >= 16 && b <= 31) { return true; }
        if (a === 192 && b === 168) { return true; }
        if (a === 169 && b === 254) { return true; }
        return false;
    }

    function isLocalDeployment(p) {
        var preset = presetById(p && p.presetId);
        if (preset && preset.deploymentClass) { return preset.deploymentClass === "local"; }
        return isPrivateNetworkHost(p && p.baseUrl);
    }

    function shouldShowLocalSpeedHint(provider, elapsedMs, alreadyShown) {
        return !alreadyShown && elapsedMs >= FP_LOCAL_SPEED_HINT_MS && isLocalDeployment(provider);
    }

    function renderProviderPresetOptions() {
        var $sel = el("#fp-provider-preset");
        if (!$sel.length) { return; }
        $sel.empty();
        providerPresetsCache.forEach(function (preset) {
            $("<option>").attr("value", preset.id).text(preset.label).appendTo($sel);
        });
    }

    function fetchProviderPresets(onDone) {
        if (providerPresetsCache.length) { onDone(); return; }
        ajaxJson("GET", "flowpilot/provider-presets", null, function (data) {
            providerPresetsCache = (data && Array.isArray(data.presets)) ? data.presets : [];
            renderProviderPresetOptions();
            onDone();
        }, function () {
            // Best-effort: an empty cache degrades to "Custom" only being
            // selectable via whatever value is already stored on the
            // provider — never blocks Settings from opening.
            onDone();
        });
    }

    // Applies a preset's OWN defaults into the form. prefillBaseUrl is true
    // only when the user just PICKED a preset from the dropdown (the whole
    // point of picking one) — false when we're merely re-deriving field
    // visibility for an already-saved provider (fillProviderFields below),
    // where the saved baseUrl/toggle values must win instead.
    function applyPresetToForm(presetId, prefillBaseUrl) {
        var preset = presetById(presetId);
        var type = preset ? preset.providerType : "openai-compatible";
        el("#fp-provider-type").val(type);
        toggleAnthropicHint(type);
        if (prefillBaseUrl) {
            el("#fp-base-url").val(preset ? preset.baseUrl : "");
        }
        var apiKeyRequired = preset ? !!preset.apiKeyRequired : true;
        el("#fp-api-key-row").toggleClass("fp-hidden", !apiKeyRequired);
        var isOpenRouter = presetId === "openrouter";
        el("#fp-openrouter-advanced").toggleClass("fp-hidden", !isOpenRouter);
        if (prefillBaseUrl) {
            // A fresh preset pick starts these off — matches the preset's
            // own stated defaults (both off) rather than carrying over
            // whatever the previous preset's toggles happened to be.
            el("#fp-openrouter-zdr").prop("checked", false);
            el("#fp-openrouter-attribution").prop("checked", false);
        }
        var $hint = el("#fp-preset-docs-hint");
        if (preset && preset.docsUrl) {
            $hint.removeClass("fp-hidden").empty();
            $("<a>").attr("href", preset.docsUrl).attr("target", "_blank").attr("rel", "noopener")
                .text("Provider docs").appendTo($hint);
        } else {
            $hint.addClass("fp-hidden").empty();
        }
        // Known limitation (0.6.3, risk accepted — see CHANGELOG/USER-GUIDE):
        // Ollama's OpenAI-compatible API has no way to set context length per
        // request, and FlowPilot's prompts are large. Non-blocking note only
        // — not a validation gate, and not tied to any live probe.
        el("#fp-ollama-context-hint").toggleClass("fp-hidden", presetId !== "ollama");
        updateResolvedEndpointHint();
    }

    // Plain-language readout for the "Assistant capability" status line
    // (ADR-013). p.supportsTools is undefined until Pre-flight check has run
    // at least once; routingTierMode/routingTier only matter when a manual
    // override is set (the common case is "auto", which always classifies first).
    function capabilityStatusText(p) {
        p = p || {};
        if (p.routingTierMode === "manual") {
            var tier = (p.routingTier || "A").toUpperCase();
            if (tier === "A") { return "Manual override: Full — plans and acts with tools."; }
            if (tier === "B") { return "Manual override: Limited — simplified tools only."; }
            return "Manual override: None — classifies your request first, then acts without tool calls.";
        }
        if (p.supportsTools === undefined) {
            return "Not checked yet — run Pre-flight check below.";
        }
        if (!p.supportsTools) {
            return "⚠ This model can't reliably call tools, so FlowPilot asks a quick question first, then acts on your behalf.";
        }
        return "✓ Tool-capable — every provider classifies first; tools can read your flows for answers.";
    }

    // Explains WHY auto mode picked the tier it did (ADR-013 follow-up,
    // architect review) — shown next to the Advanced override so it's
    // actually usable when the detection is wrong for a given setup (a LAN
    // gateway fronting a cloud model, or a local model behind a public
    // hostname/tunnel). Blank in manual mode — the override itself is
    // already the explicit choice, nothing to explain there.
    function deploymentReasonText(p) {
        p = p || {};
        if (p.routingTierMode === "manual") { return ""; }
        if (p.supportsTools === undefined) { return ""; }
        if (!p.supportsTools) {
            return "No tool-calling support detected by Pre-flight check — deployment location doesn't change this.";
        }
        var preset = presetById(p.presetId);
        if (preset && preset.deploymentClass) {
            return "Detected as " + preset.deploymentClass + " via the " + preset.label + " preset.";
        }
        return isPrivateNetworkHost(p.baseUrl)
            ? "Detected as local from the base URL (private network)."
            : "Detected as cloud from the base URL (public host).";
    }

    // Which routing tier this provider gets and the ONE reason that decided
    // it — the same decision as flowpilot.js's normalizedRoutingTier
    // (ADR-013: manual override, otherwise every provider classifies first),
    // spelled out for Settings. Display only; the server's copy decides.
    // test/tier-display.test.js keeps the two in step.
    var ROUTING_TIER_NAMES = {
        A: "Full tool planning (Tier A)",
        B: "Limited tools (Tier B)",
        C: "Classify first, then act (Tier C)"
    };

    function routingTierChoice(p) {
        p = p || {};
        if (p.routingTierMode === "manual") {
            var t = String(p.routingTier || "").trim().toUpperCase();
            if (!ROUTING_TIER_NAMES[t]) { t = "A"; }
            return { tier: t, reason: "manual", text: "your manual override (Advanced)" };
        }
        if (p.supportsTools !== true) {
            return {
                tier: "C",
                reason: "tools",
                text: p.supportsTools === undefined
                    ? "tool calling not confirmed yet — run Pre-flight check"
                    : "Pre-flight check found no tool calling"
            };
        }
        return {
            tier: "C",
            reason: "tools",
            text: "every provider classifies first; tool calling is used to read your flows for answers"
        };
    }

    function routingTierWhyText(p) {
        var c = routingTierChoice(p);
        return "Routing: " + ROUTING_TIER_NAMES[c.tier] + ". Why: " + c.text;
    }

    // Refreshes the "Assistant capability" status line and its detection-
    // reason line from the active provider's current in-memory state —
    // called after fillProviderFields and again right after Pre-flight
    // check updates supportsTools, so both are correct whether or not the
    // Settings panel is open at the time.
    function updateTierStatus() {
        var p = activeProvider();
        el("#fp-tier-status").text(capabilityStatusText(p));
        el("#fp-tier-why").text(routingTierWhyText(p));
        var reason = deploymentReasonText(p);
        el("#fp-tier-detection-reason").text(reason).toggleClass("fp-hidden", !reason);
    }

    // Write the form fields from a given provider profile. p.apiKey is
    // never a real key here — the server masks it to a sentinel/"" on every
    // response (see maskProviderSecrets, flowpilot.js) — so leaving the
    // field untouched on save round-trips harmlessly (reconcileProviderSecrets,
    // lib/storage.js, keeps the real stored key).
    function fillProviderFields(p) {
        p = p || {};
        el("#fp-provider-name").val(p.providerName || "");
        var presetId = p.presetId || "custom";
        el("#fp-provider-preset").val(presetId);
        applyPresetToForm(presetId, false);
        el("#fp-base-url").val(p.baseUrl || "");
        updateResolvedEndpointHint();
        el("#fp-api-key").val(p.apiKey || "");
        el("#fp-api-key").attr("placeholder", p.hasApiKey ? "Saved — leave to keep, retype to change" : "Optional");
        el("#fp-openrouter-zdr").prop("checked", !!p.zdrEnabled);
        el("#fp-openrouter-attribution").prop("checked", !!p.attributionEnabled);
        el("#fp-model").val(p.model || "");
        el("#fp-routing-tier-override").val(p.routingTierMode === "manual" ? (p.routingTier || "A") : "auto");
        updateTierStatus();
        el("#fp-num-ctx").val(p.numCtx !== undefined ? p.numCtx : 0);
        el("#fp-temperature").val(p.temperature !== undefined ? p.temperature : "");
        // Test provider is disabled until this provider has a model.
        el("#fp-test-provider").prop("disabled", !(p.model && String(p.model).trim()));
    }

    // CLAUDE-032: 5 discrete levels (was 1-10 with sparse interpolated
    // anchors — live testing found no discernible voice difference across
    // the old scale). Labels match lib/persona-prompt.js's PERSONA_LEVELS
    // exactly, one label per slider position, no interpolation.
    function personaLabelFor(n) {
        n = Number(n);
        if (n <= 1) { return "Plain engineer — no aviation language at all."; }
        if (n === 2) { return "Subtle co-pilot (default) — light, occasional flavor."; }
        if (n === 3) { return "Noticeable captain energy — a sentence or two, every time."; }
        if (n === 4) { return "Heavy captain energy — leans hard into the bit."; }
        return "Full captain — comically over-the-top.";
    }

    function updatePersonaLabel() {
        var n = el("#fp-persona-intensity").val();
        el("#fp-persona-value").text(n);
        el("#fp-persona-label").text(personaLabelFor(n));
    }

    function hideUpdateBanner() {
        el("#fp-update-banner").addClass("fp-hidden").empty();
    }

    function showUpdateBanner(data) {
        var $banner = el("#fp-update-banner");
        if (!$banner.length) { return; }
        $banner.empty().removeClass("fp-hidden");
        $banner.append(document.createTextNode("Update available (v" + data.latestVersion + ") — see Palette Manager to install. "));
        $("<a>").attr("href", "#").text("Dismiss").on("click", function (ev) {
            ev.preventDefault();
            try {
                sessionStorage.setItem("fp-update-dismissed-" + data.latestVersion, "1");
            } catch (e) { /* storage unavailable */ }
            hideUpdateBanner();
        }).appendTo($banner);
    }

    function checkForFlowPilotUpdates() {
        if (isPopoutContext) { return; }
        ajaxJson("GET", "flowpilot/update-check", null, function (data) {
            if (!data || data.enabled === false || data.updateAvailable === false) {
                hideUpdateBanner();
                return;
            }
            try {
                if (sessionStorage.getItem("fp-update-dismissed-" + data.latestVersion)) {
                    hideUpdateBanner();
                    return;
                }
            } catch (e) { /* storage unavailable */ }
            showUpdateBanner(data);
        }, function () {
            hideUpdateBanner();
        });
    }

    function fillSettings(settings, reason) {
        settings = settings || {};
        currentSettings = settings;

        renderProviderDropdown();
        fillProviderFields(activeProvider());

        el("#fp-flowpilot-version").text("FlowPilot v" + (settings.flowpilotVersion || "unknown"));
        var systemPromptCurrent = el("#fp-system-prompt").val();
        var systemPromptIncoming = settings.systemPrompt || "";
        console.log("[FlowPilot][G3] fillSettings systemPrompt", {
            reason: reason || "unspecified",
            current: systemPromptCurrent,
            incoming: settings.systemPrompt,
            writing: systemPromptIncoming,
            differs: systemPromptCurrent !== systemPromptIncoming
        });
        el("#fp-system-prompt").val(settings.systemPrompt || "");
        el("#fp-persona-intensity").val(settings.personaIntensity !== undefined ? settings.personaIntensity : 2);
        updatePersonaLabel();
        el("#fp-warn-tokens").val(settings.contextWarnTokens || 4000);
        el("#fp-high-tokens").val(settings.contextHighTokens || 8000);
        el("#fp-history-max").val(settings.historyMaxExchanges !== undefined ? settings.historyMaxExchanges : 10);
        el("#fp-streaming-enabled").prop("checked", !!settings.streamingEnabled);
        el("#fp-request-timeout").val(settings.requestTimeoutMs !== undefined ? (settings.requestTimeoutMs / 1000) : 180);
        el("#fp-check-for-updates").prop("checked", settings.checkForUpdates !== false);
        el("#fp-agent-turn-max-tokens").val(settings.agentTurnMaxTokens !== undefined ? settings.agentTurnMaxTokens : 4096);
        el("#fp-agent-loop-token-ceiling").val(settings.agentLoopTokenCeiling !== undefined ? settings.agentLoopTokenCeiling : 50000);
        el("#fp-agent-loop-max-iterations").val(settings.agentLoopMaxIterations !== undefined ? settings.agentLoopMaxIterations : 5);
        el("#fp-diff-gate-threshold").val(settings.diffGateThreshold !== undefined ? settings.diffGateThreshold : 5);
        el("#fp-suppress-warnings").prop("checked", !!settings.suppressContextWarnings);
        el("#fp-redaction-disabled").prop("checked", settings.redactionEnabled === false);
        el("#fp-debug-logging").prop("checked", !!settings.debugLogging);
        el("#fp-auto-toggle").prop("checked", settings.auto !== false);
        el("#fp-restricted-toggle").prop("checked", settings.restricted === true);

        // Plain checkbox-driven dev/test warning icon visibility; this warning
        // no longer uses a type-to-confirm acknowledgement.
        if (settings.suppressContextWarnings) {
            el("#fp-dev-warning-status").addClass("fp-hidden");
        } else {
            el("#fp-dev-warning-status").removeClass("fp-hidden");
        }
        if (settings.checkForUpdates === false) {
            hideUpdateBanner();
        }

        // Saved prompts may have changed; rebuild the editor and empty state.
        renderSavedPromptList();
        renderEmptyState();

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
        ap.presetId = el("#fp-provider-preset").val() || "custom";
        ap.type = el("#fp-provider-type").val() || "openai-compatible";
        ap.baseUrl = el("#fp-base-url").val() || "";
        ap.apiKey = el("#fp-api-key").val() || "";
        ap.model = el("#fp-model").val() || "";
        var tierOverride = el("#fp-routing-tier-override").val() || "auto";
        if (tierOverride === "auto") {
            ap.routingTierMode = "auto";
        } else {
            ap.routingTierMode = "manual";
            ap.routingTier = tierOverride;
        }
        ap.numCtx = Math.max(0, Number(el("#fp-num-ctx").val() || 0));
        var temperatureText = String(el("#fp-temperature").val() || "").trim();
        if (!temperatureText) {
            delete ap.temperature;
        } else {
            var temperature = Number(temperatureText);
            if (isFinite(temperature)) { ap.temperature = temperature; }
            else { delete ap.temperature; }
        }
        // OpenRouter-only (0.6.3 §2D) — harmless no-op fields for every
        // other preset, ignored server-side unless presetId is "openrouter".
        ap.zdrEnabled = el("#fp-openrouter-zdr").prop("checked") || false;
        ap.attributionEnabled = el("#fp-openrouter-attribution").prop("checked") || false;
        currentSettings.providers = list;
    }

    function collectSettings() {
        // Plain checkbox — no confirmation phrase required (Manny's explicit
        // call: excessive friction for this particular warning, unlike the
        // redaction opt-out below which stays gated).
        var suppress = el("#fp-suppress-warnings").prop("checked");

        // Same type-to-confirm gate as suppressContextWarnings used to have,
        // and for the same reason: the confirm box is never pre-filled from
        // settings, so disabling redaction stays off unless re-confirmed on
        // every save — "off-able, not off-by-accident".
        var wantRedactionOff = el("#fp-redaction-disabled").prop("checked");
        var redactionTyped = (el("#fp-redaction-confirm").val() || "").trim();
        var redactionEnabled = !(wantRedactionOff && redactionTyped === "disable redaction");

        // Fold the form's provider fields back into the active profile first.
        captureProviderFields();

        var historyMax = Number(el("#fp-history-max").val());
        if (!isFinite(historyMax) || historyMax < 0) { historyMax = 10; }

        var requestTimeoutSec = Number(el("#fp-request-timeout").val());

        var personaIntensity = Number(el("#fp-persona-intensity").val());
        if (!isFinite(personaIntensity) || personaIntensity < 1 || personaIntensity > 5) { personaIntensity = 2; }

        var agentLoopMaxIterations = Number(el("#fp-agent-loop-max-iterations").val());
        if (!isFinite(agentLoopMaxIterations) || agentLoopMaxIterations < 1) { agentLoopMaxIterations = 5; }

        var agentTurnMaxTokens = Number(el("#fp-agent-turn-max-tokens").val());
        var agentLoopTokenCeiling = Number(el("#fp-agent-loop-token-ceiling").val());
        var systemPrompt = el("#fp-system-prompt").val();
        console.log("[FlowPilot][G3] saveSettings reading systemPrompt", {
            value: systemPrompt
        });

        return {
            providers: providersList(),
            activeProviderId: currentSettings.activeProviderId,
            systemPrompt: systemPrompt,
            personaIntensity: personaIntensity,
            contextWarnTokens: Number(el("#fp-warn-tokens").val() || 4000),
            contextHighTokens: Number(el("#fp-high-tokens").val() || 8000),
            historyMaxExchanges: historyMax,
            streamingEnabled: el("#fp-streaming-enabled").prop("checked"),
            requestTimeoutMs: Math.round(requestTimeoutSec * 1000),
            checkForUpdates: el("#fp-check-for-updates").prop("checked"),
            agentTurnMaxTokens: agentTurnMaxTokens,
            agentLoopTokenCeiling: agentLoopTokenCeiling,
            agentLoopMaxIterations: agentLoopMaxIterations,
            diffGateThreshold: Math.max(0, Math.floor(Number(el("#fp-diff-gate-threshold").val() || 5))),
            suppressContextWarnings: suppress,
            redactionEnabled: redactionEnabled,
            debugLogging: el("#fp-debug-logging").prop("checked"),
            auto: el("#fp-auto-toggle").prop("checked"),
            restricted: el("#fp-restricted-toggle").prop("checked"),
            savedPrompts: normalizedSavedPrompts(editingSavedPrompts),
            savedPromptsMigrationNoticeShown: currentSettings.savedPromptsMigrationNoticeShown === true
        };
    }

    // Switch which provider the form edits. Deliberately does NOT capture
    // the outgoing provider's form edits first — unsaved edits to the
    // provider you're leaving are discarded, matching every other form in
    // FlowPilot: nothing you typed persists (even to other in-memory
    // state) until you explicitly Save or Test. This also means one
    // provider's bad/incomplete in-progress edit can never block using or
    // saving a DIFFERENT provider just by having switched away from it.
    function switchProvider(newId) {
        currentSettings.activeProviderId = newId;
        fillProviderFields(activeProvider());
    }

    function addProvider() {
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
            presetId: "custom",
            type: "openai-compatible",
            baseUrl: "http://localhost:8080",
            apiKey: "",
            model: "",
            numCtx: 0,
            routingTier: "A",
            routingTierMode: "auto"
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
        // Presets must be in the dropdown BEFORE fillSettings tries to
        // select one by value (fillProviderFields -> el("#fp-provider-
        // preset").val(presetId) is a no-op against an empty <select>).
        fetchProviderPresets(function () {
            ajaxJson("GET", "flowpilot/settings", null, function (data) {
                fillSettings(data, "loadSettings GET response");
                maybeShowFirstRun(data);
                migrateCustomIntentsOnLoad(data);
                updateSelectionStatus();
            }, function (msg) {
                addMessage("error", "Unable to load FlowPilot settings: " + msg);
                el("#fp-provider-status").text("Provider: settings load failed");
            });
        });
    }

    // C2 migration handshake. The server returns the converted savedPrompts
    // while retaining customIntents in the on-disk profile. Only this POST
    // can confirm the copy and allow storage to remove the legacy field. A
    // failed POST leaves both the original entries and the converted copy in
    // place for a later retry.
    function migrateCustomIntentsOnLoad(settings) {
        if (!settings || !Array.isArray(settings.customIntents) || !settings.customIntents.length) { return; }
        if (currentSettings.savedPromptsMigrationNoticeShown !== true) {
            addMessage("assistant", "Your custom intents are now saved prompts. Type / to use them, or edit them in Settings.");
            currentSettings.savedPromptsMigrationNoticeShown = true;
        }
        // The notice flag travels in the same atomic save as the prompt copy.
        // If the request fails, the legacy field remains on disk and the next
        // load shows the notice again before retrying the migration.
        saveSettings(null, false, true);
    }

    // `announce` is true only for the explicit Save settings button — the
    // many internal callers (Pre-flight check, Refresh models, saved prompt
    // add/remove) save as a side effect of some other action and already
    // have their own feedback, so they stay silent here.
    function saveSettings(callback, announce, silent) {
        var payload = collectSettings();
        var list = payload.providers || [];

        if (!isFinite(payload.requestTimeoutMs) || payload.requestTimeoutMs <= 0) {
            var timeoutMsg = "Cannot save: request timeout must be a positive number of seconds.";
            addMessage("error", timeoutMsg);
            if (announce) { showSaveStatus(timeoutMsg, true); }
            showSettings();
            return;
        }
        if (!isFinite(payload.agentTurnMaxTokens) || payload.agentTurnMaxTokens <= 0 || Math.floor(payload.agentTurnMaxTokens) !== payload.agentTurnMaxTokens) {
            var tokenMsg = "Cannot save: max tokens per model response (agent step) must be a positive whole number.";
            addMessage("error", tokenMsg);
            if (announce) { showSaveStatus(tokenMsg, true); }
            showSettings();
            return;
        }
        if (!isFinite(payload.agentLoopTokenCeiling) || payload.agentLoopTokenCeiling <= 0 || Math.floor(payload.agentLoopTokenCeiling) !== payload.agentLoopTokenCeiling) {
            var ceilingMsg = "Cannot save: max total tokens per agent turn must be a positive whole number.";
            addMessage("error", ceilingMsg);
            if (announce) { showSaveStatus(ceilingMsg, true); }
            showSettings();
            return;
        }

        // Validations 1-3 below check ONLY the active provider — the one
        // actually being saved/tested right now. A problem with some OTHER
        // stored provider (one you're not currently editing) must never
        // block saving or testing a good one: one bad provider shouldn't
        // break FlowPilot for every other provider you have configured.
        // (Prior versions validated every stored provider on every save;
        // that meant a single provider with bad data — however it got that
        // way — could permanently block ALL saves until manually fixed.)
        var ap = list.filter(function (p) { return p.id === payload.activeProviderId; })[0];

        // Validation 1: the active provider needs a base URL, unless it's
        // Anthropic (defaults to api.anthropic.com when blank).
        if (ap && ap.type !== "anthropic" && (!ap.baseUrl || !String(ap.baseUrl).trim())) {
            var noUrlMsg = "Cannot save: \"" + (ap.providerName || "this provider") + "\" needs a Base URL.";
            addMessage("error", noUrlMsg);
            if (announce) { showSaveStatus(noUrlMsg, true); }
            showSettings();
            return;
        }

        // Validation 2: the active provider needs a name. Name is a
        // provider's identity — base URL/model/key may all legitimately
        // repeat (e.g. same endpoint, different billing key), so the name
        // is what must distinguish it from every other saved provider.
        if (ap && (!ap.providerName || !String(ap.providerName).trim())) {
            var blankNameMsg = "Cannot save: this provider needs a name.";
            addMessage("error", blankNameMsg);
            if (announce) { showSaveStatus(blankNameMsg, true); }
            showSettings();
            return;
        }

        // Validation 3: the active provider's name must not collide with
        // any OTHER provider's name. A pre-existing collision among two
        // OTHER providers (neither of them the one you're editing) is not
        // this save's problem to block on.
        if (ap) {
            var activeNameKey = String(ap.providerName).trim().toLowerCase();
            var collidesWith = list.filter(function (p) {
                return p.id !== ap.id && String(p.providerName || "").trim().toLowerCase() === activeNameKey;
            });
            if (collidesWith.length) {
                var dupesMsg = "Cannot save: another provider is already named \"" + ap.providerName + "\".";
                addMessage("error", dupesMsg);
                if (announce) { showSaveStatus(dupesMsg, true); }
                showSettings();
                return;
            }
        }

        // Nothing changed since the last load/save — skip the round trip.
        if (announce && savedSettingsSnapshot !== null && JSON.stringify(payload) === savedSettingsSnapshot) {
            showSaveStatus("No changes to save.");
            if (callback) { callback(); }
            return;
        }

        ajaxJson("POST", "flowpilot/settings", payload, function (data) {
            fillSettings(data, "saveSettings POST response");
            if (!silent) { addMessage("assistant", "Settings saved."); }
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

    // ---------------------------------------------------------------------
    // W7 — WRITE tools (§16 of FlowPilot-Phase10-Rescope-Scoping.md).
    //
    // Exact argument schemas as landed by CODEX-005 (coordinated via
    // mailbox, 2026-07-26 19:28/19:37 UTC — these are NOT a client-side
    // guess): CODEX-005 deliberately reused the EXISTING Modify-envelope
    // field names/shapes so the client applies WRITE tool calls through
    // the SAME pipeline as the ordinary (non-agentic) Modify apply path —
    //   apply_step: { summary, changes?: [{id, set}], newNodes?: [{id,
    //                 type, ...}], newWires?: [{from, fromPort, to}] }
    //     `changes[].set` is a sparse property patch, `newNodes`/`newWires`
    //     are byte-identical in shape to the top-level Modify envelope's
    //     own fields (applyInsertions already accepts them directly).
    //     "One call is one todo item even when these arrays contain a
    //     small bundle" (§16 point 2) — arrays may hold more than one
    //     entry in a single call.
    //   remove_step: { summary, nodeId }
    //   rename_node: { summary, nodeId, name }
    //   ask_user: { question, options? } — tier "write-safe", non-mutating,
    //     handled entirely in the agent loop (modes.js), never reaches
    //     here in normal flow.
    //
    // Tier ("write-gated" vs "write-safe") arrives OUT OF BAND per call as
    // data.toolTiers[call.id] (modes.js reads this), not by tool name — a
    // write-gated tier means the call is ELIGIBLE for consent-gating, not
    // that every call of that tool prompts (CODEX-005's own clarification):
    // §16 point 4 still requires classifying the ACTUAL touched node
    // type(s) with the consent classifier (consent.js, R11-8) before gating.
    //
    // tool_result shape (§16 point 3 — mirrors the existing verifySteps
    // check vocabulary, scoped strictly to this call's own touched ids):
    //   { requested, checks: [{check, nodeId|fromId/toId, prop?, expected?,
    //     pass}], allPass, error? }
    // ---------------------------------------------------------------------

    // What a WRITE tool call would do, as consent items {op, type, nodeId}
    // for decideConsent (consent.js): a NEW node's own declared type, an
    // EXISTING node's live type via findLiveNode (apply-review.js, same
    // closure). An id that doesn't resolve has no type, which the classifier
    // treats as unknown → side-effecting (asks).
    // idMap (optional): the run's placeholder→real id map, so a node created
    // earlier in the same run is classified by its real type.
    function collectWriteToolConsentItems(name, args, idMap) {
        args = args || {};
        var items = [];
        var newTypes = {};
        function liveType(id) {
            if (newTypes[id]) { return newTypes[id]; }
            var realId = (idMap && id && idMap[id]) || id;
            var live = realId ? findLiveNode(realId) : null;
            return live ? live.type : null;
        }
        // Created by this call or earlier in this run (idMap maps the
        // model's placeholder to the real id, so check both sides).
        function runCreated(id) {
            if (!id) { return false; }
            if (newTypes[id]) { return true; }
            if (!idMap) { return false; }
            if (idMap[id]) { return true; }
            return Object.keys(idMap).some(function (key) { return idMap[key] === id; });
        }
        switch (name) {
        case "apply_step":
            (Array.isArray(args.newNodes) ? args.newNodes : []).forEach(function (n) {
                if (!n) { return; }
                if (n.id) { newTypes[n.id] = n.type; }
                items.push({ op: "create", type: n.type || null, nodeId: n.id || null });
            });
            (Array.isArray(args.newWires) ? args.newWires : []).forEach(function (w) {
                if (!w) { return; }
                items.push({ op: "rewire", type: liveType(w.from), nodeId: w.from || null, runCreated: runCreated(w.from) });
                items.push({ op: "rewire", type: liveType(w.to), nodeId: w.to || null, runCreated: runCreated(w.to) });
            });
            (Array.isArray(args.changes) ? args.changes : []).forEach(function (c) {
                if (c) {
                    items.push({ op: "modify-config", type: liveType(c.id), nodeId: c.id || null,
                        runCreated: runCreated(c.id) });
                }
            });
            break;
        case "remove_step":
            items.push({ op: "delete", type: liveType(args.nodeId), nodeId: args.nodeId || null });
            break;
        case "rename_node":
            items.push({ op: "modify-config", type: liveType(args.nodeId), nodeId: args.nodeId || null });
            break;
        case "deploy_flows":
            items.push({ op: "deploy", type: null, nodeId: null });
            break;
        }
        return items;
    }

    // Gate ONLY "write-gated" tool calls (CODEX-005: the tier marks a call
    // eligible, not automatically gated), and then only when the consent
    // classifier asks for at least one thing the call does. A gated call
    // that touches nothing identifiable asks (conservative, as before).
    // consentContext: { hold, memory, taskId } (consent.js).
    function writeToolCallNeedsConsent(tier, name, args, consentContext) {
        if (tier !== "write-gated") { return false; }
        var ctx = consentContext || {};
        var items = collectWriteToolConsentItems(name, args, ctx.idMap);
        if (!items.length) { return true; }
        return items.some(function (item) {
            // An approved plan that listed creating this node type also
            // covers wiring and configuring the node this run created; the
            // user approved adding it to do that job. Existing nodes of the
            // type, and types the plan didn't list, still ask.
            if (item.runCreated && (item.op === "rewire" || item.op === "modify-config") &&
                Array.isArray(ctx.approvedOperations) && ctx.approvedOperations.some(function (approved) {
                    return planApprovalMatches(approved, "create", item.type, item.nodeId);
                })) { return false; }
            return decideConsent(item.op, item.type,
                { hold: ctx.hold, memory: ctx.memory, taskId: ctx.taskId, nodeId: item.nodeId,
                    approvedOperations: ctx.approvedOperations }) === "ask";
        });
    }

    // Builds the tool_result envelope from a checks array already carrying
    // .pass — shared tail for all three WRITE tool executors below.
    function buildWriteToolResult(requestedArgs, checks, extra) {
        var allPass = checks.length > 0 && checks.every(function (c) { return c.pass; });
        return Object.assign({ requested: requestedArgs, checks: checks, allPass: allPass }, extra || {});
    }

    // Runs the verifySteps-style check vocabulary (runSingleVerifyCheck,
    // modes.js, same closure) against a list of steps in this call's own
    // shape, scoped strictly to the touched id(s) — never a flow-wide
    // snapshot (§16 point 3).
    function runChecksForToolResult(steps, idMap) {
        var checks = [];
        (steps || []).forEach(function (step) {
            var result = runSingleVerifyCheck(step, idMap);
            if (!result) { return; }
            checks.push(Object.assign({}, step, { pass: result.ok }));
        });
        return checks;
    }

    // apply_step: newNodes/newWires go through applyInsertions — the SAME
    // layout/collision-avoidance/wiring path Generate/Modify insertions
    // already use, since CODEX-005 matched that exact field shape — then
    // changes[].set (sparse property patches on EXISTING nodes) goes
    // through applyModifications's Tier 1, using the resulting idMap so a
    // change value can reference a placeholder id from newNodes in the
    // SAME call (mirrors the existing "insertions run first so their
    // placeholder→real-id map is available" ordering in
    // addModifyReview's apply button). `changes[].set.wires` is the ONE
    // exception: CLAUDE-009-fix — an existing node's wiring is never a
    // generic property (mirrors computeNodeDiff's `if (k === "wires") {
    // wiresChanged = true; return; }`), so it's split out and routed
    // through computeWireDiff/Tier 3 (RED.nodes.addLink/removeLink,
    // canWire port validation) instead of a raw `liveNode.wires = val`
    // assignment, which would "succeed" without ever updating the link
    // registry the canvas and RED.nodes.eachLink actually read from.
    function executeApplyStepTool(args, runIdMap, runHistoryEvents) {
        args = args || {};
        var changes = Array.isArray(args.changes) ? args.changes : [];
        var newNodes = Array.isArray(args.newNodes) ? args.newNodes : [];
        var newWires = Array.isArray(args.newWires) ? args.newWires : [];

        var idMap = {};
        var steps = [];
        var changeDetails = [];

        // CLAUDE-013: resolves a placeholder id (e.g. "fp-new-2") through
        // this call's own idMap first (ids it just created via
        // applyInsertions), then through runIdMap (ids created by an
        // EARLIER WRITE-tool call in the same agent run) — so referencing a
        // node created two tool calls ago works the same as referencing one
        // created in this call.
        function resolveId(id) {
            if (typeof id !== "string") { return id; }
            if (idMap && idMap[id]) { return idMap[id]; }
            if (runIdMap && runIdMap[id]) { return runIdMap[id]; }
            return id;
        }

        if (newNodes.length || newWires.length) {
            idMap = applyInsertions(newNodes, newWires, [], runHistoryEvents) || {};
            newNodes.forEach(function (n) {
                if (n && n.id) { steps.push({ check: "exists", nodeId: n.id }); }
            });
            newWires.forEach(function (w) {
                if (w && w.from && w.to) { steps.push({ check: "wire", fromId: w.from, fromPort: w.fromPort || 0, toId: w.to }); }
            });
        }

        if (changes.length) {
            var propDiffs = changes.filter(function (c) { return c && c.id && c.set && typeof c.set === "object"; })
                .map(function (c) {
                    var nodeId = resolveId(c.id);
                    var live = findLiveNode(nodeId);
                    var hasWireChange = Object.prototype.hasOwnProperty.call(c.set, "wires");
                    var propertyChanges = Object.keys(c.set).filter(function (k) { return k !== "wires"; })
                        .map(function (k) {
                            return { key: k, oldVal: live ? live[k] : undefined, newVal: c.set[k] };
                        });
                    var wiresDiff = { toAdd: [], toRemove: [] };
                    if (hasWireChange && live) {
                        // The tool-call path has no "flow the model had in
                        // context" boundary the way the classic envelope's
                        // validTargetIds does (scoped to the returned "flow"
                        // array) — the model only sends this one node's
                        // desired wires, not a full flow. Per sr-dev's
                        // guidance, treat every id the diff could actually
                        // flag for removal as valid: computeWireDiff only
                        // ever consults validTargetIds for ids already found
                        // among this node's CURRENT live targets, so seeding
                        // validTargetIds from those current targets is
                        // equivalent to "always valid" without needing a
                        // magic always-true object.
                        var validTargetIds = {};
                        RED.nodes.eachLink(function (l) {
                            if (l.source && l.source.id === nodeId && l.target) { validTargetIds[l.target.id] = true; }
                        });
                        wiresDiff = computeWireDiff(nodeId, c.set.wires, validTargetIds);
                    }
                    var detail = {
                        modNode: { id: nodeId },
                        propertyChanges: propertyChanges,
                        wiresChanged: hasWireChange && !!live,
                        wiresDiff: wiresDiff
                    };
                    changeDetails.push({
                        id: nodeId,
                        name: live && live.name,
                        type: live && live.type,
                        before: propertyChanges.reduce(function (values, change) {
                            values[change.key] = change.oldVal; return values;
                        }, {}),
                        after: propertyChanges.reduce(function (values, change) {
                            values[change.key] = change.newVal; return values;
                        }, {}),
                        propertyChanges: propertyChanges
                    });
                    return detail;
                });
            // CLAUDE-013: applyModifications's own Tier 1 substitution
            // (apply-review.js) resolves c.set[k] placeholder values through
            // whatever idMap it's given — passing the call-local idMap alone
            // would WRITE the raw unresolved placeholder string onto the live
            // node (e.g. an mqtt-out's "broker" left as "fp-new-broker")
            // whenever the referenced node was created by an EARLIER call
            // this run, even though the verify step below correctly expects
            // the real id — a live-value/verify-step mismatch caught by
            // testing, not named explicitly in the ticket's cited line
            // numbers. Merge runIdMap in so the actual mutation and the
            // verify step agree.
            if (propDiffs.length) { applyModifications(propDiffs, [], null, Object.assign({}, runIdMap, idMap), runHistoryEvents); }
            changes.forEach(function (c) {
                if (!c || !c.id || !c.set || typeof c.set !== "object") { return; }
                var nodeId = resolveId(c.id);
                Object.keys(c.set).filter(function (k) { return k !== "wires"; }).forEach(function (k) {
                    // Resolve through idMap/runIdMap the SAME way the diff
                    // above just did, so a set value referencing a
                    // placeholder from THIS call's own newNodes (e.g. an
                    // mqtt-out's "broker" pointing at a new mqtt-broker) OR
                    // from an EARLIER call this run is checked against what
                    // actually landed, not the raw unresolved placeholder
                    // string.
                    var expected = resolveId(c.set[k]);
                    steps.push({ check: "property", nodeId: nodeId, prop: k, expected: expected });
                });
                if (Object.prototype.hasOwnProperty.call(c.set, "wires")) {
                    // Emit one "wire" check per desired (port, target) pair —
                    // the same check shape/granularity newWires already uses
                    // above — so the model's requested final wiring state is
                    // verified against the live graph, not a property key.
                    var desiredWires = Array.isArray(c.set.wires) ? c.set.wires : [];
                    desiredWires.forEach(function (targets, port) {
                        (Array.isArray(targets) ? targets : []).forEach(function (targetId) {
                            steps.push({ check: "wire", fromId: nodeId, fromPort: port, toId: resolveId(targetId) });
                        });
                    });
                }
            });
        }

        if (!steps.length) {
            return buildWriteToolResult(args, [], { error: "apply_step call had nothing to apply" });
        }
        var checks = runChecksForToolResult(steps, idMap);
        var extra = {};
        if (newNodes.length) {
            extra.newNodes = newNodes.map(function (node) { return cardClone ? cardClone(node) : node; });
            changeDetails = newNodes.map(function (node) {
                return { id: node && (idMap[node.id] || node.id), name: node && node.name, type: node && node.type,
                    changeType: "added", after: cardClone ? cardClone(node) : node };
            }).concat(changeDetails);
        }
        if (changeDetails.length) { extra.changeDetails = changeDetails; }
        if (idMap && Object.keys(idMap).length) { extra.idMap = idMap; }
        return buildWriteToolResult(args, checks, extra);
    }

    function executeRemoveStepTool(args, runIdMap, runHistoryEvents) {
        args = args || {};
        if (!args.nodeId) {
            return buildWriteToolResult(args, [], { error: "remove_step requires nodeId" });
        }
        // CLAUDE-013: args.nodeId may be a placeholder minted by an EARLIER
        // WRITE-tool call this run (e.g. "insert node, then remove it").
        var nodeId = (runIdMap && typeof args.nodeId === "string" && runIdMap[args.nodeId]) || args.nodeId;
        var live = findLiveNode(nodeId);
        applyModifications([], [nodeId], null, {}, runHistoryEvents);
        var checks = runChecksForToolResult([{ check: "absent", nodeId: nodeId }], {});
        return buildWriteToolResult(args, checks, { changeDetails: [{ id: nodeId, changeType: "removed", before: live || { id: nodeId } }] });
    }

    function executeRenameNodeTool(args, runIdMap, runHistoryEvents) {
        args = args || {};
        if (!args.nodeId || typeof args.name !== "string") {
            return buildWriteToolResult(args, [], { error: "rename_node requires nodeId and name" });
        }
        // CLAUDE-013: same placeholder resolution as executeRemoveStepTool.
        var nodeId = (runIdMap && typeof args.nodeId === "string" && runIdMap[args.nodeId]) || args.nodeId;
        var live = findLiveNode(nodeId);
        var oldName = live && live.name;
        var diff = [{
            modNode: { id: nodeId },
            propertyChanges: [{ key: "name", oldVal: live ? live.name : undefined, newVal: args.name }],
            wiresChanged: false,
            wiresDiff: { toAdd: [], toRemove: [] }
        }];
        applyModifications(diff, [], null, {}, runHistoryEvents);
        var checks = runChecksForToolResult([{ check: "property", nodeId: nodeId, prop: "name", expected: args.name }], {});
        return buildWriteToolResult(args, checks, { changeDetails: [{ id: nodeId, name: args.name, type: live && live.type,
            before: { name: oldName }, after: { name: args.name }, propertyChanges: [{ key: "name", oldVal: oldName, newVal: args.name }] }] });
    }

    function executeRedirectModeTool(args) {
        args = args || {};
        if (["generate", "document", "chat"].indexOf(args.mode) === -1) {
            return { error: "redirect_mode requires mode = generate, document, or chat" };
        }
        if (typeof args.prompt !== "string" || !args.prompt.trim()) {
            return { error: "redirect_mode requires prompt" };
        }
        if (typeof args.explanation !== "string" || !args.explanation.trim()) {
            return { error: "redirect_mode requires explanation" };
        }

        var result = {
            redirected: true,
            explanation: args.explanation.trim(),
            suggestedAction: {
                mode: args.mode,
                prompt: args.prompt.trim()
            }
        };
        if (typeof args.selectionHint === "string" && args.selectionHint.trim()) {
            result.suggestedAction.selectionHint = args.selectionHint.trim();
        }
        if (args.targetNodeIds === "all" || args.targetNodeIds === "instance") {
            result.suggestedAction.targetNodeIds = args.targetNodeIds;
        } else if (Array.isArray(args.targetNodeIds)) {
            var ids = args.targetNodeIds
                .filter(function (id) { return typeof id === "string" && id.trim(); })
                .map(function (id) { return id.trim(); });
            if (ids.length) { result.suggestedAction.targetNodeIds = ids; }
        }
        return result;
    }

    // group_nodes (ADR-003 R3a / P10-B3): wraps the exact
    // RED.group.createGroup path already proven in apply-review.js's
    // applyGroupChanges create branch (~1356-1362) — no new group logic.
    // Pre-validates every id via findLiveNode (the established resolver
    // used by the other WRITE tool executors above, a superset of
    // RED.nodes.node that also resolves groups/junctions — needed here
    // specifically to detect a group id among nodeIds). "No partial
    // group": any missing id is an error, not a partial create. A
    // resolved id that's itself a group (nesting) or already belongs to a
    // group (would require editing that group's membership) is out of
    // scope for this minimal tool per ADR-003 and reported as
    // unsupported_operation instead of attempted.
    function executeGroupNodesTool(args, runIdMap, runHistoryEvents) {
        args = args || {};
        var name = typeof args.name === "string" ? args.name : "";
        var nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds : [];
        if (!name || !nodeIds.length) {
            return buildWriteToolResult(args, [], { error: "group_nodes requires name and at least one nodeId" });
        }

        // CLAUDE-013: this is the exact call shape that surfaced the "node
        // not found: fp-new-2" error — a node created by an EARLIER
        // apply_step call in the same run, referenced here by its
        // placeholder id, with no idMap of its own to resolve against.
        var resolvedIds = nodeIds.map(function (id) {
            return (runIdMap && typeof id === "string" && runIdMap[id]) || id;
        });
        var uniqueIds = resolvedIds.filter(function (id, i) { return resolvedIds.indexOf(id) === i; });
        var missing = [], nested = [], alreadyGrouped = [], resolved = [];
        uniqueIds.forEach(function (id) {
            var live = findLiveNode(id);
            if (!live) { missing.push(id); return; }
            if (live.type === "group") { nested.push(id); return; }
            if (live.g) { alreadyGrouped.push(id); return; }
            resolved.push(live);
        });

        if (missing.length) {
            return buildWriteToolResult(args, [], { error: "group_nodes: node id(s) not found: " + missing.join(", ") });
        }
        if (nested.length || alreadyGrouped.length) {
            var reasonParts = [];
            if (nested.length) { reasonParts.push("already a group: " + nested.join(", ")); }
            if (alreadyGrouped.length) { reasonParts.push("already in another group: " + alreadyGrouped.join(", ")); }
            return buildWriteToolResult(args, [], {
                unsupported: true,
                operation: "group_nodes",
                reason: "Nested groups and existing-group membership edits aren't supported (" + reasonParts.join("; ") + ").",
                available: ["apply_step", "remove_step", "rename_node", "group_nodes"]
            });
        }

        // CLAUDE-026: all resolved nodes must share one tab. Node-RED core's
        // own RED.group.createGroup (confirmed via source) registers an
        // EMPTY group via RED.nodes.addGroup() FIRST, using resolved[0].z,
        // and only THEN populates it via addToGroup — which validates every
        // node's .z matches and throws if not. createGroup catches that
        // throw itself, RED.notifies it, and returns undefined — but never
        // undoes the addGroup() call, so a mismatched-z request leaves a
        // real, empty, orphaned group on resolved[0]'s tab every time.
        // Checking up front avoids ever creating that orphan for this
        // (deterministic, reproducible-by-inspection) cause.
        var groupZ = resolved.length ? resolved[0].z : null;
        var mismatchedZ = resolved.some(function (n) { return n.z !== groupZ; });
        if (mismatchedZ) {
            return buildWriteToolResult(args, [], { error: "group_nodes: all nodes must be on the same tab to be grouped" });
        }

        // Belt-and-suspenders for any OTHER way createGroup can fail after
        // already registering that empty shell (a live QA run hit one:
        // "Node type not installed: group" on 1 of 3 attempts): the shared
        // createGroupSafely (apply-review.js, R11-7) removes exactly what the
        // failed call orphaned and retries once — the same creation path the
        // classic Apply uses.
        var attempt = createGroupSafely(resolved);
        if (!attempt.group) {
            var errMsg = (attempt.error && attempt.error.message) || attempt.error || "createGroup returned nothing";
            return buildWriteToolResult(args, [], { error: "Failed to create group: " + errMsg });
        }
        var newGroup = attempt.group;
        newGroup.name = name;
        RED.group.markDirty(newGroup);
        // CLAUDE-027: collected into this run's shared accumulator (same
        // mechanism as applyInsertions/applyModifications above) rather than
        // pushed straight to RED.history, so this run's flush can fold it
        // together with the rest of this run's WRITE-tool calls into ONE
        // undo entry via t:"multi".
        var createGroupHistoryEvent = { t: "createGroup", groups: [newGroup], dirty: RED.nodes.dirty() };
        if (runHistoryEvents) { runHistoryEvents.push(createGroupHistoryEvent); } else { RED.history.push(createGroupHistoryEvent); }
        // markDirty alone doesn't force the editor to recompute the new
        // group's visible boundary immediately (apply-review.js's
        // applyInsertions already redraws after every insertion for the
        // same reason) — without this the group stays invisible until some
        // unrelated user action (zoom, node move) triggers a real redraw.
        RED.view.redraw(true);

        // CLAUDE-020: group_nodes succeeded silently — no chat confirmation,
        // unlike its sibling WRITE-tool executor (apply-review.js's
        // applyInsertions), which reports a "Touchdown" note on every
        // successful insertion. Mirror that here so a Build-plan step that
        // groups nodes is actually confirmed in the chat, not just visible
        // on the canvas.
        var groupedNote = "Touchdown — created group \"" + name + "\" (" +
            resolved.length + " node(s)). Ctrl+Z to undo.";
        addMessage("assistant", groupedNote);
        pushHistory("assistant", groupedNote);
        updateSelectionStatus();

        var steps = [
            { check: "exists", nodeId: newGroup.id },
            { check: "property", nodeId: newGroup.id, prop: "name", expected: name }
        ];
        resolved.forEach(function (n) {
            steps.push({ check: "property", nodeId: n.id, prop: "g", expected: newGroup.id });
        });
        var checks = runChecksForToolResult(steps, {});
        return buildWriteToolResult(args, checks, { groupId: newGroup.id });
    }

    // Per-step narration: a short human-readable description of what a tool
    // call is about to do, shown in the pending indicator (see runAgentChat).
    // ---- Converged Build runtime steps (R11-6) ---------------------------
    // Evidence collected from RED.comms (onDebugMessage / onNodeStatus) while
    // a verify_runtime step is listening; null otherwise.
    var buildRuntimeEvidence = null;
    var buildRuntimeTapIds = null;
    var buildRuntimeStatusIds = null;
    // Set while deploy_flows waits for the editor's own "deploy" event
    // (init.js); called once with no arguments when it fires.
    var buildDeployWaiter = null;
    var buildDeployCancel = null;
    var buildVerifyWaitTimer = null;
    var buildVerifyTriggerRequest = null;
    var BUILD_DEPLOY_TIMEOUT_MS = 60000;
    var BUILD_VERIFY_DEFAULT_WAIT_MS = 4000;
    var BUILD_EVIDENCE_MAX = 12;

    // Same count the editor's Deploy button reflects: nodes changed since
    // the last deploy, minus nodes already owned by this conversation's runs
    // and this run's temporary taps.
    function countUndeployedNodes(excludedIds, runId) {
        var n = 0;
        var excluded = {};
        (Array.isArray(excludedIds) ? excludedIds : []).forEach(function (id) { if (id) { excluded[id] = true; } });
        try {
            RED.nodes.eachNode(function (node) {
                if (!node || (!node.changed && !node.moved)) { return; }
                if (excluded[node.id] || (runId && runtimeTapRunId(node) === runId)) { return; }
                n++;
            });
        } catch (e) { /* editor not ready */ }
        return n;
    }

    function runtimeRunNodeIds(historyEvents) {
        var ids = {};
        function add(value) {
            if (!value) { return; }
            if (typeof value === "string") { ids[value] = true; return; }
            if (Array.isArray(value)) { value.forEach(add); return; }
            if (typeof value !== "object") { return; }
            if (value.id) { ids[value.id] = true; }
            if (value.source && value.source.id) { ids[value.source.id] = true; }
            if (value.target && value.target.id) { ids[value.target.id] = true; }
            ["node", "nodes", "groups", "links", "removedLinks", "events"].forEach(function (key) {
                if (value[key]) { add(value[key]); }
            });
        }
        add(historyEvents);
        return Object.keys(ids);
    }

    function runtimeOutgoingLinks(node) {
        var links = [];
        if (!node || !RED.nodes) { return links; }
        if (typeof RED.nodes.filterLinks === "function") {
            try { return RED.nodes.filterLinks({ source: node }) || []; } catch (e) { /* fall through */ }
        }
        if (typeof RED.nodes.eachLink === "function") {
            RED.nodes.eachLink(function (link) {
                if (link && link.source && link.source.id === node.id) { links.push(link); }
            });
        }
        return links;
    }

    function runtimeNodeLinks(node) {
        var links = [];
        if (!node || !RED.nodes) { return links; }
        if (typeof RED.nodes.filterLinks === "function") {
            try { links = links.concat(RED.nodes.filterLinks({ source: node }) || []); } catch (e) { /* optional */ }
            try { links = links.concat(RED.nodes.filterLinks({ target: node }) || []); } catch (e2) { /* optional */ }
        }
        if (!links.length && typeof RED.nodes.eachLink === "function") {
            RED.nodes.eachLink(function (link) {
                if (link && ((link.source && link.source.id === node.id) || (link.target && link.target.id === node.id))) {
                    links.push(link);
                }
            });
        }
        return links.filter(function (link, index, all) { return all.indexOf(link) === index; });
    }

    function removeFlowPilotTapNodes(runId, nodeIds, historyEvents) {
        if (typeof RED === "undefined" || !RED.nodes) { return 0; }
        var wanted = {};
        (Array.isArray(nodeIds) ? nodeIds : []).forEach(function (id) { if (id) { wanted[id] = true; } });
        var candidates = [];
        try {
            RED.nodes.eachNode(function (node) {
                if (node && isFlowPilotTap(node) && ((!runId || runtimeTapRunId(node) === runId) || wanted[node.id])) {
                    candidates.push(node);
                }
            });
        } catch (e) { return 0; }
        var removed = 0;
        candidates.forEach(function (liveNode) {
            var connectedLinks = runtimeNodeLinks(liveNode);
            try { RED.nodes.remove(liveNode.id); } catch (e) { return; }
            if (liveNode.g && RED.nodes.group) {
                var ownerGroup = RED.nodes.group(liveNode.g);
                if (ownerGroup && Array.isArray(ownerGroup.nodes)) {
                    var index = ownerGroup.nodes.indexOf(liveNode);
                    if (index !== -1) { ownerGroup.nodes.splice(index, 1); }
                    if (RED.group && RED.group.markDirty) { RED.group.markDirty(ownerGroup); }
                }
            }
            var event = {
                t: "delete", nodes: [liveNode], links: connectedLinks, groups: [],
                junctions: [], subflow: { id: undefined, instances: [] },
                subflowInputs: [], subflowOutputs: [], dirty: RED.nodes.dirty()
            };
            if (historyEvents) { historyEvents.push(event); }
            else if (RED.history && RED.history.push) { RED.history.push(event); }
            removed++;
        });
        if (removed) {
            RED.nodes.dirty(true);
            if (RED.view && RED.view.redraw) { RED.view.redraw(true); }
        }
        return removed;
    }

    function cleanupLeftoverFlowPilotTaps() {
        // A run in progress removes its own taps; a remote-change reload
        // mid-run must not pull them out from under its proof step.
        if (el("#fp-send").prop("disabled")) { return 0; }
        var removed = removeFlowPilotTapNodes(null, null, null);
        if (removed) {
            addMessage("fp-notice", "Removed " + removed + " leftover FlowPilot test nodes. Deploy to remove them from the running flow.");
        }
        return removed;
    }

    // The last meaningful output: a node with no outgoing wire, or one whose
    // wires only go to debug nodes (live: inject → change → debug was tapped
    // at the inject too, and the proof quoted "hello" instead of "HELLO").
    function runtimeFeedsOnlyDebug(node) {
        return runtimeOutgoingLinks(node).every(function (link) {
            return link && link.target && link.target.type === "debug";
        });
    }

    function ensureFlowPilotRuntimeTaps(args, runIdMap, runHistoryEvents, runId) {
        args = args || {};
        var explicit = Array.isArray(args.observe) ? args.observe : null;
        var runNodeIds = runtimeRunNodeIds(runHistoryEvents);
        var candidates = [];
        if (explicit) {
            explicit.forEach(function (id) {
                var realId = (runIdMap && runIdMap[id]) || id;
                var node = realId && RED.nodes.node(realId);
                if (node && candidates.indexOf(node) === -1) { candidates.push(node); }
            });
        } else {
            runNodeIds.forEach(function (id) {
                var node = RED.nodes.node((runIdMap && runIdMap[id]) || id);
                if (node && candidates.indexOf(node) === -1 && runtimeOutputCount(node) > 0 &&
                        runtimeFeedsOnlyDebug(node)) {
                    candidates.push(node);
                }
            });
        }
        var newNodes = [];
        var newWires = [];
        var placeholders = [];
        var sequence = 0;
        candidates.forEach(function (node) {
            var outputs = runtimeOutputCount(node);
            for (var port = 0; port < outputs; port++) {
                var placeholder = "fp-tap-" + String(runId || "run").replace(/[^a-zA-Z0-9_-]/g, "-") + "-" + (++sequence);
                placeholders.push(placeholder);
                // Node-RED 5 exposes no stable public filter for the Debug
                // sidebar's message list. Keep the tap obvious rather than
                // pretending its messages can be hidden reliably.
                newNodes.push({
                    id: placeholder, type: "debug", z: node.z,
                    name: "FlowPilot test", active: true, tosidebar: true,
                    console: false, complete: "true", targetType: "full", wires: [],
                    tostatus: false, statusVal: FP_TAP_STATUS_PREFIX + runId, statusType: "auto",
                    fpTap: runId, x: Number(node.x || 0) + 180, y: Number(node.y || 0) + (port * 40)
                });
                newWires.push({ from: node.id, fromPort: port, to: placeholder });
            }
        });
        if (!newNodes.length) {
            return { tapIds: [], tapIdSet: {}, observeIds: candidates.map(function (node) { return node.id; }) };
        }
        var idMap = applyInsertions(newNodes, newWires, [], runHistoryEvents, { keepZ: true, quiet: true }) || {};
        var tapIds = placeholders.map(function (placeholder) {
            var realId = idMap[placeholder] || placeholder;
            if (runIdMap && idMap[placeholder]) { runIdMap[placeholder] = realId; }
            return realId;
        }).filter(function (id) { return !!(id && RED.nodes.node(id)); });
        var tapIdSet = {};
        tapIds.forEach(function (id) { tapIdSet[id] = true; });
        return { tapIds: tapIds, tapIdSet: tapIdSet, observeIds: candidates.map(function (node) { return node.id; }) };
    }

    // Deploys through the editor's own deploy action (so the editor's state,
    // confirmations and history stay exactly as for a manual Deploy click),
    // then waits for its "deploy" event. done(result) is called once.
    function deployFlowsForBuild(done) {
        if (currentSettings.restricted === true) {
            done({ deployed: false, restricted: true,
                error: "Restricted mode is on — I can't deploy flows. You deploy, I'll watch." });
            return;
        }
        if (typeof RED === "undefined" || !RED.nodes || !RED.actions) {
            done({ deployed: false, error: "The editor isn't available to deploy from." });
            return;
        }
        if (!RED.nodes.dirty()) {
            done({ deployed: false, alreadyDeployed: true, note: "Nothing to deploy — the runtime already matches the editor." });
            return;
        }
        var finished = false;
        var timer = setTimeout(function () {
            if (finished) { return; }
            finished = true;
            buildDeployWaiter = null;
            buildDeployCancel = null;
            done({ deployed: false, error: "The deploy didn't complete within " + (BUILD_DEPLOY_TIMEOUT_MS / 1000) + "s (check the editor for a deploy warning)." });
        }, BUILD_DEPLOY_TIMEOUT_MS);
        buildDeployCancel = function () {
            if (finished) { return; }
            finished = true;
            clearTimeout(timer);
            buildDeployWaiter = null;
            buildDeployCancel = null;
        };
        buildDeployWaiter = function () {
            if (finished) { return; }
            finished = true;
            clearTimeout(timer);
            buildDeployWaiter = null;
            buildDeployCancel = null;
            done({ deployed: true, at: Date.now() });
        };
        try {
            RED.actions.invoke("core:deploy-flows");
        } catch (e) {
            finished = true;
            clearTimeout(timer);
            buildDeployWaiter = null;
            buildDeployCancel = null;
            done({ deployed: false, error: "Deploy failed to start: " + e.message });
        }
    }

    // Fires the trigger node (the editor's own inject endpoint) when one is
    // given and consent allows it, then collects debug messages and node
    // statuses for wait_ms. done(result) is called once.
    function verifyRuntimeForBuild(args, runIdMap, runHistoryEvents, runId, done) {
        args = args || {};
        var waitMs = Number(args.wait_ms);
        if (!(waitMs >= 1000)) { waitMs = BUILD_VERIFY_DEFAULT_WAIT_MS; }
        waitMs = Math.min(waitMs, 15000);
        if (currentSettings.restricted === true) {
            done({ expect: args.expect || "", triggered: null, waitedMs: 0, evidence: [], evidenceCount: 0,
                restricted: true, note: "Restricted mode is on — FlowPilot did not add test nodes or deploy. You deploy, I'll watch." });
            return;
        }
        var proof = ensureFlowPilotRuntimeTaps(args, runIdMap, runHistoryEvents, runId);
        var runStatusIds = {};
        runtimeRunNodeIds(runHistoryEvents).forEach(function (id) {
            var realId = (runIdMap && runIdMap[id]) || id;
            if (realId && !proof.tapIdSet[realId]) { runStatusIds[realId] = true; }
        });
        buildRuntimeTapIds = proof.tapIdSet;
        buildRuntimeStatusIds = runStatusIds;
        buildRuntimeEvidence = [];
        var triggerId = args.trigger_node_id ? ((runIdMap && runIdMap[args.trigger_node_id]) || args.trigger_node_id) : null;
        var triggerNode = triggerId ? RED.nodes.node(triggerId) : null;
        var triggered = null;
        var proofDeployResult = null;
        var verifyGeneration = runCancelGeneration;
        function verifyCancelled() { return runCancelGeneration !== verifyGeneration; }
        function collect(deployResult) {
            buildVerifyWaitTimer = null;
            if (verifyCancelled()) { return; }
            // The observe paths call collect via setTimeout with no argument;
            // fall back to the deploy that started them.
            deployResult = deployResult || proofDeployResult;
            var rawEvidence = (buildRuntimeEvidence || []).slice();
            var evidence = runtimeEvidenceForRun(rawEvidence, proof.tapIdSet, runStatusIds).slice(0, BUILD_EVIDENCE_MAX);
            buildRuntimeEvidence = null;
            buildRuntimeTapIds = null;
            buildRuntimeStatusIds = null;
            removeFlowPilotTapNodes(runId, proof.tapIds, runHistoryEvents);
            var result = {
                expect: args.expect || "",
                triggered: triggered,
                waitedMs: waitMs,
                deployedForProof: deployResult ? !!deployResult.deployed : false,
                evidence: evidence.map(function (e) { return { kind: e.kind, node: e.name, nodeId: e.nodeId, value: e.value }; }),
                evidenceCount: evidence.length,
                note: evidence.length ? undefined : (deployResult && deployResult.error) ||
                    "No FlowPilot test output or status arrived. If the flow needs an outside trigger (for example an HTTP request), say so; otherwise check the wiring and the flow."
            };
            // The taps are gone from the editor but still running until the
            // next deploy, sending "FlowPilot test" messages to the Debug
            // sidebar (live: every 10 s). The proof deploy already passed the
            // own-edits check, so deploy once more to take them out.
            if (deployResult && deployResult.deployed && proof.tapIds.length) {
                deployFlowsForBuild(function (cleanup) {
                    result.tapsRemovedFromRuntime = !!(cleanup && (cleanup.deployed || cleanup.alreadyDeployed));
                    done(result);
                });
                return;
            }
            done(result);
        }
        function startObserve() {
            if (!proof.tapIds.length && !Object.keys(runStatusIds).length) {
                collect({ error: "Nothing observable was found in the nodes this run created or changed." });
                return;
            }
            if (triggerId && !triggerNode) {
                triggered = { id: args.trigger_node_id, error: "No node with that id exists on the canvas." };
                buildVerifyWaitTimer = setTimeout(collect, waitMs);
                return;
            }
            if (triggerNode) {
                if (triggerNode.type !== "inject") {
                    triggered = { id: triggerNode.id, error: "Only inject nodes can be triggered from FlowPilot (this is a " + triggerNode.type + ")." };
                    buildVerifyWaitTimer = setTimeout(collect, waitMs);
                    return;
                }
                buildVerifyTriggerRequest = $.ajax({ url: "inject/" + triggerNode.id, type: "POST" })
                    .done(function () { triggered = { id: triggerNode.id, name: triggerNode.name || "inject", ok: true }; })
                    .fail(function (xhr) { triggered = { id: triggerNode.id, ok: false, error: "Trigger failed (" + (xhr && xhr.status) + ")" }; })
                    .always(function () {
                        buildVerifyTriggerRequest = null;
                        if (!verifyCancelled()) { buildVerifyWaitTimer = setTimeout(collect, waitMs); }
                    });
                return;
            }
            buildVerifyWaitTimer = setTimeout(collect, waitMs);
        }
        function afterTapDeploy(deployResult) {
            proofDeployResult = deployResult || null;
            if (deployResult && deployResult.error && !deployResult.deployed && !deployResult.alreadyDeployed) {
                collect(deployResult);
                return;
            }
            startObserve();
        }
        if (proof.tapIds.length) {
            var ownEdits = countUndeployedNodes(runtimeRunNodeIds(runHistoryEvents), runId);
            // _deployApproved: the caller already asked about the user's own
            // edits and got a yes (Test it's consent card); don't refuse
            // after the user said Proceed (live: it did).
            if (args._deployApproved !== true && runtimeDeployConsent(ownEdits, false, false) === "ask") {
                collect({ error: "There are " + ownEdits + " undeployed change(s) you made yourself; deploy them first, then test again." });
                return;
            }
            deployFlowsForBuild(afterTapDeploy);
        } else {
            startObserve();
        }
    }

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
            case "apply_step":
                return "Applying step" + (args.summary ? ": " + args.summary : "") + "…";
            case "remove_step":
                return "Removing node" + (args.summary ? ": " + args.summary : " " + JSON.stringify(args.nodeId || "?")) + "…";
            case "rename_node":
                return "Renaming node to " + JSON.stringify(args.name || "?") + "…";
            case "group_nodes":
                return "Creating group " + JSON.stringify(args.name || "?") + "…";
            case "redirect_mode":
                return "Redirecting to " + JSON.stringify(args.mode || "?") + " mode…";
            case "ask_user":
                return "Asking a clarifying question…";
            case "deploy_flows":
                var pending = Math.max(Number(args._nodeCount) || 0, countUndeployedNodes());
                var own = Number(args._ownEditCount) || 0;
                var ownText = own > 0 ? ". This will also deploy " + own + " change" + (own === 1 ? "" : "s") + " you made yourself" : "";
                return "Deploy " + pending + " changed node" + (pending === 1 ? "" : "s") + " to the runtime" + ownText +
                    (args.summary ? " (" + args.summary + ")" : "");
            case "verify_runtime":
                return "Checking the runtime output" + (args.summary ? ": " + args.summary : "") + "…";
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

    function executeAgentToolCall(call, runIdMap, runHistoryEvents) {
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
            case "apply_step":
                return executeApplyStepTool(args, runIdMap, runHistoryEvents);
            case "remove_step":
                return executeRemoveStepTool(args, runIdMap, runHistoryEvents);
            case "rename_node":
                return executeRenameNodeTool(args, runIdMap, runHistoryEvents);
            case "group_nodes":
                return executeGroupNodesTool(args, runIdMap, runHistoryEvents);
            case "redirect_mode":
                return executeRedirectModeTool(args);
            case "ask_user":
                // Non-mutating and always intercepted by the agent loop
                // (modes.js's handleStep) before reaching here — this is a
                // safe fallback only, never expected in normal operation.
                return { error: "ask_user must be answered via the loop's question UI, not executed directly" };
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
            $status.text(count + (count === 1 ? " node" : " nodes") +
                         " selected — will be sent as context")
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
            var ap = activeProvider();
            var numCtx = ap ? Number(ap.numCtx) : 0;
            var hasNumCtx = isFinite(numCtx) && numCtx > 0;

            var parts = [];
            if (contextTokens) { parts.push("context ~" + contextTokens.toLocaleString()); }
            if (debugTokens) { parts.push("debug ~" + debugTokens.toLocaleString()); }
            if (historyTokens) {
                parts.push("history ~" + historyTokens.toLocaleString() +
                    (historyPayload.truncated ? " (earlier messages omitted)" : ""));
            }
            var sizeText = "~" + tokens.toLocaleString() + " tokens" +
                (parts.length ? " (" + parts.join(", ") + ")" : "");
            if (hasNumCtx) {
                sizeText += " — " + Math.round((tokens / numCtx) * 100) + "% of " +
                    (ap.providerName || "this provider") + "'s " + numCtx.toLocaleString() +
                    " context window";
            }
            var nearProviderLimit = hasNumCtx && tokens >= numCtx * 0.8;

            $size.removeClass("fp-hidden fp-size-warn fp-size-high");
            if (tokens >= highAt || nearProviderLimit) {
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
            "**Send** (Enter to send, Shift+Enter for a new line). Auto is on " +
            "by default; use the ▾ menu for a one-shot Plan first or Just do it.\n" +
            "- **Slash commands** — `/generate`, `/modify`, `/document`, and `/build` " +
            "choose the action; `/plan` makes the next send review-first. Every " +
            "change still passes consent, validation, and review gates.\n" +
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
