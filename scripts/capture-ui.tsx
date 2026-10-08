import { PassThrough, Writable } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { render } from 'ink';
import React from 'react';
import { App } from '../src/ui/App.js';
import { demoLibraryTraces, scanDemo } from '../src/demo.js';
import { safeText } from '../src/core/safe.js';

const columns = Number(process.env.COLUMNS ?? 120), rows = Number(process.env.LINES ?? 32);
let frame = '';
const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) {
  if (chunk.toString().includes('TRACE READER')) frame = chunk.toString();
  callback();
} }), { columns, rows, isTTY: true });
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; }, ref() {}, unref() {} });
const traces = demoLibraryTraces();
const app = render(<App demo reducedMotion onScan={(emit, signal) => scanDemo(traces, emit, signal)}
  onInspect={async s => traces.find(t => t.session.id === s.id)!} onExport={async () => '/tmp/synthetic-preview.trace.json'} />,
{ stdin, stdout, stderr: stdout, debug: true, interactive: true, patchConsole: false, kittyKeyboard: { mode: 'disabled' } });
await delay(1500);
for (const key of process.argv.slice(2)) {
  stdin.write(({ enter: '\r', esc: '\x1b', palette: '\x10', down: '\x1b[B' } as Record<string, string>)[key] ?? key);
  await delay(150);
}
writeFileSync('/tmp/trace-reader-ui.ansi', frame);
process.stdout.write(safeText(frame));
app.unmount();
await app.waitUntilExit();
