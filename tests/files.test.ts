import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeAdapter, codexAdapter } from '../src/adapters/files.js';
import type { Adapter, Root, ScanContext, Session } from '../src/core/types.js';

function context(home: string, overrides: Partial<ScanContext> = {}): ScanContext {
  return { home, platform: process.platform, env: {}, signal: new AbortController().signal,
    deadline: Date.now() + 30_000, maxFiles: 100, maxDepth: 10, maxFileBytes: 32 * 1024 * 1024,
    maxRecordBytes: 1024 * 1024, maxEvents: 10_000, scanned: 0, skipped: 0, diagnostics: [], ...overrides };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }, file: string, records: unknown[], tail = '') {
  const home = await mkdtemp(path.join(os.tmpdir(), 'trace-reader-files-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = path.join(home, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, records.map(r => JSON.stringify(r)).join('\n') + '\n' + tail);
  return { home, target };
}
async function discover(adapter: Adapter, root: Root, ctx: ScanContext): Promise<Session[]> {
  const sessions: Session[] = [];
  for await (const session of adapter.discover(root, ctx)) sessions.push(session);
  return sessions;
}
const claudeRoot = (home: string): Root => ({ path: path.join(home, '.claude/projects'), agent: 'claude-code', provenance: 'default' });
const codexRoot = (home: string): Root => ({ path: path.join(home, '.codex/sessions'), agent: 'codex', provenance: 'default' });

test('Claude discovers native transcripts, ignores prompt context, preserves tools, and counts message IDs once', async t => {
  const common = { sessionId: 'session-1', cwd: '/work/my-project', timestamp: '2026-10-01T12:00:00Z' };
  const { home } = await fixture(t, '.claude/projects/project/session-1.jsonl', [
    { ...common, type: 'user', uuid: 'meta', isMeta: true, message: { role: 'user', content: '<system-reminder>Injected context</system-reminder>' } },
    { ...common, type: 'user', uuid: 'u1', parentUuid: 'previous-message', message: { role: 'user', content: 'Fix\u001b[31m the login page' } },
    { ...common, type: 'assistant', uuid: 'a1', message: { id: 'msg-a', role: 'assistant', content: [{ type: 'text', text: 'I will inspect.' }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'app.ts' } }] } },
    { ...common, type: 'assistant', uuid: 'a2', message: { id: 'msg-a', role: 'assistant', content: [{ type: 'text', text: 'Found it.' }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } },
    { ...common, type: 'user', uuid: 'result-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'export const app = 1;' }] } },
  ]);
  const [session] = await discover(claudeAdapter, claudeRoot(home), context(home));
  assert.equal(session.title, 'Fix the login page');
  assert.equal(session.messages, 2);
  assert.equal(session.toolCalls, 1);
  assert.equal(session.parentId, null);
  assert.equal(session.project, 'my-project');
  assert.equal(session.timeSource, 'recorded');
  assert.equal(session.evidence, 'messages + tools');
  const transcript = await claudeAdapter.read(session, context(home));
  assert.equal(transcript.events.filter(e => e.kind === 'tool-call').length, 1);
  assert.equal(transcript.events.filter(e => e.kind === 'tool-result').length, 1);
  assert.equal(transcript.events.find(e => e.kind === 'tool-result')?.source.line, 5);
  assert.ok(transcript.events.every(e => !e.text.includes('\u001b')));
});

test('Claude subagents have their own native IDs and explicit parent session; unrelated JSONL is ignored', async t => {
  const { home } = await fixture(t, '.claude/projects/project/parent/subagents/agent-child.jsonl', [
    { type: 'user', sessionId: 'parent', parentUuid: 'message-uuid', message: { role: 'user', content: 'Check the tests' } },
  ]);
  await writeFile(path.join(home, '.claude/projects/plugin-log.jsonl'), JSON.stringify({ event: 'tool-hook', message: 'not a transcript' }));
  const sessions = await discover(claudeAdapter, claudeRoot(home), context(home));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].nativeId, 'agent-child');
  assert.equal(sessions[0].parentId, 'parent');
});

test('Codex prefers thread id over session id and suppresses mirrored events without collapsing repeated prompts', async t => {
  const meta = { type: 'session_meta', timestamp: '2026-10-01T12:00:00Z', payload: { id: 'child', session_id: 'root-thread', cwd: '/work/app', source: { subagent: { thread_spawn: { parent_thread_id: 'parent-thread' } } } } };
  const response = (role: string, text: string) => ({ type: 'response_item', timestamp: '2026-10-01T12:00:01Z', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
  const notification = (type: string, message: string) => ({ type: 'event_msg', payload: { type, message } });
  const { home } = await fixture(t, '.codex/sessions/2026/10/01/rollout-child.jsonl', [
    meta, response('user', '# AGENTS.md instructions for /work/app\n<INSTRUCTIONS>Rules</INSTRUCTIONS>'),
    response('user', '<environment_context>cwd</environment_context>'),
    response('user', 'Run the checks'), notification('user_message', 'Run the checks'),
    response('assistant', 'Done.'), notification('agent_message', 'Done.'),
    notification('user_message', 'Run the checks'), response('user', 'Run the checks'),
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"npm test"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'All passed' } },
  ]);
  const [session] = await discover(codexAdapter, codexRoot(home), context(home));
  assert.equal(session.nativeId, 'child');
  assert.equal(session.parentId, 'parent-thread');
  assert.equal(session.title, 'Run the checks');
  assert.equal(session.messages, 3);
  assert.equal(session.toolCalls, 1);
  const transcript = await codexAdapter.read(session, context(home));
  assert.equal(transcript.events.filter(e => e.kind === 'message').length, 3);
  assert.equal(transcript.events.find(e => e.kind === 'tool-result')?.text, 'All passed');
});

