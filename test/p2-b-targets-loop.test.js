const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const intake = require('../lib/core/intake.js');
const corpus = require('./engine-corpus/runner.js');

test('P2-B named nodes join the current selection', () => {
  const target = intake.resolveIntakeTarget('Connect Process to Output', ['selected'], [
    { id: 'selected', name: 'Selected', type: 'function', inActiveTab: true },
    { id: 'n2', name: 'Process', type: 'function', inActiveTab: true },
    { id: 'n3', name: 'Output', type: 'debug', inActiveTab: true }
  ]);
  assert.deepEqual(target.ids, ['selected', 'n2', 'n3']);
});

test('P2-B duplicate names remain unresolved for the picker', () => {
  const target = intake.resolveIntakeTarget('Rename Shaper', [], [
    { id: 'n1', name: 'Shaper', type: 'function', inActiveTab: true },
    { id: 'n2', name: 'Shaper', type: 'function', inActiveTab: true }
  ]);
  assert.equal(target.kind, 'unresolved');
});

test('P2-B repeated writes report the exact no-op result', () => {
  const parts = { tab: { id: 'tab-1' }, nodes: [{ id: 'n1', name: 'A', type: 'function', value: 1, wires: [] }] };
  const call = { function: { name: 'apply_step', arguments: JSON.stringify({
    changes: [{ id: 'n1', set: { value: 1 } }]
  }) } };
  corpus.applyWriteToFixture(call, parts);
  const second = corpus.applyWriteToFixture(call, parts);
  assert.equal(second.noChange, true);
  assert.equal(second.error, 'No change: already applied');
});

test('P2-B remove_step accepts a selection in one call', () => {
  const source = fs.readFileSync(require.resolve('../flowpilot.js'), 'utf8');
  const main = fs.readFileSync(require.resolve('../lib/core/main.js'), 'utf8');
  const modes = fs.readFileSync(require.resolve('../lib/core/modes.js'), 'utf8');
  assert.match(source, /name: "remove_step"[\s\S]{0,900}nodeIds/);
  assert.match(source, /Delete a selection in one call/);
  assert.match(main, /Delete these " \+ removeIds\.length \+ " nodes\?/);
  assert.match(modes, /isCompletedPlanRestatement/);
});

test('P2-B includes additive build and document guard prompts', () => {
  const build = fs.readFileSync(require.resolve('../lib/build-agent-system-prompt.js'), 'utf8');
  const document = fs.readFileSync(require.resolve('../lib/document-system-prompt.js'), 'utf8');
  assert.match(build, /Create new nodes for this; don't modify existing nodes unless the user asked\./);
  assert.match(document, /never rename existing nodes/);
});

test('P2-B malformed final responses have a corrective turn', () => {
  const source = fs.readFileSync(require.resolve('../flowpilot.js'), 'utf8');
  assert.match(source, /your reply wasn't valid JSON; continue with apply_step, or reply with a short plain summary/i);
});

test('P2-B locks out-of-target writes with a create-new-node explanation', () => {
  const source = fs.readFileSync(require.resolve('../lib/core/modes.js'), 'utf8');
  assert.match(source, /outside the locked target/);
  assert.match(source, /Create a new node instead, unless the user explicitly asked/);
  assert.match(source, /stepPayload\.dispatched = true/);
});
