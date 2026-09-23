"use strict";

// ADR-013 ("Auto capability routing") — the "Routing tier" A/B/C dropdown
// was confusing internal jargon for a non-technical user (Manny's live
// screenshot feedback on 0.6.3's Settings UI). This tests the pieces that
// replaced it: flowpilot.js's normalizedRoutingTier (derives the effective
// tier in "auto" mode from BOTH a live supportsTools probe AND deployment
// class -- amended per the architect's review, since Gate P1 measured a
// local tool-capable model, spark, doing WORSE on Tier A (68.9%) than
// Tier C (100%) on document/build/clarify; a rule that only checked
// supportsTools would assign spark exactly that measured-worse tier),
// isLocalDeployment/isPrivateNetworkHost (the deployment-class signal
// itself), and lib/storage.js's migration of pre-existing providers into
// auto/manual mode without changing anyone's deliberate choice.

const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@node-red/registry") {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const flowPilotRuntime = require("../flowpilot.js");
const normalizedRoutingTier = flowPilotRuntime.normalizedRoutingTier;
const isLocalDeployment = flowPilotRuntime.isLocalDeployment;
const isPrivateNetworkHost = flowPilotRuntime.isPrivateNetworkHost;
assert.strictEqual(typeof normalizedRoutingTier, "function", "normalizedRoutingTier export");
assert.strictEqual(typeof isLocalDeployment, "function", "isLocalDeployment export");
assert.strictEqual(typeof isPrivateNetworkHost, "function", "isPrivateNetworkHost export");

// ---- isPrivateNetworkHost: the fallback signal for presetId "custom" ----
[
  ["http://localhost:8080", true],
  ["http://127.0.0.1:8080", true],
  ["http://192.168.1.15:8080", true],
  ["http://10.0.0.5:8080", true],
  ["http://172.20.0.5:8080", true],
  ["http://169.254.1.1:8080", true],
  ["http://myhost.localhost", true],
  ["https://api.openai.com/v1", false],
  ["https://openrouter.ai/api/v1", false],
  ["https://192.169.1.1", false], // NOT the 192.168.0.0/16 range
  ["https://172.32.0.1", false], // NOT the 172.16.0.0/12 range
  ["", false],
  [undefined, false]
].forEach(function (fixture) {
  assert.strictEqual(isPrivateNetworkHost(fixture[0]), fixture[1], "isPrivateNetworkHost(" + fixture[0] + ")");
});

// ---- isLocalDeployment: named preset wins; "custom" falls back to baseUrl
assert.strictEqual(
  isLocalDeployment({ presetId: "ollama", baseUrl: "https://not-actually-local.example.com" }),
  true,
  "a named local preset is local regardless of its baseUrl"
);
assert.strictEqual(
  isLocalDeployment({ presetId: "openrouter", baseUrl: "http://127.0.0.1:1" }),
  false,
  "a named cloud preset is cloud regardless of its baseUrl"
);
assert.strictEqual(
  isLocalDeployment({ presetId: "custom", baseUrl: "http://192.168.1.15:8080" }),
  true,
  "custom + private-network baseUrl -> local (spark's real shape)"
);
assert.strictEqual(
  isLocalDeployment({ presetId: "custom", baseUrl: "https://api.example.com" }),
  false,
  "custom + public baseUrl -> cloud"
);
assert.strictEqual(
  isLocalDeployment({ presetId: "unknown-or-missing", baseUrl: "http://localhost:11434" }),
  true,
  "an unrecognized presetId still falls back to the baseUrl check"
);

