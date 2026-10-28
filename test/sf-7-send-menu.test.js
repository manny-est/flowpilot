"use strict";

// SF-7 ▾ menu: the real main.js functions, with a stub for the ▾ button.
// A choice applies to the next send only, replaces any earlier choice, shows
// on the button while armed, and "normal" clears it.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const main = fs.readFileSync(path.join(__dirname, "..", "lib", "core", "main.js"), "utf8");
function grab(name) {
  const m = main.match(new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}\\n"));
  assert.ok(m, name + " exists in main.js");
  return m[0];
}
const button = { text: "▾", armed: false, title: "" };
const el = function () {
  return {
    text: function (t) { button.text = t; return this; },
    toggleClass: function (c, on) { button.armed = !!on; return this; },
    attr: function (k, v) { button.title = v; return this; }
  };
};
const api = new Function("el", "var nextSendFlags = null;\n" +
  grab("setNextSendFlags") + grab("chooseNextSendFlag") + grab("consumeNextSendFlags") + grab("renderNextSendFlags") +
  "return { choose: chooseNextSendFlag, consume: consumeNextSendFlags, set: setNextSendFlags };")(el);

api.choose("planFirst");
assert.strictEqual(button.text, "▾ Plan first", "the armed choice shows on the button");
assert.strictEqual(button.armed, true);
api.choose("justDoIt");
assert.deepStrictEqual(api.consume(), { justDoIt: true }, "a later choice replaces the earlier one");
assert.strictEqual(button.text, "▾", "the button resets once the send uses the choice");
assert.deepStrictEqual(api.consume(), {}, "one send only");

api.choose("planFirst");
api.choose("normal");
assert.deepStrictEqual(api.consume(), {}, "Normal clears the choice");
assert.strictEqual(button.armed, false);

api.set({ planFirst: true }); // /plan prefix path
assert.deepStrictEqual(api.consume(), { planFirst: true });

console.log("SF-7 send-menu tests passed");
