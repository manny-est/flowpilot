"use strict";

const assert = require("assert");
const fs = require("fs");
const { buildCoreScript } = require("../lib/build-core-script");
const { startFakeProvider, loadRuntime, call, provider } = require("./helpers/route-harness");

async function main() {
  const fake = await startFakeProvider({
    toolCalls: function () {
      return [{ id: "deploy-1", type: "function", function: {
        name: "deploy_flows", arguments: JSON.stringify({ summary: "deploy" })
      } }];
    }
  });
  try {
    const p = provider(fake.port, { supportsTools: true });
    const runtime = loadRuntime({ activeProviderId: p.id, providers: [p], restricted: true });
    const result = await call(runtime, "POST", "/flowpilot/agent-step", {
      strategy: "agent", entry: "build", mode: "build",
      messages: [{ role: "user", content: "build and verify" }]
    });
    assert.strictEqual(result.status, 200);
    const request = fake.requests.filter(function (r) { return !/\/models$/.test(r.url); })[0];
    const names = (request.body.tools || []).map(function (tool) { return tool.function.name; });
    assert.strictEqual(names.indexOf("deploy_flows"), -1, "Restricted route never offers deploy_flows");
  } finally {
    fake.close();
  }

  const source = fs.readFileSync(require.resolve("../lib/core/main.js"), "utf8");
  assert.ok(source.indexOf("Restricted mode is on") !== -1, "client deploy refusal is present");
  const bundle = buildCoreScript();
  ["fp-plan-btn", "fp-act-btn", "fp-mode-row", "id=\"fp-intents\""].forEach(function (removed) {
    assert.strictEqual(bundle.indexOf(removed), -1, removed + " is not rendered");
  });
  ["fp-send-menu", "fp-auto-toggle", "fp-working-status", "fp-empty-state"].forEach(function (added) {
    assert.ok(bundle.indexOf(added) !== -1, added + " is rendered");
  });
  console.log("SF-7 restricted/UI assertions passed");
}

main().catch(function (err) {
  console.error(err.stack || err);
  process.exitCode = 1;
});