// ---- Auto mode: tools AND deployment class both matter, never picks B ---
assert.strictEqual(
  normalizedRoutingTier({ routingTierMode: "auto", supportsTools: true, presetId: "openrouter" }),
  "A",
  "auto + tools + cloud preset -> A"
);
assert.strictEqual(
  normalizedRoutingTier({ routingTierMode: "auto", supportsTools: true, presetId: "ollama" }),
  "C",
  "auto + tools + LOCAL preset -> C (Gate P1: local Tier A 68.9% vs Tier C 100%)"
);
assert.strictEqual(
  normalizedRoutingTier({ routingTierMode: "auto", supportsTools: true, presetId: "custom", baseUrl: "http://192.168.1.15:8080" }),
  "C",
  "auto + tools + custom-but-actually-local baseUrl -> C (spark's exact real-world shape)"
);
assert.strictEqual(
  normalizedRoutingTier({ routingTierMode: "auto", supportsTools: false, presetId: "ollama" }),
  "C",
  "auto + no tools -> C regardless of deployment class"
);
assert.strictEqual(
  normalizedRoutingTier({ routingTierMode: "auto", supportsTools: undefined }),
  "C",
  "auto + never probed -> C (safe default until Pre-flight check runs)"
);
assert.strictEqual(
  normalizedRoutingTier({ routingTierMode: "auto", supportsTools: true, presetId: "openrouter", routingTier: "B" }),
  "A",
  "auto mode ignores a stale stored routingTier entirely"
);

// ---- Manual mode: honors the stored tier exactly, including B ----------
assert.strictEqual(
  normalizedRoutingTier({ routingTierMode: "manual", routingTier: "B", supportsTools: true }),
  "B",
  "manual mode can select B even though auto never does"
);
assert.strictEqual(
  normalizedRoutingTier({ routingTierMode: "manual", routingTier: "C", supportsTools: true }),
  "C",
  "manual override wins even when the model actually supports tools"
);
assert.strictEqual(
  normalizedRoutingTier({ routingTierMode: "manual", routingTier: "bogus" }),
  "A",
  "manual mode with an invalid stored tier falls back to A"
);

// ---- Missing routingTierMode entirely defaults to auto -------------------
assert.strictEqual(
  normalizedRoutingTier({ supportsTools: false }),
  "C",
  "no routingTierMode at all behaves as auto"
);

console.log("normalizedRoutingTier (flowpilot.js): all assertions passed");

// ---- Storage migration: existing installs keep deliberate B/C choices ---
const createStorage = require("../lib/storage.js");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowpilot-routing-tier-test-"));
try {
  const flowpilotDir = path.join(tmpDir, "flowpilot");
  fs.mkdirSync(flowpilotDir, { recursive: true });
  fs.writeFileSync(path.join(flowpilotDir, "settings.json"), JSON.stringify({
    activeProviderId: "p1",
    providers: [
      { id: "p1", providerName: "Untouched default", routingTier: "A" },
      { id: "p2", providerName: "Deliberate classify-only", routingTier: "C" },
      { id: "p3", providerName: "Deliberate narrowed stub", routingTier: "B" },
      { id: "p4", providerName: "Already migrated, explicit auto", routingTier: "A", routingTierMode: "auto" },
      { id: "p5", providerName: "Already migrated, explicit manual", routingTier: "B", routingTierMode: "manual" }
    ]
  }, null, 2), "utf8");

  const store = createStorage(tmpDir);
  const settings = store.getSettings();
  const byId = {};
  settings.providers.forEach(function (p) { byId[p.id] = p; });

  assert.strictEqual(byId.p1.routingTierMode, "auto", "untouched default A migrates to auto");
  assert.strictEqual(byId.p2.routingTierMode, "manual", "deliberate C is preserved as manual");
  assert.strictEqual(byId.p2.routingTier, "C", "deliberate C keeps its tier value");
  assert.strictEqual(byId.p3.routingTierMode, "manual", "deliberate B is preserved as manual");
  assert.strictEqual(byId.p3.routingTier, "B", "deliberate B keeps its tier value");
  assert.strictEqual(byId.p4.routingTierMode, "auto", "already-migrated auto stays auto");
  assert.strictEqual(byId.p5.routingTierMode, "manual", "already-migrated manual stays manual");

  console.log("storage.js routingTierMode migration: all assertions passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
