import path from 'node:path';
import { lstat, open, readdir } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Root, ScanContext, Session, TraceEvent, Transcript } from '../core/types.js';
import { checkBudget, diagnostic, readJsonLines, walkFiles } from '../core/io.js';
import { contentText, iso, projectName, safeText, singleLine, stableId } from '../core/safe.js';

type Row = Record<string, any>;
const META_BYTES = 256 * 1024;
const MAX_DATABASE_ROWS = 10_000;
const CURSOR_TABLES = ['cursorDiskKV', 'ItemTable'] as const;
type Table = typeof CURSOR_TABLES[number] | 'sessions' | 'messages';
const live = (ctx: ScanContext) => !ctx.signal.aborted && Date.now() < ctx.deadline;
const nullableText = (value: unknown) => typeof value === 'string' && value ? safeText(value) : null;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Normal read-only SQLite connections see committed WAL data. Never use immutable=1. */
async function openDatabase(file: string): Promise<DatabaseSync> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Database must be a regular, non-symlink file');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=100; BEGIN;');
    return db;
  } catch (e) { db.close(); throw e; }
}

function closeDatabase(db: DatabaseSync | undefined): void {
  if (!db) return;
  try { db.exec('ROLLBACK;'); } finally { db.close(); }
}

function inspectedSession(session: Session, events: TraceEvent[], truncated: boolean, bytes: number): Session {
  return {
    ...session, bytes,
    messages: truncated ? null : new Set(events.filter(e => e.kind === 'message').map(e => e.source.row ?? e.source.line ?? e.id)).size,
    toolCalls: truncated || session.locator.format === 'cursor-text' ? null : events.filter(e => e.kind === 'tool-call').length,
    warnings: session.warnings.filter(w => !w.startsWith('Message count is producer-reported')),
    evidence: events.some(e => e.kind === 'tool-call' || e.kind === 'tool-result') ? 'messages + tools'
      : events.some(e => e.kind === 'message') ? 'messages' : 'metadata only',
  };
}

/** Only query ordinary, explicitly named tables; never execute schema SQL or visit virtual tables. */
function columns(db: DatabaseSync, table: Table): Set<string> {
  const record = db.prepare("SELECT type, sql FROM sqlite_master WHERE name = ?").get(table) as Row | undefined;
  if (!record || record.type !== 'table' || /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(String(record.sql))) return new Set();
  return new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as Row[]).map(r => String(r.name)));
}

function baseSession(root: Root, nativeId: string, file: string, format: string): Session {
  return {
    id: stableId(root.agent, file, nativeId), nativeId, agent: root.agent,
    title: `Untitled ${root.agent} session`, project: null, cwd: null,
    startedAt: null, updatedAt: null, timeSource: 'unknown', messages: null,
    toolCalls: null, bytes: 0, archived: false, parentId: null, preview: '',
    warnings: [], evidence: 'metadata only', locator: { path: file, root: root.path, format },
  };
}

function parseJson(value: unknown): any {
  if (typeof value !== 'string' && !ArrayBuffer.isView(value)) return null;
  try { return JSON.parse(typeof value === 'string' ? value : Buffer.from(value as Uint8Array).toString('utf8')); }
  catch { return null; }
}

