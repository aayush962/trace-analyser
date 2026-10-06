import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cursorAdapter, hermesAdapter } from '../src/adapters/databases.js';
import type { Adapter, Root, ScanContext, Session } from '../src/core/types.js';

function context(home: string, overrides: Partial<ScanContext> = {}): ScanContext {
  return {
    home, platform: 'linux', env: {}, signal: new AbortController().signal,
    deadline: Date.now() + 30_000, maxFiles: 2000, maxDepth: 10,
    maxFileBytes: 4 * 1024 * 1024, maxRecordBytes: 256 * 1024, maxEvents: 1000,
    scanned: 0, skipped: 0, diagnostics: [], ...overrides,
  };
}
async function collect(adapter: Adapter, root: Root, ctx: ScanContext): Promise<Session[]> {
  const result: Session[] = [];
  for await (const session of adapter.discover(root, ctx)) result.push(session);
  return result;
}
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
async function temporary(t: { after(fn: () => unknown): void }): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trace-reader-db-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function createHermes(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL, ended_at REAL, title TEXT, cwd TEXT, message_count INTEGER, tool_call_count INTEGER, parent_session_id TEXT, archived INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, tool_calls TEXT, tool_name TEXT, tool_call_id TEXT, codex_message_items TEXT);
    CREATE INDEX message_session ON messages(session_id, timestamp);
  `);
  return db;
}

test('Cursor discovers nested JSONL transcripts and source-addressed tool events', async t => {
  const home = await temporary(t);
  const root: Root = { agent: 'cursor', path: path.join(home, '.cursor/projects'), provenance: 'default' };
  const folder = path.join(root.path, 'project-name', 'agent-transcripts', 'session-a');
  await mkdir(path.join(folder, 'subagents'), { recursive: true });
  const file = path.join(folder, 'session-a.jsonl');
  await writeFile(file, [
    { role: 'user', message: { content: [{ type: 'text', text: '\u001b[31mBuild a reader\u001b[0m' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Reading files' }, { type: 'tool_use', name: 'read', input: { path: 'file.ts' } }] } },
    { role: 'user', message: { content: [{ type: 'tool_result', content: 'file contents' }] } },
  ].map(v => JSON.stringify(v)).join('\n'));
  await writeFile(path.join(folder, 'subagents', 'child.jsonl'), JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Child task' }] } }));
  const sessions = await collect(cursorAdapter, root, context(home));
  assert.equal(sessions.length, 2);
  const parent = sessions.find(s => s.nativeId === 'session-a')!;
  assert.equal(parent.title, 'Build a reader');
  assert.equal(parent.messages, 2);
  assert.equal(parent.toolCalls, 1);
  assert.equal(parent.timeSource, 'filesystem');
  assert.equal(sessions.find(s => s.nativeId === 'child')!.parentId, 'session-a');
  const opened = await cursorAdapter.read(parent, context(home));
  assert.equal(opened.events.find(e => e.kind === 'tool-call')?.source.line, 2);
  assert.equal(opened.events.find(e => e.kind === 'tool-result')?.text, 'file contents');
  assert.equal(opened.truncated, false);
});

test('Cursor text format is readable and bounded previews never fabricate exact counts', async t => {
  const home = await temporary(t);
  const root: Root = { agent: 'cursor', path: home, provenance: 'explicit' };
  await writeFile(path.join(home, 'chat.txt'), 'user:\nFix the build\n\nassistant:\n' + 'Explanation '.repeat(100));
  const full = await collect(cursorAdapter, root, context(home));
  assert.equal(full[0]?.messages, 2);
  assert.equal(full[0]?.title, 'Fix the build');
  const bounded = await collect(cursorAdapter, root, context(home, { maxFileBytes: 64 }));
  assert.equal(bounded[0]?.messages, null);
  assert.equal(bounded[0]?.toolCalls, null);
  assert.ok(bounded[0]?.warnings.some(w => w.includes('Bounded')));
});

test('Cursor composer headers preserve bubble order and source rows without modifying SQLite', async t => {
  const home = await temporary(t), file = path.join(home, 'state.vscdb');
  const writer = new DatabaseSync(file);
  t.after(() => writer.close());
  writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);');
  const put = writer.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
  put.run('composerData:session-1', JSON.stringify({ name: 'Database title', createdAt: 1700000000000, fullConversationHeadersOnly: [{ bubbleId: 'z', type: 1 }, { bubbleId: 'a', type: 2 }] }));
  put.run('bubbleId:session-1:z', JSON.stringify({ type: 1, text: 'First user message' }));
  put.run('bubbleId:session-1:a', JSON.stringify({ type: 2, text: 'Assistant answer' }));
  const before = await Promise.all([digest(file), digest(`${file}-wal`)]);
  const root: Root = { agent: 'cursor', path: file, provenance: 'explicit' };
  const sessions = await collect(cursorAdapter, root, context(home));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.title, 'Database title');
  assert.equal(sessions[0]?.messages, null);
  const opened = await cursorAdapter.read(sessions[0]!, context(home));
  assert.deepEqual(opened.events.map(e => e.text), ['First user message', 'Assistant answer']);
  assert.equal(opened.events[0]?.source.row, 'bubbleId:session-1:z');
  assert.equal(opened.truncated, false);
  assert.equal(opened.session.messages, 2);
  assert.equal(opened.session.evidence, 'messages');
  assert.ok(opened.session.bytes > 0);
  assert.deepEqual(await Promise.all([digest(file), digest(`${file}-wal`)]), before);
});

test('Hermes reads committed WAL messages, normalized tools and profile identity; source bytes stay unchanged', async t => {
  const home = await temporary(t), base = path.join(home, '.hermes');
  await mkdir(path.join(base, 'profiles', 'work'), { recursive: true });
  const file = path.join(base, 'state.db'), profile = path.join(base, 'profiles', 'work', 'state.db');
  const writer = createHermes(file), second = createHermes(profile);
  t.after(() => { writer.close(); second.close(); });
  for (const db of [writer, second]) db.prepare('INSERT INTO sessions VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?)').run('same-id', 1700000000, 'Build a CLI', '/project/demo', 3, 1, 0);
  writer.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(1, 'same-id', 'user', 'Create a reader', 1700000001, null, null, null, null);
  writer.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(2, 'same-id', 'assistant', 'I will inspect files', 1700000002, JSON.stringify([{ id: 'call-1', function: { name: 'read_file', arguments: '{"path":"index.ts"}' } }]), null, null, null);
  writer.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(3, 'same-id', 'tool', 'File data', 1700000003, null, 'read_file', 'call-1', null);
  const before = await Promise.all([digest(file), digest(`${file}-wal`)]);
  const roots = await hermesAdapter.roots(context(home));
  assert.equal(roots.length, 2);
  const sessions = (await Promise.all(roots.map(root => collect(hermesAdapter, root, context(home))))).flat();
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0]!.id, sessions[1]!.id);
  const session = sessions.find(s => s.locator.path === file)!;
  assert.equal(session.title, 'Build a CLI');
  assert.equal(session.project, 'demo');
  assert.equal(session.updatedAt, new Date(1700000003000).toISOString());
  const opened = await hermesAdapter.read(session, context(home));
  assert.deepEqual(opened.events.map(e => e.kind), ['message', 'message', 'tool-call', 'tool-result']);
  assert.equal(opened.events[3]?.source.row, 'messages:3');
  assert.match(opened.events[2]!.text, /read_file/);
  assert.equal(opened.truncated, false);
  assert.equal(opened.session.messages, 2);
  assert.equal(opened.session.toolCalls, 1);
  assert.equal(opened.session.evidence, 'messages + tools');
  assert.ok(!opened.session.warnings.some(w => w.includes('producer-reported')));
  assert.deepEqual(await Promise.all([digest(file), digest(`${file}-wal`)]), before);
});

test('Hermes honors HERMES_HOME and returns actionable diagnostics for schema drift', async t => {
  const home = await temporary(t), location = path.join(home, 'alternate');
  await mkdir(location);
  const db = new DatabaseSync(path.join(location, 'state.db'));
  db.exec('CREATE TABLE sessions (different_schema TEXT)'); db.close();
  const ctx = context(home, { env: { HERMES_HOME: location } });
  const roots = await hermesAdapter.roots(ctx);
  assert.equal(roots[0]!.provenance, 'environment');
  assert.equal(roots[0]!.path, path.join(location, 'state.db'));
  assert.ok(roots.some(r => r.path === path.join(home, '.hermes', 'state.db')));
  assert.deepEqual(await collect(hermesAdapter, roots[0]!, ctx), []);
  assert.ok(ctx.diagnostics.some(d => d.message.includes('Unsupported Hermes schema')));
});

test('Hermes omits oversized content with an explicit partial-result warning', async t => {
  const home = await temporary(t), file = path.join(home, 'state.db');
  const writer = createHermes(file); t.after(() => writer.close());
  writer.prepare('INSERT INTO sessions VALUES (?, ?, NULL, ?, NULL, 1, 0, NULL, 0)').run('big', 1700000000, 'Large session');
  writer.prepare('INSERT INTO messages VALUES (1, ?, ?, ?, 1700000000, NULL, NULL, NULL, NULL)').run('big', 'user', 'a'.repeat(1024));
  const sessions = await collect(hermesAdapter, { agent: 'hermes', path: file, provenance: 'explicit' }, context(home));
  const opened = await hermesAdapter.read(sessions[0]!, context(home, { maxRecordBytes: 64 }));
  assert.equal(opened.events.length, 0);
  assert.equal(opened.truncated, true);
  assert.match(opened.warnings[0]!, /byte limit/);
});

test('Cursor unsupported tables do not execute or infer arbitrary database schemas', async t => {
  const home = await temporary(t), file = path.join(home, 'state.vscdb');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE secrets(key TEXT,value TEXT); CREATE VIEW cursorDiskKV AS SELECT * FROM secrets;'); db.close();
  const ctx = context(home);
  const sessions = await collect(cursorAdapter, { agent: 'cursor', path: file, provenance: 'explicit' }, ctx);
  assert.deepEqual(sessions, []);
  assert.ok(ctx.diagnostics.some(d => d.message.includes('Unsupported Cursor SQLite schema')));
});

test('Hermes expands configured homes and includes Windows native and legacy defaults', async t => {
  const home = await temporary(t);
  const roots = await hermesAdapter.roots(context(home, { platform: 'win32', env: { HERMES_HOME: '~/custom-hermes', LOCALAPPDATA: path.join(home, 'AppData/Local') } }));
  assert.equal(roots[0]?.path, path.join(home, 'custom-hermes', 'state.db'));
  assert.ok(roots.some(r => r.path === path.join(home, 'AppData', 'Local', 'hermes', 'state.db')));
  assert.ok(roots.some(r => r.path === path.join(home, '.hermes', 'state.db')));
});

test('Cursor empty transcripts are informational and partial dated previews use filesystem time', async t => {
  const home = await temporary(t);
  await writeFile(path.join(home, 'empty.jsonl'), '');
  await writeFile(path.join(home, 'partial.jsonl'), JSON.stringify({ role: 'user', timestamp: '2020-01-01T00:00:00Z', message: { content: [{ type: 'text', text: 'Title' }] } }) + '\n' + 'a'.repeat(2000));
  const ctx = context(home, { maxFileBytes: 500 });
  const sessions = await collect(cursorAdapter, { agent: 'cursor', path: home, provenance: 'explicit' }, ctx);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.timeSource, 'filesystem');
  assert.notEqual(sessions[0]?.updatedAt, '2020-01-01T00:00:00.000Z');
  assert.equal(ctx.diagnostics.find(d => d.path.endsWith('empty.jsonl'))?.level, 'info');
});

test('Cursor missing bubble records explicitly make an inspection incomplete', async t => {
  const home = await temporary(t), file = path.join(home, 'state.vscdb');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:missing', JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: 'gone', type: 1 }] }));
  db.close();
  const sessions = await collect(cursorAdapter, { agent: 'cursor', path: file, provenance: 'explicit' }, context(home));
  const opened = await cursorAdapter.read(sessions[0]!, context(home));
  assert.equal(opened.truncated, true);
  assert.equal(opened.session.messages, null);
  assert.ok(opened.warnings.some(w => w.includes('Missing database row')));
});
