const fs = require("fs");
const path = require("path");
const { presetIdForExistingProvider } = require("./provider-presets");

const RETIRED_SETTING_KEYS = ["defaultContextMode", "enableAgentWrite", "buildEngine", "loopHoldStep", "showHelperButtons"];
const BUILTIN_SLASH_COMMANDS = [
  "generate", "document", "modify", "build", "plan", "chat", "query", "clear",
  "history", "settings", "compact", "expand", "disable", "enable", "refresh", "debug",
  "summarize", "demo", "help", "?", "bug", "feedback", "beta"
];

function savedPromptSlug(label) {
  const text = String(label === undefined || label === null ? "prompt" : label)
    .trim().toLowerCase().replace(/^\/+/, "");
  const slug = text.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "prompt";
}

function uniqueSavedPromptName(rawName, fallback, taken) {
  const raw = String(rawName === undefined || rawName === null ? "" : rawName)
    .trim().toLowerCase().replace(/^\/+/, "");
  let base = (raw ? raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : "") || fallback;
  if (BUILTIN_SLASH_COMMANDS.indexOf(base) !== -1) { base += "-prompt"; }
  let name = "/" + base;
  let suffix = 2;
  while (taken[name] || BUILTIN_SLASH_COMMANDS.indexOf(name.slice(1)) !== -1) {
    name = "/" + base + "-" + suffix++;
  }
  taken[name] = true;
  return name;
}

function normalizeSavedPrompts(rawPrompts, customIntents) {
  const prompts = [];
  const taken = {};
  const input = Array.isArray(rawPrompts) ? rawPrompts : [];
  input.forEach(function (prompt, index) {
    if (!prompt || typeof prompt !== "object") { return; }
    const text = prompt.text === undefined || prompt.text === null ? "" : String(prompt.text);
    const fallback = savedPromptSlug(prompt.name || "prompt-" + (index + 1));
    prompts.push({
      name: uniqueSavedPromptName(prompt.name, fallback, taken),
      text: text
    });
  });
  const usedExisting = {};
  (Array.isArray(customIntents) ? customIntents : []).forEach(function (intent, index) {
    const item = intent && typeof intent === "object" ? intent : { label: intent, text: "" };
    const label = item.label === undefined || item.label === null ? "prompt-" + (index + 1) : item.label;
    const text = item.text === undefined || item.text === null ? "" : String(item.text);
    const base = savedPromptSlug(label);
    const expectedBase = BUILTIN_SLASH_COMMANDS.indexOf(base) !== -1 ? base + "-prompt" : base;
    const existingIndex = prompts.findIndex(function (prompt, promptIndex) {
      return !usedExisting[promptIndex] && prompt.text === text &&
        (prompt.name === "/" + expectedBase || prompt.name.indexOf("/" + expectedBase + "-") === 0);
    });
    if (existingIndex !== -1) {
      usedExisting[existingIndex] = true;
      return;
    }
    prompts.push({
      name: uniqueSavedPromptName("", base, taken),
      text: text
    });
  });
  return prompts;
}

function removeRetiredSettings(settings) {
  const clean = Object.assign({}, settings || {});
  RETIRED_SETTING_KEYS.forEach(function (key) { delete clean[key]; });
  return clean;
}

// 0.6.3 §2C migration: every saved provider gets a presetId with ZERO
// behavior change to any other field — an existing "anthropic"-type
// provider maps to the "anthropic" preset, everything else maps to
// "custom" (never to a named preset like "openai"/"openrouter", since a
// pre-existing provider's own baseUrl/etc. must be left exactly as the
// user configured it, not silently reinterpreted as matching a preset's
// own defaults). A provider that already carries a presetId (created
// through the new preset-aware UI, or already migrated once) is left
// untouched.
function normalizePresetId(p) {
  if (p && typeof p.presetId === "string" && p.presetId) { return p; }
  return Object.assign({}, p, { presetId: presetIdForExistingProvider(p) });
}

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

function normalizeRoutingTier(raw) {
  const tier = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return tier === "A" || tier === "B" || tier === "C" ? tier : "A";
}

