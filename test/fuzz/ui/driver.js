"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

function execFile(command, args, options) {
  return new Promise((resolve, reject) => {
    const opts = Object.assign({ maxBuffer: 4 * 1024 * 1024 }, options || {});
    childProcess.execFile(command, args, opts, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(String(stdout || stderr || "").trim());
    });
  });
}

function parseOutput(output) {
  const text = String(output || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (error) {}
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch (error) {}
  }
  return text;
}

function safeError(error) {
  const envName = ["NR", "PASS"].join("_");
  const keyPrefix = ["s", "k", "-"].join("");
  return String(error && (error.message || error.stderr || error) || "OpenClaw command failed")
    .replace(new RegExp(envName + "\\s*=\\s*[^\\s]+", "gi"), envName + "=[redacted]")
    .replace(new RegExp(keyPrefix + "[A-Za-z0-9_-]+", "g"), keyPrefix + "[redacted]");
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.min(5000, Math.max(0, ms))));
}

// OpenClaw's --json tab objects carry tabId ("t4"), the handle every command
// accepts; targetId is the raw CDP id. Plain strings are already handles.
function tabId(tab) {
  if (typeof tab === "string") return tab;
  return tab && (tab.tabId || tab.suggestedTargetId || tab.targetId || tab.id || tab.handle);
}

function normalizeTabs(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.tabs)) return value.tabs;
  if (typeof value === "string") {
    return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => ({ id: line, title: line }));
  }
  return [];
}

class OpenClawDriver {
  constructor(options) {
    const opts = options || {};
    this.command = opts.command || "openclaw";
    this.profile = opts.profile || "fz-nrt";
    this.url = opts.url || "http://192.168.1.220:1850";
    this.timeout = Number(opts.timeout || 60000);
    this.retries = Number.isInteger(opts.retries) ? opts.retries : 2;
    this.mainTab = opts.mainTab || null;
    this.popoutTab = opts.popoutTab || null;
    this.lastError = null;
  }

