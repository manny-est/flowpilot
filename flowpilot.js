const createStorage = require("./lib/storage");
const provider = require("./lib/provider-openai-compatible");
const generationSystemPrompt = require("./lib/generation-system-prompt");
const documentSystemPrompt = require("./lib/document-system-prompt");
const modifySystemPrompt = require("./lib/modify-system-prompt");

module.exports = function flowPilotRuntime(RED) {
  const storage = createStorage(RED.settings.userDir);

  // ---------------------------------------------------------------------
  // Phase 6: client-held conversation history. The frontend sends a capped
  // slice of the visible chat (role/content pairs) with each request; the
  // backend stays stateless and just folds it into the message list. Used
  // by both /chat and the generate/modify/document endpoints so the cap and
  // truncation-notice behaviour can't drift between the two paths.
  // ---------------------------------------------------------------------
  const HISTORY_TRUNCATION_NOTICE =
    "Note: earlier parts of this conversation were omitted to keep the " +
    "request size manageable. Continue naturally; if you need something " +
    "that may have been said earlier, ask the user.";

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
  // A3: per-conversation transcript persistence. The frontend generates a
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
  // A3b: Recall — user-triggered keyword search across OTHER conversations'
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

  // Assemble the final messages array in the one place both /chat and the
  // generate/modify/document endpoints use: system prompt, optional
  // truncation notice, history, optional selection-context note, then the
  // new user turn.
  function buildMessages(systemPrompt, history, historyTruncated, described, userPrompt) {
    const messages = [{ role: "system", content: systemPrompt }];
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
  // Phase 6.5 B0: per-request performance fields for the audit log. Character
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
  function describeSelectionContext(context) {
    const nodes = context && Array.isArray(context.nodes) ? context.nodes : [];
    if (nodes.length === 0) { return null; }

    const connections = (context && context.connections) ? context.connections : {};
    const edges = Array.isArray(connections.edges) ? connections.edges : [];
    const perNode = Array.isArray(connections.perNode) ? connections.perNode : [];
    const subFlowCount = (typeof connections.subFlowCount === "number") ? connections.subFlowCount : 0;

    let content = "The user has selected the following Node-RED nodes as context. " +
              "This is sanitized configuration; credentials are redacted.\n\n" +
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

    return { content: content, nodeCount: nodes.length, connectionCount: edges.length };
  }

  // ---------------------------------------------------------------------
  // Shared helper: run a single-turn chat against the configured provider,
  // log it, and return the result. Used by both /chat and /test so the two
  // never drift apart. contextMode is recorded for the Phase 2+ audit trail.
  // ---------------------------------------------------------------------
  async function runChat(prompt, contextMode, context, history, historyTruncated, conversationId) {
    const settings = storage.getSettings();
    const activeProvider = storage.getActiveProvider(settings);

    const described = describeSelectionContext(context);
    const messages = buildMessages(
      settings.systemPrompt || "You are FlowPilot, a Node-RED development assistant.",
      history, historyTruncated, described, prompt
    );

    const result = await provider.chat(activeProvider, messages);

    recordTranscriptTurn(conversationId, "chat", prompt, result.content || "");

    const perf = performanceAuditFields(messages, result.content, result);

    return { settings, activeProvider, result, perf };
  }

  // ---------------------------------------------------------------------
  // Phase 6 chunk 4: streaming variant of /chat. Relays provider SSE chunks
  // to the browser as they arrive via res.write (Node-RED's httpAdmin routes
  // are plain Express, so chunked relay works the same as any Express app).
  // Generate/modify/document stay non-streamed (their JSON envelope can't be
  // validated until complete).
  // ---------------------------------------------------------------------
  async function runChatStream(req, res, prompt, context, history, historyTruncated, conversationId) {
    const settings = storage.getSettings();
    const activeProvider = storage.getActiveProvider(settings);

    const described = describeSelectionContext(context);
    const messages = buildMessages(
      settings.systemPrompt || "You are FlowPilot, a Node-RED development assistant.",
      history, historyTruncated, described, prompt
    );

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (typeof res.flushHeaders === "function") { res.flushHeaders(); }

    let streamResult;
    try {
      streamResult = await provider.chatStream(activeProvider, messages, function (delta) {
        res.write("data: " + JSON.stringify({ delta: delta }) + "\n\n");
      });
    } catch (err) {
      res.write("data: " + JSON.stringify({ error: err.message }) + "\n\n");
      res.end();
      storage.appendAudit({ action: "chat_stream_error", error: err.message });
      return;
    }
    const full = streamResult.content;

    res.write("data: [DONE]\n\n");
    res.end();

    storage.appendAudit(Object.assign({
      action: "chat_stream",
      providerName: activeProvider.providerName,
      baseUrl: activeProvider.baseUrl,
      model: activeProvider.model
    }, performanceAuditFields(messages, full, streamResult)));

    recordTranscriptTurn(conversationId, "chat", prompt, full);
  }

  // ---- Settings: read --------------------------------------------------

  RED.httpAdmin.get("/flowpilot/settings", RED.auth.needsPermission("settings.read"), function (req, res) {
    try {
      res.json(storage.getSettings());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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

  // ---- Chat: the real prompt endpoint ----------------------------------
  // This is the endpoint that will grow in Phase 2/3 (message history,
  // flow context, streaming). Keep /test minimal and separate from it.

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
      const { activeProvider, result, perf } = await runChat(prompt, "selected-nodes", req.body.context, history, historyTruncated, req.body.conversationId);

      storage.appendAudit(Object.assign({
        action: "chat",
        providerName: activeProvider.providerName,
        baseUrl: activeProvider.baseUrl,
        model: activeProvider.model
      }, perf));

      res.json({
        message: result.content || "[No assistant message returned by provider]",
        raw: result.raw ? "[raw response captured]" : null
      });
    } catch (err) {
      storage.appendAudit({ action: "chat_error", error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Recall: search past conversations' transcripts (A3b) ------------
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
  // D6: conversation list ("Flight log"), layered over the A3 transcript
  // files. Summaries are read-only and derived on the fly — title is the
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

  // ---- Test: connectivity check only -----------------------------------
  // Deliberately minimal. Confirms "can I reach the provider and get a
  // reply at all." Never depends on chat history or flow context.

  RED.httpAdmin.post("/flowpilot/test", RED.auth.needsPermission("settings.write"), async function (req, res) {
    const prompt = (req.body && req.body.prompt) || "Say hello from FlowPilot.";

    try {
      const { settings, activeProvider, result, perf } = await runChat(prompt, "connectivity-test");

      storage.appendAudit(Object.assign({
        action: "chat_test",
        providerName: activeProvider.providerName,
        baseUrl: activeProvider.baseUrl,
        model: activeProvider.model
      }, perf));

      // Bcap1: capability probe — connectivity already succeeded above, so a
      // probe failure here just means "no tool support", not a /test failure.
      // Persist the result on the provider profile for Phase 7's agentic path.
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
        message: result.content || "[No assistant message returned by provider]",
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

  // ---- Generate: produce an importable flow fragment (Phase 4) ---------
  // Uses the generation system prompt and expects the model to return a single
  // JSON object { explanation, flow }. This first cut does NOT validate node
  // types or wire integrity yet (that's the next chunk) — it returns the parsed
  // envelope so the frontend can display it for review.

  function extractJsonObject(text) {
    if (!text) { throw new Error("Empty response from provider."); }
    let s = String(text).trim();
    // Strip markdown code fences if the model wrapped the JSON.
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    const firstBrace = s.indexOf("{");
    const firstBracket = s.indexOf("[");

    // The model occasionally returns a bare top-level array (e.g.
    // `[ {...node...} ]`) instead of the {explanation, flow} envelope. If we
    // fell through to the {...} extraction below, indexOf("{")/lastIndexOf("}")
    // would grab just the first node object — which has no "flow" key and
    // fails validation. Detect this case up front and wrap it as a minimal
    // envelope instead.
    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
      const lastBracket = s.lastIndexOf("]");
      if (lastBracket !== -1 && lastBracket > firstBracket) {
        try {
          const arr = JSON.parse(s.slice(firstBracket, lastBracket + 1));
          if (Array.isArray(arr)) {
            return { explanation: "", flow: arr };
          }
        } catch (e) {
          // Not a parseable array — fall through to the {...} extraction.
        }
      }
    }

    // If there's leading/trailing prose, grab the outermost {...}.
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first === -1 || last === -1 || last < first) {
      // A1: no JSON object found at all — flagged separately from a found-
      // but-unparseable ({...} present, JSON.parse failed) "garbled" error,
      // so callers can distinguish "model just answered in prose" (tolerate)
      // from "model's JSON envelope is broken" (still an error).
      const err = new Error("Provider did not return a JSON object.");
      err.noJsonFound = true;
      throw err;
    }
    return JSON.parse(s.slice(first, last + 1));
  }

  // ---------------------------------------------------------------------
  // Shared helper: resolve the active provider and assemble the messages
  // array for a generation-style request (generate/document/modify). Split
  // out from runFlowGeneration so the streaming variant (B1) can build the
  // same request and swap provider.chat for provider.chatStream.
  // ---------------------------------------------------------------------
  function buildGenerationContext(systemPrompt, userPrompt, context, history, historyTruncated) {
    const settings = storage.getSettings();
    const activeProvider = storage.getActiveProvider(settings);
    const described = describeSelectionContext(context);
    const messages = buildMessages(systemPrompt, history, historyTruncated, described, userPrompt);
    return { activeProvider, described, messages };
  }

  // ---------------------------------------------------------------------
  // Workstream C: pull an optional "suggestedAction" (action chip) out of a
  // parsed envelope. Validated but non-critical — a malformed or missing
  // suggestion is just dropped (returns null), never an error, since chips
  // are an additive hint on top of the real response.
  //   { mode: "generate"|"document"|"modify", prompt: "...", selectionHint?: "..." }
  // ---------------------------------------------------------------------
  function extractSuggestedAction(parsed) {
    const sa = parsed && parsed.suggestedAction;
    if (!sa || typeof sa !== "object") { return null; }
    if (["generate", "document", "modify"].indexOf(sa.mode) === -1) { return null; }
    if (typeof sa.prompt !== "string" || !sa.prompt.trim()) { return null; }

    const result = { mode: sa.mode, prompt: sa.prompt.trim() };
    if (typeof sa.selectionHint === "string" && sa.selectionHint.trim()) {
      result.selectionHint = sa.selectionHint.trim();
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // Shared helper: parse, validate and audit a completed provider response
  // for a generation-style request, returning { question } / { prose } /
  // { explanation, flow, newNodes, newWires }, each optionally carrying a
  // `suggestedAction` (Workstream C action chip). Used by both the
  // non-streaming and streaming (B1) paths, which differ only in how
  // `content` and `providerResult` were obtained (provider.chat vs
  // provider.chatStream). Throws an Error with .status and (when applicable)
  // .raw for the route to relay.
  // ---------------------------------------------------------------------
  function processGenerationContent(content, providerResult, messages, auditAction, described, activeProvider) {
    const perf = performanceAuditFields(messages, content, providerResult);

    let parsed;
    try {
      parsed = extractJsonObject(content);
    } catch (parseErr) {
      // A1: a response with no JSON envelope at all, but non-empty prose
      // (analysis, an answer, a question without the envelope) is tolerated —
      // render it as a normal assistant message and keep the action armed.
      // Errors stay reserved for empty responses or a found-but-broken {...}.
      if (parseErr.noJsonFound && content.trim()) {
        storage.appendAudit(Object.assign({ action: auditAction + "_prose" }, perf));
        return { prose: content.trim() };
      }
      storage.appendAudit(Object.assign({ action: auditAction + "_parse_error", error: parseErr.message }, perf));
      const err = new Error("Could not parse a flow from the response: " + parseErr.message);
      err.status = 422;
      err.raw = content;
      throw err;
    }

    // Phase 6 chunk 3: clarifying-question envelope. The model may ask ONE
    // follow-up question instead of producing a flow when the request is too
    // ambiguous to act on. The frontend renders the question as a normal
    // assistant message and keeps the Execute action armed for the answer.
    if (typeof parsed.question === "string" && parsed.question.trim() &&
        (!Array.isArray(parsed.flow) || parsed.flow.length === 0)) {
      storage.appendAudit(Object.assign({ action: auditAction + "_question" }, perf));
      const questionResult = { question: parsed.question, explanation: parsed.explanation || "" };
      const questionAction = extractSuggestedAction(parsed);
      if (questionAction) { questionResult.suggestedAction = questionAction; }
      return questionResult;
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
  async function runFlowGeneration(systemPrompt, auditAction, userPrompt, context, history, historyTruncated) {
    const { activeProvider, described, messages } = buildGenerationContext(systemPrompt, userPrompt, context, history, historyTruncated);
    const result = await provider.chat(activeProvider, messages);
    return processGenerationContent(result.content || "", result, messages, auditAction, described, activeProvider);
  }

  // ---------------------------------------------------------------------
  // B1: streaming variant of runFlowGeneration. Relays each provider delta
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
  // B1: turn a runFlowGeneration(Stream) result into a { status, body }
  // response for /generate and /document — they share identical
  // post-processing (question/prose passthrough, else the envelope as-is).
  // Used by both the non-streaming route (res.status(status).json(body)) and
  // the streaming route (relayed as the final SSE event).
  // ---------------------------------------------------------------------
  function finalizeSimpleGeneration(result) {
    if (result.question) {
      const body = { explanation: result.explanation, question: result.question, flow: null };
      if (result.suggestedAction) { body.suggestedAction = result.suggestedAction; }
      return { status: 200, body: body };
    }
    if (result.prose) {
      return { status: 200, body: { explanation: result.prose, prose: true, flow: null } };
    }
    return { status: 200, body: result };
  }

  // ---------------------------------------------------------------------
  // B1: turn a runFlowGeneration(Stream) result into a { status, body }
  // response for /modify — question/prose passthrough, else the full
  // removeNodes/newNodes/newWires validation that previously lived inline in
  // the /flowpilot/modify route handler. Used by both the non-streaming and
  // streaming routes.
  // ---------------------------------------------------------------------
  function finalizeModifyResult(result, originalIds) {
    if (result.question) {
      const questionBody = { explanation: result.explanation, question: result.question, flow: null };
      if (result.suggestedAction) { questionBody.suggestedAction = result.suggestedAction; }
      return { status: 200, body: questionBody };
    }
    if (result.prose) {
      return { status: 200, body: { explanation: result.prose, prose: true, flow: null } };
    }

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

    // Build the set of ids that should remain in flow (original minus removals).
    const removeSet = new Set(removeNodes.map(String));
    const returnedIds = result.flow.map(function (n) { return n.id; });
    const returnedIdSet = new Set(returnedIds);

    // Models often drop a node from "flow" to remove it without also listing
    // it in "removeNodes" (despite the prompt's instructions). Treat any
    // original id that's missing from flow and not already in removeNodes as
    // an implicit removal rather than a hard error — the review UI surfaces
    // every removal for the user to approve before anything is applied.
    const implicitRemovals = Array.from(originalIds).filter(function (id) {
      return !returnedIdSet.has(id) && !removeSet.has(id);
    });
    if (implicitRemovals.length > 0) {
      storage.appendAudit({ action: "modify_implicit_remove", ids: implicitRemovals });
      implicitRemovals.forEach(function (id) { removeSet.add(id); });
    }

    // Validate that flow contains no hallucinated ids, and that no id is both
    // kept in flow and marked for removal.
    const extraIds = returnedIds.filter(function (id) { return !originalIds.has(id); });
    const wronglyKeptIds = returnedIds.filter(function (id) { return removeSet.has(id); });

    const idProblems = [];
    if (extraIds.length) { idProblems.push("unexpected id(s) in flow: " + extraIds.join(", ")); }
    if (wronglyKeptIds.length) { idProblems.push("id(s) in both flow and removeNodes: " + wronglyKeptIds.join(", ")); }

    if (idProblems.length > 0) {
      storage.appendAudit({ action: "modify_id_mismatch", problems: idProblems });
      return {
        status: 422,
        body: {
          error: "The model returned inconsistent node ids (" + idProblems.join("; ") + "). Try again.",
          raw: JSON.stringify(result.flow)
        }
      };
    }

    const finalRemoveNodes = Array.from(removeSet);

    // "group" nodes aren't supported yet (the editor's group API needs
    // bounding-box computation + group-aware undo that applyInsertions
    // doesn't implement). The system prompt tells the model not to propose
    // them, but strip any that slip through anyway, and drop any newWires
    // that reference a stripped group's placeholder id.
    const allNewNodes = result.newNodes || [];
    const groupNodes = allNewNodes.filter(function (n) { return n && n.type === "group"; });
    const newNodes = allNewNodes.filter(function (n) { return !(n && n.type === "group"); });
    const newNodeIdSet = new Set(newNodes.map(function (n) { return n && n.id; }).filter(Boolean));

    // Validate newWires references: each from/to must be either an existing
    // context node id or a placeholder id present in newNodes.
    let newWires = result.newWires || [];
    if (groupNodes.length > 0) {
      const groupIdSet = new Set(groupNodes.map(function (n) { return n && n.id; }).filter(Boolean));
      newWires = newWires.filter(function (wire) {
        return !groupIdSet.has(String(wire.from)) && !groupIdSet.has(String(wire.to));
      });
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

    let explanation = result.explanation;
    if (groupNodes.length > 0) {
      storage.appendAudit({ action: "modify_group_stripped", count: groupNodes.length });
      explanation = (explanation ? explanation + "\n\n" : "") +
        "Note: grouping nodes into a visual group isn't supported yet, so that part of the request was skipped.";
    }

    const body = {
      explanation: explanation,
      flow: result.flow,
      newNodes: newNodes,
      newWires: newWires,
      removeNodes: finalRemoveNodes
    };
    if (result.suggestedAction) { body.suggestedAction = result.suggestedAction; }

    return { status: 200, body: body };
  }

  // ---------------------------------------------------------------------
  // B1: streaming variant of /generate, /document and /modify. Opens an SSE
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
      const generated = await runFlowGeneration(
        generationSystemPrompt, "generate", prompt, req.body && req.body.context,
        history, historyTruncated
      );
      recordTranscriptTurn(req.body.conversationId, "generate", prompt, transcriptTextFromGenerationResult(generated));
      const { status, body } = finalizeSimpleGeneration(generated);
      res.status(status).json(body);
    } catch (err) {
      sendGenerationError(res, "generate", err);
    }
  });

  RED.httpAdmin.post("/flowpilot/document", RED.auth.needsPermission("settings.write"), async function (req, res) {
    const context = req.body && req.body.context;
    const described = describeSelectionContext(context);

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
      const documented = await runFlowGeneration(
        documentSystemPrompt, "document", userPrompt, context,
        history, historyTruncated
      );
      recordTranscriptTurn(req.body.conversationId, "document", userPrompt, transcriptTextFromGenerationResult(documented));
      const { status, body } = finalizeSimpleGeneration(documented);
      res.status(status).json(body);
    } catch (err) {
      sendGenerationError(res, "document", err);
    }
  });

  RED.httpAdmin.post("/flowpilot/modify", RED.auth.needsPermission("settings.write"), async function (req, res) {
    const context = req.body && req.body.context;
    const described = describeSelectionContext(context);

    if (!described) {
      return res.status(400).json({ error: "Select the node(s) you want to modify first." });
    }

    const prompt = req.body && req.body.prompt;
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: "Describe what you want to change." });
    }

    // Build a set of the original ids so we can validate the model's output.
    const originalNodes = (context && Array.isArray(context.nodes)) ? context.nodes : [];
    const originalIds = new Set(originalNodes.map(function (n) { return n.id; }));

    const history = sanitizeHistory(req.body.history);
    const historyTruncated = !!req.body.historyTruncated;

    const finalize = function (result) { return finalizeModifyResult(result, originalIds); };

    if (req.body.stream) {
      return runExecuteStream(
        req, res, modifySystemPrompt, "modify", String(prompt).trim(), context,
        history, historyTruncated, finalize, req.body.conversationId
      );
    }

    try {
      const result = await runFlowGeneration(
        modifySystemPrompt, "modify", String(prompt).trim(), context,
        history, historyTruncated
      );
      recordTranscriptTurn(req.body.conversationId, "modify", String(prompt).trim(), transcriptTextFromGenerationResult(result));
      const { status, body } = finalize(result);
      res.status(status).json(body);
    } catch (err) {
      sendGenerationError(res, "modify", err);
    }
  });
};
