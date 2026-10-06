import path from 'node:path';
import { stat } from 'node:fs/promises';
import { readJson, walkFiles, diagnostic } from '../core/io.js';
import { contentText, iso, projectName, singleLine, stableId } from '../core/safe.js';
import { AGENTS, type Adapter, type ScanContext, type Session, type TraceEvent, type Transcript } from '../core/types.js';

const roles = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
export async function importGeneric(file: string, ctx: ScanContext): Promise<Transcript> {
  const data: any = await readJson(file, ctx);
  const info = await stat(file);
  const isPackage = data?.schemaVersion === 'trace-reader/1';
  let events: TraceEvent[];
  let title: string;
  let warnings: string[] = [], truncated = false;
  if (isPackage) {
    const s = data.session;
    const optionalText = (v: unknown) => v === null || typeof v === 'string';
    const optionalCount = (v: unknown) => v === null || typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    if (!s || typeof s.title !== 'string' || typeof s.nativeId !== 'string' || typeof s.preview !== 'string'
      || !AGENTS.includes(s.agent) || !['project', 'cwd', 'parentId', 'startedAt', 'updatedAt'].every(k => optionalText(s[k]))
      || !['messages', 'toolCalls'].every(k => optionalCount(s[k])) || !Number.isSafeInteger(s.bytes) || s.bytes < 0
      || typeof s.archived !== 'boolean' || !['recorded', 'filesystem', 'unknown'].includes(s.timeSource)
      || !['messages + tools', 'messages', 'metadata only'].includes(s.evidence)
      || !Array.isArray(s.warnings) || !s.warnings.every((w: unknown) => typeof w === 'string')
      || !Array.isArray(data.events) || data.events.length > ctx.maxEvents) throw new Error('Invalid or oversized Trace reader package');
    events = data.events.map((event: any) => {
      if (!event || typeof event.id !== 'string' || typeof event.text !== 'string' || !['message', 'tool-call', 'tool-result', 'metadata', 'unknown'].includes(event.kind)) throw new Error('Invalid package event');
      return { id: event.id, kind: event.kind, text: event.text, role: typeof event.role === 'string' ? event.role : undefined,
        timestamp: iso(event.timestamp), source: { line: Number.isSafeInteger(event.source?.line) ? event.source.line : undefined,
          row: typeof event.source?.row === 'string' ? event.source.row : undefined, pointer: typeof event.source?.pointer === 'string' ? event.source.pointer : undefined }, raw: event.raw };
    });
    title = data.session.title;
    warnings = Array.isArray(data.warnings) ? data.warnings.filter((w: unknown) => typeof w === 'string').slice(0, 100) : [];
    truncated = data.truncated === true;
  } else {
    const messages = Array.isArray(data) ? data : data?.messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > ctx.maxEvents || !messages.every((m: any) => m && roles.has(m.role) && (typeof m.content === 'string' || Array.isArray(m.content)))) throw new Error('Unsupported JSON. Expected a Trace reader package or an explicit role/content message array.');
    events = messages.map((m: any, index: number) => ({ id: String(m.id ?? index), kind: m.role === 'tool' ? 'tool-result' : 'message', role: m.role,
      text: contentText(m.content), timestamp: iso(m.timestamp), source: { pointer: `/messages/${index}` }, raw: m }));
    title = singleLine(data?.title || events.find(e => e.role === 'user')?.text || path.basename(file)).slice(0, 180);
    warnings.push('Explicit generic conversation import; execution coverage and source harness are unknown.');
  }
  const nativeId = String(isPackage ? data.session.nativeId || data.snapshotDigest : stableId(JSON.stringify(data)));
  const cwd = isPackage && typeof data.session.cwd === 'string' ? data.session.cwd : null;
  const session: Session = {
    id: stableId('generic', file, nativeId), nativeId, agent: isPackage ? data.session.agent : 'generic', title: singleLine(title), cwd, project: isPackage ? data.session.project : projectName(cwd),
    startedAt: isPackage ? iso(data.session.startedAt) : events.find(e => e.timestamp)?.timestamp ?? null,
    updatedAt: isPackage ? iso(data.session.updatedAt) : [...events].reverse().find(e => e.timestamp)?.timestamp ?? info.mtime.toISOString(),
    timeSource: isPackage ? data.session.timeSource : events.some(e => e.timestamp) ? 'recorded' : 'filesystem', messages: isPackage ? data.session.messages : events.filter(e => e.kind === 'message').length,
    toolCalls: isPackage ? data.session.toolCalls : events.filter(e => e.kind === 'tool-call').length, bytes: isPackage ? data.session.bytes : info.size, archived: isPackage && data.session.archived === true,
    parentId: isPackage && typeof data.session.parentId === 'string' ? data.session.parentId : null,
    preview: isPackage ? data.session.preview : singleLine(events.find(e => e.role === 'user')?.text ?? '').slice(0, 300), warnings: isPackage ? data.session.warnings : warnings,
    evidence: isPackage ? data.session.evidence : events.some(e => e.kind.startsWith('tool')) ? 'messages + tools' : 'messages',
    locator: { path: file, root: path.dirname(file), format: isPackage ? 'trace-reader' : 'generic-json' },
  };
  return { session, events, warnings, truncated };
}
export const genericAdapter: Adapter = {
  manifest: { id: 'generic', name: 'Explicit imports', status: 'import-only', formats: ['trace-reader/1', 'role/content JSON arrays'], limitations: 'No automatic generic JSON detection. Explicit file import only; ZIP and ChatGPT account exports are not supported yet.', sources: [] },
  roots: () => [],
  async *discover(root, ctx) {
    for await (const file of walkFiles(root.path, ctx, p => p.endsWith('.trace.json'))) {
      try { yield (await importGeneric(file, ctx)).session; }
      catch (e) { diagnostic(ctx, 'generic', file, (e as Error).message); }
    }
  },
  read: (session, ctx) => importGeneric(session.locator.path, ctx),
};
