"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const createStorage = require("../lib/storage");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flowpilot-param-compat-"));
try {
  const storage = createStorage(tmp);
  const file = path.join(tmp, "flowpilot", "settings.json");
  assert.strictEqual(storage.getSettings().providers[0].temperature, undefined);
  const original = {
    providers: [
      { id: "old", providerName: "Old", type: "openai-compatible", baseUrl: "http://old", model: "old-model", temperature: 0.2 },
      { id: "explicit", providerName: "Explicit", type: "openai-compatible", baseUrl: "http://explicit", model: "explicit-model", temperature: 0.7 },
      { id: "confirmed", providerName: "Confirmed", type: "openai-compatible", baseUrl: "http://confirmed", model: "confirmed-model", confirmedBaseUrl: "http://confirmed", confirmedAt: "2026-10-27T00:00:00.000Z", paramCompat: {
        "confirmed-model": { omit: ["temperature"], learnedAt: "2026-10-27T00:00:00.000Z" }
      } }
    ],
    activeProviderId: "confirmed"
  };
  fs.writeFileSync(file, JSON.stringify(original));
  const loaded = storage.getSettings();
  assert.strictEqual(loaded.providers.find(p => p.id === "old").temperature, undefined);
  assert.strictEqual(loaded.providers.find(p => p.id === "explicit").temperature, 0.7);

  const incoming = Object.assign({}, loaded, {
    providers: loaded.providers.map(function (provider) {
      if (provider.id !== "confirmed") { return provider; }
      const next = Object.assign({}, provider);
      delete next.paramCompat;
      return next;
    })
  });
  const saved = storage.saveSettings(incoming);
  const confirmed = saved.providers.find(p => p.id === "confirmed");
  assert.deepStrictEqual(confirmed.paramCompat["confirmed-model"].omit, ["temperature"]);
  assert.strictEqual(confirmed.confirmedBaseUrl, "http://confirmed");
  assert.strictEqual(confirmed.confirmedAt, "2026-10-27T00:00:00.000Z");
  console.log("storage param-compat tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
