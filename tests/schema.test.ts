import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventSchema, PayloadSchema, TimeSchema, normalizedJsonSchema } from '../src/schema/normalized.js';

const base = {
  id: 'event-1', nativeId: null, sequence: 0, branchId: null, time: null,
  evidence: [{ recordId: 'record-1', pointer: '/content/0', textRange: null }],
  issueIds: [], links: [],
};

test('draft preserves unavailable versus empty captured values', () => {
  assert.equal(PayloadSchema.safeParse({ state: 'present', value: '' }).success, true);
  assert.equal(PayloadSchema.safeParse({ state: 'unavailable', reason: 'redacted', detail: 'secret' }).success, true);
  assert.equal(PayloadSchema.safeParse({ state: 'unavailable', value: '' }).success, false);
});

test('native user role does not require human authorship', () => {
  const result = EventSchema.parse({ ...base, kind: 'message', role: 'user', author: 'tool',
    visibility: 'unknown', channel: 'unknown', nativeRole: 'user', nativeChannel: null,
    messageState: 'complete', content: [{ id: 'block-1', kind: 'tool-result-ref', eventId: 'result-1' }],
  });
  assert.equal(result.kind, 'message');
});

test('unmatched results and partial output remain valid observations', () => {
  const result = EventSchema.safeParse({ ...base, kind: 'tool-result',
    call: { status: 'unmatched', nativeCallId: 'call-1', candidateEventIds: [] },
    outcome: 'unknown', nativeStatus: null,
    output: [{ id: 'block-1', kind: 'text', text: { state: 'partial', value: 'first line', reason: 'byte limit' } }],
  });
  assert.equal(result.success, true);
});

test('nanosecond times retain exact precision and require provenance', () => {
  const time = { unixNs: '1791331200123456789', precision: 'ns', basis: 'recorded-event', clockId: null };
  assert.equal(TimeSchema.parse(time).unixNs, time.unixNs);
  assert.equal(TimeSchema.safeParse({ ...time, unixNs: Number(time.unixNs) }).success, false);
  assert.equal(TimeSchema.safeParse({ unixNs: time.unixNs }).success, false);
});

test('generated JSON Schema agrees with the TypeScript structural source', () => {
  const generated = JSON.parse(readFileSync(new URL('../schemas/trace-reader-2-draft.1.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(generated, normalizedJsonSchema());
  assert.equal(generated.$schema, 'https://json-schema.org/draft/2020-12/schema');
});
