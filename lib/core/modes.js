    // Single dispatch point for "Send" (button click and Enter key): slash
    // commands are handled locally first; otherwise route to the armed
    // Execute action, or a normal chat message. Bound identically in both
    // the main window and the pop-out (see initPopout) — arming/disarming/
    // slash commands are pure local state either way, but the FINAL
    // generate/document/modify/build/chat dispatch needs live RED.*
    // context that only the main window has, so the pop-out relays
    // instead of calling those functions locally (see isPopoutContext
    // Detects when the user's typed prompt implies a different mode than the
    // one currently armed, and returns a suggestedAction chip object if so.
    // High-signal phrases only — avoids false positives on common words like
    // "build" that have legitimate uses in any mode.
    function detectModeSuggestion(prompt, currentMode) {
        var text = prompt.toLowerCase();

        // Build-loop language when no loop is already running
        if (!activeBuildLoop) {
            var buildLoopRe = /\b(build[ -]loop|try[ -](?:a[ -])?(?:build[ -])?loop|deploy[ -](?:and[ -])?(?:test|verify)|run[ -](?:a[ -])?(?:build[ -])?loop|test[ -](?:the[ -])?loop|verify[ -]with[ -](?:a[ -])?loop)\b/;
            if (buildLoopRe.test(text) && currentMode !== "build") {
                return { mode: "build", prompt: prompt, customTitle: "Run deploy-verify loop on this →" };
            }
        }

        // "Create a new flow" language while in Modify — user wants Generate
        if (currentMode === "modify") {
            var generateRe = /\b(create\s+(?:a\s+)?(?:new\s+)?flow|build\s+(?:a\s+)?new\s+flow|start\s+from\s+scratch|generate\s+(?:a\s+)?(?:new\s+)?flow|make\s+(?:a\s+)?(?:new\s+)?flow)\b/;
            if (generateRe.test(text)) {
                return { mode: "generate", prompt: prompt, customTitle: "Generate a new flow instead →" };
            }
        }

        return null;
    }

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

        // Detect when the prompt implies a different mode and surface a chip
        // instead of making the API call — prevents a wasted/confused request
        // (e.g. "try a build loop" typed in Modify, where the Modify system
        // prompt can't act on mode-switch text). The chip arms the right mode
        // and puts the prompt back; the user reviews and re-sends.
        if (!isPopoutContext) {
            var promptForDetect = raw.trim();
            if (promptForDetect) {
                var modeSuggestion = detectModeSuggestion(promptForDetect, armedExecuteAction);
                if (modeSuggestion) {
                    addMessage("user", promptForDetect);
                    el("#fp-prompt").val("");
                    renderActionChip(modeSuggestion);
                    return;
                }
            }
        }

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

        function dispatch() {
            var ap = activeProvider();
            var isAgentLoop = isChat && ap && ap.supportsTools;

            setBusy(true);
            showPending(isAgentLoop);
            var payload = {
                prompt: prompt,
                context: context,
                history: historyPayload.messages,
                historyTruncated: historyPayload.truncated,
                conversationId: conversationId,
                strategy: "classic",
                entry: "chat"
            };

            function handleSendResult(data) {
                hidePending();
                // Render a collapsed thinking block for non-streaming reasoning models
                // (the streaming path handles this live in sendChatStream instead).
                if (data.reasoningContent) {
                    var $box = el("#fp-messages");
                    var approxTokens = Math.round(data.reasoningContent.length / 4);
                    var $thinking = $("<details>").addClass("fp-thinking");
                    var $summary = $("<summary>").appendTo($thinking);
                    $("<span>").text("Thinking").appendTo($summary);
                    $("<span>").addClass("fp-thinking-tokens").text(approxTokens + " tokens").appendTo($summary);
                    $("<div>").addClass("fp-thinking-body").text(data.reasoningContent).appendTo($thinking);
                    $box.append($thinking);
                }
                var message = data.message || JSON.stringify(data, null, 2);
                // Test Provider also reports tool-calling support, used by
                // the agentic path. Mirror the probe results into currentSettings
                // so the auto-preflight condition (probedModel !== model) has a
                // baseline to compare against without requiring a page reload.
                if (data.capability && data.capability.label) {
                    message += "\n\n" + data.capability.label;
                }
                if (endpoint === "test" && data.capability && data.capability.probedModel) {
                    var testAp = activeProvider();
                    if (testAp && currentSettings && Array.isArray(currentSettings.providers)) {
                        currentSettings.providers = currentSettings.providers.map(function(p) {
                            return p.id === testAp.id ? Object.assign({}, p, {
                                supportsTools: data.capability.supportsTools,
                                isReasoningModel: data.capability.isReasoningModel,
                                probedModel: data.capability.probedModel
                            }) : p;
                        });
                    }
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

        // Silent preflight: if the model changed since the last probe, save and
        // re-probe before routing — stale supportsTools silently misroutes chat
        // (agent-loop path vs streaming/non-streaming).
        // Compare against the LIVE DOM value so unsaved edits trigger correctly;
        // save first so the backend probes the right model.
        var ap = activeProvider();
        var liveModel = (el("#fp-model").length ? el("#fp-model").val() : null) || (ap && ap.model) || "";
        if (isChat && ap && ap.probedModel && liveModel && liveModel !== ap.probedModel) {
            setBusy(true);
            showPending(false);
            setAgentNarration("Pre-flight…");
            saveSettings(function() {
                var ap2 = activeProvider();
                ajaxJson("POST", "flowpilot/probe", {}, function(result) {
                    if (currentSettings && Array.isArray(currentSettings.providers)) {
                        var targetId = (ap2 || ap).id;
                        currentSettings.providers = currentSettings.providers.map(function(p) {
                            return p.id === targetId ? Object.assign({}, p, {
                                supportsTools: result.supportsTools,
                                isReasoningModel: result.isReasoningModel,
                                probedModel: result.probedModel
                            }) : p;
                        });
                    }
                    hidePending();
                    var caps = [];
                    if (result.supportsTools) { caps.push("Tools ✓"); } else { caps.push("Tools ✗"); }
                    if (result.isReasoningModel) { caps.push("Reasoning ✓"); }
                    addMessage("notice", "Pre-flight: " + (result.probedModel || liveModel) + " · " + caps.join(" · "));
                    dispatch();
                }, function() {
                    hidePending();
                    addMessage("notice", "Pre-flight failed — continuing with cached capabilities.");
                    dispatch();
                });
            });
            return;
        }

        dispatch();
    }

    function summarizeConversationHistory() {
        if (isPopoutContext) {
            addMessage("assistant", "`/summarize` only runs in the main FlowPilot panel.");
            return;
        }

        var totalMessages = conversationHistory.length;
        if (totalMessages <= 4) {
            addMessage("assistant", "Nothing much to summarize yet — only " + totalMessages +
                " message(s) so far.");
            return;
        }

        var recentTail = conversationHistory.slice(-4);
        var olderSlice = conversationHistory.slice(0, -4);
        var beforeTokens = estimateTokens(olderSlice);
        var prompt = "Summarize the earlier conversation history provided here. " +
            "Keep it concise and factual. Preserve decisions, constraints, important context, " +
            "and unresolved questions. Return plain text only.";
        var payload = {
            prompt: prompt,
            context: null,
            history: olderSlice.slice(),
            historyTruncated: false,
            conversationId: conversationId,
            strategy: "classic",
            entry: "chat"
        };

        setBusy(true);
        showPending(false);

        ajaxJson("POST", "flowpilot/chat", payload, function (data) {
            hidePending();
            var summaryText = String(data && data.message ? data.message : "").trim();
            if (!summaryText) {
                addMessage("error", "Summarize failed: no summary text returned.");
                setBusy(false);
                updateSelectionStatus();
                return;
            }

            var summaryMessage = {
                role: "assistant",
                content: "[Summary of earlier conversation]\n" + summaryText
            };
            conversationHistory = [summaryMessage].concat(recentTail);
            addMessage("assistant", "Compacted " + olderSlice.length + " earlier message(s) into a summary (~" +
                beforeTokens.toLocaleString() + " → ~" + estimateTokens(summaryMessage).toLocaleString() + " tokens).");
            setBusy(false);
            updateSelectionStatus();
        }, function (msg) {
            hidePending();
            addMessage("error", "Summarize failed: " + msg);
            setBusy(false);
            updateSelectionStatus();
        });
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
    // W7 §16 point 5: ask_user round-trips get their own small budget,
    // separate from AGENT_LOOP_MAX_STEPS, so a couple of clarifying
    // questions don't eat the real step budget.
    var AGENT_ASK_USER_MAX_ROUNDTRIPS = 3;

    var fpAgentStopRequested = false;
    // CLAUDE-022: the in-flight jqXHR for this run's current ajaxJson call
    // (first request / postNextStep / fallbackToPlain), so the Stop button
    // can actually abort it instead of only setting the flag above. Cleared
    // back to null the moment that call's own success/error callback runs,
    // so a stale reference never lingers into the next step.
    var fpCurrentAgentRequest = null;

    // P10-D1 (ADR-001 R5): monotonic suffix so two runs minted in the same
    // millisecond (Date.now() collision) still get distinct runIds.
    var runIdCounter = 0;

    function runAgentLoop(firstEndpoint, payload, stepExtra, realOnDone, realOnError) {
        if (!payload || !payload.strategy || !payload.entry) {
            throw new Error("runAgentLoop requires strategy and entry in the initial payload.");
        }
        var AGENT_LOOP_TOKEN_CEILING = (Number(currentSettings.agentLoopTokenCeiling) > 0)
            ? Number(currentSettings.agentLoopTokenCeiling) : 50000;
        var runStrategy = payload.strategy;
        var runEntry = payload.entry;
        // P10-D1 follow-up (sr-dev review): captured once, like
        // runStrategy/runEntry/runId — using the free-variable
        // conversationId instead would let a stale run's dedup lookup land
        // in the wrong conversation's bucket if the user switches
        // conversations mid-run.
        var runConversationId = payload.conversationId;
        // P10-D1: minted once per run, included in every step payload so
        // the server can echo it into logs beside strategy/entry. Also the
        // namespace for this run's WRITE tool opIds (opId = runId + ":" +
        // call.id, ADR-001 R5).
        var runId = "run-" + Date.now().toString(36) + "-" + (++runIdCounter);
        // CLAUDE-013: accumulates placeholder->real-id mappings across every
        // WRITE-tool call resolved THIS run, so a later call in the same run
        // (e.g. group_nodes) can resolve a placeholder id (e.g. "fp-new-2")
        // that an earlier call (e.g. apply_step) minted via applyInsertions —
        // each WRITE executor's call-local idMap only covers ids it created
        // itself, not ids from a prior call in the same agent loop.
        var runIdMap = {};
        // CLAUDE-027: accumulates the individual RED.history event(s) each
        // WRITE-tool call this run would otherwise have pushed on its own
        // (apply_step/remove_step/rename_node/group_nodes — see
        // applyInsertions/applyModifications in apply-review.js and
        // executeGroupNodesTool in main.js, all of which push into this
        // array instead of RED.history directly whenever it's passed
        // through). Flushed as ONE RED.history entry — via RED.history's own
        // t:"multi" wrapper, confirmed against @node-red/editor-client's
        // red.js (e.g. its deleteSelection(), which collapses a mixed
        // delete+move into one push the exact same way) when there's more
        // than one, or pushed unwrapped when there's exactly one, matching
        // that same core convention — the moment this run actually ends, by
        // flushRunHistory()/onDone/onError below. A run that never calls a
        // WRITE tool (e.g. a pure ask_user round-trip, or read-only chat)
        // leaves this empty, so flush is a no-op and no spurious entry is
        // pushed.
        var runHistoryEvents = [];
        var step = 0;
        var totalTokens = 0;
        var askUserRounds = 0;
        fpAgentStopRequested = false;
        fpCurrentAgentRequest = null;
        // W7: one entry per WRITE tool call resolved THIS runAgentLoop
        // invocation, in order (proceed-and-pass / proceed-and-fail /
        // user-declined all count, read-tool calls don't) — gives
        // handleModifyResult a real 1:1 todo-item correlation instead of
        // the CLAUDE-005 all-together fallback. Attached to the final
        // data as _agentWriteResults right before onDone(data); untouched
        // (empty) whenever no WRITE tool call was made this turn, which
        // keeps the existing all-together path completely unchanged.
        var agentWriteResults = [];
        // CLAUDE-014: plain-language note for the decision that triggered the
        // NEXT agent-step round trip (consent-gate Proceed/Skip, ask_user
        // answer) — set right before the decision resumes the loop, read and
        // cleared by postNextStep so CODEX-012's debug.log can show what the
        // user actually decided instead of only raw tool-result JSON. Only
        // populated when settings.debugLogging is on.
        var pendingDebugNote = null;

        // CLAUDE-027: pushes this run's accumulated WRITE-tool history
        // event(s) (runHistoryEvents above) to RED.history as ONE entry —
        // coalesced via t:"multi" when more than one WRITE-tool call
        // mutated this run, unwrapped when exactly one did, a no-op when
        // none did. MUST run at every single point this run can end, not
        // just the "clean" success path — a run that errors out (step
        // budget/token ceiling exceeded, user Stop, a failed request) after
        // ALREADY applying one or more WRITE tool calls still needs its
        // partial progress to land in undo history, or Ctrl+Z would be
        // unable to remove mutations that are visibly sitting on the
        // canvas. Rather than call this at each of those call sites
        // individually (easy to miss one), onDone/onError below shadow the
        // real callback params so EVERY exit from this closure flushes
        // first automatically.
        function flushRunHistory() {
            if (!runHistoryEvents.length) { return; }
            if (runHistoryEvents.length === 1) {
                RED.history.push(runHistoryEvents[0]);
            } else {
                RED.history.push({ t: "multi", events: runHistoryEvents.slice() });
            }
            runHistoryEvents = [];
        }
        function onDone(data) { flushRunHistory(); realOnDone(data); }
        function onError(err, xhr) { flushRunHistory(); realOnError(err, xhr); }

        // P10-D2 (ADR-001 R5): run events on the record store. runRec is
        // created LAZILY, the first time something WRITE-tool/ask_user-
        // worthy happens — never for a plain chat/read-only turn, so this
        // is a no-op for every mode/strategy that never offers WRITE tools
        // (chat, document, build, classic Modify — agentToolsFor only
        // offers WRITE_TOOLS for strategy:"agent" + mode:"modify"). Once
        // created, it's a "todo" record (the same W4 machinery that
        // already survives /refresh via rerenderRecord) so a mid-run
        // refresh finds it; handleModifyResult upgrades it in place with
        // real Plan: items via data._agentRunRecord instead of creating a
        // second record, once the final turn's explanation arrives.
        var runEvents = [];
        var runRec = null;

        function syncRunMarker(reason) {
            if (!runRec) { return; }
            writeRunMarker({
                runId: runId,
                action: runEntry,
                appliedCount: runEvents.filter(function (e) { return e.t === "applied"; }).length,
                conversationId: runConversationId
            }, reason || "syncRunMarker");
        }

        function recordRunEvent(t, extra) {
            if (!runRec) {
                runRec = addRecord("todo", { action: runEntry, items: [], events: runEvents });
            }
            runEvents.push(Object.assign({ t: t, at: Date.now() }, extra || {}));
            runRec.events = runEvents;
            if (t === "done") {
                clearRunMarker("run done: " + runId);
            } else {
                syncRunMarker("run event: " + t);
            }
        }

        function addUsage(usage) {
            if (usage && typeof usage.total_tokens === "number") {
                totalTokens += usage.total_tokens;
            }
        }

        function fallbackToPlain() {
            setAgentNarration("Continuing without tools…");
            fpCurrentAgentRequest = ajaxJson("POST", firstEndpoint, payload, function (data) {
                fpCurrentAgentRequest = null;
                if (runRec) { recordRunEvent("done", {}); data._agentRunRecord = runRec; }
                onDone(data);
            }, function (err, xhr) {
                fpCurrentAgentRequest = null;
                if (fpAgentStopRequested) {
                    if (runRec) { recordRunEvent("interrupted", { detail: "stopped by user" }); rerenderTodoRecord(runRec); }
                    onError("Stopped after " + Math.max(0, step - 1) + " tool call step(s) at your request.");
                    return;
                }
                if (runRec) { recordRunEvent("interrupted", { detail: "fallback request failed" }); rerenderTodoRecord(runRec); }
                // CLAUDE-023: forward xhr so a genuine parse error's raw
                // response survives to handleExecuteError (via onModifyError)
                // instead of being dropped here — ajaxJson's error callback
                // is (msg, xhr), and onError expects the same shape.
                onError(err, xhr);
            });
        }

        function postNextStep(nextMessages) {
            setAgentNarration("Thinking… (step " + step + "/" + AGENT_LOOP_MAX_STEPS + ")");
            var stepPayload = Object.assign({
                messages: nextMessages,
                conversationId: payload.conversationId
            }, stepExtra, {
                strategy: runStrategy,
                entry: runEntry,
                runId: runId,
                events: runEvents.slice()
            });
            if (pendingDebugNote) {
                stepPayload.debugNote = pendingDebugNote;
                pendingDebugNote = null;
            }
            fpCurrentAgentRequest = ajaxJson("POST", "flowpilot/agent-step", stepPayload,
                function (stepData) { fpCurrentAgentRequest = null; handleStep(stepData, nextMessages); },
                function (err, xhr) {
                    fpCurrentAgentRequest = null;
                    if (fpAgentStopRequested) {
                        if (runRec) { recordRunEvent("interrupted", { detail: "stopped by user" }); rerenderTodoRecord(runRec); }
                        onError("Stopped after " + Math.max(0, step - 1) + " tool call step(s) at your request.");
                        return;
                    }
                    if (runRec) { recordRunEvent("interrupted", { detail: "agent-step request failed" }); rerenderTodoRecord(runRec); }
                    // CLAUDE-023: forward xhr — see fallbackToPlain's error
                    // callback above for why this must not be dropped.
                    onError(err, xhr);
                });
        }

        // Processes calls[idx..] one at a time. A WRITE-gated call (per
        // toolTiers, classified against SAFE_NODE_TYPES) or an ask_user
        // call PAUSES here — rendering a chip/question and waiting for a
        // user action — instead of executing synchronously like the
        // existing 6 READ tools still do. Once the whole batch is
        // resolved, posts the next step exactly as before.
        function processToolCallsFrom(calls, idx, nextMessages, toolTiers) {
            if (idx >= calls.length) { postNextStep(nextMessages); return; }

            var call = calls[idx];
            var name = call.function.name;
            var args = parseToolCallArgs(call);
            if (name === "redirect_mode") {
                var redirectResult = executeAgentToolCall(call, runIdMap, runHistoryEvents);
                nextMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(redirectResult) });
                if (runRec) {
                    recordRunEvent("redirect", { detail: (redirectResult && redirectResult.suggestedAction && redirectResult.suggestedAction.mode) || args.mode || "unknown" });
                    recordRunEvent("done", {});
                }
                onDone({
                    explanation: (redirectResult && redirectResult.explanation) || "",
                    prose: true,
                    flow: null,
                    suggestedAction: redirectResult && redirectResult.suggestedAction ? redirectResult.suggestedAction : null
                });
                return;
            }
            var isWriteTool = name === "apply_step" || name === "remove_step" || name === "rename_node" || name === "group_nodes";
            // P10-D1: only WRITE tool calls get an opId — idempotency is
            // about preventing double MUTATION, not about read tools.
            var opId = isWriteTool ? (runId + ":" + call.id) : null;

            // P10-D1: a repeat opId (duplicate delivery, a retry, or the
            // model repeating a call) returns the SAME result without
            // re-invoking the executor — the graph is mutated at most once
            // per opId, checked against the per-conversation applied-ops
            // map before mutating (main.js).
            function runExecutorIdempotent() {
                if (opId) {
                    var recorded = getAppliedOp(runConversationId, opId);
                    if (recorded) { return recorded; }
                }
                var result = executeAgentToolCall(call, runIdMap, runHistoryEvents);
                // CLAUDE-013: merge this call's own new placeholder->real-id
                // mappings (e.g. apply_step's newNodes) into the run-scoped
                // map so a LATER call this run can resolve the same ids.
                if (result && result.idMap) { Object.assign(runIdMap, result.idMap); }
                if (opId) { recordAppliedOp(runConversationId, opId, result); }
                return result;
            }

            function continueWithResult(resultObj) {
                var _reason = null;
                if (resultObj && !resultObj.allPass) {
                    _reason = resultObj.error || resultObj.reason || null;
                }
                if (isWriteTool) { agentWriteResults.push({ allPass: !!(resultObj && resultObj.allPass), reason: _reason }); }
                nextMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(resultObj) });
                processToolCallsFrom(calls, idx + 1, nextMessages, toolTiers);
            }

            if (name === "ask_user") {
                if (askUserRounds >= AGENT_ASK_USER_MAX_ROUNDTRIPS) {
                    continueWithResult({ error: "ask_user budget (" + AGENT_ASK_USER_MAX_ROUNDTRIPS +
                        ") exhausted for this turn — proceed with your best judgment or give a final answer." });
                    return;
                }
                askUserRounds++;
                setAgentNarration(describeAgentToolCall(name, args));
                recordRunEvent("asked", { detail: args.question });
                renderAskUserQuestion({ question: args.question, options: args.options,
                    onAnswer: function (answerText) {
                        recordRunEvent("answered", { detail: answerText });
                        if (currentSettings.debugLogging) { pendingDebugNote = "user answered: " + answerText; }
                        continueWithResult({ answer: answerText });
                    } });
                return; // PAUSES here until the question is answered
            }

            if (isWriteTool) { recordRunEvent("step", { opId: opId, detail: name }); }

            var tier = toolTiers && toolTiers[call.id];
            if (writeToolCallNeedsConsent(tier, name, args)) {
                if (isWriteTool) { recordRunEvent("consent", { opId: opId, detail: name }); }
                renderAgentToolConsentGate({
                    name: name, args: args,
                    onResume: function (granted) {
                        if (currentSettings.debugLogging) {
                            pendingDebugNote = granted ? "user clicked Proceed" : "user clicked Skip this step";
                        }
                        if (!granted) {
                            continueWithResult({ skipped: true, reason: "user declined — this call was not applied" });
                            return;
                        }
                        setAgentNarration(describeAgentToolCall(name, args) + " (step " + step + "/" + AGENT_LOOP_MAX_STEPS + ")");
                        var result = runExecutorIdempotent();
                        if (isWriteTool) {
                            recordRunEvent("applied", { opId: opId });
                            recordRunEvent("verified", { opId: opId, detail: !!(result && result.allPass) });
                        }
                        continueWithResult(result);
                    }
                });
                return; // PAUSES here until Proceed/Skip is clicked
            }

            setAgentNarration(describeAgentToolCall(name, args) + " (step " + step + "/" + AGENT_LOOP_MAX_STEPS + ")");
            var autoResult = runExecutorIdempotent();
            if (isWriteTool) {
                recordRunEvent("applied", { opId: opId });
                recordRunEvent("verified", { opId: opId, detail: !!(autoResult && autoResult.allPass) });
            }
            continueWithResult(autoResult);
        }

        function handleStep(data, messages) {
            addUsage(data.usage);

            if (data.fallbackToClassic) {
                fallbackToPlain();
                return;
            }

            if (!data.toolCalls || !data.toolCalls.length) {
                if (step > 0) { addAgentStatsNote(step, totalTokens); }
                if (agentWriteResults.length) { data._agentWriteResults = agentWriteResults.slice(); }
                if (runRec) { recordRunEvent("done", {}); data._agentRunRecord = runRec; }
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

            // An ask_user-ONLY batch doesn't consume the real step budget —
            // see AGENT_ASK_USER_MAX_ROUNDTRIPS above. A batch mixing
            // ask_user with any other tool call counts normally, since real
            // work happened in it too.
            var isAskUserOnlyBatch = data.toolCalls.every(function (c) { return c.function.name === "ask_user"; });
            if (!isAskUserOnlyBatch) {
                step++;
                if (step > AGENT_LOOP_MAX_STEPS) {
                    if (runRec) { recordRunEvent("interrupted", { detail: "step budget exceeded" }); rerenderTodoRecord(runRec); }
                    onError("FlowPilot stopped after " + AGENT_LOOP_MAX_STEPS +
                        " tool call(s) without a final answer. Try breaking your " +
                        "request into smaller steps, or be more specific about " +
                        "which node(s) or flow you mean.");
                    return;
                }
            }
            if (totalTokens > AGENT_LOOP_TOKEN_CEILING) {
                if (runRec) { recordRunEvent("interrupted", { detail: "token ceiling exceeded" }); rerenderTodoRecord(runRec); }
                onError("FlowPilot stopped after using " + totalTokens +
                    " tokens on this turn (limit: " + AGENT_LOOP_TOKEN_CEILING +
                    ") without a final answer. Try selecting fewer nodes, asking a " +
                    "more specific question, or raising \"Max total tokens per " +
                    "agent turn\" in Settings → Behavior.");
                return;
            }
            if (fpAgentStopRequested) {
                if (runRec) { recordRunEvent("interrupted", { detail: "stopped by user" }); rerenderTodoRecord(runRec); }
                onError("Stopped after " + (step - 1) + " tool call step(s) at your request.");
                return;
            }

            var nextMessages = (messages || data.messages || []).slice();
            nextMessages.push({ role: "assistant", content: data.content || null, tool_calls: data.toolCalls });
            processToolCallsFrom(data.toolCalls, 0, nextMessages, data.toolTiers);
        }

        var firstPayload = Object.assign({}, payload, { tools: true, runId: runId });
        fpCurrentAgentRequest = ajaxJson("POST", firstEndpoint, firstPayload, function (data) {
            fpCurrentAgentRequest = null;
            handleStep(data, null);
        }, function (err, xhr) {
            fpCurrentAgentRequest = null;
            if (fpAgentStopRequested) {
                // CLAUDE-022: an abort of the FIRST request must actually
                // stop, not fallbackToPlain() — falling back would ignore
                // the stop and keep going without tools instead.
                if (runRec) { recordRunEvent("interrupted", { detail: "stopped by user" }); rerenderTodoRecord(runRec); }
                onError("Stopped after " + Math.max(0, step - 1) + " tool call step(s) at your request.");
                return;
            }
            // CLAUDE-023: fallbackToPlain() must only fire for failures that
            // actually look like "the provider doesn't support tools" — a
            // genuine parse/validation failure from processGenerationContent
            // (flowpilot.js) always comes back as HTTP 422 with a .raw
            // payload attached (see err.status = 422 / err.raw = content
            // there). A provider-level failure of the tools:true call itself
            // (unrecognized "tools" field, model swapped since the last
            // probe, etc.) never goes through that parser, so it always
            // reaches here as some other status with no .raw. Only the
            // latter should be silently retried without tools; the former is
            // a real failure and must surface as one so handleExecuteError
            // (via onModifyError) gets a chance to show it — including its
            // raw JSON in Debug mode.
            var raw = xhr && xhr.responseJSON && xhr.responseJSON.raw;
            var looksLikeParseFailure = !!raw || (xhr && xhr.status === 422);
            if (looksLikeParseFailure) {
                if (runRec) { recordRunEvent("interrupted", { detail: "first agentic request failed" }); rerenderTodoRecord(runRec); }
                onError(err, xhr);
                return;
            }
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
        var _chatRec = null;

        // Reasoning block (shown for reasoning models that emit reasoning_content).
        var $thinking = null;
        var $thinkingBody = null;
        var $thinkingTokens = null;
        var reasoningBuf = "";

        var fullText = "";
        var finalData = null;

        function ensureThinkingBlock() {
            if ($thinking) { return; }
            hidePending();
            $thinking = $("<details>").addClass("fp-thinking").attr("open", "");
            var $summary = $("<summary>").appendTo($thinking);
            $("<span>").text("Thinking").appendTo($summary);
            $thinkingTokens = $("<span>").addClass("fp-thinking-tokens").appendTo($summary);
            $thinkingBody = $("<div>").addClass("fp-thinking-body").appendTo($thinking);
            $box.append($thinking);
            scrollMessagesToBottom();
        }

        function ensureBubble() {
            if ($text) { return; }
            hidePending();
            // Collapse the thinking block the moment real content starts flowing.
            if ($thinking) { $thinking.prop("open", false); }
            _chatRec = addMessage("assistant", "");
            $msg = $box.find(".fp-message").last();
            $text = $msg.find("div").last();
        }

        function finish() {
            hidePending();
            // Stamp approximate token count on the thinking block once we're done.
            if ($thinking && reasoningBuf) {
                var approxTokens = Math.round(reasoningBuf.length / 4);
                $thinkingTokens.text(approxTokens + " tokens");
            }
            if (!fullText) {
                if ($msg && $msg.length) { $msg.remove(); }
                if (_chatRec) { messageRecords.splice(messageRecords.indexOf(_chatRec), 1); _chatRec = null; }
                popDanglingUserHistory();
                addMessage("error", "No response received from the provider.");
            } else {
                if (_chatRec) { _chatRec.text = fullText; _chatRec.streamingComplete = true; }
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
        // `data: {"reasoningDelta":"..."}` / `data: {"final":{...}}` /
        // `data: {"error":"..."}` / `data: [DONE]` lines. Used by both the
        // streaming pump() loop and the non-getReader fallback so neither path
        // can drift or show raw SSE text.
        function processSseLines(lines) {
            lines.forEach(function (line) {
                line = line.trim();
                if (line.indexOf("data:") !== 0) { return; }
                var dataStr = line.slice(5).trim();
                if (!dataStr || dataStr === "[DONE]") { return; }
                var evt;
                try { evt = JSON.parse(dataStr); } catch (e) { return; }
                if (evt.error) { throw new Error(evt.error); }
                if (evt.reasoningDelta) {
                    reasoningBuf += evt.reasoningDelta;
                    ensureThinkingBlock();
                    $thinkingBody.text(reasoningBuf);
                    $thinkingBody[0].scrollTop = $thinkingBody[0].scrollHeight;
                    scrollMessagesToBottom();
                } else if (evt.delta) {
                    fullText += evt.delta;
                    ensureBubble();
                    $text.html(renderMarkdown(fullText));
                    if (_chatRec) { _chatRec.text = fullText; }
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
        if (raw && currentSettings.debugLogging) {
            addMessage("error", msg);
            addGeneratedJson(raw, true);
        } else if (raw) {
            addMessage("error", msg + " Enable Debug mode in Settings to see the full response next time.");
        } else {
            addMessage("error", msg);
        }
        setBusy(false);
    }

    // Clicking an action chip arms the suggested mode, fills the compose box,
    // and fires immediately — the chip itself is the confirmation.
    function applySuggestedAction(suggestedAction) {
        if (!suggestedAction || !suggestedAction.mode || !suggestedAction.prompt) { return; }
        armExecuteAction(suggestedAction.mode);
        // CLAUDE-015: the model already identified which nodes this action
        // targets (including "the whole flow" as a valid identification,
        // not an exemption) — override whatever armExecuteAction's own
        // pinCurrentSelection() pinned from the live canvas selection, the
        // same pinnedSelectionIds every downstream consumer (Document,
        // Modify, their guards, their context builders) already reads via
        // activeSelectionIds(). Absent targetNodeIds: unchanged, today's
        // behavior. Mirrors pinCurrentSelection()'s own rule of only
        // overwriting on a non-empty result, so a bad/empty resolution
        // doesn't blow away a legitimate live-selection pin.
        if (suggestedAction.targetNodeIds === "all") {
            var allTabIds = allActiveTabNodeIds();
            if (allTabIds.length) { pinnedSelectionIds = allTabIds; }
        } else if (suggestedAction.targetNodeIds === "instance") {
            var allInstanceIds = allInstanceNodeIds();
            if (allInstanceIds.length) { pinnedSelectionIds = allInstanceIds; }
        } else if (Array.isArray(suggestedAction.targetNodeIds)) {
            var resolvedIds = suggestedAction.targetNodeIds.filter(function (id) {
                return !!findLiveNode(id);
            });
            if (resolvedIds.length) { pinnedSelectionIds = resolvedIds; }
        }
        var $promptBox = el("#fp-prompt");
        if ($promptBox.length) {
            $promptBox.val(suggestedAction.prompt);
        }
        dispatchSend();
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
        var titleText = suggestedAction.customTitle || (isChatMode ? "Switch to Chat" : "Cleared for takeoff — " + modeLabel);

        // CLAUDE-028: the record must exist before the button does, so the
        // button can carry data-fp-record-id/-action — the same relay
        // markers renderAskUserQuestion's quick-reply buttons use to
        // survive the pop-out's innerHTML clone (bindRecordActionButtons
        // in init.js rebinds by these attributes and relays the click back
        // to this window via resolveRecordAction; this window is the only
        // one with live suggestedAction data to act on). The direct click
        // handler below still fires normally for the un-popped-out sidebar.
        var rec = addRecord("chip", { chipType: "suggestedAction", suggestedAction: suggestedAction });

        var $row = $("<div>").addClass("fp-chip-row");
        var $card = $("<button>")
            .addClass("fp-chip fp-chip-card")
            .attr("type", "button")
            .attr("title", suggestedAction.prompt)
            .attr("data-fp-record-id", rec.id)
            .attr("data-fp-record-action", "apply-suggested-action")
            .on("click", function () { applySuggestedAction(suggestedAction); });
        $("<span>").addClass("fp-chip-icon")
            .append($("<i>").addClass(isChatMode ? "fa fa-comment" : "fa fa-paper-plane"))
            .appendTo($card);
        var $body = $("<span>").addClass("fp-chip-body").appendTo($card);
        $("<span>").addClass("fp-chip-title").text(titleText).appendTo($body);
        $("<span>").addClass("fp-chip-sub").text(preview).appendTo($body);
        $("<span>").addClass("fp-chip-go").html("&rsaquo;").appendTo($card);
        $card.appendTo($row);

        // CLAUDE-030: Document mode always requires a real, non-empty
        // selection at Send time (server-side: describeSelectionContext
        // returns null and /flowpilot/document 400s on "Select the node(s)
        // you want documented first" whenever nothing is actually selected)
        // — but the model has occasionally generated a selectionHint
        // implying otherwise (e.g. "leave nothing selected to document...
        // general Node-RED info") when it had no concrete node to name.
        // Rather than re-word the model's already-fragile mode-mismatch
        // prompt guidance under time pressure, override deterministically
        // here: if this chip targets Document and doesn't carry a real
        // resolved target, always show the one hint that's actually true.
        var targetResolved = suggestedAction.targetNodeIds === "all" ||
            suggestedAction.targetNodeIds === "instance" ||
            (Array.isArray(suggestedAction.targetNodeIds) && suggestedAction.targetNodeIds.length > 0);
        var hintText = (suggestedAction.mode === "document" && !targetResolved)
            ? "Select the node(s) you want documented first."
            : suggestedAction.selectionHint;
        if (hintText) {
            $("<div>").addClass("fp-chip-hint").text("Tip: " + hintText).appendTo($row);
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
        addRecord("question", { options: options });
        scrollMessagesToBottom();
    }

    // Detects the model's own tool-call envelope leaking through as
    // "prose" — e.g. a vague first-turn Modify reply the server marked
    // prose:true but whose explanation is actually the raw
    // {"explanation":...,"changes":[...]} JSON as literal text. Starting
    // with "{" alone doesn't make text suspect (real prose can open with
    // a brace), so this also requires it to parse as an object carrying
    // one of FlowPilot's own envelope keys.
    function looksLikeToolEnvelope(text) {
        if (typeof text !== "string") { return false; }
        var trimmed = text.trim();
        if (trimmed.charAt(0) !== "{") { return false; }
        var parsed;
        try {
            parsed = JSON.parse(trimmed);
        } catch (e) {
            return false;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { return false; }
        return ["changes", "newNodes", "newWires", "removeNodes", "newGroups", "explanation"]
            .some(function (key) { return Object.prototype.hasOwnProperty.call(parsed, key); });
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
        // finalizeSimpleGeneration/finalizeModifyResult set prose:true on
        // EVERY agent-strategy final response, whether or not real
        // WRITE-tool work happened this run — it's the server's generic
        // "no classic flow/changes to review" signal, not a claim that
        // nothing happened. When real write results are attached
        // (data._agentWriteResults, added client-side in handleStep before
        // onDone fires), the caller's own deterministic-summary rendering
        // needs to run instead of this generic prose bubble — bug found
        // live during the 0.6.0 go-live smoke test: this unconditional
        // early-return made C1's entire deterministic-summary/prose-
        // demotion feature unreachable for every real agent-strategy run.
        var hasRealWriteResults = Array.isArray(data._agentWriteResults) && data._agentWriteResults.length > 0;
        if (data.prose && !hasRealWriteResults) {
            if (looksLikeToolEnvelope(data.explanation)) {
                handleExecuteError("FlowPilot's reply didn't come through as expected.", data.explanation);
                updateSelectionStatus();
                return true;
            }
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
    function handleSimpleGenerationResult(data, goalPrompt) {
        hidePending();
        if (renderQuestionOrProse(data)) { return; }

        // Lay nodes out before review/import — see layoutGeneratedFlow for why.
        var flow = Array.isArray(data.flow) ? layoutGeneratedFlow(data.flow) : data.flow;
        var planItems = parseTodoPlan(data.explanation || "");
        var todoRec = null;
        var writeResults = Array.isArray(data._agentWriteResults) ? data._agentWriteResults : [];
        if (writeResults.length) {
            if (!planItems.length) {
                planItems = [{ text: goalPrompt || "Generate flow", status: "pending" }];
            }
            planItems.forEach(function (item, i) {
                item.status = (i < writeResults.length)
                    ? (writeResults[i].allPass ? "done" : "failed")
                    : "active";
            });
            if (data._agentRunRecord) {
                todoRec = data._agentRunRecord;
                todoRec.action = "generate";
                todoRec.items = planItems;
            } else {
                todoRec = addRecord("todo", { action: "generate", items: planItems });
            }
            rerenderTodoRecord(todoRec);
            var deterministicSummary = buildDeterministicRunSummary(planItems, writeResults);
            addMessage("assistant", deterministicSummary || "(no explanation returned)");
            if (shouldShowSecondaryExplanation(deterministicSummary, data.explanation)) {
                addMessage("fp-notice", data.explanation);
            }
        } else {
            addMessage("assistant", data.explanation || "(no explanation returned)");
        }
        pushHistory("assistant", data.explanation || "(no explanation returned)");
        // B1: bake the deploy-verify option into the review panel as the
        // primary chip rather than a separate chip below it. Only for
        // executable flows (not documentation-only comment nodes) and when no
        // loop is already active. The secondary "Just add to canvas" button is
        // always shown alongside it as an escape hatch.
        var _hasDeployable = (flow || []).some(function (n) { return n && n.type !== "comment" && n.type !== "group"; });
        var _buildOnImported = (goalPrompt && !activeBuildLoop && _hasDeployable)
            ? function (importResult) { startBuildLoop(goalPrompt, flow, importResult); }
            : null;
        if (!writeResults.length) {
            addGeneratedReview(flow, _buildOnImported, _buildOnImported ? goalPrompt : null);
        }
        // Suppress a server-suggested build chip when deploy-verify is already
        // the primary action inside the review panel — it would be a duplicate.
        renderActionChip(_buildOnImported && data.suggestedAction && data.suggestedAction.mode === "build"
            ? null : data.suggestedAction);
        setBusy(false);
        updateSelectionStatus();
    }

    // Shared result handler for /modify — used by both the non-streaming
    // (ajaxJson) and streaming (sendExecuteStream) paths.
    function handleModifyResult(data) {
        hidePending();
        if (renderQuestionOrProse(data)) { return; }

        // W4: parse and surface the Plan: block if present.
        var planItems = parseTodoPlan(data.explanation || "");
        var todoRec = null;
        // W7: real per-item correlation, and (CLAUDE-011) the signal that
        // real mutations already happened this turn via WRITE tool calls
        // (apply_step/remove_step/rename_node/group_nodes) — each already
        // consent-gated (or, for group_nodes' write-safe tier, always
        // auto-applied) and applied through its own review chip. Hoisted
        // above the planItems.length check (rather than declared inside
        // it) so it's always defined below even on a turn with no Plan:
        // block, e.g. a wrap-up-only final response after tool calls.
        var writeResults = Array.isArray(data._agentWriteResults) ? data._agentWriteResults : [];
        if (planItems.length) {
            // Each WRITE tool call this turn resolves ONE plan item, in
            // order (§16 point 2 — "one WRITE tool call = one plan/todo
            // item"). This is the deferred half of CLAUDE-005 (c6c2e84),
            // now unblocked: that fix could only mark the WHOLE plan
            // active/resolved together because there was no way to know
            // which check proved which numbered line — a per-call tool
            // result finally gives that mapping for free. Items beyond the
            // resolved-call count (or ALL items, when no WRITE tool call
            // was made this turn — the default, non-agentic-write path)
            // fall back to CLAUDE-005's original all-together marking
            // below, resolved via the ordinary aggregate verifySteps
            // envelope path exactly as before — confirmed unchanged when
            // _agentWriteResults is empty/absent.
            if (writeResults.length) {
                planItems.forEach(function (item, i) {
                    item.status = (i < writeResults.length)
                        ? (writeResults[i].allPass ? "done" : "failed")
                        : "active";
                });
            } else {
                // Verification only produces one aggregate pass/fail result
                // for the whole Modify response — mark every item active up
                // front so they all resolve together instead of leaving
                // items 2+ stuck at "pending" forever (only item 1 would
                // ever flip otherwise).
                planItems.forEach(function (item) { item.status = "active"; });
            }
            // P10-D2: if this run already has a live "todo" record from
            // WRITE-tool events (runAgentLoop, modes.js), upgrade it in
            // place with the real Plan: items instead of creating a
            // second record for the same run — so a run that paused
            // mid-flight (refresh, interrupted) and one that completed
            // normally both end up as ONE record with both events and
            // items.
            if (data._agentRunRecord) {
                todoRec = data._agentRunRecord;
                todoRec.action = "modify";
                todoRec.items = planItems;
            } else {
                todoRec = addRecord("todo", { action: "modify", items: planItems });
            }
            rerenderTodoRecord(todoRec);
        }

        if (writeResults.length) {
            var deterministicModifySummary = buildDeterministicRunSummary(planItems, writeResults);
            addMessage("assistant", deterministicModifySummary || "(no explanation returned)");
            if (shouldShowSecondaryExplanation(deterministicModifySummary, data.explanation)) {
                addMessage("fp-notice", data.explanation);
            }
        } else {
            addMessage("assistant", data.explanation || "(no explanation returned)");
        }
        pushHistory("assistant", data.explanation || "(no explanation returned)");
        if (data.skippedNote) { addMessage("assistant", "⚠ " + data.skippedNote); }

        // W4 Phase 2: wrap apply to run a real graph read-back via
        // verifySteps (Track A, server) instead of unconditionally marking
        // the todo done. Falls back to the Phase 1 behavior (check off with
        // no verification) when the server sent no verifySteps.
        var verifySteps = Array.isArray(data.verifySteps) ? data.verifySteps : [];
        var applyCallback = todoRec ? function(nodeDiffs, removeNodes, $btn, idMap) {
            applyModifications(nodeDiffs, removeNodes, $btn, idMap);
            if (verifySteps.length) {
                verifyModifySteps(verifySteps, idMap, todoRec);
            } else {
                todoRec.items.forEach(function(item) {
                    if (item.status === "active") { item.status = "done"; }
                });
                rerenderTodoRecord(todoRec);
            }
        } : applyModifications;

        // CLAUDE-011: agentWriteRules tells the model to omit changes/
        // newNodes/newWires/removeNodes/newGroups on this final response
        // when writeResults is non-empty, so already-applied work isn't
        // proposed a second time — but the model doesn't always comply.
        // Don't rely on the prompt alone: skip rendering a second review/
        // apply flow whenever real WRITE-tool work happened this turn,
        // regardless of what the final envelope contains.
        if (!writeResults.length) {
            addModifyReview(data.flow, data.newNodes || [], data.newWires || [], data.removeNodes || [], applyCallback, null, data.newGroups || []);
        }
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
        var useAgentStrategy = isAgentLoop && endpointName === "generate" &&
            currentSettings.enableAgentWrite === true;

        setBusy(true);
        showPending(isAgentLoop);
        var payload = {
            prompt: prompt, context: context,
            history: historyPayload.messages, historyTruncated: historyPayload.truncated,
            conversationId: conversationId,
            strategy: useAgentStrategy ? "agent" : "classic",
            entry: endpointName
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

    // W4: parse a "Plan:" block from the model's explanation field.
    // Returns an array of { text, status } items, or [] if none found.
    // Each numbered/bulleted line under "Plan:" up to the first blank line
    // becomes one item. Status starts as "pending" for all items — the
    // caller sets the first to "active" before rendering.
    function parseTodoPlan(explanation) {
        if (!explanation || typeof explanation !== "string") { return []; }
        var planStart = explanation.indexOf("Plan:");
        if (planStart === -1) { return []; }
        var afterPlan = explanation.slice(planStart + 5);
        var planBlock = afterPlan.split(/\n\n/)[0];
        var lines = planBlock.split("\n");
        var items = [];
        lines.forEach(function (line) {
            var stripped = line.replace(/^\s*\d+[.):\s]+/, "").replace(/^\s*[-*]\s+/, "").trim();
            if (stripped) { items.push({ text: stripped, status: "pending" }); }
        });
        return items;
    }

    function buildDeterministicRunSummary(planItems, writeResults) {
        var lines = [];
        var unreached = 0;
        var items = planItems || [];
        var counted = Math.max(items.length, (writeResults || []).length);
        for (var i = 0; i < counted; i++) {
            var item = items[i];
            if (item && (i >= writeResults.length || item.status === "active" || item.status === "pending")) {
                unreached++;
                continue;
            }
            var itemText = (item && item.text) ? item.text : ("Step " + (i + 1));
            if (writeResults[i] && writeResults[i].allPass) {
                lines.push("✓ " + itemText);
                continue;
            }
            var reason = (writeResults[i] && writeResults[i].reason) || "failed verification";
            lines.push("✗ " + itemText + " — " + reason);
        }
        if (unreached) {
            lines.push("▶ " + unreached + " step(s) not reached");
        }
        return lines.join("\n");
    }

    function shouldShowSecondaryExplanation(summaryText, explanationText) {
        if (!explanationText || typeof explanationText !== "string") { return false; }
        if (!summaryText || typeof summaryText !== "string") { return true; }
        function normalize(text) {
            return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
        }
        return normalize(summaryText) !== normalize(explanationText);
    }

    // W4: render or re-render a "todo" record. For a 1-item plan, renders
    // as a compact status line (one chip). For N>1 items, renders as a
    // checklist card. Updates in place when the record already has a
    // data-fp-todo-id element in the message box (e.g. on verify check-off).
    function rerenderTodoRecord(rec) {
        if (!rec || !rec.items) { return; }
        var $box = el("#fp-messages");
        if (!$box.length) { return; }
        var items = rec.items;
        var $existing = $box.find("[data-fp-todo-id='" + rec.id + "']");

        var $wrap;
        if (items.length === 1) {
            var item = items[0];
            var icon = item.status === "done" ? "✓" : item.status === "failed" ? "✗" : "▶";
            $wrap = $("<div>")
                .addClass("fp-todo-status fp-todo-" + item.status)
                .attr("data-fp-todo-id", rec.id)
                .text(icon + " " + item.text);
        } else {
            $wrap = $("<div>")
                .addClass("fp-todo-card")
                .attr("data-fp-todo-id", rec.id);
            var $ul = $("<ul>").addClass("fp-todo-list");
            items.forEach(function (item) {
                var icon = item.status === "done" ? "✓" :
                           item.status === "failed" ? "✗" :
                           item.status === "active" ? "▶" : "○";
                $("<li>")
                    .addClass("fp-todo-item fp-todo-item-" + item.status)
                    .text(icon + " " + item.text)
                    .appendTo($ul);
            });
            $wrap.append($ul);
        }

        // P10-D2 (ADR-001 R5): a run whose last recorded event isn't "done"
        // was abandoned mid-flight — an explicit interruption (stop button,
        // step/token budget) or an orphaned request that never returned.
        // Freeze whatever checklist state exists (possibly none yet, if
        // interrupted before any Plan: text arrived) and say so plainly,
        // replacing the old silent-death behavior ("Continuing without
        // tools…" then nothing). "step N" counts completed (applied) WRITE
        // tool calls, not raw round-trips.
        if (Array.isArray(rec.events) && rec.events.length) {
            var lastEvent = rec.events[rec.events.length - 1];
            if (lastEvent.t !== "done") {
                var appliedCount = rec.events.filter(function (e) { return e.t === "applied"; }).length;
                $("<div>").addClass("fp-todo-interrupted").text(
                    "⚠ This run was interrupted after step " + appliedCount +
                    " — completed steps are applied (Ctrl+Z to undo). Re-send to continue from here."
                ).appendTo($wrap);
            }
        }

        if ($existing.length) {
            $existing.replaceWith($wrap);
        } else {
            $box.append($wrap);
        }
    }

    // Step-queue path for Generate (opt-in via enableStepQueue setting).
    // After the user clicks "Add to workspace", performs a synchronous graph
    // read-back — calls RED.nodes.node(id) for every node that landed on the
    // canvas — and surfaces the result as a verification notice. This is the
    // structural verification step for Generate: "did the import actually land?"
    // not "does it do the thing?" (that's the semantic loop, Build's domain).
    // Skips comment and group nodes — those aren't addressable via RED.nodes.node.
    // todoRec: optional todo record to check off (or fail) after verification.
    function verifyImportedNodes(importResult, todoRec) {
        if (!importResult || !importResult.nodeMap) { return; }
        var nodeMap = importResult.nodeMap;
        var total = 0, found = 0, missing = [];
        // Config nodes (e.g. an http-request's TLS config, an mqtt broker
        // config) ride along in nodeMap whenever the model's own `flow`
        // array included them, but they aren't part of what the user asked
        // for — RED.nodes.node() resolves them same as regular nodes (it
        // checks configNodes[id] before falling back), so left uncounted
        // they'd silently inflate the headline total (e.g. "8" instead of
        // "5"). Track and verify them separately instead.
        var configTotal = 0, configFound = 0;
        // Node-RED's own RED.nodes.import (the generateIds:true path used
        // for every Generate/Build import) keys nodeMap TWICE per imported
        // node: once under the model's own placeholder id (assigned while
        // constructing the node, before it's added to the live registry)
        // and again under the freshly-generated real editor id (assigned in
        // the final addNode/addGroup/addJunction registration loop) — both
        // entries point to the same live node object. Left undeduped this
        // doubles every count here (visible AND config alike), independent
        // of the config/visible split above. Confirmed by reading
        // @node-red/editor-client/public/red/red.js's importNodes directly.
        var seenLiveIds = {};
        Object.keys(nodeMap).forEach(function (pid) {
            var liveNode = nodeMap[pid];
            if (!liveNode || !liveNode.id) { return; }
            if (seenLiveIds[liveNode.id]) { return; }
            seenLiveIds[liveNode.id] = true;
            if (liveNode.type === "comment" || liveNode.type === "group") { return; }
            if (liveNode._def && liveNode._def.category === "config") {
                configTotal++;
                if (nodeExists(liveNode.id)) { configFound++; }
                return;
            }
            total++;
            if (nodeExists(liveNode.id)) {
                found++;
            } else {
                missing.push(liveNode.type || pid);
            }
        });
        var configMissing = configTotal - configFound;
        var allGood = total > 0 && missing.length === 0 && configMissing === 0;
        if (total === 0) {
            // Nothing user-visible to verify (only comments/groups/config
            // nodes) — skip notice.
        } else if (allGood) {
            var configSuffix = configTotal > 0
                ? " (+" + configTotal + " supporting config node(s))"
                : "";
            addMessage("fp-notice", "✓ Verified: all " + found + " node(s) confirmed on canvas" + configSuffix + ".");
        } else {
            var allMissing = missing.slice();
            if (configMissing > 0) { allMissing.push(configMissing + " config node(s)"); }
            addMessage("fp-notice", "⚠ Verification: " + found + "/" + total + " node(s) on canvas — " +
                allMissing.length + " not found after import (" + allMissing.join(", ") + "). " +
                "These may be uninstalled node types that were silently dropped.");
        }
        // Check off (or fail) the active todo item.
        if (todoRec && todoRec.items) {
            todoRec.items.forEach(function (item) {
                if (item.status === "active") { item.status = allGood ? "done" : "failed"; }
            });
            rerenderTodoRecord(todoRec);
        }
    }

    // W4 Phase 2: real graph read-back verification for Modify, using the
    // server-derived verifySteps (Track A — property/exists/absent/wire
    // checks; see finalizeModifyResult in flowpilot.js). Mirrors
    // verifyImportedNodes's design for Generate: aggregate pass/fail across
    // all steps, surface one notice, and check off (or fail) the active
    // todo item. idMap resolves the response-time placeholder ids that
    // existence/wire checks on newly-inserted nodes carry (the server can't
    // know the browser-assigned id at response time — applyInsertions
    // assigns it and returns idMap). Property/absent checks already use
    // real existing-node ids, so idMap[id] simply misses and falls through
    // to the id unchanged.
    // One check-vocabulary evaluation (property/exists/absent/wire), shared
    // by verifyModifySteps (aggregate Modify verification) and W7's
    // per-tool-call check results (runChecksForToolResult, main.js) — same
    // approach, applied either to the whole verifySteps batch or scoped to
    // one WRITE tool call's own touched id(s). Returns null for an
    // unrecognized check type (caller should skip it, not count it either
    // way) or { ok, label } where label is the human-readable failure
    // description used in the aggregate "did not land as expected" message.
    // P10-E: each case delegates to graph-truth.js (same closure) — the
    // one implementation of graph truth, per ADR-005. Wire checks in
    // particular must never fall back to reading node.wires: RED.nodes.
    // addLink/removeLink never re-sync a live node's own .wires array
    // mid-session, so it's stale for anything added/removed this session.
    function runSingleVerifyCheck(step, idMap) {
        idMap = idMap || {};
        function resolve(id) { return (idMap && idMap[id]) || id; }
        switch (step.check) {
        case "property": {
            var okP = propertyEquals(resolve(step.nodeId), step.prop, step.expected);
            var labelP = (step.prop || "property") + " on " + step.nodeId;
            if (!okP) {
                var readP = readProperty(resolve(step.nodeId), step.prop);
                labelP += readP.exists ?
                    " (expected " + JSON.stringify(step.expected) + ", found " + JSON.stringify(readP.value) + ")" :
                    " (node does not exist)";
            }
            return { ok: okP, label: labelP };
        }
        case "exists": {
            var okE = nodeExists(resolve(step.nodeId));
            return { ok: okE, label: step.nodeId + " missing" };
        }
        case "absent": {
            var okA = nodeAbsent(resolve(step.nodeId));
            return { ok: okA, label: step.nodeId + " still present" };
        }
        case "wire": {
            var fromId = resolve(step.fromId);
            var toId = resolve(step.toId);
            var port = step.fromPort || 0;
            var okW = wireExists(fromId, port, toId);
            var labelW = "wire " + step.fromId + " → " + step.toId;
            if (!okW) {
                var fromExists = nodeExists(fromId);
                var toExists = nodeExists(toId);
                if (!fromExists && !toExists) {
                    labelW += " (neither node was ever created)";
                } else if (!fromExists) {
                    labelW += " (" + step.fromId + " was never created)";
                } else if (!toExists) {
                    labelW += " (" + step.toId + " was never created)";
                } else {
                    labelW += " (both nodes exist but aren't connected)";
                }
            }
            return { ok: okW, label: labelW };
        }
        default:
            return null; // unrecognized check type — don't count it either way
        }
    }

    function verifyModifySteps(verifySteps, idMap, todoRec) {
        if (!Array.isArray(verifySteps) || !verifySteps.length) { return; }

        var total = 0, passed = 0, failures = [], failedSteps = [];
        verifySteps.forEach(function (step) {
            var result = runSingleVerifyCheck(step, idMap);
            if (!result) { return; }
            total++;
            if (result.ok) { passed++; } else { failures.push(result.label); failedSteps.push(step); }
        });

        if (total === 0) { return; }
        var allGood = failures.length === 0;
        if (allGood) {
            addMessage("fp-notice", "✓ Verified: all " + passed + " change(s) confirmed on canvas.");
        } else {
            addMessage("fp-notice", "⚠ Verification: " + passed + "/" + total + " change(s) confirmed — " +
                failures.length + " did not land as expected (" + failures.join(", ") + ").");
            // CLAUDE-016: offer a "Fix this" chip naming exactly the nodes
            // involved in the failed checks, reusing CLAUDE-015/CODEX-014's
            // targetNodeIds auto-select mechanism rather than a new
            // retry/loop. User-initiated only — the chip pre-fills a Modify
            // prompt but still requires the user to review and click Send,
            // same as every other suggestedAction chip.
            function resolve(id) { return (idMap && idMap[id]) || id; }
            var targetNodeIds = [];
            failedSteps.forEach(function (step) {
                var ids = step.check === "wire" ? [resolve(step.fromId), resolve(step.toId)] : [resolve(step.nodeId)];
                ids.forEach(function (id) {
                    if (id && targetNodeIds.indexOf(id) === -1) { targetNodeIds.push(id); }
                });
            });
            renderActionChip({
                mode: "modify",
                prompt: "Fix the following change(s) that didn't land as expected: " + failures.join(", "),
                targetNodeIds: targetNodeIds
            });
        }
        if (todoRec && todoRec.items) {
            todoRec.items.forEach(function (item) {
                if (item.status === "active") { item.status = allGood ? "done" : "failed"; }
            });
            rerenderTodoRecord(todoRec);
        }
    }

    function handleStepQueueGenerateResult(data, goalPrompt) {
        hidePending();
        if (renderQuestionOrProse(data)) { return; }
        var flow = Array.isArray(data.flow) ? layoutGeneratedFlow(data.flow) : data.flow;
        var writeResults = Array.isArray(data._agentWriteResults) ? data._agentWriteResults : [];

        // Build the todo plan. Parse "Plan:" from explanation if present;
        // fall back to an implicit single item from the goal prompt.
        var planItems = parseTodoPlan(data.explanation || "");
        if (!planItems.length) {
            planItems = [{ text: goalPrompt || "Generate flow", status: "pending" }];
        }
        // Same aggregate-verification reasoning as the Modify path: mark
        // every item active up front so a multi-item plan resolves together.
        if (writeResults.length) {
            planItems.forEach(function (item, i) {
                item.status = (i < writeResults.length)
                    ? (writeResults[i].allPass ? "done" : "failed")
                    : "active";
            });
        } else {
            planItems.forEach(function (item) { item.status = "active"; });
        }
        var todoRec;
        if (data._agentRunRecord) {
            todoRec = data._agentRunRecord;
            todoRec.action = "generate";
            todoRec.items = planItems;
        } else {
            todoRec = addRecord("todo", { action: "generate", items: planItems });
        }
        rerenderTodoRecord(todoRec);

        if (writeResults.length) {
            var deterministicQueueSummary = buildDeterministicRunSummary(planItems, writeResults);
            addMessage("assistant", deterministicQueueSummary || "(no explanation returned)");
            if (shouldShowSecondaryExplanation(deterministicQueueSummary, data.explanation)) {
                addMessage("fp-notice", data.explanation);
            }
        } else {
            addMessage("assistant", data.explanation || "(no explanation returned)");
        }
        pushHistory("assistant", data.explanation || "(no explanation returned)");
        // B1: when a build loop is appropriate, bake deploy-verify into the
        // primary chip (same as handleSimpleGenerationResult). The callback
        // also runs verifyImportedNodes so the todo record still gets checked
        // off. Without a build loop, fall back to a plain "Add to canvas"
        // button that still fires the verify callback.
        var _hasDeployable = (flow || []).some(function (n) { return n && n.type !== "comment" && n.type !== "group"; });
        var _wantLoop = goalPrompt && !activeBuildLoop && _hasDeployable;
        var _onImported = _wantLoop
            ? function (importResult) {
                verifyImportedNodes(importResult, todoRec);
                startBuildLoop(goalPrompt, flow, importResult);
            }
            : function (importResult) { verifyImportedNodes(importResult, todoRec); };
        if (!writeResults.length) {
            addGeneratedReview(flow, _onImported, _wantLoop ? goalPrompt : null);
        }
        // Suppress a server-suggested build chip when deploy-verify is already
        // the primary action inside the review panel.
        renderActionChip(_wantLoop && data.suggestedAction && data.suggestedAction.mode === "build"
            ? null : data.suggestedAction);
        setBusy(false);
        updateSelectionStatus();
    }

    function generate() {
        if (currentSettings.enableStepQueue) {
            runGenerateLikeAction("generate", "generate", "Generate: ", handleStepQueueGenerateResult);
        } else {
            runGenerateLikeAction("generate", "generate", "Generate: ", handleSimpleGenerationResult);
        }
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
        var context = collectSelectionContext(activeSelectionIds());
        if (context && Array.isArray(context.nodes) && context.nodes.length > 0) {
            runBuildOnExistingFlow(context);
        } else {
            runGenerateLikeAction("build", "build", "Build: ", handleBuildResult);
        }
    }

    // Build loop on EXISTING selected nodes: routes to the Modify pipeline
    // with build-loop framing so the AI patches what's already there instead
    // of generating a fresh flow. Triggered when nodes are selected at the
    // moment /build fires.
    function runBuildOnExistingFlow(context) {
        var $promptBox = el("#fp-prompt");
        var goalPrompt = $promptBox.length ? $promptBox.val().trim() : "";
        if (!goalPrompt) {
            addMessage("error", "Describe what you want to achieve first.");
            return;
        }
        context = attachDebugContext(context);
        var existingNodeIds = context.nodes.map(function (n) { return n.id; });

        var instruction = "[BUILD LOOP — STEP 1] Goal: \"" + goalPrompt + "\"\n\n" +
            "Analyse the attached nodes and propose what changes will make them achieve " +
            "this goal. Start \"explanation\" with a \"Plan:\" block listing the steps. " +
            "Produce a Modify-style patch (changes / newNodes / newWires / removeNodes) — " +
            "not a full flow replacement — unless a complete rebuild is clearly the right call.";

        var label = "Build: " + goalPrompt + contextAttachmentNote(context);
        addMessage("user", label);
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
            conversationId: conversationId,
            strategy: "classic",
            entry: "build-existing"
        };

        function onBuildExistingError(msg, xhr) {
            hidePending();
            var raw = xhr && xhr.responseJSON && xhr.responseJSON.raw;
            handleExecuteError(msg, raw);
        }
        function onBuildExistingResult(data) {
            handleBuildOnExistingResult(data, goalPrompt, existingNodeIds);
        }

        if (isAgentLoop) {
            runAgentLoop("flowpilot/modify", payload,
                { mode: "modify", context: context, prompt: instruction },
                onBuildExistingResult, onBuildExistingError);
            return;
        }
        if (currentSettings.streamingEnabled) {
            payload.stream = true;
            sendExecuteStream("modify", payload, onBuildExistingResult);
            return;
        }
        ajaxJson("POST", "flowpilot/modify", payload, onBuildExistingResult, onBuildExistingError);
    }

    function handleBuildOnExistingResult(data, goalPrompt, existingNodeIds) {
        hidePending();
        if (renderQuestionOrProse(data)) { return; }

        addMessage("assistant", data.explanation || "(no explanation returned)");
        pushHistory("assistant", data.explanation || "(no explanation returned)");
        if (data.skippedNote) { addMessage("assistant", "⚠ " + data.skippedNote); }

        // Apply patches, then start the loop. idMap has placeholder→real-id
        // mappings from applyInsertions (which runs before this callback), so
        // we can extend the loop’s tracked node set to include any new nodes.
        function applyAndStartLoop(nodeDiffs, removeNodes, $applyBtn, idMap) {
            applyModifications(nodeDiffs, removeNodes, $applyBtn, idMap);
            var loopNodeIds = existingNodeIds.slice();
            if (idMap) {
                Object.keys(idMap).forEach(function (pid) {
                    var realId = idMap[pid];
                    if (realId && loopNodeIds.indexOf(realId) === -1) { loopNodeIds.push(realId); }
                });
            }
            startBuildLoop(goalPrompt, loopNodeIds, null);
        }

        addModifyReview(data.flow, data.newNodes || [], data.newWires || [],
            data.removeNodes || [], applyAndStartLoop, null, data.newGroups || []);
        setBusy(false);
        updateSelectionStatus();
    }

    // WS4: real consent gate for side-effecting build steps. Renders one
    // combined chip covering every side-effecting node this step's
    // classification found (classifyFlowNodes in flowpilot.js, server-side)
    // — a single decision rather than per-node chips, which is sufficient
    // because only the FIRST /flowpilot/build response carries
    // stepNodeClasses today (fix iterations via /flowpilot/modify don't, so
    // there's exactly one consent point per loop lifetime under the current
    // limitation — see the handleBuildResult call site).
    //
    // Reconstructed entirely from `src` (plain data, never a live closure)
    // on every call — the initial render from handleBuildResult AND every
    // later rerender (refresh, pop-out reopen, the W0A idle/focus
    // auto-refresh) via rerenderRecord's buildConsentGate branch below.
    // Mirrors rerenderReviewRecord's pattern in apply-review.js: a fresh
    // record is added each time from the source's stored fields (including
    // `decision`, once made), rather than relying on an in-memory callback
    // surviving a refresh. That in-memory-callback version is exactly what
    // broke before this fix — a refresh mid-decision fell through to
    // renderClarifyingQuestion's generic path, whose buttons send the
    // clicked label as a new chat message instead of resolving Proceed/Skip,
    // permanently stranding the loop.
    //
    // src fields: sideEffecting, flow, goalPrompt, fpUidManifest,
    // suggestedAction — everything runBuildConsentDecision needs — plus,
    // once resolved, `decision` ("proceed"|"skip") so a later rerender shows
    // a settled state instead of re-offering an already-made choice.
    function renderBuildConsentGate(src) {
        var $box = el("#fp-messages");
        if (!$box.length) {
            if (!src.decision) { runBuildConsentDecision(src, true); }
            return;
        }

        var _rec = addRecord("question", {
            buildConsentGate: true,
            options: ["Auto-verify", "I'll check myself"],
            sideEffecting: src.sideEffecting,
            flow: src.flow,
            goalPrompt: src.goalPrompt,
            fpUidManifest: src.fpUidManifest,
            suggestedAction: src.suggestedAction,
            decision: src.decision
        });

        var sideEffecting = Array.isArray(_rec.sideEffecting) ? _rec.sideEffecting : [];
        var labels = sideEffecting.map(function (n) { return n.name || n.type; }).join(", ");

        if (_rec.decision) {
            // Already resolved before this render (e.g. resolved earlier in
            // the session, now showing again after a refresh) — settled
            // state, not an interactive choice.
            addMessage("assistant", "This step calls an external service: " + labels + ".");
            var $settledRow = $("<div>").addClass("fp-chip-row fp-question-row");
            $("<button>")
                .addClass("fp-consent-chip")
                .addClass(_rec.decision === "proceed" ? "fp-consent-chip-primary" : "fp-consent-chip-alt")
                .attr("type", "button").prop("disabled", true)
                .text(_rec.decision === "proceed" ? "Auto-verify ✓" : "Checking myself ✓")
                .appendTo($settledRow);
            $box.append($settledRow);
            scrollMessagesToBottom();
            return;
        }

        addMessage("assistant", "This step calls an external service: " + labels +
            ". Want it verified automatically once triggered, or would you rather check it yourself?");

        var $row = $("<div>").addClass("fp-chip-row fp-question-row");

        function decide(proceed) {
            $row.find("button").prop("disabled", true);
            _rec.decision = proceed ? "proceed" : "skip";
            runBuildConsentDecision(_rec, proceed);
        }

        $("<button>")
            .addClass("fp-consent-chip fp-consent-chip-primary")
            .attr("type", "button")
            .attr("data-fp-record-id", _rec.id)
            .attr("data-fp-record-action", "proceed")
            .text("Auto-verify")
            .on("click", function () { decide(true); })
            .appendTo($row);
        $("<button>")
            .addClass("fp-consent-chip fp-consent-chip-alt")
            .attr("type", "button")
            .attr("data-fp-record-id", _rec.id)
            .attr("data-fp-record-action", "skip")
            .text("I'll check myself")
            .on("click", function () { decide(false); })
            .appendTo($row);

        $box.append($row);
        scrollMessagesToBottom();
    }

    // The actual "proceed with review + loop" action, factored out so both
    // the fresh (no side-effecting nodes) and gated (decision made) paths in
    // handleBuildResult, and a rerendered consent-gate record's decide(),
    // all run identical logic sourced from plain data — never a captured
    // closure. consentGranted=false builds the Skip consent object
    // (skippedNodeIds/fpUidManifest) that startBuildLoop resolves into real
    // ids via importResult.nodeMap — see startBuildLoop's own comment.
    function runBuildConsentDecision(src, consentGranted) {
        var sideEffecting = Array.isArray(src.sideEffecting) ? src.sideEffecting : [];
        var flow = src.flow;
        var goalPrompt = src.goalPrompt;
        var fpUidManifest = Array.isArray(src.fpUidManifest) ? src.fpUidManifest : [];

        if (sideEffecting.length > 0) {
            var sideLabels = sideEffecting.map(function (n) { return n.name || n.type; }).join(", ");
            addMessage("fp-notice", consentGranted
                ? "⚠ External calls: " + sideLabels + " — the deploy-test loop will auto-verify these once triggered."
                : "⚠ External calls: " + sideLabels + " — auto-verify skipped for these node(s); confirm the result yourself.");
        }
        var consent = consentGranted ? null : {
            skippedNodeIds: sideEffecting.map(function (n) { return n.id; }),
            fpUidManifest: fpUidManifest
        };
        addGeneratedReview(flow, function (importResult) {
            startBuildLoop(goalPrompt, flow, importResult, consent);
        }, goalPrompt);
        renderActionChip(src.suggestedAction);
    }

    // W7 — per-call consent gate for a write-gated agent tool call
    // (apply_step/remove_step/rename_node touching a node type outside
    // WRITE_GATE_SAFE_NODE_TYPES). Mirrors renderBuildConsentGate's shape
    // and CLAUDE-008's fp-consent-chip styling, generalized to hold an
    // arbitrary pending tool call instead of only a build-loop's node set.
    //
    // src.onResume is a live function reference, not plain-data-only —
    // this is a DELIBERATE, reported deviation from renderBuildConsentGate/
    // runBuildConsentDecision's full data-reconstruction pattern. Reason:
    // the actual continuation (resuming the SAME in-flight
    // runAgentLoop/handleStep batch — remaining tool calls, accumulated
    // messages, then POSTing the next step and continuing the loop) lives
    // in per-invocation closures that aren't all JSON-serializable
    // (onDone/onError are themselves ad-hoc closures at each Modify call
    // site, e.g. onModifyResult/onModifyError capturing goalPrompt/
    // existingNodeIds). This mirrors the established, already-shipped
    // rerenderGeneratedReview "onImported is a live function ref, valid
    // within the same session" pattern rather than the stricter one.
    // Confirmed the stricter pattern's actual reason — a genuinely separate
    // pop-out window JS realm — does NOT apply here: the agent loop only
    // ever runs in the main window (dispatchSend's pop-out branch relays
    // via postMessage back to the opener rather than running its own loop,
    // and runBuildConsentDecision/renderBuildConsentGate itself has no
    // pop-out relay path either — confirmed via grep, so this is no
    // weaker than the existing shipped precedent). What DOES carry over
    // from CLAUDE-004-fix is the actual bug class it fixed: rerenderRecord
    // must find a dispatch branch and re-render from the SAME stored
    // record on refresh, never silently fall through to a generic path —
    // that guarantee is fully delivered below.
    function renderAgentToolConsentGate(src) {
        var $box = el("#fp-messages");
        if (!$box.length) {
            if (!src.decision && typeof src.onResume === "function") { src.onResume(true); }
            return;
        }
        // The pending "typing" indicator is only cleared automatically when
        // a turn fully completes or errors — a pause here otherwise leaves
        // it stuck showing stale narration ("Applying step: …") permanently
        // above the real gate that renders below it.
        hidePending();

        var _rec = addRecord("question", {
            agentToolConsent: true,
            options: ["Proceed", "Skip this step"],
            name: src.name,
            args: src.args,
            label: describeAgentToolCall(src.name, src.args),
            onResume: src.onResume,
            decision: src.decision
        });

        if (_rec.decision) {
            // Already resolved before this render (e.g. resolved earlier in
            // the session, now showing again after a refresh) — settled
            // state, not an interactive choice. Mirrors
            // renderBuildConsentGate's settled branch exactly.
            addMessage("assistant", "Consent requested for: " + _rec.label);
            var $settledRow = $("<div>").addClass("fp-chip-row fp-question-row");
            $("<button>")
                .addClass("fp-consent-chip")
                .addClass(_rec.decision === "proceed" ? "fp-consent-chip-primary" : "fp-consent-chip-alt")
                .attr("type", "button").prop("disabled", true)
                .text(_rec.decision === "proceed" ? "Proceeded ✓" : "Skipped ✓")
                .appendTo($settledRow);
            $box.append($settledRow);
            scrollMessagesToBottom();
            return;
        }

        addMessage("assistant", "FlowPilot wants to do this: " + _rec.label +
            ". Let it proceed, or skip just this one step and continue?");

        var $row = $("<div>").addClass("fp-chip-row fp-question-row");

        function decide(proceed) {
            $row.find("button").prop("disabled", true);
            _rec.decision = proceed ? "proceed" : "skip";
            if (typeof _rec.onResume === "function") { _rec.onResume(proceed); }
        }

        $("<button>")
            .addClass("fp-consent-chip fp-consent-chip-primary")
            .attr("type", "button")
            .attr("data-fp-record-id", _rec.id)
            .attr("data-fp-record-action", "proceed")
            .text("Proceed")
            .on("click", function () { decide(true); })
            .appendTo($row);
        $("<button>")
            .addClass("fp-consent-chip fp-consent-chip-alt")
            .attr("type", "button")
            .attr("data-fp-record-id", _rec.id)
            .attr("data-fp-record-action", "skip")
            .text("Skip this step")
            .on("click", function () { decide(false); })
            .appendTo($row);

        $box.append($row);
        scrollMessagesToBottom();
    }

    // W7 — ask_user tool UI. Reuses renderClarifyingQuestion's button +
    // free-text presentation, but resumes the SAME in-flight agent-loop
    // tool-call batch with the answer as a tool result via src.onAnswer —
    // NOT dispatchSend() (which sends a brand-new user Send, a different
    // flow entirely from continuing an already-in-progress tool-call turn).
    // Same refresh-survival shape as renderAgentToolConsentGate (record +
    // settled state), for the same reason: a mid-answer /refresh must not
    // strand the loop or silently re-ask a resolved question.
    function renderAskUserQuestion(src) {
        var $box = el("#fp-messages");
        if (!$box.length) {
            if (src.decision !== "answered" && typeof src.onAnswer === "function") { src.onAnswer(""); }
            return;
        }
        // Same reasoning as renderAgentToolConsentGate: a pause here must
        // clear the pending indicator itself, since nothing else will.
        hidePending();

        var _rec = addRecord("question", {
            askUserTool: true,
            question: src.question || "FlowPilot has a question.",
            options: Array.isArray(src.options) ? src.options : [],
            onAnswer: src.onAnswer,
            decision: src.decision,
            answerText: src.answerText
        });

        if (_rec.decision === "answered") {
            addMessage("assistant", _rec.question);
            var $settled = $("<div>").addClass("fp-chip-row fp-question-row");
            $("<button>")
                .addClass("red-ui-button red-ui-button-small fp-chip fp-question-option")
                .attr("type", "button").prop("disabled", true)
                .text((_rec.answerText || "") + " ✓")
                .appendTo($settled);
            $box.append($settled);
            scrollMessagesToBottom();
            return;
        }

        addMessage("assistant", _rec.question);

        var $row = $("<div>").addClass("fp-chip-row fp-question-row");
        var $otherRow;

        function answer(text) {
            $row.find("button, input").prop("disabled", true);
            if ($otherRow) { $otherRow.find("button, input").prop("disabled", true); }
            _rec.decision = "answered";
            _rec.answerText = text;
            if (typeof _rec.onAnswer === "function") { _rec.onAnswer(text); }
        }

        _rec.options.forEach(function (opt) {
            $("<button>")
                .addClass("red-ui-button red-ui-button-small fp-chip fp-question-option")
                .attr("type", "button")
                .attr("data-fp-record-id", _rec.id)
                .attr("data-fp-record-action", "answer")
                .attr("data-fp-record-value", opt)
                .text(opt)
                .on("click", function () { answer(opt); })
                .appendTo($row);
        });

        $otherRow = $("<div>").addClass("fp-question-other-row fp-hidden");
        var $otherInput = $("<input>")
            .attr("type", "text")
            .attr("placeholder", "Type your answer…")
            .addClass("fp-question-other-input");
        var $otherSend = $("<button>")
            .addClass("red-ui-button red-ui-button-small")
            .attr("type", "button")
            .attr("data-fp-record-id", _rec.id)
            .attr("data-fp-record-action", "answer-other")
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
            .attr("data-fp-record-id", _rec.id)
            .attr("data-fp-record-action", "show-other")
            .text("Other…")
            .on("click", function () {
                $otherRow.removeClass("fp-hidden");
                $otherInput.focus();
            })
            .appendTo($row);

        $box.append($row).append($otherRow);
        scrollMessagesToBottom();
    }

    function renderProposeActionChip(rec) {
        var $box = el("#fp-messages");
        if (!$box.length) { return; }
        var pa = rec.proposeAction || {};
        var editingKey = "editing_" + rec.id;
        var editingState = rec[editingKey] || {};
        if (rec.decision) {
            if (rec.decision === "act") {
                addMessage("assistant", "Approved plan: " + (pa.summary || "(no summary)"));
            } else if (rec.decision === "discard") {
                addMessage("assistant", "Plan dismissed.");
            }
            return;
        }
        addMessage("assistant", "FlowPilot proposes an action:");
        var $row = $("<div>").addClass("fp-chip-row");
        var $card = $("<div>").addClass("fp-chip fp-chip-card");
        var modes = ["generate", "modify", "document", "build"];
        var modeRow = $("<div>").addClass("fp-propose-mode-row");
        modes.forEach(function (m) {
            var isProposed = m === pa.action;
            var modeLabel = m.charAt(0).toUpperCase() + m.slice(1);
            var $badge = $("<span>").addClass("fp-propose-mode-badge")
                .addClass(isProposed ? "fp-propose-mode-active" : "fp-propose-mode-inactive")
                .attr("title", modeLabel)
                .text(modeLabel.charAt(0));
            modeRow.append($badge);
        });
        $card.append(modeRow);
        var $summarySection = $("<div>").addClass("fp-propose-summary-section");
        var $summaryDisplay = $("<div>").addClass("fp-propose-summary-display");
        var summaryText = pa.summary || "(no summary)";
        $summaryDisplay.text(summaryText);
        var $editButton = $("<button>")
            .addClass("red-ui-button red-ui-button-small")
            .attr("type", "button")
            .text("Edit")
            .on("click", function () {
                editingState.summaryOpen = !editingState.summaryOpen;
                rec[editingKey] = editingState;
                renderProposeActionChip(rec);
            });
        $summarySection.append($summaryDisplay).append($editButton);
        if (editingState.summaryOpen) {
            var $textarea = $("<textarea>")
                .addClass("fp-propose-summary-textarea")
                .val(pa.summary || "");
            $textarea.on("input", function () {
                pa.summary = $textarea.val();
                rec.proposeAction = pa;
            }).on("blur", function () {
                pa.summary = $textarea.val();
                rec.proposeAction = pa;
            });
            $summarySection.append($textarea);
        }
        $card.append($summarySection);
        if (Array.isArray(pa.targets) && pa.targets.length > 0) {
            var $targetsSection = $("<div>").addClass("fp-propose-targets-section");
            $("<div>").addClass("fp-propose-label").text("Targets:").appendTo($targetsSection);
            var $targetsList = $("<div>").addClass("fp-propose-targets-list");
            pa.targets.forEach(function (nodeId) {
                var $item = $("<button>")
                    .addClass("fp-propose-target-item")
                    .attr("type", "button")
                    .text(nodeId)
                    .on("click", function () {
                        if (typeof RED !== "undefined" && RED.view && typeof RED.view.reveal === "function") {
                            RED.view.reveal(nodeId);
                        }
                    });
                $targetsList.append($item);
            });
            $targetsSection.append($targetsList);
            $card.append($targetsSection);
        }
        var $planSection = $("<div>").addClass("fp-propose-plan-section");
        $("<div>").addClass("fp-propose-label").text("Plan:").appendTo($planSection);
        var $planList = $("<ul>").addClass("fp-propose-plan-list");
        var planItems = Array.isArray(pa.plan_items) ? pa.plan_items.slice() : [];
        planItems.forEach(function (item, idx) {
            var $li = $("<li>");
            $("<span>").addClass("fp-propose-plan-text").text(item).appendTo($li);
            $("<button>")
                .addClass("fp-propose-plan-remove")
                .attr("type", "button")
                .text("✕")
                .on("click", function () {
                    pa.plan_items = pa.plan_items.filter(function (_, i) { return i !== idx; });
                    rec.proposeAction = pa;
                    renderProposeActionChip(rec);
                })
                .appendTo($li);
            $planList.append($li);
        });
        var $addPlanRow = $("<div>").addClass("fp-propose-add-plan");
        var $planInput = $("<input>")
            .attr("type", "text")
            .attr("placeholder", "Add a plan item…")
            .addClass("fp-propose-plan-input");
        var $addButton = $("<button>")
            .addClass("red-ui-button red-ui-button-small")
            .attr("type", "button")
            .text("Add")
            .on("click", function () {
                var val = $planInput.val().trim();
                if (val) {
                    if (!pa.plan_items) { pa.plan_items = []; }
                    pa.plan_items.push(val);
                    rec.proposeAction = pa;
                    $planInput.val("");
                    renderProposeActionChip(rec);
                }
            });
        $planInput.on("keydown", function (e) {
            if (e.key === "Enter") {
                var val = $planInput.val().trim();
                if (val) {
                    if (!pa.plan_items) { pa.plan_items = []; }
                    pa.plan_items.push(val);
                    rec.proposeAction = pa;
                    $planInput.val("");
                    renderProposeActionChip(rec);
                }
            }
        });
        $addPlanRow.append($planInput).append($addButton);
        $planList.append($("<li>").append($addPlanRow));
        $planSection.append($planList);
        $card.append($planSection);
        var needsSelection = pa.needs_selection === true;
        var isLowConfidence = pa.confidence === "low";
        var canAct = !needsSelection && !isLowConfidence;
        var $buttonsRow = $("<div>").addClass("fp-propose-buttons-row");
        if (!canAct) {
            var hintText = needsSelection
                ? "Select nodes first"
                : isLowConfidence ? "Clarify your intent"
                : "Review and edit above";
            $("<div>").addClass("fp-propose-hint").text(hintText).appendTo($buttonsRow);
        }
        $("<button>")
            .addClass("fp-consent-chip fp-consent-chip-primary")
            .attr("type", "button")
            .attr("data-fp-record-id", rec.id)
            .attr("data-fp-record-action", "propose-act")
            .prop("disabled", !canAct)
            .text("Act")
            .on("click", function () {
                rec.decision = "act";
                renderProposeActionChip(rec);
            })
            .appendTo($buttonsRow);
        $("<button>")
            .addClass("fp-consent-chip fp-consent-chip-alt")
            .attr("type", "button")
            .attr("data-fp-record-id", rec.id)
            .attr("data-fp-record-action", "propose-discard")
            .text("Discard")
            .on("click", function () {
                rec.decision = "discard";
                renderProposeActionChip(rec);
            })
            .appendTo($buttonsRow);
        $card.append($buttonsRow);
        $row.append($card);
        $box.append($row);
        scrollMessagesToBottom();
    }

    function handleBuildResult(data, goalPrompt) {
        hidePending();
        if (renderQuestionOrProse(data)) { return; }

        // Lay nodes out before review/import — see layoutGeneratedFlow for why.
        var flow = Array.isArray(data.flow) ? layoutGeneratedFlow(data.flow) : data.flow;
        addMessage("assistant", data.explanation || "(no explanation returned)");
        pushHistory("assistant", data.explanation || "(no explanation returned)");

        var nodeClasses = data.stepNodeClasses;
        var sideEffecting = (nodeClasses && Array.isArray(nodeClasses.sideEffecting))
            ? nodeClasses.sideEffecting : [];
        var fpUidManifest = Array.isArray(data.fpUidManifest) ? data.fpUidManifest : [];
        var consentSrc = {
            sideEffecting: sideEffecting,
            flow: flow,
            goalPrompt: goalPrompt,
            fpUidManifest: fpUidManifest,
            suggestedAction: data.suggestedAction
        };

        if (sideEffecting.length > 0) {
            renderBuildConsentGate(consentSrc);
        } else {
            runBuildConsentDecision(consentSrc, true);
        }
        setBusy(false);
        updateSelectionStatus();
    }

    // Document feature: explain the SELECTED nodes and produce a single
    // comment node (prose + Mermaid diagram in its "info" field) to drop onto
    // the canvas. Reuses the same validate -> review -> import pipeline as
    // Generate — a comment node is just a regular flow-JSON node, so there's
    // nothing import-mechanism-specific to build here. The prompt box holds
    // OPTIONAL notes to steer the explanation; the selection is the real input.
    // Nothing selected/pinned for a Document send: rather than hard-erroring
    // (the old behavior — Document previously only ever meant "the
    // selection"), offer a deterministic one-click scope choice. This is a
    // pure client-side UX decision, not something worth routing through the
    // model — a weak/local provider's suggestedAction may omit
    // targetNodeIds even when the user's intent was clear (see the "all"/
    // "instance" vocabulary in the system prompts), so this is the backstop
    // that always works regardless of model reliability.
    function offerDocumentScopeClarification() {
        addMessage("info", "Nothing is selected. What would you like documented?");
        renderChip("This flow", "fa fa-sitemap", function () {
            var ids = allActiveTabNodeIds();
            if (ids.length) { pinnedSelectionIds = ids; }
            documentFlow();
        });
        renderChip("Entire instance", "fa fa-server", function () {
            var ids = allInstanceNodeIds();
            if (ids.length) { pinnedSelectionIds = ids; }
            documentFlow();
        });
    }

    function documentFlow() {
        // Falls back to the pinned selection if nothing is currently
        // selected, so follow-up turns need no reselection.
        var context = collectSelectionContext(activeSelectionIds());
        if (!context || !Array.isArray(context.nodes) || context.nodes.length === 0) {
            offerDocumentScopeClarification();
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
            conversationId: conversationId,
            strategy: "classic",
            entry: "document"
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
        var existingNodeIds = context.nodes.map(function (n) { return n.id; });

        var label = "Modify: " + instruction + contextAttachmentNote(context);
        addMessage("user", label);
        // Snapshot history before pushing this turn (see send()).
        var historyPayload = buildHistoryPayload();
        pushHistory("user", label);
        $promptBox.val("");

        var ap = activeProvider();
        var isAgentLoop = ap && ap.supportsTools &&
            currentSettings.enableAgentWrite === true;

        setBusy(true);
        showPending(isAgentLoop);
        var payload = {
            prompt: instruction, context: context,
            history: historyPayload.messages, historyTruncated: historyPayload.truncated,
            conversationId: conversationId,
            strategy: isAgentLoop ? "agent" : "classic",
            entry: "modify"
        };

        function onModifyError(msg, xhr) {
            hidePending();
            var raw = xhr && xhr.responseJSON && xhr.responseJSON.raw;
            handleExecuteError(msg, raw);
        }

        function onModifyResult(data) {
            handleModifyResult(data);
        }

        // Explore-then-propose, same as generate(). The
        // model may call read tools (e.g. to re-check the selected node's
        // current config) before producing the modify envelope; the final
        // diff still goes through finalizeModifyResult via handleModifyResult.
        if (isAgentLoop) {
            runAgentLoop("flowpilot/modify", payload,
                { mode: "modify", context: context, prompt: instruction },
                onModifyResult, onModifyError);
            return;
        }

        // Stream the envelope's "explanation" as it's generated; see
        // generate() for details.
        if (currentSettings.streamingEnabled) {
            payload.stream = true;
            sendExecuteStream("modify", payload, onModifyResult);
            return;
        }

        ajaxJson("POST", "flowpilot/modify", payload, onModifyResult, onModifyError);
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

    // CLAUDE-014: plain-language note for a loop-checkpoint "Continue" click,
    // read and cleared by runBuildReview's payload build. Mirrors
    // runAgentLoop's pendingDebugNote, but module-scoped since
    // renderLoopCheckpoint/runBuildReview aren't nested inside runAgentLoop.
    // No equivalent exists for "Stop loop" — stopBuildLoop makes no server
    // round trip to attach a note to.
    var pendingLoopDebugNote = null;

    // How long onDebugMessage's auto-attach waits, after each matching
    // message, for another one to arrive before locking in and running
    // the review — see onDebugMessage for why (a forked/split flow can
    // fire its debug node more than once per trigger).
    var BUILD_LOOP_ATTACH_DEBOUNCE_MS = 1200;
    // W0.3: how many times the model can bail (emit a prose reply with a
    // suggestedAction mode-redirect) before the loop gives up with an
    // honest-timeout instead of silently treating the bail as success.
    var BUILD_LOOP_MAX_BAILS = 2;
    var buildLoopAttachTimer = null;
    // Fires when "attach" waits too long with no debug — surfaces a prompt
    // for flows that don't produce automatic debug output (HTTP endpoints, etc).
    var BUILD_LOOP_NO_DEBUG_TIMEOUT_MS = 20000;
    var buildLoopNoDebugTimer = null;

    var BUILD_LOOP_WAYPOINTS = [
        { id: "apply", label: "Deploy" },
        { id: "attach", label: "Attach debug" },
        { id: "review", label: "Review" },
        { id: "done", label: "Done" }
    ];

    // Pauses the loop at the "attach → review" transition and shows a
    // clarifying-question-style checkpoint instead of auto-advancing.
    // Rendered when loopHoldStep is enabled in Settings; otherwise the
    // attach debounce timer calls runBuildReview directly.
    function renderLoopCheckpoint(loop) {
        var $box = el("#fp-messages");
        if (!$box.length || !loop) { return; }

        addMessage("assistant", "Debug output attached — continue with AI review, or stop here?");

        var $row = $("<div>").addClass("fp-chip-row fp-question-row");

        var _rec = addRecord("question", {
            options: ["Continue → AI review", "Stop loop"],
            loopCheckpoint: true,
            onResume: function (action) {
                if (action === "continue") {
                    if (activeBuildLoop) {
                        if (currentSettings.debugLogging) { pendingLoopDebugNote = "user clicked Continue"; }
                        runBuildReview(activeBuildLoop);
                    }
                } else if (action === "stop") {
                    stopBuildLoop("Build loop stopped — applied nodes remain as-is.");
                }
            }
        });

        function onContinue() {
            $row.find("button").prop("disabled", true);
            if (!activeBuildLoop) { return; }
            if (currentSettings.debugLogging) { pendingLoopDebugNote = "user clicked Continue"; }
            runBuildReview(activeBuildLoop);
        }
        function onStop() {
            $row.find("button").prop("disabled", true);
            stopBuildLoop("Build loop stopped — applied nodes remain as-is.");
        }

        $("<button>")
            .addClass("red-ui-button red-ui-button-small fp-chip fp-question-option")
            .attr("type", "button")
            .attr("data-fp-record-id", _rec.id)
            .attr("data-fp-record-action", "continue")
            .text("Continue → AI review")
            .on("click", onContinue)
            .appendTo($row);
        $("<button>")
            .addClass("red-ui-button red-ui-button-small fp-chip fp-question-option")
            .attr("type", "button")
            .attr("data-fp-record-id", _rec.id)
            .attr("data-fp-record-action", "stop")
            .text("Stop loop")
            .on("click", onStop)
            .appendTo($row);

        $box.append($row);
        scrollMessagesToBottom();
    }

    // WS3: remove FP-UID checkpoint tap nodes that the build prompt placed
    // on the canvas as FlowPilot scaffolding. These are debug nodes named
    // FP-UID001, FP-UID002, etc. — wired in parallel to external-call nodes
    // so the loop can attribute debug messages to specific checkpoints.
    // Called at loop end (any outcome) to clean up before returning control
    // to the user. Replicates the remove-and-history pattern from
    // applyModifications in apply-review.js (confirmed group-cleanup bookkeeping).
    function removeFpUidTaps(loop) {
        if (!loop || !Array.isArray(loop.nodeIds) || !loop.nodeIds.length) { return 0; }
        var FP_UID_RE = /^FP-UID\d+$/;
        var removed = 0;
        loop.nodeIds.forEach(function (id) {
            var liveNode = RED.nodes.node(id);
            if (!liveNode || !FP_UID_RE.test(liveNode.name)) { return; }
            var connectedLinks = [];
            RED.nodes.eachLink(function (l) {
                if ((l.source && l.source.id === id) || (l.target && l.target.id === id)) {
                    connectedLinks.push(l);
                }
            });
            try { RED.nodes.remove(liveNode.id); } catch (e) { return; }
            if (liveNode.g && RED.nodes.group) {
                var ownerGroup = RED.nodes.group(liveNode.g);
                if (ownerGroup) {
                    var idx = ownerGroup.nodes.indexOf(liveNode);
                    if (idx !== -1) { ownerGroup.nodes.splice(idx, 1); }
                    RED.group.markDirty(ownerGroup);
                }
            }
            RED.history.push({
                t: "delete",
                nodes: [liveNode],
                links: connectedLinks,
                groups: [],
                junctions: [],
                subflow: { id: undefined, instances: [] },
                subflowInputs: [],
                subflowOutputs: [],
                dirty: RED.nodes.dirty()
            });
            removed++;
        });
        if (removed) {
            RED.nodes.dirty(true);
            RED.view.redraw(true);
        }
        return removed;
    }

    // The single exit point for every way a build loop ends — Touchdown,
    // the cap being reached, pausing on a clarifying question, or the user
    // clicking Stop. Releases Build mode and its pinned selection too: once
    // the loop is over, there's no reason to keep the original arm-time
    // selection pinned — the user can just select fresh nodes for whatever
    // comes next.
    // success=true: update the stepper to show "Done" highlighted and leave it
    // visible as a completion badge. success=false (default): remove the stepper
    // (user stop, cap reached, paused for question).
    function stopBuildLoop(note, success) {
        var tapCount = activeBuildLoop ? removeFpUidTaps(activeBuildLoop) : 0;
        if (success && activeBuildLoop) {
            activeBuildLoop.waypoint = "done";
            renderLoopStepper(activeBuildLoop);
        }
        activeBuildLoop = null;
        if (buildLoopAttachTimer) { clearTimeout(buildLoopAttachTimer); buildLoopAttachTimer = null; }
        if (buildLoopNoDebugTimer) { clearTimeout(buildLoopNoDebugTimer); buildLoopNoDebugTimer = null; }
        if (!success) { el("#fp-loop-stepper").remove(); }
        disarmExecuteAction();
        if (note) { addMessage("assistant", note); }
        if (tapCount) { addMessage("assistant", "Removed " + tapCount + " FP-UID checkpoint tap(s) from the canvas."); }
    }

    // Applies a build-loop review's fix envelope, then keeps the loop's
    // tracked node ids in sync and advances/stops it. Factored out of
    // handleBuildReviewResult's addModifyReview callback (rather than left
    // as an inline closure) so the EXACT same logic can run whether the
    // Apply click happened in the main window or was relayed from the
    // pop-out — see the applyByRecordId handler in initMainWindow (Phase 10 0B).
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
            // CLAUDE-025: this fix still needs its OWN fresh deploy before
            // any evidence counts — the next "deploy" event re-stamps this
            // once the new apply->attach transition actually fires.
            loop.deployedAt = null;
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
            var eps = loop.httpEndpoints;
            if (eps && eps.length > 0) {
                var ep = eps[0];
                var baseUrl = (typeof window !== "undefined" && window.location)
                    ? window.location.origin : "";
                var curlMethod = ep.method === "GET" ? "" : " -X " + ep.method;
                hint = "Send " + ep.method + " " + ep.url + " to trigger the flow — " +
                    "e.g. curl" + curlMethod + " " + baseUrl + ep.url +
                    ". I’ll attach the debug output automatically.";
                if (eps.length > 1) {
                    hint += " (" + (eps.length - 1) + " more endpoint(s) in this flow.)";
                }
            } else {
                hint = "Trigger the flow, then check the Debug sidebar — I'll attach the next debug message automatically.";
            }
        } else if (loop.waypoint === "review") {
            hint = "Debug output attached — reviewing against the goal…";
        }
        if (hint) { $("<div>").addClass("fp-loop-hint").text(hint).appendTo($msg); }

        var $actions = $("<div>").addClass("fp-loop-actions").appendTo($msg);
        if (loop.waypoint !== "done") {
            $("<button>").addClass("red-ui-button red-ui-button-small").attr("type", "button")
                .text("Stop build loop")
                .on("click", function () { stopBuildLoop("Build loop stopped — applied nodes remain as-is."); })
                .appendTo($actions);
        }

        // Replace any prior buildStep snapshot — only the latest waypoint matters.
        messageRecords = messageRecords.filter(function (r) { return r.kind !== "buildStep"; });
        addRecord("buildStep", {
            waypoint: loop.waypoint,
            iteration: loop.iteration,
            maxIterations: loop.maxIterations,
            goal: loop.goal,
            nodeIds: Array.isArray(loop.nodeIds) ? loop.nodeIds.slice() : [],
            httpEndpoints: Array.isArray(loop.httpEndpoints) ? loop.httpEndpoints.slice() : []
        });

        $box.append($msg);
        scrollMessagesToBottom();
    }

    function rerenderBuildStepRecord(rec) {
        renderLoopStepper({
            waypoint: rec.waypoint || "done",
            iteration: rec.iteration || 1,
            maxIterations: rec.maxIterations || 5,
            goal: rec.goal || "",
            nodeIds: Array.isArray(rec.nodeIds) ? rec.nodeIds : [],
            httpEndpoints: Array.isArray(rec.httpEndpoints) ? rec.httpEndpoints : []
        });
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
    //
    // consent (WS4, optional): { skippedNodeIds, fpUidManifest } from a
    // Skip decision at the build consent gate (see handleBuildResult /
    // renderBuildConsentGate) — skippedNodeIds are the side-effecting
    // nodes' own PLACEHOLDER ids, fpUidManifest maps each FP-UID debug tap's
    // placeholder id to the placeholder id of the node it's wired from
    // (wiredFrom). Resolved here into two REAL-id sets: the skipped nodes
    // themselves (onNodeStatus's status/<nodeId> path checks against these)
    // and the taps wired to them (onDebugMessage's msg.id check does) — so
    // both auto-verify evidence paths honor the same Skip decision.
    function startBuildLoop(goal, nodeIdsOrNodes, importResult, consent) {
        var nodeIds = [];
        var nodeMap = importResult && importResult.nodeMap;
        if (importResult) {
            // Fresh build: map placeholder ids from the proposal to the real
            // ids importNodes assigned on the canvas.
            if (nodeMap && Array.isArray(nodeIdsOrNodes)) {
                nodeIdsOrNodes.forEach(function (n) {
                    var real = n && n.id && nodeMap[n.id];
                    if (real && real.id) { nodeIds.push(real.id); }
                });
            }
        } else if (Array.isArray(nodeIdsOrNodes)) {
            // Existing-flow build: ids are already resolved real canvas ids.
            nodeIds = nodeIdsOrNodes.filter(function (id) { return typeof id === "string" && id; });
        }
        // Detect HTTP-in endpoints so the "attach" step can show a specific
        // trigger hint instead of the generic "trigger the flow" message.
        var httpEndpoints = [];
        nodeIds.forEach(function (id) {
            var n = RED.nodes.node(id);
            if (n && n.type === "http in" && n.url) {
                httpEndpoints.push({ method: (n.method || "get").toUpperCase(), url: n.url });
            }
        });

        var skipCheckpointNodeIds = [];
        var skipCheckpointTapIds = [];
        var skippedPlaceholderIds = consent && Array.isArray(consent.skippedNodeIds) ? consent.skippedNodeIds : [];
        if (skippedPlaceholderIds.length && nodeMap) {
            skippedPlaceholderIds.forEach(function (placeholderId) {
                var real = nodeMap[placeholderId];
                if (real && real.id) { skipCheckpointNodeIds.push(real.id); }
            });
            var manifest = Array.isArray(consent.fpUidManifest) ? consent.fpUidManifest : [];
            manifest.forEach(function (tap) {
                if (!tap || skippedPlaceholderIds.indexOf(tap.wiredFrom) === -1) { return; }
                var realTap = nodeMap[tap.id];
                if (realTap && realTap.id) { skipCheckpointTapIds.push(realTap.id); }
            });
        }

        activeBuildLoop = {
            goal: goal,
            nodeIds: nodeIds,
            iteration: 1,
            maxIterations: getAgentLoopMaxIterations(),
            waypoint: "apply",
            conversationId: conversationId,
            bailCount: 0,
            httpEndpoints: httpEndpoints,
            skipCheckpointNodeIds: skipCheckpointNodeIds,
            skipCheckpointTapIds: skipCheckpointTapIds,
            // CLAUDE-025: stamped by the RED "deploy" listener (init.js) the
            // moment THIS attempt's own apply->attach transition fires — see
            // freshBuildLoopEvidence. Starts null: no deploy has happened for
            // this attempt yet, so nothing can count as evidence.
            deployedAt: null
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
        // CLAUDE-025: deliberately NOT attachDebugContext() here — that pulls
        // in the full sticky attachedDebugMessages buffer, which can still
        // hold evidence from an earlier Build attempt (or a manual attach)
        // that has nothing to do with THIS attempt's own deploy. Only
        // messages that arrived at/after this attempt's own deploy (see
        // freshBuildLoopEvidence) count as evidence for its review.
        var freshEvidence = freshBuildLoopEvidence(loop);
        if (freshEvidence.length) {
            context = context || { nodes: [], connections: {} };
            context = Object.assign({}, context, {
                debugMessages: freshEvidence.map(function (m) {
                    return { id: m.id, timestamp: m.timestamp, sourceKind: m.sourceKind, name: m.name, topic: m.topic, value: m.value };
                })
            });
        }
        var reviewEvidence = context && Array.isArray(context.debugMessages)
            ? context.debugMessages : [];
        var statusOnlyEvidence = reviewEvidence.length > 0 &&
            reviewEvidence.every(function (entry) {
                return entry && entry.sourceKind === "status";
            });
        // W0.3: framing block — suppresses the Modify escape hatch
        // (suggestedAction mode-redirect) inside the build loop context.
        // The code-side handler (handleBuildReviewResult) also detects and
        // counts bail attempts so N bails trigger an honest-timeout instead
        // of silently treating a redirect as success.
        var instruction = "CONTEXT: You are the fix engine inside a build-test-fix loop. " +
            "Your only valid responses are: (1) plain text when the goal is fully " +
            "satisfied, or (2) a {\"explanation\", \"changes\", ...} fix envelope " +
            "when something needs patching." +
            (statusOnlyEvidence
                ? " (3) Because the attached evidence contains ONLY coarse node-status " +
                  "lines, you may instead return the atomic {\"question\", " +
                  "\"questionOptions\"} envelope described below."
                : "") +
            " Do NOT use the <<<FLOWPILOT_DATA>>> " +
            "block or suggest switching to chat/generate/document — you are already " +
            "in the right context and any mode-redirect will be ignored. If you are " +
            "genuinely uncertain what to fix, " +
            (statusOnlyEvidence
                ? "use the status-only confirmation question below."
                : "describe the uncertainty inside \"explanation\" in a fix envelope.") +
            "\n\nEach attached evidence object has sourceKind. sourceKind:\"debug\" " +
            "is real message content emitted by a debug node. sourceKind:\"status\" " +
            "is only a coarse connection/status line synthesized from node status; " +
            "never treat it as proof of message payload content or successful " +
            "end-to-end behavior. " +
            (statusOnlyEvidence
                ? "STATUS-ONLY FALLBACK: if the coarse status does not prove whether " +
                  "the deployed node is actually connected/working, do not guess or " +
                  "assert failure. Ask one concrete yes/no confirmation such as " +
                  "\"Does the node show connected after deploy?\" by returning ONLY " +
                  "{\"question\":\"...\",\"questionOptions\":[\"Yes\",\"No\"]}. "
                : "") +
            "\n\n" +
            "Review the attached debug output against this build goal: \"" +
            loop.goal + "\". Before concluding anything, list out every distinct " +
            "piece of data or behavior the goal actually requires, then check the " +
            "attached debug payload(s) contain EACH one — a payload that's merely " +
            "plausible-looking, or that satisfies only PART of the goal (e.g. the " +
            "goal asked to combine two things but the payload only shows one), " +
            "does NOT fully satisfy it. If more than one debug message is " +
            "attached, treat them together as the full picture from one trigger, " +
            "not as separate independent attempts. " +
            "SPECIAL CASE — network errors: if the debug output shows ONLY a " +
            "network-level error (EHOSTUNREACH, ECONNREFUSED, ETIMEDOUT, " +
            "ENOTFOUND, getaddrinfo ENOTFOUND, EAI_AGAIN, EAI_NODATA), the " +
            "flow MIGHT be correctly built — BUT you MUST first check the node " +
            "context: if any http-request node has an empty url field, a " +
            "placeholder, or a clearly malformed url (no hostname, no protocol, " +
            "etc.), the DNS or connection error is a CONFIGURATION problem — " +
            "fix the url field, do NOT declare it an infrastructure issue. Only " +
            "apply this special case when the url is a real, non-empty, " +
            "well-formed URL and the external service is simply unreachable. In " +
            "that case reply in plain text acknowledging the flow is structurally " +
            "correct and the network error is an infrastructure issue outside the " +
            "flow. Do NOT propose any changes; this error cannot be resolved by " +
            "modifying the flow. " +
            "If it fully satisfies the goal, " +
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
            conversationId: loop.conversationId,
            strategy: "classic",
            entry: "build-review"
        };
        if (pendingLoopDebugNote) {
            payload.debugNote = pendingLoopDebugNote;
            pendingLoopDebugNote = null;
        }

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
    // Returns false when all of data's proposed changes are sentinel-echoed
    // with no insertions, removals, or wire changes. Used by
    // handleBuildReviewResult to avoid showing an all-blocked review panel
    // when the model said "no changes needed" but still emitted a modify
    // envelope (a common model behavior after a build-loop review).
    function reviewHasRealDiffs(data) {
        if ((data.newNodes && data.newNodes.length) ||
                (data.removeNodes && data.removeNodes.length) ||
                (data.newWires && data.newWires.length) ||
                (data.newGroups && data.newGroups.length)) { return true; }
        var nodes = Array.isArray(data.flow) ? data.flow : [];
        return nodes.some(function (modNode) {
            if (!modNode || !modNode.id) { return false; }
            var liveNode = findLiveNode(modNode.id);
            if (!liveNode) { return false; }
            var diff = computeNodeDiff(liveNode, modNode);
            return diff.propertyChanges.length > 0 || diff.wiresChanged;
        });
    }

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
            var explanation = data.explanation || "(no content returned)";

            if (looksLikeToolEnvelope(data.explanation)) {
                handleExecuteError("FlowPilot's reply didn't come through as expected.", data.explanation);
                stopBuildLoop("Build loop stopped — the review response wasn't in the expected format. Continue manually with Modify, or start a fresh /build.", false);
                updateSelectionStatus();
                return;
            }

            // W0.3: bail detection — a prose reply with a mode-redirect
            // suggestedAction means the model tried to exit the loop
            // context via the Modify escape hatch. Count it and retry or
            // honest-timeout rather than treating it as success.
            var sa = data.suggestedAction;
            var isBail = sa && (sa.mode === "chat" || sa.mode === "generate" || sa.mode === "document");
            if (isBail) {
                loop.bailCount = (loop.bailCount || 0) + 1;
                console.warn("[FlowPilot] build-loop bail #" + loop.bailCount +
                    " mode=" + sa.mode + ": " + explanation);
                addMessage("assistant", explanation);
                pushHistory("assistant", explanation);
                if (loop.bailCount >= BUILD_LOOP_MAX_BAILS) {
                    stopBuildLoop("Build loop could not assess the debug output — the AI kept redirecting instead of reviewing. Try attaching more debug context or continuing manually with Modify.", false);
                    setBusy(false);
                    updateSelectionStatus();
                } else {
                    addMessage("fp-notice", "Build-loop: review redirected to " + sa.mode +
                        " — staying in build context and retrying (bail " + loop.bailCount +
                        "/" + BUILD_LOOP_MAX_BAILS + ").");
                    runBuildReview(loop);
                }
                return;
            }

            addMessage("assistant", explanation);
            pushHistory("assistant", explanation);
            renderActionChip(data.suggestedAction);
            var stopMsg = /EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EAI_NODATA|getaddrinfo|unreachable|infrastructure/i
                .test(explanation)
                ? "Build complete — the flow is correctly structured, but the external endpoint was unreachable during testing (infrastructure issue, not a flow problem)."
                : "Touchdown — the debug output matches the goal.";
            stopBuildLoop(stopMsg, true);
            setBusy(false);
            updateSelectionStatus();
            return;
        }

        // Modify envelope where every proposed change is a sentinel echo —
        // the model emitted a changes object but all fields are redacted
        // placeholders with no insertions, removals, or wire changes. Treat
        // it as "no changes needed" rather than showing an all-blocked panel.
        if (!reviewHasRealDiffs(data)) {
            addMessage("assistant", data.explanation || "(no content returned)");
            pushHistory("assistant", data.explanation || "");
            renderActionChip(data.suggestedAction);
            stopBuildLoop("Touchdown — the debug output matches the goal.", true);
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