function normalizedEvents(value: Row, source: TraceEvent['source'], prefix: string): TraceEvent[] {
  const role = String(value.role ?? value.message?.role ?? (value.type === 1 ? 'user' : value.type === 2 ? 'assistant' : 'unknown'));
  const content = value.message?.content ?? value.content ?? value.text;
  const timestamp = iso(value.timestamp ?? value.createdAt);
  const events: TraceEvent[] = [];
  const add = (kind: TraceEvent['kind'], text: unknown, raw: unknown, suffix: string, pointer?: string) => {
    events.push({ id: `${prefix}:${suffix}`, kind, role, text: safeText(text), timestamp, source: { ...source, ...(pointer ? { pointer } : {}) }, raw });
  };
  if (Array.isArray(content)) {
    for (const [i, block] of content.entries()) {
      if (!block || typeof block !== 'object') continue;
      const pointer = `/message/content/${i}`;
      if (['tool_use', 'tool_call', 'tool-call'].includes(block.type)) {
        add('tool-call', `${block.name ?? block.function?.name ?? 'tool'} ${typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? block.function?.arguments ?? {})}`, block, String(i), pointer);
      } else if (['tool_result', 'tool-result'].includes(block.type)) {
        add('tool-result', contentText(block.content ?? block.output), block, String(i), pointer);
      } else if (['text', 'input_text', 'output_text'].includes(block.type)) {
        add(role === 'tool' ? 'tool-result' : 'message', contentText(block), block, String(i), pointer);
      } else {
        add('unknown', contentText(block) || `[${singleLine(block.type ?? 'unknown content block')}]`, block, String(i), pointer);
      }
    }
  } else if (typeof content === 'string' && content) add(role === 'tool' ? 'tool-result' : 'message', content, value, 'text');
  const tools = typeof value.tool_calls === 'string' ? parseJson(value.tool_calls) : value.tool_calls;
  if (Array.isArray(tools)) for (const [i, tool] of tools.entries()) {
    if (!tool || typeof tool !== 'object') continue;
    add('tool-call', `${tool.function?.name ?? tool.name ?? 'tool'} ${typeof tool.function?.arguments === 'string' ? tool.function.arguments : JSON.stringify(tool.function?.arguments ?? tool.input ?? {})}`, tool, `tool-${i}`, `/tool_calls/${i}`);
  }
  if (!events.length) add('unknown', '[No recognized display content]', value, 'unknown');
  return events;
}

async function readCursorFile(file: string, ctx: ScanContext, maxBytes = ctx.maxFileBytes): Promise<{ events: TraceEvent[]; warnings: string[]; truncated: boolean; bytes: number }> {
  if (file.endsWith('.jsonl')) {
    const data = await readJsonLines(file, ctx, { maxBytes });
    const events: TraceEvent[] = [];
    let truncated = data.truncated;
    for (const { value, line } of data.records) {
      if (!value || typeof value !== 'object') continue;
      const next = normalizedEvents(value, { line }, `line-${line}`);
      if (events.length + next.length > ctx.maxEvents) truncated = true;
      events.push(...next.slice(0, Math.max(0, ctx.maxEvents - events.length)));
      if (events.length >= ctx.maxEvents) break;
    }
    return { ...data, events, truncated };
  }
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Transcript is not a regular file');
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    const events: TraceEvent[] = [];
    let role = 'unknown', start = 1, chunk: string[] = [];
    const flush = () => {
      if (!chunk.length || events.length >= ctx.maxEvents) return;
      const text = safeText(chunk.join('\n').trim());
      if (text) events.push({ id: `line-${start}`, kind: role === 'unknown' ? 'unknown' : 'message', role, text, timestamp: null, source: { line: start } });
      chunk = [];
    };
    for (const [i, line] of lines.entries()) {
      const marker = /^(user|assistant|system|tool):\s*$/i.exec(line);
      if (marker) { flush(); role = marker[1]!.toLowerCase(); start = i + 1; }
      else chunk.push(line);
    }
    flush();
    const after = await handle.stat();
    const truncated = bytesRead < stat.size || events.length >= ctx.maxEvents || after.mtimeMs !== stat.mtimeMs;
    return { events, bytes: stat.size, truncated, warnings: [
      'Cursor text transcript: tool details and original timestamps may be unavailable.',
      ...(truncated ? ['Bounded or changing transcript; counts are unknown.'] : []),
    ] };
  } finally { await handle.close(); }
}

