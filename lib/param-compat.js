"use strict";

// Shared, provider-aware request compatibility. This module deliberately has
// no storage or HTTP dependencies: adapters supply request builders/senders,
// while flowpilot.js supplies the persistence hook.

const TOOLS_UNSUPPORTED_MESSAGE = "This model can't use function tools through OpenAI's Chat Completions API (OpenAI requires the Responses API for it). FlowPilot's agent features need a model that can; chat still works.";

let compatHook = null;
const learned = new Map();

function setCompatHook(fn) {
  compatHook = typeof fn === "function" ? fn : null;
}

function normalizeBase(baseUrl) {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) { return ""; }
  try {
    const url = new URL(raw);
    return url.protocol.toLowerCase() + "//" + url.host.toLowerCase() + url.pathname.replace(/\/+$/, "") + url.search;
  } catch (err) {
    return raw.toLowerCase();
  }
}

function keyFor(baseUrl, model) {
  return normalizeBase(baseUrl) + "|" + String(model || "");
}

function emptyEntry() {
  return {
    omit: [],
    maxTokensParam: undefined,
    toolsReasoningNone: false,
    toolsUnsupported: false,
    toolChoiceAuto: false,
    learnedAt: undefined
  };
}

function cloneEntry(entry) {
  const out = emptyEntry();
  if (entry && typeof entry === "object") {
    if (Array.isArray(entry.omit)) { out.omit = entry.omit.slice(); }
    if (typeof entry.maxTokensParam === "string") { out.maxTokensParam = entry.maxTokensParam; }
    out.toolsReasoningNone = entry.toolsReasoningNone === true;
    out.toolsUnsupported = entry.toolsUnsupported === true;
    out.toolChoiceAuto = entry.toolChoiceAuto === true;
    if (typeof entry.learnedAt === "string") { out.learnedAt = entry.learnedAt; }
  }
  return out;
}

function getEntry(vendor, baseUrl, model, stored) {
  const key = keyFor(baseUrl, model);
  const memory = learned.get(key);
  return cloneEntry(memory || stored || emptyEntry());
}

function resetCompat(vendor, baseUrl, model) {
  // vendor is accepted to keep the call site explicit; the key is shared so
  // a provider's URL/model pair cannot acquire two contradictory entries.
  void vendor;
  learned.delete(keyFor(baseUrl, model));
}

function isOpenAiError(errorObj) {
  return !!(errorObj && typeof errorObj === "object" &&
    (errorObj.type === "invalid_request_error" || errorObj.code || errorObj.param));
}

