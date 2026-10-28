#!/usr/bin/env node
"use strict";

// W1 Corpus Runner — FlowPilot Phase 10
// ───────────────────────────────────────
// Sends structured test cases to a live FlowPilot / Node-RED instance,
// classifies each response by failure kind, writes results-<ts>.json.
//
// Usage (from host, nodered-test port-forwarded to 1880):
//   node runner.js
//   NR_URL=http://localhost:1880 node runner.js
//
// Usage (inside the nodered-test container):
//   docker exec nodered-test node /path/to/runner.js
//
// Env vars:
//   NR_URL      Base URL of Node-RED admin (default: http://127.0.0.1:1880)
//   NR_USER     Username for adminAuth  (default: fp-test)
//   NR_PASS     Password (required; no default. Test-instance credentials
//               live in dev-docs, never in the repo)
//   DELAY_MS    Milliseconds between requests (default: 4000)
//   OUTPUT_DIR  Directory to write results JSON (default: this script's dir)
//
// PRECONDITION as of 2026-08-30 (ADR-007, the provider-confirmation gate):
// every case here hits an operational route (generate/modify/agent-step),
// which now 409s with "provider_unconfirmed" unless the corpus's target
// provider has already passed a real POST /flowpilot/test. This is NOT
// something the corpus itself can do (the check requires strict
// provider-shape validation on a real response, deliberately not fakeable)
// — run Test Provider once via the UI (or POST /flowpilot/test directly)
// against whichever provider NR_URL/activeProviderId points at before
// running this. Confirmation is cleared automatically whenever that
// provider's baseUrl or apiKey changes, so this can silently start failing
// again after any settings reset — if EVERY case suddenly shows
// provider_unconfirmed, this is why, not a real regression.

const https = require("https");

// "expect" is one kind, or (R11-10, 2026-10-26) a list of acceptable kinds
// for cases whose meaning changed when routing moved into Plan.
function expectMatches(expect, kind) {
  return Array.isArray(expect) ? expect.indexOf(kind) !== -1 : expect === kind;
}
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

const NR_URL     = process.env.NR_URL     || "http://127.0.0.1:1880";
const NR_USER    = process.env.NR_USER    || "fp-test";
const NR_PASS    = process.env.NR_PASS;
const DELAY_MS   = parseInt(process.env.DELAY_MS || "4000", 10);
const OUTPUT_DIR = process.env.OUTPUT_DIR || __dirname;

const CASES_FILE = path.join(__dirname, "cases.json");
const cases = JSON.parse(fs.readFileSync(CASES_FILE, "utf8"));

// ── HTTP helper ────────────────────────────────────────────────────────────

