"use strict";

const assert = require("assert");
const EventEmitter = require("events");
const http = require("http");
const https = require("https");
const { chatStream } = require("../lib/provider-openai-compatible");

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

async function testMalformedNonSseResponse() {
  await withMockedRequest(function (res) {
    res.emit("data", "this is not sse at all");
    res.emit("end");
  }, async function () {
    await assert.rejects(
      function () {
        return chatStream(
          {
            baseUrl: "http://example.invalid",
            model: "test-model",
            requestTimeoutMs: 1000
          },
          [{ role: "user", content: "hello" }],
          function () {}
        );
      },
      /Provider returned non-SSE response \(200\): this is not sse at all/
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
  await testMalformedNonSseResponse();
  await testValidSseResponse();
  console.log("provider-openai-compatible tests passed");
})().catch(function (err) {
  console.error(err);
  process.exitCode = 1;
});
