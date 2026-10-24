"use strict";

// Issue #10: POST /flowpilot/test's "not provider-shaped" 422 must carry the
// same Docker/localhost hint /flowpilot/probe's identical 422 already does —
// for a localhost/127.0.0.1 baseUrl only. Drives the REAL route handler.

const assert = require("assert");
const { startFakeProvider, loadRuntime, call, provider } = require("./helpers/route-harness");
const { DOCKER_LOCALHOST_HINT } = require("../lib/docker-localhost-hint");

const BASE_MESSAGE = "Not a valid provider endpoint (no FlowPilot-compatible response).";

async function testRoute(route, host) {
  const fake = await startFakeProvider({ mode: "not-provider", host: host === "localhost" ? "127.0.0.1" : host });
  try {
    const p = provider(fake.port, { baseUrl: "http://" + host + ":" + fake.port, confirmedBaseUrl: null, confirmedAt: null });
    const runtime = loadRuntime({ activeProviderId: p.id, providers: [p] });
    const out = await call(runtime, "POST", route, { prompt: "Say hello." });
    assert.ok(fake.requests.length > 0, route + " (" + host + "): the fake endpoint was actually contacted");
    return out;
  } finally {
    fake.close();
  }
}

(async function () {
  // 127.0.0.1 → hint
  let out = await testRoute("/flowpilot/test", "127.0.0.1");
  assert.strictEqual(out.status, 422);
  assert.strictEqual(out.body.error, "provider_check_failed");
  assert.strictEqual(out.body.message, BASE_MESSAGE + " " + DOCKER_LOCALHOST_HINT);

  // "localhost" → hint
  out = await testRoute("/flowpilot/test", "localhost");
  assert.strictEqual(out.status, 422);
  assert.strictEqual(out.body.message, BASE_MESSAGE + " " + DOCKER_LOCALHOST_HINT);

  // non-local host (127.0.0.2 is loopback on Linux, but not literally
  // "localhost"/"127.0.0.1", so it stands in for a LAN/cloud host) → no hint
  out = await testRoute("/flowpilot/test", "127.0.0.2");
  assert.strictEqual(out.status, 422);
  assert.strictEqual(out.body.message, BASE_MESSAGE);

  // /flowpilot/probe unchanged: same text, same condition
  out = await testRoute("/flowpilot/probe", "127.0.0.1");
  assert.strictEqual(out.status, 422);
  assert.strictEqual(out.body.message, BASE_MESSAGE + " " + DOCKER_LOCALHOST_HINT);
  out = await testRoute("/flowpilot/probe", "127.0.0.2");
  assert.strictEqual(out.body.message, BASE_MESSAGE);

  console.log("test-route docker-hint tests passed");
})().catch(function (err) { console.error(err); process.exit(1); });
