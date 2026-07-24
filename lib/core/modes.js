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
                conversationId: conversationId
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
        addMessage("error", msg);
        if (raw) { addGeneratedJson(raw, true); }
        setBusy(false);
    }

    // Clicking an action chip arms the suggested mode, fills the compose box,
    // and fires immediately — the chip itself is the confirmation.
    function applySuggestedAction(suggestedAction) {
        if (!suggestedAction || !suggestedAction.mode || !suggestedAction.prompt) { return; }
        armExecuteAction(suggestedAction.mode);
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
        addRecord("chip", { chipType: "suggestedAction", suggestedAction: suggestedAction });
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
    function handleSimpleGenerationResult(data, goalPrompt) {
        hidePending();
        if (renderQuestionOrProse(data)) { return; }

        // Complexity routing: model flagged this as a multi-step planned task.
        // Route to the build loop instead of single-shot review — same path as
        // /build, but seeded with the plan the model returned for 2A to render.
        if (data.plan_needed) {
            var planFlow = Array.isArray(data.flow) ? layoutGeneratedFlow(data.flow) : data.flow;
            addMessage("assistant", data.explanation || "(no explanation returned)");
            pushHistory("assistant", data.explanation || "(no explanation returned)");
            addGeneratedReview(planFlow, function (importResult) {
                startBuildLoop(goalPrompt, planFlow, importResult, data.plan);
            }, goalPrompt);
            setBusy(false);
            updateSelectionStatus();
            return;
        }

        // Lay nodes out before review/import — see layoutGeneratedFlow for why.
        var flow = Array.isArray(data.flow) ? layoutGeneratedFlow(data.flow) : data.flow;
        addMessage("assistant", data.explanation || "(no explanation returned)");
        pushHistory("assistant", data.explanation || "(no explanation returned)");
        addGeneratedReview(flow);
        // After any Generate result, offer the deploy-verify loop as a one-click
        // option. Only shown when no loop is already running and the original
        // prompt is available (it always is here — goalPrompt comes from the
        // compose box value captured at send time via wrappedOnResult).
        if (goalPrompt && !activeBuildLoop) {
            renderActionChip({ mode: "build", prompt: goalPrompt, customTitle: "Run deploy-verify loop on this →" });
        }
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
        if (data.skippedNote) { addMessage("assistant", "⚠ " + data.skippedNote); }
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
            conversationId: conversationId
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

    function handleBuildOnExistingResult(data, goalPrompt, existingNodeIds, plan) {
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
            startBuildLoop(goalPrompt, loopNodeIds, null, plan);
        }

        addModifyReview(data.flow, data.newNodes || [], data.newWires || [],
            data.removeNodes || [], applyAndStartLoop, null, data.newGroups || []);
        setBusy(false);
        updateSelectionStatus();
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
        // Captured for plan_needed routing: if the model returns a multi-step
        // plan, we hand off to handleBuildOnExistingResult with the same context.
        var existingNodeIds = context.nodes.map(function (n) { return n.id; });

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

        // Complexity routing: if the model flags this as a multi-step planned
        // task, hand off to the build loop (same as /build on existing nodes).
        // Otherwise fall through to the normal single-shot modify review path.
        function onModifyResult(data) {
            if (data.plan_needed) {
                handleBuildOnExistingResult(data, instruction, existingNodeIds, data.plan);
            } else {
                handleModifyResult(data);
            }
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

    // How long onDebugMessage's auto-attach waits, after each matching
    // message, for another one to arrive before locking in and running
    // the review — see onDebugMessage for why (a forked/split flow can
    // fire its debug node more than once per trigger).
    var BUILD_LOOP_ATTACH_DEBOUNCE_MS = 1200;
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

        function onContinue() {
            $row.find("button").prop("disabled", true);
            if (!activeBuildLoop) { return; }
            runBuildReview(activeBuildLoop);
        }
        function onStop() {
            $row.find("button").prop("disabled", true);
            stopBuildLoop("Build loop stopped — applied nodes remain as-is.");
        }

        $("<button>")
            .addClass("red-ui-button red-ui-button-small fp-chip fp-question-option")
            .attr("type", "button")
            .text("Continue → AI review")
            .on("click", onContinue)
            .appendTo($row);
        $("<button>")
            .addClass("red-ui-button red-ui-button-small fp-chip fp-question-option")
            .attr("type", "button")
            .text("Stop loop")
            .on("click", onStop)
            .appendTo($row);

        $box.append($row);
        addRecord("question", { options: ["Continue → AI review", "Stop loop"], loopCheckpoint: true });
        scrollMessagesToBottom();
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
            nodeIds: Array.isArray(loop.nodeIds) ? loop.nodeIds.slice() : []
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
            nodeIds: Array.isArray(rec.nodeIds) ? rec.nodeIds : []
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
    function startBuildLoop(goal, nodeIdsOrNodes, importResult, plan) {
        var nodeIds = [];
        if (importResult) {
            // Fresh build: map placeholder ids from the proposal to the real
            // ids importNodes assigned on the canvas.
            var nodeMap = importResult.nodeMap;
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
        activeBuildLoop = {
            goal: goal,
            nodeIds: nodeIds,
            iteration: 1,
            maxIterations: getAgentLoopMaxIterations(),
            waypoint: "apply",
            conversationId: conversationId
        };
        // plan is populated by 2B complexity routing (Generate/Modify with
        // plan_needed: true). Stored here for 2A's todo-list spine to render.
        if (Array.isArray(plan) && plan.length) { activeBuildLoop.plan = plan; }
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
            addMessage("assistant", data.explanation || "(no content returned)");
            pushHistory("assistant", data.explanation || "");
            renderActionChip(data.suggestedAction);
            stopBuildLoop("Touchdown — the debug output matches the goal.", true);
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
