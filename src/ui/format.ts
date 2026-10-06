import stringWidth from 'string-width';
import { safeText, singleLine } from '../core/safe.js';
import type { Agent, Session } from '../core/types.js';

export const AGENT_LABELS: Record<Agent, string> = {
  'claude-code': 'Claude', codex: 'Codex', cursor: 'Cursor', hermes: 'Hermes',
  generic: 'Imported',
};
export const AGENT_COLORS: Record<Agent, string> = {
  'claude-code': '#DCAA83', codex: '#9BA8F4', cursor: '#D2D7E0',
  hermes: '#E2BD72', generic: '#94A3B8',
};

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function clip(value: unknown, width: number): string {
  return clipLine(singleLine(value), width);
}
export function clipLine(value: unknown, width: number): string {
  const text = safeText(value).replace(/[\r\n]/g, ' ').replace(/\t/g, '  ');
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  if (width === 1) return '…';
  let out = '';
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = stringWidth(segment);
    if (used + size > width - 1) break;
    out += segment;
    used += size;
  }
  return out + '…';
}
export function cell(value: unknown, width: number): string {
  const text = clipLine(value, width);
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}

/** Hard-wrap terminal cells without splitting emoji or allowing control sequences. */
export function wrap(value: unknown, width: number, limit = 10_000): string[] {
  const result: string[] = [];
  const safeWidth = Math.max(1, width);
  for (const paragraph of safeText(value).replace(/\t/g, '  ').split('\n')) {
    let line = '';
    let used = 0;
    for (const { segment } of segmenter.segment(paragraph)) {
      const size = stringWidth(segment);
      if (used + size > safeWidth && line) {
        const breakAt = line.lastIndexOf(' ');
        const breakOnWord = breakAt > 0 && stringWidth(line.slice(0, breakAt)) > safeWidth / 2;
        result.push(breakOnWord ? line.slice(0, breakAt) : line);
        if (result.length >= limit) return result;
        line = breakOnWord ? line.slice(breakAt + 1) : '';
        used = stringWidth(line);
      }
      if (size > safeWidth) continue;
      line += segment;
      used += size;
    }
    result.push(line);
    if (result.length >= limit) return result;
  }
  return result;
}
export const sessionTime = (session: Session): number => {
  const time = Date.parse(session.updatedAt ?? session.startedAt ?? '');
  return Number.isFinite(time) ? time : 0;
};
export const sortSessions = (sessions: Session[]): Session[] => [...sessions].sort((a, b) => sessionTime(b) - sessionTime(a) || a.id.localeCompare(b.id));
export function dateLabel(session: Session): string {
  const time = sessionTime(session);
  if (!time) return 'Undated';
  const date = new Date(time);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
export function timeLabel(session: Session): string {
  const time = sessionTime(session);
  return time ? new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }) : '  —  ';
}
export function bytesLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
export function filterSessions(sessions: Session[], query: string, agent: string): Session[] {
  const terms = singleLine(query).toLocaleLowerCase().split(' ').filter(Boolean);
  return sessions.filter(session => {
    if (agent !== 'all' && session.agent !== agent) return false;
    if (!terms.length) return true;
    const haystack = singleLine([session.title, session.project, session.cwd, session.agent, session.nativeId, session.preview].join(' ')).toLocaleLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}
export type ListRow = { kind: 'date'; label: string } | { kind: 'session'; session: Session; index: number };
export function groupRows(sessions: Session[]): ListRow[] {
  const rows: ListRow[] = [];
  let previous = '';
  sessions.forEach((session, index) => {
    const label = dateLabel(session);
    if (label !== previous) rows.push({ kind: 'date', label });
    rows.push({ kind: 'session', session, index });
    previous = label;
  });
  return rows;
}
