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

async function chat(settings, messages) {
  const baseUrl = String(settings.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Provider base URL is required.");
  if (!settings.model) throw new Error("Model is required.");

  const headers = {};
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  const temperature = settings.temperature !== undefined ? Number(settings.temperature) : 0.2;

  const startedAt = Date.now();
  const response = await postJson(`${baseUrl}/v1/chat/completions`, headers, {
    model: settings.model,
    messages,
    temperature,
    stream: false
  }, 180000);
  const totalMs = Date.now() - startedAt;

  const content = response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : "";

  return {
    raw: response,
    content: content || "[No assistant message returned by provider]",
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

module.exports = { chat, chatStream };
