"use strict";

const assert = require("assert");
const EventEmitter = require("events");
const http = require("http");
const https = require("https");
const adapter = require("../lib/provider-openai-compatible");
const { chat, chatStream, probeTools, normalizeApiBase } = adapter;

function toolDefinition() {
  return [{
    type: "function",
    function: {
      name: "ping",
      description: "Respond to a connectivity probe. Takes no arguments.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  }];
}

function toolResponse() {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: "call_ping",
          type: "function",
          function: { name: "ping", arguments: "{}" }
        }]
      }
    }]
  };
}

function withMockedRequests(responder, run) {
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const calls = [];

  function fakeRequest(options, callback) {
    const req = new EventEmitter();
    let payload = "";
    req.setTimeout = function () {};
    req.write = function (chunk) { payload += chunk; };
    req.destroy = function (err) {
      process.nextTick(function () { req.emit("error", err); });
    };
    req.end = function () {
      let body = null;
      try { body = payload ? JSON.parse(payload) : null; } catch (err) {}
      const outcome = responder(options, body, calls.length) || {};
      calls.push({ options: options, body: body, raw: payload, outcome: outcome });
      const res = new EventEmitter();
      res.statusCode = outcome.statusCode === undefined ? 200 : outcome.statusCode;
      res.setEncoding = function () {};
      callback(res);
      process.nextTick(function () {
        if (outcome.chunks) {
          outcome.chunks.forEach(function (chunk) { res.emit("data", chunk); });
        } else if (outcome.body !== undefined) {
          res.emit("data", typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body));
        }
        res.emit("end");
      });
    };
    return req;
  }

  http.request = fakeRequest;
  https.request = fakeRequest;
  return Promise.resolve().then(function () { return run(calls); }).finally(function () {
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
  });
}

function jsonError(message, param, code) {
  return { error: { message: message, param: param, code: code, type: "invalid_request_error" } };
}

function assertClassifier(errorObj, expected) {
  const classify = adapter.classifyParamError || function () { return null; };
  assert.strictEqual(classify(errorObj), expected,
    "classifyParamError must be exported and classify the error correctly");
}