test('Malformed tails retain usable sessions with explicit unknown counts', async t => {
  const { home } = await fixture(t, '.claude/projects/project/s.jsonl', [
    { type: 'user', sessionId: 's', message: { role: 'user', content: 'Recover this session' } },
  ], '{"type":');
  const [session] = await discover(claudeAdapter, claudeRoot(home), context(home));
  assert.equal(session.title, 'Recover this session');
  assert.equal(session.messages, null);
  assert.ok(session.warnings.some(w => w.includes('line 2')));
  const transcript = await claudeAdapter.read(session, context(home));
  assert.equal(transcript.truncated, true);
});

test('Discovery is bounded, and inspect replaces preview counts with full counts', async t => {
  const records = [
    { type: 'session_meta', payload: { id: 'big', cwd: '/work' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A large session' }] } },
    ...Array.from({ length: 140 }, (_, i) => ({ type: 'event_msg', payload: { type: 'log', value: `${i}${'x'.repeat(4096)}` } })),
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Finished' }] } },
  ];
  const { home } = await fixture(t, '.codex/sessions/rollout-big.jsonl', records);
  const [session] = await discover(codexAdapter, codexRoot(home), context(home));
  assert.equal(session.messages, null);
  assert.equal(session.timeSource, 'filesystem');
  const transcript = await codexAdapter.read(session, context(home));
  assert.equal(transcript.truncated, false);
  assert.equal(transcript.session.messages, 2);
  assert.ok(!transcript.warnings.some(w => w.includes('Partial discovery')));
});

test('Event expansion is bounded and tools are not presented as ordinary user messages', async t => {
  const { home } = await fixture(t, '.claude/projects/project/s.jsonl', [
    { type: 'assistant', sessionId: 's', message: { role: 'assistant', content: Array.from({ length: 8 }, (_, i) => ({ type: 'tool_use', id: `call-${i}`, name: 'Read', input: {} })) } },
  ]);
  const [session] = await discover(claudeAdapter, claudeRoot(home), context(home));
  assert.equal(session.messages, 0);
  const transcript = await claudeAdapter.read(session, context(home, { maxEvents: 3 }));
  assert.equal(transcript.events.length, 3);
  assert.equal(transcript.truncated, true);
  assert.equal(transcript.session.toolCalls, null);
});

test('Configured roots are additive, deduplicated, and include archived Codex rollouts', async () => {
  const ctx = context('/tmp/user', { env: { CODEX_HOME: '/srv/codex', CLAUDE_CONFIG_DIR: '~/.claude' } });
  assert.deepEqual((await codexAdapter.roots(ctx)).map(r => r.path), ['/srv/codex/sessions', '/srv/codex/archived_sessions', '/tmp/user/.codex/sessions', '/tmp/user/.codex/archived_sessions']);
  assert.equal((await claudeAdapter.roots(ctx)).length, 1);
});

test('Codex archive status and inherited history limitations are explicit', async t => {
  const { home } = await fixture(t, '.codex/archived_sessions/rollout-old.jsonl', [
    { type: 'session_meta', payload: { id: 'old', forked_from_id: 'origin', history_base: { thread_id: 'origin' } } },
  ]);
  const root: Root = { path: path.join(home, '.codex/archived_sessions'), agent: 'codex', provenance: 'default', label: 'archived_sessions' };
  const [session] = await discover(codexAdapter, root, context(home));
  assert.equal(session.archived, true);
  assert.equal(session.parentId, 'origin');
  assert.equal(session.evidence, 'metadata only');
  assert.ok(session.warnings.some(w => w.includes('inherited history')));
});

test('Explicit Codex JSONL files need not use the original rollout filename', async t => {
  const { home, target } = await fixture(t, 'copied-session.jsonl', [
    { type: 'session_meta', payload: { id: 'copy', cwd: '/work' } },
  ]);
  const sessions = await discover(codexAdapter, { path: target, agent: 'codex', provenance: 'explicit' }, context(home));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].nativeId, 'copy');
});

