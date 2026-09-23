"use strict";

// ADR-013 ("Auto capability routing") — the "Routing tier" A/B/C dropdown
// was confusing internal jargon for a non-technical user (Manny's live
// screenshot feedback on 0.6.3's Settings UI). This tests the two pieces
// that replaced it: flowpilot.js's normalizedRoutingTier (now derives the
// effective tier from a live supportsTools probe in "auto" mode, the new
// default) and lib/storage.js's migration of pre-existing providers into
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
assert.strictEqual(typeof normalizedRoutingTier, "function", "normalizedRoutingTier export");

// ---- Auto mode: derives from supportsTools, never picks Tier B ----------
assert.strictEqual(
  normalizedRoutingTier({ routingTierMode: "auto", supportsTools: true }),
  "A",
  "auto + supportsTools true -> A"
);
assert.strictEqual(
  normalizedRoutingTier({ routingTierMode: "auto", supportsTools: false }),
  "C",
  "auto + supportsTools false -> C"
);
assert.strictEqual(
  normalizedRoutingTier({ routingTierMode: "auto", supportsTools: undefined }),
  "C",
  "auto + never probed -> C (safe default until Pre-flight check runs)"
);
assert.strictEqual(
  normalizedRoutingTier({ routingTierMode: "auto", supportsTools: true, routingTier: "B" }),
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
