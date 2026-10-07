import { z } from 'zod';

/** Draft contract only. Existing CLI exports remain trace-reader/1. */
export const SCHEMA_VERSION = 'trace-reader/2-draft.1' as const;
const Id = z.string().min(1).max(240);
const Short = z.string().max(2048);
const UInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const Ns = z.string().regex(/^-?(0|[1-9]\d*)$/);
const Pointer = z.string().regex(/^(?:\/(?:[^~]|~[01])*)*$/).max(4096);
const Json = z.json();
const ids = () => z.array(Id).max(100_000);

/** Null means unknown/not supplied; missing data gets a reason, never an empty stand-in. */
function captured<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('present'), value }),
    z.strictObject({ state: z.literal('partial'), value, reason: Short }),
    z.strictObject({ state: z.literal('unavailable'), reason: z.enum(['not-recorded', 'not-read', 'redacted', 'omitted', 'unsupported', 'missing-source']), detail: Short }),
  ]);
}
export const PayloadSchema = captured(Json);
const TextValue = captured(z.string().max(4 * 1024 * 1024));
export const EvidenceRefSchema = z.strictObject({
  recordId: Id, pointer: Pointer,
  // Ranges address Unicode code points in the SANITIZED string, [start, end).
  textRange: z.strictObject({ start: UInt, end: UInt }).nullable(),
});
const Evidence = z.array(EvidenceRefSchema).min(1).max(10_000);
export const TimeSchema = z.strictObject({
  unixNs: Ns, precision: z.enum(['s', 'ms', 'us', 'ns']),
  basis: z.enum(['recorded-event', 'recorded-persistence', 'filesystem', 'inferred']),
  clockId: Id.nullable(),
});
const Entity = {
  id: Id, evidence: Evidence, issueIds: ids(),
};
const Location = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('jsonl'), line: UInt.min(1), byteStart: UInt.nullable(), byteEnd: UInt.nullable() }),
  z.strictObject({ kind: z.literal('sqlite'), table: Short, rowKey: Short }),
  z.strictObject({ kind: z.literal('json'), pointer: Pointer }),
  z.strictObject({ kind: z.literal('text'), lineStart: UInt.min(1), lineEnd: UInt.min(1) }),
]);
export const SourceRecordSchema = z.strictObject({
  id: Id, sourceId: Id, ordinal: UInt, nativeId: Short.nullable(),
  // Existing adapters may retain one content block rather than a complete record.
  captureKind: z.enum(['native-record', 'extracted-fragment', 'display-fallback']),
  location: Location, body: PayloadSchema,
});
export const SourceSchema = z.strictObject({
  id: Id, format: Short, formatVersion: Short.nullable(),
  adapter: z.strictObject({ id: Id, version: Short }),
  // A logical display label, never a host locator or instruction to fetch anything.
  label: Short, readState: z.enum(['complete', 'partial', 'unknown']),
  consistency: z.enum(['closed-file', 'read-transaction', 'bounded-live-read', 'unknown']),
  bytesRead: UInt, sourceBytes: UInt.nullable(),
});
export const ContentBlockSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: Id, kind: z.literal('text'), text: TextValue }),
  z.strictObject({ id: Id, kind: z.literal('json'), data: PayloadSchema }),
  z.strictObject({ id: Id, kind: z.literal('reasoning-summary'), text: TextValue }),
  z.strictObject({ id: Id, kind: z.literal('attachment'), mediaType: Short.nullable(), label: Short.nullable(), data: PayloadSchema }),
  z.strictObject({ id: Id, kind: z.literal('tool-call-ref'), eventId: Id }),
  z.strictObject({ id: Id, kind: z.literal('tool-result-ref'), eventId: Id }),
  z.strictObject({ id: Id, kind: z.literal('unknown'), nativeType: Short.nullable(), data: PayloadSchema }),
]);
const Content = z.array(ContentBlockSchema).max(100_000);
const EventBase = {
  ...Entity, nativeId: Short.nullable(), sequence: UInt,
  branchId: Id.nullable(), time: TimeSchema.nullable(),
  links: z.array(z.strictObject({
    targetEventId: Id, relation: z.enum(['reply-to', 'follows', 'supersedes', 'caused-by', 'branch-parent']),
    basis: z.enum(['native', 'adapter-rule']), rule: Short.nullable(),
  })).max(100_000),
};
export const EventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...EventBase, kind: z.literal('message'),
    role: z.enum(['user', 'assistant', 'system', 'developer', 'tool', 'unknown']),
    // Source role does not establish who authored the content or whether UI showed it.
    author: z.enum(['human', 'agent', 'runtime', 'tool', 'unknown']),
    visibility: z.enum(['user-facing', 'internal', 'unknown']),
    channel: z.enum(['final', 'commentary', 'analysis', 'unknown']),
    nativeRole: Short.nullable(), nativeChannel: Short.nullable(),
    messageState: z.enum(['complete', 'partial', 'unknown']),
    content: Content,
  }),
  z.strictObject({ ...EventBase, kind: z.literal('tool-call'),
    nativeCallId: Short.nullable(), name: Short, namespace: Short.nullable(),
    execution: z.enum(['client', 'server', 'unknown']), arguments: PayloadSchema,
  }),
  z.strictObject({ ...EventBase, kind: z.literal('tool-result'),
    // Unmatched/ambiguous results remain first-class evidence.
    call: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('matched'), eventId: Id, nativeCallId: Short.nullable(), basis: z.enum(['native-id', 'adapter-rule']), rule: Short.nullable() }),
      z.strictObject({ status: z.enum(['unmatched', 'ambiguous']), nativeCallId: Short.nullable(), candidateEventIds: ids() }),
    ]),
    outcome: z.enum(['reported-success', 'reported-error', 'cancelled', 'unknown']),
    nativeStatus: Short.nullable(), output: Content,
  }),
  z.strictObject({ ...EventBase, kind: z.literal('context'),
    category: z.enum(['system', 'developer', 'skill', 'memory', 'settings', 'unknown']),
    action: z.enum(['set', 'append', 'remove', 'unknown']), data: PayloadSchema,
    appliesToSpanIds: ids(),
  }),
  z.strictObject({ ...EventBase, kind: z.literal('compaction'),
    summary: TextValue, replacesEventIds: ids(),
    priorHistory: z.enum(['included', 'missing', 'unknown']), nativeReference: Short.nullable(),
  }),
  z.strictObject({ ...EventBase, kind: z.literal('usage'),
    scope: z.enum(['model-call', 'session', 'unknown']), spanId: Id.nullable(), nativeRequestId: Short.nullable(),
    accounting: z.enum(['delta', 'cumulative', 'total', 'unknown']),
    provider: Short.nullable(), model: Short.nullable(),
    tokens: z.strictObject({ input: UInt.nullable(), output: UInt.nullable(), cacheRead: UInt.nullable(), cacheWrite: UInt.nullable(), reasoning: UInt.nullable(),
      inputIncludesCache: z.enum(['yes', 'no', 'unknown']), outputIncludesReasoning: z.enum(['yes', 'no', 'unknown']) }),
    cost: z.strictObject({ amount: Decimal, currency: z.string().regex(/^[A-Z]{3}$/), basis: z.enum(['reported', 'estimated']), pricingVersion: Short.nullable() }).nullable(),
  }),
  z.strictObject({ ...EventBase, kind: z.literal('lifecycle'),
    scope: z.enum(['session', 'turn', 'operation']), state: z.enum(['started', 'completed', 'interrupted', 'cancelled', 'unknown']),
    nativeScopeId: Short.nullable(),
  }),
  z.strictObject({ ...EventBase, kind: z.literal('unknown'), nativeType: Short.nullable(), data: PayloadSchema }),
]);
export const SpanSchema = z.strictObject({
  ...Entity, kind: z.enum(['model', 'tool', 'agent', 'retrieval', 'memory', 'unknown']), name: Short,
  nativeId: Short.nullable(), branchId: Id.nullable(), parentSpanId: Id.nullable(),
  links: z.array(z.strictObject({ traceId: Short, spanId: Short, attributes: Json })).max(10_000),
  // instrumented = native span; correlated = a documented association, not observed runtime.
  basis: z.enum(['instrumented', 'correlated']),
  start: TimeSchema.nullable(), end: TimeSchema.nullable(),
  intervalMeaning: z.enum(['operation', 'call-result-envelope', 'unknown']),
  status: z.enum(['unset', 'ok', 'error', 'cancelled', 'unknown']),
  eventIds: ids(), inputMessageIds: ids(), outputMessageIds: ids(), contextEventIds: ids(),
  model: z.strictObject({ provider: Short.nullable(), requested: Short.nullable(), returned: Short.nullable() }).nullable(),
  telemetry: z.strictObject({ traceId: z.string().regex(/^[0-9a-f]{32}$/), spanId: z.string().regex(/^[0-9a-f]{16}$/),
    parentSpanId: z.string().regex(/^[0-9a-f]{16}$/).nullable(), schemaUrl: Short.nullable(),
    resource: Json, instrumentationScope: Json, attributes: Json }).nullable(),
});
export const SnapshotSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  normalization: z.strictObject({ version: Short, identityVersion: Short }),
  session: z.strictObject({
    id: Id, nativeId: Short.nullable(), harness: Short, harnessVersion: Short.nullable(),
    surface: Short.nullable(), profileLabel: Short.nullable(),
    title: z.strictObject({ text: Short, basis: z.enum(['native', 'first-user-message', 'fallback']), evidence: z.array(EvidenceRefSchema).max(100) }),
    projectLabel: Short.nullable(), startedAt: TimeSchema.nullable(), endedAt: TimeSchema.nullable(),
    selectedBranchId: Id.nullable(),
    relations: z.array(z.strictObject({ relation: z.enum(['subagent-of', 'fork-of', 'continues', 'unknown']),
      targetNativeSessionId: Short, targetHarness: Short, evidence: Evidence })).max(1000),
  }),
  capture: z.strictObject({
    capturedAt: z.iso.datetime(), readState: z.enum(['complete', 'partial', 'unknown']),
    // Array range is display/source order, never automatically a wall-clock interval.
    coverage: z.array(z.strictObject({ facet: z.enum(['messages', 'tool-calls', 'tool-results', 'timestamps', 'usage', 'context', 'lineage']),
      state: z.enum(['observed', 'partial', 'not-recorded', 'unknown']),
      scope: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('session') }), z.strictObject({ kind: z.literal('events'), eventIds: ids().min(1) })]),
      explanation: Short, evidence: z.array(EvidenceRefSchema).max(1000) })).max(100_000),
  }),
  sources: z.array(SourceSchema).min(1).max(10_000),
  records: z.array(SourceRecordSchema).max(100_000),
  branches: z.array(z.strictObject({ id: Id, nativeId: Short.nullable(), parentBranchId: Id.nullable(),
    forkEventId: Id.nullable(), evidence: Evidence })).max(10_000),
  events: z.array(EventSchema).max(100_000),
  spans: z.array(SpanSchema).max(100_000),
  issues: z.array(z.strictObject({ id: Id, code: Short,
    severity: z.enum(['info', 'warning', 'error']), detail: Short,
    // JSON pointers address this snapshot; source byte locations live on records.
    affected: z.array(Pointer).min(1).max(100_000), evidence: z.array(EvidenceRefSchema).max(1000),
  })).max(100_000),
  redaction: z.strictObject({ policyVersion: Short,
    transforms: z.array(z.strictObject({ kind: z.enum(['redaction', 'omission', 'pseudonymization', 'truncation']),
      rule: Short, affected: z.array(Pointer).min(1).max(100_000), count: UInt.min(1) })).max(100_000),
  }),
});

export type NormalizedSnapshot = z.infer<typeof SnapshotSchema>;
export type NormalizedEvent = z.infer<typeof EventSchema>;
export type ExecutionSpan = z.infer<typeof SpanSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** Structure only. Cross-reference/semantic validation remains a pre-adoption requirement. */
export function normalizedJsonSchema() {
  return z.toJSONSchema(SnapshotSchema, { target: 'draft-2020-12', reused: 'ref' });
}
