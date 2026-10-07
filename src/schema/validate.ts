import { SnapshotSchema, type NormalizedSnapshot } from './normalized.js';

/** Structural validation plus graph/evidence integrity. Does not prove claims or sanitization. */
export function validateSnapshot(value: unknown): { success: true; snapshot: NormalizedSnapshot } | { success: false; errors: string[] } {
  const parsed = SnapshotSchema.safeParse(value);
  if (!parsed.success) return { success: false, errors: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
  const s = parsed.data, errors: string[] = [];
  const unique = <T extends { id: string }>(values: T[], label: string) => {
    const map = new Map<string, T>();
    for (const value of values) { if (map.has(value.id)) errors.push(`Duplicate ${label} ID: ${value.id}`); map.set(value.id, value); }
    return map;
  };
  const sources = unique(s.sources, 'source'), records = unique(s.records, 'record'), events = unique(s.events, 'event');
  const branches = unique(s.branches, 'branch'), spans = unique(s.spans, 'span'), issues = unique(s.issues, 'issue');
  const ref = (id: string | null, map: Map<string, unknown>, kind: string) => { if (id !== null && !map.has(id)) errors.push(`Missing ${kind}: ${id}`); };
  const eventRef = (id: string, kind?: string) => {
    ref(id, events, 'event');
    if (kind && events.has(id) && events.get(id)!.kind !== kind) errors.push(`Event ${id} must be ${kind}`);
  };
  const pointer = (value: unknown, path: string): { found: boolean; value?: unknown } => {
    let current = value;
    if (path === '') return { found: true, value: current };
    for (const key of path.slice(1).split('/').map(v => v.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return { found: false };
      current = (current as Record<string, unknown>)[key];
    }
    return { found: true, value: current };
  };
  const evidence = (refs: NormalizedSnapshot['session']['title']['evidence']) => {
    for (const e of refs) {
      const record = records.get(e.recordId);
      if (!record) { errors.push(`Missing evidence record: ${e.recordId}`); continue; }
      if (record.body.state === 'unavailable') {
        if (e.pointer || e.textRange) errors.push(`Unavailable record cannot support content evidence: ${e.recordId}`);
        continue;
      }
      const target = pointer(record.body.value, e.pointer);
      if (!target.found) errors.push(`Unresolved evidence pointer: ${e.recordId}${e.pointer}`);
      if (e.textRange && (typeof target.value !== 'string' || e.textRange.start > e.textRange.end || e.textRange.end > Array.from(target.value).length)) errors.push(`Invalid evidence range: ${e.recordId}`);
    }
  };
  for (const record of s.records) {
    ref(record.sourceId, sources, 'source');
    const l = record.location;
    if (l.kind === 'jsonl' && l.byteStart !== null && l.byteEnd !== null && l.byteEnd < l.byteStart) errors.push(`Reversed byte range: ${record.id}`);
    if (l.kind === 'text' && l.lineEnd < l.lineStart) errors.push(`Reversed line range: ${record.id}`);
  }
  let sequence = -1;
  for (const e of s.events) {
    if (e.sequence <= sequence) errors.push(`Non-increasing event sequence: ${e.id}`);
    sequence = e.sequence;
    evidence(e.evidence); ref(e.branchId, branches, 'branch'); e.issueIds.forEach(id => ref(id, issues, 'issue'));
    for (const link of e.links) {
      eventRef(link.targetEventId);
      if (link.targetEventId === e.id) errors.push(`Self-linked event: ${e.id}`);
      if (link.basis === 'adapter-rule' && !link.rule) errors.push(`Missing event linking rule: ${e.id}`);
    }
    if (e.kind === 'tool-result') {
      if (e.call.status === 'matched') {
        eventRef(e.call.eventId, 'tool-call');
        const call = events.get(e.call.eventId);
        if (e.call.basis === 'native-id' && (call?.kind !== 'tool-call' || !e.call.nativeCallId || call.nativeCallId !== e.call.nativeCallId)) errors.push(`Mismatched native call ID: ${e.id}`);
        if (call && call.branchId !== e.branchId) errors.push(`Cross-branch tool match: ${e.id}`);
        if (e.call.basis === 'adapter-rule' && !e.call.rule) errors.push(`Missing tool linking rule: ${e.id}`);
      } else e.call.candidateEventIds.forEach(id => eventRef(id, 'tool-call'));
    }
    const blocks = e.kind === 'message' ? e.content : e.kind === 'tool-result' ? e.output : [];
    unique(blocks, `content block in ${e.id}`);
    for (const block of blocks) {
      if (block.kind === 'tool-call-ref') eventRef(block.eventId, 'tool-call');
      if (block.kind === 'tool-result-ref') eventRef(block.eventId, 'tool-result');
    }
    if (e.kind === 'context') e.appliesToSpanIds.forEach(id => ref(id, spans, 'span'));
    if (e.kind === 'compaction') e.replacesEventIds.forEach(id => eventRef(id));
    if (e.kind === 'usage') ref(e.spanId, spans, 'span');
  }
  const acyclic = (parents: Map<string, string | null>, label: string) => {
    const done = new Set<string>();
    for (const id of parents.keys()) {
      let at: string | null = id;
      const path = new Set<string>();
      while (at !== null && parents.has(at) && !done.has(at)) {
        if (path.has(at)) { errors.push(`Cyclic ${label}: ${at}`); break; }
        path.add(at); at = parents.get(at)!;
      }
      path.forEach(v => done.add(v));
    }
  };
  for (const branch of s.branches) { evidence(branch.evidence); ref(branch.parentBranchId, branches, 'branch'); if (branch.forkEventId) eventRef(branch.forkEventId); }
  for (const span of s.spans) {
    evidence(span.evidence); ref(span.parentSpanId, spans, 'span'); ref(span.branchId, branches, 'branch');
    span.issueIds.forEach(id => ref(id, issues, 'issue'));
    span.eventIds.forEach(id => eventRef(id));
    [...span.inputMessageIds, ...span.outputMessageIds].forEach(id => eventRef(id, 'message'));
    span.contextEventIds.forEach(id => eventRef(id, 'context'));
    if (span.start && span.end && span.start.clockId && span.start.clockId === span.end.clockId && BigInt(span.end.unixNs) < BigInt(span.start.unixNs)) errors.push(`Reversed span time: ${span.id}`);
  }
  acyclic(new Map(s.branches.map(b => [b.id, b.parentBranchId])), 'branch');
  acyclic(new Map(s.spans.map(p => [p.id, p.parentSpanId])), 'span');
  ref(s.session.selectedBranchId, branches, 'branch'); evidence(s.session.title.evidence);
  s.session.relations.forEach(r => evidence(r.evidence));
  s.capture.coverage.forEach(c => { evidence(c.evidence); if (c.scope.kind === 'events') c.scope.eventIds.forEach(id => eventRef(id)); });
  for (const issue of s.issues) { evidence(issue.evidence); for (const p of issue.affected) if (!pointer(s, p).found) errors.push(`Unresolved issue path: ${p}`); }
  for (const transform of s.redaction.transforms) for (const p of transform.affected) if (!pointer(s, p).found) errors.push(`Unresolved transformation path: ${p}`);
  return errors.length ? { success: false, errors } : { success: true, snapshot: s };
}
