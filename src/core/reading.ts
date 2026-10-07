import type { NormalizedEvent, NormalizedSnapshot } from '../schema/normalized.js';
import { eventText } from './normalize.js';

export interface Observation { id: string; title: string; detail: string; tone: 'warning' | 'info'; eventIds: string[] }
export interface Reading {
  request: { text: string; eventId: string } | null;
  response: { text: string; eventId: string } | null;
  observations: Observation[];
  messages: number; tools: number; errors: number; unresolved: number;
  elapsedMs: number | null;
}
export function readSnapshot(snapshot: NormalizedSnapshot): Reading {
  const events = snapshot.events;
  const messages = events.filter(e => e.kind === 'message');
  const request = messages.find(e => e.kind === 'message' && e.role === 'user');
  const response = messages.findLast(e => e.kind === 'message' && e.role === 'assistant');
  const calls = events.filter(e => e.kind === 'tool-call');
  const results = events.filter(e => e.kind === 'tool-result');
  const answered = new Set(results.flatMap(e => e.kind === 'tool-result' && e.call.status === 'matched' ? [e.call.eventId] : []));
  const errors = results.filter(e => e.kind === 'tool-result' && e.outcome === 'reported-error');
  const unresolved = calls.filter(e => !answered.has(e.id));
  const observations: Observation[] = [];
  for (const e of errors.slice(0, 20)) {
    if (e.kind !== 'tool-result') continue;
    const callId = e.call.status === 'matched' ? e.call.eventId : null;
    const call = events.find(c => c.id === callId);
    observations.push({ id: `error:${e.id}`, title: `${call?.kind === 'tool-call' ? call.name : 'Tool'} reported an error`,
      detail: 'The source records a failed result. Inspect the output and the events that follow.', tone: 'warning', eventIds: [e.id, ...(callId ? [callId] : [])] });
  }
  const groups = new Map<string, NormalizedEvent[]>();
  for (const call of calls) {
    if (call.kind !== 'tool-call' || call.arguments.state !== 'present') continue;
    const key = JSON.stringify([call.name, call.arguments.value]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(call);
  }
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    const call = group[0];
    observations.push({ id: `repeat:${call.id}`, title: `${call.kind === 'tool-call' ? call.name : 'Tool'} called ${group.length} times with identical arguments`,
      detail: 'Repeated calls can be intentional. This observation alone does not establish a retry loop or wasted work.', tone: 'info', eventIds: group.map(e => e.id) });
    if (observations.length >= 30) break;
  }
  if (unresolved.length) observations.push({ id: 'unresolved', title: `${unresolved.length} tool call${unresolved.length === 1 ? '' : 's'} without a matched result`,
    detail: 'The capture may be incomplete, the call may still be running, or the source may use an unsupported result format.', tone: 'info', eventIds: unresolved.map(e => e.id) });
  const unmatched = results.filter(e => e.kind === 'tool-result' && e.call.status !== 'matched');
  if (unmatched.length) observations.push({ id: 'unmatched', title: `${unmatched.length} result${unmatched.length === 1 ? '' : 's'} with uncertain call linkage`,
    detail: 'No unique native call ID matched. These results remain available as evidence.', tone: 'info', eventIds: unmatched.map(e => e.id) });
  const times = events.flatMap(e => e.time?.basis === 'recorded-event' ? [Number(BigInt(e.time.unixNs) / 1_000_000n)] : []);
  const elapsedMs = times.length > 1 ? times.reduce((a, b) => Math.max(a, b)) - times.reduce((a, b) => Math.min(a, b)) : null;
  return { request: request ? { text: eventText(request), eventId: request.id } : null,
    response: response ? { text: eventText(response), eventId: response.id } : null,
    observations, messages: messages.length, tools: calls.length, errors: errors.length, unresolved: unresolved.length, elapsedMs };
}
