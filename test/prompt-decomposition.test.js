"use strict";

// R11-10: under Plan/Act, routing between modes happens in Plan
// (propose_action / Tier C). The mode prompts carry execution rules only —
// no "is this really a <mode> request?" section and no mode-redirect escape
// hatch. Classic chat keeps its chip routing (ADR-009: the fallback for
// providers without tools).

const assert = require("assert");
const generation = require("../lib/generation-system-prompt");
const documentPrompt = require("../lib/document-system-prompt");
const modify = require("../lib/modify-system-prompt");
const build = require("../lib/build-system-prompt");
const chat = require("../lib/default-system-prompt");

const ROUTING = /check this is actually a|escape hatch|mode mismatch|call `redirect_mode`|that's a (Generate|Modify|Document) request/;

[["generation", generation], ["document", documentPrompt], ["build", build],
 ["modify", modify({})], ["modify (agent write)", modify({ agentWriteEnabled: true })], ["modify (switch)", modify({ hasSwitch: true })]
].forEach(function (pair) {
  assert.ok(!ROUTING.test(pair[1]), pair[0] + ": no mode-routing section left (" + (pair[1].match(ROUTING) || [])[0] + ")");
});
assert.ok(/would you like me to generate this\?/.test(generation), "generation keeps the no-permission-seeking rule");
assert.ok(/would you like me to add this\?/.test(documentPrompt), "document keeps the no-permission-seeking rule");
assert.ok(/Suggested actions \("chips"\)/.test(chat), "classic chat keeps its chip routing");
console.log("prompt-decomposition tests passed");
