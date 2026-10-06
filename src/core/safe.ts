import { createHash } from 'node:crypto';
import path from 'node:path';

/** Trace text is data: strip terminal controls, including OSC and bidi overrides. */
export function safeText(value: unknown): string {
  return String(value ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -~]?/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}
export const singleLine = (value: unknown): string => safeText(value).replace(/\s+/g, ' ').trim();
export const stableId = (...parts: string[]): string => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
export function iso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(typeof value === 'number' && value < 1e11 ? value * 1000 : value as string);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}
export function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return contentText(v.text ?? v.content ?? v.output ?? v.input_text ?? '');
  }
  return '';
}
export function projectName(cwd: string | null): string | null { return cwd ? path.basename(cwd.replace(/[\\/]$/, '')) || cwd : null; }
