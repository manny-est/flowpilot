"use strict";

// Direct Chrome DevTools Protocol client for the UI fuzzer. Each OpenClaw CLI
// call costs ~4 s of process start-up, which made a 25-action sequence take
// ~15 minutes; a CDP Runtime.evaluate is milliseconds. OpenClaw still starts
// the browser profile and owns it; this only talks to its DevTools port
// (browser.profiles.<name>.cdpPort in ~/.openclaw/openclaw.json).

const http = require("http");

function httpJson(port, pathName, method) {
  return new Promise(function (resolve, reject) {
    const req = http.request({ host: "127.0.0.1", port: port, path: pathName, method: method || "GET" }, function (res) {
      let data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        try { resolve(data ? JSON.parse(data) : null); } catch (error) { resolve(data); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, function () { req.destroy(new Error("CDP HTTP timeout")); });
    req.end();
  });
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ready = null;
  }

  connect() {
    if (this.ready) { return this.ready; }
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = (event) => reject(new Error("CDP socket error: " + (event && event.message || "unknown")));
      ws.onclose = () => {
        this.pending.forEach(function (entry) { entry.reject(new Error("CDP socket closed")); });
        this.pending.clear();
        this.ready = null;
      };
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(String(event.data)); } catch (error) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) { entry.reject(new Error(msg.error.message || "CDP error")); } else { entry.resolve(msg.result); }
          return;
        }
        if (msg.method === "Page.javascriptDialogOpening") {
          // A native dialog ("Leave page?", confirm()) blocks the page; the
          // fuzzer always accepts it, like `openclaw browser dialog --accept`.
          this.send("Page.handleJavaScriptDialog", { accept: true }).catch(function () {});
          return;
        }
        if (msg.method) {
          this.events.push({ method: msg.method, params: msg.params, at: Date.now() });
          if (this.events.length > 500) { this.events.splice(0, this.events.length - 500); }
        }
      };
    }).then(async (session) => {
      await session.send("Page.enable").catch(function () {});
      await session.send("Runtime.enable").catch(function () {});
      await session.send("Log.enable").catch(function () {});
      return session;
    });
    return this.ready;
  }

  send(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) { reject(new Error("CDP socket not open")); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("CDP " + method + " timed out")); }
      }, timeoutMs || 30000);
      this.pending.set(id, {
        resolve: function (value) { clearTimeout(timer); resolve(value); },
        reject: function (error) { clearTimeout(timer); reject(error); }
      });
      this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }

  close() {
    try { if (this.ws) { this.ws.close(); } } catch (error) { /* already closed */ }
    this.ready = null;
  }
}

class CdpClient {
  constructor(port) {
    this.port = Number(port);
    this.sessions = new Map();
  }

  async pages() {
    const list = await httpJson(this.port, "/json/list");
    return (Array.isArray(list) ? list : []).filter(function (t) { return t && t.type === "page"; })
      .map(function (t) { return { targetId: t.id, tabId: t.id, url: t.url, title: t.title, wsUrl: t.webSocketDebuggerUrl }; });
  }

  async session(targetId) {
    let s = this.sessions.get(targetId);
    if (!s) {
      const page = (await this.pages()).find(function (p) { return p.targetId === targetId; });
      if (!page || !page.wsUrl) { throw new Error("CDP target not found: " + targetId); }
      s = new CdpSession(page.wsUrl);
      this.sessions.set(targetId, s);
    }
    return s.connect();
  }

  async evaluate(targetId, source, timeoutMs) {
    const session = await this.session(targetId);
    const result = await session.send("Runtime.evaluate", {
      // Callers pass either a function ("() => ...") or a ready-made call
      // expression ("(fn)(args)", buildInPageEvaluator); handle both.
      expression: "(async () => { const __fz = (" + source + "); return typeof __fz === 'function' ? await __fz() : await __fz; })()",
      awaitPromise: true, returnByValue: true, userGesture: true
    }, timeoutMs || 30000);
    if (result && result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error("Evaluate failed: " + ((d.exception && (d.exception.description || d.exception.value)) || d.text || "exception"));
    }
    return result && result.result ? result.result.value : undefined;
  }

  async open(url) {
    const target = await httpJson(this.port, "/json/new?" + encodeURIComponent(url), "PUT");
    return target && target.id ? { targetId: target.id, tabId: target.id, url: target.url } : null;
  }

  async close(targetId) {
    const s = this.sessions.get(targetId);
    if (s) { s.close(); this.sessions.delete(targetId); }
    await httpJson(this.port, "/json/close/" + encodeURIComponent(targetId)).catch(function () {});
    return true;
  }

  async activate(targetId) {
    await httpJson(this.port, "/json/activate/" + encodeURIComponent(targetId)).catch(function () {});
  }

  async screenshot(targetId) {
    const session = await this.session(targetId);
    const result = await session.send("Page.captureScreenshot", { format: "png" }, 20000);
    return result && result.data ? Buffer.from(result.data, "base64") : null;
  }

  async setViewport(targetId, width, height) {
    const session = await this.session(targetId);
    await session.send("Emulation.setDeviceMetricsOverride", { width: width, height: height, deviceScaleFactor: 1, mobile: false });
  }

  // Console errors, uncaught exceptions and failed resource loads since `since`.
  errorsSince(targetId, since) {
    const s = this.sessions.get(targetId);
    if (!s) { return []; }
    return s.events.filter(function (e) { return e.at >= since; }).map(function (e) {
      if (e.method === "Runtime.consoleAPICalled" && e.params && e.params.type === "error") {
        const text = (e.params.args || []).map(function (a) { return a.value !== undefined ? String(a.value) : (a.description || ""); }).join(" ");
        const frame = e.params.stackTrace && e.params.stackTrace.callFrames && e.params.stackTrace.callFrames[0];
        return { text: text, url: frame ? frame.url : "" };
      }
      if (e.method === "Runtime.exceptionThrown" && e.params && e.params.exceptionDetails) {
        const d = e.params.exceptionDetails;
        return { text: (d.exception && d.exception.description) || d.text || "exception", url: d.url || "" };
      }
      if (e.method === "Log.entryAdded" && e.params && e.params.entry && e.params.entry.level === "error") {
        return { text: e.params.entry.text || "", url: e.params.entry.url || "" };
      }
      return null;
    }).filter(Boolean);
  }
}

module.exports = { CdpClient: CdpClient };
