const https = require("https");
const http = require("http");
const { isModelsListShaped } = require("./provider-shape-check");

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
const modelsWithoutTemperatureSupport = new Map();

function isTemperatureDeprecatedError(err) {
  if (!err || typeof err.message !== "string") { return false; }
  const msg = err.message;
  return msg.indexOf("invalid_request_error") !== -1 &&
    msg.indexOf("temperature") !== -1 &&
    msg.indexOf("deprecated") !== -1;
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
          const msg = parsed && parsed.error ? JSON.stringify(parsed.error) : ("status " + res.statusCode);
          reject(new Error("Provider request failed (" + res.statusCode + "): " + msg));
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
          const msg = parsed && parsed.error ? JSON.stringify(parsed.error) : ("status " + res.statusCode);
          reject(new Error("Provider request failed (" + res.statusCode + "): " + msg));
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
        res.on("data", (chunk) => { errBody += chunk; });
        res.on("end", () => {
          let parsed = null;
          try { parsed = errBody ? JSON.parse(errBody) : null; } catch (e) { /* fall through to generic message */ }
          const msg = parsed && parsed.error ? JSON.stringify(parsed.error) : ("status " + res.statusCode);
          reject(new Error("Provider request failed (" + res.statusCode + "): " + msg));
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
              onDelta(evt.delta.text);
            } else if (evt.delta.type === "thinking_delta" && evt.delta.thinking && onReasoningDelta) {
              onReasoningDelta(evt.delta.thinking);
            }
          } else if (evt.type === "message_delta" && evt.usage) {
            if (usage) { usage.completion_tokens = evt.usage.output_tokens || 0; }
            else { usage = { prompt_tokens: 0, completion_tokens: evt.usage.output_tokens || 0 }; }
          }
        });
      });
      res.on("end", () => {
        resolve({ content: full, ttftMs: firstTokenAt !== null ? firstTokenAt - startedAt : null, totalMs: Date.now() - startedAt, usage: usage });
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

// ---- chat ----

async function chat(settings, messages, options) {
  if (!settings.model) { throw new Error("Model is required."); }
  const baseUrl = resolveBaseUrl(settings);
  const { system, messages: anthropicMessages } = convertMessages(messages);
  const temperature = settings.temperature !== undefined ? Number(settings.temperature) : 0.2;

  function buildBody(includeTemperature) {
    const body = {
      model: settings.model,
      messages: anthropicMessages,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: false
    };
    if (includeTemperature) { body.temperature = temperature; }
    if (system) { body.system = system; }
    if (options && Array.isArray(options.tools) && options.tools.length) {
      body.tools = options.tools.map(toAnthropicTool).filter(Boolean);
      body.tool_choice = {
        type: options.toolChoice === "required" ? "any" : "auto"
      };
    }
    return body;
  }

  const skipTemperature = modelsWithoutTemperatureSupport.get(settings.model) === true;
  const startedAt = Date.now();
  let response;
  try {
    response = await postJson(baseUrl + "/v1/messages", anthropicHeaders(settings), buildBody(!skipTemperature), settings.requestTimeoutMs || 180000);
  } catch (err) {
    if (skipTemperature || !isTemperatureDeprecatedError(err)) { throw err; }
    // First time seeing this on this model this process — cache it so
    // every later call to this model skips straight to the no-temperature
    // body, then retry this one request once.
    modelsWithoutTemperatureSupport.set(settings.model, true);
    response = await postJson(baseUrl + "/v1/messages", anthropicHeaders(settings), buildBody(false), settings.requestTimeoutMs || 180000);
  }
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
    usage: usage
  };
}

// ---- chatStream ----

async function chatStream(settings, messages, onDelta, onReasoningDelta) {
  if (!settings.model) { throw new Error("Model is required."); }
  const baseUrl = resolveBaseUrl(settings);
  const { system, messages: anthropicMessages } = convertMessages(messages);
  const temperature = settings.temperature !== undefined ? Number(settings.temperature) : 0.2;

  function buildBody(includeTemperature) {
    const body = {
      model: settings.model,
      messages: anthropicMessages,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true
    };
    if (includeTemperature) { body.temperature = temperature; }
    if (system) { body.system = system; }
    return body;
  }

  const skipTemperature = modelsWithoutTemperatureSupport.get(settings.model) === true;
  let result;
  try {
    result = await postStream(baseUrl + "/v1/messages", anthropicHeaders(settings), buildBody(!skipTemperature), settings.requestTimeoutMs || 180000, onDelta, onReasoningDelta);
  } catch (err) {
    if (skipTemperature || !isTemperatureDeprecatedError(err)) { throw err; }
    // Same one-time detection as chat() above. Safe to retry whole-hog:
    // postStream rejects on the response's status line, before any SSE
    // data event is parsed, so onDelta/onReasoningDelta can't have already
    // emitted partial content from the failed attempt.
    modelsWithoutTemperatureSupport.set(settings.model, true);
    result = await postStream(baseUrl + "/v1/messages", anthropicHeaders(settings), buildBody(false), settings.requestTimeoutMs || 180000, onDelta, onReasoningDelta);
  }

  return {
    content: result.content || "",
    timing: { ttftMs: result.ttftMs, totalMs: result.totalMs },
    usage: result.usage
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

  function buildProbeBody(includeTemperature) {
    const body = {
      model: settings.model,
      messages: [{ role: "user", content: "Call the \"ping\" tool now with no arguments." }],
      system: "You are being tested for tool/function-calling support.",
      tools: [{
        name: "ping",
        description: "Respond to a connectivity probe. Takes no arguments.",
        input_schema: { type: "object", properties: {}, additionalProperties: false }
      }],
      tool_choice: { type: "auto" },
      max_tokens: 128,
      stream: false
    };
    if (includeTemperature) { body.temperature = 0; }
    return body;
  }

  const skipTemperature = modelsWithoutTemperatureSupport.get(settings.model) === true;
  try {
    let response;
    try {
      response = await postJson(baseUrl + "/v1/messages", anthropicHeaders(settings), buildProbeBody(!skipTemperature), settings.requestTimeoutMs || 30000);
    } catch (err) {
      // A temperature-deprecated failure here is not "no tool support" —
      // it's an unrelated request-shape error. Retry without temperature
      // before concluding anything about tool support (same detection as
      // chat()/chatStream() above).
      if (skipTemperature || !isTemperatureDeprecatedError(err)) { throw err; }
      modelsWithoutTemperatureSupport.set(settings.model, true);
      response = await postJson(baseUrl + "/v1/messages", anthropicHeaders(settings), buildProbeBody(false), settings.requestTimeoutMs || 30000);
    }

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

module.exports = { chat, chatStream, probeTools, listModels, detectReasoning };
