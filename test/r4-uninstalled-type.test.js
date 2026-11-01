"use strict";
// QA pass 4 (S10): a creative build included a ui_page node (not installed).
// Half the step was created; the model resent it, hit "already created" until
// the run stopped, and FlowPilot said "Done — all approved plan steps are
// already built" with nothing on the tab.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const main = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "main.js"), "utf8");
const precheckSrc = main.match(/function applyStepPrecheck\(args, creationState\) \{[\s\S]*?\n    \}\n/)[0];

function precheck(installed, args) {
  const RED = { nodes: { getType: t => (installed.indexOf(t) !== -1 ? {} : null) } };
  return new Function("RED", "creationFirstWriteError", "uninvitedContribNodes",
    precheckSrc + "return applyStepPrecheck;")(RED, undefined, undefined)(args, null);
}

test("a step with a node type Node-RED doesn't have is refused before anything is created", () => {
  const r = precheck(["inject", "function", "debug"], { newNodes: [
    { id: "n1", type: "inject" }, { id: "n2", type: "function" }, { id: "n6", type: "ui_page" }] });
  assert.ok(r && /Node type not installed: ui_page/.test(r.error));
  assert.deepEqual(r.uninstalledTypes, ["ui_page"]);
  assert.equal(r.retryable, true);
});

test("installed types, groups and junctions pass", () => {
  assert.equal(precheck(["inject", "debug"], { newNodes: [
    { id: "n1", type: "inject" }, { id: "g", type: "group" }, { id: "j", type: "junction" }, { id: "n2", type: "debug" }] }), null);
});

test("the re-plan never says 'Done … built' when nothing was built", () => {
  const modes = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "modes.js"), "utf8");
  const chip = modes.slice(modes.indexOf("function renderReplanChip"), modes.indexOf("function renderReplanChip") + 900);
  assert.match(chip, /built\.length\s*\?\s*"Done — all approved plan steps are already built\."\s*:\s*"The run stopped and nothing was built/);
});