async function* discoverCursorFiles(root: Root, ctx: ScanContext): AsyncGenerator<Session> {
  for await (const file of walkFiles(root.path, ctx, f => /\.(jsonl|txt)$/.test(f) && (f.split(path.sep).includes('agent-transcripts') || root.provenance === 'explicit'))) {
    try {
      const data = await readCursorFile(file, ctx, Math.min(ctx.maxFileBytes, META_BYTES));
      if (!data.events.some(e => e.role === 'user' || e.role === 'assistant')) {
        diagnostic(ctx, 'cursor', file, 'No recognized Cursor conversation messages', data.warnings.some(w => w.includes('Invalid') || w.includes('incomplete')) ? 'warning' : 'info'); continue;
      }
      const nativeId = path.basename(file).replace(/\.(jsonl|txt)$/, '');
      const session = baseSession(root, nativeId, file, file.endsWith('.jsonl') ? 'cursor-jsonl' : 'cursor-text');
      const stat = await lstat(file);
      const projectPart = file.split(path.sep).indexOf('agent-transcripts');
      session.project = projectPart > 0 ? file.split(path.sep)[projectPart - 1]! : null;
      const parent = file.split(path.sep).indexOf('subagents');
      session.parentId = parent > 0 ? file.split(path.sep)[parent - 1]! : null;
      session.preview = singleLine(data.events.find(e => e.kind === 'message' && e.role === 'user')?.text ?? '').slice(0, 240);
      session.title = session.preview || `Cursor session ${nativeId.slice(0, 8)}`;
      session.startedAt = data.events.find(e => e.timestamp)?.timestamp ?? null;
      session.updatedAt = !data.truncated ? [...data.events].reverse().find(e => e.timestamp)?.timestamp ?? stat.mtime.toISOString() : stat.mtime.toISOString();
      session.timeSource = !data.truncated && data.events.some(e => e.timestamp) ? 'recorded' : 'filesystem';
      session.messages = data.truncated ? null : new Set(data.events.filter(e => e.kind === 'message').map(e => e.source.line)).size;
      session.toolCalls = data.truncated || session.locator.format === 'cursor-text' ? null : data.events.filter(e => e.kind === 'tool-call').length;
      session.bytes = data.bytes;
      session.warnings = data.warnings;
      if (data.truncated && !session.warnings.some(w => w.includes('Bounded'))) session.warnings.push('Bounded preview; message and tool counts are unknown.');
      session.evidence = data.events.some(e => e.kind === 'tool-call') ? 'messages + tools' : 'messages';
      yield session;
    } catch (e) { diagnostic(ctx, 'cursor', file, `Cannot read transcript: ${errorText(e)}`); }
  }
}

function cursorTables(db: DatabaseSync): Array<typeof CURSOR_TABLES[number]> {
  return CURSOR_TABLES.filter(table => { const names = columns(db, table); return names.has('key') && names.has('value'); });
}

