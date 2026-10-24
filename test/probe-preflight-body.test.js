"use strict";

// The client's silent model-change pre-flight (lib/core/modes.js) must send
// a body POST /flowpilot/probe accepts — the route 400s on an empty body via
// the shared hasRequestBody guard. Takes the payload literal from the REAL
// client call site and sends it through the REAL route handler.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { startFakeProvider, loadRuntime, call, provider } = require("./helpers/route-harness");

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");
const CALL_RE = /ajaxJson\("POST", "flowpilot\/probe", (\{[^}]*\}),/g;
const payloads = [];
let m;
while ((m = CALL_RE.exec(source)) !== null) { payloads.push(m[1]); }
assert.ok(payloads.length >= 1, "found the client's flowpilot/probe call site(s) in lib/core/modes.js");
assert.strictEqual((source.match(/"flowpilot\/probe"/g) || []).length, payloads.length,
  "every flowpilot/probe call site has a literal payload this test can check");

(async function () {
  for (const literal of payloads) {
    const body = new Function("return (" + literal + ");")();
    const fake = await startFakeProvider({});
    try {
      const p = provider(fake.port);
      const runtime = loadRuntime({ activeProviderId: p.id, providers: [p] });
      const out = await call(runtime, "POST", "/flowpilot/probe", body);
      assert.strictEqual(out.status, 200, "probe with client payload " + literal + " → " + out.status + " " + JSON.stringify(out.body));
      assert.strictEqual(typeof out.body.supportsTools, "boolean", "probe returns supportsTools");
      assert.strictEqual(out.body.probedModel, "test-model", "probe returns probedModel");
    } finally {
      fake.close();
    }
  }
  console.log("probe-preflight-body tests passed (" + payloads.length + " call site)");
})().catch(function (err) { console.error(err); process.exit(1); });
