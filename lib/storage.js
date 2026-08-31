const fs = require("fs");
const path = require("path");

// Sentinel the client sends back for an apiKey field it never actually saw
// (see maskProviderSecrets in flowpilot.js) to mean "leave the stored key
// alone". Shared between the GET/POST /flowpilot/settings routes (masking)
// and reconcileProviderSecrets below (unmasking on save) — both must agree
// on the exact string or a real key could get silently overwritten.
const API_KEY_UNCHANGED = "__FP_KEY_UNCHANGED__";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Strips control characters (CR/LF and friends) from a freshly-typed API
// key before it's persisted — cheap insurance against a pasted value
// corrupting a future header or a log line.
function sanitizeApiKey(raw) {
  return String(raw).replace(/[\x00-\x1F\x7F]/g, "");
}

// Reconciles an incoming providers list (as submitted by POST /flowpilot/
// settings, where the client only ever sees the masked sentinel/"" for
// apiKey — never a real key) against the previously-stored list, matched by
// provider id. A sentinel or missing apiKey keeps the stored key; an empty
// string clears it; anything else is a real retyped key. Also enforces the
// server-writes-only discipline for confirmedBaseUrl/confirmedAt (the
// provider-confirmation gate, B1): a client can never set or forge these,
// and confirmation is dropped whenever baseUrl or apiKey actually changed
// from what was last confirmed.
// trustedConfirmation: true ONLY when called from saveSettings' own internal
// callers (/flowpilot/test, /flowpilot/probe, right after a real passing
// check) — never from the public POST /settings path. Those two routes
// compute confirmedBaseUrl themselves (== the exact URL they just verified),
// so it's server-computed data at that point, not client input; every OTHER
// provider in the same save (anything not freshly (re)confirmed this call)
// still only keeps its OWN prior confirmation, and only while baseUrl/apiKey
// still match what was actually confirmed.
function reconcileProviderSecrets(incoming, existing, trustedConfirmation) {
  const existingById = {};
  (Array.isArray(existing) ? existing : []).forEach(function (p) {
    if (p && p.id) { existingById[p.id] = p; }
  });

  return (Array.isArray(incoming) ? incoming : []).map(function (p) {
    const prior = existingById[p.id];
    const next = Object.assign({}, p);
    delete next.hasApiKey;

    if (next.apiKey === API_KEY_UNCHANGED || next.apiKey === undefined) {
      next.apiKey = prior ? (prior.apiKey || "") : "";
    } else if (typeof next.apiKey === "string" && next.apiKey !== "") {
      next.apiKey = sanitizeApiKey(next.apiKey);
    }

    // typeof, not truthiness: baseUrl "" is a real, documented, supported
    // value (Anthropic's "leave blank for api.anthropic.com" convention),
    // so confirmedBaseUrl can legitimately BE "" too — `"" && ...` would
    // silently evaluate false and lock that configuration out of
    // confirmation forever. Only an actually-absent field should fail.
    if (trustedConfirmation && typeof p.confirmedBaseUrl === "string") {
      next.confirmedBaseUrl = p.confirmedBaseUrl;
      next.confirmedAt = p.confirmedAt;
      return next;
    }

    // Untrusted path (public POST /settings): never trust what the client
    // sent, start from the prior stored state, then drop it if baseUrl or
    // the (now-reconciled) apiKey no longer matches what was confirmed.
    if (prior && typeof prior.confirmedBaseUrl === "string" && next.baseUrl === prior.baseUrl && next.apiKey === prior.apiKey) {
      next.confirmedBaseUrl = prior.confirmedBaseUrl;
      next.confirmedAt = prior.confirmedAt;
    } else {
      delete next.confirmedBaseUrl;
      delete next.confirmedAt;
    }
    return next;
  });
}

