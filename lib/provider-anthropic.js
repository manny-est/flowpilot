const https = require("https");
const http = require("http");
const { isModelsListShaped } = require("./provider-shape-check");
const compat = require("./param-compat");
const providerErrors = require("./provider-errors");

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;

// ---- temperature-deprecated detection (GitHub #9) ----
// Models released after Claude Opus 4.6 reject any temperature value other
// than 1.0 (Anthropic's own Messages API docs) — FlowPilot's default is 0.2,
// so every request against a newer model fails outright with no reactive
// handling. No model-name allowlist or version parsing: detect the actual
// error shape live and adapt. In-memory only (module scope, keyed by model
// name) — resets on a server restart, which is an acceptable, deliberate
// simplification for a hotfix; the storage-backed persistence
// `supportsTools` uses would need threading through every one of this
// module's ~8 call sites in flowpilot.js and isn't worth that churn for a
// per-process cache that already makes this a one-time cost per model for
// the life of the running server.
function sanitizedProviderError(errorObj) {
  if (!errorObj || typeof errorObj !== "object") { return null; }
  return {
    type: typeof errorObj.type === "string" ? errorObj.type.slice(0, 300) : "",
    message: typeof errorObj.message === "string" ? errorObj.message.slice(0, 300) : ""
  };
}

function mapStopReason(reason) {
  if (reason === "max_tokens") { return "length"; }
  if (reason === "tool_use") { return "tool_calls"; }
  if (reason === "end_turn" || reason === "stop_sequence") { return "stop"; }
  return reason || null;
}

// ---- HTTP helpers ----

function postJson(urlString, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (err) { reject(new Error("Invalid provider URL: " + urlString)); return; }

    const payload = JSON.stringify(body);
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request({
      method: "POST",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, headers || {})
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (err) {
          // Never echo the raw upstream body — see the matching comment in
          // provider-openai-compatible.js (ADR-007, the SSRF mitigation).
          reject(new Error("Provider returned a non-JSON response (status " + res.statusCode + ")."));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const normalized = providerErrors.normalizeProviderError(parsed || data, res.statusCode);
          const error = new Error(normalized.message);
          error.status = res.statusCode;
          error.raw = normalized.raw;
          if (parsed && parsed.error) { error.providerError = sanitizedProviderError(parsed.error); }
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs || 180000, () => {
      req.destroy(new Error("Provider request timed out after " + (timeoutMs || 180000) + "ms — increase the request timeout in Settings → Behavior for slower hardware."));
    });
    req.write(payload);
    req.end();
  });
}

function getJson(urlString, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (err) { reject(new Error("Invalid provider URL: " + urlString)); return; }

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request({
      method: "GET",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: headers || {}
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (err) {
          reject(new Error("Provider returned a non-JSON response (status " + res.statusCode + ")."));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const normalized = providerErrors.normalizeProviderError(parsed || data, res.statusCode);
          const error = new Error(normalized.message);
          error.status = res.statusCode;
          error.raw = normalized.raw;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs || 30000, () => {
      req.destroy(new Error("Timeout"));
    });
    req.end();
  });
}

