const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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
      baseUrl: "http://localhost:8080",
      apiKey: "",
      model: "",
      temperature: 0.2
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
    logFullContext: false,
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
    // Lets the user silence the recurring secrets/size reminder bar after
    // typing an explicit acknowledgement in settings.
    suppressContextWarnings: false,
    // Secret-shaped-value scrubbing (password/token/apiKey-looking fields in
    // node config and debug output) — on by default. Local/private-AI users
    // can turn it off via a separate type-to-confirm gate in Settings; the
    // dedicated Node-RED credentials field is dropped by the frontend
    // regardless of this setting, via a different, always-on mechanism.
    redactionEnabled: true,
    // Chat-only persona slider, 1-10: 1 is a plain Node-RED engineer, 10 is
    // a comically over-the-top airline captain who happens to be a Node-RED
    // expert. 3 matches the original "subtle co-pilot" voice this replaced.
    // See lib/persona-prompt.js — generated fresh per request, never baked
    // into the persisted systemPrompt below.
    personaIntensity: 3,
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

  function saveSettings(settings) {
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
    // If the caller sent a providers list, it wins outright (Object.assign
    // already did this, but be explicit for clarity/safety).
    if (settings && Array.isArray(settings.providers)) {
      merged.providers = settings.providers;
    }
    // Saving settings is an explicit user action; mark first-run complete so
    // the welcome/warning stops showing.
    merged.firstRunAcknowledged = true;

    fs.writeFileSync(settingsFile, JSON.stringify(merged, null, 2), "utf8");

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
    fs.appendFileSync(transcriptFile(conversationId), JSON.stringify(entry) + "\n", "utf8");
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

  init();

  return {
    baseDir,
    chatsDir,
    backupsDir,
    settingsFile,
    auditFile,
    getSettings,
    saveSettings,
    getActiveProvider,
    getDefaultSystemPrompt,
    appendAudit,
    appendTranscript,
    readTranscript,
    deleteTranscript,
    listConversationIds
  };
}

module.exports = createStorage;