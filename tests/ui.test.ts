import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { render, Text } from 'ink';
import stringWidth from 'string-width';
import { safeText } from '../src/core/safe.js';
import type { ScanResult, Session } from '../src/core/types.js';
import { App, type AppProps } from '../src/ui/App.js';
import { cell, clip, clipLine, filterSessions, windowCells, wrap } from '../src/ui/format.js';
import { Marquee } from '../src/ui/motion.js';
import { demoTraces, scanDemo } from '../src/demo.js';

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
  // Ink emits a frame before passive effects attach a newly mounted panel's input handler.
  for (let i = 0; i < 100; i++) { if (check()) { await delay(20); return; } await delay(10); }
  assert.fail('UI did not reach expected state');
}
function harness(columns: number, props: AppProps, rows = 24) {
  const frames: string[] = [];
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) {
    const frame = safeText(chunk.toString());
    if (frame.includes('TRACE READER')) frames.push(frame);
    callback();
  } }), { columns, rows, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; }, ref() {}, unref() {} });
  const app = render(createElement(App, props), { stdin, stdout, stderr: stdout, debug: true, interactive: true, patchConsole: false, kittyKeyboard: { mode: 'disabled' } });
  return { app, stdin, stdout, frames, frame: () => frames.at(-1) ?? '' };
}

test('terminal formatting strips executable controls and preserves graphemes within cell width', () => {
  assert.equal(clip('\x1b]52;c;payload\x07Hello\x1b[31m!', 20), 'Hello!');
  assert.equal(clip('你好世界', 5), '你好…');
  assert.equal(stringWidth(cell('👩‍💻 trace', 8)), 8);
  assert.equal(clipLine('    const x = 1;', 80), '    const x = 1;');
  assert.deepEqual(wrap('  alpha\nbeta', 6), ['  alph', 'a', 'beta']);
  assert.equal(windowCells('a你好👩‍💻éz', 2, 6), ' 好👩‍💻é');
  assert.equal(windowCells('👩‍💻hello', 0, 1), ' ');
  assert.equal(windowCells('\x1b]52;c;payload\x07abc', 1, 4), 'bc  ');
});

test('inline actions stay aligned, run against the selected row, and reset when moving', async () => {
  const sessions = [session('newest', '2026-10-07T12:00:00Z'), session('older')];
  const exports: string[] = [], inspections: string[] = [];
  const ui = harness(120, { reducedMotion: true,
    onScan: async () => result(sessions),
    onInspect: async selected => { inspections.push(selected.id); return { session: selected, events: [], warnings: [], truncated: false }; },
    onExport: async selected => { exports.push(selected.id); return '/tmp/selected.trace.json'; },
  }, 32);
  const selectedRow = () => ui.frame().split('\n').find(line => line.startsWith('  › ')) ?? '';
  try {
    await eventually(() => ui.frame().includes('2 traces'));
    const rows = ui.frame().split('\n').filter(line => /Trace (newest|older)/.test(line) && line.includes('Export'));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].indexOf('Export'), rows[1].indexOf('Export'));
    assert.ok(rows.every(row => /Inspect\s+Export\s+Details\s*$/.test(row)));
    ui.stdin.write('\x1b[C\x1b[C');
    await eventually(() => selectedRow().includes('›Details'));
    ui.stdin.write('\x1b[D');
    await eventually(() => selectedRow().includes('›Export'));
    ui.stdin.write('\r');
    await eventually(() => ui.frame().includes('Saved'));
    assert.deepEqual(exports, ['newest']);
    assert.deepEqual(inspections, []);
    ui.stdin.write('\t');
    await eventually(() => selectedRow().includes('›Details'));
    ui.stdin.write('\r');
    await eventually(() => ui.frame().includes('Source /tmp/newest.jsonl'));
    assert.ok(ui.frame().includes('LOCAL TRACES'));
    ui.stdin.write('\x1b[Z');
    await eventually(() => selectedRow().includes('›Export'));
    ui.stdin.write('\x1b[B');
    await eventually(() => selectedRow().includes('Trace older') && selectedRow().includes('›Inspect'));
    ui.stdin.write('s');
    await eventually(() => ui.frame().includes('Oldest ↑'));
    assert.ok(ui.frame().indexOf('Trace older') < ui.frame().indexOf('Trace newest'));
    assert.ok(selectedRow().includes('Trace older'), 'sorting preserves selection by identity');
    ui.stdin.write('/'); await delay(30);
    ui.stdin.write('newest');
    await eventually(() => ui.frame().includes('1/1 matches'));
    assert.deepEqual(exports, ['newest'], 'search text must not trigger shortcuts');
    ui.stdin.write('\r'); await delay(30);
    ui.stdin.write('o');
    await eventually(() => inspections.length === 1);
    assert.deepEqual(inspections, ['newest']);
  } finally { ui.app.unmount(); await ui.app.waitUntilExit(); }
});

