"use strict";

const assert = require("assert");
const {
  createChatDataStreamSplitter,
  splitChatDataBlock
} = require("../lib/chat-data");

function testSplit(name, content, expectedMessage, expectedData) {
  const result = splitChatDataBlock(content);
  assert.strictEqual(result.message, expectedMessage, name + ": message");
  assert.deepStrictEqual(result.data, expectedData, name + ": data");
}

function testStream(name, chunks, expectedVisible, expectedData) {
  const splitter = createChatDataStreamSplitter();
  let visible = "";
  chunks.forEach(function (chunk) {
    visible += splitter.push(chunk);
  });
  const finished = splitter.finish();
  visible += finished.tail;
  assert.strictEqual(visible, expectedVisible, name + ": visible");
  assert.deepStrictEqual(finished.data, expectedData, name + ": data");
}

testSplit(
  "exact marker",
  "Answer first.\n<<<FLOWPILOT_DATA>>>\n{\"questionOptions\":[\"Yes\",\"No\"]}",
  "Answer first.",
  { questionOptions: ["Yes", "No"] }
);

testSplit(
  "marker with spaces and fenced json",
  "Answer first.\n```json\n<<< FLOWPILOT_DATA >>>\n{\"suggestedAction\":{\"mode\":\"chat\",\"prompt\":\"Keep going\"}}\n```",
  "Answer first.",
  { suggestedAction: { mode: "chat", prompt: "Keep going" } }
);

testSplit(
  "malformed json still strips marker",
  "Answer first.\n<<<FLOWPILOT_DATA>>>\n{\"questionOptions\":[\"Yes\",]}",
  "Answer first.",
  null
);

testSplit(
  "no marker leaves content alone",
  "Just prose.",
  "Just prose.",
  null
);

testStream(
  "stream exact marker across chunks",
  ["Answer first.\n<<<FLOW", "PILOT_DATA>>>\n{\"questionOptions\":[\"Yes\",\"No\"]}"],
  "Answer first.",
  { questionOptions: ["Yes", "No"] }
);

testStream(
  "stream marker with spaces and fenced json",
  [
    "Answer first.\n```json\n<<< FLOW",
    "PILOT_DATA >>>\n{\"suggestedAction\":{\"mode\":\"chat\",\"prompt\":\"Keep going\"}}\n```"
  ],
  "Answer first.",
  { suggestedAction: { mode: "chat", prompt: "Keep going" } }
);

console.log("chat-data-block tests passed");
