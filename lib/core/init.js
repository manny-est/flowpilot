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
        "- `/disable` — disable the selected node(s) (skipped on Deploy); `/enable` re-enables them. Instant, no AI involved — one Ctrl+Z undoes it.\n" +
        "- `/refresh` — re-render all messages from the in-memory record store (restores interactive Apply buttons if they were lost).\n\n" +
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

    // Registry of all slash commands — drives the autocomplete panel that
    // appears when the user types "/" in the prompt box. Keep in sync with
    // handleSlashCommand below.
    var SLASH_COMMANDS = [
        { cmd: "/generate", desc: "Switch to Generate mode" },
        { cmd: "/document", desc: "Switch to Document mode" },
        { cmd: "/modify",   desc: "Switch to Modify mode" },
        { cmd: "/build",    desc: "Start a deploy-verify build loop" },
        { cmd: "/chat",     desc: "Switch to Chat mode" },
        { cmd: "/query",    desc: "Add or toggle a Query intent" },
        { cmd: "/compact",  desc: "Compact labels on selected nodes" },
        { cmd: "/expand",   desc: "Expand labels on selected nodes" },
        { cmd: "/disable",  desc: "Disable selected nodes" },
        { cmd: "/enable",   desc: "Enable selected nodes" },
        { cmd: "/refresh",  desc: "Re-render all messages from shadow record store" },
        { cmd: "/demo",     desc: "Type in a demo prompt" },
        { cmd: "/help",     desc: "Show all available commands" },
        { cmd: "/feedback", desc: "Show feedback info" }
    ];

    function bindSlashAutocomplete($promptBox) {
        var $wrap = $promptBox.closest(".fp-prompt-wrap");
        var $panel = $('<div id="fp-slash-suggest"></div>').hide();
        $wrap.prepend($panel);
        var activeIndex = -1;

        function getRows() { return $panel.find(".fp-slash-row"); }

        function setActive(idx) {
            getRows().removeClass("fp-slash-active");
            activeIndex = idx;
            if (idx >= 0) { getRows().eq(idx).addClass("fp-slash-active"); }
        }

        function showPanel(partial) {
            var matches = SLASH_COMMANDS.filter(function (c) {
                return c.cmd.indexOf(partial) === 0;
            });
            if (!matches.length) { $panel.hide(); return; }
            $panel.empty();
            matches.forEach(function (c) {
                $('<div class="fp-slash-row">')
                    .append($('<span class="fp-slash-cmd">').text(c.cmd))
                    .append($('<span class="fp-slash-desc">').text(c.desc))
                    .on("mousedown", function (e) {
                        e.preventDefault();
                        completeWith(c.cmd);
                    })
                    .appendTo($panel);
            });
            setActive(0);
            $panel.show();
        }

        function hidePanel() {
            $panel.hide();
            activeIndex = -1;
        }

        function completeWith(cmd) {
            $promptBox.val(cmd + " ").focus();
            hidePanel();
        }

        $promptBox.on("input.slashcomplete", function () {
            var val = $promptBox.val();
            if (/^\/\S*$/.test(val)) { showPanel(val); } else { hidePanel(); }
        });

        $promptBox.on("keydown.slashcomplete", function (e) {
            if (!$panel.is(":visible")) { return; }
            var $rows = getRows();
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive(Math.min(activeIndex + 1, $rows.length - 1));
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive(Math.max(activeIndex - 1, 0));
            } else if (e.key === "Tab" || e.key === "Enter") {
                if (activeIndex >= 0) {
                    e.preventDefault();
                    completeWith($rows.eq(activeIndex).find(".fp-slash-cmd").text());
                }
            } else if (e.key === "Escape") {
                hidePanel();
            }
        });

        $promptBox.on("blur.slashcomplete", function () {
            setTimeout(function () { hidePanel(); }, 150);
        });
    }

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
            case "/refresh":
                refreshView();
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

    // Phase 10 0B: all review panels carry data-fp-record-id instead of the
    // old per-kind data-fp-apply-* attribute family. The pop-out posts a
    // recordId to the parent, which looks up the live record and applies from
    // stored payload — no giant JSON blob in the DOM attribute, no separate
    // bind function per review kind.
    function bindReviewApplyButtons($scope) {
        $scope.filter("[data-fp-record-id]").add($scope.find("[data-fp-record-id]")).each(function () {
            var $panel = $(this);
            if ($panel.data("fp-review-apply-bound")) { return; }
            $panel.data("fp-review-apply-bound", true);
            var recordId = parseInt($panel.attr("data-fp-record-id"), 10);
            if (isNaN(recordId)) { return; }
            $panel.find(".fp-review-actions button.red-ui-button-primary").on("click", function () {
                var $btn = $(this);
                if ($btn.prop("disabled")) { return; }
                $btn.prop("disabled", true).text("Applying…");
                if (!window.opener || window.opener.closed) { return; }
                try {
                    window.opener.postMessage({ event: "applyByRecordId", recordId: recordId }, location.origin);
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
        bindSlashAutocomplete(el("#fp-prompt"));

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
                bindReviewApplyButtons(el("#fp-messages"));
                bindStopLoopButton(el("#fp-messages"));
                bindTabSwitching(el("#fp-messages"));
                bindDebugAttachButtons(el("#fp-messages"));
                scrollMessagesToBottom(true);
            } else if (data.event === "appendMessage") {
                el("#fp-messages").append(data.html);
                bindReviewApplyButtons(el("#fp-messages").children().last());
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
            bindSlashAutocomplete(el("#fp-prompt"));

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
                } else if (data.event === "applyByRecordId" && typeof data.recordId === "number") {
                    var rec = null;
                    for (var ri = 0; ri < messageRecords.length; ri++) {
                        if (messageRecords[ri].id === data.recordId) { rec = messageRecords[ri]; break; }
                    }
                    if (rec && rec.kind === "review" && rec.state !== "applied") {
                        var d0 = rec.sharedApplyData || {};
                        var nd0 = Array.isArray(d0.nodeDiffs) ? d0.nodeDiffs : [];
                        var rn0 = Array.isArray(d0.removeNodes) ? d0.removeNodes : [];
                        var nn0 = Array.isArray(d0.newNodes) ? d0.newNodes : [];
                        var nw0 = Array.isArray(d0.newWires) ? d0.newWires : [];
                        var ng0 = Array.isArray(d0.newGroups) ? d0.newGroups : [];
                        var eids0 = Array.isArray(d0.existingNodeIds) ? d0.existingNodeIds : [];
                        var idMap0 = {};
                        if (rec.subkind === "generate") {
                            importGeneratedFlow(rec.flow || [], null);
                        } else if (rec.subkind === "build-generate") {
                            importGeneratedFlow(rec.flow || [], function (importResult) {
                                startBuildLoop(rec.buildGoal || "", rec.flow || [], importResult);
                            });
                        } else if (rec.subkind === "modify") {
                            if (nn0.length) { idMap0 = applyInsertions(nn0, nw0, eids0) || {}; }
                            if (d0.hasMutations) { applyModifications(nd0, rn0, null, idMap0); }
                            if (ng0.length) { applyGroupChanges(ng0, idMap0); }
                        } else if (rec.subkind === "build-fix") {
                            if (nn0.length) { idMap0 = applyInsertions(nn0, nw0, eids0) || {}; }
                            applyBuildLoopFix(nd0, rn0, idMap0, !!d0.capReached);
                        }
                        rec.state = "applied";
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