test('library resizes, pages a large result set, and keeps all row actions usable', async () => {
  const sessions = Array.from({ length: 600 }, (_, index) => session(`session-${String(index).padStart(3, '0')}`));
  const ui = harness(160, { reducedMotion: true,
    onScan: async () => result(sessions),
    onInspect: async selected => ({ session: selected, events: [], warnings: [], truncated: false }),
    onExport: async () => '/tmp/export.json',
  }, 36);
  const fits = () => {
    assert.ok(ui.frame().split('\n').length <= ui.stdout.rows + 1, ui.frame());
    assert.ok(ui.frame().split('\n').every(line => stringWidth(line) <= ui.stdout.columns), ui.frame());
  };
  try {
    await eventually(() => ui.frame().includes('600 traces'));
    ui.stdin.write('\x1b[B\x1b[B\x1b[B');
    await eventually(() => ui.frame().includes('4/600'));
    ui.stdin.write('g');
    await eventually(() => ui.frame().includes('1/600'));
    for (const [columns, rows] of [[48, 12], [60, 20], [80, 24], [100, 28], [120, 32], [160, 36]]) {
      ui.stdout.columns = columns; ui.stdout.rows = rows; ui.stdout.emit('resize');
      await delay(60); fits();
      assert.ok(ui.frame().includes('Inspect') && ui.frame().includes('Export'));
      assert.ok(ui.frame().includes(columns < 101 ? 'Info' : 'Details'), ui.frame());
      ui.stdin.write(' '); await delay(40); fits();
      assert.ok(ui.frame().includes('/tmp/session-000.jsonl'), ui.frame());
      ui.stdin.write(' '); await delay(30);
    }
    ui.stdin.write('G');
    await eventually(() => ui.frame().includes('600/600'));
    assert.ok(ui.frame().includes('Trace session-599') && ui.frame().includes('┃'));
    assert.ok(!ui.frame().includes('Trace session-000'), 'off-screen rows are not rendered');
    ui.stdin.write('\x1b[5~'); await delay(40);
    assert.ok(!ui.frame().includes('600/600'));
    ui.stdin.write('g');
    await eventually(() => ui.frame().includes('1/600') && ui.frame().includes('Trace session-000'));
  } finally { ui.app.unmount(); await ui.app.waitUntilExit(); }
});

test('selected-title marquee pauses, pans within fixed cells, returns, and rests; reduced motion stays still', async () => {
  const frames: string[] = [];
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) { frames.push(safeText(chunk.toString()).trimEnd()); callback(); } }), { columns: 80, rows: 10, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; }, ref() {}, unref() {} });
  const view = (reduced: boolean) => createElement(Text, {}, '[', createElement(Marquee, { text: 'abcdefghijkl', width: 8, active: true, reduced }), '] Export');
  const app = render(view(false), { stdin, stdout, stderr: stdout, debug: true, interactive: true, patchConsole: false, kittyKeyboard: { mode: 'disabled' } });
  try {
    await delay(150);
    const first = frames.at(-1)!;
    assert.equal(first, '[abcdefg…] Export');
    await delay(400); assert.equal(frames.at(-1), first, 'title initially pauses');
    await delay(850); assert.notEqual(frames.at(-1), first, 'overflow becomes readable');
    assert.ok(frames.every(frame => stringWidth(frame) === stringWidth(first)), 'action column never moves');
    await delay(2200); assert.equal(frames.at(-1), first, 'returns to the beginning');
    const count = frames.length;
    await delay(250); assert.equal(frames.length, count, 'idle title has no perpetual animation');
    app.rerender(view(true)); await delay(100);
    const quiet = frames.length;
    await delay(1250); assert.equal(frames.length, quiet, 'reduced motion never starts a timer');
  } finally { app.unmount(); await app.waitUntilExit(); }
});

