"use strict";

// The Settings "Routing: … Why: …" line (lib/core/main.js routingTierChoice)
// must name the same tier flowpilot.js's normalizedRoutingTier actually
// routes with, and the right deciding reason (manual override / tool
// calling / deployment class), for every branch of the ADR-013 rule.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "@node-red/registry") { return {}; }
  return originalLoad.apply(this, arguments);
};
const server = require("../flowpilot.js");
const presets = require("../lib/provider-presets.js");
const presetList = presets.PROVIDER_PRESETS || presets.presets || presets.list || presets;

const main = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "main.js"), "utf8");
function extract(re) { const m = main.match(re); assert.ok(m, "found " + re); return m[0]; }
const src = [
  extract(/function presetById\(id\) \{[\s\S]*?\n    \}\n/),
  extract(/function isPrivateNetworkHost\(rawBaseUrl\) \{[\s\S]*?\n    \}\n/),
  extract(/function isLocalDeployment\(p\) \{[\s\S]*?\n    \}\n/),
  extract(/function deploymentReasonText\(p\) \{[\s\S]*?\n    \}\n/),
  extract(/var ROUTING_TIER_NAMES = \{[\s\S]*?\n    \};\n/),
  extract(/function routingTierChoice\(p\) \{[\s\S]*?\n    \}\n/),
  extract(/function routingTierWhyText\(p\) \{[\s\S]*?\n    \}\n/)
].join("\n");
const api = new Function("providerPresetsCache",
  src + "return { routingTierChoice: routingTierChoice, routingTierWhyText: routingTierWhyText };")(
  Array.isArray(presetList) ? presetList : Object.values(presetList));

const CASES = [
  [{ routingTierMode: "manual", routingTier: "B", supportsTools: true }, "manual"],
  [{ routingTierMode: "manual", routingTier: "c", supportsTools: false }, "manual"],
  [{ routingTierMode: "manual", routingTier: "zz" }, "manual"],
  [{ routingTierMode: "auto" }, "tools"],
  [{ routingTierMode: "auto", supportsTools: false, presetId: "openai" }, "tools"],
  [{ routingTierMode: "auto", supportsTools: true, presetId: "anthropic" }, "deployment"],
  [{ routingTierMode: "auto", supportsTools: true, presetId: "ollama", baseUrl: "http://my.host:11434" }, "deployment"],
  [{ routingTierMode: "auto", supportsTools: true, presetId: "custom", baseUrl: "http://192.168.1.15:8080" }, "deployment"],
  [{ routingTierMode: "auto", supportsTools: true, presetId: "custom", baseUrl: "https://api.example.com" }, "deployment"]
];

CASES.forEach(function (c, i) {
  const [p, reason] = c;
  const choice = api.routingTierChoice(p);
  assert.strictEqual(choice.tier, server.normalizedRoutingTier(p), "case " + i + ": display tier = server tier (" + JSON.stringify(p) + ")");
  assert.strictEqual(choice.reason, reason, "case " + i + ": deciding reason");
  assert.ok(/^Routing: .+\(Tier [ABC]\)\. Why: .+/.test(api.routingTierWhyText(p)), "case " + i + ": readable line: " + api.routingTierWhyText(p));
});
console.log("tier-display tests passed (" + CASES.length + " cases)");
