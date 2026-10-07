import { SCHEMA_VERSION, type NormalizedEvent, type NormalizedSnapshot } from '../schema/normalized.js';
import { safeText, singleLine, stableId } from './safe.js';
import type { TraceEvent, Transcript } from './types.js';

type Obj = Record<string, any>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown): string | null => typeof v === 'string' && v.length ? v.slice(0, 2048) : null;
const present = (value: any) => ({ state: 'present' as const, value });
const absent = () => ({ state: 'unavailable' as const, reason: 'not-recorded' as const, detail: 'Not present in retained source data' });

function time(value: string | null): NormalizedEvent['time'] {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? { unixNs: String(BigInt(ms) * 1_000_000n), precision: 'ms', basis: 'recorded-event', clockId: null } : null;
}
function payload(e: TraceEvent) { const r = obj(e.raw); return obj(r.payload).type ? obj(r.payload) : r; }
function nativeCallId(e: TraceEvent) {
  const p = payload(e);
  return str(p.tool_use_id ?? p.call_id ?? p.tool_call_id ?? (e.kind === 'tool-call' ? p.id : null));
}
function textBlock(id: string, text: string) {
  // Imported display text is already bounded by the reader; preserve a reason if clipped again.
  const value = safeText(text).slice(0, 1_000_000);
  return { id: `${id}:text`, kind: 'text' as const, text: text.length > 1_000_000
    ? { state: 'partial' as const, value, reason: 'Local reading text limit' } : present(value) };
}
export function eventText(event: NormalizedEvent): string {
  const content = event.kind === 'message' ? event.content : event.kind === 'tool-result' ? event.output : [];
  if (content.length) return content.map(block => 'text' in block && block.text.state !== 'unavailable' ? block.text.value : '').filter(Boolean).join('\n');
  if (event.kind === 'tool-call') return event.arguments.state === 'unavailable' ? '(Arguments not recorded)' : typeof event.arguments.value === 'string' ? event.arguments.value : JSON.stringify(event.arguments.value, null, 2);
  return '';
}

/** On-demand local projection. Draft IDs are stable within the discovered source;
 * this is not yet the portable identity/export migration. No model is invoked. */
