"use strict";

function parsedBody(body) {
  if (body && typeof body === "object") { return body; }
  if (typeof body !== "string" || !body.trim()) { return null; }
  try { return JSON.parse(body); } catch (err) { return null; }
}

function firstString(value) {
  if (typeof value === "string" && value.trim()) { return value.trim(); }
  if (!value || typeof value !== "object") { return ""; }
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const found = firstString(value[keys[i]]);
    if (found) { return found; }
  }
  return "";
}

function sentence(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) { return "Provider request failed."; }
  if (!/[.!?]$/.test(text)) { text += "."; }
  return text.slice(0, 500);
}

function providerMessage(body, status) {
  const parsed = parsedBody(body);
  const candidates = [
    parsed && parsed.error && typeof parsed.error === "object" ? parsed.error.message : null,
    parsed && parsed.message,
    parsed && parsed.detail,
    parsed && typeof parsed.error === "string" ? parsed.error : null,
    firstString(parsed)
  ];
  const message = candidates.find(function (value) { return typeof value === "string" && value.trim(); });
  return message ? sentence(message) : "Provider request failed" + (status ? " (status " + status + ")" : "") + ".";
}

function normalizeProviderError(body, status) {
  const parsed = parsedBody(body);
  return {
    message: providerMessage(parsed || body, status),
    raw: typeof body === "string" ? body : (parsed ? JSON.stringify(parsed) : "")
  };
}

function sanitizedProviderError(body) {
  const parsed = parsedBody(body);
  if (!parsed || typeof parsed !== "object") { return null; }
  const nested = parsed.error && typeof parsed.error === "object" ? parsed.error : parsed;
  return {
    type: typeof nested.type === "string" ? nested.type.slice(0, 300) : "",
    message: providerMessage(parsed, 0).slice(0, 300)
  };
}

module.exports = { normalizeProviderError, providerMessage, sanitizedProviderError };
