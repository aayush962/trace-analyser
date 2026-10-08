#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import os from 'node:os';
import path from 'node:path';
import { adapters, cachePath, clearCache, context, discover, importFile, inspect, type DiscoveryOptions } from './core/discovery.js';
import { exportTranscript } from './core/package.js';
import { safeText, singleLine } from './core/safe.js';
import type { ScanResult, Session, Transcript } from './core/types.js';
import { cell, clip } from './ui/format.js';
import { normalizeTranscript } from './core/normalize.js';
import { readSnapshot } from './core/reading.js';
import { demoTraces, scanDemo } from './demo.js';

const program = new Command();
// Commander parses duplicated global flags on the parent. Carry only explicitly
// supplied values into subcommands, preserving each subcommand's own defaults.
program.hook('preAction', (_command, action) => {
  if (action === program) return;
  for (const [key, value] of Object.entries(program.opts())) {
    if (program.getOptionValueSource(key) === 'cli') action.setOptionValueWithSource(key, value, 'cli');
  }
});
const controller = new AbortController();
process.once('SIGINT', () => { controller.abort(); process.exitCode = 130; });
const integer = (value: string): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 100_000) throw new InvalidArgumentError('Use an integer between 1 and 100000.');
  return n;
};
const agent = (value: string) => {
  const id = value === 'claude' ? 'claude-code' : value;
  if (!adapters.some(a => a.manifest.id === id)) throw new InvalidArgumentError(`Supported sources: ${adapters.map(a => a.manifest.id).join(', ')}`);
  return id;
};
function common(command: Command): Command {
  return command.option('--agent <name>', 'filter source (claude-code, codex, cursor, hermes, generic)', agent)
    .option('--root <path...>', 'read explicit roots instead of the default stores')
    .option('--recursive', 'recurse through an explicit root (native stores always recurse)')
    .option('--include-archived', 'include archived sessions').option('--include-children', 'include child/subagent sessions')
    .option('--include-empty', 'show sessions with confirmed empty captures')
    .option('--timeout <seconds>', 'discovery time budget', integer, 30).option('--max-files <count>', 'file budget', integer, 100_000)
    .option('--no-cache', 'do not read or write the metadata index').option('--json', 'emit structured JSON')
    .option('--plain', 'line-oriented output instead of the interactive browser').option('--no-color', 'disable color')
    .option('--no-motion', 'disable terminal animations');
}
function options(raw: any): DiscoveryOptions { return { ...raw, roots: raw.root, signal: controller.signal }; }
function outputJson(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
function sinceTime(value: string | undefined): number {
  if (!value) return 0;
  const match = /^(\d+)([hdw])$/.exec(value);
  const time = match ? Date.now() - Number(match[1]) * ({ h: 3600, d: 86400, w: 604800 }[match[2]!]!) * 1000 : Date.parse(value);
  if (!Number.isFinite(time)) throw new InvalidArgumentError('--since expects a date or a duration such as 24h, 7d, 2w.');
  return time;
}
function filter(sessions: Session[], raw: any): Session[] {
  const since = sinceTime(raw.since);
  const terms = (raw.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter(s => (!raw.agent || s.agent === raw.agent) && (!raw.project || (s.project ?? s.cwd ?? '').toLowerCase().includes(raw.project.toLowerCase()))
    && (!since || Date.parse(s.updatedAt ?? s.startedAt ?? '') >= since)
    && terms.every((q: string) => [s.title, s.project, s.preview, s.nativeId, s.agent].join(' ').toLowerCase().includes(q)));
}
function printList(result: ScanResult, raw: any) {
  const all = filter(result.sessions, raw);
  const shown = all.slice(0, raw.limit ?? 50);
  if (raw.json) outputJson({ ...result, sessions: shown, matchedCount: all.length, displayedCount: shown.length });
  else {
    process.stdout.write('TRACE READER  /  local sessions\n\n');
    const width = Math.max(68, Math.min(160, process.stdout.columns ?? 120));
    const titleWidth = width - 58;
    process.stdout.write(`${cell('ID', 18)}${cell('SOURCE', 13)}${cell('TITLE', titleWidth)}${cell('PROJECT', 20)}MSGS\n`);
    for (const s of shown) process.stdout.write(`${cell(s.id, 18)}${cell(s.agent, 13)}${cell(s.title, titleWidth)}${cell(s.project ?? '—', 20)}${s.messages ?? '…'}\n`);
    if (!shown.length) process.stdout.write('No saved sessions found in the folders checked. Try scan --root PATH --recursive or import FILE.\n');
    process.stdout.write(`\n${shown.length} of ${all.length} sessions · ${result.scan.rootsChecked} roots · ${(result.scan.durationMs / 1000).toFixed(1)}s · ${result.scan.complete ? 'scan complete' : 'partial scan'}\n`);
    if (result.scan.emptyHidden) process.stdout.write(`${result.scan.emptyHidden} empty sessions hidden · --include-empty to show\n`);
    if (!result.scan.complete) process.stderr.write(`Discovery: ${singleLine(result.scan.stopReason)}. Run doctor for details.\n`);
  }
  if (!result.scan.complete) process.exitCode = controller.signal.aborted ? 130 : 4;
}
function printTranscript(trace: Transcript, raw: any) {
  if (raw.json) outputJson({ schemaVersion: 'trace-reader-cli/1', ...trace });
  else {
    const s = trace.session;
    process.stdout.write(`${safeText(s.title)}\n${s.agent} · ${s.evidence} · ${s.messages ?? 'unknown'} messages\n`);
    process.stdout.write(`Source: ${safeText(s.locator.path)}\nProject: ${safeText(s.cwd ?? 'Unknown')}\nTime: ${s.updatedAt ?? 'Unknown'} (${s.timeSource})\n`);
    for (const warning of [...new Set([...s.warnings, ...trace.warnings])]) process.stdout.write(`! ${safeText(warning)}\n`);
    const events = trace.events.filter(e => e.kind !== 'metadata').slice(0, raw.limit ?? 40);
    for (const e of events) process.stdout.write(`\n${singleLine(e.role ?? e.kind).toUpperCase()}${e.source.line ? ` · line ${e.source.line}` : ''}\n${safeText(e.text).slice(0, 2000)}\n`);
    if (trace.events.length > events.length) process.stdout.write('\nPreview is bounded. Use --json or export for the available event data.\n');
  }
  if (trace.truncated) process.exitCode = 4;
}
async function selectSession(id: string, raw: any): Promise<Session> {
  const result = await discover({ ...options(raw), includeArchived: true, includeChildren: true, includeEmpty: true });
  const found = result.sessions.filter(s => s.id.startsWith(id) || s.nativeId === id);
  if (found.length > 1) throw new Error('Ambiguous session ID. Use the full local ID from list.');
  if (!found.length) throw new Error(`Session not found: ${singleLine(id)}${!result.scan.complete ? ' (discovery was incomplete; run doctor)' : ''}`);
  return found[0]!;
}
async function launch(raw: any) {
  const demo = raw.demo ? demoTraces() : null;
  if (!process.stdin.isTTY || !process.stdout.isTTY || raw.plain || raw.json) { printList(demo ? await scanDemo(demo, () => {}, controller.signal) : await discover(options(raw)), raw); return; }
  if (raw.color === false) process.env.NO_COLOR = '1';
  const [{ render }, { App }] = await Promise.all([import('ink'), import('./ui/App.js')]);
  let activeSignal = controller.signal;
  const onScan = (emit: (s: Session) => void, signal: AbortSignal) => { activeSignal = signal; return demo ? scanDemo(demo, emit, signal) : discover({ ...options(raw), signal }, emit); };
  const onInspect = (s: Session) => demo ? Promise.resolve(demo.find(t => t.session.id === s.id)!) : inspect(s, { ...options(raw), signal: activeSignal });
  const onExport = async (s: Session) => exportTranscript(await onInspect(s), path.resolve(`trace-${s.id}-${Date.now()}.trace.json`), os.homedir());
  const app = render(<App onScan={onScan} onInspect={onInspect} onExport={onExport} initialAgent={raw.agent} demo={!!demo}
    reducedMotion={raw.motion === false || process.env.TRACE_READER_REDUCED_MOTION === '1' || process.env.TERM === 'dumb' || !!process.env.CI} />,
    { alternateScreen: true, incrementalRendering: true, maxFps: 20, exitOnCtrlC: false });
  await app.waitUntilExit();
}

program.name('trace-reader').description('Find and read saved agent sessions. Local, offline, no account required.').version('0.1.0');
common(program).action(launch);
common(program.command('demo').description('Explore a synthetic session library; no local stores or AI accessed'))
  .action(raw => launch({ ...raw, demo: true }));
common(program.command('list').description('List saved sessions'))
  .option('--limit <count>', 'maximum output rows', integer, 50).option('--since <date-or-duration>', 'updated since 7d, 24h, or an ISO date')
  .option('--project <text>', 'filter project name').action(async raw => printList(await discover(options(raw)), raw));
common(program.command('scan').description('Discover traces inside an explicit folder or file'))
  .option('--limit <count>', 'maximum output rows', integer, 50).action(async raw => {
    if (!raw.root?.length) throw new InvalidArgumentError('scan requires --root PATH.');
    printList(await discover(options(raw)), raw);
  });
common(program.command('search <query>').description('Search session titles and project metadata'))
  .option('--limit <count>', 'maximum output rows', integer, 50).action(async (query, raw) => printList(await discover(options(raw)), { ...raw, query }));
common(program.command('inspect <id>').description('Read a local session and its coverage warnings'))
  .option('--limit <count>', 'maximum preview events', integer, 40).action(async (id, raw) => printTranscript(await inspect(await selectSession(id, raw), options(raw)), raw));
common(program.command('read [id]').description('Generate an evidence-linked local reading without an AI request'))
  .option('--file <path>', 'read an explicit trace file instead of a local ID')
  .action(async (id, raw) => {
    if (Boolean(id) === Boolean(raw.file)) throw new InvalidArgumentError('Provide exactly one session ID or --file PATH.');
    const trace = raw.file ? await importFile(raw.file, options(raw)) : await inspect(await selectSession(id, raw), options(raw));
    const snapshot = normalizeTranscript(trace), reading = readSnapshot(snapshot);
    if (raw.json) outputJson({ schemaVersion: 'trace-reader-reading/1', mode: 'local-rules', sessionId: trace.session.id,
      partial: trace.truncated, warnings: trace.warnings, coverage: snapshot.capture.coverage, reading, evidence: snapshot.events.map(e => ({ id: e.id, source: trace.events[e.sequence].source })) });
    else {
      process.stdout.write(`${singleLine(trace.session.title)}\nLocal observations · no model request\n\n${reading.messages} message events · ${reading.tools} tools · ${reading.errors} reported errors\n`);
      for (const finding of reading.observations) process.stdout.write(`\n${singleLine(finding.title)}\n${singleLine(finding.detail)}\nEvidence: ${finding.eventIds.join(', ')}\n`);
      if (!reading.observations.length) process.stdout.write('\nNo matching patterns in the retained events. This does not establish success.\n');
      if (trace.truncated) process.stdout.write('\nPartial capture. Inspect the source diagnostics for omissions.\n');
    }
    if (trace.truncated) process.exitCode = 4;
  });
program.command('import <file>').description('Preview a selected trace file; nothing is uploaded')
  .option('--json', 'emit full parsed data').option('--limit <count>', 'maximum preview events', integer, 40)
  .action(async (file, raw) => { try { printTranscript(await importFile(file, options(raw)), raw); } catch (e) { process.exitCode = 3; throw e; } });
common(program.command('export [id]').description('Export a selected session to a sanitized .trace.json file'))
  .option('--file <path>', 'read an explicit trace file instead of a local ID').requiredOption('--out <path>', 'output .trace.json path')
  .option('--force', 'replace an existing output file').action(async (id, raw) => {
    if (Boolean(id) === Boolean(raw.file)) throw new InvalidArgumentError('Provide exactly one session ID or --file PATH.');
    const trace = raw.file ? await importFile(raw.file, options(raw)) : await inspect(await selectSession(id, raw), options(raw));
    const out = await exportTranscript(trace, path.resolve(raw.out), os.homedir(), raw.force);
    if (raw.json) outputJson({ schemaVersion: 'trace-reader-cli/1', path: out, truncated: trace.truncated });
    else process.stdout.write(`Saved ${safeText(out)}\nKnown secret patterns removed; review before sharing.${trace.truncated ? '\nExport is partial; source limits are recorded in the file.' : ''}\n`);
    if (trace.truncated) process.exitCode = 4;
  });
common(program.command('doctor').description('Check store paths, permissions and parser support'))
  .action(async raw => {
    const result = await discover(options(raw));
    if (raw.json) outputJson({ schemaVersion: result.schemaVersion, scan: result.scan, diagnostics: result.diagnostics });
    else for (const d of result.diagnostics) process.stdout.write(`${d.level === 'info' ? '·' : '!'} ${d.agent}  ${safeText(d.path)}\n  ${safeText(d.message)}\n`);
    if (!result.scan.complete) process.exitCode = 4;
  });
program.command('adapters').description('Show implemented formats and their limitations').option('--json').action(raw => {
  if (raw.json) outputJson({ schemaVersion: 'trace-reader-cli/1', adapters: adapters.map(a => a.manifest) });
  else for (const { manifest: m } of adapters) process.stdout.write(`${m.name} [${m.status}]\n  ${m.formats.join(', ')}\n  ${m.limitations}\n\n`);
});
program.command('roots').description('Show native store locations').option('--json').action(async raw => {
  const ctx = context();
  const roots = (await Promise.all(adapters.map(a => a.roots(ctx)))).flat();
  if (raw.json) outputJson({ schemaVersion: 'trace-reader-cli/1', roots });
  else for (const root of roots) process.stdout.write(`${root.agent}  ${root.provenance}  ${safeText(root.path)}\n`);
});
program.command('cache <action>').description('Show or clear the local metadata index (path|clear)').action(async action => {
  if (action === 'path') process.stdout.write(cachePath() + '\n');
  else if (action === 'clear') { await clearCache(); process.stdout.write('Trace reader metadata cache cleared.\n'); }
  else throw new InvalidArgumentError('Use cache path or cache clear.');
});
try { await program.parseAsync(); }
catch (error) {
  process.stderr.write(`trace-reader: ${singleLine(error instanceof Error ? error.message : error)}\n`);
  if (!process.exitCode) process.exitCode = error instanceof InvalidArgumentError ? 2 : 1;
}
