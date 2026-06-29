const http = require("http");
const path = require("path");
const createStorage = require("./lib/storage");
const provider = require("./lib/provider-openai-compatible");
const generationSystemPrompt = require("./lib/generation-system-prompt");
const documentSystemPrompt = require("./lib/document-system-prompt");
const modifySystemPrompt = require("./lib/modify-system-prompt");
const buildSystemPrompt = require("./lib/build-system-prompt");
const personaPrompt = require("./lib/persona-prompt");
const { buildCoreScript } = require("./lib/build-core-script");
const { extractJsonObject } = require("./lib/envelope");

module.exports = function flowPilotRuntime(RED) {
  const storage = createStorage(RED.settings.userDir);

  // ---------------------------------------------------------------------
  // Client-held conversation history. The frontend sends a capped
  // slice of the visible chat (role/content pairs) with each request; the
  // backend stays stateless and just folds it into the message list. Used
  // by both /chat and the generate/modify/document endpoints so the cap and
  // truncation-notice behaviour can't drift between the two paths.
  // ---------------------------------------------------------------------
  const HISTORY_TRUNCATION_NOTICE =
    "Note: earlier parts of this conversation were omitted to keep the " +
    "request size manageable. Continue naturally; if you need something " +
    "that may have been said earlier, ask the user.";

  // ---------------------------------------------------------------------
  // Tier-1 READ tools the model may call autonomously during
  // a chat turn. Their data (RED.nodes, live selection, debug buffer) lives
  // only in the editor, so each call is executed CLIENT-SIDE and its result
  // passed back through the same sanitizer as selection context — a tool
  // result can never carry a raw secret. WRITE actions are never exposed as
  // tools; they stay on the existing diff/review/apply envelope.
  // ---------------------------------------------------------------------
  const AGENT_READ_TOOLS = [
    {
      type: "function",
      function: {
        name: "read_node",
        description: "Read the sanitized configuration of a single node in " +
          "the current flow editor, identified by id or by name. Use this " +
          "when the user refers to a node that is not in the attached " +
          "selection.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "The node's id, if known." },
            name: { type: "string", description: "The node's display " +
              "name (\"name\" property), if id is not known." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_flows",
        description: "List the flow tabs AND subflow definitions in this " +
          "Node-RED instance, with their labels, type (\"tab\" or " +
          "\"subflow\"), enabled/disabled state, and node counts. Subflow " +
          "definitions are listed separately from flow tabs (they appear " +
          "as \"[Subflow] <name>\" in the editor). Use this to orient " +
          "yourself before searching, and to find a subflow's id so its " +
          "internal nodes can be looked up with search_flow/get_connections " +
          "using that id as flowId.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "search_flow",
        description: "Search nodes across the flow editor (including nodes " +
          "inside subflow definitions) by name and/or type substring " +
          "(case-insensitive). Also matches subflow definitions by name " +
          "(returned with type \"subflow\"), and subflow-instance nodes by " +
          "their subflow's name. Returns matching items' id, name, type, " +
          "and which flow tab (or subflow definition) they're on. Use this " +
          "to find a node or subflow when you don't have its id.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Substring to match " +
              "against node name or type. Leave empty to list all nodes " +
              "(combine with type or flowId to narrow it)." },
            type: { type: "string", description: "Optional node type " +
              "substring filter, e.g. \"http request\" or \"inject\"." },
            flowId: { type: "string", description: "Optional flow tab id " +
              "to restrict the search to." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_connections",
        description: "Get the wiring (connections) for a node, identified " +
          "by id, or — if no id is given — for the current selection, or " +
          "for the whole active flow tab if nothing is selected.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "The node's id. Omit to use " +
              "the current selection or active flow tab." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "read_debug",
        description: "Read recent messages from the Node-RED Debug sidebar " +
          "(already redacted of secret-shaped values). Use this for " +
          "troubleshooting runtime behaviour without the user manually " +
          "attaching debug output.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", description: "Max number of recent " +
              "messages to return (default 10, max 50)." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_selection",
        description: "Get the sanitized configuration and connections of " +
          "the node(s) currently selected in the editor, if any.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    }
  ];

  // Keep only well-formed { role: "user"|"assistant", content: <string> }
  // entries. Anything else (bad shapes, empty content, other roles) is
  // dropped rather than rejected outright — the history is advisory context,
  // not a contract.
  function sanitizeHistory(history) {
    if (!Array.isArray(history)) { return []; }
    return history
      .filter(function (m) {
        return m && (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" && m.content.trim();
      })
      .map(function (m) { return { role: m.role, content: m.content }; });
  }

  // ---------------------------------------------------------------------
  // Per-conversation transcript persistence. The frontend generates a
  // conversationId (kept for the life of the browser tab, reset on Clear
  // Chat) and sends it with every request; the backend appends each turn to
  // chats/<conversationId>.jsonl. Restricted to a safe filename charset —
  // anything else is treated as "no conversation id" (transcript logging is
  // best-effort, never blocks the request).
  // ---------------------------------------------------------------------
  function sanitizeConversationId(id) {
    if (typeof id !== "string") { return null; }
    const trimmed = id.trim();
    return /^[A-Za-z0-9_-]{1,128}$/.test(trimmed) ? trimmed : null;
  }

  function recordTranscriptTurn(conversationId, mode, userText, assistantText) {
    const id = sanitizeConversationId(conversationId);
    if (!id) { return; }

    const timestamp = new Date().toISOString();
    if (userText && String(userText).trim()) {
      storage.appendTranscript(id, { timestamp: timestamp, role: "user", mode: mode, content: String(userText) });
    }
    if (assistantText && String(assistantText).trim()) {
      storage.appendTranscript(id, { timestamp: timestamp, role: "assistant", mode: mode, content: String(assistantText) });
    }
  }

  // Pulls the natural-language part out of a generation-style result
  // ({question}/{prose}/{explanation, flow}) for transcript storage — the
  // same text the frontend renders as the assistant's chat bubble.
  function transcriptTextFromGenerationResult(result) {
    if (result.question) {
      return (result.explanation ? result.explanation + "\n\n" : "") + result.question;
    }
    if (result.prose) { return result.prose; }
    return result.explanation || "";
  }

  // ---------------------------------------------------------------------
  // Recall: user-triggered keyword search across OTHER conversations'
  // persisted transcripts (the current conversation is excluded; its own
  // live history is already in context). Deliberately simple
  // retrieval-injection: lowercase word-overlap scoring, no embeddings —
  // provider-agnostic and works the same for every model.
  // ---------------------------------------------------------------------
  const RECALL_STOPWORDS = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
    "her", "was", "one", "our", "out", "day", "get", "has", "him", "his",
    "how", "man", "new", "now", "old", "see", "two", "way", "who", "boy",
    "did", "its", "let", "put", "say", "she", "too", "use", "with", "this",
    "that", "what", "your", "from", "have", "more", "will", "would", "there",
    "their", "about", "into", "than", "then", "them", "these", "some",
    "could", "should", "please", "want", "like", "just", "make", "node",
    "nodes", "flow", "flowpilot"
  ]);

  function tokenize(text) {
    return String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(function (w) { return w.length >= 3 && !RECALL_STOPWORDS.has(w); });
  }

  // Pairs up consecutive { role: "user" } / { role: "assistant" } transcript
  // entries into one "exchange" so recall results read as a Q&A snippet
  // rather than two disconnected lines.
  function groupExchanges(entries) {
    const exchanges = [];
    let i = 0;
    while (i < entries.length) {
      const entry = entries[i];
      const next = entries[i + 1];
      if (entry.role === "user" && next && next.role === "assistant") {
        exchanges.push({ timestamp: entry.timestamp, mode: entry.mode, user: entry.content, assistant: next.content });
        i += 2;
      } else {
        exchanges.push({
          timestamp: entry.timestamp,
          mode: entry.mode,
          user: entry.role === "user" ? entry.content : null,
          assistant: entry.role === "assistant" ? entry.content : null
        });
        i += 1;
      }
    }
    return exchanges;
  }

  function searchTranscripts(query, excludeConversationId) {
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) { return []; }

    const matches = [];
    storage.listConversationIds().forEach(function (id) {
      if (id === excludeConversationId) { return; }
      groupExchanges(storage.readTranscript(id)).forEach(function (exchange) {
        const combinedTokens = tokenize((exchange.user || "") + " " + (exchange.assistant || ""));
        let score = 0;
        combinedTokens.forEach(function (t) { if (queryTokens.has(t)) { score++; } });
        if (score > 0) {
          matches.push({
            conversationId: id,
            timestamp: exchange.timestamp,
            mode: exchange.mode,
            user: exchange.user,
            assistant: exchange.assistant,
            score: score
          });
        }
      });
    });

    matches.sort(function (a, b) {
      if (b.score !== a.score) { return b.score - a.score; }
      return new Date(b.timestamp) - new Date(a.timestamp);
    });

    return matches.slice(0, 5);
  }

  // ---------------------------------------------------------------------
  // Palette awareness / "default nodes first": tell the model which
  // optional node packages are actually installed in this Node-RED
  // instance (beyond the always-available core nodes), so it can use
  // their node types when relevant and otherwise stick to core nodes
  // rather than proposing types that aren't installed.
  //
  // The node-level RED API passed to this module has no direct registry
  // lookup (no RED.nodes.getNodeList), so the node list is fetched via a
  // loopback call to Node-RED's own admin API (the same data the palette
  // sidebar uses) and cached briefly — the palette rarely changes, and
  // every chat/generate/document/modify request goes through
  // buildMessages, so this must stay cheap and synchronous.
  // ---------------------------------------------------------------------
  let installedNodesCache = null;
  let installedNodesCacheAt = 0;
  let installedNodesRefreshInFlight = false;
  const INSTALLED_NODES_CACHE_TTL_MS = 5 * 60 * 1000;

  function buildInstalledNodesContent(list) {
    if (!Array.isArray(list)) { return null; }

    const typesByModule = {};
    list.forEach(function (n) {
      if (!n || !n.enabled) { return; }
      if (n.module === "node-red" || n.module === "node-red-contrib-flowpilot") { return; }
      if (!n.module) { return; }
      if (!typesByModule[n.module]) { typesByModule[n.module] = new Set(); }
      (n.types || []).forEach(function (t) { typesByModule[n.module].add(t); });
    });

    const modules = Object.keys(typesByModule).filter(function (m) { return typesByModule[m].size > 0; });
    if (modules.length === 0) { return null; }

    let content = "This Node-RED instance's palette (Manage palette > Installed) " +
      "includes the following optional/non-default node packages, in addition " +
      "to Node-RED's core/built-in nodes:\n";
    modules.forEach(function (m) {
      content += "- " + m + ": " + Array.from(typesByModule[m]).join(", ") + "\n";
    });
    content += "\nIf the user asks what's in the palette, which node " +
      "packages/types are installed or available, or whether a specific node " +
      "type is installed, answer directly from this list — it's already " +
      "complete and current, so there's no need to call tools or inspect the " +
      "current flow to answer those questions.\n\n" +
      "When generating or modifying flows: default to Node-RED's core/built-in " +
      "nodes (inject, function, change, switch, http request, debug, etc.) " +
      "unless the user's request specifically calls for nodes from one of the " +
      "optional packages listed above. Only use a non-core node type if it's " +
      "listed above as installed — if a node type you'd otherwise want isn't " +
      "covered by core nodes or this list, say so and note that the user would " +
      "need to install it first, rather than proposing it as if it were already " +
      "available.";
    return content;
  }

  function refreshInstalledNodesCache() {
    if (installedNodesRefreshInFlight) { return; }
    installedNodesRefreshInFlight = true;

    const root = String(RED.settings.httpAdminRoot || "/").replace(/\/+$/, "");
    const req = http.get({
      host: "127.0.0.1",
      port: RED.settings.uiPort,
      path: root + "/nodes",
      headers: { Accept: "application/json" },
      timeout: 5000
    }, function (res) {
      const chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        installedNodesRefreshInFlight = false;
        if (res.statusCode !== 200) { return; }
        try {
          const list = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          installedNodesCache = buildInstalledNodesContent(list);
          installedNodesCacheAt = Date.now();
        } catch (err) { /* leave previous cache value in place */ }
      });
    });
    req.on("error", function () { installedNodesRefreshInFlight = false; });
    req.on("timeout", function () { req.destroy(); installedNodesRefreshInFlight = false; });
  }

  function describeInstalledNodes() {
    if (Date.now() - installedNodesCacheAt > INSTALLED_NODES_CACHE_TTL_MS) {
      refreshInstalledNodesCache();
    }
    return installedNodesCache;
  }

  // Chat-only: the user's base system prompt plus a freshly-generated
  // persona instruction (never baked into the persisted prompt itself, so
  // it always reflects the current personaIntensity slider value).
  // Generate/Document/Modify use their own mode-specific prompts and don't
  // call this — aviation flavor has no place in a structured JSON envelope.
  function buildChatSystemPrompt(settings) {
    const base = settings.systemPrompt || "You are FlowPilot, a Node-RED development assistant.";
    return base + "\n\n" + personaPrompt.buildPersonaInstruction(settings.personaIntensity);
  }

  // Assemble the final messages array in the one place both /chat and the
  // generate/modify/document endpoints use: system prompt, optional
  // installed-node-package note, optional truncation notice, history,
  // optional selection-context note, then the new user turn.
  function buildMessages(systemPrompt, history, historyTruncated, described, userPrompt) {
    const messages = [{ role: "system", content: systemPrompt }];
    const installedNodes = describeInstalledNodes();
    if (installedNodes) {
      messages.push({ role: "system", content: installedNodes });
    }
    if (historyTruncated) {
      messages.push({ role: "system", content: HISTORY_TRUNCATION_NOTICE });
    }
    (history || []).forEach(function (m) { messages.push(m); });
    if (described) {
      messages.push({ role: "system", content: described.content });
    }
    messages.push({ role: "user", content: userPrompt });
    return messages;
  }

  // ---------------------------------------------------------------------
  // Per-request performance fields for the audit log. Character
  // counts are always available (provider-agnostic); token usage is included
  // only when the provider returned a `usage` object. Kept separate from
  // appendAudit's other fields so every chat/generate/modify/document audit
  // entry reports the same shape.
  // ---------------------------------------------------------------------
  function performanceAuditFields(messages, content, providerResult) {
    const fields = {
      promptChars: (messages || []).reduce(function (sum, m) {
        return sum + (m && typeof m.content === "string" ? m.content.length : 0);
      }, 0),
      completionChars: (content || "").length
    };
    if (providerResult && providerResult.timing) { fields.timing = providerResult.timing; }
    if (providerResult && providerResult.usage) { fields.usage = providerResult.usage; }
    return fields;
  }

  // ---------------------------------------------------------------------
  // Shared helper: format selected-node context (sanitized by the frontend)
  // into a system-message string for the model, plus counts for audit logs.
  // Returns null when there's no selection — used by both /chat and
  // /generate so the two describe context identically and never drift.
  // ---------------------------------------------------------------------
  function describeSelectionContext(context, redactionEnabled) {
    const nodes = context && Array.isArray(context.nodes) ? context.nodes : [];
    const debugMessages = context && Array.isArray(context.debugMessages) ? context.debugMessages : [];
    if (nodes.length === 0 && debugMessages.length === 0) { return null; }

    const connections = (context && context.connections) ? context.connections : {};
    const edges = Array.isArray(connections.edges) ? connections.edges : [];
    const perNode = Array.isArray(connections.perNode) ? connections.perNode : [];
    const subFlowCount = (typeof connections.subFlowCount === "number") ? connections.subFlowCount : 0;

    // Node-RED's own credential store (config node "credentials" fields) is
    // dropped by the frontend's sanitizer unconditionally — that part never
    // changes. redactionEnabled only controls the SEPARATE secret-shaped-value
    // scrubbing (password/token/apiKey-looking fields elsewhere in a node's
    // config) — tell the model the truth about which protection is active.
    const credentialNote = redactionEnabled === false
      ? "Redaction is OFF for this session — context may contain sensitive " +
        "values the user chose to share (e.g. embedded API keys or tokens); " +
        "handle carefully and never volunteer them. Node-RED's separate " +
        "credential store is still never included. This is a setting in the " +
        "editor's FlowPilot Settings panel (Context & Safety section) — you " +
        "have no ability to read, change, or report on it beyond this note; " +
        "if the user wants to turn it back on, tell them to uncheck it there " +
        "(it requires re-confirming a type-to-confirm phrase, by design)."
      : "This is sanitized configuration; credentials are redacted.";

    let content = "";
    if (nodes.length > 0) {
      content += "The user has selected the following Node-RED nodes as context. " +
                credentialNote + "\n\n" +
                "Nodes:\n```json\n" + JSON.stringify(nodes) + "\n```";
      if (edges.length > 0) {
        content += "\n\nConnections — directed edges by node id (a node's wires " +
               "describe its OUTPUTS; one edge per output port; fromId/toId refer " +
               "to the \"id\" fields in Nodes above):\n```json\n" +
               JSON.stringify(edges) + "\n```";
        content += "\n\nPer-node wiring summary, with readable \"Name [type]\" " +
               "labels (inputs are reconstructed, since Node-RED nodes do not " +
               "store their own inputs; subFlow groups nodes into connected " +
               "sub-flows):\n```json\n" +
               JSON.stringify(perNode) + "\n```";
      }
      if (subFlowCount > 1) {
        content += "\n\nNote: the selection contains " + subFlowCount + " separate, " +
               "unconnected sub-flows (see each node's subFlow number). Treat " +
               "them as distinct unless the user says otherwise.";
      }
    }

    if (debugMessages.length > 0) {
      content += (content ? "\n\n" : "") +
             "The user attached recent Node-RED Debug sidebar output for " +
             "troubleshooting (runtime data, may be truncated):\n```json\n" +
             JSON.stringify(debugMessages) + "\n```";
    }

    return { content: content, nodeCount: nodes.length, connectionCount: edges.length, debugMessageCount: debugMessages.length };
  }

  // ---------------------------------------------------------------------
  // Shared helper: run a single-turn chat against the configured provider,
  // log it, and return the result. Used by both /chat and /test so the two
  // never drift apart. contextMode is recorded for the audit trail.
  // ---------------------------------------------------------------------
  // useTools: when true, the request offers AGENT_READ_TOOLS
  // with tool_choice "auto". If the provider responds with tool_calls instead
  // of a final message, we return early with `toolCalls` + the `messages`
  // array built so far (so the caller/frontend can append the tool results
  // and continue via /flowpilot/agent-step) — nothing is recorded to the
  // transcript yet, since this isn't the final answer for the turn.
  async function runChat(prompt, contextMode, context, history, historyTruncated, conversationId, useTools) {
    const settings = storage.getSettings();
    const activeProvider = storage.getActiveProvider(settings);

    const described = describeSelectionContext(context, settings.redactionEnabled);
    const messages = buildMessages(
      buildChatSystemPrompt(settings),
      history, historyTruncated, described, prompt
    );

    const chatOptions = useTools ? { tools: AGENT_READ_TOOLS, toolChoice: "auto" } : undefined;
    const result = await provider.chat(activeProvider, messages, chatOptions);

    if (result.toolCalls) {
      const perf = performanceAuditFields(messages, result.content, result);
      return { settings, activeProvider, result, perf, messages, toolCalls: result.toolCalls };
    }

    // The visible reply may end with a hidden <<<FLOWPILOT_DATA>>> block
    // carrying a suggestedAction/questionOptions — split it off before
    // logging or returning the message text.
    const split = splitChatDataBlock(result.content || "");

    recordTranscriptTurn(conversationId, "chat", prompt, split.message);

    const perf = performanceAuditFields(messages, result.content, result);

    return { settings, activeProvider, result, perf, chatMessage: split.message, chatData: split.data, messages };
  }

  // ---------------------------------------------------------------------
  // Streaming variant of /chat. Relays provider SSE chunks
  // to the browser as they arrive via res.write (Node-RED's httpAdmin routes
  // are plain Express, so chunked relay works the same as any Express app).
  // Generate/modify/document stay non-streamed (their JSON envelope can't be
  // validated until complete).
  // ---------------------------------------------------------------------
  async function runChatStream(req, res, prompt, context, history, historyTruncated, conversationId) {
    const settings = storage.getSettings();
    const activeProvider = storage.getActiveProvider(settings);

    const described = describeSelectionContext(context, settings.redactionEnabled);
    const messages = buildMessages(
      buildChatSystemPrompt(settings),
      history, historyTruncated, described, prompt
    );

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (typeof res.flushHeaders === "function") { res.flushHeaders(); }

    // As with the non-streaming path, the reply may end with a hidden
    // <<<FLOWPILOT_DATA>>> block. The splitter withholds the marker (and
    // anything after it) from the relayed deltas so it's never flashed to
    // the user, then we send its parsed contents as a separate `final`
    // event once the stream completes.
    const splitter = createChatDataStreamSplitter();
    let visibleText = "";

    let streamResult;
    try {
      streamResult = await provider.chatStream(activeProvider, messages, function (delta) {
        const visible = splitter.push(delta);
        if (visible) {
          visibleText += visible;
          res.write("data: " + JSON.stringify({ delta: visible }) + "\n\n");
        }
      });
    } catch (err) {
      res.write("data: " + JSON.stringify({ error: err.message }) + "\n\n");
      res.end();
      storage.appendAudit({ action: "chat_stream_error", error: err.message });
      return;
    }
    const full = streamResult.content;

    const finished = splitter.finish();
    if (finished.tail) {
      visibleText += finished.tail;
      res.write("data: " + JSON.stringify({ delta: finished.tail }) + "\n\n");
    }

    const final = {};
    const suggestedAction = extractSuggestedAction(finished.data);
    if (suggestedAction) { final.suggestedAction = suggestedAction; }
    const questionOptions = extractQuestionOptions(finished.data);
    if (questionOptions) { final.questionOptions = questionOptions; }
    if (final.suggestedAction || final.questionOptions) {
      res.write("data: " + JSON.stringify({ final: final }) + "\n\n");
    }

    res.write("data: [DONE]\n\n");
    res.end();

    storage.appendAudit(Object.assign({
      action: "chat_stream",
      providerName: activeProvider.providerName,
      baseUrl: activeProvider.baseUrl,
      model: activeProvider.model
    }, performanceAuditFields(messages, full, streamResult)));

    recordTranscriptTurn(conversationId, "chat", prompt, visibleText);
  }

  // ---- Settings: read --------------------------------------------------

  RED.httpAdmin.get("/flowpilot/settings", RED.auth.needsPermission("settings.read"), function (req, res) {
    try {
      res.json(storage.getSettings());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Settings: default system prompt (for "Reset to default") -------

  RED.httpAdmin.get("/flowpilot/default-system-prompt", RED.auth.needsPermission("settings.read"), function (req, res) {
    try {
      res.json({ systemPrompt: storage.getDefaultSystemPrompt() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Pop-out window (Phase 8.5 C1, v1 review-only) -------------------
  // Serves the shared renderer (flowpilot-core.js, the same script
  // flowpilot.html loads for the sidebar) plus its stylesheet and the
  // pop-out's own minimal page — mirroring core Node-RED's debug-node
  // pattern (RED.httpAdmin.get("/debug/view/view.html", ...) serving a
  // static lib/debug/view.html that loads the SAME debug-utils.js the
  // sidebar uses). Gated the same as every other FlowPilot route, unlike
  // NR5's own debug view route, which has no permission check at all.
  //
  // Phase 9 refactor: the SOURCE is now split into lib/core/*.js fragments
  // (see lib/build-core-script.js for why and how), but this route's
  // behavior is unchanged — it still serves one complete script at this
  // same URL, just assembled instead of read off disk verbatim.
  RED.httpAdmin.get("/flowpilot/core.js", RED.auth.needsPermission("settings.read"), function (req, res) {
    res.type("application/javascript").send(buildCoreScript());
  });

  RED.httpAdmin.get("/flowpilot/core.css", RED.auth.needsPermission("settings.read"), function (req, res) {
    res.sendFile(path.join(__dirname, "flowpilot-core.css"));
  });

  RED.httpAdmin.get("/flowpilot/popout/view.html", RED.auth.needsPermission("settings.read"), function (req, res) {
    res.sendFile(path.join(__dirname, "lib", "popout", "view.html"));
  });

  // ---- Settings: write -------------------------------------------------

  RED.httpAdmin.post("/flowpilot/settings", RED.auth.needsPermission("settings.write"), function (req, res) {
    try {
      const saved = storage.saveSettings(req.body || {});
      storage.appendAudit({
        action: "settings_saved",
        providerName: saved.providerName,
        baseUrl: saved.baseUrl,
        model: saved.model
      });
      res.json(saved);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Models: list models via the active provider's /v1/models -------
  // Always acts on the SAVED active provider (the frontend saves the form
  // first, mirroring Pre-flight check), and never errors out for a provider
  // that doesn't support /v1/models — see listModels().

  RED.httpAdmin.post("/flowpilot/models", RED.auth.needsPermission("settings.write"), async function (req, res) {
    try {
      const settings = storage.getSettings();
      const activeProvider = storage.getActiveProvider(settings);
      const result = await provider.listModels(activeProvider);
      storage.appendAudit({
        action: "list_models",
        providerName: activeProvider.providerName,
        baseUrl: activeProvider.baseUrl,
        modelCount: result.models.length,
        error: result.error || null
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Chat: the real prompt endpoint ----------------------------------
  // Handles message history, flow context, and streaming. Kept separate
  // from /test, which stays a minimal connectivity check.

  RED.httpAdmin.post("/flowpilot/chat", RED.auth.needsPermission("settings.write"), async function (req, res) {
    const prompt = req.body && req.body.prompt;

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: "A prompt is required." });
    }

    const history = sanitizeHistory(req.body.history);
    const historyTruncated = !!req.body.historyTruncated;

    if (req.body.stream) {
      try {
        await runChatStream(req, res, prompt, req.body.context, history, historyTruncated, req.body.conversationId);
      } catch (err) {
        storage.appendAudit({ action: "chat_stream_error", error: err.message });
        if (!res.headersSent) {
          res.status(500).json({ error: err.message });
        } else {
          try { res.end(); } catch (e) { /* already closed */ }
        }
      }
      return;
    }

    try {
      const useTools = !!req.body.tools;
      const { activeProvider, result, perf, chatMessage, chatData, messages, toolCalls } =
        await runChat(prompt, "selected-nodes", req.body.context, history, historyTruncated, req.body.conversationId, useTools);

      storage.appendAudit(Object.assign({
        action: "chat",
        providerName: activeProvider.providerName,
        baseUrl: activeProvider.baseUrl,
        model: activeProvider.model,
        toolCallCount: toolCalls ? toolCalls.length : 0
      }, perf));

      if (toolCalls) {
        return res.json({ toolCalls: toolCalls, messages: messages, content: result.content || null, usage: result.usage || null });
      }

      const body = {
        message: chatMessage || "[No assistant message returned by provider]",
        raw: result.raw ? "[raw response captured]" : null,
        usage: result.usage || null
      };
      const suggestedAction = extractSuggestedAction(chatData);
      if (suggestedAction) { body.suggestedAction = suggestedAction; }
      const questionOptions = extractQuestionOptions(chatData);
      if (questionOptions) { body.questionOptions = questionOptions; }
      res.json(body);
    } catch (err) {
      storage.appendAudit({ action: "chat_error", error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Agent step: continue a tool-calling loop --------------------------
  // The frontend owns the loop: after executing any tool_calls returned by
  // /flowpilot/{chat,generate,document,modify} (tools:true) or a prior
  // /agent-step against RED.nodes, it appends { role: "assistant",
  // tool_calls } and { role: "tool", ... } result messages and posts the
  // full array back here. Stateless — just another provider.chat call with
  // the same tool definitions.
  //
  // `mode` ("chat" | "generate" | "document" | "modify", default "chat")
  // controls how a FINAL (non-tool-call) response is interpreted:
  //  - "chat": split off the <<<FLOWPILOT_DATA>>> block, same as /chat.
  //  - "generate"/"document"/"modify" (Step 4, explore-then-propose): parse
  //    the { explanation, flow|changes, ... } envelope via
  //    processGenerationContent + finalizeSimpleGeneration/
  //    finalizeModifyResult — the SAME validate step the non-streaming
  //    routes use, so a tool-using turn still ends in the reviewed envelope.
  //    `context` (for describeSelectionContext / modify's originalNodes) and
  //    `prompt` (for transcript recording) are passed through from the
  //    initial request.
  RED.httpAdmin.post("/flowpilot/agent-step", RED.auth.needsPermission("settings.write"), async function (req, res) {
    const messages = req.body && req.body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required." });
    }
    const mode = req.body.mode || "chat";

    try {
      const settings = storage.getSettings();
      const activeProvider = storage.getActiveProvider(settings);
      const result = await provider.chat(activeProvider, messages, { tools: AGENT_READ_TOOLS, toolChoice: "auto" });

      storage.appendAudit(Object.assign({
        action: "agent_step",
        mode: mode,
        providerName: activeProvider.providerName,
        baseUrl: activeProvider.baseUrl,
        model: activeProvider.model,
        toolCallCount: result.toolCalls ? result.toolCalls.length : 0
      }, performanceAuditFields(messages, result.content, result)));

      if (result.toolCalls) {
        return res.json({ toolCalls: result.toolCalls, content: result.content || null, usage: result.usage || null });
      }

      if (mode !== "chat") {
        const context = req.body.context;
        const described = describeSelectionContext(context, settings.redactionEnabled);
        const generated = processGenerationContent(result.content || "", result, messages, mode, described, activeProvider);
        recordTranscriptTurn(req.body.conversationId, mode, req.body.prompt || null, transcriptTextFromGenerationResult(generated));
        const finalize = (mode === "modify")
          ? function (r) { return finalizeModifyResult(r, (context && Array.isArray(context.nodes)) ? context.nodes : []); }
          : finalizeSimpleGeneration;
        const { status, body } = finalize(generated);
        return res.status(status).json(body);
      }

      const split = splitChatDataBlock(result.content || "");
      recordTranscriptTurn(req.body.conversationId, "chat", null, split.message);

      const body = { message: split.message || "[No assistant message returned by provider]", usage: result.usage || null };
      const suggestedAction = extractSuggestedAction(split.data);
      if (suggestedAction) { body.suggestedAction = suggestedAction; }
      const questionOptions = extractQuestionOptions(split.data);
      if (questionOptions) { body.questionOptions = questionOptions; }
      res.json(body);
    } catch (err) {
      sendGenerationError(res, mode + "_agent_step", err);
    }
  });

  // ---- Recall: search past conversations' transcripts -------------------
  // User-triggered, not automatic: the frontend's "Recall" button sends the
  // current prompt-box text as the query. Results are returned for display
  // only — nothing is injected into the model's context.

  RED.httpAdmin.post("/flowpilot/recall", RED.auth.needsPermission("settings.write"), function (req, res) {
    const query = req.body && req.body.query;
    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: "Enter something to search for first." });
    }

    try {
      const results = searchTranscripts(String(query).trim(), sanitizeConversationId(req.body.conversationId));
      storage.appendAudit({ action: "recall", resultCount: results.length });
      res.json({ results: results });
    } catch (err) {
      storage.appendAudit({ action: "recall_error", error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------
  // Conversation list ("Flight log"), layered over the per-conversation
  // transcript files. Summaries are read-only and derived on the fly — title is the
  // first user message, trimmed; full transcripts are fetched on demand.
  // ---------------------------------------------------------------------
  function summarizeTranscript(id) {
    const entries = storage.readTranscript(id);
    if (!entries.length) { return null; }
    const firstUser = entries.find(function (e) { return e.role === "user"; });
    const last = entries[entries.length - 1];
    return {
      id: id,
      title: firstUser ? String(firstUser.content).trim().slice(0, 80) : "(untitled)",
      lastTimestamp: last.timestamp,
      exchangeCount: groupExchanges(entries).length
    };
  }

  RED.httpAdmin.get("/flowpilot/conversations", RED.auth.needsPermission("settings.read"), function (req, res) {
    try {
      const conversations = storage.listConversationIds()
        .map(summarizeTranscript)
        .filter(Boolean)
        .sort(function (a, b) { return new Date(b.lastTimestamp) - new Date(a.lastTimestamp); });
      res.json({ conversations: conversations });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  RED.httpAdmin.get("/flowpilot/conversations/:id", RED.auth.needsPermission("settings.read"), function (req, res) {
    const id = sanitizeConversationId(req.params.id);
    if (!id) { return res.status(400).json({ error: "Invalid conversation id." }); }
    try {
      res.json({ id: id, messages: storage.readTranscript(id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  RED.httpAdmin.delete("/flowpilot/conversations/:id", RED.auth.needsPermission("settings.write"), function (req, res) {
    const id = sanitizeConversationId(req.params.id);
    if (!id) { return res.status(400).json({ error: "Invalid conversation id." }); }
    try {
      storage.deleteTranscript(id);
      storage.appendAudit({ action: "conversation_delete", conversationId: id });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  RED.httpAdmin.delete("/flowpilot/conversations", RED.auth.needsPermission("settings.write"), function (req, res) {
    try {
      const ids = storage.listConversationIds();
      ids.forEach(function (id) { storage.deleteTranscript(id); });
      storage.appendAudit({ action: "conversation_delete_all", count: ids.length });
      res.json({ ok: true, count: ids.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Test: connectivity check only -----------------------------------
  // Deliberately minimal. Confirms "can I reach the provider and get a
  // reply at all." Never depends on chat history or flow context.

  RED.httpAdmin.post("/flowpilot/test", RED.auth.needsPermission("settings.write"), async function (req, res) {
    const prompt = (req.body && req.body.prompt) || "Say hello from FlowPilot.";

    try {
      const { settings, activeProvider, result, perf, chatMessage } = await runChat(prompt, "connectivity-test");

      storage.appendAudit(Object.assign({
        action: "chat_test",
        providerName: activeProvider.providerName,
        baseUrl: activeProvider.baseUrl,
        model: activeProvider.model
      }, perf));

      // Capability probe — connectivity already succeeded above, so a
      // probe failure here just means "no tool support", not a /test failure.
      // Persist the result on the provider profile for the agentic tool-calling path.
      const probe = await provider.probeTools(activeProvider);
      storage.appendAudit({
        action: "capability_probe",
        providerName: activeProvider.providerName,
        baseUrl: activeProvider.baseUrl,
        model: activeProvider.model,
        supportsTools: probe.supportsTools
      });

      const updatedProviders = (settings.providers || []).map(function (p) {
        return p.id === activeProvider.id
          ? Object.assign({}, p, { supportsTools: probe.supportsTools, toolsProbedAt: new Date().toISOString() })
          : p;
      });
      storage.saveSettings(Object.assign({}, settings, { providers: updatedProviders }));

      res.json({
        message: chatMessage || "[No assistant message returned by provider]",
        raw: result.raw ? "[raw response captured]" : null,
        capability: {
          supportsTools: probe.supportsTools,
          label: probe.supportsTools
            ? "✓ Connected · ✓ Supports tools"
            : "✓ Connected · ⚠ No tool support — compatibility mode"
        }
      });
    } catch (err) {
      storage.appendAudit({ action: "chat_test_error", error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Generate: produce an importable flow fragment --------------------
  // Uses the generation system prompt and expects the model to return a single
  // JSON object { explanation, flow }. This first cut does NOT validate node
  // types or wire integrity yet (that's the next chunk) — it returns the parsed
  // envelope so the frontend can display it for review.

  // ---------------------------------------------------------------------
  // Shared helper: resolve the active provider and assemble the messages
  // array for a generation-style request (generate/document/modify). Split
  // out from runFlowGeneration so the streaming variant can build the
  // same request and swap provider.chat for provider.chatStream.
  // ---------------------------------------------------------------------
  function buildGenerationContext(systemPrompt, userPrompt, context, history, historyTruncated) {
    const settings = storage.getSettings();
    const activeProvider = storage.getActiveProvider(settings);
    const described = describeSelectionContext(context, settings.redactionEnabled);
    // Persona applies to the "explanation" field only (a real hand-off/
    // transition moment — "here's the flow I built for you") — never to
    // node names, ids, or any structural JSON, which stays exactly as each
    // mode's own system prompt above already specifies.
    const personaInstruction = personaPrompt.buildPersonaInstruction(settings.personaIntensity, { scope: "explanation" });
    const messages = buildMessages(systemPrompt + "\n\n" + personaInstruction, history, historyTruncated, described, userPrompt);
    return { activeProvider, described, messages };
  }

  // ---------------------------------------------------------------------
  // Pull an optional "suggestedAction" (action chip) out of a
  // parsed envelope. Validated but non-critical — a malformed or missing
  // suggestion is just dropped (returns null), never an error, since chips
  // are an additive hint on top of the real response.
  //   { mode: "generate"|"document"|"modify"|"chat", prompt: "...", selectionHint?: "..." }
  // ---------------------------------------------------------------------
  function extractSuggestedAction(parsed) {
    const sa = parsed && parsed.suggestedAction;
    if (!sa || typeof sa !== "object") { return null; }
    if (["generate", "document", "modify", "chat"].indexOf(sa.mode) === -1) { return null; }
    if (typeof sa.prompt !== "string" || !sa.prompt.trim()) { return null; }

    const result = { mode: sa.mode, prompt: sa.prompt.trim() };
    if (typeof sa.selectionHint === "string" && sa.selectionHint.trim()) {
      result.selectionHint = sa.selectionHint.trim();
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // Pull an optional "questionOptions" (quick-reply buttons for a clarifying
  // question) out of a parsed envelope: 2-4 short non-empty strings. The
  // frontend renders these as one-click buttons plus a free-text "Other";
  // anything malformed or out of range is dropped (returns null), never an
  // error — same additive-hint treatment as extractSuggestedAction.
  // ---------------------------------------------------------------------
  function extractQuestionOptions(parsed) {
    const opts = parsed && parsed.questionOptions;
    if (!Array.isArray(opts)) { return null; }
    const cleaned = opts
      .map(function (o) { return typeof o === "string" ? o.trim() : ""; })
      .filter(Boolean);
    if (cleaned.length < 2 || cleaned.length > 4) { return null; }
    return cleaned;
  }

  // ---------------------------------------------------------------------
  // Chat (free-text) responses can end with an optional, hidden data block —
  // a marker line followed by a single JSON object carrying a
  // "suggestedAction" and/or "questionOptions" (see default-system-prompt.js).
  // Unlike the generate/modify/document envelopes, the visible chat reply is
  // plain prose, so this block is split off rather than being the whole
  // response. Used by the non-streaming /chat path; streaming uses
  // createChatDataStreamSplitter below so the marker/JSON are never flashed
  // to the user mid-stream.
  // ---------------------------------------------------------------------
  const CHAT_DATA_MARKER = "<<<FLOWPILOT_DATA>>>";

  function splitChatDataBlock(content) {
    const text = String(content || "");
    const idx = text.indexOf(CHAT_DATA_MARKER);
    if (idx === -1) { return { message: text, data: null }; }

    const message = text.slice(0, idx).replace(/\s+$/, "");
    const jsonStr = text.slice(idx + CHAT_DATA_MARKER.length).trim();
    let data = null;
    try { data = JSON.parse(jsonStr); } catch (e) { data = null; }
    return { message: message, data: data };
  }

  // Streaming counterpart of splitChatDataBlock: buffers just enough of the
  // tail to detect CHAT_DATA_MARKER even if it's split across provider
  // chunks, without delaying normal text. push(delta) returns the portion of
  // `delta` (plus any previously-held tail) that's safe to display now —
  // possibly "". Once the marker is seen, all further input is buffered as
  // the JSON data block instead of being displayed. finish() returns any
  // held-back text that turned out NOT to be part of the marker (a false
  // positive at end of stream) plus the parsed data block, if any.
  // ---------------------------------------------------------------------
  function createChatDataStreamSplitter() {
    let held = "";
    let inData = false;
    let dataBuf = "";

    function push(delta) {
      if (inData) { dataBuf += delta; return ""; }

      const combined = held + delta;
      const idx = combined.indexOf(CHAT_DATA_MARKER);
      if (idx !== -1) {
        inData = true;
        dataBuf = combined.slice(idx + CHAT_DATA_MARKER.length);
        held = "";
        return combined.slice(0, idx);
      }

      // No full marker yet — check whether the tail of `combined` is a
      // prefix of the marker (i.e. the marker may be split across chunks)
      // and hold that part back.
      const maxOverlap = Math.min(combined.length, CHAT_DATA_MARKER.length - 1);
      let overlap = 0;
      for (let len = maxOverlap; len >= 1; len--) {
        if (combined.slice(-len) === CHAT_DATA_MARKER.slice(0, len)) { overlap = len; break; }
      }
      held = overlap ? combined.slice(-overlap) : "";
      return overlap ? combined.slice(0, -overlap) : combined;
    }

    function finish() {
      const tail = held;
      held = "";
      let data = null;
      if (inData) {
        try { data = JSON.parse(dataBuf.trim()); } catch (e) { data = null; }
      }
      return { tail: tail, data: data };
    }

    return { push: push, finish: finish };
  }

  // ---------------------------------------------------------------------
  // Shared helper: parse, validate and audit a completed provider response
  // for a generation-style request, returning { question } / { prose } /
  // { explanation, flow, newNodes, newWires }, each optionally carrying a
  // `suggestedAction` (action chip). Used by both the
  // non-streaming and streaming paths, which differ only in how
  // `content` and `providerResult` were obtained (provider.chat vs
  // provider.chatStream). Throws an Error with .status and (when applicable)
  // .raw for the route to relay.
  // ---------------------------------------------------------------------
  function processGenerationContent(content, providerResult, messages, auditAction, described, activeProvider) {
    const perf = performanceAuditFields(messages, content, providerResult);

    // Mode-mismatch redirect: the model may respond in plain prose —
    // addressing a request that doesn't belong in generate/document/modify —
    // followed by a hidden <<<FLOWPILOT_DATA>>> block suggesting a mode
    // switch, exactly like Chat. Detect this BEFORE extractJsonObject, since
    // it would otherwise grab the "{" inside the data block and treat it as
    // a broken envelope.
    let envelopeParsed;
    if (content.indexOf(CHAT_DATA_MARKER) !== -1) {
      const preSplit = splitChatDataBlock(content);
      const proseMessage = preSplit.message.trim();
      if (proseMessage && proseMessage[0] !== "{") {
        storage.appendAudit(Object.assign({ action: auditAction + "_prose" }, perf));
        const proseResult = { prose: proseMessage };
        if (preSplit.data) {
          const proseAction = extractSuggestedAction(preSplit.data);
          if (proseAction) { proseResult.suggestedAction = proseAction; }
          const proseOptions = extractQuestionOptions(preSplit.data);
          if (proseOptions) { proseResult.questionOptions = proseOptions; }
        }
        return proseResult;
      }
      // The message part is itself the JSON envelope (a full flow/changes/
      // question result), with the data block appending an additive
      // suggestedAction/questionOptions hint. Parse just the envelope (not
      // the marker/data suffix, which extractJsonObject can't handle) and
      // merge the hint in, then fall through to the normal envelope
      // handling below so modify/question/flow shapes are still validated
      // and audited correctly.
      try {
        envelopeParsed = JSON.parse(proseMessage);
      } catch (e) {
        // Not a standalone envelope after all — fall through to
        // extractJsonObject(content) below.
      }
      if (envelopeParsed && preSplit.data) {
        if (envelopeParsed.suggestedAction === undefined) { envelopeParsed.suggestedAction = preSplit.data.suggestedAction; }
        if (envelopeParsed.questionOptions === undefined) { envelopeParsed.questionOptions = preSplit.data.questionOptions; }
      }
    }

    let parsed = envelopeParsed;
    if (!parsed) {
      try {
        parsed = extractJsonObject(content);
      } catch (parseErr) {
        // A response with no JSON envelope at all, but non-empty prose
        // (analysis, an answer, a question without the envelope) is tolerated —
        // render it as a normal assistant message and keep the action armed.
        // Errors stay reserved for empty responses or a found-but-broken {...}.
        if (parseErr.noJsonFound && content.trim()) {
          storage.appendAudit(Object.assign({ action: auditAction + "_prose" }, perf));
          // Mode-mismatch redirect: a prose reply may carry the same hidden
          // <<<FLOWPILOT_DATA>>> block as Chat, suggesting a mode switch (e.g.
          // "chat" when the request was actually a question, not a
          // generate/modify/document instruction).
          const split = splitChatDataBlock(content.trim());
          const proseResult = { prose: split.message || content.trim() };
          if (split.data) {
            const proseAction = extractSuggestedAction(split.data);
            if (proseAction) { proseResult.suggestedAction = proseAction; }
            const proseOptions = extractQuestionOptions(split.data);
            if (proseOptions) { proseResult.questionOptions = proseOptions; }
          }
          return proseResult;
        }
        storage.appendAudit(Object.assign({ action: auditAction + "_parse_error", error: parseErr.message }, perf));
        const err = new Error("Could not parse a flow from the response: " + parseErr.message);
        err.status = 422;
        err.raw = content;
        throw err;
      }
    }

    // Clarifying-question envelope. The model may ask ONE
    // follow-up question instead of producing a flow when the request is too
    // ambiguous to act on. The frontend renders the question as a normal
    // assistant message and keeps the Execute action armed for the answer.
    if (typeof parsed.question === "string" && parsed.question.trim() &&
        (!Array.isArray(parsed.flow) || parsed.flow.length === 0)) {
      storage.appendAudit(Object.assign({ action: auditAction + "_question" }, perf));
      const questionResult = { question: parsed.question, explanation: parsed.explanation || "" };
      const questionAction = extractSuggestedAction(parsed);
      if (questionAction) { questionResult.suggestedAction = questionAction; }
      const questionOptions = extractQuestionOptions(parsed);
      if (questionOptions) { questionResult.questionOptions = questionOptions; }
      return questionResult;
    }

    // /modify returns a sparse "changes" envelope (patches against the
    // selection) instead of a full "flow" array. "changes", "newNodes",
    // "newWires" and "removeNodes" are all individually optional — a no-op
    // modify can legitimately omit all of them — but the envelope must
    // contain at least one of those keys or a non-empty "explanation",
    // otherwise it's not recognizable as a modify response at all.
    if (auditAction === "modify") {
      const hasModifyShape = ("changes" in parsed) || ("newNodes" in parsed) ||
        ("newWires" in parsed) || ("removeNodes" in parsed) || ("newGroups" in parsed) ||
        (typeof parsed.explanation === "string" && parsed.explanation.trim());
      if (!hasModifyShape) {
        const err = new Error("The response did not contain any recognizable modify fields.");
        err.status = 422;
        err.raw = content;
        throw err;
      }

      const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
      const newNodes = Array.isArray(parsed.newNodes) ? parsed.newNodes : [];
      const newWires = Array.isArray(parsed.newWires) ? parsed.newWires : [];
      const removeNodes = Array.isArray(parsed.removeNodes) ? parsed.removeNodes : [];
      // Bug found live: this object is what finalizeModifyResult later reads
      // as "result" — but it never copied parsed.newGroups onto itself, so
      // even a model correctly using the top-level "newGroups" field (per
      // the prompt) had it silently dropped right here, before
      // finalizeModifyResult's own newGroups handling (fixed earlier) ever
      // saw it. Only a stray type:"group" entry inside newNodes survived,
      // since newNodes itself is copied through.
      const newGroups = Array.isArray(parsed.newGroups) ? parsed.newGroups : [];

      storage.appendAudit(Object.assign({
        action: auditAction,
        providerName: activeProvider.providerName,
        baseUrl: activeProvider.baseUrl,
        model: activeProvider.model,
        changeCount: changes.length,
        newNodeCount: newNodes.length,
        newWireCount: newWires.length,
        removeNodeCount: removeNodes.length,
        newGroupCount: newGroups.length,
        contextNodeCount: described ? described.nodeCount : 0,
        contextConnectionCount: described ? described.connectionCount : 0
      }, perf));

      const modifyResult = {
        explanation: parsed.explanation || "",
        changes: changes,
        newNodes: newNodes,
        newWires: newWires,
        removeNodes: removeNodes,
        newGroups: newGroups
      };
      const modifyAction = extractSuggestedAction(parsed);
      if (modifyAction) { modifyResult.suggestedAction = modifyAction; }
      return modifyResult;
    }

    const flow = Array.isArray(parsed.flow) ? parsed.flow : null;
    if (!flow) {
      const err = new Error("The response did not contain a 'flow' array.");
      err.status = 422;
      err.raw = content;
      throw err;
    }

    storage.appendAudit(Object.assign({
      action: auditAction,
      providerName: activeProvider.providerName,
      baseUrl: activeProvider.baseUrl,
      model: activeProvider.model,
      nodeCount: flow.length,
      contextNodeCount: described ? described.nodeCount : 0,
      contextConnectionCount: described ? described.connectionCount : 0
    }, perf));

    const flowResult = {
      explanation: parsed.explanation || "",
      flow: flow,
      newNodes: Array.isArray(parsed.newNodes) ? parsed.newNodes : [],
      newWires: Array.isArray(parsed.newWires) ? parsed.newWires : []
    };
    const flowAction = extractSuggestedAction(parsed);
    if (flowAction) { flowResult.suggestedAction = flowAction; }
    return flowResult;
  }

  // ---------------------------------------------------------------------
  // Shared helper: ask the model for a { explanation, flow } envelope using
  // the given system prompt (+ optional selection context), parse and
  // validate it, audit the result, and return { explanation, flow }. Used by
  // both /generate and /document — they differ only in system prompt, audit
  // action name, and how the route validates its inputs beforehand. Throws
  // an Error with .status and (when applicable) .raw for the route to relay.
  // ---------------------------------------------------------------------
  // Step 4: useTools offers AGENT_READ_TOOLS (explore-then-propose). If the
  // provider responds with tool_calls instead of a final envelope, returns
  // early with { toolCalls, messages, content, usage } — same shape as
  // runChat's early return — so the route can hand it to the frontend
  // without running processGenerationContent yet.
  async function runFlowGeneration(systemPrompt, auditAction, userPrompt, context, history, historyTruncated, useTools) {
    const { activeProvider, described, messages } = buildGenerationContext(systemPrompt, userPrompt, context, history, historyTruncated);
    const chatOptions = useTools ? { tools: AGENT_READ_TOOLS, toolChoice: "auto" } : undefined;
    const result = await provider.chat(activeProvider, messages, chatOptions);
    if (result.toolCalls) {
      return { toolCalls: result.toolCalls, messages: messages, content: result.content || null, usage: result.usage || null };
    }
    return processGenerationContent(result.content || "", result, messages, auditAction, described, activeProvider);
  }

  // ---------------------------------------------------------------------
  // Streaming variant of runFlowGeneration. Relays each provider delta
  // via onDelta as it arrives, then runs the SAME parse/validate/audit logic
  // as the non-streaming path once the full response is in. The frontend
  // uses onDelta to progressively render the envelope's "explanation" field
  // while the rest of the JSON (the "flow" array etc.) is buffered until
  // this resolves.
  // ---------------------------------------------------------------------
  async function runFlowGenerationStream(systemPrompt, auditAction, userPrompt, context, history, historyTruncated, onDelta) {
    const { activeProvider, described, messages } = buildGenerationContext(systemPrompt, userPrompt, context, history, historyTruncated);
    const result = await provider.chatStream(activeProvider, messages, onDelta);
    return processGenerationContent(result.content || "", result, messages, auditAction, described, activeProvider);
  }

  // Relays a runFlowGeneration error to the client with the right status,
  // falling back to 500 for anything that didn't set .status itself.
  function sendGenerationError(res, auditAction, err) {
    if (err && err.status) {
      const body = { error: err.message };
      if (err.raw) { body.raw = err.raw; }
      return res.status(err.status).json(body);
    }
    storage.appendAudit({ action: auditAction + "_error", error: err.message });
    res.status(500).json({ error: err.message });
  }

  // ---------------------------------------------------------------------
  // Turn a runFlowGeneration(Stream) result into a { status, body }
  // response for /generate and /document — they share identical
  // post-processing (question/prose passthrough, else the envelope as-is).
  // Used by both the non-streaming route (res.status(status).json(body)) and
  // the streaming route (relayed as the final SSE event).
  // ---------------------------------------------------------------------
  function finalizeSimpleGeneration(result) {
    if (result.question) {
      const body = { explanation: result.explanation, question: result.question, flow: null };
      if (result.suggestedAction) { body.suggestedAction = result.suggestedAction; }
      if (result.questionOptions) { body.questionOptions = result.questionOptions; }
      return { status: 200, body: body };
    }
    if (result.prose) {
      const proseBody = { explanation: result.prose, prose: true, flow: null };
      if (result.suggestedAction) { proseBody.suggestedAction = result.suggestedAction; }
      if (result.questionOptions) { proseBody.questionOptions = result.questionOptions; }
      return { status: 200, body: proseBody };
    }
    return { status: 200, body: result };
  }

  // ---------------------------------------------------------------------
  // Turn a runFlowGeneration(Stream) result into a { status, body }
  // response for /modify — question/prose passthrough, else reconstruct the
  // full "flow" by applying the model's sparse "changes" patches on top of
  // the original selection (the model returns only
  // { id, set: {...changed props} } for nodes it actually touches, instead
  // of repeating every node's full JSON). Also runs the
  // removeNodes/newNodes/newWires validation that previously lived inline in
  // the /flowpilot/modify route handler. Used by both the non-streaming and
  // streaming routes.
  // ---------------------------------------------------------------------
  function finalizeModifyResult(result, originalNodes) {
    if (result.question) {
      const questionBody = { explanation: result.explanation, question: result.question, flow: null };
      if (result.suggestedAction) { questionBody.suggestedAction = result.suggestedAction; }
      if (result.questionOptions) { questionBody.questionOptions = result.questionOptions; }
      return { status: 200, body: questionBody };
    }
    if (result.prose) {
      const proseBody = { explanation: result.prose, prose: true, flow: null };
      if (result.suggestedAction) { proseBody.suggestedAction = result.suggestedAction; }
      if (result.questionOptions) { proseBody.questionOptions = result.questionOptions; }
      return { status: 200, body: proseBody };
    }

    const originalIds = new Set(originalNodes.map(function (n) { return n.id; }));

    // Group ids the selection is actually inside (sanitizeNode resolves
    // each context node's group membership into a `group: {id, name}`
    // field — Phase 8.5 C2). A "changes" patch may target one of THESE
    // group ids too (e.g. to rename it) even though the group itself
    // isn't a member of originalIds — the user selected something
    // relevant to it, same spirit as selecting a node lets you patch it.
    const contextGroupIds = new Set(
      originalNodes.map(function (n) { return n.group && n.group.id; }).filter(Boolean)
    );

    // Validate removeNodes: all ids must be in the original selection.
    const removeNodes = Array.isArray(result.removeNodes) ? result.removeNodes : [];
    if (removeNodes.length > 0) {
      const badRemove = removeNodes.filter(function (id) { return !originalIds.has(String(id)); });
      if (badRemove.length > 0) {
        storage.appendAudit({ action: "modify_remove_ref_error", ids: badRemove });
        return {
          status: 422,
          body: {
            error: "removeNodes contains id(s) not in the selection: " + badRemove.join(", "),
            raw: JSON.stringify(result)
          }
        };
      }
    }
    const removeSet = new Set(removeNodes.map(String));

    // "changes" is a sparse array of { id, set } patches against the
    // original selection. A node with no entry here is kept exactly as-is —
    // unlike the old full-"flow" format, omission can only mean "unchanged",
    // never "delete", so there's no "implicit removal" failure mode anymore.
    const changes = Array.isArray(result.changes) ? result.changes : [];
    const changeIds = changes
      .map(function (c) { return c && c.id; })
      .filter(function (id) { return id !== undefined && id !== null; });

    // Validate that changes contains no hallucinated ids, and that no id is
    // both patched and marked for removal. A group id from contextGroupIds
    // is allowed here too (see above) even though it's not in originalIds.
    const extraIds = changeIds.filter(function (id) { return !originalIds.has(String(id)) && !contextGroupIds.has(String(id)); });
    const wronglyRemovedIds = changeIds.filter(function (id) { return removeSet.has(String(id)); });

    const idProblems = [];
    if (extraIds.length) { idProblems.push("unexpected id(s) in changes: " + extraIds.join(", ")); }
    if (wronglyRemovedIds.length) { idProblems.push("id(s) in both changes and removeNodes: " + wronglyRemovedIds.join(", ")); }

    if (idProblems.length > 0) {
      storage.appendAudit({ action: "modify_id_mismatch", problems: idProblems });
      return {
        status: 422,
        body: {
          error: "The model returned inconsistent node ids (" + idProblems.join("; ") + "). Try again.",
          raw: JSON.stringify(changes)
        }
      };
    }

    // Each patch's "set" is shallow-merged onto a copy of the original node.
    // "id", "x", "y", "z" can never move via a patch — strip them
    // defensively even though the prompt already forbids them.
    const patchById = {};
    changes.forEach(function (c) {
      const set = (c.set && typeof c.set === "object") ? c.set : {};
      const clean = Object.assign({}, set);
      delete clean.id;
      delete clean.x;
      delete clean.y;
      delete clean.z;
      patchById[String(c.id)] = clean;
    });

    const flow = originalNodes
      .filter(function (n) { return !removeSet.has(String(n.id)); })
      .map(function (n) {
        const patch = patchById[String(n.id)];
        return patch ? Object.assign({}, n, patch) : n;
      });

    // A "changes" patch targeting a group id (contextGroupIds, not
    // originalIds — see above) has nowhere to merge onto above, since
    // originalNodes never includes the group itself, only nodes inside
    // it. Synthesize a minimal {id, type:"group", ...patch} entry for
    // each one instead, so it rides through the SAME flow array the
    // frontend's existing Tier-1 diff/apply pipeline already handles —
    // computeNodeDiff()/applyModifications() don't care what TYPE a node
    // is, and findLiveNode() already resolves a group id to the live
    // group object (Phase 8.5 C2 slice 1). This is how a group gets
    // renamed/restyled — pure property edit, no new apply-side code.
    const groupPatchIds = changeIds.filter(function (id) {
      return contextGroupIds.has(String(id)) && !originalIds.has(String(id));
    });
    groupPatchIds.forEach(function (id) {
      flow.push(Object.assign({ id: id, type: "group" }, patchById[String(id)]));
    });

    const finalRemoveNodes = Array.from(removeSet);

    // Groups describe MEMBERSHIP, not a regular node to insert — the
    // model is taught (modify-system-prompt.js) to put them in their OWN
    // top-level "newGroups" field, never inside "newNodes" (that API
    // doesn't know what a group is at all — applyInsertions would try to
    // RED.nodes.add() it). Bug found live: this used to ONLY look for a
    // stray type:"group" entry INSIDE newNodes and never read
    // result.newGroups at all — a model correctly following the prompt's
    // own instructions had its groups silently dropped ("No changes
    // detected"). Read the real field now; still tolerate a stray
    // type:"group" entry left inside newNodes as a fallback, merging
    // both rather than requiring exactly one style. Each entry's "nodes"
    // is the FULL desired membership for that group id: if the id
    // matches an EXISTING live group, the frontend reconciles membership
    // to match exactly (add/remove as needed, down to zero — ungrouping
    // everyone); if not, it creates a new group with exactly that
    // membership. See applyGroupChanges() in flowpilot-core.js.
    const allNewNodes = result.newNodes || [];
    const strayGroupNodes = allNewNodes.filter(function (n) { return n && n.type === "group"; });
    const newNodes = allNewNodes.filter(function (n) { return !(n && n.type === "group"); });
    const newNodeIdSet = new Set(newNodes.map(function (n) { return n && n.id; }).filter(Boolean));

    const declaredGroups = Array.isArray(result.newGroups) ? result.newGroups : [];
    const seenGroupIds = {};
    const newGroups = declaredGroups.concat(strayGroupNodes).filter(function (g) {
      if (!g || !g.id || seenGroupIds[g.id]) { return false; }
      seenGroupIds[g.id] = true;
      return true;
    });

    // Validate newWires references: each from/to must be either an existing
    // context node id or a placeholder id present in newNodes. A group id
    // is never a valid wire endpoint (groups don't pass messages) — filter
    // those out the same as before, just without discarding the group itself.
    let newWires = result.newWires || [];
    if (newGroups.length > 0) {
      const groupIdSet = new Set(newGroups.map(function (n) { return n && n.id; }).filter(Boolean));
      newWires = newWires.filter(function (wire) {
        return !groupIdSet.has(String(wire.from)) && !groupIdSet.has(String(wire.to));
      });
    }
    // Validate newGroups' own "nodes" member references: each must be an
    // existing context node id or a new-node placeholder id — explicitly
    // NOT another group's id, so nested groups-within-groups (out of scope
    // for v1) are naturally rejected rather than silently mis-imported.
    // An EMPTY "nodes" is allowed through here — meaningless for creating
    // a brand new group (the frontend already no-ops that case), but a
    // legitimate "ungroup everyone in this EXISTING group" when "id"
    // matches a live one, which only the frontend can tell apart.
    if (newGroups.length > 0) {
      const groupProblems = [];
      newGroups.forEach(function (g, i) {
        if (!g || !g.id) { groupProblems.push("group " + i + " missing id"); return; }
        const members = Array.isArray(g.nodes) ? g.nodes : [];
        members.forEach(function (ref) {
          if (!originalIds.has(String(ref)) && !newNodeIdSet.has(String(ref))) {
            groupProblems.push("group " + i + " member '" + ref + "' not in existing or new nodes");
          }
        });
      });
      if (groupProblems.length > 0) {
        storage.appendAudit({ action: "modify_group_ref_error", problems: groupProblems });
        return {
          status: 422,
          body: {
            error: "Invalid group references in newGroups: " + groupProblems.join("; "),
            raw: JSON.stringify(result)
          }
        };
      }
    }
    if (newWires.length > 0) {
      const wireProblems = [];
      newWires.forEach(function (wire, i) {
        [wire.from, wire.to].forEach(function (ref) {
          if (!ref) { wireProblems.push("wire " + i + " missing ref"); return; }
          if (!originalIds.has(String(ref)) && !newNodeIdSet.has(String(ref))) {
            wireProblems.push("wire " + i + " ref '" + ref + "' not in existing or new nodes");
          }
        });
      });
      if (wireProblems.length > 0) {
        storage.appendAudit({ action: "modify_wire_ref_error", problems: wireProblems });
        return {
          status: 422,
          body: {
            error: "Invalid wire references in newWires: " + wireProblems.join("; "),
            raw: JSON.stringify(result)
          }
        };
      }
    }

    if (newGroups.length > 0) { storage.appendAudit({ action: "modify_groups", count: newGroups.length }); }

    const body = {
      explanation: result.explanation,
      flow: flow,
      newNodes: newNodes,
      newWires: newWires,
      removeNodes: finalRemoveNodes,
      newGroups: newGroups
    };
    if (result.suggestedAction) { body.suggestedAction = result.suggestedAction; }

    return { status: 200, body: body };
  }

  // ---------------------------------------------------------------------
  // Streaming variant of /generate, /document and /modify. Opens an SSE
  // response, relays each provider delta as `data: {"delta":...}` (the
  // frontend uses these to progressively render the envelope's
  // "explanation" field), then runs `finalize` (finalizeSimpleGeneration or
  // finalizeModifyResult) on the completed result and sends it as a single
  // `data: {"final": <body>, "status": <status>}` event — the same
  // {status, body} shape the non-streaming routes pass to
  // res.status(status).json(body). A provider/parse error (which may carry
  // .status/.raw, e.g. a 422 parse failure) is relayed the same way, as
  // `data: {"error": <body>, "status": <status>}`, since SSE responses can't
  // change their HTTP status after headers are sent.
  // ---------------------------------------------------------------------
  async function runExecuteStream(req, res, systemPrompt, auditAction, userPrompt, context, history, historyTruncated, finalize, conversationId) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (typeof res.flushHeaders === "function") { res.flushHeaders(); }

    let result;
    try {
      result = await runFlowGenerationStream(systemPrompt, auditAction, userPrompt, context, history, historyTruncated, function (delta) {
        res.write("data: " + JSON.stringify({ delta: delta }) + "\n\n");
      });
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const body = { error: err.message };
      if (err && err.raw) { body.raw = err.raw; }
      if (!err || !err.status) { storage.appendAudit({ action: auditAction + "_error", error: err.message }); }
      res.write("data: " + JSON.stringify({ error: body, status: status }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    recordTranscriptTurn(conversationId, auditAction, userPrompt, transcriptTextFromGenerationResult(result));

    const final = finalize(result);
    res.write("data: " + JSON.stringify({ final: final.body, status: final.status }) + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  }

  RED.httpAdmin.post("/flowpilot/generate", RED.auth.needsPermission("settings.write"), async function (req, res) {
    const prompt = req.body && req.body.prompt;

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: "A description of what to generate is required." });
    }

    const history = sanitizeHistory(req.body.history);
    const historyTruncated = !!req.body.historyTruncated;

    if (req.body.stream) {
      return runExecuteStream(
        req, res, generationSystemPrompt, "generate", prompt, req.body && req.body.context,
        history, historyTruncated, finalizeSimpleGeneration, req.body.conversationId
      );
    }

    try {
      const useTools = !!req.body.tools;
      const generated = await runFlowGeneration(
        generationSystemPrompt, "generate", prompt, req.body && req.body.context,
        history, historyTruncated, useTools
      );
      if (generated.toolCalls) {
        return res.json({ toolCalls: generated.toolCalls, messages: generated.messages, content: generated.content, usage: generated.usage });
      }
      recordTranscriptTurn(req.body.conversationId, "generate", prompt, transcriptTextFromGenerationResult(generated));
      const { status, body } = finalizeSimpleGeneration(generated);
      res.status(status).json(body);
    } catch (err) {
      sendGenerationError(res, "generate", err);
    }
  });

  // First step of the agentic /build loop. Envelope-shaped and validated
  // identically to /generate (processGenerationContent only special-cases
  // auditAction === "modify"; "build" falls through to the same flow-array
  // handling "generate"/"document" already use) — the only difference is
  // buildSystemPrompt's planning preamble. Later loop iterations (fix
  // proposals) go through /flowpilot/modify instead, not this route.
  RED.httpAdmin.post("/flowpilot/build", RED.auth.needsPermission("settings.write"), async function (req, res) {
    const prompt = req.body && req.body.prompt;

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: "A description of what to build is required." });
    }

    const history = sanitizeHistory(req.body.history);
    const historyTruncated = !!req.body.historyTruncated;

    if (req.body.stream) {
      return runExecuteStream(
        req, res, buildSystemPrompt, "build", prompt, req.body && req.body.context,
        history, historyTruncated, finalizeSimpleGeneration, req.body.conversationId
      );
    }

    try {
      const useTools = !!req.body.tools;
      const built = await runFlowGeneration(
        buildSystemPrompt, "build", prompt, req.body && req.body.context,
        history, historyTruncated, useTools
      );
      if (built.toolCalls) {
        return res.json({ toolCalls: built.toolCalls, messages: built.messages, content: built.content, usage: built.usage });
      }
      recordTranscriptTurn(req.body.conversationId, "build", prompt, transcriptTextFromGenerationResult(built));
      const { status, body } = finalizeSimpleGeneration(built);
      res.status(status).json(body);
    } catch (err) {
      sendGenerationError(res, "build", err);
    }
  });

  RED.httpAdmin.post("/flowpilot/document", RED.auth.needsPermission("settings.write"), async function (req, res) {
    const context = req.body && req.body.context;
    const described = describeSelectionContext(context, storage.getSettings().redactionEnabled);

    if (!described) {
      return res.status(400).json({ error: "Select the node(s) you want documented first." });
    }

    // The prompt box holds OPTIONAL notes to steer the explanation — the
    // selection itself is the real input, so an empty prompt is fine.
    const notes = (req.body && req.body.prompt) ? String(req.body.prompt).trim() : "";
    const userPrompt = notes || "Document the selected flow.";

    const history = sanitizeHistory(req.body.history);
    const historyTruncated = !!req.body.historyTruncated;

    if (req.body.stream) {
      return runExecuteStream(
        req, res, documentSystemPrompt, "document", userPrompt, context,
        history, historyTruncated, finalizeSimpleGeneration, req.body.conversationId
      );
    }

    try {
      const useTools = !!req.body.tools;
      const documented = await runFlowGeneration(
        documentSystemPrompt, "document", userPrompt, context,
        history, historyTruncated, useTools
      );
      if (documented.toolCalls) {
        return res.json({ toolCalls: documented.toolCalls, messages: documented.messages, content: documented.content, usage: documented.usage });
      }
      recordTranscriptTurn(req.body.conversationId, "document", userPrompt, transcriptTextFromGenerationResult(documented));
      const { status, body } = finalizeSimpleGeneration(documented);
      res.status(status).json(body);
    } catch (err) {
      sendGenerationError(res, "document", err);
    }
  });

  RED.httpAdmin.post("/flowpilot/modify", RED.auth.needsPermission("settings.write"), async function (req, res) {
    const context = req.body && req.body.context;
    const described = describeSelectionContext(context, storage.getSettings().redactionEnabled);

    if (!described) {
      return res.status(400).json({ error: "Select the node(s) you want to modify first." });
    }

    const prompt = req.body && req.body.prompt;
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: "Describe what you want to change." });
    }

    // The model's "changes" patches are applied on top of these original
    // nodes to reconstruct the full "flow" sent to the editor.
    const originalNodes = (context && Array.isArray(context.nodes)) ? context.nodes : [];

    const history = sanitizeHistory(req.body.history);
    const historyTruncated = !!req.body.historyTruncated;

    const finalize = function (result) { return finalizeModifyResult(result, originalNodes); };

    if (req.body.stream) {
      return runExecuteStream(
        req, res, modifySystemPrompt, "modify", String(prompt).trim(), context,
        history, historyTruncated, finalize, req.body.conversationId
      );
    }

    try {
      const useTools = !!req.body.tools;
      const result = await runFlowGeneration(
        modifySystemPrompt, "modify", String(prompt).trim(), context,
        history, historyTruncated, useTools
      );
      if (result.toolCalls) {
        return res.json({ toolCalls: result.toolCalls, messages: result.messages, content: result.content, usage: result.usage });
      }
      recordTranscriptTurn(req.body.conversationId, "modify", String(prompt).trim(), transcriptTextFromGenerationResult(result));
      const { status, body } = finalize(result);
      res.status(status).json(body);
    } catch (err) {
      sendGenerationError(res, "modify", err);
    }
  });
};
