"use strict";

const assert = require("assert");
const { isProviderShapedResponse } = require("../lib/provider-shape-check");

// Table-driven per the security-hardening ticket's own acceptance spec
// (Part B, acceptance bullet): metadata-style JSON, an HTML error page, a
// bare 200 with an unrelated body, a valid OpenAI /v1/models list, and a
// valid chat completion — only the last two should pass.
const openaiCases = [
  {
    name: "metadata-style JSON (e.g. a cloud metadata endpoint)",
    raw: { instance: { id: "i-0123456789abcdef0", region: "us-east-1" } },
    expectPass: false
  },
  {
    name: "HTML error page parsed as a string, not JSON — represented here as an object that merely looks nothing like a provider",
    raw: { status: "error", html: "<html><body>404 Not Found</body></html>" },
    expectPass: false
  },
  {
    name: "bare 200 with an unrelated body (an internal service's own health-check shape)",
    raw: { ok: true, service: "internal-admin" },
    expectPass: false
  },
  {
    name: "valid OpenAI /v1/models list",
    raw: { object: "list", data: [{ id: "gpt-4o", object: "model" }, { id: "gpt-4o-mini", object: "model" }] },
    expectPass: true
  },
  {
    name: "valid OpenAI-compatible chat completion",
    raw: { id: "chatcmpl-1", choices: [{ index: 0, message: { role: "assistant", content: "Hello!" } }] },
    expectPass: true
  }
];

openaiCases.forEach(function (testCase) {
  const result = isProviderShapedResponse("openai-compatible", testCase.raw);
  assert.strictEqual(result, testCase.expectPass, "openai-compatible: " + testCase.name);
});

// Anthropic uses a different chat shape (content[] instead of
// choices[].message) — same pass/fail table, adapted.
const anthropicCases = [
  { name: "metadata-style JSON", raw: { instance: { id: "i-0123456789abcdef0" } }, expectPass: false },
  { name: "bare 200 unrelated body", raw: { ok: true }, expectPass: false },
  {
    name: "valid Anthropic message",
    raw: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "Hello!" }] },
    expectPass: true
  },
  {
    name: "valid OpenAI-style /v1/models list (accepted regardless of provider type)",
    raw: { object: "list", data: [{ id: "claude-sonnet-5" }] },
    expectPass: true
  }
];

anthropicCases.forEach(function (testCase) {
  const result = isProviderShapedResponse("anthropic", testCase.raw);
  assert.strictEqual(result, testCase.expectPass, "anthropic: " + testCase.name);
});

// Edge cases: null/undefined/non-object raw responses must never pass.
[null, undefined, "a string", 42, []].forEach(function (raw) {
  assert.strictEqual(isProviderShapedResponse("openai-compatible", raw), false, "non-object raw: " + JSON.stringify(raw));
});

console.log("provider-shape-check tests passed (" + (openaiCases.length + anthropicCases.length + 5) + " cases)");
