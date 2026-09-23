"use strict";

const assert = require("assert");
const EventEmitter = require("events");
const http = require("http");
const https = require("https");
const { chatStream, normalizeApiBase, chatCompletionsUrl, modelsUrl } = require("../lib/provider-openai-compatible");

// 0.6.3 §2A / §4: table-driven — every shape named in the sprint scope,
// plus the actual saved configs on the dev containers as of 2026-09-23
// (LocalAI/spark and the OpenAI test provider), so a real existing config
// is provably unaffected, not just a synthetic case.
function testNormalizeApiBase() {
  const cases = [
    // [input, expected chatCompletionsUrl, label]
    ["https://host", "https://host/v1/chat/completions", "bare host, no path"],
    ["https://host/v1", "https://host/v1/chat/completions", "host already ending in /v1 — must not double"],
    ["https://host/api/v1", "https://host/api/v1/chat/completions", "host/api/v1 (OpenRouter's own documented shape)"],
    ["https://host/v1/chat/completions", "https://host/v1/chat/completions", "a pasted full chat/completions URL recovers idempotently"],
    ["https://host/api/v1/chat/completions", "https://host/api/v1/chat/completions", "a pasted OpenRouter-shaped chat/completions URL"],
    ["https://host/v1/models", "https://host/v1/chat/completions", "a pasted /models URL recovers to the same base"],
    ["https://host/api/v1/models", "https://host/api/v1/chat/completions", "a pasted OpenRouter-shaped /models URL"],
    ["https://host/", "https://host/v1/chat/completions", "trailing slash on a bare host"],
    ["https://host/v1/", "https://host/v1/chat/completions", "trailing slash after /v1"],
    ["https://host/v1//", "https://host/v1/chat/completions", "multiple trailing slashes"],
    // Real saved dev-container configs (2026-09-23) — must resolve
    // IDENTICALLY to how the old unconditional-append code already
    // resolved them, i.e. zero behavior change for existing providers.
    ["http://192.168.1.15:8080", "http://192.168.1.15:8080/v1/chat/completions", "real saved config: LocalAI/spark, bare host+port"],
    ["https://api.openai.com", "https://api.openai.com/v1/chat/completions", "real saved config: OpenAI test provider, bare host"]
  ];
  cases.forEach(function (c) {
    const input = c[0], expectedChat = c[1], label = c[2];
    const gotChat = chatCompletionsUrl(input);
    assert.strictEqual(gotChat, expectedChat, "chatCompletionsUrl(\"" + input + "\") — " + label);
    // modelsUrl must always be the identical base with /models instead —
    // check the shared base is consistent between the two constructors.
    const gotModels = modelsUrl(input);
    const expectedModels = expectedChat.replace(/\/chat\/completions$/, "/models");
    assert.strictEqual(gotModels, expectedModels, "modelsUrl(\"" + input + "\") — " + label);
  });
  // Empty/missing input shouldn't throw inside the pure function itself —
  // chat()/chatStream()/listModels()/probeTools() each already guard with
  // their own "Provider base URL is required" check before ever calling
  // this, but the function itself must degrade predictably if called
  // directly with nothing.
  assert.strictEqual(normalizeApiBase(""), "/v1");
  assert.strictEqual(normalizeApiBase(undefined), "/v1");
  console.log("normalizeApiBase table-driven tests passed (" + cases.length + " cases)");
}

function withMockedRequest(responseFactory, run) {
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;

  function fakeRequest(options, callback) {
    const req = new EventEmitter();
    req.setTimeout = function () {};
    req.write = function () {};
    req.destroy = function (err) {
      process.nextTick(function () {
        req.emit("error", err);
      });
    };
    req.end = function () {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = function () {};
      callback(res);
      process.nextTick(function () {
        responseFactory(res, options);
      });
    };
    return req;
  }

  http.request = fakeRequest;
  https.request = fakeRequest;

  return Promise.resolve()
    .then(run)
    .finally(function () {
      http.request = originalHttpRequest;
      https.request = originalHttpsRequest;
    });
}

// ADR-007 (SSRF mitigation): the error message must be generic — never the
// raw upstream body. Before that fix, a non-provider target's response text
// ("this is not sse at all", here standing in for anything an SSRF target
// might return) would round-trip verbatim into this error message.
async function testMalformedNonSseResponse() {
  await withMockedRequest(function (res) {
    res.emit("data", "this is not sse at all — a secret internal hostname, for instance");
    res.emit("end");
  }, async function () {
    let caught = null;
    try {
      await chatStream(
        {
          baseUrl: "http://example.invalid",
          model: "test-model",
          requestTimeoutMs: 1000
        },
        [{ role: "user", content: "hello" }],
        function () {}
      );
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "expected chatStream to reject on a non-SSE response");
    assert.strictEqual(caught.message, "Provider returned a non-SSE response (status 200).");
    assert.ok(
      caught.message.indexOf("this is not sse at all") === -1,
      "error message must never contain the raw upstream body"
    );
  });
}

async function testValidSseResponse() {
  await withMockedRequest(function (res) {
    res.emit("data", "ignored junk\n");
    res.emit("data", 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    res.emit("data", 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    res.emit("data", "data: [DONE]\n\n");
    res.emit("end");
  }, async function () {
    const chunks = [];
    const result = await chatStream(
      {
        baseUrl: "http://example.invalid",
        model: "test-model",
        requestTimeoutMs: 1000
      },
      [{ role: "user", content: "hello" }],
      function (delta) {
        chunks.push(delta);
      }
    );

    assert.strictEqual(result.content, "Hello");
    assert.deepStrictEqual(chunks, ["Hel", "lo"]);
  });
}

(async function main() {
  testNormalizeApiBase();
  await testMalformedNonSseResponse();
  await testValidSseResponse();
  console.log("provider-openai-compatible tests passed");
})().catch(function (err) {
  console.error(err);
  process.exitCode = 1;
});