async function* discoverCursorDatabase(root: Root, file: string, ctx: ScanContext): AsyncGenerator<Session> {
  let db: DatabaseSync | undefined;
  try {
    db = await openDatabase(file);
    const tables = cursorTables(db);
    if (!tables.length) { diagnostic(ctx, 'cursor', file, 'Unsupported Cursor SQLite schema: no ordinary key/value table'); return; }
    let remaining = Math.min(MAX_DATABASE_ROWS, Math.max(0, ctx.maxFiles - ctx.scanned));
    for (const table of tables) {
      // Bound values before transferring them out of SQLite; large opaque blobs are never hydrated.
      const rows = db.prepare(`SELECT key, length(CAST(value AS BLOB)) AS bytes, CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value END AS value FROM "${table}" WHERE key >= 'composerData:' AND key < 'composerData;' ORDER BY key LIMIT ?`).iterate(ctx.maxRecordBytes, remaining);
      for (const row of rows as Iterable<Row>) {
        if (!live(ctx) || remaining-- <= 0) break;
        ctx.scanned++;
        const nativeId = String(row.key).slice('composerData:'.length);
        if (!nativeId) continue;
        const session = baseSession(root, nativeId, file, 'cursor-sqlite');
        session.locator.key = JSON.stringify({ table, key: row.key });
        const data = parseJson(row.value);
        if (!data || typeof data !== 'object') {
          session.warnings.push(Number(row.bytes) > ctx.maxRecordBytes ? 'Composer metadata exceeds the record limit; open the file transcript when available.' : 'Unrecognized or invalid Cursor composer metadata.');
        } else {
          const messages = Array.isArray(data.conversation) ? data.conversation.flatMap((v: Row, i: number) => v && typeof v === 'object' ? normalizedEvents(v, { row: `${row.key}/conversation/${i}` }, String(i)) : []) : [];
          session.preview = singleLine(messages.find((e: TraceEvent) => e.role === 'user' && e.kind === 'message')?.text ?? data.text ?? '').slice(0, 240);
          session.title = singleLine(data.name ?? data.title ?? session.preview).slice(0, 240) || `Cursor session ${nativeId.slice(0, 8)}`;
          session.startedAt = iso(data.createdAt);
          session.updatedAt = iso(data.lastUpdatedAt ?? data.updatedAt) ?? session.startedAt;
          session.timeSource = session.updatedAt ? 'recorded' : 'unknown';
          session.cwd = nullableText(data.cwd ?? data.workspacePath);
          session.project = projectName(session.cwd);
        }
        session.warnings.push('Experimental Cursor database format; full tools and attachments may be unavailable.');
        yield session;
      }
    }
    if (remaining <= 0) diagnostic(ctx, 'cursor', file, 'Cursor session limit reached; discovery is partial');
  } catch (e) { diagnostic(ctx, 'cursor', file, `Cannot read SQLite database: ${errorText(e)}`); }
  finally { closeDatabase(db); }
}

async function readCursorDatabase(session: Session, ctx: ScanContext): Promise<Transcript> {
  const warnings = [...session.warnings];
  const events: TraceEvent[] = [];
  let db: DatabaseSync | undefined, truncated = false, usedBytes = 0;
  try {
    db = await openDatabase(session.locator.path);
    const location = parseJson(session.locator.key);
    if (!location || !CURSOR_TABLES.includes(location.table) || typeof location.key !== 'string' || !location.key.startsWith('composerData:')) throw new Error('Invalid Cursor database locator');
    const table = location.table as typeof CURSOR_TABLES[number];
    if (!cursorTables(db).includes(table)) throw new Error('Unsupported Cursor database schema');
    const query = db.prepare(`SELECT key, length(CAST(value AS BLOB)) AS bytes, CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value END AS value FROM "${table}" WHERE key = ?`);
    const get = (key: string): Row | null => {
      if (!live(ctx)) { truncated = true; return null; }
      const row = query.get(ctx.maxRecordBytes, key) as Row | undefined;
      if (!row) { truncated = true; warnings.push(`Missing database row: ${singleLine(key)}`); return null; }
      const bytes = Number(row.bytes);
      if (bytes > ctx.maxRecordBytes || usedBytes + bytes > ctx.maxFileBytes) { truncated = true; warnings.push('Database record or transcript byte limit reached'); return null; }
      usedBytes += bytes;
      const parsed = parseJson(row.value);
      if (!parsed || typeof parsed !== 'object') { truncated = true; warnings.push(`Invalid JSON in database row: ${singleLine(key)}`); return null; }
      return parsed;
    };
    const data = get(location.key);
    const append = (value: Row, key: string) => {
      const next = normalizedEvents(value, { row: key }, key);
      if (events.length + next.length > ctx.maxEvents) truncated = true;
      events.push(...next.slice(0, Math.max(0, ctx.maxEvents - events.length)));
    };
    const headers = data?.fullConversationHeadersOnly;
    if (Array.isArray(headers) && headers.length) {
      for (const header of headers) {
        if (events.length >= ctx.maxEvents || !live(ctx)) { truncated = true; break; }
        if (!header || typeof header.bubbleId !== 'string') { truncated = true; warnings.push('Unrecognized conversation header omitted'); continue; }
        const key = `bubbleId:${session.nativeId}:${header.bubbleId}`;
        const bubble = get(key);
        if (bubble) append({ ...bubble, type: bubble.type ?? header.type }, key);
      }
    } else if (Array.isArray(data?.conversation) && data.conversation.length) {
      for (const [i, value] of data.conversation.entries()) {
        if (events.length >= ctx.maxEvents || !live(ctx)) { truncated = true; break; }
        if (value && typeof value === 'object') append(value, `${location.key}/conversation/${i}`);
      }
    } else {
      const prefix = `bubbleId:${session.nativeId}:`;
      const keys = db.prepare(`SELECT key FROM "${table}" WHERE key >= ? AND key < ? ORDER BY key LIMIT ?`).all(prefix, `${prefix}\uffff`, ctx.maxEvents + 1) as Row[];
      if (keys.length) warnings.push('Conversation ordering metadata unavailable; messages shown in database key order.');
      for (const row of keys) {
        if (events.length >= ctx.maxEvents || !live(ctx)) { truncated = true; break; }
        const bubble = get(String(row.key));
        if (bubble) append(bubble, String(row.key));
      }
    }
    if (!events.length) warnings.push('No readable conversation messages found; metadata only.');
  } catch (e) { warnings.push(`Cannot read SQLite transcript: ${errorText(e)}`); truncated = true; }
  finally { closeDatabase(db); }
  return { session: inspectedSession(session, events, truncated, usedBytes), events, warnings: [...new Set(warnings)].slice(0, 30), truncated };
}

