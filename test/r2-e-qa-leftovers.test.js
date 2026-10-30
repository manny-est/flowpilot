"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const intake = require("../lib/core/intake.js");

const root = path.join(__dirname, "..");
const modes = fs.readFileSync(path.join(root, "lib/core/modes.js"), "utf8");
const init = fs.readFileSync(path.join(root, "lib/core/init.js"), "utf8");
const css = fs.readFileSync(path.join(root, "flowpilot-core.css"), "utf8");
const applyReview = fs.readFileSync(path.join(root, "lib/core/apply-review.js"), "utf8");
const server = fs.readFileSync(path.join(root, "flowpilot.js"), "utf8");
const modifyPrompt = fs.readFileSync(path.join(root, "lib/modify-system-prompt.js"), "utf8");

function functionSource(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "found " + name);
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") { depth += 1; }
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > start, "closed " + name);
  return source.slice(start, end);
}

// QA F2: a model's answers are its own options. Only FlowPilot's explicit
// target question gets the editor picker, and duplicate picker rows collapse.
test("F2 model options and target picker labels", () => {
  const candidates = [
    { id: "a", name: "Show it", type: "debug" },
    { id: "b", name: "Show it", type: "debug" },
    { id: "c", name: "Other", type: "function" }
  ];
  assert.deepEqual(
    intake.askUserOptions({ target: { kind: "unresolved" }, candidates },
      { question: "Which weather API?", options: ["Open-Meteo", "WeatherAPI"] }),
    ["Open-Meteo", "WeatherAPI"],
    "model-provided options survive an unresolved target"
  );
  const picker = intake.askUserOptions({ target: { kind: "unresolved" }, candidates },
    { question_kind: "target" });
  assert.deepEqual(picker, ["Show it [debug]", "Other [function]", "Something else (describe it)"]);
  assert.equal(new Set(picker).size, picker.length, "picker labels are unique");
  assert.match(server, /question_kind[\s\S]{0,180}enum: \["intent", "target"\]/,
    "ask_user accepts the target-question discriminator");
  assert.match(modifyPrompt, /question_kind.*target.*existing node/i,
    "modify guidance teaches the target-question discriminator");
});

// Exploratory active-tab scope: an off-tab inject must not make an empty
// active tab look non-empty to Modify's Generate fallback.
test("active-tab candidates drive the empty-tab Generate fallback", () => {
  const oldRed = global.RED;
  global.RED = {
    workspaces: { active: () => "tab-active" },
    nodes: {
      eachNode: (callback) => callback({ id: "off-tab", type: "inject", name: "Tick", z: "tab-other" }),
      workspace: () => null,
      node: () => null
    }
  };
  try {
    const built = intake.buildIntake("Add an inject node", {}, {
      activeTab: { id: "tab-active", label: "Empty" },
      activeSelectionIds: () => []
    });
    assert.deepEqual(built.candidates, [], "off-tab nodes are excluded from intake candidates");
  } finally {
    global.RED = oldRed;
  }
});

// QA S9: busy state is independent of the Send button's disabled property;
// both the main and pop-out paths must continue through dispatchSend so a
// typed message can be queued by the shared busy-run branch.
test("S9 busy Send queues in both window paths", () => {
  assert.match(modes, /function isRunBusy\(\)/, "shared busy predicate exists");
  assert.match(modes, /if \(!isPopoutContext && isRunBusy\(\)\)/,
    "main-window Send queues while a run is busy");
  assert.doesNotMatch(modes, /el\("#fp-send"\)\.prop\("disabled", busy\)/,
    "busy runs do not disable Send");
  const popoutStart = init.indexOf("function initPopout");
  const mainStart = init.indexOf("function initMainWindow");
  assert.ok(popoutStart >= 0 && mainStart > popoutStart, "both window initializers exist");
  const popout = init.slice(popoutStart, mainStart);
  const main = init.slice(mainStart);
  assert.match(popout, /#fp-send[\s\S]{0,180}dispatchSend\(\)/, "pop-out Send uses shared dispatch");
  assert.match(main, /#fp-send[\s\S]{0,180}dispatchSend\(\)/, "main Send uses shared dispatch");
});

// QA S12c: slash autocomplete is bound before either Enter-to-send handler;
// the autocomplete handler's stopImmediatePropagation can therefore consume
// Enter without also sending the partial command.
function enterHandlerOffset(source) {
  return source.indexOf('if (e.key === "Enter" && !e.shiftKey)');
}
test("S12c slash Enter is consumed by autocomplete", () => {
  const popoutStart = init.indexOf("function initPopout");
  const mainStart = init.indexOf("function initMainWindow");
  const popout = init.slice(popoutStart, mainStart);
  const main = init.slice(mainStart);
  assert.ok(popout.indexOf("bindSlashAutocomplete(el(\"#fp-prompt\"))") < enterHandlerOffset(popout),
    "pop-out slash handler runs before Enter-to-send");
  assert.ok(main.indexOf("bindSlashAutocomplete(el(\"#fp-prompt\"))") < enterHandlerOffset(main),
    "main slash handler runs before Enter-to-send");
  assert.match(init, /e\.stopImmediatePropagation\(\)/, "slash selection stops later keydown handlers");
});

// QA S15: command names and descriptions have separate wrapped lines at
// narrow widths, so neither overlaps nor forces horizontal scrolling.
test("S15 narrow slash menu rows wrap", () => {
  assert.match(css, /\.fp-slash-row\s*\{[^}]*flex-wrap\s*:\s*wrap/s);
  assert.match(css, /\.fp-slash-cmd\s*\{[^}]*flex:\s*0\s+0\s+100%/s);
  assert.match(css, /\.fp-slash-desc\s*\{[^}]*white-space:\s*normal/s);
});

// Layout regression: the normal generated-flow layout follows wires left to
// right, while insertion anchoring clamps away the canvas corner.
test("layout supplies coordinates, follows wires, and avoids the canvas corner", () => {
  const layoutGeneratedFlow = new Function("return " + functionSource(applyReview, "layoutGeneratedFlow"))();
  const chain = [
    { id: "a", type: "inject", wires: [["b"]] },
    { id: "b", type: "function", wires: [["c"]] },
    { id: "c", type: "debug", wires: [[]] }
  ];
  layoutGeneratedFlow(chain);
  assert.ok(chain.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert.ok(chain.every((node) => !(node.x === 0 && node.y === 0)), "no generated node lands at 0,0");
  assert.ok(chain[0].x < chain[1].x && chain[1].x < chain[2].x, "wired chain grows left to right");
  assert.match(applyReview, /n\.x\s*=\s*Math\.max\(MIN_CANVAS_X/,
    "anchored insertions clamp their x position away from 0");
  assert.match(applyReview, /n\.y\s*=\s*Math\.max\(MIN_CANVAS_Y/,
    "anchored insertions clamp their y position away from 0");
});

console.log("R2-E QA leftovers regression tests passed");
