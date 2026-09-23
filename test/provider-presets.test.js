"use strict";

const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const createStorage = require("../lib/storage");
const { PROVIDER_PRESETS, getPreset, presetIdForExistingProvider } = require("../lib/provider-presets");

function testPresetLookup() {
  assert.ok(PROVIDER_PRESETS.length >= 9, "expected all 0.6.3 presets present (8 named + Custom)");
  assert.strictEqual(getPreset("openrouter").providerType, "openai-compatible");
  assert.strictEqual(getPreset("anthropic").providerType, "anthropic");
  assert.strictEqual(getPreset("nonexistent-id"), null);
  // Every preset must carry a full, consistent shape — a missing field here
  // would silently break the client's rendering/apply logic.
  PROVIDER_PRESETS.forEach(function (p) {
    ["id", "label", "providerType", "baseUrl"].forEach(function (field) {
      assert.ok(field in p, "preset \"" + p.id + "\" missing required field \"" + field + "\"");
    });
    assert.ok(typeof p.apiKeyRequired === "boolean", "preset \"" + p.id + "\" apiKeyRequired must be boolean");
  });
  console.log("preset lookup/shape tests passed (" + PROVIDER_PRESETS.length + " presets)");
}

function testPresetIdForExistingProvider() {
  assert.strictEqual(presetIdForExistingProvider({ type: "anthropic" }), "anthropic");
  assert.strictEqual(presetIdForExistingProvider({ type: "openai-compatible" }), "custom");
  assert.strictEqual(presetIdForExistingProvider({}), "custom");
  assert.strictEqual(presetIdForExistingProvider(null), "custom");
  console.log("presetIdForExistingProvider mapping tests passed");
}

// 0.6.3 §2C migration: a provider saved before presets existed (no
// presetId field at all) must get one assigned on load, with ZERO change
// to any other field — this is the real, on-disk migration path, not just
// the pure function in isolation.
function testMigrationOnLoad() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowpilot-presets-test-"));
  try {
    const storage = createStorage(tmpDir);
    const preMigrationSettings = {
      providers: [
        { id: "default", providerName: "LocalAI", type: "openai-compatible", baseUrl: "http://192.168.1.15:8080", apiKey: "", model: "some-model", temperature: 0.2, numCtx: 0 },
        { id: "anthro1", providerName: "Anthropic", type: "anthropic", baseUrl: "", apiKey: "", model: "claude-sonnet-5", temperature: 0.2, numCtx: 0 }
      ],
      activeProviderId: "default"
    };
    fs.mkdirSync(path.join(tmpDir, "flowpilot"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "flowpilot", "settings.json"), JSON.stringify(preMigrationSettings));

    const loaded = storage.getSettings();
    const localai = loaded.providers.find(function (p) { return p.id === "default"; });
    const anthro = loaded.providers.find(function (p) { return p.id === "anthro1"; });

    assert.strictEqual(localai.presetId, "custom", "pre-existing openai-compatible provider migrates to custom");
    assert.strictEqual(localai.baseUrl, "http://192.168.1.15:8080", "migration must not alter baseUrl");
    assert.strictEqual(localai.model, "some-model", "migration must not alter model");

    assert.strictEqual(anthro.presetId, "anthropic", "pre-existing anthropic provider migrates to the anthropic preset");
    assert.strictEqual(anthro.model, "claude-sonnet-5", "migration must not alter model");

    // A provider that already has a presetId is left alone, even if it
    // looks like it "should" map differently — no re-guessing on every load.
    const settings2 = storage.getSettings();
    settings2.providers = settings2.providers.map(function (p) {
      return p.id === "default" ? Object.assign({}, p, { presetId: "openrouter" }) : p;
    });
    fs.writeFileSync(path.join(tmpDir, "flowpilot", "settings.json"), JSON.stringify(settings2));
    const reloaded = storage.getSettings();
    assert.strictEqual(reloaded.providers.find(function (p) { return p.id === "default"; }).presetId, "openrouter",
      "an already-assigned presetId must not be overwritten on a later load");

    console.log("presetId migration-on-load tests passed");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

testPresetLookup();
testPresetIdForExistingProvider();
testMigrationOnLoad();
console.log("provider-presets tests passed");
