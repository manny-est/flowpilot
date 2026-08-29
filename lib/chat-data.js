"use strict";

const { findMatchingBrace } = require("./envelope");

const CHAT_DATA_MARKER = "<<<FLOWPILOT_DATA>>>";
const CHAT_DATA_MARKER_RE = /<<<\s{0,8}FLOWPILOT_DATA\s{0,8}>>>/i;
const CHAT_DATA_MARKER_MAX_SCAN = 40;

function stripTrailingDataFence(text) {
  return String(text || "")
    .replace(/(?:\r?\n)?```(?:json)?[ \t]*(?:\r?\n)?$/i, "")
    .replace(/\s+$/, "");
}

function stripLeadingDataFence(text) {
  return String(text || "")
    .replace(/^\s*```(?:json)?[ \t]*\r?\n?/i, "")
    .replace(/\s*```[\s\r\n]*$/i, "")
    .trim();
}

function findChatDataMarker(text) {
  const source = String(text || "");
  const match = CHAT_DATA_MARKER_RE.exec(source);
  if (!match) { return null; }
  return {
    index: match.index,
    marker: match[0]
  };
}

function parseChatDataObject(text) {
  const source = stripLeadingDataFence(text);
  const firstBrace = source.indexOf("{");
  if (firstBrace === -1) { return null; }
  const end = findMatchingBrace(source, firstBrace);
  if (end === -1) { return null; }
  try {
    return JSON.parse(source.slice(firstBrace, end + 1));
  } catch (e) {
    return null;
  }
}

function stripChatDataFromVisibleText(content) {
  const text = String(content || "");
  const found = findChatDataMarker(text);
  if (!found) { return text; }
  return stripTrailingDataFence(text.slice(0, found.index));
}

function splitChatDataBlock(content) {
  const text = String(content || "");
  const found = findChatDataMarker(text);
  if (!found) { return { message: text, data: null }; }

  const message = stripTrailingDataFence(text.slice(0, found.index));
  const data = parseChatDataObject(text.slice(found.index + found.marker.length));
  return { message: message, data: data };
}

function createChatDataStreamSplitter() {
  let held = "";
  let inData = false;
  let dataBuf = "";

  function push(delta) {
    if (inData) { dataBuf += delta; return ""; }

    const combined = held + String(delta || "");
    const found = findChatDataMarker(combined);
    if (found) {
      inData = true;
      dataBuf = combined.slice(found.index + found.marker.length);
      held = "";
      return stripTrailingDataFence(combined.slice(0, found.index));
    }

    if (combined.length <= CHAT_DATA_MARKER_MAX_SCAN) {
      held = combined;
      return "";
    }
    held = combined.slice(-CHAT_DATA_MARKER_MAX_SCAN);
    return combined.slice(0, -CHAT_DATA_MARKER_MAX_SCAN);
  }

  function finish() {
    const tail = inData ? "" : held;
    held = "";
    const data = inData ? parseChatDataObject(dataBuf) : null;
    return {
      tail: inData ? "" : stripChatDataFromVisibleText(tail),
      data: data
    };
  }

  return { push: push, finish: finish };
}

module.exports = {
  CHAT_DATA_MARKER,
  createChatDataStreamSplitter,
  findChatDataMarker,
  splitChatDataBlock,
  stripChatDataFromVisibleText
};
