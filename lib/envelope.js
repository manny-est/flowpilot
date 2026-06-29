"use strict";

// Envelope parsing (Phase 9 refactor seam 2): pulls the model's JSON
// envelope out of a raw provider response. Shared by every mode
// (chat/generate/document/modify/build) via flowpilot.js - this was the
// source of two cross-mode bugs this project already hit (a brace
// embedded in prose like "{{payload}}" mistaken for the envelope's start,
// and a valid-but-unrelated JSON snippet in prose mistaken for the
// envelope itself), which is exactly the case for keeping this logic in
// ONE place instead of duplicated per mode.
//
// Pure functions, no dependency on anything else in this package -
// require()'d directly, no special build step needed (unlike the
// browser-side flowpilot-core.js split, this file already has a real
// module system).

// Given s[startIdx] === "{", scans forward with brace-depth counting that
// ignores braces inside string literals (so a value like "{{payload}}"
// can't be mistaken for structure) to find the index of the MATCHING
// closing "}". Returns -1 if the braces never balance before the string
// ends (truncated/malformed input).
function findMatchingBrace(s, startIdx) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch === "\\") { escaped = true; }
      else if (ch === "\"") { inString = false; }
      continue;
    }
    if (ch === "\"") { inString = true; }
    else if (ch === "{") { depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0) { return i; }
    }
  }
  return -1;
}

function extractJsonObject(text) {
  if (!text) { throw new Error("Empty response from provider."); }
  let s = String(text).trim();
  // Strip markdown code fences if the model wrapped the JSON.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const firstBrace = s.indexOf("{");
  const firstBracket = s.indexOf("[");

  // The model occasionally returns a bare top-level array (e.g.
  // `[ {...node...} ]`) instead of the {explanation, flow} envelope. If we
  // fell through to the {...} extraction below, indexOf("{")/lastIndexOf("}")
  // would grab just the first node object — which has no "flow" key and
  // fails validation. Detect this case up front and wrap it as a minimal
  // envelope instead.
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    const lastBracket = s.lastIndexOf("]");
    if (lastBracket !== -1 && lastBracket > firstBracket) {
      try {
        const arr = JSON.parse(s.slice(firstBracket, lastBracket + 1));
        if (Array.isArray(arr)) {
          return { explanation: "", flow: arr };
        }
      } catch (e) {
        // Not a parseable array — fall through to the {...} extraction.
      }
    }
  }

  const firstObjIdx = s.indexOf("{");
  if (firstObjIdx === -1) {
    // No JSON object found at all — flagged separately from a found-
    // but-unparseable ({...} present, JSON.parse failed) "garbled" error,
    // so callers can distinguish "model just answered in prose" (tolerate)
    // from "model's JSON envelope is broken" (still an error).
    const err = new Error("Provider did not return a JSON object.");
    err.noJsonFound = true;
    throw err;
  }

  // There may be more than one "{" before the real envelope — e.g. prose
  // explaining a fix that mentions inline code like "{{payload}}" before
  // the actual JSON (seen live: a review response started with "The
  // template node is using `{{payload}}` with...", and slicing from THAT
  // brace to the envelope's real closing "}" produced unparseable
  // garbage). Try each candidate "{" in order with string-aware brace
  // matching (findMatchingBrace, which ignores braces inside quoted
  // strings) rather than just slicing from the first "{" to the last
  // "}".
  //
  // A candidate must not just PARSE, it must also look like one of the
  // known envelope shapes (have at least one recognized top-level key) —
  // seen live: a pure-prose advice response that mentioned structured
  // logging included the illustrative example
  // `{"level":"info","event":"trivia_answer","user":"alex","correct":true}`,
  // which IS valid standalone JSON, so the old "first candidate that
  // parses wins" rule accepted it as "the envelope" and the caller threw
  // "no recognizable modify fields" — when the right answer was to treat
  // the whole reply as prose, since there was no real envelope at all.
  const ENVELOPE_KEYS = ["explanation", "flow", "question", "changes", "newNodes", "newWires", "removeNodes", "newGroups", "prose"];
  function looksLikeEnvelope(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) { return false; }
    return ENVELOPE_KEYS.some(function (k) { return k in obj; });
  }

  let lastError = null;
  let searchFrom = firstObjIdx;
  while (searchFrom !== -1 && searchFrom < s.length) {
    const end = findMatchingBrace(s, searchFrom);
    if (end !== -1) {
      try {
        const candidate = JSON.parse(s.slice(searchFrom, end + 1));
        if (looksLikeEnvelope(candidate)) { return candidate; }
        // Valid JSON, but not envelope-shaped (e.g. an illustrative
        // example embedded in prose) — keep searching rather than
        // accepting it.
      } catch (e) {
        lastError = e;
      }
    }
    searchFrom = s.indexOf("{", searchFrom + 1);
  }
  // No candidate both parsed AND looked like a real envelope — equivalent
  // to "the model just answered in prose," not "the envelope is broken."
  // Let callers fall back to rendering this as a normal message instead
  // of surfacing a parse error (same noJsonFound flag the "no { at all"
  // branch above uses).
  const err = lastError || new Error("Provider's JSON object could not be parsed.");
  err.noJsonFound = true;
  throw err;
}

module.exports = { extractJsonObject: extractJsonObject, findMatchingBrace: findMatchingBrace };
