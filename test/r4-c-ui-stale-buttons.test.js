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
  assert.match(render, /resultCardUndoState/);
  assert.match(render, /\.attr\("title", undoUnavailable\)/);
  assert.match(render, /prop\("disabled", !!rec\.undone \|\| !undoState\.available\)/);
});

test("review: Test it and Undo never go through the one-shot chip guard (Test it must not lock Undo)", () => {
  const render = functionBody(modes, "renderResultCard");
  const undoClick = render.slice(render.indexOf('"result-undo"'), render.indexOf('"result-test"'));
  const testClick = render.slice(render.indexOf('"result-test"'));
  assert.doesNotMatch(undoClick, /guardRecordControls/);
  assert.doesNotMatch(testClick.slice(0, 400), /guardRecordControls/);
  assert.doesNotMatch(render, /rec\.undoUnavailable\s*=/);
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
    "renderAgentToolConsentGate", "renderAskUserQuestion"
    // renderResultCard is deliberately excluded: Undo/Test it are not one-shot
    // chips (see the review test above).
  ].forEach(name => assert.match(functionBody(modes, name), /guardRecordControls/,
    name + " uses the shared guard"));
});

console.log("R4-C regression tests loaded");

test("review (live): pop-out dedupe keeps the newest copy of a re-rendered card", () => {
  const body = init.slice(init.indexOf("function dedupeMirroredRecord"), init.indexOf("function dedupeMirroredRecord") + 1400);
  assert.match(body, /if \(newest\[key\]\) \{ \$\(newest\[key\]\)\.remove\(\); \}\s*newest\[key\] = this;/);
  assert.doesNotMatch(body, /if \(seen\[key\]\) \{ \$node\.remove\(\); \}/);
});

test("review (live): the pop-out drops the empty state when a real message arrives", () => {
  assert.match(init, /data\.event === "appendMessage"\) \{[\s\S]{0,400}find\("#fp-empty-state"\)\.remove\(\)/);
});

test("QA pass 4b: a card's nested same-record row isn't a duplicate (the pop-out lost the whole proposal)", () => {
  const body = init.slice(init.indexOf("function dedupeMirroredRecord"), init.indexOf("function dedupeMirroredRecord") + 2600);
  assert.match(body, /groups\[key\]\[0\]\.contains\(\$group\[0\]\) \|\| \$group\[0\]\.contains\(groups\[key\]\[0\]\)/);
  assert.ok(body.indexOf(".contains($group[0])") < body.indexOf("groups[key].remove();"), "the nesting check runs before any removal");
});