for (const columns of [80, 120, 160]) {
  test(`reading, evidence, palette and resize work at ${columns} columns`, async () => {
    const traces = demoTraces();
    let exports = 0;
    const ui = harness(columns, { demo: true, reducedMotion: true,
      onScan: (emit, signal) => scanDemo(traces, emit, signal),
      onInspect: async s => traces.find(t => t.session.id === s.id)!,
      onExport: async () => { exports++; return '/tmp/demo.trace.json'; },
    });
    const fits = () => {
      assert.ok(ui.frame().split('\n').length <= ui.stdout.rows + 1, ui.frame());
      assert.ok(ui.frame().split('\n').every(line => stringWidth(line) <= ui.stdout.columns), ui.frame());
    };
    try {
      await eventually(() => ui.frame().includes('4 traces'));
      fits(); ui.stdin.write('\r');
      await eventually(() => ui.frame().includes('Bash reported an error'));
      fits(); ui.stdin.write('\r');
      await eventually(() => ui.frame().includes('Expected: 200'));
      assert.ok(ui.frame().includes('line 6'), ui.frame());
      fits(); ui.stdin.write(']');
      await eventually(() => ui.frame().includes('npm test -- checkout') && ui.frame().includes('line 5'));
      ui.stdin.write('/');
      await eventually(() => ui.frame().includes('/ ▏'));
      ui.stdin.write('expired');
      await eventually(() => ui.frame().includes('/ expired'));
      assert.equal(exports, 0, 'Typing e in search must not export');
      ui.stdin.write('\r'); await delay(30);
      ui.stdin.write('\x10');
      await eventually(() => ui.frame().includes('COMMAND PALETTE'));
      ui.stdin.write('\x1b');
      await eventually(() => ui.frame().includes('/ expired') && ui.frame().includes('Context') === false);
      ui.stdin.write('\x10');
      await eventually(() => ui.frame().includes('COMMAND PALETTE'));
      fits(); ui.stdin.write('diagnostics');
      await eventually(() => ui.frame().includes('Source diagnostics') && !ui.frame().includes('Refresh discovery'));
      ui.stdin.write('\r');
      await eventually(() => ui.frame().includes('SOURCE DIAGNOSTICS'));
      ui.stdout.columns = 48; ui.stdout.rows = 12; ui.stdout.emit('resize');
      await delay(60); fits();
    } finally { ui.app.unmount(); await ui.app.waitUntilExit(); }
  });
}

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
      await eventually(() => ui.frame().includes('OBSERVATIONS'));
      ui.stdin.write('2');
      await eventually(() => ui.frame().includes('Context hidden') && ui.frame().includes('    code indentation is preserved'));
      ui.stdin.write('e');
      await eventually(() => exported === 'beta' && ui.frame().includes('Saved'));
      ui.stdin.write('q');
      await eventually(() => ui.frame().includes('OBSERVATIONS'));
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

test('refresh keeps the chosen trace when its row arrives after other streamed results', async () => {
  const older = session('older'), newer = session('newer', '2026-10-06T12:00:00Z');
  let scans = 0, inspected = '';
  let finish: (() => void) | undefined;
  const ui = harness(100, { reducedMotion: true,
    onScan: async emit => {
      if (scans++ === 0) return result([older, newer]);
      emit(newer);
      return new Promise(resolve => { finish = () => { emit(older); resolve(result([newer, older])); }; });
    },
    onInspect: async selected => { inspected = selected.id; return { session: selected, events: [], warnings: [], truncated: false }; },
    onExport: async () => '/tmp/export.json',
  });
  try {
    await eventually(() => ui.frame().includes('2 traces'));
    ui.stdin.write('j');
    await eventually(() => ui.frame().split('\n').some(line => line.startsWith('  › ') && line.includes('Trace older')));
    ui.stdin.write('r');
    await eventually(() => ui.frame().includes('1 found') && !ui.frame().includes('Trace older'));
    finish!();
    await eventually(() => ui.frame().includes('2 traces'));
    ui.stdin.write('\r');
    await eventually(() => inspected.length > 0);
    assert.equal(inspected, 'older');
  } finally { ui.app.unmount(); await ui.app.waitUntilExit(); }
});

test('empty sessions are hidden by default and can be revealed without rescanning; unknown captures stay visible', async () => {
  const empty = { ...session('empty'), activity: 'empty' as const, messages: 0, toolCalls: 0 };
  const unknown = { ...session('unknown'), activity: 'unknown' as const, messages: null, toolCalls: null };
  const sessions = [empty, unknown, session('active')];
  let scans = 0;
  const props: AppProps = { reducedMotion: true,
    onScan: async emit => { scans++; sessions.forEach(emit); return result(sessions); },
    onInspect: async selected => ({ session: selected, events: [], warnings: [], truncated: false }),
    onExport: async () => '/tmp/export.json',
  };
  const ui = harness(120, props);
  try {
    await eventually(() => ui.frame().includes('2 traces') && ui.frame().includes('1 empty hidden · v show'));
    assert.ok(ui.frame().includes('Trace unknown'));
    assert.ok(!ui.frame().includes('Trace empty'));
    ui.stdin.write('v');
    await eventually(() => ui.frame().includes('[empty] Trace empty') && ui.frame().includes('3 traces'));
    assert.ok(ui.frame().includes('1 empty shown · v hide'));
    ui.stdin.write('v');
    await eventually(() => !ui.frame().includes('Trace empty') && ui.frame().includes('2 traces'));
    assert.equal(scans, 1);
  } finally { ui.app.unmount(); await ui.app.waitUntilExit(); }
  const included = harness(120, { ...props, initialIncludeEmpty: true });
  try { await eventually(() => included.frame().includes('[empty] Trace empty')); }
  finally { included.app.unmount(); await included.app.waitUntilExit(); }
});