function postStream(urlString, headers, body, timeoutMs, onDelta, onReasoningDelta) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (err) { reject(new Error("Invalid provider URL: " + urlString)); return; }

    const payload = JSON.stringify(body);
    const transport = url.protocol === "https:" ? https : http;
    const startedAt = Date.now();
    let firstTokenAt = null;
    let usage = null;
    let full = "";
    let stopReason = null;
    let hadDeltas = false;

    const req = transport.request({
      method: "POST",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, headers || {})
    }, (res) => {
      res.setEncoding("utf8");
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // Capture the error body (same shape as postJson's non-2xx path)
        // so callers can detect a specific error type (e.g. the
        // temperature-deprecated case below) — this stays internal to the
        // retry decision, never echoed to the HTTP client as the raw body
        // (same ADR-007 boundary postJson already holds).
        let errBody = "";
        res.on("data", (chunk) => {
          if (errBody.length < 8192) { errBody += String(chunk).slice(0, 8192 - errBody.length); }
        });
        res.on("end", () => {
          let parsed = null;
          try { parsed = errBody ? JSON.parse(errBody) : null; } catch (e) { /* fall through to generic message */ }
          const normalized = providerErrors.normalizeProviderError(parsed || errBody, res.statusCode);
          const error = new Error(normalized.message);
          error.status = res.statusCode;
          error.raw = normalized.raw;
          if (parsed && parsed.error) { error.providerError = sanitizedProviderError(parsed.error); }
          reject(error);
        });
        return;
      }

      let sseBuf = "";
      res.on("data", (chunk) => {
        sseBuf += chunk;
        const lines = sseBuf.split("\n");
        sseBuf = lines.pop();
        lines.forEach((line) => {
          line = line.trim();
          if (!line.startsWith("data:")) { return; }
          const dataStr = line.slice(5).trim();
          if (!dataStr) { return; }
          let evt;
          try { evt = JSON.parse(dataStr); } catch (e) { return; }

          // Anthropic SSE event types used here:
          // message_start: carries input_tokens
          // content_block_delta: text_delta or thinking_delta
          // message_delta: carries output_tokens
          if (evt.type === "message_start" && evt.message && evt.message.usage) {
            usage = { prompt_tokens: evt.message.usage.input_tokens || 0, completion_tokens: 0 };
          } else if (evt.type === "content_block_delta" && evt.delta) {
            if (evt.delta.type === "text_delta" && evt.delta.text) {
              if (firstTokenAt === null) { firstTokenAt = Date.now(); }
              full += evt.delta.text;
              hadDeltas = true;
              onDelta(evt.delta.text);
            } else if (evt.delta.type === "thinking_delta" && evt.delta.thinking && onReasoningDelta) {
              hadDeltas = true;
              onReasoningDelta(evt.delta.thinking);
            }
          } else if (evt.type === "message_delta" && evt.usage) {
            if (usage) { usage.completion_tokens = evt.usage.output_tokens || 0; }
            else { usage = { prompt_tokens: 0, completion_tokens: evt.usage.output_tokens || 0 }; }
          }
          if (evt && evt.delta && evt.delta.stop_reason) { stopReason = evt.delta.stop_reason; }
        });
      });
      res.on("end", () => {
        resolve({
          content: full,
          ttftMs: firstTokenAt !== null ? firstTokenAt - startedAt : null,
          totalMs: Date.now() - startedAt,
          usage: usage,
          finishReason: mapStopReason(stopReason),
          hadDeltas: hadDeltas
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs || 180000, () => {
      req.destroy(new Error("Provider request timed out after " + (timeoutMs || 180000) + "ms — increase the request timeout in Settings → Behavior for slower hardware."));
    });
    req.write(payload);
    req.end();
  });
}

// ---- Message format conversion ----

// OpenAI {type:"function", function:{name,description,parameters}} →
// Anthropic {name, description, input_schema}
function toAnthropicTool(tool) {
  const fn = tool && tool.function;
  if (!fn) { return null; }
  return {
    name: fn.name,
    description: fn.description || "",
    input_schema: fn.parameters || { type: "object", properties: {} }
  };
}

// Anthropic {type:"tool_use", id, name, input} →
// OpenAI {id, type:"function", function:{name, arguments:string}}
function toOpenAiToolCall(block) {
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input || {})
    }
  };
}

// Convert an OpenAI-shaped messages array to Anthropic format.
// Returns { system: string, messages: [...] }
//
// - role:"system" messages are extracted and concatenated into top-level system param
// - role:"assistant" + tool_calls converted to Anthropic tool_use content blocks
// - role:"tool" results converted and grouped into user messages with tool_result blocks
// - role:"user" and plain role:"assistant" pass through unchanged
function convertMessages(messages) {
  const systemParts = [];
  const converted = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "system") {
      if (typeof msg.content === "string" && msg.content) {
        systemParts.push(msg.content);
      }
      continue;
    }

    // Group consecutive tool result messages into one user message
    if (msg.role === "tool") {
      const toolResults = [];
      while (i < messages.length && messages[i].role === "tool") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: messages[i].tool_call_id,
          content: messages[i].content || ""
        });
        i++;
      }
      i--; // outer loop will increment
      converted.push({ role: "user", content: toolResults });
      continue;
    }

    // Assistant with tool_calls → Anthropic tool_use content blocks
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const content = [];
      if (msg.content) { content.push({ type: "text", text: msg.content }); }
      msg.tool_calls.forEach(function (tc) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || "{}"); } catch (e) {}
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: input });
      });
      converted.push({ role: "assistant", content: content });
      continue;
    }

    converted.push({ role: msg.role, content: msg.content });
  }

  return { system: systemParts.join("\n\n"), messages: converted };
}

function anthropicHeaders(settings) {
  return {
    "x-api-key": settings.apiKey || "",
    "anthropic-version": ANTHROPIC_VERSION
  };
}