// 0.6.4 (ADR-013, "Auto capability routing"): whether a provider's tier is
// hand-picked ("manual", stored routingTier applies as-is) or derived live
// from the Pre-flight check's own tool-calling probe ("auto" — the default;
// see normalizedRoutingTier in flowpilot.js). Migration: a provider that
// already carries a deliberate non-default tier (B or C) was clearly
// hand-configured by someone who understood the old dropdown — preserve
// that as "manual" so upgrading never silently changes its behavior. A
// provider sitting on the untouched old universal default ("A") migrates to
// "auto" instead, since that default was never a deliberate choice and, for
// a tool-incapable model, silently left it with zero agentic capability —
// auto mode is a straight bug fix for that case, not a behavior change
// anyone was relying on.
function normalizeRoutingTierMode(raw, priorTier) {
  if (raw === "manual") { return "manual"; }
  if (raw === "auto") { return "auto"; }
  const tier = typeof priorTier === "string" ? priorTier.trim().toUpperCase() : "";
  return (tier === "B" || tier === "C") ? "manual" : "auto";
}

// Combines the two normalizers above into the pair of fields every call
// site needs — reads raw p.routingTier/p.routingTierMode and returns both
// normalized, ready to Object.assign onto the provider being built.
function normalizeRoutingFields(p) {
  const routingTier = normalizeRoutingTier(p && p.routingTier);
  const routingTierMode = normalizeRoutingTierMode(p && p.routingTierMode, routingTier);
  return { routingTier: routingTier, routingTierMode: routingTierMode };
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
    Object.assign(next, normalizeRoutingFields(next));

    // The Settings form does not need to round-trip learned compatibility
    // data. Keep the stored per-model record when an older/client payload
    // omits it entirely.
    if ((!Object.prototype.hasOwnProperty.call(p, "paramCompat") || p.paramCompat === undefined) && prior && prior.paramCompat) {
      next.paramCompat = prior.paramCompat;
    }

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
      presetId: "localai",
      baseUrl: "http://localhost:8080",
      apiKey: "",
      model: "",
      // Model-tier routing profile (see normalizedRoutingTier, flowpilot.js).
      // "auto" (default) derives the effective tier from the Pre-flight
      // check's own tool-calling probe; routingTier here is only consulted
      // when routingTierMode is "manual".
      routingTier: "A",
      routingTierMode: "auto",
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
    // ADR-015: automatically dispatch safe, resolved changes; users can
    // turn this off to make every change land in the Plan lane.
    auto: true,
    // ADR-015 §2.9: keep deploy tools and client deploy actions disabled.
    restricted: false,
    // Hard output bound for each tool-capable agent turn. Classic completions
    // remain uncapped so ordinary flow envelopes are never silently clipped.
    agentTurnMaxTokens: 4096,
    // Cumulative token budget across one read/write tool-calling turn
    // before stopping with an honest error instead of continuing forever.
    // User-configurable since "reasonable" varies by provider context
    // window. Unrelated to agentTurnMaxTokens above, which caps one
    // individual model response's output length, not the running total.
    agentLoopTokenCeiling: 50000,
    agentLoopTokenCeilingUserSet: false,
    agentLoopTokenCeilingUserSetV2: false,
    // Max build->deploy->test->fix cycles the /build agentic loop will run
    // before stopping with an honest "couldn't fully verify" instead of
    // proposing another fix. Bounds against a non-converging loop burning
    // tokens forever; user-configurable since "reasonable" varies by
    // provider speed/cost. Unrelated to the read-only tool-calling loop's
    // own hardcoded AGENT_LOOP_MAX_STEPS (a different bound, for a
    // different loop).
    agentLoopMaxIterations: 5,
    // Routes Generate through the Phase 10 step-queue engine (graph read-back
    // verification after import). The legacy path remains available when a
    // user explicitly disables this setting.
    enableStepQueue: true,
    // Maximum number of changed nodes before the diff gate pauses for review.
    diffGateThreshold: 5,
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
    // User-defined slash prompts: array of { name, text }.
    savedPrompts: [],
    // Set after the one-time custom-intent migration notice is shown.
    savedPromptsMigrationNoticeShown: false,
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
    parsed = removeRetiredSettings(parsed);
    if (Array.isArray(parsed.providers) && parsed.providers.length) {
      // 0.2 was the old built-in default; clear it so the model's own default applies.
      parsed = Object.assign({}, parsed);
      parsed.providers = parsed.providers.map(function (provider) {
        const next = Object.assign({}, provider);
        if (next.temperature === 0.2) { delete next.temperature; }
        return next;
      });
    } else if (parsed.providerName || parsed.baseUrl || parsed.model) {
      const migrated = Object.assign({}, parsed);
      migrated.providers = [{
        id: "default",
        providerName: parsed.providerName || "LocalAI",
        baseUrl: parsed.baseUrl || "http://localhost:8080",
        apiKey: parsed.apiKey || "",
        model: parsed.model || "",
        routingTier: normalizeRoutingTier(parsed.routingTier),
        routingTierMode: normalizeRoutingTierMode(parsed.routingTierMode, parsed.routingTier)
      }];
      if (typeof parsed.temperature === "number" && parsed.temperature !== 0.2) {
        migrated.providers[0].temperature = parsed.temperature;
      }
      migrated.activeProviderId = "default";
      // Remove the now-relocated flat fields.
      delete migrated.providerName;
      delete migrated.baseUrl;
      delete migrated.apiKey;
      delete migrated.model;
      delete migrated.temperature;
      parsed = migrated;
    }
    if (Array.isArray(parsed.customIntents)) {
      if (parsed._customIntentsMigrated !== true) {
        parsed.savedPrompts = normalizeSavedPrompts(parsed.savedPrompts, parsed.customIntents);
        parsed._customIntentsMigrated = true;
      }
    } else if (Array.isArray(parsed.savedPrompts)) {
      parsed.savedPrompts = normalizeSavedPrompts(parsed.savedPrompts, []);
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
      writeSettingsFile(defaultSettings);
    }

    if (!fs.existsSync(auditFile)) {
      fs.writeFileSync(auditFile, "", "utf8");
    }
  }

  // Settings migrations must not turn a failed write into a truncated
  // profile. Write beside the real file, then rename only after the complete
  // JSON document is on disk; the old file remains intact on any failure.
  function writeSettingsFile(settings) {
    const tempFile = settingsFile + ".tmp-" + process.pid + "-" + Date.now();
    try {
      fs.writeFileSync(tempFile, JSON.stringify(settings, null, 2), "utf8");
      try { fs.chmodSync(tempFile, 0o600); } catch (e) { /* best-effort */ }
      fs.renameSync(tempFile, settingsFile);
      try { fs.chmodSync(settingsFile, 0o600); } catch (e) { /* best-effort */ }
    } catch (err) {
      try { fs.unlinkSync(tempFile); } catch (e) { /* best-effort */ }
      throw err;
    }
  }

  function getSettings() {
    init();

    try {
      const raw = fs.readFileSync(settingsFile, "utf8");
      const original = JSON.parse(raw);
      const parsed = migrate(original);
      if (JSON.stringify(original) !== JSON.stringify(parsed)) {
        // Best-effort: a read must never fail because the migrated copy
        // couldn't be written (read-only or full disk). The migration simply
        // runs again on the next read; settings are still served from it.
        try { writeSettingsFile(parsed); } catch (e) {
          console.warn("[FlowPilot] settings migration not saved: " + e.message);
        }
      }
      // Merge top-level app settings with defaults, but take the providers
      // list verbatim from the file (don't let defaults overwrite it).
      const merged = removeRetiredSettings(Object.assign({}, defaultSettings, parsed));
      delete merged._customIntentsMigrated;
      if (Array.isArray(parsed.providers) && parsed.providers.length) {
        merged.providers = parsed.providers.map(function (p) {
          return normalizePresetId(Object.assign({}, p, normalizeRoutingFields(p)));
        });
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

    const incoming = settings || {};
    const merged = removeRetiredSettings(Object.assign({}, defaultSettings, current, incoming));
    if (Array.isArray(incoming.savedPrompts)) {
      merged.savedPrompts = normalizeSavedPrompts(incoming.savedPrompts, []);
      // C2: customIntents is retained in the file until the POST containing
      // the converted prompts has actually been written successfully. The
      // delete occurs below, after all validation and before the atomic write.
      delete merged.customIntents;
    } else if (Array.isArray(current.customIntents)) {
      merged.savedPrompts = normalizeSavedPrompts(merged.savedPrompts, current.customIntents);
    }
    merged.systemPrompt = fixStaleSystemPrompt(merged.systemPrompt);
    delete merged._error;
    // If the caller sent a providers list, reconcile it against what's
    // actually stored (real apiKey/confirmedBaseUrl never come from the
    // client — see reconcileProviderSecrets above) rather than trusting it
    // outright the way Object.assign would.
    if (settings && Array.isArray(settings.providers)) {
      merged.providers = reconcileProviderSecrets(settings.providers, current.providers, !!(options && options.trustConfirmation))
        .map(function (p) {
          return normalizePresetId(Object.assign({}, p, normalizeRoutingFields(p)));
        });
    } else if (Array.isArray(merged.providers)) {
      merged.providers = merged.providers.map(function (p) {
        return normalizePresetId(Object.assign({}, p, normalizeRoutingFields(p)));
      });
    }
    // Saving settings is an explicit user action; mark first-run complete so
    // the welcome/warning stops showing.
    merged.firstRunAcknowledged = true;
    delete merged._savedPromptsMigrationPending;
    delete merged._customIntentsMigrated;

    writeSettingsFile(merged);

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
