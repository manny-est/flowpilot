"use strict";

// Loads the REAL flowpilot.js runtime against a minimal fake RED (route
// handlers captured, not served) plus a local fake OpenAI-compatible
// provider that records every request body it receives. Lets a test call an
// actual route handler end to end — settings → message building → provider
// adapter → HTTP — without Node-RED or a real model.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const Module = require("module");

// flowpilot.js requires @node-red/registry (only present inside a real
// Node-RED install) for the installed-palette list; stub it with an empty
// palette (one contrib package) so the runtime loads standalone.
const REGISTRY_STUB_ID = "@node-red/registry";
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request) {
  if (request === REGISTRY_STUB_ID) { return REGISTRY_STUB_ID; }
  return originalResolve.apply(this, arguments);
};
require.cache[REGISTRY_STUB_ID] = {
  id: REGISTRY_STUB_ID, filename: REGISTRY_STUB_ID, loaded: true,
  exports: {
    getNodeList: function () {
      return [{ module: "node-red-contrib-example", enabled: true, types: ["example-node"] }];
    },
    getModuleList: function () { return {}; }
  }
};

function chatCompletion(content) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "test-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  };
}

// mode: "provider" (default) answers like an OpenAI-compatible API;
// "not-provider" answers every request with JSON that is NOT provider-shaped.
// reply: string or function(body) -> string, the assistant content returned.
// host: address to listen on (default 127.0.0.1).
// finishReason: function(chatRequestIndex, body) -> finish_reason (default "stop").
function startFakeProvider(options) {
  const opts = options || {};
  const requests = [];
  const server = http.createServer(function (req, res) {
    let raw = "";
    req.on("data", function (c) { raw += c; });
    req.on("end", function () {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw; }
      requests.push({ method: req.method, url: req.url, body: body });
      res.setHeader("Content-Type", "application/json");
      if (opts.mode === "not-provider") {
        res.end(JSON.stringify({ hello: "this is not an AI provider" }));
        return;
      }
      if (/\/models$/.test(req.url)) {
        res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model" }] }));
        return;
      }
      const chatIndex = requests.filter(function (r) { return !/\/models$/.test(r.url); }).length - 1;
      const content = typeof opts.reply === "function" ? opts.reply(body) : (opts.reply || "ok");
      const finishReason = typeof opts.finishReason === "function" ? opts.finishReason(chatIndex, body) : "stop";
      if (body && body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.write("data: " + JSON.stringify({ id: "x", object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: content } }] }) + "\n\n");
        res.write("data: " + JSON.stringify({ id: "x", object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n");
        res.end("data: [DONE]\n\n");
        return;
      }
      const completion = chatCompletion(content);
      completion.choices[0].finish_reason = finishReason;
      res.end(JSON.stringify(completion));
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, opts.host || "127.0.0.1", function () {
      resolve({ port: server.address().port, requests: requests, close: function () { server.close(); } });
    });
  });
}

// settings: the FlowPilot settings.json object to seed the userDir with.
function loadRuntime(settings) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-route-harness-"));
  fs.mkdirSync(path.join(userDir, "flowpilot"));
  fs.writeFileSync(path.join(userDir, "flowpilot", "settings.json"), JSON.stringify(settings));
  const routes = {};
  const eventHandlers = {};
  function reg(method) {
    return function (route) {
      const handlers = Array.prototype.slice.call(arguments, 1);
      routes[method + " " + route] = handlers[handlers.length - 1];
    };
  }
  const RED = {
    settings: { userDir: userDir },
    auth: { needsPermission: function () { return function (req, res, next) { next(); }; } },
    events: { on: function (name, fn) { (eventHandlers[name] = eventHandlers[name] || []).push(fn); } },
    nodes: { add: function () {}, getNodeList: function () { return []; } },
    httpAdmin: { get: reg("GET"), post: reg("POST"), delete: reg("DELETE"), use: function () {} }
  };
  delete global.__flowPilotRuntimeInitialized;
  const runtimePath = require.resolve("../../flowpilot.js");
  delete require.cache[runtimePath];
  require(runtimePath)(RED);
  // Behave like a started runtime (enables the installed-nodes note).
  (eventHandlers["flows:started"] || []).forEach(function (fn) { fn(); });
  return { routes: routes, userDir: userDir };
}

// Invokes a captured route handler with a fake req/res. Resolves with
// { status, body } (JSON body), or { status, sse } for streamed responses.
function call(runtime, method, route, body) {
  const handler = runtime.routes[method + " " + route];
  if (!handler) { return Promise.reject(new Error("no route " + method + " " + route)); }
  return new Promise(function (resolve, reject) {
    let status = 200;
    let sse = "";
    const res = {
      headersSent: false,
      status: function (s) { status = s; return res; },
      json: function (b) { resolve({ status: status, body: b }); return res; },
      send: function (b) { resolve({ status: status, body: b }); return res; },
      type: function () { return res; },
      set: function () { return res; },
      setHeader: function () {},
      writeHead: function (s) { status = s; res.headersSent = true; },
      flushHeaders: function () { res.headersSent = true; },
      write: function (chunk) { res.headersSent = true; sse += chunk; return true; },
      end: function (chunk) { if (chunk) { sse += chunk; } resolve({ status: status, sse: sse }); },
      on: function () {}
    };
    const req = { body: body, params: {}, query: {}, on: function () {}, headers: {} };
    try { Promise.resolve(handler(req, res)).catch(reject); } catch (e) { reject(e); }
  });
}

function provider(port, extra) {
  return Object.assign({
    id: "p1",
    providerName: "Fake",
    type: "openai-compatible",
    baseUrl: "http://127.0.0.1:" + port,
    model: "test-model",
    apiKey: "test-key",
    supportsTools: false,
    toolsProbedAt: "2026-01-01T00:00:00.000Z",
    probedModel: "test-model",
    confirmedBaseUrl: "http://127.0.0.1:" + port,
    confirmedAt: "2026-01-01T00:00:00.000Z"
  }, extra || {});
}

module.exports = { startFakeProvider, loadRuntime, call, provider, chatCompletion };