  async invoke(command, args, options) {
    const opts = options || {};
    const attempts = Number.isInteger(opts.retries) ? opts.retries : this.retries;
    const timeout = Number(opts.timeout || this.timeout);
    const fullArgs = ["browser", "--browser-profile", this.profile].concat(opts.json ? ["--json"] : [], [command], args || []);
    let last;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try {
        const output = await execFile(this.command, fullArgs, {
          timeout,
          killSignal: "SIGTERM",
          env: process.env
        });
        this.lastError = null;
        return output;
      } catch (error) {
        last = error;
        this.lastError = safeError(error);
        if (attempt < attempts) await wait(100 * (attempt + 1));
      }
    }
    throw new Error(this.lastError || safeError(last));
  }

  async start() { return this.invoke("start"); }

  // The new tab's handle comes from open's own --json result: OpenClaw lists
  // tabs newest-first, so "the last tab" was the oldest one.
  async open(url) {
    const result = parseOutput(await this.invoke("open", [url || this.url], { json: true }));
    const candidate = result && typeof result === "object" && tabId(result) ? { tabId: tabId(result), url: result.url } : null;
    this.mainTab = candidate || this.mainTab;
    if (this.mainTab) await this.focus(this.mainTab);
    return this.mainTab;
  }

  async tabs() {
    return normalizeTabs(parseOutput(await this.invoke("tabs", [], { json: true })));
  }

  async focus(tab) {
    const id = tabId(tab) || tab;
    if (!id) return null;
    const result = parseOutput(await this.invoke("focus", [String(id)]));
    if (this.popoutTab && id === tabId(this.popoutTab)) this.popoutTab = tab;
    return result;
  }

  async resize(width, height) {
    return this.invoke("resize", [String(width), String(height || 640)]);
  }

  async evaluate(fn) {
    const source = typeof fn === "function" ? fn.toString() : String(fn);
    return parseOutput(await this.invoke("evaluate", ["--fn", source]));
  }

  async press(key) { return this.invoke("press", [key]); }

  async dialogAccept() {
    try { return await this.invoke("dialog", ["--accept"], { retries: 0, timeout: 5000 }); } catch (error) { return null; }
  }

  async reload() {
    // A native leave-page dialog blocks every later browser call. Arm the
    // dialog handler before asking the editor to reload, then give the new
    // document a short, bounded settling window.
    await this.dialogAccept();
    try {
      await this.invoke("evaluate", ["--fn", "() => { location.reload(); return true; }"], { retries: 0, timeout: 5000 });
    } catch (error) {
      this.lastError = safeError(error);
    }
    await wait(1200);
    return true;
  }

  async click(selector) {
    const encoded = JSON.stringify(String(selector));
    return this.evaluate("() => { const element = document.querySelector(" + encoded + "); if (!element || element.disabled) return false; element.click(); return true; }");
  }

  async typeAndSend(value) {
    const encoded = JSON.stringify(String(value));
    return this.evaluate("() => { const prompt = document.getElementById('fp-prompt'); const send = document.getElementById('fp-send'); if (!prompt || !send) return false; prompt.value = " + encoded + "; prompt.dispatchEvent(new Event('input', { bubbles: true })); send.click(); return true; }");
  }

  async addFixture(fixture) {
    const encoded = JSON.stringify(fixture && fixture.flow ? fixture.flow : fixture);
    // Onto the active (fuzz) tab with fresh ids. Node-RED 5's import takes an
    // options object; the old boolean was ignored, so a second import threw
    // "Imported duplicate nodes" and crashed the run.
    return this.evaluate("() => { const z = RED.workspaces.active(); const fixture = " + encoded + ".filter(n => n.type !== 'tab').map(n => Object.assign({}, n, { z })); if (!RED.nodes || typeof RED.nodes.import !== 'function') return false; RED.nodes.import(fixture, { generateIds: true, applyNodeDefaults: true }); RED.view.redraw(true); return true; }");
  }

  async switchEditorTab() {
    return this.evaluate("() => { const order = RED.nodes && RED.nodes.getWorkspaceOrder ? RED.nodes.getWorkspaceOrder() : []; if (!order.length || !RED.workspaces || !RED.workspaces.show) return false; const current = RED.workspaces.active(); const next = order[(Math.max(0, order.indexOf(current)) + 1) % order.length]; RED.workspaces.show(next); return next; }");
  }

  async chooseNextProvider() {
    return this.evaluate("() => { const select = document.getElementById('fp-provider-select'); if (!select || select.options.length < 2) return false; select.selectedIndex = (select.selectedIndex + 1) % select.options.length; select.dispatchEvent(new Event('change', { bubbles: true })); return select.value; }");
  }

  async closePopout() {
    if (this.popoutTab) {
      try {
        await this.invoke("close", [String(tabId(this.popoutTab))], { retries: 1 });
        this.popoutTab = null;
        return true;
      } catch (error) {}
    }
    return this.evaluate("() => { if (window.opener) { window.close(); return true; } return false; }");
  }

  async deleteTab(tab) {
    const id = tabId(tab) || tab;
    if (!id) return false;
    try {
      await this.invoke("close", [String(id)], { retries: 1 });
      return true;
    } catch (error) {
      return false;
    }
  }

  async deploy() {
    return this.evaluate("() => { if (!RED.deploy) return false; RED.deploy(); return true; }");
  }

  async actionState() {
    const state = await this.evaluate("() => { const visible = b => b && b.offsetParent && !b.disabled; const q = s => [...document.querySelectorAll(s)].filter(visible); const stop = q('#fp-root button.fp-working-stop').length > 0; return { busy: stop, canSend: !!document.getElementById('fp-send') && !document.getElementById('fp-send').disabled, approve: q('#fp-messages button[data-fp-record-action=propose-act]').length, proceed: q('#fp-messages button[data-fp-record-action=proceed]').length, keep: q('#fp-messages button[data-fp-record-action=keep]').length, undo: q('#fp-messages button[data-fp-record-action=result-undo]').length, options: q('#fp-messages button.fp-question-option').length, queued: document.querySelector('.fp-compose') && document.querySelector('.fp-compose').classList.contains('fp-has-queued'), popoutOpen: !!window.__flowPilotPopoutOpen, hasProviderChoice: !!document.getElementById('fp-provider-select'), placeholder: document.getElementById('fp-prompt') && document.getElementById('fp-prompt').placeholder }; }");
    if (state && this.popoutTab) state.popoutOpen = true;
    return state;
  }

  // New FlowPilot errors since the previous call: console messages of type
  // "error" and page errors whose text or source is FlowPilot's own code.
  // (Plain-text output such as "No page errors." is never an error.)
  async captureConsole() {
    const since = this.lastConsoleCheck || 0;
    this.lastConsoleCheck = Date.now();
    const fromFlowPilot = item => /flowpilot/i.test(JSON.stringify(item && (item.location || item.url || item.stack || ""))) ||
      /flowpilot/i.test(String(item && (item.text || item.message) || ""));
    const fresh = item => !item || !item.timestamp || Date.parse(item.timestamp) >= since;
    const out = [];
    const consoleResult = parseOutput(await this.invoke("console", [], { retries: 0, timeout: 10000, json: true }));
    (consoleResult && Array.isArray(consoleResult.messages) ? consoleResult.messages : []).forEach(item => {
      if (item && item.type === "error" && fresh(item) && fromFlowPilot(item)) out.push(String(item.text || "").slice(0, 300));
    });
    const errorsResult = parseOutput(await this.invoke("errors", [], { retries: 0, timeout: 10000, json: true }));
    (errorsResult && Array.isArray(errorsResult.errors) ? errorsResult.errors : []).forEach(item => {
      if (fresh(item) && fromFlowPilot(item)) out.push(String((item && (item.message || item.text)) || item).slice(0, 300));
    });
    return out;
  }

  async screenshot(outputPath) {
    const target = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      await this.invoke("screenshot", ["--output", target], { retries: 1 });
      if (fs.existsSync(target)) return target;
    } catch (error) {}
    try {
      const result = await this.invoke("screenshot", [], { retries: 0 });
      if (typeof result === "string" && result.indexOf("data:image/") === 0) {
        fs.writeFileSync(target, Buffer.from(result.split(",")[1], "base64"));
        return target;
      }
    } catch (error) {}
    return null;
  }
}

module.exports = {
  OpenClawDriver,
  normalizeTabs,
  parseOutput,
  safeError
};