function resolveBaseUrl(settings) {
  return String(settings.baseUrl || ANTHROPIC_API_BASE).replace(/\/+$/, "") || ANTHROPIC_API_BASE;
}

function buildAnthropicBody(settings, anthropicMessages, system, options, entry, stream, overrides) {
  options = options || {};
  overrides = overrides || {};
  // Chat and agent turns keep 0.6.4's fixed limit; only the probe and the
  // empty-cut-off retry pass an explicit override.
  const configuredMax = DEFAULT_MAX_TOKENS;
  const body = {
    model: settings.model,
    messages: anthropicMessages,
    max_tokens: overrides.maxTokens !== undefined ? overrides.maxTokens : configuredMax,
    stream: stream
  };
  if (typeof settings.temperature === "number" && Number.isFinite(settings.temperature)) {
    body.temperature = settings.temperature;
  }
  if (typeof settings.top_p === "number" && Number.isFinite(settings.top_p)) { body.top_p = settings.top_p; }
  if (typeof settings.top_k === "number" && Number.isFinite(settings.top_k)) { body.top_k = settings.top_k; }
  if (system) { body.system = system; }
  if (Array.isArray(options.tools) && options.tools.length) {
    body.tools = options.tools.map(toAnthropicTool).filter(Boolean);
    body.tool_choice = { type: options.toolChoice === "required" ? "any" : "auto" };
  }
  return compat.applyCompat("anthropic", body, entry, {
    hasTools: Array.isArray(options.tools) && options.tools.length > 0
  });
}

// ---- chat ----

async function chat(settings, messages, options) {
  if (!settings.model) { throw new Error("Model is required."); }
  const baseUrl = resolveBaseUrl(settings);
  const { system, messages: anthropicMessages } = convertMessages(messages);
  options = options || {};
  const entry = compat.getEntry("anthropic", baseUrl, settings.model,
    settings.paramCompat && settings.paramCompat[settings.model]);
  const startedAt = Date.now();
  const response = await compat.runWithCompat({
    vendor: "anthropic",
    entry: entry,
    hasTools: Array.isArray(options.tools) && options.tools.length > 0,
    mode: "normal",
    build: function (currentEntry, overrides) {
      return buildAnthropicBody(settings, anthropicMessages, system, options, currentEntry, false, overrides);
    },
    send: function (body) {
      return postJson(baseUrl + "/v1/messages", anthropicHeaders(settings), body, settings.requestTimeoutMs || 180000);
    },
    onLearn: function (currentEntry, fix) {
      compat.notifyLearn(settings, currentEntry, fix, { baseUrl: baseUrl });
    },
    isEmptyLengthCut: function (raw) {
      const blocks = raw && Array.isArray(raw.content) ? raw.content : [];
      return raw && raw.stop_reason === "max_tokens" &&
        !blocks.some(function (block) { return block && block.type === "text" && block.text; }) &&
        !blocks.some(function (block) { return block && block.type === "tool_use"; });
    },
    limitOf: function (body) { return body && body.max_tokens; }
  });
  const totalMs = Date.now() - startedAt;

  const contentArray = (response && Array.isArray(response.content)) ? response.content : [];
  const textContent = contentArray.filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("");
  const toolUseBlocks = contentArray.filter(function (b) { return b.type === "tool_use"; });
  const toolCalls = toolUseBlocks.length ? toolUseBlocks.map(toOpenAiToolCall) : null;
  const usage = (response && response.usage)
    ? { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens }
    : null;

  return {
    raw: response,
    content: textContent || (toolCalls ? "" : "[No assistant message returned by provider]"),
    toolCalls: toolCalls,
    timing: { totalMs: totalMs },
    usage: usage,
    finishReason: mapStopReason(response && response.stop_reason),
    compatNotes: response && response.compatNotes
  };
}

// ---- chatStream ----

