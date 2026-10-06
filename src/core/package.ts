import { writeFile, rename, link, unlink, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Transcript } from './types.js';

const patterns: [string, RegExp][] = [
  ['api-key', /\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi],
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],
  ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g],
];
export function scrub(value: unknown, home: string): { value: unknown; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const hit = (kind: string) => { counts[kind] = (counts[kind] ?? 0) + 1; return `[REDACTED:${kind}]`; };
  function visit(v: unknown, depth: number): unknown {
    if (depth > 80) return hit('depth-limit');
    if (typeof v === 'string') {
      let s = home && home.length > 1 ? v.split(home).join('~') : v;
      for (const [kind, pattern] of patterns) s = s.replace(pattern, () => hit(kind));
      s = s.replace(/((?:api[_-]?key|access[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',;}]{8,}/gi, (_match, prefix: string) => prefix + hit('credential'));
      return s;
    }
    if (Array.isArray(v)) return v.map(item => visit(item, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([key, data]) => {
      if (/^(api_?key|access_token|refresh_token|password|authorization|secret|encrypted_content)$/i.test(key) && data) return [key, hit('credential-field')];
      if (/^(base64|image_data|audio_data)$/i.test(key) && data) return [key, hit('attachment')];
      return [key, visit(data, depth + 1)];
    }));
    return v;
  }
  return { value: visit(value, 0), counts };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => JSON.stringify(key) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function makePackage(transcript: Transcript, home: string) {
  const { locator: _locator, id: _localId, ...session } = transcript.session;
  const sanitized = scrub({ session, events: transcript.events, warnings: transcript.warnings, truncated: transcript.truncated }, home);
  const content = sanitized.value as object;
  const snapshotDigest = createHash('sha256').update(canonical(content)).digest('hex');
  return { schemaVersion: 'trace-reader/1', adapterVersion: '0.1.0', snapshotDigest, ...content,
    redaction: { policyVersion: '1', counts: sanitized.counts, notice: 'Known secret patterns removed; review before sharing. This is not guaranteed anonymization.' } };
}
export async function exportTranscript(transcript: Transcript, filename: string, home: string, force = false): Promise<string> {
  const output = path.resolve(filename);
  const source = await realpath(transcript.session.locator.path).catch(() => path.resolve(transcript.session.locator.path));
  const current = await realpath(output).catch(() => output);
  if (source === current) throw new Error('Export cannot replace its source transcript');
  if ((await lstat(output).catch(() => null))?.isSymbolicLink()) throw new Error('Export will not replace a symbolic link');
  const contents = JSON.stringify(makePackage(transcript, home), null, 2) + '\n';
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    if (force) await rename(temporary, output);
    else await link(temporary, output); // Atomic no-overwrite publication.
  } finally { await unlink(temporary).catch(() => {}); }
  return filename;
}
