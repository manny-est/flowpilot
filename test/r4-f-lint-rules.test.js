"use strict";

// R4-F is deliberately a table test: every Node-RED-shaped lint rule has
// positive and negative fixtures, so a later fix cannot silently lose its
// regression case.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { LINT_RULES } = require("../lib/core/lint-rules");

const fixtureDir = path.join(__dirname, "fixtures", "lint");
const fixtures = fs.readdirSync(fixtureDir).filter(name => name.endsWith(".json")).sort()
  .map(name => Object.assign({ file: name }, JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8"))));

const byId = nodes => nodes.reduce((map, node) => {
  if (node && node.id) { map[node.id] = node; }
  return map;
}, {});

for (const fixture of fixtures) {
  test(`lint fixture ${fixture.file}`, () => {
    const rule = LINT_RULES.find(candidate => candidate.id === fixture.rule);
    assert.ok(rule, `fixture names an existing rule: ${fixture.rule}`);
    const nodes = Array.isArray(fixture.nodes) ? fixture.nodes : [fixture.nodes || fixture.node];
    const subject = fixture.nodeId
      ? nodes.find(node => node && node.id === fixture.nodeId)
      : nodes[0];
    assert.ok(subject, "fixture has a subject node");
    assert.equal(rule.appliesTo(subject), true, "fixture subject is covered by the rule");
    const actual = rule.check(subject, { nodes, byId: byId(nodes) }).map(result => result.status);
    assert.deepEqual(actual, fixture.expect, `statuses for ${fixture.file}`);
  });
}

const counts = {};
fixtures.forEach(fixture => {
  counts[fixture.rule] = counts[fixture.rule] || { good: 0, bad: 0 };
  if (fixture.expect.length) { counts[fixture.rule].bad++; }
  else { counts[fixture.rule].good++; }
});
for (const rule of LINT_RULES) {
  test(`lint rule ${rule.id} has a balanced fixture table`, () => {
    assert.ok(counts[rule.id] && counts[rule.id].good >= 2, `${rule.id} has at least two good fixtures`);
    assert.ok(counts[rule.id] && counts[rule.id].bad >= 2, `${rule.id} has at least two bad fixtures`);
  });
}