function post(url, body, token) {
  return new Promise(function (resolve, reject) {
    const parsed   = new URL(url);
    const lib      = parsed.protocol === "https:" ? https : http;
    const bodyStr  = JSON.stringify(body);
    const headers  = {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(bodyStr)
    };
    if (token) headers["Authorization"] = "Bearer " + token;

    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname,
      method:   "POST",
      headers:  headers
    }, function (res) {
      let data = "";
      res.on("data", function (c) { data += c; });
      res.on("end", function () {
        let parsed;
        try { parsed = JSON.parse(data); } catch (e) { parsed = { _raw: data }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// ── Auth ───────────────────────────────────────────────────────────────────

async function getToken() {
  const res = await post(NR_URL + "/auth/token", {
    client_id:  "node-red-admin",
    grant_type: "password",
    scope:      "*",
    username:   NR_USER,
    password:   NR_PASS
  });
  if (res.status !== 200 || !res.body.access_token) {
    throw new Error("Auth failed (HTTP " + res.status + "): " + JSON.stringify(res.body));
  }
  return res.body.access_token;
}

// ── Classification ─────────────────────────────────────────────────────────
// Returns one of:
//   success | question | prose | mode_redirect | asked_permission |
//   parse_error | wrong_envelope | wrong_content | no_changes |
//   empty_flow | fixed_script_success | fixed_script_error |
//   bad_request | server_error | http_error | network_error

const PERMISSION_RE = /\b(should\s+i|would\s+you\s+like|shall\s+i|do\s+you\s+want|want\s+me\s+to|may\s+i)\b/i;

function classify(endpoint, status, body) {
  if (status === 0)   return "network_error";
  if (status === 400 && body && body.error === "strategy_required") return "strategy_required";
  if (status === 409 && body && body.error === "agent_strategy_unavailable") return "agent_strategy_unavailable";
  if (status >= 500)  return "server_error";
  if (status === 400) return "bad_request";

  // 422 = parse/validation failure from processGenerationContent or
  //        reference-validation inside finalizeModifyResult
  if (status === 422) {
    const err = (body && body.error) || "";
    if (/could not parse/i.test(err))                              return "parse_error";
    if (/did not contain a.+flow|recognizable modify fields/i.test(err)) return "wrong_envelope";
    if (/not in the selection|wire references|group references/i.test(err)) return "wrong_content";
    return "parse_error";   // fallback for other 422 shapes
  }

  if (status !== 200) return "http_error";

  // prose: true — model returned plain text instead of a JSON envelope
  if (body && body.prose === true) {
    if (body.suggestedAction && body.suggestedAction.mode) {
      return "mode_redirect";
    }
    const text = ((body.explanation || "") + " " + (body.prose || "")).toLowerCase();
    if (PERMISSION_RE.test(text)) return "asked_permission";
    return "prose";
  }

  // Clarifying question envelope
  if (body && body.question) return "question";

  // Generate / Build / Document response
  if (endpoint === "generate" || endpoint === "build" || endpoint === "document") {
    if (!body || !Array.isArray(body.flow) || body.flow.length === 0) return "empty_flow";
    return "success";
  }

  // Modify response (finalizeModifyResult always returns flow + arrays on 200 non-prose/question)
  if (endpoint === "modify") {
    // Unexpected mode redirect embedded in a modify-shaped response
    if (body && body.suggestedAction && body.suggestedAction.mode &&
        body.suggestedAction.mode !== "modify") {
      return "mode_redirect";
    }
    const hasWork = (Array.isArray(body && body.flow)        && body.flow.length > 0) ||
                    (Array.isArray(body && body.newNodes)     && body.newNodes.length > 0) ||
                    (Array.isArray(body && body.removeNodes)  && body.removeNodes.length > 0);
    if (!hasWork) return "no_changes";
    return "success";
  }

  return "unknown";
}

// ── Fixed WRITE-tool scripts ──────────────────────────────────────────────
// W7 Round 1 deliberately adds a few deterministic call→result fixtures,
// not a general multi-turn mocking framework. These prove that the client-
// shaped role:"tool" content round-trips as exact JSON and uses §16's
// structural check vocabulary before the live provider corpus runs.

const WRITE_TOOL_NAMES = new Set(["apply_step", "remove_step", "rename_node"]);
const CHECK_NAMES = new Set(["property", "exists", "absent", "wire"]);

function validateFixedToolResult(toolName, result) {
  if (toolName === "ask_user") {
    return result && typeof result.answer === "string" && result.answer.length > 0
      ? null : "ask_user result requires a non-empty answer";
  }
  if (!WRITE_TOOL_NAMES.has(toolName)) return "unsupported scripted tool " + toolName;
  if (!result || !Array.isArray(result.checks) || result.checks.length === 0) {
    return "WRITE result requires non-empty checks";
  }
  for (let i = 0; i < result.checks.length; i++) {
    const check = result.checks[i];
    if (!check || !CHECK_NAMES.has(check.check)) return "invalid check vocabulary";
    if (typeof check.pass !== "boolean") return "check.pass must be boolean";
    if (!Object.prototype.hasOwnProperty.call(check, "expected") ||
        !Object.prototype.hasOwnProperty.call(check, "actual")) {
      return "check requires expected and actual";
    }
    if (check.check === "wire") {
      if (!check.fromId || !Number.isInteger(check.fromPort) || !check.toId) {
        return "wire check requires fromId/fromPort/toId";
      }
    } else if (!check.nodeId) {
      return check.check + " check requires nodeId";
    }
    if (check.check === "property" && !check.prop) {
      return "property check requires prop";
    }
  }
  return null;
}

function runFixedScriptCase(c) {
  const started = Date.now();
  const script = c.fixedScript;
  if (!script || !script.call || !script.result) {
    return {
      id: c.id, endpoint: "fixed-script", description: c.description,
      expect: c.expect, kind: "fixed_script_error", pass: false, status: 0,
      durationMs: Date.now() - started, networkError: "malformed fixedScript"
    };
  }

  const call = script.call;
  const messages = [{
    role: "assistant",
    content: null,
    tool_calls: [{
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments || {})
      }
    }]
  }, {
    role: "tool",
    tool_call_id: call.id,
    content: JSON.stringify(script.result)
  }];

  let error = validateFixedToolResult(call.name, script.result);
  let parsed;
  try { parsed = JSON.parse(messages[1].content); }
  catch (err) { error = "tool result did not round-trip as JSON"; }
  if (!error && JSON.stringify(parsed) !== JSON.stringify(script.result)) {
    error = "tool result changed during message round-trip";
  }

  const kind = error ? "fixed_script_error" : "fixed_script_success";
  return {
    id: c.id,
    endpoint: "fixed-script",
    description: c.description,
    expect: c.expect,
    kind: kind,
    pass: expectMatches(c.expect, kind),
    status: 0,
    durationMs: Date.now() - started,
    networkError: error || undefined
  };
}

// ── Run a single case ──────────────────────────────────────────────────────

async function runCase(c, token) {
  const url  = NR_URL + "/flowpilot/" + c.endpoint;
  const body = {
    prompt:  c.prompt,
    stream:  false,
    history: []
  };
  if (["generate", "build", "document", "modify"].indexOf(c.endpoint) !== -1) {
    body.strategy = "classic";
    body.entry = c.endpoint;
  }
  if (c.request && typeof c.request === "object") {
    Object.assign(body, c.request);
  }
  if (Array.isArray(c.omitFields)) {
    c.omitFields.forEach(function (field) { delete body[field]; });
  }
  if (c.context) body.context = c.context;

  const start = Date.now();
  let status = 0, respBody = null, kind, networkError;

  try {
    const res = await post(url, body, token);
    status   = res.status;
    respBody = res.body;
    kind     = classify(c.endpoint, status, respBody);
  } catch (err) {
    kind         = "network_error";
    networkError = err.message;
  }

  const durationMs = Date.now() - start;
  const pass = (c.expect === null || c.expect === undefined) ? null : expectMatches(c.expect, kind);

  // Compact result — attach raw body only on non-success to keep results file small
  const result = {
    id:          c.id,
    endpoint:    c.endpoint,
    description: c.description,
    expect:      c.expect !== undefined ? c.expect : null,
    kind:        kind,
    pass:        pass,
    status:      status,
    durationMs:  durationMs
  };

  if (networkError)                         result.networkError  = networkError;
  if (respBody && respBody.explanation)     result.explanation   = respBody.explanation;
  if (respBody && respBody.skippedNote)     result.skippedNote   = respBody.skippedNote;
  if (respBody && Array.isArray(respBody.flow)) result.nodeCount = respBody.flow.length;
  if (kind !== "success")                   result.raw           = respBody;

  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("══ FlowPilot W1 Corpus Runner ══════════════════════════");
  console.log("NR_URL  :", NR_URL);
  console.log("Cases   :", cases.length);
  console.log("Delay   :", DELAY_MS + "ms between requests");
  console.log("");

  let token;
  try {
    token = await getToken();
    console.log("Auth    : OK\n");
  } catch (err) {
    console.error("Auth FAILED:", err.message);
    process.exit(1);
  }

  const results = [];
  const counts  = {};

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const label = "[" + (i + 1) + "/" + cases.length + "] " + c.id;
    process.stdout.write(label.padEnd(40) + " ... ");

    const result = c.fixedScript ? runFixedScriptCase(c) : await runCase(c, token);
    results.push(result);
    counts[result.kind] = (counts[result.kind] || 0) + 1;

    let marker = result.kind;
    if (result.pass === false) marker += " (UNEXPECTED, expected=" + result.expect + ")";
    console.log(marker + "  " + result.durationMs + "ms");

    if (i < cases.length - 1) await sleep(DELAY_MS);
  }

  // ── Summary ──

  const unexpected = results.filter(function (r) { return r.pass === false; });

  console.log("\n── Result counts ────────────────────────────────────────");
  const kindKeys = Object.keys(counts).sort();
  kindKeys.forEach(function (k) {
    console.log("  " + k.padEnd(20) + counts[k]);
  });
  console.log("  " + "total".padEnd(20) + results.length);

  if (unexpected.length) {
    console.log("\n── Unexpected results (" + unexpected.length + ") ──────────────────────────");
    unexpected.forEach(function (r) {
      console.log("  " + r.id + ":  expected=" + r.expect + "  got=" + r.kind);
    });
  } else {
    console.log("\nAll cases with an 'expect' value matched.");
  }

  // ── Write results JSON ──

  const summary = {
    timestamp:  new Date().toISOString(),
    nrUrl:      NR_URL,
    total:      results.length,
    byKind:     counts,
    unexpected: unexpected.length,
    results:    results
  };

  const ts      = Date.now();
  const outFile = path.join(OUTPUT_DIR, "results-" + ts + ".json");
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log("\nResults → " + outFile);
}

main().catch(function (err) {
  console.error("\nFatal:", err.message);
  process.exit(1);
});
