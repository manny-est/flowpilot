"use strict";

const assert = require("assert");
const EventEmitter = require("events");
const http = require("http");
const https = require("https");
const { chat, chatStream, probeTools, normalizeApiBase, chatCompletionsUrl, modelsUrl } = require("../lib/provider-openai-compatible");

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
    ["https://api.openai.com", "https://api.openai.com/v1/chat/completions", "real saved config: OpenAI test provider, bare host"],
    // Pre-beta.1 addition (design-chat rule): a full endpoint that does NOT
    // end in "/v1" (a non-standard gateway path, e.g. Open WebUI's own
    // "/api/chat/completions") must be used VERBATIM — the old logic
    // stripped this suffix unconditionally and forced a "/v1" into a path
    // that was never supposed to have one, breaking exactly this case.
    ["http://host:3000/api/chat/completions", "http://host:3000/api/chat/completions", "full non-/v1 endpoint (Open WebUI-style) used verbatim, no /v1 forced in"],
    ["http://host:3000/api/chat/completions/", "http://host:3000/api/chat/completions", "verbatim rule also tolerates a trailing slash"]
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

// Non-streaming variant of withMockedRequest, for chat()/probeTools() (which
// use postJson — a single JSON response body, not SSE). `responder(options,
// parsedBody)` returns `{ statusCode, body }`; every call's options and
// parsed request body are captured in `calls` (passed to `run`).
function withMockedJsonRequest(responder, run) {
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const calls = [];

  function fakeRequest(options, callback) {
    const req = new EventEmitter();
    let written = "";
    req.setTimeout = function () {};
    req.write = function (chunk) { written += chunk; };
    req.destroy = function (err) {
      process.nextTick(function () { req.emit("error", err); });
    };
    req.end = function () {
      let parsedBody = null;
      try { parsedBody = written ? JSON.parse(written) : null; } catch (e) { /* ignore */ }
      const outcome = responder(options, parsedBody) || {};
      calls.push({ options: options, body: parsedBody, outcome: outcome });
      const res = new EventEmitter();
      res.statusCode = outcome.statusCode !== undefined ? outcome.statusCode : 200;
      res.setEncoding = function () {};
      callback(res);
      process.nextTick(function () {
        res.emit("data", JSON.stringify(outcome.body !== undefined ? outcome.body : {}));
        res.emit("end");
      });
    };
    return req;
  }

  http.request = fakeRequest;
  https.request = fakeRequest;

  return Promise.resolve()
    .then(function () { return run(calls); })
    .finally(function () {
      http.request = originalHttpRequest;
      https.request = originalHttpsRequest;
    });
}

// vLLM (0.6.3 §review, "known-untested-provider" gap) needs
// --enable-auto-tool-choice + --tool-call-parser to support tool calls at
// all -- without those flags it 400s on any request carrying "tools", per
// its own docs. probeTools() must resolve (never throw) with
// supportsTools:false so Test Provider still passes -- a probe failure is
// "no tool support," never a connectivity failure. This also confirms
// (via the second chat() call) that supportsTools:false is exactly what
// drives normalizedRoutingTier's auto mode to Tier C (flowpilot.js,
// test/routing-tier.test.js already covers that half).
async function testProbeToolsRejectedByProviderDoesNotThrow() {
  await withMockedJsonRequest(function (options, body) {
    if (body && Array.isArray(body.tools) && body.tools.length) {
      return { statusCode: 400, body: { error: { message: "tools are not supported" } } };
    }
    return { statusCode: 200, body: { choices: [{ message: { content: "hello" } }] } };
  }, async function () {
    const settings = { baseUrl: "http://localhost:8000/v1", model: "test-model", requestTimeoutMs: 1000 };

    const probe = await probeTools(settings);
    assert.strictEqual(probe.supportsTools, false, "probeTools must resolve false, not throw, when the provider rejects a tools request");
    assert.ok(probe.error, "probeTools should surface the rejection reason for diagnostics");

    // Test Provider's plain connectivity check carries no tools -- it must
    // still succeed even though the capability probe above failed.
    const result = await chat(settings, [{ role: "user", content: "hi" }]);
    assert.strictEqual(result.content, "hello", "the plain connectivity check must still pass even though probeTools failed");
  });
}

// An empty apiKey (every local preset's default) must never produce a
// broken "Bearer " Authorization header -- chat()/chatStream()/listModels()/
// probeTools() all guard with `if (settings.apiKey)`, a truthy check.
async function testEmptyApiKeySendsNoAuthorizationHeader() {
  await withMockedJsonRequest(function () {
    return { statusCode: 200, body: { choices: [{ message: { content: "ok" } }] } };
  }, async function (calls) {
    await chat({ baseUrl: "http://localhost:1234/v1", model: "test-model", apiKey: "", requestTimeoutMs: 1000 },
      [{ role: "user", content: "hi" }]);
    assert.strictEqual(calls[0].options.headers.Authorization, undefined,
      "an empty apiKey must never produce a broken Authorization header");
  });
}

// ADR-013 sprint follow-up: OpenRouter's ZDR toggle already has live
// verification (echo server, real request body). Attribution headers had
// none -- this closes that gap with repeatable, automated coverage: off by
// default, on only when explicitly enabled, and OpenRouter-preset-only
// (never applied to Custom even if the flag is somehow set, since
// applyOpenRouterExtras keys on presetId, not baseUrl pattern-matching).
async function testAttributionHeadersOnlyWhenEnabledAndOnlyForOpenRouter() {
  await withMockedJsonRequest(function () {
    return { statusCode: 200, body: { choices: [{ message: { content: "ok" } }] } };
  }, async function (calls) {
    const base = { baseUrl: "https://openrouter.ai/api/v1", model: "test-model", presetId: "openrouter", requestTimeoutMs: 1000 };

    await chat(base, [{ role: "user", content: "hi" }]); // attributionEnabled unset entirely -- the real default
    assert.strictEqual(calls[0].options.headers["HTTP-Referer"], undefined, "attribution headers absent by default");
    assert.strictEqual(calls[0].options.headers["X-Title"], undefined, "attribution headers absent by default");

    await chat(Object.assign({}, base, { attributionEnabled: false }), [{ role: "user", content: "hi" }]);
    assert.strictEqual(calls[1].options.headers["HTTP-Referer"], undefined, "attribution headers absent when explicitly off");

    await chat(Object.assign({}, base, { attributionEnabled: true }), [{ role: "user", content: "hi" }]);
    assert.strictEqual(calls[2].options.headers["HTTP-Referer"], "https://github.com/manny-est/flowpilot", "attribution headers present when enabled");
    assert.strictEqual(calls[2].options.headers["X-Title"], "FlowPilot", "attribution headers present when enabled");

    await chat(Object.assign({}, base, { presetId: "custom", attributionEnabled: true }), [{ role: "user", content: "hi" }]);
    assert.strictEqual(calls[3].options.headers["HTTP-Referer"], undefined, "attribution must be OpenRouter-preset-only, never applied to Custom");
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
  await testProbeToolsRejectedByProviderDoesNotThrow();
  await testEmptyApiKeySendsNoAuthorizationHeader();
  await testAttributionHeadersOnlyWhenEnabledAndOnlyForOpenRouter();
  console.log("provider-openai-compatible tests passed");
})().catch(function (err) {
  console.error(err);
  process.exitCode = 1;
});
