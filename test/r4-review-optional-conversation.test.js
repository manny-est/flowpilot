"use strict";
// UI fuzzer (cal3): reload after Clear made the rehydrate GET return 404,
// a browser console error. Page-load rehydrate asks with ?optional=1.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
test("optional conversation lookup answers found:false instead of 404", () => {
  assert.match(read("flowpilot.js"), /req\.query\.optional === "1"\) \{ return res\.json\(\{ id: id, found: false \}\); \}/);
  assert.match(read("lib/core/main.js"), /options\.optional \? "\?optional=1" : ""/);
  assert.match(read("lib/core/init.js"), /preserveRunMarker: true, optional: true/);
});
