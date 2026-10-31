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