async function chatStream(settings, messages, onDelta, onReasoningDelta, options) {
  if (!settings.model) { throw new Error("Model is required."); }
  const baseUrl = resolveBaseUrl(settings);
  const { system, messages: anthropicMessages } = convertMessages(messages);
  options = options || {};
  const entry = compat.getEntry("anthropic", baseUrl, settings.model,
    settings.paramCompat && settings.paramCompat[settings.model]);
  const result = await compat.runWithCompat({
    vendor: "anthropic",
    entry: entry,
    hasTools: Array.isArray(options.tools) && options.tools.length > 0,
    mode: "normal",
    build: function (currentEntry, overrides) {
      return buildAnthropicBody(settings, anthropicMessages, system, options, currentEntry, true, overrides);
    },
    send: function (body) {
      return postStream(baseUrl + "/v1/messages", anthropicHeaders(settings), body,
        settings.requestTimeoutMs || 180000, onDelta, onReasoningDelta);
    },
    onLearn: function (currentEntry, fix) {
      compat.notifyLearn(settings, currentEntry, fix, { baseUrl: baseUrl });
    },
    isEmptyLengthCut: function (streamResult) {
      return !!(streamResult && streamResult.content === "" &&
        streamResult.finishReason === "length" && streamResult.hadDeltas !== true);
    },
    limitOf: function (body) { return body && body.max_tokens; }
  });

  return {
    content: result.content || "",
    timing: { ttftMs: result.ttftMs, totalMs: result.totalMs },
    usage: result.usage,
    finishReason: result.finishReason,
    compatNotes: result.compatNotes
  };
}

// ---- listModels ----
// Tries GET /v1/models; falls back to a hardcoded list if that endpoint
// is unavailable (non-standard proxy) or returns an error.
//
// Allowed to run against an UNCONFIRMED provider (ADR-007), same as the
// OpenAI-compatible provider's listModels — see its comment for the full
// rationale. isModelsListShaped gates the success path here too: a
// non-provider target's response never gets its ids reflected back, it
// just falls through to the safe hardcoded fallback below like any other
// failure.
async function listModels(settings) {
  const baseUrl = resolveBaseUrl(settings);
  try {
    const response = await getJson(baseUrl + "/v1/models", anthropicHeaders(settings), settings.requestTimeoutMs || 30000);
    if (!isModelsListShaped(response)) {
      throw new Error("Not a valid provider endpoint (no FlowPilot-compatible response).");
    }
    const models = response.data.map(function (m) { return m && m.id; }).filter(function (id) { return typeof id === "string" && id; });
    if (models.length) { return { models: models }; }
    throw new Error("Empty model list from provider");
  } catch (err) {
    return {
      models: [
        "claude-opus-4-8",
        "claude-sonnet-5",
        "claude-haiku-4-5-20251001"
      ],
      error: err.message
    };
  }
}

// ---- probeTools ----
async function probeTools(settings) {
  if (!settings.model) { throw new Error("Model is required."); }
  const baseUrl = resolveBaseUrl(settings);
  const options = {
    tools: [{
      type: "function",
      function: {
        name: "ping",
        description: "Respond to a connectivity probe. Takes no arguments.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    }],
    toolChoice: "required",
    maxTokens: 1024
  };
  const entry = compat.getEntry("anthropic", baseUrl, settings.model,
    settings.paramCompat && settings.paramCompat[settings.model]);
  try {
    const response = await compat.runWithCompat({
      vendor: "anthropic",
      entry: entry,
      hasTools: true,
      mode: "discover",
      build: function (currentEntry, overrides) {
        return buildAnthropicBody(settings, [
          { role: "user", content: "Call the \"ping\" tool now with no arguments." }
        ], "You are being tested for tool/function-calling support.", options, currentEntry, false,
        Object.assign({}, overrides, { maxTokens: overrides.maxTokens !== undefined ? overrides.maxTokens : 1024 }));
      },
      send: function (body) {
        return postJson(baseUrl + "/v1/messages", anthropicHeaders(settings), body, settings.requestTimeoutMs || 30000);
      },
      onLearn: function (currentEntry, fix) {
        compat.notifyLearn(settings, currentEntry, fix, { baseUrl: baseUrl });
      }
    });

    const contentArray = (response && Array.isArray(response.content)) ? response.content : [];
    const hasToolUse = contentArray.some(function (b) { return b.type === "tool_use" && b.name === "ping"; });
    return { supportsTools: hasToolUse };
  } catch (err) {
    return { supportsTools: false, error: err.message };
  }
}

// ---- detectReasoning ----
// Extended thinking responses include content blocks with type:"thinking".
// Standard non-thinking responses never include them.
function detectReasoning(rawResponse) {
  const contentArray = (rawResponse && Array.isArray(rawResponse.content)) ? rawResponse.content : [];
  const isReasoningModel = contentArray.some(function (b) { return b && b.type === "thinking" && b.thinking; });
  return { isReasoningModel: isReasoningModel };
}

module.exports = {
  chat, chatStream, probeTools, listModels, detectReasoning,
  mapStopReason,
  resetCompat: function (settings) { compat.resetCompat("anthropic", resolveBaseUrl(settings), settings.model); }
};
