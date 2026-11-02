"use strict";
// UI fuzzer (reload-restores): the saved view held "Cruising…" and a reload
// inside the 1.5 s save debounce lost the latest turn.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
test("saved views drop live progress, flag a pending reply, and flush on page hide", () => {
  const h = read("lib/core/history.js");
  assert.match(h, /\$copy\.find\("#fp-pending, #fp-working-status, #fp-empty-state"\)\.remove\(\)/);
  assert.match(h, /window\.addEventListener\("pagehide", flushConversationViewOnHide\)/);
  assert.match(h, /keepalive: true/);
  assert.match(read("flowpilot.js"), /interrupted: body\.interrupted === true/);
  assert.match(read("lib/core/main.js"), /The page was reloaded before FlowPilot answered your last message/);
});

test("pop-out: re-attach passes the source guard, full snapshots after changes, no empty state beside messages", () => {
  const init = read("lib/core/init.js");
  assert.match(init, /evt\.source !== popoutWindow && data\.event !== "popoutReattach"/);
  assert.match(init, /popoutSnapshotObserver = new MutationObserver\(schedulePopoutSnapshot\)/);
  assert.match(init, /keepScroll: true/);
  assert.match(read("lib/core/main.js"), /\$box\.children\(\)\.not\("#fp-empty-state"\)\.length\) \{ \$state\.remove\(\); return; \}/);
});

test("a second interrupted run gets its own notice; only a repeat of the latest message is skipped", () => {
  // history.js runs a little page-load code; give it the browser globals it reads.
  const storage = new Map();
  global.window = global.window || { sessionStorage: {
    getItem: (key) => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  } };
  global.location = global.location || { href: "http://test/" };
  global.document = global.document || { readyState: "complete" };
  const history = require("../lib/core/history.js");
  const notice = history.interruptedRunNotice(0);
  const added = [];
  global.addMessage = (role, text) => { added.push(text); global.messageRecords.push({ kind: "chat", role, text }); };
  global.messageRecords = [
    { kind: "chat", role: "user", text: "hello FlowPilot" },
    { kind: "chat", role: "assistant", text: notice },
    { kind: "chat", role: "user", text: "hi" }
  ];
  try {
    history.renderInterruptedRunMessage(0);
    assert.deepEqual(added, [notice], "the earlier identical notice doesn't swallow this run's");
    history.renderInterruptedRunMessage(0);
    assert.equal(added.length, 1, "restoring twice doesn't stack it");
  } finally {
    delete global.addMessage;
    delete global.messageRecords;
  }
});

test("the pop-out's pull never claims the main page, so a reloaded main page is re-attached; looking at the pop-out pulls", () => {
  const init = read("lib/core/init.js");
  const pull = init.slice(init.indexOf("function pullOpenerConversation"), init.indexOf("setInterval(pullOpenerConversation"));
  assert.ok(pull.length > 0, "the pull is a named function");
  assert.doesNotMatch(pull, /mainBoot/, "the pull's sync carries no mainBoot (it beat the re-attach check: asked 0)");
  assert.match(init, /window\.addEventListener\("focus", pullOpenerConversation\)/);
  assert.match(init, /visibilitychange[\s\S]{0,120}pullOpenerConversation\(\)/);
});

test("UI fuzzer 240145: a pop-out no main page ever synced asks to be adopted after ~3 s", () => {
  const init = read("lib/core/init.js");
  const tick = init.slice(init.indexOf("var boot = window.opener.__fpMainBoot;"), init.indexOf("var boot = window.opener.__fpMainBoot;") + 900);
  assert.match(tick, /if \(knownMainBoot === null\) \{\s*unsyncedTicks \+= 1;\s*if \(unsyncedTicks < 2\) \{ return; \}\s*knownMainBoot = "never-synced";/);
  assert.match(tick, /window\.opener\.postMessage\(\{ event: "popoutReattach" \}/);
});
