"use strict";

// P1-36: exercise the browser bundle's real cancellation boundary in a small
// VM.  The fake DOM is intentionally only the jQuery surface used by the
// lifecycle/question renderers; no Node-RED runtime is needed here.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { buildCoreScript } = require("../lib/build-core-script");

function makeDom() {
  const elements = {};
  const created = [];

  function Node(selector) {
    this.selector = selector || "<node>";
    this.children = [];
    this.attrs = {};
    this.props = {};
    this.classes = {};
    this.handlers = {};
    this.value = "";
    this.textValue = "";
    this.length = 1;
    this[0] = { scrollHeight: 0 };
    created.push(this);
  }
  Node.prototype.find = function (selector) {
    if (this.selector === "#fp-root") { return root.find(selector); }
    const found = [];
    function walk(node) {
      (node.children || []).forEach(function (child) {
        if (selector === "button" && child.selector === "<button>") { found.push(child); }
        if (selector === "input" && child.selector === "<input>") { found.push(child); }
        if (selector === "button, input" && (child.selector === "<button>" || child.selector === "<input>")) { found.push(child); }
        walk(child);
      });
    }
    walk(this);
    return collection(found);
  };
  Node.prototype.addClass = function (cls) { String(cls || "").split(/\s+/).forEach(c => { if (c) { this.classes[c] = true; } }); return this; };
  Node.prototype.removeClass = function (cls) { delete this.classes[cls]; return this; };
  Node.prototype.toggleClass = function (cls, on) { this.classes[cls] = !!on; return this; };
  Node.prototype.attr = function (key, value) { if (arguments.length > 1) { this.attrs[key] = value; return this; } return this.attrs[key]; };
  Node.prototype.prop = function (key, value) { if (arguments.length > 1) { this.props[key] = value; return this; } return this.props[key]; };
  Node.prototype.val = function (value) { if (arguments.length) { this.value = value; return this; } return this.value; };
  Node.prototype.text = function (value) { if (arguments.length) { this.textValue = String(value); return this; } return this.textValue; };
  Node.prototype.html = function () { return this; };
  Node.prototype.append = function () { Array.prototype.slice.call(arguments).forEach(child => { if (child && child.children) { this.children.push(child); } }); return this; };
  Node.prototype.appendTo = function (parent) { if (parent && parent.children) { parent.children.push(this); } return this; };
  Node.prototype.empty = function () { this.children = []; return this; };
  Node.prototype.remove = function () { this.removed = true; return this; };
  Node.prototype.on = function (event, handler) { this.handlers[event] = handler; return this; };
  Node.prototype.focus = function () { return this; };
  Node.prototype.scrollTop = function () { return this; };

  function collection(nodes) {
    const c = new Node("<collection>");
    c.children = nodes || [];
    c.length = c.children.length;
    c[0] = c.children[0] || { scrollHeight: 0 };
    ["addClass", "removeClass", "toggleClass", "attr", "prop", "val", "text", "html", "append",
      "appendTo", "empty", "remove", "on", "focus", "scrollTop"].forEach(function (name) {
      c[name] = function () {
        const args = arguments;
        if ((name === "attr" || name === "prop") && args.length === 1) {
          return c.children.length ? Node.prototype[name].apply(c.children[0], args) : undefined;
        }
        if (name === "val" && args.length === 0) {
          return c.children.length ? Node.prototype[name].apply(c.children[0], args) : "";
        }
        c.children.forEach(function (node) { Node.prototype[name].apply(node, args); });
        return c;
      };
    });
    c.find = function (selector) {
      let all = [];
      c.children.forEach(function (node) { all = all.concat(node.find(selector).children); });
      return collection(all);
    };
    return c;
  }

  const root = new Node("#fp-root");
  ["#fp-send", "#fp-prompt", ".fp-compose", "#fp-messages", "#fp-working-status",
    "#fp-test-provider", "#fp-recall", "#fp-chat-panel", "#fp-settings-panel",
    "#fp-history-panel", "#fp-show-chat", "#fp-show-settings", "#fp-show-history",
    "#fp-loop-stepper"].forEach(function (selector) {
    elements[selector] = new Node(selector);
    if (selector === "#fp-send") { elements[selector].props.disabled = false; }
  });
  root.find = function (selector) { return elements[selector] ? collection([elements[selector]]) : collection([]); };

  function $fake(value) {
    if (value instanceof Node) { return collection([value]); }
    if (typeof value === "string" && value.charAt(0) === "<") { return collection([new Node(value)]); }
    return collection([]);
  }
  return { root, elements, created, $: $fake, Node };
}