test('Unknown Claude records are retained with source evidence and bounded warnings', async t => {
  const records = [
    { type: 'future-record', content: { unknown: 'before recognized record' } },
    { type: 'user', sessionId: 's', message: { role: 'user', content: 'Read this' } },
    ...Array.from({ length: 25 }, () => ({ type: 'future-record', content: 'after recognized record' })),
  ];
  const { home } = await fixture(t, '.claude/projects/project/s.jsonl', records);
  const [session] = await discover(claudeAdapter, claudeRoot(home), context(home));
  const transcript = await claudeAdapter.read(session, context(home));
  assert.equal(transcript.events.filter(e => e.kind === 'unknown').length, 26);
  assert.equal(transcript.events[0].source.line, 1);
  assert.deepEqual(transcript.events[0].raw, records[0]);
  assert.equal(transcript.warnings.filter(w => w.includes('unrecognized Claude')).length, 1);
  assert.equal(transcript.session.messages, null);
});

test('Local identity follows the actual file across default, nested, and explicit file discovery roots', async t => {
  const { home, target } = await fixture(t, '.codex/sessions/2026/10/01/rollout-stable.jsonl', [
    { type: 'session_meta', payload: { id: 'stable' } },
  ]);
  const [fromDefault] = await discover(codexAdapter, codexRoot(home), context(home));
  const [fromNested] = await discover(codexAdapter, { path: path.dirname(target), agent: 'codex', provenance: 'explicit' }, context(home));
  const [fromFile] = await discover(codexAdapter, { path: target, agent: 'codex', provenance: 'explicit' }, context(home));
  assert.equal(fromDefault.id, fromNested.id);
  assert.equal(fromDefault.id, fromFile.id);
});

test('Same-named Claude subagents under different parent sessions have distinct local identities', async t => {
  const { home } = await fixture(t, '.claude/projects/project/parent-one/subagents/agent-child.jsonl', [
    { type: 'user', sessionId: 'parent-one', message: { role: 'user', content: 'First child task' } },
  ]);
  const second = path.join(home, '.claude/projects/project/parent-two/subagents/agent-child.jsonl');
  await mkdir(path.dirname(second), { recursive: true });
  await writeFile(second, JSON.stringify({ type: 'user', sessionId: 'parent-two', message: { role: 'user', content: 'Second child task' } }));
  const sessions = await discover(claudeAdapter, claudeRoot(home), context(home));
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].id, sessions[1].id);
  assert.notEqual(sessions[0].parentId, sessions[1].parentId);
});

test('Codex titles skip plugin, skill, and app context wrappers before extracting the human request', async t => {
  const message = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const { home } = await fixture(t, '.codex/sessions/rollout-context-title.jsonl', [
    { type: 'session_meta', payload: { id: 'context-title' } },
    message('<recommended_plugins>Here is a list of available plugins</recommended_plugins>'),
    message('<skills_instructions>## Skills\nUse these helper tools</skills_instructions>'),
    message('<app-context>Desktop app context</app-context>'),
    message('<environment_context>working directory</environment_context>\n<codex_apps_client_time_context>Client time</codex_apps_client_time_context>'),
    message('<recommended_plugins>Tools</recommended_plugins>\n# AGENTS.md instructions for /work/project\n<INSTRUCTIONS>Repository policy</INSTRUCTIONS>'),
    message('# Files mentioned by the user:\n\nScreenshot.png\n\n## My request:\nBuild a trace reader with local discovery.'),
  ]);
  const [session] = await discover(codexAdapter, codexRoot(home), context(home));
  assert.equal(session.title, 'Build a trace reader with local discovery.');
  assert.equal(session.messages, 1);
});

test('Context stripping retains a human prompt in the same user record', async t => {
  const { home } = await fixture(t, '.codex/sessions/rollout-mixed-context.jsonl', [
    { type: 'session_meta', payload: { id: 'mixed' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>Available tools</recommended_plugins>\n<skills_instructions>Skills list</skills_instructions>\nPlease investigate the failing build.' }] } },
  ]);
  const [session] = await discover(codexAdapter, codexRoot(home), context(home));
  assert.equal(session.title, 'Please investigate the failing build.');
});

test('Codex native index provides an exact-ID title when context exceeds the discovery preview', async t => {
  const { home } = await fixture(t, '.codex/sessions/rollout-native-index.jsonl', [
    { type: 'session_meta', payload: { id: 'indexed-session', cwd: '/work' } },
    ...Array.from({ length: 140 }, () => ({ type: 'event_msg', payload: { type: 'context', content: 'x'.repeat(4096) } })),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Human prompt beyond preview' }] } },
  ]);
  await writeFile(path.join(home, '.codex/session_index.jsonl'), [
    { id: 'different-session', thread_name: 'Unrelated title', updated_at: '2026-10-05T12:00:00Z' },
    { id: 'indexed-session', thread_name: 'Build the trace browser', updated_at: '2026-10-06T12:00:00Z' },
  ].map(r => JSON.stringify(r)).join('\n'));
  const [session] = await discover(codexAdapter, codexRoot(home), context(home));
  assert.equal(session.title, 'Build the trace browser');
  assert.equal(session.preview, '');
  assert.equal(session.messages, null);
  const transcript = await codexAdapter.read(session, context(home));
  assert.equal(transcript.session.title, 'Build the trace browser');
  assert.equal(transcript.session.preview, 'Human prompt beyond preview');
  assert.equal(transcript.session.messages, 1);
});
