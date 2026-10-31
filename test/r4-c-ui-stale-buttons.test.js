"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "flowpilot-core.css"), "utf8");
const init = fs.readFileSync(path.join(root, "lib/core/init.js"), "utf8");
const main = fs.readFileSync(path.join(root, "lib/core/main.js"), "utf8");
const modes = fs.readFileSync(path.join(root, "lib/core/modes.js"), "utf8");

function functionBody(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.notEqual(start, -1, "found " + name);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") { depth++; }
    if (source[i] === "}" && --depth === 0) { return source.slice(start, i + 1); }
  }
  assert.fail("closed " + name);
}

test("slash suggestions are capped, scrollable, grouped, and keep the active row visible", () => {
  const panel = css.slice(css.indexOf("#fp-slash-suggest"), css.indexOf(".fp-slash-row"));
  assert.match(panel, /max-height\s*:/);
  assert.match(panel, /overflow-y\s*:\s*auto/);
  assert.match(init, /fp-slash-group-label/);
  assert.match(functionBody(init, "setActive"), /scrollIntoView/);
  assert.match(init, /getBoundingClientRect\(\)[\s\S]{0,700}\.css\("max-height"/);
});

test("provider status always exposes its full text as a title", () => {
  const writes = [
    ...main.matchAll(/el\("#fp-provider-status"\)\.text\(([^;]+)\)/g),
    ...init.matchAll(/el\("#fp-provider-status"\)\.text\(([^;]+)\)/g)
  ];
  assert.ok(writes.length >= 3, "all provider status writers found");
  writes.forEach(match => {
    const statement = match[0];
    assert.match(statement, /\.attr\("title"/);
  });
});

test("pop-out mirrors replace one record and receive settled control state", () => {
  assert.match(init, /dedupeMirroredRecord/);
  assert.match(init, /data\.event === "recordControlsSettled"/);
  assert.match(init, /data\.event === "appendMessage"[\s\S]{0,900}dedupeMirroredRecord/);
  assert.match(modes, /data-fp-record-id[\s\S]{0,500}_rec\.id[\s\S]{0,500}Proceeded/);
  assert.match(modes, /relayRecordControlsToPopout/);
});

test("undo records that cannot be undone stay disabled with a reason", () => {
  const render = functionBody(modes, "renderResultCard");
  assert.match(render, /undoUnavailable/);
  assert.match(render, /\.attr\("title"/);
  assert.match(render, /prop\("disabled",[\s\S]{0,100}undoUnavailable/);
  assert.match(render, /result\.undone[\s\S]{0,180}undoUnavailable/);
});

test("result-card testing owns and releases the working banner", () => {
  const renderTest = functionBody(modes, "runResultCardTest");
  assert.match(renderTest, /beginWorkingStatus/);
  assert.match(renderTest, /finish[\s\S]{0,350}fpWorkingStatus\.visible\s*=\s*false/);
  assert.match(renderTest, /renderWorkingStatus/);
});

test("one shared answered-control guard is used by every chip/card renderer", () => {
  assert.match(modes, /function guardRecordControls\(/);
  [
    "renderActionChip", "renderChip", "renderClarifyingQuestion",
    "renderBuildConsentGate", "renderDiffGatePause",
    "renderAgentToolConsentGate", "renderAskUserQuestion",
    "renderResultCard"
  ].forEach(name => assert.match(functionBody(modes, name), /guardRecordControls/,
    name + " uses the shared guard"));
});

console.log("R4-C regression tests loaded");
