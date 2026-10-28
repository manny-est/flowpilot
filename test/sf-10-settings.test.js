"use strict";

// SF-10 settings audit: the storage migration is deliberately tested against
// the real storage implementation so a failed write cannot be hidden by a
// test-only copy of the migration logic.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const createStorage = require("../lib/storage");

function makeProfile(settings) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowpilot-sf10-"));
  fs.mkdirSync(path.join(userDir, "flowpilot"), { recursive: true });
  fs.writeFileSync(path.join(userDir, "flowpilot", "settings.json"), JSON.stringify(settings), "utf8");
  return { userDir: userDir, file: path.join(userDir, "flowpilot", "settings.json"), storage: createStorage(userDir) };
}

const profile = makeProfile({
  providers: [{ id: "default", providerName: "LocalAI", baseUrl: "http://localhost:8080" }],
  activeProviderId: "default",
  customIntents: [
    { label: "Weather Check", text: "Check the weather." },
    { label: "help", text: "Help me inspect this flow." },
    { label: "Weather Check", text: "Check the weather twice." }
  ],
  enableAgentWrite: true,
  buildEngine: "classic",
  loopHoldStep: true,
  showHelperButtons: false,
  defaultContextMode: "selected",
  userExtension: "must survive"
});

try {
  const loaded = profile.storage.getSettings();
  assert.deepStrictEqual(loaded.savedPrompts, [
    { name: "/weather-check", text: "Check the weather." },
    { name: "/help-prompt", text: "Help me inspect this flow." },
    { name: "/weather-check-2", text: "Check the weather twice." }
  ], "custom intents migrate to slugged, deduplicated, non-built-in prompts");
  assert.strictEqual(loaded.customIntents.length, 3, "legacy entries stay until the migration save succeeds");
  assert.strictEqual(loaded.enableAgentWrite, undefined, "retired configuration keys are dropped silently");
  assert.strictEqual(loaded.buildEngine, undefined);
  assert.strictEqual(loaded.loopHoldStep, undefined);
  assert.strictEqual(loaded.showHelperButtons, undefined);
  assert.strictEqual(loaded.defaultContextMode, undefined);
  assert.strictEqual(loaded.userExtension, "must survive", "unknown legacy keys still load cleanly");
  assert.strictEqual(loaded.diffGateThreshold, 5, "diff-gate threshold defaults to five");

  const secondLoad = profile.storage.getSettings();
  assert.deepStrictEqual(secondLoad.savedPrompts, loaded.savedPrompts, "a second load does not duplicate migrated prompts");

  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function (file) {
    if (file.indexOf(profile.file + ".tmp-") === 0) { throw new Error("simulated settings write failure"); }
    return originalWrite.apply(fs, arguments);
  };
  try {
    assert.throws(function () { profile.storage.saveSettings(loaded); }, /simulated settings write failure/);
  } finally {
    fs.writeFileSync = originalWrite;
  }
  const afterFailedSave = JSON.parse(fs.readFileSync(profile.file, "utf8"));
  assert.ok(Array.isArray(afterFailedSave.customIntents), "custom intents survive a failed migration save");
  assert.deepStrictEqual(afterFailedSave.customIntents, loaded.customIntents, "failed save does not drop user-written text");

  const saved = profile.storage.saveSettings(loaded);
  assert.strictEqual(saved.customIntents, undefined, "legacy field is removed after successful save");
  assert.deepStrictEqual(saved.savedPrompts, loaded.savedPrompts);
  assert.strictEqual(saved.savedPromptsMigrationNoticeShown, false, "storage leaves notice acknowledgement to the client");
  const onDisk = JSON.parse(fs.readFileSync(profile.file, "utf8"));
  assert.strictEqual(onDisk.customIntents, undefined);
  assert.strictEqual(onDisk.userExtension, "must survive");
  ["defaultContextMode", "enableAgentWrite", "buildEngine", "loopHoldStep", "showHelperButtons"].forEach(function (key) {
    assert.strictEqual(onDisk[key], undefined, key + " is not persisted");
  });

  const legacy = makeProfile({
    providerName: "Old LocalAI",
    baseUrl: "http://localhost:8080",
    model: "old-model",
    customIntents: [{ label: "Legacy", text: "Legacy prompt text" }]
  });
  try {
    assert.doesNotThrow(function () { legacy.storage.getSettings(); }, "flat 0.6.x settings load cleanly");
  } finally {
    fs.rmSync(legacy.userDir, { recursive: true, force: true });
  }
  console.log("SF-10 settings migration tests passed");
} finally {
  fs.rmSync(profile.userDir, { recursive: true, force: true });
}

const main = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "main.js"), "utf8");
const init = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "init.js"), "utf8");
assert.ok(main.indexOf("Your custom intents are now saved prompts") !== -1, "migration notice text exists");
assert.ok(main.indexOf("savedPromptsMigrationNoticeShown") !== -1, "migration notice is persisted");
assert.ok(init.indexOf("Fill saved prompt") !== -1, "slash menu labels saved prompts");
assert.ok(init.indexOf("applyIntentText(command.text)") !== -1, "saved prompt selection fills instead of sending");
assert.strictEqual(main.indexOf("loopHoldStep"), -1, "main client no longer reads loopHoldStep");
assert.strictEqual(main.indexOf("showHelperButtons"), -1, "main client no longer reads showHelperButtons");
console.log("SF-10 client settings assertions passed");
