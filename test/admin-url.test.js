"use strict";

// Issue #12: admin-URL building under a non-root httpAdminRoot. The helpers
// live in the browser bundle (lib/core/main.js, one shared closure, no module
// system), so this extracts the REAL function source text from that file and
// evaluates it — never a hand-copied re-implementation.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "main.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "function " + name + " not found in lib/core/main.js");
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") { depth++; }
    else if (source[i] === "}") { depth--; if (depth === 0) { return source.slice(start, i + 1); } }
  }
  throw new Error("unbalanced braces in " + name);
}

const popoutConst = /var POPOUT_PAGE_PATH = "[^"]*";/.exec(source);
assert.ok(popoutConst, "POPOUT_PAGE_PATH not found");

// flowpilotUrl/flowpilotAdminBase read window/RED/isPopoutContext from the
// shared closure — supply those as parameters of a wrapper scope.
const factory = new Function("window", "RED", "isPopoutContext",
  popoutConst[0] + "\n" +
  ["editorAdminBase", "popoutAdminBase", "flowpilotAdminBase", "flowpilotUrl"].map(extractFunction).join("\n") +
  "\nreturn { editorAdminBase: editorAdminBase, popoutAdminBase: popoutAdminBase, flowpilotUrl: flowpilotUrl };");

function env(pathname, search, apiRootUrl, popout) {
  return factory({ location: { pathname: pathname, search: search || "" } },
    { settings: { apiRootUrl: apiRootUrl } }, !!popout);
}

const h = env("/", "", "", false);

// --- editorAdminBase: relative to the editor page (always "<root>/") ---
assert.strictEqual(h.editorAdminBase("/", ""), "/");
assert.strictEqual(h.editorAdminBase("/manage/", ""), "/manage/");
assert.strictEqual(h.editorAdminBase("/a/b/", undefined), "/a/b/");
assert.strictEqual(h.editorAdminBase("/manage/index.html", ""), "/manage/");
// apiRootUrl, when set, prefixes like Node-RED's own $.ajaxSetup does
assert.strictEqual(h.editorAdminBase("/manage/", "/api"), "/api/");
assert.strictEqual(h.editorAdminBase("/manage/", "http://host:1880/"), "http://host:1880/");
assert.strictEqual(h.editorAdminBase("/manage/", "api/"), "/manage/api/");

// --- popoutAdminBase: explicit editor-supplied base wins ---
assert.strictEqual(h.popoutAdminBase("/manage/flowpilot/popout/view.html", "?fpAdminBase=%2Fmanage%2F"), "/manage/");
assert.strictEqual(h.popoutAdminBase("/manage/flowpilot/popout/view.html", "?access_token=x&fpAdminBase=%2Fmanage%2F"), "/manage/");
assert.strictEqual(h.popoutAdminBase("/flowpilot/popout/view.html", "?fpAdminBase=%2F"), "/");
// unsafe/malformed values are rejected → fall back to own route suffix
["http%3A%2F%2Fevil%2F", "%2F%2Fevil%2F", "%2F%5Cevil%2F", "manage%2F", "%2Fmanage", "%E0%A4%A"].forEach(function (bad) {
  assert.strictEqual(h.popoutAdminBase("/manage/flowpilot/popout/view.html", "?fpAdminBase=" + bad), "/manage/", "reject " + bad);
});
// no param (e.g. an older opener) → derived from own route suffix
assert.strictEqual(h.popoutAdminBase("/manage/flowpilot/popout/view.html", ""), "/manage/");
assert.strictEqual(h.popoutAdminBase("/flowpilot/popout/view.html", ""), "/");

// --- flowpilotUrl: every FlowPilot request goes through this ---
assert.strictEqual(env("/", "", "", false).flowpilotUrl("flowpilot/settings"), "/flowpilot/settings");
assert.strictEqual(env("/manage/", "", "", false).flowpilotUrl("flowpilot/settings"), "/manage/flowpilot/settings");
assert.strictEqual(env("/manage/", "", "", false).flowpilotUrl("/flowpilot/chat"), "/manage/flowpilot/chat");
assert.strictEqual(env("/manage/flowpilot/popout/view.html", "?fpAdminBase=%2Fmanage%2F", "", true).flowpilotUrl("flowpilot/settings"),
  "/manage/flowpilot/settings");
assert.strictEqual(env("/flowpilot/popout/view.html", "", "", true).flowpilotUrl("flowpilot/conversations"), "/flowpilot/conversations");

console.log("admin-url tests passed");
