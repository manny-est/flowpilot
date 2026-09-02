// Node-RED's "nodes" registration entry needs its own .js file, separate
// from flowpilot.js — Node-RED derives an editor-template path for every
// declared "nodes" entry by replacing the .js extension with .html
// (@node-red/registry/lib/loader.js loadNodeConfig: `file.replace(/\.c?js$/,".html")`),
// with NO awareness of the "plugins" entry that already explicitly declares
// flowpilot.html. If this entry pointed at flowpilot.js directly, Node-RED
// would derive "flowpilot.html" as this node's own template, find the real
// file (same basename), and load its content a SECOND time — the plugin's
// entire client bundle (flowpilot/core.js and its inline init script)
// ends up in the editor page twice, executing every module-level
// side effect (including sessionStorage init) twice per page load.
// This shim's own basename ("flowpilot-node-entry") has no matching .html,
// so Node-RED's template lookup misses (ENOENT) and loads no content for
// it — exactly what a route-registration-only, no-editor-UI node needs.
module.exports = require("./flowpilot.js");