function testClassifier() {
  const maxMessage = "Use 'max_completion_tokens' instead.";
  const temperatureMessage = "Only the default (1) value is supported.";
  const toolsMessage = "Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use /v1/responses or set reasoning_effort to 'none'.";
  const noneMessage = "does not support 'none' with this model";

  assertClassifier({ message: maxMessage, type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter" }, "max_tokens");
  assertClassifier({ message: maxMessage, type: "invalid_request_error", param: null, code: "unsupported_parameter" }, "max_tokens");
  assertClassifier({ message: temperatureMessage, type: "invalid_request_error", param: "temperature", code: "unsupported_value" }, "temperature");
  assertClassifier({ message: temperatureMessage, type: "invalid_request_error", param: "temperature", code: "unsupported_parameter" }, "temperature");
  assertClassifier({ message: toolsMessage, type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_parameter" }, "tools_need_reasoning_none");
  assertClassifier({ message: "Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use /v1/responses or set reasoning_effort to 'none'.", type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_parameter" }, "tools_need_reasoning_none");
  assertClassifier({ message: noneMessage, type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_value" }, "reasoning_none_unsupported");

  assertClassifier({ message: "Incorrect API key provided.", type: "authentication_error", param: null, code: "invalid_api_key" }, null);
  assertClassifier({ message: "This request exceeds the model's maximum context length.", type: "invalid_request_error", param: null, code: "context_length_exceeded" }, null);
  assertClassifier({ message: "Messages are invalid.", type: "invalid_request_error", param: "messages", code: "invalid_value" }, null);
  console.log("classifyParamError tests passed");
}

async function testChatAdaptsMaxAndTemperature() {
  const settings = { baseUrl: "http://gpt5-params.example/v1", model: "gpt-5.6-luna", requestTimeoutMs: 1000 };
  const messages = [{ role: "user", content: "hello" }];
  await withMockedRequests(function (options, body) {
    if (body.max_tokens !== undefined) {
      return { statusCode: 400, body: jsonError("Use 'max_completion_tokens' instead.", "max_tokens", "unsupported_parameter") };
    }
    if (body.temperature !== undefined) {
      return { statusCode: 400, body: jsonError("Only the default (1) value is supported.", "temperature", "unsupported_value") };
    }
    return { statusCode: 200, body: { choices: [{ message: { content: "ok" } }] } };
  }, async function (calls) {
    const result = await chat(settings, messages, { maxTokens: 4096 });
    assert.strictEqual(result.content, "ok");
    assert.strictEqual(calls.length, 3);
    const finalBody = calls[2].body;
    assert.strictEqual(finalBody.max_completion_tokens, 4096);
    assert.strictEqual(finalBody.max_tokens, undefined);
    assert.strictEqual(finalBody.temperature, undefined);

    calls.length = 0;
    await chat(settings, messages, { maxTokens: 4096 });
    assert.strictEqual(calls.length, 1, "cached parameter fixes should apply on the next call");
    assert.strictEqual(calls[0].body.max_completion_tokens, 4096);
    assert.strictEqual(calls[0].body.temperature, undefined);
  });
}

async function testChatToolsNeedNone() {
  const settings = { baseUrl: "http://gpt5-luna-tools.example/v1", model: "gpt-5.6-luna", requestTimeoutMs: 1000 };
  await withMockedRequests(function (options, body) {
    if (body.tools && body.reasoning_effort !== "none") {
      return { statusCode: 400, body: jsonError("Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use /v1/responses or set reasoning_effort to 'none'.", "reasoning_effort", "unsupported_parameter") };
    }
    return { statusCode: 200, body: toolResponse() };
  }, async function (calls) {
    const result = await chat(settings, [{ role: "user", content: "use ping" }], { tools: toolDefinition() });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].body.reasoning_effort, undefined);
    assert.strictEqual(calls[1].body.reasoning_effort, "none");
    assert.ok(result.toolCalls && result.toolCalls.length === 1, "tool calls must pass through");
  });
}

async function testToolsUnsupportedIsCached() {
  const settings = { baseUrl: "http://gpt6-sol.example/v1", model: "gpt-6.1-sol", requestTimeoutMs: 1000 };
  const expected = "This model can't use function tools through OpenAI's Chat Completions API (OpenAI requires the Responses API for it). FlowPilot's agent features need a model that can; chat still works.";
  await withMockedRequests(function (options, body) {
    if (body.reasoning_effort === "none") {
      return { statusCode: 400, body: jsonError("does not support 'none' with this model", "reasoning_effort", "unsupported_value") };
    }
    return { statusCode: 400, body: jsonError("Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use /v1/responses or set reasoning_effort to 'none'.", "reasoning_effort", "unsupported_parameter") };
  }, async function (calls) {
    await assert.rejects(
      chat(settings, [{ role: "user", content: "use ping" }], { tools: toolDefinition() }),
      function (err) { return err.message === expected; }
    );
    assert.strictEqual(calls.length, 2);

    calls.length = 0;
    const probe = await probeTools(settings);
    assert.deepStrictEqual(probe, { supportsTools: false, error: expected });
    assert.strictEqual(calls.length, 0, "cached unsupported tools must avoid the probe request");

    await assert.rejects(
      chat(settings, [{ role: "user", content: "use ping again" }], { tools: toolDefinition() }),
      function (err) { return err.message === expected; }
    );
    assert.strictEqual(calls.length, 0, "cached unsupported tools must avoid chat requests too");
  });
}

async function testProbeLuna() {
  const settings = { baseUrl: "http://gpt5-probe-luna.example/v1", model: "gpt-5.6-luna", requestTimeoutMs: 1000 };
  await withMockedRequests(function (options, body) {
    if (body.reasoning_effort !== "none") {
      return { statusCode: 400, body: jsonError("Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use /v1/responses or set reasoning_effort to 'none'.", "reasoning_effort", "unsupported_parameter") };
    }
    return { statusCode: 200, body: toolResponse() };
  }, async function (calls) {
    const result = await probeTools(settings);
    assert.strictEqual(result.supportsTools, true);
    assert.strictEqual(calls.length, 2);
  });
}

async function testChatStreamAdaptsTemperatureAndKeepsGenericErrors() {
  const settings = { baseUrl: "http://gpt5-stream.example/v1", model: "gpt-5-stream", requestTimeoutMs: 1000 };
  await withMockedRequests(function (options, body) {
    if (body.temperature !== undefined) {
      return { statusCode: 400, body: jsonError("Only the default (1) value is supported.", "temperature", "unsupported_value") };
    }
    return { chunks: [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n"
    ] };
  }, async function (calls) {
    const chunks = [];
    const result = await chatStream(settings, [{ role: "user", content: "hello" }], function (delta) { chunks.push(delta); });
    assert.strictEqual(result.content, "Hello");
    assert.deepStrictEqual(chunks, ["Hel", "lo"]);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].body.temperature, undefined);
  });

  await withMockedRequests(function () {
    return { statusCode: 400, body: jsonError("some unrelated failure", "messages", "invalid_value") };
  }, async function () {
    await assert.rejects(
      chatStream({ baseUrl: "http://gpt5-stream-bad.example/v1", model: "gpt-5-stream-bad", requestTimeoutMs: 1000 },
        [{ role: "user", content: "hello" }], function () {}),
      function (err) { return err.message === "Provider request failed (status 400)."; }
    );
  });
}

async function testLegacyBodiesRemainByteIdentical() {
  const settings = { baseUrl: "http://localai-regression.example/v1", model: "local-model", requestTimeoutMs: 1000 };
  const messages = [{ role: "user", content: "hello" }];
  const expectedChat = JSON.stringify({ model: "local-model", messages: messages, temperature: 0.2, stream: false });
  const expectedStream = JSON.stringify({ model: "local-model", messages: messages, temperature: 0.2, stream: true, stream_options: { include_usage: true } });
  const expectedProbe = JSON.stringify({
    model: "local-model",
    messages: [
      { role: "system", content: "You are being tested for tool/function-calling support." },
      { role: "user", content: "Call the \"ping\" tool now with no arguments. Do not reply with text." }
    ],
    tools: toolDefinition(),
    tool_choice: "auto",
    temperature: 0,
    stream: false
  });

  await withMockedRequests(function () {
    return { statusCode: 200, body: { choices: [{ message: { content: "ok" } }] } };
  }, async function (calls) {
    await chat(settings, messages);
    assert.strictEqual(calls[0].raw, expectedChat, "LocalAI chat body changed");
  });
  await withMockedRequests(function () {
    return { chunks: ["data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", "data: [DONE]\n\n"] };
  }, async function (calls) {
    await chatStream(settings, messages, function () {});
    assert.strictEqual(calls[0].raw, expectedStream, "LocalAI stream body changed");
  });
  await withMockedRequests(function () {
    return { statusCode: 200, body: toolResponse() };
  }, async function (calls) {
    await probeTools(settings);
    assert.strictEqual(calls[0].raw, expectedProbe, "LocalAI probe body changed");
  });
}

async function testCacheKeyIncludesBaseUrl() {
  const model = "same-model-cache-key";
  const settingsA = { baseUrl: "http://cache-a.example/v1", model: model, requestTimeoutMs: 1000 };
  const settingsB = { baseUrl: "http://cache-b.example/v1", model: model, requestTimeoutMs: 1000 };
  await withMockedRequests(function (options, body) {
    if (body.temperature !== undefined) {
      return { statusCode: 400, body: jsonError("Only the default (1) value is supported.", "temperature", "unsupported_value") };
    }
    return { statusCode: 200, body: { choices: [{ message: { content: "ok" } }] } };
  }, async function (calls) {
    await chat(settingsA, [{ role: "user", content: "a" }]);
    assert.strictEqual(calls.length, 2);
    calls.length = 0;
    await chat(settingsB, [{ role: "user", content: "b" }]);
    assert.strictEqual(calls.length, 2, "different base URLs must not share model capabilities");
    assert.strictEqual(calls[0].body.temperature, 0.2);
  });
}

async function testNonClassifiable400OnlyRequestsOnce() {
  let requestCount = 0;
  await withMockedRequests(function () {
    requestCount++;
    return { statusCode: 400, body: jsonError("context length exceeded", null, "context_length_exceeded") };
  }, async function (calls) {
    await assert.rejects(
      chat({ baseUrl: "http://nonclassifiable.example/v1", model: "one-request-model", requestTimeoutMs: 1000 },
        [{ role: "user", content: "hello" }]),
      function (err) { return err.message.indexOf("Provider request failed (400):") === 0; }
    );
    assert.strictEqual(requestCount, 1);
    assert.strictEqual(calls.length, 1);
  });
}

(async function main() {
  const tests = [
    ["classifyParamError", function () { testClassifier(); }],
    ["chat parameter adaptation", testChatAdaptsMaxAndTemperature],
    ["chat tools reasoning fallback", testChatToolsNeedNone],
    ["unsupported tools cache", testToolsUnsupportedIsCached],
    ["probe tools reasoning fallback", testProbeLuna],
    ["stream parameter adaptation", testChatStreamAdaptsTemperatureAndKeepsGenericErrors],
    ["legacy request bodies", testLegacyBodiesRemainByteIdentical],
    ["cache keying", testCacheKeyIncludesBaseUrl],
    ["non-classifiable errors", testNonClassifiable400OnlyRequestsOnce]
  ];
  const failures = [];
  for (const test of tests) {
    try {
      await test[1]();
      console.log("PASS " + test[0]);
    } catch (err) {
      failures.push({ name: test[0], error: err });
      console.error("FAIL " + test[0]);
      console.error(err);
    }
  }
  if (failures.length) {
    throw new Error(failures.length + " test group(s) failed");
  }
  console.log("openai-gpt5-params tests passed");
})().catch(function (err) {
  console.error(err);
  process.exitCode = 1;
});
