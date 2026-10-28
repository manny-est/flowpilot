"use strict";

const assert = require("assert");
const compat = require("../lib/param-compat");

const OPENAI_MAX = "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";
const OPENAI_TEMP = "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.";
const OPENAI_TOOLS = "Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
const OPENAI_NONE = "Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: ...";
const ANTHROPIC_TEMP = "`temperature` is deprecated for this model.";
const ANTHROPIC_BOTH = "`temperature` and `top_p` cannot both be specified for this model. Please use only one.";
const ANTHROPIC_EXTRA = "temperature: Extra inputs are not permitted";
const ANTHROPIC_TOOL = "tool_choice: type \"tool\" and \"any\" are not supported for this model.";

function testClassification() {
  assert.deepStrictEqual(compat.classify("openai", 400, {
    message: OPENAI_MAX, type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter"
  }), { kind: "translate", from: "max_tokens", to: "max_completion_tokens" });
  assert.deepStrictEqual(compat.classify("openai", 400, {
    message: OPENAI_TEMP, type: "invalid_request_error", param: "temperature", code: "unsupported_value"
  }), { kind: "drop", param: "temperature" });
  assert.deepStrictEqual(compat.classify("openai", 400, {
    message: OPENAI_TOOLS, type: "invalid_request_error", param: "reasoning_effort"
  }), { kind: "set", param: "reasoning_effort", value: "none", toolsOnly: true });
  assert.deepStrictEqual(compat.classify("openai", 400, {
    message: OPENAI_NONE, type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_value"
  }), { kind: "toolsUnsupported" });
  assert.deepStrictEqual(compat.classify("anthropic", 400, { type: "invalid_request_error", message: ANTHROPIC_TEMP }), { kind: "drop", param: "temperature" });
  assert.deepStrictEqual(compat.classify("anthropic", 400, { type: "invalid_request_error", message: ANTHROPIC_BOTH }), { kind: "drop", param: "top_p" });
  assert.deepStrictEqual(compat.classify("anthropic", 400, { type: "invalid_request_error", message: ANTHROPIC_EXTRA }), { kind: "drop", param: "temperature" });
  assert.deepStrictEqual(compat.classify("anthropic", 400, { type: "invalid_request_error", message: "top_p: Extra inputs are not permitted" }), { kind: "drop", param: "top_p" });
  assert.deepStrictEqual(compat.classify("anthropic", 400, { type: "invalid_request_error", message: "top_k: Extra inputs are not permitted" }), { kind: "drop", param: "top_k" });
  assert.deepStrictEqual(compat.classify("anthropic", 400, { type: "invalid_request_error", message: ANTHROPIC_TOOL }), { kind: "toolChoiceAuto" });

  assert.strictEqual(compat.classify("openai", 401, { message: OPENAI_TEMP, param: "temperature" }), null);
  assert.strictEqual(compat.classify("openai", 400, { message: "context", code: "context_length_exceeded" }), null);
  assert.strictEqual(compat.classify("openai", 400, { message: "Messages are invalid.", param: "messages", code: "invalid_value" }), null);
  assert.strictEqual(compat.classify("anthropic", 529, { type: "overloaded_error", message: "busy" }), null);
}

function testApplicationAndDescriptions() {
  const openaiEntry = {
    omit: ["temperature"],
    maxTokensParam: "max_completion_tokens",
    toolsReasoningNone: true,
    toolsUnsupported: false,
    toolChoiceAuto: false
  };
  const body = { temperature: 0.2, max_tokens: 100, tools: [{}] };
  assert.strictEqual(compat.applyCompat("openai", body, openaiEntry, { hasTools: true }), body);
  assert.strictEqual(body.temperature, undefined);
  assert.strictEqual(body.max_tokens, undefined);
  assert.strictEqual(body.max_completion_tokens, 100);
  assert.strictEqual(body.reasoning_effort, "none");
  assert.deepStrictEqual(compat.describe(openaiEntry), [
    "temperature omitted (model only accepts its default)",
    "max_tokens sent as max_completion_tokens",
    "reasoning_effort: none for tool calls"
  ]);

  const anthropicEntry = { omit: [], toolChoiceAuto: true };
  const anthropicBody = { temperature: 0.2, top_p: 0.5, tool_choice: { type: "any" } };
  compat.applyCompat("anthropic", anthropicBody, anthropicEntry, { hasTools: true });
  assert.deepStrictEqual(anthropicBody.tool_choice, { type: "auto" });
}

function testPureHelpers() {
  assert.strictEqual(compat.isOfficialOpenAI("https://api.openai.com/v1"), true);
  assert.strictEqual(compat.isOfficialOpenAI("https://api.openai.com.evil.example/v1"), false);
  assert.strictEqual(compat.isOfficialOpenAI("http://localhost:8080/v1"), false);
  assert.strictEqual(compat.raisedLimit(0), 16384);
  assert.strictEqual(compat.raisedLimit(4096), 16384);
  assert.strictEqual(compat.raisedLimit(10000), 32768);
  assert.strictEqual(compat.raisedLimit(100000), 32768);
}

testClassification();
testApplicationAndDescriptions();
testPureHelpers();
console.log("param-compat tests passed");
