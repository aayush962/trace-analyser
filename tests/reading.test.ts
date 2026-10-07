import assert from 'node:assert/strict';
import test from 'node:test';
import { demoTraces } from '../src/demo.js';
import { normalizeTranscript } from '../src/core/normalize.js';
import { readSnapshot } from '../src/core/reading.js';
import { validateSnapshot } from '../src/schema/validate.js';
import { importFile } from '../src/core/discovery.js';
import { fileURLToPath } from 'node:url';

test('native Claude fixture passes from file adapter to validated reading without a model', async () => {
  const trace = await importFile(fileURLToPath(new URL('../docs/examples/checkout-retry.claude.jsonl', import.meta.url)));
  const snapshot = normalizeTranscript(trace);
  assert.equal(validateSnapshot(snapshot).success, true);
  const reading = readSnapshot(snapshot);
  assert.equal(reading.errors, 2);
  assert.equal(reading.tools, 5);
  assert.equal(reading.messages, 5);
  assert.equal(snapshot.events.filter(e => e.kind === 'message' && e.role === 'tool').length, 0);
  assert.ok(snapshot.events.filter(e => e.kind === 'tool-result').every(e => e.kind === 'tool-result' && e.call.status === 'matched'));
});

test('synthetic reading maps errors and repeated calls to resolvable evidence', () => {
  const trace = demoTraces()[0], snapshot = normalizeTranscript(trace);
  const result = validateSnapshot(snapshot);
  assert.equal(result.success, true, JSON.stringify(result));
  const reading = readSnapshot(snapshot);
  assert.equal(reading.errors, 2);
  assert.equal(reading.unresolved, 0);
  assert.ok(reading.observations.some(o => o.title.includes('3 times')));
  for (const finding of reading.observations) for (const id of finding.eventIds) assert.ok(snapshot.events.some(e => e.id === id));
  assert.equal(snapshot.records.find(r => r.captureKind === 'extracted-fragment')?.location.kind, 'jsonl');
});

test('Codex native calls match their result and preserve unknown status', () => {
  const trace = demoTraces()[1];
  trace.events = [
    { id: 'a', kind: 'tool-call', text: 'exec_command', timestamp: null, source: { line: 1 }, raw: { type: 'response_item', payload: { type: 'function_call', call_id: 'call-a', name: 'exec_command', arguments: '{"cmd":"echo error"}' } } },
    { id: 'b', kind: 'tool-result', text: 'This is the word error, not a status', timestamp: null, source: { line: 2 }, raw: { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-a', output: 'This is the word error, not a status' } } },
  ];
  const snapshot = normalizeTranscript(trace), reading = readSnapshot(snapshot);
  assert.equal(validateSnapshot(snapshot).success, true);
  assert.equal(reading.errors, 0);
  assert.equal(reading.unresolved, 0);
  assert.equal(snapshot.events[1].kind === 'tool-result' && snapshot.events[1].outcome, 'unknown');
});

test('ambiguous and absent call IDs never silently choose a call', () => {
  const trace = demoTraces()[0];
  const call = trace.events.find(e => e.kind === 'tool-call')!;
  const result = trace.events.find(e => e.kind === 'tool-result')!;
  trace.events = [call, { ...call, id: 'duplicate' }, result];
  trace.truncated = true;
  const snapshot = normalizeTranscript(trace);
  assert.equal(validateSnapshot(snapshot).success, true);
  assert.equal(snapshot.events[2].kind === 'tool-result' && snapshot.events[2].call.status, 'ambiguous');
  assert.equal(snapshot.capture.readState, 'partial');
  assert.equal(readSnapshot(snapshot).unresolved, 2);
});

test('semantic validator rejects dangling evidence, bad tool targets and duplicate sequences', () => {
  const snapshot = normalizeTranscript(demoTraces()[0]);
  snapshot.events[0].evidence[0].recordId = 'missing';
  snapshot.events[1].sequence = 0;
  const result = snapshot.events.find(e => e.kind === 'tool-result')!;
  if (result.kind === 'tool-result' && result.call.status === 'matched') result.call.eventId = snapshot.events[0].id;
  const validation = validateSnapshot(snapshot);
  assert.equal(validation.success, false);
  if (!validation.success) {
    assert.ok(validation.errors.some(e => e.includes('Missing evidence')));
    assert.ok(validation.errors.some(e => e.includes('must be tool-call')));
    assert.ok(validation.errors.some(e => e.includes('Non-increasing')));
  }
});

test('semantic validator resolves escaped pointers and Unicode ranges without prototype lookup', () => {
  const snapshot = normalizeTranscript(demoTraces()[0]);
  snapshot.records[0].body = { state: 'present', value: { 'a/b': '💫x' } };
  snapshot.events[0].evidence[0] = { recordId: snapshot.records[0].id, pointer: '/a~1b', textRange: { start: 0, end: 2 } };
  assert.equal(validateSnapshot(snapshot).success, true);
  snapshot.events[0].evidence[0].textRange!.end = 3;
  assert.equal(validateSnapshot(snapshot).success, false);
  snapshot.events[0].evidence[0] = { recordId: snapshot.records[0].id, pointer: '/toString', textRange: null };
  assert.equal(validateSnapshot(snapshot).success, false);
});
