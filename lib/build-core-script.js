"use strict";

const fs = require("fs");
const path = require("path");

// flowpilot-core.js is loaded directly in the BROWSER via a single
// <script src="flowpilot/core.js"> tag - one big IIFE, no module system,
// every function/var sharing one closure by lexical scope (not via
// require/import). Phase 9's refactor splits the SOURCE into focused files
// under lib/core/ for maintainability, but the served SCRIPT must stay
// exactly what it was: one concatenated text, so cross-fragment references
// keep working unmodified and script-loading/timing behavior never changes.
//
// Order matters only for top-level code that runs immediately at load time
// (e.g. a `var x = (function(){...})();` initializer) - plain function
// declarations are hoisted within the shared closure and safe in any
// order. Keep new fragments appended in the same relative order they held
// in the original single file unless a specific dependency says otherwise.
const FRAGMENT_ORDER = [
  "redaction.js",
  "main.js"
];

const HEADER = "(function () {\n    \"use strict\";\n";
const FOOTER = "\n})();\n";

let cached = null;

function buildCoreScript() {
  if (cached) { return cached; }
  const body = FRAGMENT_ORDER.map(function (name) {
    return fs.readFileSync(path.join(__dirname, "core", name), "utf8");
  }).join("\n");
  cached = HEADER + body + FOOTER;
  return cached;
}

module.exports = { buildCoreScript: buildCoreScript };
