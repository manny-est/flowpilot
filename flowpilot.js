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
              "Nodes:\n```json\n" + JSON.stringify(nodes, null, 2) + "\n```";
    if (edges.length > 0) {
      content += "\n\nConnections — directed edges (a node's wires describe its " +
             "OUTPUTS; one edge per output port):\n```json\n" +
             JSON.stringify(edges, null, 2) + "\n```";
      content += "\n\nPer-node wiring summary (inputs are reconstructed, since " +
             "Node-RED nodes do not store their own inputs; subFlow groups " +
             "nodes into connected sub-flows):\n```json\n" +
             JSON.stringify(perNode, null, 2) + "\n```";
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
  async function runChat(prompt, contextMode, context, history, historyTruncated) {
    const settings = storage.getSettings();
    const activeProvider = storage.getActiveProvider(settings);

    const described = describeSelectionContext(context);
    const messages = buildMessages(
      settings.systemPrompt || "You are FlowPilot, a Node-RED development assistant.",
      history, historyTruncated, described, prompt
    );

    const result = await provider.chat(activeProvider, messages);

    storage.saveChatLog({
      providerName: activeProvider.providerName,
      baseUrl: activeProvider.baseUrl,
      model: activeProvider.model,
      contextMode: contextMode,
      contextNodeCount: described ? described.nodeCount : 0,
      contextConnectionCount: described ? described.connectionCount : 0,
      allowConfigContext: false,
      logFullContext: false,
      historyLength: (history || []).length,
      historyTruncated: !!historyTruncated,
      userPrompt: prompt,
      assistantResponse: result.content || "",
      raw: result.raw ? "[raw response captured]" : ""
    });

    return { settings, activeProvider, result };
  }

  // ---------------------------------------------------------------------
  // Phase 6 chunk 4: streaming variant of /chat. Relays provider SSE chunks
  // to the browser as they arrive via res.write (Node-RED's httpAdmin routes
  // are plain Express, so chunked relay works the same as any Express app).
  // Generate/modify/document stay non-streamed (their JSON envelope can't be
  // validated until complete).
  // ---------------------------------------------------------------------
  async function runChatStream(req, res, prompt, context, history, historyTruncated) {
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

    let full = "";
    try {
      full = await provider.chatStream(activeProvider, messages, function (delta) {
        res.write("data: " + JSON.stringify({ delta: delta }) + "\n\n");
      }).then(function (r) { return r.content; });
    } catch (err) {
      res.write("data: " + JSON.stringify({ error: err.message }) + "\n\n");
      res.end();
      storage.appendAudit({ action: "chat_stream_error", error: err.message });
      return;
    }

    res.write("data: [DONE]\n\n");
    res.end();

    storage.appendAudit({
      action: "chat_stream",
      providerName: activeProvider.providerName,
      baseUrl: activeProvider.baseUrl,
      model: activeProvider.model
    });

    storage.saveChatLog({
      providerName: activeProvider.providerName,
      baseUrl: activeProvider.baseUrl,
      model: activeProvider.model,
      contextMode: "selected-nodes",
      contextNodeCount: described ? described.nodeCount : 0,
      contextConnectionCount: described ? described.connectionCount : 0,
      allowConfigContext: false,
      logFullContext: false,
      historyLength: (history || []).length,
      historyTruncated: !!historyTruncated,
      streamed: true,
      userPrompt: prompt,
      assistantResponse: full
    });
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
        await runChatStream(req, res, prompt, req.body.context, history, historyTruncated);
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
      const { activeProvider, result } = await runChat(prompt, "selected-nodes", req.body.context, history, historyTruncated);

      storage.appendAudit({
        action: "chat",
        providerName: activeProvider.providerName,
        baseUrl: activeProvider.baseUrl,
        model: activeProvider.model
      });

      res.json({
        message: result.content || "[No assistant message returned by provider]",
        raw: result.raw ? "[raw response captured]" : null
      });
    } catch (err) {
      storage.appendAudit({ action: "chat_error", error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Test: connectivity check only -----------------------------------
  // Deliberately minimal. Confirms "can I reach the provider and get a
  // reply at all." Never depends on chat history or flow context.

  RED.httpAdmin.post("/flowpilot/test", RED.auth.needsPermission("settings.write"), async function (req, res) {
    const prompt = (req.body && req.body.prompt) || "Say hello from FlowPilot.";

    try {
      const { activeProvider, result } = await runChat(prompt, "connectivity-test");

      storage.appendAudit({
        action: "chat_test",
        providerName: activeProvider.providerName,
        baseUrl: activeProvider.baseUrl,
        model: activeProvider.model
      });

      res.json({
        message: result.content || "[No assistant message returned by provider]",
        raw: result.raw ? "[raw response captured]" : null
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
    // If there's leading/trailing prose, grab the outermost {...}.
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first === -1 || last === -1 || last < first) {
      throw new Error("Provider did not return a JSON object.");
    }
    return JSON.parse(s.slice(first, last + 1));
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
    const settings = storage.getSettings();
    const activeProvider = storage.getActiveProvider(settings);

    const described = describeSelectionContext(context);
    const messages = buildMessages(systemPrompt, history, historyTruncated, described, userPrompt);

    const result = await provider.chat(activeProvider, messages);
    const content = result.content || "";

    let parsed;
    try {
      parsed = extractJsonObject(content);
    } catch (parseErr) {
      storage.appendAudit({ action: auditAction + "_parse_error", error: parseErr.message });
      const err = new Error("Could not parse a flow from the response: " + parseErr.message);
      err.status = 422;
      err.raw = content;
      throw err;
    }

    // Phase 6 chunk 3: clarifying-question envelope. The model may ask ONE
    // follow-up question instead of producing a flow when the request is too
    // ambiguous to act on. The frontend renders the question as a normal
    // assistant message and keeps the Execute action armed for the answer.
    if (typeof parsed.question === "string" && parsed.question.trim() && !Array.isArray(parsed.flow)) {
      storage.appendAudit({ action: auditAction + "_question" });
      return { question: parsed.question, explanation: parsed.explanation || "" };
    }

    const flow = Array.isArray(parsed.flow) ? parsed.flow : null;
    if (!flow) {
      const err = new Error("The response did not contain a 'flow' array.");
      err.status = 422;
      err.raw = content;
      throw err;
    }

    storage.appendAudit({
      action: auditAction,
      providerName: activeProvider.providerName,
      baseUrl: activeProvider.baseUrl,
      model: activeProvider.model,
      nodeCount: flow.length,
      contextNodeCount: described ? described.nodeCount : 0,
      contextConnectionCount: described ? described.connectionCount : 0
    });

    return {
      explanation: parsed.explanation || "",
      flow: flow,
      newNodes: Array.isArray(parsed.newNodes) ? parsed.newNodes : [],
      newWires: Array.isArray(parsed.newWires) ? parsed.newWires : []
    };
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

  RED.httpAdmin.post("/flowpilot/generate", RED.auth.needsPermission("settings.write"), async function (req, res) {
    const prompt = req.body && req.body.prompt;

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: "A description of what to generate is required." });
    }

    const history = sanitizeHistory(req.body.history);
    const historyTruncated = !!req.body.historyTruncated;

    try {
      const generated = await runFlowGeneration(
        generationSystemPrompt, "generate", prompt, req.body && req.body.context,
        history, historyTruncated
      );
      if (generated.question) {
        return res.json({ explanation: generated.explanation, question: generated.question, flow: null });
      }
      res.json(generated);
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

    try {
      const documented = await runFlowGeneration(
        documentSystemPrompt, "document", userPrompt, context,
        history, historyTruncated
      );
      if (documented.question) {
        return res.json({ explanation: documented.explanation, question: documented.question, flow: null });
      }
      res.json(documented);
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

    try {
      const result = await runFlowGeneration(
        modifySystemPrompt, "modify", String(prompt).trim(), context,
        history, historyTruncated
      );

      // Phase 6 chunk 3: clarifying-question envelope — bypass all flow
      // validation below, the model is asking a question instead.
      if (result.question) {
        return res.json({ explanation: result.explanation, question: result.question, flow: null });
      }

      // Validate removeNodes: all ids must be in the original selection.
      const removeNodes = Array.isArray(result.removeNodes) ? result.removeNodes : [];
      if (removeNodes.length > 0) {
        const badRemove = removeNodes.filter(function (id) { return !originalIds.has(String(id)); });
        if (badRemove.length > 0) {
          storage.appendAudit({ action: "modify_remove_ref_error", ids: badRemove });
          return res.status(422).json({
            error: "removeNodes contains id(s) not in the selection: " + badRemove.join(", "),
            raw: JSON.stringify(result)
          });
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
        return res.status(422).json({
          error: "The model returned inconsistent node ids (" + idProblems.join("; ") + "). Try again.",
          raw: JSON.stringify(result.flow)
        });
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
          return res.status(422).json({
            error: "Invalid wire references in newWires: " + wireProblems.join("; "),
            raw: JSON.stringify(result)
          });
        }
      }

      let explanation = result.explanation;
      if (groupNodes.length > 0) {
        storage.appendAudit({ action: "modify_group_stripped", count: groupNodes.length });
        explanation = (explanation ? explanation + "\n\n" : "") +
          "Note: grouping nodes into a visual group isn't supported yet, so that part of the request was skipped.";
      }

      res.json({
        explanation: explanation,
        flow: result.flow,
        newNodes: newNodes,
        newWires: newWires,
        removeNodes: finalRemoveNodes
      });
    } catch (err) {
      sendGenerationError(res, "modify", err);
    }
  });
};
