const http = require("http");
const https = require("https");

function postJson(urlString, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      reject(new Error(`Invalid provider URL: ${urlString}`));
      return;
    }

    const payload = JSON.stringify(body);
    const transport = url.protocol === "https:" ? https : http;
    const options = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: Object.assign({
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }, headers || {})
    };

    const req = transport.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch (err) {
          reject(new Error(`Provider returned non-JSON response (${res.statusCode}): ${data.slice(0, 500)}`));
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = parsed && parsed.error ? JSON.stringify(parsed.error) : data;
          reject(new Error(`Provider request failed (${res.statusCode}): ${msg}`));
          return;
        }

        resolve(parsed);
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs || 180000, () => {
      req.destroy(new Error(`Provider request timed out after ${timeoutMs || 180000}ms`));
    });

    req.write(payload);
    req.end();
  });
}

function getJson(urlString, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      reject(new Error(`Invalid provider URL: ${urlString}`));
      return;
    }

    const transport = url.protocol === "https:" ? https : http;
    const options = {
      method: "GET",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: headers || {}
    };

    const req = transport.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch (err) {
          reject(new Error(`Provider returned non-JSON response (${res.statusCode}): ${data.slice(0, 500)}`));
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = parsed && parsed.error ? JSON.stringify(parsed.error) : data;
          reject(new Error(`Provider request failed (${res.statusCode}): ${msg}`));
          return;
        }

        resolve(parsed);
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs || 30000, () => {
      req.destroy(new Error(`Provider request timed out after ${timeoutMs || 30000}ms`));
    });

    req.end();
  });
}

