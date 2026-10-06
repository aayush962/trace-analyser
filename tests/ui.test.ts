import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { render } from 'ink';
import stringWidth from 'string-width';
import { safeText } from '../src/core/safe.js';
import type { ScanResult, Session } from '../src/core/types.js';
import { App, type AppProps } from '../src/ui/App.js';
import { cell, clip, clipLine, filterSessions, wrap } from '../src/ui/format.js';

const session = (id: string, date = '2026-10-05T12:00:00Z'): Session => ({
  id, nativeId: id, agent: 'codex', title: `Trace ${id}`, project: 'demo', cwd: '/tmp/demo',
  startedAt: date, updatedAt: date, timeSource: 'recorded', messages: 12, toolCalls: 3,
  bytes: 1024, archived: false, parentId: null, preview: 'A useful local preview',
  warnings: [], evidence: 'messages + tools', locator: { path: `/tmp/${id}.jsonl`, root: '/tmp', format: 'jsonl' },
});
const result = (sessions: Session[]): ScanResult => ({
  schemaVersion: 'trace-reader-cli/1', sessions,
  scan: { complete: true, rootsChecked: 4, filesScanned: sessions.length, skipped: 0, durationMs: 25, stopReason: 'complete' },
  diagnostics: [{ agent: 'cursor', path: '/tmp/cursor', level: 'info', message: 'No source directory found' }],
});
async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); }
  assert.fail('UI did not reach expected state');
}
function harness(columns: number, props: AppProps) {
  const frames: string[] = [];
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) {
    const frame = safeText(chunk.toString());
    if (frame.includes('TRACE READER')) frames.push(frame);
    callback();
  } }), { columns, rows: 24, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; }, ref() {}, unref() {} });
  const app = render(createElement(App, props), { stdin, stdout, stderr: stdout, debug: true, interactive: true, patchConsole: false, kittyKeyboard: { mode: 'disabled' } });
  return { app, stdin, frames, frame: () => frames.at(-1) ?? '' };
}

test('terminal formatting strips executable controls and preserves graphemes within cell width', () => {
  assert.equal(clip('\x1b]52;c;payload\x07Hello\x1b[31m!', 20), 'Hello!');
  assert.equal(clip('你好世界', 5), '你好…');
  assert.equal(stringWidth(cell('👩‍💻 trace', 8)), 8);
  assert.equal(clipLine('    const x = 1;', 80), '    const x = 1;');
  assert.deepEqual(wrap('  alpha\nbeta', 6), ['  alph', 'a', 'beta']);
});

test('search matches every term and source filters independently', () => {
  const a = { ...session('a'), title: 'Fix request parser', project: 'alpha' };
  const b = { ...session('b'), agent: 'hermes' as const, title: 'Fix tests', project: 'beta' };
  assert.deepEqual(filterSessions([a, b], 'alpha parser', 'all').map(s => s.id), ['a']);
  assert.deepEqual(filterSessions([a, b], 'fix', 'hermes').map(s => s.id), ['b']);
});

for (const columns of [80, 120, 160]) {
  test(`trace browser fits a ${columns}×24 terminal and exposes working action controls`, async () => {
    let inspected = '';
    let exported = '';
    const sessions = [session('alpha'), session('beta')];
    const ui = harness(columns, {
      onScan: async emit => { sessions.forEach(emit); return result(sessions); },
      onInspect: async selected => {
        inspected = selected.id;
        return { session: selected, events: [{ id: '1', kind: 'message', role: 'user', text: '    code indentation is preserved', timestamp: null, source: { line: 1 } }], warnings: [], truncated: false };
      },
      onExport: async selected => { exported = selected.id; return '/tmp/export.json'; },
    });
    try {
      await eventually(() => ui.frame().includes('2 traces') && ui.frame().includes('Trace alpha'));
      const frame = ui.frame();
      assert.ok(frame.includes('LOCAL ONLY'));
      assert.ok(frame.includes('Inspect') && frame.includes('Export'));
      assert.ok(frame.split('\n').length <= 25, frame);
      assert.ok(frame.split('\n').every(line => stringWidth(line) <= columns), frame);
      if (columns === 160) assert.ok(frame.includes('A useful local preview'));
      await delay(40);
      ui.stdin.write('j');
      await eventually(() => ui.frame().split('\n').some(line => line.includes('›') && line.includes('Trace beta')));
      ui.stdin.write('\r');
      await eventually(() => inspected === 'beta' && ui.frame().includes('TRACE INSPECTOR'));
      await eventually(() => ui.frame().includes('    code indentation is preserved'));
      ui.stdin.write('e');
      await eventually(() => exported === 'beta' && ui.frame().includes('Saved'));
      ui.stdin.write('q');
      await eventually(() => ui.frame().includes('LOCAL TRACES'));
      ui.stdin.write('d');
      await eventually(() => ui.frame().includes('SOURCE DIAGNOSTICS') && ui.frame().includes('No source directory found'));
      ui.stdin.write('q');
      await eventually(() => ui.frame().includes('LOCAL TRACES'));
      ui.stdin.write('/');
      await eventually(() => ui.frame().includes('Type to filter'));
      ui.stdin.write('trace beta');
      await eventually(() => ui.frame().includes('1/1 matches') && !ui.frame().includes('Trace alpha'));
      ui.stdin.write('\r');
      await delay(20);
      ui.stdin.write('f');
      await eventually(() => ui.frame().includes('No matching traces'));
    } finally { ui.app.unmount(); await ui.app.waitUntilExit(); }
  });
}

test('streamed discovery preserves selected trace identity when newer results arrive', async () => {
  let emit: ((s: Session) => void) | undefined;
  let complete: ((scan: ScanResult) => void) | undefined;
  let inspected = '';
  const older = session('older');
  const newer = session('newer', '2026-10-06T12:00:00Z');
  const ui = harness(100, {
    onScan: async onSession => { emit = onSession; onSession(older); return new Promise(resolve => { complete = resolve; }); },
    onInspect: async selected => { inspected = selected.id; return { session: selected, events: [], warnings: [], truncated: false }; },
    onExport: async () => '/tmp/export.json',
  });
  try {
    await eventually(() => ui.frame().includes('Trace older'));
    emit!(newer);
    await eventually(() => ui.frame().includes('Trace newer'));
    complete!(result([older, newer]));
    await eventually(() => ui.frame().includes('2 traces'));
    ui.stdin.write('\r');
    await eventually(() => inspected.length > 0);
    assert.equal(inspected, 'older');
  } finally { ui.app.unmount(); await ui.app.waitUntilExit(); }
});
