"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { startFakeProvider, loadRuntime, call, provider } = require("./helpers/route-harness");

function parseKeepaliveBody(result) {
  assert.ok(typeof result.sse === "string", "keepalive response was written as a body");
  assert.strictEqual(result.sse[0], " ", "keepalive starts with whitespace");
  return JSON.parse(result.sse.trim());
}

async function withFastKeepaliveTimers(work) {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = function (fn, delay) {
    return realSetTimeout(fn, delay === 15000 ? 5 : delay);
  };
  try { return await work(); } finally { global.setTimeout = realSetTimeout; }
}

async function routeTests() {
  const slowProvider = await startFakeProvider({
    delayMs: 25,
    reply: function (body) {
      return body && body.messages && body.messages[0] && /classify one node-red/i.test(body.messages[0].content)
        ? "A" : "slow but successful";
    }
  });
  try {
    const slow = provider(slowProvider.port, { supportsTools: true });
    const runtime = loadRuntime({ activeProviderId: slow.id, providers: [slow] });
    const result = await withFastKeepaliveTimers(function () {
      return call(runtime, "POST", "/flowpilot/chat", {
        prompt: "How does a Node-RED debug node work?",
        strategy: "agent",
        entry: "chat",
        tools: true
      });
    });
    const body = parseKeepaliveBody(result);
    assert.strictEqual(result.status, 200, "late success remains HTTP 200");
    assert.strictEqual(body.message, "slow but successful", "leading whitespace still parses as JSON");
  } finally {
    slowProvider.close();
  }

  const unconfirmed = provider(1, {
    supportsTools: true,
    confirmedBaseUrl: "http://different-confirmed-url"
  });
  const earlyRuntime = loadRuntime({ activeProviderId: unconfirmed.id, providers: [unconfirmed] });
  const early = await call(earlyRuntime, "POST", "/flowpilot/chat", {
    prompt: "fail before the model call",
    strategy: "agent",
    entry: "chat"
  });
  assert.strictEqual(early.status, 409, "early failure keeps its HTTP status");
  assert.strictEqual(early.body.error, "provider_unconfirmed", "early failure keeps its JSON body");

  const disconnectProvider = await startFakeProvider({ delayMs: 25, reply: "discarded after disconnect" });
  try {
    const disconnected = provider(disconnectProvider.port, { supportsTools: true });
    const runtime = loadRuntime({ activeProviderId: disconnected.id, providers: [disconnected] });
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    let timerCleared = false;
    global.setTimeout = function (fn, delay) {
      return realSetTimeout(fn, delay === 15000 ? 5 : delay);
    };
    global.clearTimeout = function (timer) {
      timerCleared = true;
      return realClearTimeout(timer);
    };
    let result;
    try {
      result = await call(runtime, "POST", "/flowpilot/chat", {
        prompt: "How does a Node-RED debug node work?",
        strategy: "agent",
        entry: "chat"
      }, { disconnectAfterMs: 1, resolveOnDisconnect: true });
    } finally {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }
    assert.strictEqual(result.disconnected, true, "disconnect test simulates a closed client");
    assert.strictEqual(timerCleared, true, "client disconnect clears the keepalive timer");
  } finally {
    disconnectProvider.close();
  }

  const failingProvider = await startFakeProvider({ delayMs: 25, status: 503 });
  try {
    const failing = provider(failingProvider.port, { supportsTools: true });
    const runtime = loadRuntime({ activeProviderId: failing.id, providers: [failing] });
    const result = await withFastKeepaliveTimers(function () {
      return call(runtime, "POST", "/flowpilot/chat", {
        prompt: "How does a Node-RED debug node work?",
        strategy: "agent",
        entry: "chat"
      });
    });
    const body = parseKeepaliveBody(result);
    assert.strictEqual(result.status, 200, "late failure is returned as HTTP 200");
    // Since 0.6.5 the adapter keeps the provider's own status on the error,
    // so the non-keepalive path would also have answered 503.
    assert.strictEqual(body.code, 503, "late failure carries the status it would have had");
    assert.ok(body.error, "late failure carries an error");
  } finally {
    failingProvider.close();
  }
}

function clientTests() {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "main.js"), "utf8");
  const ajaxStart = source.indexOf("function stripHtmlForDisplay");
  const settingsMarker = source.indexOf("    // ---- Settings", ajaxStart);
  const ajaxSource = source.slice(ajaxStart, settingsMarker);
  let request = null;
  const api = new Function("$", "flowpilotUrl", "addMessage", ajaxSource +
    "\nreturn { ajaxJson: ajaxJson, readableRequestError: readableRequestError };" )({
      ajax: function (options) { request = options; return { abort: function () {} }; }
    }, function (url) { return "/admin/" + url; }, function () {});

  let message = null;
  api.ajaxJson("POST", "flowpilot/chat", {}, function () {}, function (text) { message = text; });
  request.error({ status: 504, responseText: "<html><h1>Gateway Timeout</h1></html>", statusText: "Gateway Timeout" }, "error");
  assert.ok(/proxy \(504\)/.test(message), "proxy 504 gets the readable timeout message");
  assert.strictEqual(/[<>]/.test(message), false, "HTML tags never reach the UI");

  message = null;
  request.success({ error: "<b>provider failed</b>", code: 500 }, "success", { status: 200 });
  assert.ok(/status 500/.test(message), "late HTTP 200 error is treated as an error");
  assert.strictEqual(/[<>]/.test(message), false, "late server text is HTML-stripped");

  message = null;
  request.error({ status: 0, responseText: "", statusText: "" }, "error");
  assert.ok(/Couldn't reach FlowPilot/.test(message), "empty network failure is readable");

  const hintStart = source.indexOf("var FP_LOCAL_SPEED_HINT_MS");
  const hintEnd = source.indexOf("\n    function renderProviderPresetOptions", hintStart);
  const hintSource = source.slice(hintStart, hintEnd);
  const hintApi = new Function(hintSource +
    "\nreturn { shouldShowLocalSpeedHint: shouldShowLocalSpeedHint, isLocalDeployment: isLocalDeployment };" )();
  assert.strictEqual(hintApi.shouldShowLocalSpeedHint({ baseUrl: "http://127.0.0.1:8080" }, 44999, false), false,
    "local hint waits for 45 seconds");
  assert.strictEqual(hintApi.shouldShowLocalSpeedHint({ baseUrl: "http://127.0.0.1:8080" }, 45000, false), true,
    "local hint appears at 45 seconds");
  assert.strictEqual(hintApi.shouldShowLocalSpeedHint({ baseUrl: "https://api.example.com" }, 60000, false), false,
    "cloud providers do not get the local hint");
  assert.strictEqual(hintApi.shouldShowLocalSpeedHint({ baseUrl: "http://127.0.0.1:8080" }, 60000, true), false,
    "local hint is shown once per run");
}

(async function () {
  await routeTests();
  clientTests();
  console.log("SF-9 errors/keepalive tests passed");
})().catch(function (err) {
  console.error(err.stack || err);
  process.exitCode = 1;
});
