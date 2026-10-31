"use strict";

const https = require("https");

function judgePrompt(input) {
  return [
    "You are a strict evaluator of a Node-RED flow edit.",
    "Answer only JSON with this shape: {\"did_what_was_asked\":true|false,\"gaps\":[\"short explanation\"]}.",
    "Judge whether the final graph and final user-facing text satisfy the original request. Do not reward unrelated writes.",
    "The user sees a result card listing the changes, so empty or short final text after a correct write is fine.",
    "For a vague request, asking one clarifying question is the right outcome.",
    "A request that should only be answered (explain / what does) must not write.",
    "Original prompt(s):\n" + String(input.prompt || ""),
    input.followUp ? "Follow-up:\n" + String(input.followUp) : "",
    // The judge saw only the final graph, so it couldn't tell fixture nodes
    // from FlowPilot's changes ("the flow was changed" after a greeting).
    "What FlowPilot did: " + String(input.outcome || "unknown") + ".",
    "Changes FlowPilot made (the only changes; everything else was already there):\n" +
      (Array.isArray(input.changes) && input.changes.length ? input.changes.map(function (c) { return "- " + c; }).join("\n") : "none"),
    input.expected ? "The right kind of outcome for this prompt: " + String(input.expected) + "." : "",
    "Final graph (code-built):\n" + JSON.stringify(input.graph || {}),
    "FlowPilot final user-facing text:\n" + String(input.finalText || "")
  ].filter(Boolean).join("\n\n");
}

function buildJudgeRequest(input, model) {
  return {
    model: model || "gpt-4.1",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return the requested JSON object and no markdown." },
      { role: "user", content: judgePrompt(input) }
    ]
  };
}

function redactJudgeError(error, secret) {
  const text = error && error.message ? error.message : String(error || "judge request failed");
  return secret ? text.split(String(secret)).join("[redacted]") : text;
}

function parseJudgeBody(body) {
  const choice = body && body.choices && body.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content !== "string") { throw new Error("judge returned no message"); }
  const parsed = JSON.parse(content);
  if (typeof parsed.did_what_was_asked !== "boolean" || !Array.isArray(parsed.gaps)) {
    throw new Error("judge returned an invalid verdict");
  }
  return { did_what_was_asked: parsed.did_what_was_asked, gaps: parsed.gaps.map(String) };
}

function requestJudge(input, apiKey, model) {
  return new Promise(function (resolve, reject) {
    if (!apiKey) { reject(new Error("OpenAI judge key is unavailable")); return; }
    const request = buildJudgeRequest(input, model);
    const raw = JSON.stringify(request);
    const req = https.request({
      hostname: "api.openai.com", port: 443, path: "/v1/chat/completions", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(raw),
        Authorization: "Bearer " + apiKey
      }
    }, function (res) {
      let data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        let parsed;
        try { parsed = JSON.parse(data); } catch (error) {
          reject(new Error("judge HTTP " + res.statusCode + " returned non-JSON"));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = parsed && parsed.error && parsed.error.message ? parsed.error.message : "request failed";
          reject(new Error("judge HTTP " + res.statusCode + ": " + detail));
          return;
        }
        try { resolve(parseJudgeBody(parsed)); } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.write(raw);
    req.end();
  }).catch(function (error) {
    throw new Error(redactJudgeError(error, apiKey));
  });
}

module.exports = { buildJudgeRequest: buildJudgeRequest, redactJudgeError: redactJudgeError,
  requestJudge: requestJudge, judgePrompt: judgePrompt };