export function normalizeTranscript(trace: Transcript): NormalizedSnapshot {
  const s = trace.session;
  const sourceId = `src:${s.id}`;
  const records: NormalizedSnapshot['records'] = [];
  const events: NormalizedEvent[] = [];
  const calls = new Map<string, string[]>();
  const idFor = (e: TraceEvent, i: number) => `ev:${stableId(s.id, e.id, String(i))}`;
  trace.events.forEach((e, i) => {
    const native = nativeCallId(e);
    if (e.kind === 'tool-call' && native) {
      if (!calls.has(native)) calls.set(native, []);
      calls.get(native)!.push(idFor(e, i));
    }
  });
  trace.events.forEach((e, i) => {
    const id = idFor(e, i), recordId = `rec:${id.slice(3)}`, p = payload(e), r = obj(e.raw);
    const isFragment = /:(?:tool|result|block)-\d+$/.test(e.id) || ['tool_use', 'server_tool_use', 'tool_result', 'thinking', 'image'].includes(r.type);
    records.push({ id: recordId, sourceId, ordinal: i, nativeId: str(r.uuid ?? p.id),
      captureKind: e.raw === undefined ? 'display-fallback' : isFragment ? 'extracted-fragment' : 'native-record',
      location: e.source.line ? { kind: 'jsonl', line: e.source.line, byteStart: null, byteEnd: null }
        : e.source.row ? { kind: 'sqlite', table: 'adapter-record', rowKey: e.source.row }
        : { kind: 'json', pointer: e.source.pointer ?? '' },
      body: present(e.raw ?? { text: e.text }),
    });
    const base = { id, nativeId: str(r.uuid ?? p.id), sequence: i, branchId: null, time: time(e.timestamp),
      evidence: [{ recordId, pointer: '', textRange: null }], issueIds: [], links: [] };
    if (e.kind === 'message') {
      const role = ['user', 'assistant', 'system', 'developer', 'tool'].includes(e.role ?? '') ? e.role as 'user' | 'assistant' | 'system' | 'developer' | 'tool' : 'unknown';
      const channel = ['final', 'commentary', 'analysis'].includes(p.phase ?? p.channel) ? (p.phase ?? p.channel) : 'unknown';
      events.push({ ...base, kind: 'message', role, author: role === 'assistant' ? 'agent' : role === 'tool' ? 'tool' : 'unknown',
        nativeRole: e.role ?? null, nativeChannel: str(p.phase ?? p.channel), channel,
        visibility: 'unknown', messageState: 'unknown', content: [textBlock(id, e.text)] });
    } else if (e.kind === 'tool-call') {
      let args = p.input ?? p.arguments ?? p.action;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* Preserve non-JSON arguments. */ } }
      events.push({ ...base, kind: 'tool-call', nativeCallId: nativeCallId(e), name: str(p.name ?? p.tool_name) ?? singleLine(e.text.split('\n')[0]).slice(0, 2048) ?? 'tool',
        namespace: null, execution: p.type === 'server_tool_use' ? 'server' : 'unknown', arguments: args === undefined ? absent() : present(args) });
    } else if (e.kind === 'tool-result') {
      const native = nativeCallId(e), candidates = native ? calls.get(native) ?? [] : [];
      // Only structured source status establishes a failure. Text mentioning an error is insufficient.
      const output = obj(p.output);
      const error = p.is_error ?? p.isError ?? output.is_error ?? output.isError;
      const code = p.exit_code ?? output.exit_code ?? obj(output.metadata).exit_code;
      const outcome = error === true || typeof code === 'number' && code !== 0 ? 'reported-error'
        : error === false || code === 0 ? 'reported-success' : 'unknown';
      events.push({ ...base, kind: 'tool-result', call: candidates.length === 1
        ? { status: 'matched', eventId: candidates[0], nativeCallId: native, basis: 'native-id', rule: null }
        : { status: candidates.length ? 'ambiguous' : 'unmatched', nativeCallId: native, candidateEventIds: candidates },
        outcome, nativeStatus: str(p.status), output: [textBlock(id, e.text)] });
    } else {
      // Context, compaction, usage and lineage are deliberately not guessed from display text.
      events.push({ ...base, kind: 'unknown', nativeType: str(p.type ?? r.type), data: e.raw === undefined ? absent() : present(e.raw) });
    }
  });
  const evidence = events[0]?.evidence ?? [];
  return {
    schemaVersion: SCHEMA_VERSION, normalization: { version: 'local-projection/1', identityVersion: 'source-local/1' },
    session: { id: s.id, nativeId: s.nativeId, harness: s.agent, harnessVersion: null, surface: null, profileLabel: null,
      title: { text: singleLine(s.title).slice(0, 2048), basis: 'fallback', evidence: [] }, projectLabel: s.project,
      startedAt: null, endedAt: null, selectedBranchId: null, relations: [] },
    capture: { capturedAt: new Date().toISOString(), readState: trace.truncated ? 'partial' : 'unknown', coverage: [
      { facet: 'messages', state: trace.truncated ? 'partial' : events.some(e => e.kind === 'message') ? 'observed' : 'unknown', scope: { kind: 'session' }, explanation: 'Retained adapter events; source-only branches and multimodal blocks may be absent.', evidence },
      { facet: 'lineage', state: 'unknown', scope: { kind: 'session' }, explanation: 'This first local projection does not resolve branches or inherited history.', evidence: [] },
      { facet: 'usage', state: 'unknown', scope: { kind: 'session' }, explanation: 'Usage records are retained as unknown events; no totals are inferred.', evidence: [] },
    ] },
    sources: [{ id: sourceId, format: s.locator.format, formatVersion: null, adapter: { id: s.agent, version: '0.1.0' },
      label: `${s.agent} local session`, readState: trace.truncated ? 'partial' : 'unknown', consistency: 'unknown', bytesRead: s.bytes, sourceBytes: null }],
    records, branches: [], events, spans: [],
    issues: [...new Set(trace.warnings)].map((detail, i) => ({ id: `issue:${i}`, code: 'adapter-warning', severity: 'warning', detail: detail.slice(0, 2048), affected: ['/capture'], evidence: [] })),
    redaction: { policyVersion: 'local-unredacted/1', transforms: [] },
  };
}