export const cursorAdapter: Adapter = {
  manifest: {
    id: 'cursor', name: 'Cursor', status: 'experimental', formats: ['agent-transcripts JSONL', 'agent-transcripts text', 'state.vscdb composer/bubble records'],
    limitations: 'Undocumented formats. Transcript timestamps may be filesystem-derived; database attachment/tool coverage varies. Workspace database chat formats other than composerData are not parsed.',
    sources: ['https://cursor.com/docs/context/memories'],
  },
  roots(ctx) {
    const user = ctx.platform === 'darwin' ? path.join(ctx.home, 'Library', 'Application Support', 'Cursor', 'User')
      : ctx.platform === 'win32' ? path.join(ctx.env.APPDATA ?? path.join(ctx.home, 'AppData', 'Roaming'), 'Cursor', 'User')
      : path.join(ctx.env.XDG_CONFIG_HOME ?? path.join(ctx.home, '.config'), 'Cursor', 'User');
    return [
      { path: path.join(ctx.home, '.cursor', 'projects'), agent: 'cursor', provenance: 'default' },
      { path: path.join(user, 'globalStorage', 'state.vscdb'), agent: 'cursor', provenance: 'default' },
      { path: path.join(user, 'workspaceStorage'), agent: 'cursor', provenance: 'default' },
    ];
  },
  async *discover(root, ctx) {
    const stat = await lstat(root.path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') diagnostic(ctx, 'cursor', root.path, errorText(e)); return null; });
    if (!stat || stat.isSymbolicLink()) return;
    if (stat.isFile() && root.path.endsWith('.vscdb')) { if (checkBudget(ctx)) yield* discoverCursorDatabase(root, root.path, ctx); return; }
    if (path.basename(root.path) === 'workspaceStorage') {
      for await (const file of walkFiles(root.path, ctx, f => path.basename(f) === 'state.vscdb')) yield* discoverCursorDatabase(root, file, ctx);
      return;
    }
    yield* discoverCursorFiles(root, ctx);
  },
  async read(session, ctx) {
    if (session.locator.format === 'cursor-sqlite') return readCursorDatabase(session, ctx);
    const result = await readCursorFile(session.locator.path, ctx);
    return { session: inspectedSession(session, result.events, result.truncated, result.bytes), events: result.events, warnings: result.warnings, truncated: result.truncated };
  },
};

function hermesSchema(db: DatabaseSync): { sessions: Set<string>; messages: Set<string> } {
  const sessions = columns(db, 'sessions'), messages = columns(db, 'messages');
  if (!['id', 'started_at'].every(c => sessions.has(c)) || !['id', 'session_id', 'role', 'content'].every(c => messages.has(c))) throw new Error('Unsupported Hermes schema: expected sessions/messages tables and identifying columns');
  return { sessions, messages };
}

async function* discoverHermesDatabase(root: Root, file: string, ctx: ScanContext): AsyncGenerator<Session> {
  let db: DatabaseSync | undefined;
  try {
    db = await openDatabase(file);
    const schema = hermesSchema(db);
    const optional = ['title', 'ended_at', 'message_count', 'tool_call_count', 'cwd', 'parent_session_id', 'archived'];
    const fields = ['id', 'started_at', ...optional.filter(c => schema.sessions.has(c)).map(c => ['title', 'cwd'].includes(c) ? `substr("${c}", 1, 2048) AS "${c}"` : `"${c}"`)];
    const preview = db.prepare("SELECT substr(content, 1, 240) AS content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id LIMIT 1");
    const last = schema.messages.has('timestamp') ? db.prepare('SELECT timestamp FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1') : null;
    const limit = Math.min(MAX_DATABASE_ROWS, Math.max(0, ctx.maxFiles - ctx.scanned));
    let seen = 0;
    for (const row of db.prepare(`SELECT ${fields.join(', ')} FROM sessions ORDER BY started_at DESC LIMIT ?`).iterate(limit + 1) as Iterable<Row>) {
      if (!live(ctx) || seen++ >= limit) { diagnostic(ctx, 'hermes', file, 'Hermes session limit or deadline reached; discovery is partial'); break; }
      ctx.scanned++;
      const nativeId = String(row.id);
      const session = baseSession(root, nativeId, file, 'hermes-sqlite');
      session.locator.key = nativeId;
      const first = preview.get(nativeId) as Row | undefined;
      session.preview = singleLine(first?.content ?? '').slice(0, 240);
      session.title = singleLine(row.title).slice(0, 240) || session.preview || `Hermes session ${nativeId.slice(0, 8)}`;
      session.startedAt = iso(row.started_at);
      session.updatedAt = iso((last?.get(nativeId) as Row | undefined)?.timestamp) ?? iso(row.ended_at) ?? session.startedAt;
      session.timeSource = session.updatedAt ? 'recorded' : 'unknown';
      session.cwd = nullableText(row.cwd); session.project = projectName(session.cwd);
      session.parentId = nullableText(row.parent_session_id);
      session.archived = row.archived === 1;
      session.messages = count(row.message_count); session.toolCalls = count(row.tool_call_count);
      session.evidence = first ? (session.toolCalls ? 'messages + tools' : 'messages') : 'metadata only';
      session.warnings = ['Message count is producer-reported and may include system/tool rows.'];
      yield session;
    }
  } catch (e) { diagnostic(ctx, 'hermes', file, `Cannot read SQLite database: ${errorText(e)}`); }
  finally { closeDatabase(db); }
}

export const hermesAdapter: Adapter = {
  manifest: {
    id: 'hermes', name: 'Hermes', status: 'preview', formats: ['state.db sessions/messages'],
    limitations: 'SQLite sessions only; legacy per-session JSONL is not yet indexed. Counts are producer-reported; a shared database has no per-session byte size. Reasoning and binary attachments are not promoted to conversation text.',
    sources: ['https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage/'],
  },
  async roots(ctx) {
    const expand = (value: string) => path.resolve(value === '~' ? ctx.home : value.startsWith('~/') || value.startsWith('~\\') ? path.join(ctx.home, value.slice(2)) : value);
    const defaultHome = ctx.platform === 'win32' ? path.join(ctx.env.LOCALAPPDATA ?? path.join(ctx.home, 'AppData', 'Local'), 'hermes') : path.join(ctx.home, '.hermes');
    const bases: Array<{ path: string; provenance: Root['provenance'] }> = [
      ...(ctx.env.HERMES_HOME ? [{ path: expand(ctx.env.HERMES_HOME), provenance: 'environment' as const }] : []),
      { path: defaultHome, provenance: 'default' },
      ...(ctx.platform === 'win32' ? [{ path: path.join(ctx.home, '.hermes'), provenance: 'default' as const }] : []),
    ];
    const roots: Root[] = [], seen = new Set<string>();
    for (const base of bases) {
      if (seen.has(base.path)) continue;
      seen.add(base.path);
      roots.push({ path: path.join(base.path, 'state.db'), agent: 'hermes', provenance: base.provenance });
      const profiles = path.join(base.path, 'profiles');
      try {
        const entries = await readdir(profiles, { withFileTypes: true });
        for (const entry of entries.slice(0, Math.min(ctx.maxFiles, 1000))) {
          if (entry.isDirectory() && !entry.isSymbolicLink()) roots.push({ path: path.join(profiles, entry.name, 'state.db'), agent: 'hermes', provenance: base.provenance, label: entry.name });
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') diagnostic(ctx, 'hermes', profiles, errorText(e)); }
    }
    return roots;
  },
  async *discover(root, ctx) {
    const stat = await lstat(root.path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') diagnostic(ctx, 'hermes', root.path, errorText(e)); return null; });
    if (!stat || stat.isSymbolicLink() || !checkBudget(ctx)) return;
    if (stat.isFile()) { yield* discoverHermesDatabase(root, root.path, ctx); return; }
    const database = path.join(root.path, 'state.db');
    if ((await lstat(database).catch(() => null))?.isFile()) yield* discoverHermesDatabase(root, database, ctx);
  },
  async read(session, ctx) {
    let db: DatabaseSync | undefined, truncated = false, bytes = 0;
    const events: TraceEvent[] = [], warnings: string[] = [];
    try {
      db = await openDatabase(session.locator.path);
      const schema = hermesSchema(db);
      const contentColumns = ['content', 'tool_calls', 'tool_name', 'tool_call_id', 'codex_message_items'].filter(c => schema.messages.has(c));
      const fields = ['id', 'role', ...(schema.messages.has('timestamp') ? ['timestamp'] : []), ...contentColumns.flatMap(c => [`length(CAST("${c}" AS BLOB)) AS "${c}_bytes"`, `CASE WHEN length(CAST("${c}" AS BLOB)) <= ${ctx.maxRecordBytes} THEN "${c}" END AS "${c}"`])];
      for (const row of db.prepare(`SELECT ${fields.join(', ')} FROM messages WHERE session_id = ? ORDER BY id LIMIT ?`).iterate(session.nativeId, ctx.maxEvents + 1) as Iterable<Row>) {
        if (!live(ctx) || events.length >= ctx.maxEvents) { truncated = true; break; }
        const rowBytes = contentColumns.reduce((n, c) => n + Number(row[`${c}_bytes`] ?? 0), 0);
        if (rowBytes > ctx.maxRecordBytes || bytes + rowBytes > ctx.maxFileBytes) { warnings.push(`Message row ${row.id} exceeds the record or transcript byte limit`); truncated = true; if (bytes + rowBytes > ctx.maxFileBytes) break; continue; }
        bytes += rowBytes;
        // Some Hermes backends store structured content as a JSON string.
        const decoded = parseJson(row.content);
        if (Array.isArray(decoded)) row.content = decoded;
        if (!row.content && row.codex_message_items) {
          const sidecar = parseJson(row.codex_message_items);
          if (Array.isArray(sidecar)) row.content = sidecar.filter(v => v?.type === 'message' && v.phase !== 'commentary' && v.phase !== 'analysis').flatMap(v => v.content ?? []);
        }
        const next = normalizedEvents(row, { row: `messages:${row.id}` }, `messages:${row.id}`);
        if (next.length + events.length > ctx.maxEvents) truncated = true;
        events.push(...next.slice(0, Math.max(0, ctx.maxEvents - events.length)));
      }
    } catch (e) { warnings.push(`Cannot read SQLite transcript: ${errorText(e)}`); truncated = true; }
    finally { closeDatabase(db); }
    return { session: inspectedSession(session, events, truncated, bytes), events, warnings: [...new Set(warnings)].slice(0, 30), truncated };
  },
};
