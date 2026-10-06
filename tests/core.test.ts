import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, chmod, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { context, discover, importFile, inspect } from '../src/core/discovery.js';
import { readJsonLines } from '../src/core/io.js';
import { exportTranscript, makePackage, scrub } from '../src/core/package.js';

async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trace-reader-core-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'sample.jsonl');
  await writeFile(file, [
    { type: 'session_meta', timestamp: '2026-10-01T00:00:00Z', payload: { id: 'example', cwd: '/example/project' } },
    { type: 'response_item', timestamp: '2026-10-01T00:01:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the API key sk-proj-abcdefghijklmnopqrstuvxyz' }] } },
    { type: 'response_item', timestamp: '2026-10-01T00:02:00Z', payload: { type: 'function_call', call_id: 'tool1', name: 'test', arguments: '{"api_key":"secret-value-abcdef"}' } },
  ].map(r => JSON.stringify(r)).join('\n'));
  return { root, file };
}

test('explicit native import, redaction, package export and re-import preserve semantic digest', async t => {
  const { root, file } = await fixture(t);
  const trace = await importFile(file);
  assert.equal(trace.session.agent, 'codex');
  assert.equal(trace.session.messages, 1);
  const out = path.join(root, 'out.trace.json');
  await exportTranscript(trace, out, os.homedir());
  const text = await readFile(out, 'utf8');
  assert.ok(!text.includes('sk-proj-abcdefghijklmnopqrstuvxyz'));
  assert.ok(!text.includes('secret-value-abcdef'));
  const reimport = await importFile(out);
  assert.equal(reimport.session.agent, 'codex');
  assert.equal(reimport.session.messages, 1);
  assert.equal(reimport.session.timeSource, 'recorded');
  assert.equal(makePackage(reimport, os.homedir()).snapshotDigest, JSON.parse(text).snapshotDigest);
  assert.equal((await inspect(reimport.session)).events.length, trace.events.length);
});

test('partial package preserves unknown counts, warnings and filesystem timestamp provenance', async t => {
  const { root, file } = await fixture(t);
  const trace = await importFile(file);
  trace.truncated = true; trace.session.messages = null; trace.session.toolCalls = null; trace.session.timeSource = 'filesystem';
  trace.warnings = ['Partial capture'];
  const out = path.join(root, 'partial.trace.json');
  await exportTranscript(trace, out, os.homedir());
  const reimport = await importFile(out);
  assert.equal(reimport.session.messages, null);
  assert.equal(reimport.session.toolCalls, null);
  assert.equal(reimport.session.timeSource, 'filesystem');
  assert.equal(reimport.truncated, true);
  assert.deepEqual(reimport.warnings, ['Partial capture']);
});

test('export refuses source overwrite, accidental overwrite and symlinks; force replaces with private file', async t => {
  const { root, file } = await fixture(t);
  const trace = await importFile(file), out = path.join(root, 'out.trace.json');
  await assert.rejects(exportTranscript(trace, file, root, true), /source transcript/);
  await writeFile(out, 'existing'); await chmod(out, 0o644);
  await assert.rejects(exportTranscript(trace, out, root), /EEXIST/);
  assert.equal(await readFile(out, 'utf8'), 'existing');
  await exportTranscript(trace, out, root, true);
  if (process.platform !== 'win32') assert.equal((await stat(out)).mode & 0o777, 0o600);
  const link = path.join(root, 'link.json');
  await symlink(out, link);
  await assert.rejects(exportTranscript(trace, link, root, true), /symbolic link/);
});

test('selected scans recognize native structure, count files once and exclude arbitrary JSON', async t => {
  const { root, file } = await fixture(t);
  const second = path.join(root, 'other'); await mkdir(second);
  const another = path.join(second, 'copied.jsonl');
  await writeFile(another, (await readFile(file, 'utf8')).replace('example"', 'other"'));
  const result = await discover({ roots: [file, another], cache: false });
  assert.equal(result.sessions.length, 2);
  assert.equal(result.scan.filesScanned, 2);
  assert.equal(result.scan.complete, true);
  const random = path.join(root, 'package.json');
  await writeFile(random, JSON.stringify({ name: 'package', messages: [] }));
  assert.equal((await discover({ roots: [random], cache: false })).sessions.length, 0);
  const limited = await discover({ roots: [root], recursive: true, maxFiles: 1, cache: false });
  assert.equal(limited.scan.complete, false);
  assert.ok(limited.scan.filesScanned <= 1);
  const missing = await discover({ roots: [path.join(root, 'missing')], cache: false });
  assert.equal(missing.scan.complete, false);
});

test('bounded JSONL keeps readable records around malformed/oversized records and reports omissions', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'bad.jsonl');
  await writeFile(file, '{"a":1}\ninvalid\n' + JSON.stringify({ value: 'x'.repeat(100000) }) + '\n{"a":2}');
  const data = await readJsonLines(file, { ...context(), maxRecordBytes: 1024 });
  assert.deepEqual(data.records.map(r => r.value), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(data.records.map(r => r.line), [1, 4]);
  assert.equal(data.truncated, true);
  assert.match(data.warnings.join('\n'), /line 2/);
  assert.match(data.warnings.join('\n'), /Oversized/);
});

test('descendant symlinks never widen an explicit scan; malformed packages fail validation', async t => {
  const { root, file } = await fixture(t);
  const nested = path.join(root, 'scope'); await mkdir(nested);
  await symlink(file, path.join(nested, 'outside.jsonl'));
  const result = await discover({ roots: [nested], recursive: true, cache: false });
  assert.equal(result.sessions.length, 0);
  assert.equal(result.scan.skipped, 1);
  const data: any = makePackage(await importFile(file), root);
  data.session.messages = 'a lot';
  const invalid = path.join(root, 'invalid.trace.json'); await writeFile(invalid, JSON.stringify(data));
  await assert.rejects(importFile(invalid), /Invalid/);
});

test('redaction covers nested credentials and terminal-host paths without altering ordinary values', () => {
  const result = scrub({ nested: [{ password: 'abc', text: 'Bearer abcdefghijklmnopqrstuvwxyz', cwd: '/Users/example/work' }], ordinary: 'a normal session' }, '/Users/example');
  const text = JSON.stringify(result.value);
  assert.ok(!text.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!text.includes('/Users/example'));
  assert.ok(text.includes('a normal session'));
});

test('CLI options work after the subcommand and non-TTY output is finite JSON', async t => {
  const { file } = await fixture(t);
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'list', '--root', file, '--agent', 'codex', '--json', '--no-cache', '--limit', '1'], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].agent, 'codex');
  const bad = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'scan', '--no-cache'], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
  assert.equal(bad.status, 2);
});