// ---------------------------------------------------------------------
// Models dropdown: lists models via the OpenAI-compatible GET /v1/models
// endpoint, so the settings UI can suggest valid model names instead of
// the user guessing and hitting a 404 from /v1/chat/completions. Unlike
// chat()/probeTools(), settings.model is NOT required here — this is how
// the user picks one. Never throws: a provider without /v1/models (or any
// other failure) just means an empty list with an explanatory error, which
// the UI shows as a hint while leaving the model field free-text.
// ---------------------------------------------------------------------
async function listModels(settings) {
  const baseUrl = String(settings.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Provider base URL is required.");

  const headers = {};
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  try {
    const response = await getJson(`${baseUrl}/v1/models`, headers, 30000);
    const data = response && Array.isArray(response.data) ? response.data : [];
    const models = data
      .map(function (m) { return m && m.id; })
      .filter(function (id) { return typeof id === "string" && id; });
    return { models: models };
  } catch (err) {
    return { models: [], error: err.message };
  }
}

// Phase 7: `options.tools` (OpenAI-style tool/function definitions) and
// `options.toolChoice` are optional — when present, the request asks the
// provider to call a tool instead of (or in addition to) replying with text.
// `result.toolCalls` is the raw `message.tool_calls` array (or null), passed
// through unparsed so the agent loop can validate/dispatch each call itself.
// A tool-call-only response has no `content`, so the "[No assistant message
// returned...]" fallback only applies when there are no tool calls either.
async function chat(settings, messages, options) {
  const baseUrl = String(settings.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Provider base URL is required.");
  if (!settings.model) throw new Error("Model is required.");

  const headers = {};
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  const temperature = settings.temperature !== undefined ? Number(settings.temperature) : 0.2;

  const body = {
    model: settings.model,
    messages,
    temperature,
    stream: false
  };
  if (options && Array.isArray(options.tools) && options.tools.length) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice || "auto";
  }

  const startedAt = Date.now();
  const response = await postJson(`${baseUrl}/v1/chat/completions`, headers, body, 180000);
  const totalMs = Date.now() - startedAt;

  const message = response && response.choices && response.choices[0] && response.choices[0].message;
  const content = message ? message.content : "";
  const toolCalls = message && Array.isArray(message.tool_calls) && message.tool_calls.length
    ? message.tool_calls
    : null;

  return {
    raw: response,
    content: content || (toolCalls ? "" : "[No assistant message returned by provider]"),
    toolCalls: toolCalls,
    timing: { totalMs },
    usage: (response && response.usage) || null
  };
}

// Streaming variant of chat(): requests `stream: true` and parses the
// OpenAI-compatible SSE format (lines `data: {...}`, terminated by
// `data: [DONE]`). Calls onDelta(text) for each content fragment as it
// arrives and resolves with { content } containing the full concatenated
// text once the stream ends. Used by Phase 6 chunk 4 (chat streaming only).
function postStream(urlString, headers, body, timeoutMs, onDelta) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      reject(new Error(`Invalid provider URL: ${urlString}`));
      return;
    }

    const payload = JSON.stringify(body);
    const transport = url.protocol === "https:" ? https : http;
    const options = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: Object.assign({
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }, headers || {})
    };

    const startedAt = Date.now();
    let firstTokenAt = null;
    let usage = null;

    const req = transport.request(options, (res) => {
      res.setEncoding("utf8");

      if (res.statusCode < 200 || res.statusCode >= 300) {
        let errData = "";
        res.on("data", chunk => { errData += chunk; });
        res.on("end", () => {
          reject(new Error(`Provider request failed (${res.statusCode}): ${errData.slice(0, 500)}`));
        });
        return;
      }

      let buf = "";
      let full = "";
      res.on("data", (chunk) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop(); // keep the last (possibly partial) line for next time

        lines.forEach((line) => {
          line = line.trim();
          if (!line.startsWith("data:")) { return; }
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") { return; }

          let evt;
          try {
            evt = JSON.parse(dataStr);
          } catch (e) {
            return; // ignore malformed/partial SSE chunk
          }

          if (evt && evt.usage) { usage = evt.usage; }

          const delta = evt && evt.choices && evt.choices[0] && evt.choices[0].delta
            ? evt.choices[0].delta.content
            : "";
          if (delta) {
            if (firstTokenAt === null) { firstTokenAt = Date.now(); }
            full += delta;
            onDelta(delta);
          }
        });
      });
      res.on("end", () => {
        const endedAt = Date.now();
        resolve({
          content: full,
          ttftMs: firstTokenAt !== null ? firstTokenAt - startedAt : null,
          totalMs: endedAt - startedAt,
          usage: usage
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs || 180000, () => {
      req.destroy(new Error(`Provider request timed out after ${timeoutMs || 180000}ms`));
    });

    req.write(payload);
    req.end();
  });
}

async function chatStream(settings, messages, onDelta) {
  const baseUrl = String(settings.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Provider base URL is required.");
  if (!settings.model) throw new Error("Model is required.");

  const headers = {};
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  const temperature = settings.temperature !== undefined ? Number(settings.temperature) : 0.2;

  // stream_options.include_usage asks OpenAI-compatible servers to emit a
  // final SSE chunk carrying token usage (no delta) before [DONE]. Providers
  // that don't support it just ignore the option; postStream treats a
  // missing usage field as null either way.
  const result = await postStream(`${baseUrl}/v1/chat/completions`, headers, {
    model: settings.model,
    messages,
    temperature,
    stream: true,
    stream_options: { include_usage: true }
  }, 180000, onDelta);

  return {
    content: result.content || "",
    timing: { ttftMs: result.ttftMs, totalMs: result.totalMs },
    usage: result.usage
  };
}

// ---------------------------------------------------------------------
// B-cap1: sends a minimal request with a trivial tool definition and a
// prompt that should trigger a tool call, to detect whether this provider
// supports OpenAI-style function/tool calling. Returns
// { supportsTools: boolean }, never throws — a provider that doesn't
// understand "tools" typically 400s on the request itself, which is a clean
// "no" for capability purposes (connectivity is checked separately by
// chat()).
//
// CAUTION: a pass here means the provider is ELIGIBLE for agentic features
// (Phase 7), not a reliability guarantee — the agentic path must still handle
// malformed mid-conversation tool calls by falling back to the envelope for
// that turn.
// ---------------------------------------------------------------------
async function probeTools(settings) {
  const baseUrl = String(settings.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Provider base URL is required.");
  if (!settings.model) throw new Error("Model is required.");

  const headers = {};
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  const tools = [{
    type: "function",
    function: {
      name: "ping",
      description: "Respond to a connectivity probe. Takes no arguments.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  }];

  try {
    const response = await postJson(`${baseUrl}/v1/chat/completions`, headers, {
      model: settings.model,
      messages: [
        { role: "system", content: "You are being tested for tool/function-calling support." },
        { role: "user", content: "Call the \"ping\" tool now with no arguments. Do not reply with text." }
      ],
      tools: tools,
      tool_choice: "auto",
      temperature: 0,
      stream: false
    }, 30000);

    const message = response && response.choices && response.choices[0] && response.choices[0].message;
    const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const wellFormed = toolCalls.length > 0 && toolCalls.every(function (call) {
      return !!(call && call.function && typeof call.function.name === "string" &&
        typeof call.function.arguments === "string");
    });

    return { supportsTools: wellFormed };
  } catch (err) {
    return { supportsTools: false, error: err.message };
  }
}

module.exports = { chat, chatStream, probeTools, listModels };