function load() {
  const dom = makeDom();
  const window = {
    location: { href: "http://localhost/", origin: "http://localhost", pathname: "/", search: "" },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {},
    opener: null
  };
  const RED = {
    settings: { get: () => null, apiRootUrl: "" },
    nodes: { node: () => null, eachNode: () => {}, dirty: () => false },
    events: { on: () => {} },
    history: { push: () => {} },
    view: { redraw: () => {} }
  };
  const context = { window, document: { createTextNode: text => ({ textContent: text }) }, RED,
    $, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, Math, isFinite,
    encodeURIComponent, decodeURIComponent, location: window.location };
  function $(value) { return dom.$(value); }
  context.ajaxCalls = [];
  $.ajax = function (options) {
    const request = { options, aborted: false, abort: function () { this.aborted = true; } };
    request.done = function (handler) { this.doneHandler = handler; return this; };
    request.fail = function (handler) { this.failHandler = handler; return this; };
    request.always = function (handler) { this.alwaysHandler = handler; return this; };
    context.ajaxCalls.push(request);
    return request;
  };
  context.$ = $;
  let source = buildCoreScript();
  source = source.replace(/\n\}\)\(\);\s*$/, "\n" +
    "window.__p136 = {" +
    "setRoot:function(v){$root=v;} , end:endActiveRun, clear:clearChat, send:dispatchSend, sendRoute:send, " +
    "busy:setBusy, " +
    "consent:renderAgentToolConsentGate, ask:renderAskUserQuestion, " +
    "setState:function(v){activeRunState=v; activeRunCancelled=false;}, " +
    "setQueued:function(v){queuedMessage=v; updateQueuedIndicator();}, " +
    "setRequest:function(v){fpCurrentAgentRequest=v;}, " +
    "get:function(){return {state:activeRunState, cancelled:activeRunCancelled, queued:queuedMessage, records:messageRecords.slice()};}" +
    "};\n})();\n");
  vm.runInNewContext(source, context, { filename: "flowpilot-core.js" });
  context.window.__p136.setRoot(dom.root);
  return { api: context.window.__p136, dom, context };
}

function buttons(dom) { return dom.created.filter(node => node.selector === "<button>" && node.handlers.click); }

// The required no-op guarantee: a quiet editor must not manufacture a stop,
// clear a draft, or call setBusy's queue flush path.
{
  const h = load();
  assert.strictEqual(h.api.end("nothing-running"), false);
  assert.strictEqual(h.dom.elements["#fp-send"].props.disabled, false);
}

// Consent: Clear/end invalidates the old Proceed handler, releases Send, and
// aborts the request if one was still attached to the run.
{
  const h = load();
  let resumed = 0;
  let settled = null;
  h.api.setState({ ended: false, waitingRecord: null, answer: null, cancel: () => { settled = "stopped"; } });
  h.api.setRequest({ abort: () => { h.aborted = (h.aborted || 0) + 1; } });
  h.api.consent({ name: "apply_step", args: { summary: "change it" }, onResume: () => { resumed++; } });
  const oldProceed = buttons(h.dom).find(button => button.textValue === "Proceed");
  assert.ok(oldProceed, "consent rendered");
  h.api.setQueued({ text: "stale queued message", deferred: false });
  h.api.clear();
  oldProceed.handlers.click();
  assert.strictEqual(resumed, 0, "late Proceed is inert");
  assert.strictEqual(h.dom.elements["#fp-send"].props.disabled, false, "Send enabled after clear/end");
  assert.strictEqual(h.api.get().queued, null, "queue cleared");
  assert.strictEqual(h.aborted, 1, "in-flight request aborted");
  assert.strictEqual(settled, "stopped", "Stop/Clear settles the waiting run");
}

// ask_user: typing in the disabled composer answers the waiting question;
// after cancellation, its stale callback is inert and no continuation runs.
{
  const h = load();
  let answers = [];
  h.api.busy(true);
  h.api.ask({ question: "Which target?", options: ["A"], onAnswer: answer => answers.push(answer) });
  h.dom.elements["#fp-prompt"].value = "typed answer";
  h.api.send();
  assert.deepStrictEqual(answers, ["typed answer"], "typed text answers ask_user");
  assert.strictEqual(h.dom.elements["#fp-send"].props.disabled, true, "continuation remains the active run");
  h.api.end("clear-chat");
  assert.strictEqual(h.dom.elements["#fp-send"].props.disabled, false);
}

// Clear while ask_user is paused: the next ordinary Send starts a request,
// rather than being trapped in the old queued-message path.
{
  const h = load();
  h.api.busy(true);
  h.api.ask({ question: "Which target?", options: ["A"], onAnswer: () => {} });
  h.api.end("clear-chat");
  h.api.setQueued(null);
  h.dom.elements["#fp-prompt"].value = "fresh message";
  h.api.sendRoute("chat");
  assert.strictEqual(h.api.get().queued, null, "fresh message was not queued");
  assert.strictEqual(h.context.ajaxCalls.length, 1, "fresh message dispatched");
}

// A late model response after Clear is ignored: it cannot add an assistant
// bubble or apply a write through the old callback.
{
  const h = load();
  h.api.busy(true);
  h.dom.elements["#fp-prompt"].value = "in flight";
  h.api.sendRoute("chat");
  assert.strictEqual(h.context.ajaxCalls.length, 1);
  const before = h.api.get().records.length;
  h.api.end("clear-chat");
  h.context.ajaxCalls[0].options.success({ message: "late response" });
  assert.strictEqual(h.api.get().records.length, before, "late response was ignored");
}

console.log("P1-36 clear-ends-run tests passed");
