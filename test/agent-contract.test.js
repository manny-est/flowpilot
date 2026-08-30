"use strict";

const assert = require("assert");
const { enforceAgentContract } = require("../lib/agent-contract");

// Table-driven per Gate 2's close-out spec: populated envelope stripped
// and logged; explanation-only envelope untouched; classic strategy
// untouched; tool-call turns untouched. Each case captures console.warn
// output rather than asserting on side effects alone, so the logged
// counts/fields are verified too, not just the returned object.
const cases = [
  {
    name: "populated agent-strategy envelope: mutation fields stripped and logged",
    result: {
      explanation: "Added a debug node.",
      changes: [{ id: "n1", set: { name: "x" } }],
      newNodes: [{ id: "n2", type: "debug" }],
      newWires: [],
      removeNodes: ["n3"],
      newGroups: [{ id: "g1" }]
    },
    execution: { strategy: "agent", entry: "modify", conversationId: "conv-1" },
    hasToolCalls: false,
    expectStripped: ["changes", "newNodes", "newWires", "removeNodes", "newGroups"],
    expectWarn: true
  },
  {
    name: "explanation-only agent-strategy envelope: untouched, no warning",
    result: { explanation: "Here is what I found." },
    execution: { strategy: "agent", entry: "modify", conversationId: "conv-2" },
    hasToolCalls: false,
    expectStripped: [],
    expectWarn: false
  },
  {
    name: "classic strategy with mutation fields: untouched even though fields are present",
    result: {
      explanation: "Added a debug node.",
      changes: [{ id: "n1", set: { name: "x" } }],
      newNodes: [{ id: "n2", type: "debug" }]
    },
    execution: { strategy: "classic", entry: "modify", conversationId: "conv-3" },
    hasToolCalls: false,
    expectStripped: [],
    expectWarn: false
  },
  {
    name: "agent-strategy turn that made tool calls: untouched even though fields are present",
    result: {
      explanation: "Added a debug node via tool.",
      changes: [{ id: "n1", set: { name: "x" } }]
    },
    execution: { strategy: "agent", entry: "modify", conversationId: "conv-4" },
    hasToolCalls: true,
    expectStripped: [],
    expectWarn: false
  }
];

cases.forEach(function (testCase) {
  const originalWarn = console.warn;
  const warnCalls = [];
  console.warn = function () { warnCalls.push(Array.prototype.slice.call(arguments)); };

  let result;
  try {
    const inputSnapshotKeys = Object.keys(testCase.result);
    result = enforceAgentContract(testCase.result, testCase.execution, testCase.hasToolCalls);

    if (testCase.expectStripped.length) {
      testCase.expectStripped.forEach(function (field) {
        assert.ok(!Object.prototype.hasOwnProperty.call(result, field), testCase.name + ": " + field + " should be stripped");
      });
      assert.deepStrictEqual(result.strippedFields, testCase.expectStripped, testCase.name + ": strippedFields");
    } else {
      inputSnapshotKeys.forEach(function (field) {
        assert.ok(Object.prototype.hasOwnProperty.call(result, field), testCase.name + ": " + field + " should be untouched");
      });
      assert.ok(!("strippedFields" in result), testCase.name + ": strippedFields should not be added");
    }

    if (testCase.expectWarn) {
      assert.strictEqual(warnCalls.length, 1, testCase.name + ": expected exactly one console.warn");
    } else {
      assert.strictEqual(warnCalls.length, 0, testCase.name + ": expected no console.warn");
    }
  } finally {
    console.warn = originalWarn;
  }
});

console.log("agent-contract tests passed (" + cases.length + " cases)");
