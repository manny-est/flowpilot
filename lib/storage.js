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
    streamingEnabled: false,
    // First-run welcome/warning shows until the user saves settings once.
    firstRunAcknowledged: false,
    // Context-size advisory thresholds, in estimated tokens (~chars/4).
    // Advisory only; never blocks sending.
    contextWarnTokens: 4000,
    contextHighTokens: 8000,
    // Phase 6: how many recent chat exchanges (user+assistant pairs) the
    // frontend includes as history with each request. Older turns are
    // dropped client-side and the model is told when that happened.
    historyMaxExchanges: 10,
    // Lets the user silence the recurring secrets/size reminder bar after
    // typing an explicit acknowledgement in settings.
    suppressContextWarnings: false,
    // User-defined intent buttons: array of { label, text }.
    customIntents: [],
    systemPrompt: require("./default-system-prompt")
  };

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

  // Returns the currently active provider profile (or the first, or a default).
  function getActiveProvider(settings) {
    const list = Array.isArray(settings.providers) ? settings.providers : [];
    if (!list.length) { return defaultProvider(); }
    const found = list.filter(function (p) { return p.id === settings.activeProviderId; })[0];
    return found || list[0];
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

  function saveChatLog(entry) {
    init();

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(chatsDir, `${stamp}.json`);

    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          ...entry
        },
        null,
        2
      ),
      "utf8"
    );

    return file;
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
    appendAudit,
    saveChatLog
  };
}

module.exports = createStorage;