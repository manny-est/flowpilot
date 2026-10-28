"use strict";

const assert = require("assert");
const EventEmitter = require("events");
const https = require("https");
const http = require("http");
const adapter = require("../lib/provider-anthropic");

function withMockedRequests(responder, run) {
  const originalHttp = http.request;
  const originalHttps = https.request;
  const calls = [];
  function fakeRequest(options, callback) {
    const req = new EventEmitter();
    let payload = "";
    req.setTimeout = function () {};
    req.write = function (chunk) { payload += chunk; };
    req.destroy = function (err) { process.nextTick(function () { req.emit("error", err); }); };
    req.end = function () {
      const body = payload ? JSON.parse(payload) : null;
      const outcome = responder(options, body, calls.length) || {};
      calls.push({ options: options, body: body, outcome: outcome });
      const res = new EventEmitter();
      res.statusCode = outcome.statusCode === undefined ? 200 : outcome.statusCode;
      res.setEncoding = function () {};
      callback(res);
      process.nextTick(function () {
        (outcome.chunks || (outcome.body !== undefined ? [outcome.body] : [])).forEach(function (chunk) {
          res.emit("data", typeof chunk === "string" ? chunk : JSON.stringify(chunk));
        });
        res.emit("end");
      });
    };
    return req;
  }
  http.request = fakeRequest;
  https.request = fakeRequest;
  return Promise.resolve().then(function () { return run(calls); }).finally(function () {
    http.request = originalHttp;
    https.request = originalHttps;
  });
}

function errorBody(message) {
  return { type: "error", error: { type: "invalid_request_error", message: message } };
}

function success(stopReason, content) {
  return {
    type: "message",
    stop_reason: stopReason || "end_turn",
    content: content === undefined ? [{ type: "text", text: "ok" }] : content,
    usage: { input_tokens: 2, output_tokens: 3 }
  };
}

async function testTemperatureDropAndRetry() {
  const settings = { baseUrl: "https://anthropic-temp.example", model: "claude-opus-4-7", temperature: 0.2 };
  await withMockedRequests(function (options, body) {
    if (body.temperature !== undefined) {
      return { statusCode: 400, body: errorBody("`temperature` is deprecated for this model.") };
    }
    return { body: success("end_turn") };
  }, async function (calls) {
    const result = await adapter.chat(settings, [{ role: "user", content: "hello" }]);
    assert.strictEqual(result.content, "ok");
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].body.temperature, 0.2);
    assert.strictEqual(calls[1].body.temperature, undefined);
  });
}

async function testTopPConflictKeepsTemperature() {
  const settings = { baseUrl: "https://anthropic-both.example", model: "claude-sonnet-4-6", temperature: 0.2, top_p: 0.7 };
  await withMockedRequests(function (options, body) {
    if (body.top_p !== undefined) {
      return { statusCode: 400, body: errorBody("`temperature` and `top_p` cannot both be specified for this model. Please use only one.") };
    }
    return { body: success("end_turn") };
  }, async function (calls) {
    const result = await adapter.chat(settings, [{ role: "user", content: "hello" }]);
    assert.strictEqual(result.content, "ok");
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].body.temperature, 0.2);
    assert.strictEqual(calls[1].body.top_p, undefined);
  });
}

async function testForcedToolChoiceAndFinishReason() {
  const settings = { baseUrl: "https://anthropic-tool.example", model: "claude-opus-5-5", temperature: 0.2 };
  const options = { tools: [{ type: "function", function: { name: "ping", parameters: {} } }], toolChoice: "required" };
  await withMockedRequests(function (requestOptions, body) {
    if (body.tool_choice.type === "any") {
      return { statusCode: 400, body: errorBody("tool_choice: type \"tool\" and \"any\" are not supported for this model.") };
    }
    return { body: success("tool_use", [{ type: "tool_use", id: "u1", name: "ping", input: {} }]) };
  }, async function (calls) {
    const result = await adapter.chat(settings, [{ role: "user", content: "use ping" }], options);
    assert.strictEqual(result.finishReason, "tool_calls");
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[1].body.tool_choice, { type: "auto" });
    assert.strictEqual(result.toolCalls[0].function.name, "ping");
  });
}

async function testEmptyLengthRetryAndStopMapping() {
  const settings = { baseUrl: "https://anthropic-length.example", model: "claude-sonnet-length" };
  await withMockedRequests(function (requestOptions, body, index) {
    if (index === 0) { return { body: success("max_tokens", []) }; }
    return { body: success("stop_sequence", [{ type: "text", text: "recovered" }]) };
  }, async function (calls) {
    const result = await adapter.chat(settings, [{ role: "user", content: "hello" }]);
    assert.strictEqual(result.content, "recovered");
    assert.strictEqual(result.finishReason, "stop");
    assert.deepStrictEqual(result.compatNotes, ["length limit raised to 32768 after an empty cut-off reply"]);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].body.temperature, undefined);
    assert.strictEqual(calls[0].body.max_tokens, 8192);
    assert.strictEqual(calls[1].body.max_tokens, 32768);
  });
}

async function testStreamFinishReason() {
  const settings = { baseUrl: "https://anthropic-stream.example", model: "claude-stream" };
  await withMockedRequests(function () {
    return { chunks: [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":1}}\n\n'
    ] };
  }, async function () {
    const result = await adapter.chatStream(settings, [{ role: "user", content: "hello" }], function () {});
    assert.strictEqual(result.content, "ok");
    assert.strictEqual(result.finishReason, "length");
  });
}

(async function main() {
  await testTemperatureDropAndRetry();
  await testTopPConflictKeepsTemperature();
  await testForcedToolChoiceAndFinishReason();
  await testEmptyLengthRetryAndStopMapping();
  await testStreamFinishReason();
  console.log("anthropic-param-compat tests passed");
})().catch(function (err) {
  console.error(err);
  process.exitCode = 1;
});
