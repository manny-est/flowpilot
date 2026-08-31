"use strict";

// ---------------------------------------------------------------------
// The provider-confirmation gate's own pass/fail criterion (ADR-007, the
// SSRF mitigation). Deliberately NOT "HTTP 200 with a JSON body" — an
// internal admin panel or a cloud metadata endpoint can trivially return
// that. Requires an actually provider-shaped response: a well-formed
// OpenAI-compatible chat-completion object (choices[].message) or Anthropic
// message (content[]), or a valid OpenAI-style /v1/models list (data[] of
// {id}). Anything else — including a bare 200, an HTML error page, or JSON
// that merely happens to parse but isn't shaped like either — fails the
// check, and the provider stays unconfirmed.
// ---------------------------------------------------------------------

function isChatShaped(providerType, raw) {
  if (providerType === "anthropic") {
    return Array.isArray(raw.content);
  }
  return Array.isArray(raw.choices) && raw.choices.length > 0 &&
    raw.choices[0] && typeof raw.choices[0] === "object" &&
    raw.choices[0].message && typeof raw.choices[0].message === "object";
}

function isModelsListShaped(raw) {
  return Array.isArray(raw.data) && raw.data.length > 0 &&
    raw.data.every(function (m) { return m && typeof m.id === "string" && m.id; });
}

function isProviderShapedResponse(providerType, raw) {
  if (!raw || typeof raw !== "object") { return false; }
  return isChatShaped(providerType, raw) || isModelsListShaped(raw);
}

module.exports = { isProviderShapedResponse };