function createStorage(userDir) {
  const baseDir = path.join(userDir, "flowpilot");
  const chatsDir = path.join(baseDir, "chats");
  const backupsDir = path.join(baseDir, "backups");
  const settingsFile = path.join(baseDir, "settings.json");
  const auditFile = path.join(baseDir, "audit.log");

  // A provider profile. Each has its own model since model names differ
  // across providers (LocalAI vs cloud).
  function defaultProvider() {
    return {
      id: "default",
      providerName: "LocalAI",
      // "openai-compatible" (default) or "anthropic"
      type: "openai-compatible",
      baseUrl: "http://localhost:8080",
      apiKey: "",
      model: "",
      temperature: 0.2,
      // Configured context window size for this provider in tokens (0 = unknown).
      // When set, FlowPilot warns when the assembled prompt approaches the limit.
      numCtx: 0
    };
  }

  const defaultSettings = {
    // Multiple provider profiles; one is active at a time. The list shape is
    // deliberately ready for a future side-by-side compare mode.
    providers: [defaultProvider()],
    activeProviderId: "default",
    maxContextChars: 12000,
    defaultContextMode: "selected",
    allowConfigContext: false,
    // When true, provider turns (post-redaction messages, replies, and tool calls)
    // are appended to debug.log
    // (0600 perms). Auth headers/keys are never logged — only the content bytes
    // that the provider actually received. Off by default (diagnostic tool).
    debugLogging: false,
    streamingEnabled: true,
    // First-run welcome/warning shows until the user saves settings once.
    firstRunAcknowledged: false,
    // Context-size advisory thresholds, in estimated tokens (~chars/4).
    // Advisory only; never blocks sending.
    contextWarnTokens: 4000,
    contextHighTokens: 8000,
    // How many recent chat exchanges (user+assistant pairs) the frontend
    // includes as history with each request. Older turns are dropped
    // client-side and the model is told when that happened.
    historyMaxExchanges: 10,
    // How long to wait for a provider response before giving up. Slow local
    // hardware (e.g. Ollama on a big model with no GPU) can take much longer
    // than cloud providers; users on that hardware raise this in Behavior
    // settings rather than living with a hardcoded ceiling.
    requestTimeoutMs: 180000,
    // Hard output bound for each tool-capable agent turn. Classic completions
    // remain uncapped so ordinary flow envelopes are never silently clipped.
    agentTurnMaxTokens: 4096,
    // Max build->deploy->test->fix cycles the /build agentic loop will run
    // before stopping with an honest "couldn't fully verify" instead of
    // proposing another fix. Bounds against a non-converging loop burning
    // tokens forever; user-configurable since "reasonable" varies by
    // provider speed/cost. Unrelated to the read-only tool-calling loop's
    // own hardcoded AGENT_LOOP_MAX_STEPS (a different bound, for a
    // different loop).
    agentLoopMaxIterations: 5,
    // When true, the build loop pauses at the "attach → review" transition
    // and shows a checkpoint question ("Continue with AI review, or stop?")
    // instead of auto-advancing. Default false = original auto-advance behavior.
    loopHoldStep: false,
    // Routes Generate through the Phase 10 step-queue engine (graph read-back
    // verification after import). The legacy path remains available when a
    // user explicitly disables this setting.
    enableStepQueue: true,
    // W7 WRITE-tool loop. Default-off until the server/client Round 1
    // plumbing has passed its integration and mandatory human live-test
    // gates. This is separate from enableStepQueue (Generate checklist UI).
    enableAgentWrite: false,
    // Lets the user silence the recurring secrets/size reminder bar after
    // typing an explicit acknowledgement in settings.
    suppressContextWarnings: false,
    // Secret-shaped-value scrubbing (password/token/apiKey-looking fields in
    // node config and debug output) — on by default. Local/private-AI users
    // can turn it off via a separate type-to-confirm gate in Settings; the
    // dedicated Node-RED credentials field is dropped by the frontend
    // regardless of this setting, via a different, always-on mechanism.
    redactionEnabled: true,
    // Chat-only persona slider, 1-5 (CLAUDE-032: was 1-10, collapsed to 5
    // discrete levels after live testing found the old scale's
    // interpolated-between-anchors design produced no discernible voice
    // difference across most of its range): 1 is a plain Node-RED engineer,
    // 5 is a comically over-the-top airline captain who happens to be a
    // Node-RED expert. 2 ("subtle co-pilot") is the default.
    // See lib/persona-prompt.js — generated fresh per request, never baked
    // into the persisted systemPrompt below.
    personaIntensity: 2,
    // User-defined intent buttons: array of { label, text }.
    customIntents: [],
    systemPrompt: require("./default-system-prompt")
  };

  // Older builds persisted a "Phase 1, READ-ONLY mode" system prompt into
  // settings.json once and never updated it — Object.assign in getSettings
  // lets that stale persisted copy win forever, even after
  // default-system-prompt.js is fixed. Detect that stale text (by a phrase
  // unique to it) and swap in the current default instead. Applied both when
  // reading settings AND when saving them, so a browser tab that still has
  // the stale text loaded in the System Prompt textarea can't re-persist it.
  // The old default also baked a static "Personality:" paragraph into the
  // persisted systemPrompt; that's now generated fresh every request from
  // personaIntensity (lib/persona-prompt.js) instead, scaled by a slider, so
  // a leftover copy from before this change is redundant rather than wrong.
  // Unlike the READ-ONLY case above, only this one paragraph is stale — the
  // rest of any customization the user made should survive — so this is a
  // surgical removal (exact match) rather than swapping the whole prompt.
  const STALE_PERSONALITY_PARAGRAPH = "Personality: you have a subtle co-pilot voice, used ONLY for greetings, \"what can you do?\"-style capability questions, and brief transition moments — e.g. \"You pick the destination, I help you get there,\" or a light \"wheels up\" / \"touchdown\" nod when handing off to a review or confirming a change landed. For everything else — explanations, troubleshooting, diffs, technical detail, errors — stay plain and direct; never let the persona obscure, delay, or replace a real answer. A little goes a long way: do not repeat aviation phrasing in every reply.\n\n";

  function fixStaleSystemPrompt(systemPrompt) {
    if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
      return defaultSettings.systemPrompt;
    }
    if (systemPrompt.indexOf("operating in READ-ONLY mode") !== -1) {
      return defaultSettings.systemPrompt;
    }
    if (systemPrompt.indexOf(STALE_PERSONALITY_PARAGRAPH) !== -1) {
      return systemPrompt.split(STALE_PERSONALITY_PARAGRAPH).join("");
    }
    return systemPrompt;
  }

  // Migrate an old flat-provider settings object (providerName/baseUrl/etc at
  // top level) into the new providers-list shape, preserving the user's
  // configured provider. Idempotent: leaves new-format settings untouched.
  function migrate(parsed) {
    if (!parsed || typeof parsed !== "object") { return parsed; }
    if (Array.isArray(parsed.providers) && parsed.providers.length) {
      return parsed; // already new format
    }
    if (parsed.providerName || parsed.baseUrl || parsed.model) {
      const migrated = Object.assign({}, parsed);
      migrated.providers = [{
        id: "default",
        providerName: parsed.providerName || "LocalAI",
        baseUrl: parsed.baseUrl || "http://localhost:8080",
        apiKey: parsed.apiKey || "",
        model: parsed.model || "",
        temperature: parsed.temperature !== undefined ? parsed.temperature : 0.2
      }];
      migrated.activeProviderId = "default";
      // Remove the now-relocated flat fields.
      delete migrated.providerName;
      delete migrated.baseUrl;
      delete migrated.apiKey;
      delete migrated.model;
      delete migrated.temperature;
      return migrated;
    }
    return parsed;
  }

  // Returns the currently active provider profile (or the first, or a
  // default), with the app-level requestTimeoutMs folded in. Every
  // provider.chat/chatStream/listModels/probeTools call takes this object as
  // its `settings` argument, so merging the timeout in here is what threads
  // it through all of them without touching each call site.
  function getActiveProvider(settings) {
    const list = Array.isArray(settings.providers) ? settings.providers : [];
    const base = list.length
      ? (list.filter(function (p) { return p.id === settings.activeProviderId; })[0] || list[0])
      : defaultProvider();
    const requestTimeoutMs = settings.requestTimeoutMs !== undefined
      ? settings.requestTimeoutMs : defaultSettings.requestTimeoutMs;
    return Object.assign({}, base, { requestTimeoutMs: requestTimeoutMs });
  }

  function init() {
    ensureDir(baseDir);
    ensureDir(chatsDir);
    ensureDir(backupsDir);

    if (!fs.existsSync(settingsFile)) {
      fs.writeFileSync(settingsFile, JSON.stringify(defaultSettings, null, 2), "utf8");
      try { fs.chmodSync(settingsFile, 0o600); } catch (e) { /* best-effort */ }
    }

    if (!fs.existsSync(auditFile)) {
      fs.writeFileSync(auditFile, "", "utf8");
    }
  }

  function getSettings() {
    init();

    try {
      const raw = fs.readFileSync(settingsFile, "utf8");
      const parsed = migrate(JSON.parse(raw));
      // Merge top-level app settings with defaults, but take the providers
      // list verbatim from the file (don't let defaults overwrite it).
      const merged = Object.assign({}, defaultSettings, parsed);
      if (Array.isArray(parsed.providers) && parsed.providers.length) {
        merged.providers = parsed.providers;
      }
      merged.systemPrompt = fixStaleSystemPrompt(merged.systemPrompt);
      return merged;
    } catch (err) {
      return Object.assign({}, defaultSettings, {
        _error: err.message
      });
    }
  }

  // options.trustConfirmation: pass true ONLY from /flowpilot/test or
  // /flowpilot/probe's own internal saveSettings call, right after a real
  // passing provider check — see reconcileProviderSecrets's own comment.
  // Every other caller (in particular the public POST /settings route)
  // omits this, so confirmedBaseUrl/confirmedAt stay strictly
  // server-computed and can never be set via a settings save.
  function saveSettings(settings, options) {
    init();

    let current = {};
    try {
      const raw = fs.readFileSync(settingsFile, "utf8");
      current = migrate(JSON.parse(raw));
    } catch (err) {
      current = {};
    }

    const merged = Object.assign({}, defaultSettings, current, settings || {});
    merged.systemPrompt = fixStaleSystemPrompt(merged.systemPrompt);
    delete merged._error;
    // If the caller sent a providers list, reconcile it against what's
    // actually stored (real apiKey/confirmedBaseUrl never come from the
    // client — see reconcileProviderSecrets above) rather than trusting it
    // outright the way Object.assign would.
    if (settings && Array.isArray(settings.providers)) {
      merged.providers = reconcileProviderSecrets(settings.providers, current.providers, !!(options && options.trustConfirmation));
    }
    // Saving settings is an explicit user action; mark first-run complete so
    // the welcome/warning stops showing.
    merged.firstRunAcknowledged = true;

    fs.writeFileSync(settingsFile, JSON.stringify(merged, null, 2), "utf8");
    try { fs.chmodSync(settingsFile, 0o600); } catch (e) { /* best-effort */ }

    return merged;
  }

  function appendAudit(entry) {
    init();

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry
    });

    fs.appendFileSync(auditFile, line + "\n", "utf8");
  }

  // Per-conversation transcripts: one JSON Lines file per conversation,
  // keyed by a frontend-generated conversationId. Callers must pass an
  // already-validated id (flowpilot.js's sanitizeConversationId) — this is
  // just file I/O.
  function transcriptFile(conversationId) {
    return path.join(chatsDir, `${conversationId}.jsonl`);
  }

  function appendTranscript(conversationId, entry) {
    init();
    const file = transcriptFile(conversationId);
    const isNewFile = !fs.existsSync(file);
    // Same 0600-on-append pattern as appendDebugLog below — transcripts hold
    // full conversation content, never world-readable even on first write.
    const fd = fs.openSync(file, "a", 0o600);
    fs.writeSync(fd, JSON.stringify(entry) + "\n");
    fs.closeSync(fd);
    if (isNewFile) {
      try { fs.chmodSync(file, 0o600); } catch (e) { /* best-effort */ }
    }
  }

  // Removes a conversation's transcript file (e.g. user deletes it from the
  // conversation list). Best-effort — a missing file is not an error.
  function deleteTranscript(conversationId) {
    init();
    try { fs.unlinkSync(transcriptFile(conversationId)); } catch (err) { /* already gone */ }
  }

  function readTranscript(conversationId) {
    init();
    const file = transcriptFile(conversationId);
    if (!fs.existsSync(file)) { return []; }

    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      return [];
    }

    return raw.split("\n").filter(Boolean).map(function (line) {
      try { return JSON.parse(line); } catch (err) { return null; }
    }).filter(Boolean);
  }

  // Used by Recall to search across OTHER conversations' transcripts. Lists
  // every persisted conversationId (one per chats/*.jsonl file).
  function listConversationIds() {
    init();
    let files;
    try {
      files = fs.readdirSync(chatsDir);
    } catch (err) {
      return [];
    }
    return files
      .filter(function (f) { return f.endsWith(".jsonl"); })
      .map(function (f) { return f.slice(0, -6); });
  }

  // Always the CURRENT contents of lib/default-system-prompt.js — never the
  // stale copy that may be persisted in settings.json. Lets the Settings UI
  // offer a "Reset to default" action that picks up prompt updates shipped
  // in later FlowPilot versions, even though a snapshot was saved once.
  function getDefaultSystemPrompt() {
    return defaultSettings.systemPrompt;
  }

  const debugLogFile = path.join(baseDir, "debug.log");

  // Append one JSON-lines entry to debug.log.
  // Written 0600 — diagnostic data, never world-readable.
  // Auth keys are NOT included (only baseUrl + model from the provider
  // profile, never apiKey). The bytes logged are post-redaction: the same
  // content the provider actually received.
  function appendDebugLog(entry) {
    init();
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry
    });
    try {
      // Open with O_APPEND | O_CREAT, mode 0600 so secrets never land
      // in a world-readable file even on first write.
      const fd = fs.openSync(debugLogFile, "a", 0o600);
      fs.writeSync(fd, line + "\n");
      fs.closeSync(fd);
      // Ensure 0600 regardless of umask on subsequent opens.
      fs.chmodSync(debugLogFile, 0o600);
    } catch (err) {
      console.error("[FlowPilot] debug log write failed:", err.message);
    }
  }

  init();

  return {
    baseDir,
    chatsDir,
    backupsDir,
    settingsFile,
    auditFile,
    debugLogFile,
    getSettings,
    saveSettings,
    getActiveProvider,
    getDefaultSystemPrompt,
    appendAudit,
    appendDebugLog,
    appendTranscript,
    readTranscript,
    deleteTranscript,
    listConversationIds
  };
}

// Static, instance-independent — flowpilot.js's route handlers need the
// exact same sentinel string that reconcileProviderSecrets checks against
// above, without needing a storage instance to get it.
createStorage.API_KEY_UNCHANGED = API_KEY_UNCHANGED;

module.exports = createStorage;
