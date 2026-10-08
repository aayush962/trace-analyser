import type { Session, TraceEvent } from './types.js';

/** Only a complete, understood capture can establish absence of activity. */
export function traceActivity(events: TraceEvent[], incomplete: boolean): NonNullable<Session['activity']> {
  if (events.some(e => e.kind === 'tool-call' || e.kind === 'tool-result' || e.kind === 'message' && e.text.trim())) return 'present';
  if (incomplete || events.some(e => e.kind === 'unknown' || e.kind === 'message')) return 'unknown';
  // Some adapters retain unfamiliar records and reasoning under "metadata".
  // Only known setup records establish an otherwise unused session.
  const setupTypes = new Set(['session_meta', 'turn_context', 'custom-title', 'file-history-snapshot']);
  if (events.some(e => e.kind === 'metadata' && (!e.raw || typeof e.raw !== 'object'
    || !setupTypes.has(String((e.raw as { type?: unknown }).type))))) return 'unknown';
  return 'empty';
}

export const isEmptySession = (session: Session): boolean => session.activity === 'empty';