function classify(vendor, status, errorObj) {
  if (status !== 400 || !errorObj || typeof errorObj !== "object") { return null; }
  const message = typeof errorObj.message === "string" ? errorObj.message : "";
  const lower = message.toLowerCase();

  if (vendor === "openai") {
    if (!isOpenAiError(errorObj)) { return null; }
    const param = typeof errorObj.param === "string" ? errorObj.param : "";
    const code = typeof errorObj.code === "string" ? errorObj.code.toLowerCase() : "";

    if (param === "max_tokens" && (code === "unsupported_parameter" || lower.indexOf("max_completion_tokens") !== -1)) {
      return { kind: "translate", from: "max_tokens", to: "max_completion_tokens" };
    }
    if (param === "temperature" && (code === "unsupported_value" || code === "unsupported_parameter")) {
      return { kind: "drop", param: "temperature" };
    }
    if (param === "reasoning_effort" && /function\s+tools?/i.test(message)) {
      return { kind: "set", param: "reasoning_effort", value: "none", toolsOnly: true };
    }
    if (param === "reasoning_effort" && lower.indexOf("none") !== -1 &&
        (lower.indexOf("unsupported") !== -1 || lower.indexOf("not support") !== -1 || lower.indexOf("does not support") !== -1)) {
      return { kind: "toolsUnsupported" };
    }
    return null;
  }

  if (vendor === "anthropic") {
    const param = typeof errorObj.param === "string" ? errorObj.param : "";
    if (lower.indexOf("temperature") !== -1 && /and\s+`?top_p/.test(lower) &&
        lower.indexOf("cannot both") !== -1) {
      return { kind: "drop", param: "top_p" };
    }
    if (lower.indexOf("tool_choice") !== -1 && lower.indexOf("not supported") !== -1 &&
        (lower.indexOf('type "tool"') !== -1 || lower.indexOf('type "any"') !== -1)) {
      return { kind: "toolChoiceAuto" };
    }
    if (lower.indexOf("extra inputs are not permitted") !== -1) {
      const samplingParam = param || (lower.indexOf("top_p") !== -1 ? "top_p" :
        lower.indexOf("top_k") !== -1 ? "top_k" : "temperature");
      if (["temperature", "top_p", "top_k"].indexOf(samplingParam) !== -1) {
        return { kind: "drop", param: samplingParam };
      }
    }
    if (lower.indexOf("temperature") !== -1 && lower.indexOf("deprecated") !== -1) {
      return { kind: "drop", param: "temperature" };
    }
  }

  return null;
}

function hasOmit(entry, param) {
  return Array.isArray(entry && entry.omit) && entry.omit.indexOf(param) !== -1;
}

function applyCompat(vendor, body, entry, ctx) {
  body = body || {};
  entry = entry || emptyEntry();
  ctx = ctx || {};

  (Array.isArray(entry.omit) ? entry.omit : []).forEach(function (param) {
    delete body[param];
  });

  if (vendor === "openai" && entry.maxTokensParam === "max_completion_tokens" &&
      body.max_tokens !== undefined && body.max_completion_tokens === undefined) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  } else if (vendor === "openai" && entry.maxTokensParam === "max_tokens" &&
      body.max_completion_tokens !== undefined && body.max_tokens === undefined) {
    body.max_tokens = body.max_completion_tokens;
    delete body.max_completion_tokens;
  }

  if (vendor === "openai" && entry.toolsReasoningNone && ctx.hasTools) {
    body.reasoning_effort = "none";
  }
  if (vendor === "anthropic" && entry.toolChoiceAuto && body.tool_choice) {
    body.tool_choice = { type: "auto" };
  }
  return body;
}

function applyFix(entry, fix) {
  if (!entry || !fix) { return; }
  if (fix.kind === "drop") {
    if (!Array.isArray(entry.omit)) { entry.omit = []; }
    if (entry.omit.indexOf(fix.param) === -1) { entry.omit.push(fix.param); }
  } else if (fix.kind === "translate") {
    entry.maxTokensParam = fix.to;
  } else if (fix.kind === "set") {
    if (fix.param === "reasoning_effort" && fix.value === "none") {
      entry.toolsReasoningNone = true;
    }
  } else if (fix.kind === "toolsUnsupported") {
    entry.toolsUnsupported = true;
  } else if (fix.kind === "toolChoiceAuto") {
    entry.toolChoiceAuto = true;
  }
  entry.learnedAt = new Date().toISOString();
}

function describe(entry) {
  entry = entry || emptyEntry();
  const out = [];
  (Array.isArray(entry.omit) ? entry.omit : []).forEach(function (param) {
    if (param === "temperature") {
      out.push("temperature omitted (model only accepts its default)");
    } else {
      out.push(param + " omitted");
    }
  });
  if (entry.maxTokensParam === "max_completion_tokens") {
    out.push("max_tokens sent as max_completion_tokens");
  }
  if (entry.toolsReasoningNone) { out.push("reasoning_effort: none for tool calls"); }
  if (entry.toolChoiceAuto) { out.push("tool_choice forced → auto"); }
  if (entry.toolsUnsupported) { out.push("tools not available through this API"); }
  return out;
}

function isOfficialOpenAI(baseUrl) {
  try {
    return new URL(String(baseUrl || "").trim()).hostname.toLowerCase() === "api.openai.com";
  } catch (err) {
    return false;
  }
}

function raisedLimit(limit) {
  return Math.min(Math.max((limit || 4096) * 4, 16384), 32768);
}

async function runWithCompat(options) {
  options = options || {};
  const vendor = options.vendor;
  const entry = options.entry || emptyEntry();
  const mode = options.mode === "discover" ? "discover" : "normal";
  const maxFixes = mode === "discover" ? 4 : 1;
  const attempted = new Set();
  let fixCount = 0;
  let body = null;

  async function sendOnce(overrides) {
    body = options.build(entry, overrides || {});
    return options.send(body);
  }

  let result;
  while (true) {
    try {
      result = await sendOnce({});
      break;
    } catch (err) {
      const fix = classify(vendor, err && err.status, err && err.providerError);
      if (!fix || attempted.has(fix.kind)) { throw err; }
      if (fix.kind === "set" && fix.toolsOnly && !options.hasTools) { throw err; }
      if (fix.kind === "toolsUnsupported") {
        if (!options.hasTools || !entry.toolsReasoningNone) { throw err; }
        attempted.add(fix.kind);
        applyFix(entry, fix);
        if (options.onLearn) { await options.onLearn(entry, fix); }
        throw new Error(TOOLS_UNSUPPORTED_MESSAGE);
      }
      if (fixCount >= maxFixes) { throw err; }
      attempted.add(fix.kind);
      applyFix(entry, fix);
      if (options.onLearn) { await options.onLearn(entry, fix); }
      fixCount++;
    }
  }

  if (options.isEmptyLengthCut && options.isEmptyLengthCut(result)) {
    const raised = raisedLimit(options.limitOf ? options.limitOf(body) : undefined);
    const retry = await sendOnce({ maxTokens: raised });
    if (retry && typeof retry === "object") {
      retry.compatNotes = ["length limit raised to " + raised + " after an empty cut-off reply"];
    }
    return retry;
  }
  return result;
}

function notifyLearn(settings, entry, fix, options) {
  const baseUrl = options && options.baseUrl !== undefined ? options.baseUrl : settings.baseUrl;
  const model = settings.model;
  learned.set(keyFor(baseUrl, model), cloneEntry(entry));
  if (!settings.paramCompat || typeof settings.paramCompat !== "object") { settings.paramCompat = {}; }
  settings.paramCompat[model] = cloneEntry(entry);
  if (settings._compatPersist === false) { return; }
  if (compatHook) {
    compatHook({
      providerId: settings.id,
      providerName: settings.providerName,
      model: model,
      baseUrl: baseUrl,
      entry: cloneEntry(entry),
      fix: Object.assign({}, fix),
      persist: settings._compatPersist !== false
    });
  }
}

module.exports = {
  TOOLS_UNSUPPORTED_MESSAGE,
  setCompatHook,
  normalizeBase,
  getEntry,
  resetCompat,
  classify,
  applyCompat,
  describe,
  isOfficialOpenAI,
  raisedLimit,
  runWithCompat,
  applyFix,
  notifyLearn,
  hasOmit
};
