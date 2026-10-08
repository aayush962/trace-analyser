import os from 'node:os';
import { isEmptySession } from './activity.js';
import path from 'node:path';
import { stat, realpath, open, readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { claudeAdapter, codexAdapter } from '../adapters/files.js';
import { cursorAdapter, hermesAdapter } from '../adapters/databases.js';
import { genericAdapter, importGeneric } from '../adapters/generic.js';
import { checkBudget, diagnostic, walkFiles } from './io.js';
import type { Adapter, Agent, Root, ScanContext, ScanResult, Session, Transcript } from './types.js';

export const adapters: Adapter[] = [claudeAdapter, codexAdapter, cursorAdapter, hermesAdapter, genericAdapter];
export interface DiscoveryOptions {
  roots?: string[]; agent?: string; includeArchived?: boolean; includeChildren?: boolean; includeEmpty?: boolean;
  maxFiles?: number; maxDepth?: number; timeout?: number; cache?: boolean; recursive?: boolean;
  home?: string; env?: Record<string, string | undefined>; signal?: AbortSignal;
}
export function context(options: DiscoveryOptions = {}): ScanContext {
  const env = options.env ?? process.env;
  return { home: options.home ?? os.homedir(), platform: process.platform,
    env: Object.fromEntries(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME', 'LOCALAPPDATA', 'APPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'].map(key => [key, env[key]])),
    signal: options.signal ?? new AbortController().signal, deadline: Date.now() + (options.timeout ?? 30) * 1000,
    maxFiles: options.maxFiles ?? 100_000, maxDepth: options.maxDepth ?? 10,
    maxFileBytes: 32 * 1024 * 1024, maxRecordBytes: 4 * 1024 * 1024, maxEvents: 30_000,
    scanned: 0, skipped: 0, diagnostics: [] };
}
export function cachePath(): string {
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches')
    : process.platform === 'win32' ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'trace-reader', 'index-v1.json');
}
export async function clearCache(): Promise<void> { await unlink(cachePath()).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
function visible(s: Session, options: DiscoveryOptions): boolean {
  return (!options.agent || s.agent === options.agent) && (options.includeArchived === true || !s.archived)
    && (options.includeChildren === true || !s.parentId) && (options.includeEmpty === true || !isEmptySession(s));
}
async function detectedAdapter(file: string): Promise<Adapter | undefined> {
  if (file.endsWith('.trace.json')) return genericAdapter;
  if (file.endsWith('state.db')) return hermesAdapter;
  if (file.endsWith('state.vscdb')) return cursorAdapter;
  if (/agent-transcripts[\\/]/.test(file) && /\.(jsonl|txt)$/.test(file)) return cursorAdapter;
  if (!/\.jsonl$/.test(file)) return undefined;
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 12);
    for (const line of lines) {
      let record; try { record = JSON.parse(line); } catch { continue; }
      if (record?.type === 'session_meta' && record.payload?.id) return codexAdapter;
      if (record?.sessionId && ['user', 'assistant', 'system', 'summary', 'progress'].includes(record.type)) return claudeAdapter;
    }
  } finally { await handle.close(); }
  return undefined;
}
export async function discover(options: DiscoveryOptions = {}, onSession?: (session: Session) => void): Promise<ScanResult> {
  const start = Date.now(), ctx = context(options);
  const sessions = new Map<string, Session>();
  let rootsChecked = 0;
  const cacheEnabled = options.cache !== false && !options.roots?.length && !options.home;
  // The index provides immediate previous rows. The fresh scan always reconciles deletions.
  if (cacheEnabled && onSession) {
    try {
      const info = await stat(cachePath());
      if (info.size < 8 * 1024 * 1024) {
        const cached = JSON.parse(await readFile(cachePath(), 'utf8'));
        if (cached.version === 2 && Array.isArray(cached.sessions)) for (const s of cached.sessions) {
          if (s && typeof s.id === 'string' && typeof s.title === 'string' && s.locator && visible(s, options)) onSession({ ...s, warnings: [...(s.warnings ?? []), 'Cached metadata; checking source…'] });
        }
      }
    } catch { /* An index is optional and always replaceable. */ }
  }
  const add = (s: Session) => { sessions.set(s.id, s); if (visible(s, options)) onSession?.(s); };
  const scanRoot = async (adapter: Adapter, root: Root) => {
    if (!checkBudget(ctx)) return;
    rootsChecked++;
    try {
      const info = await stat(root.path).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (!info) { diagnostic(ctx, adapter.manifest.id, root.path, 'Store not present', root.provenance === 'explicit' ? 'error' : 'info'); return; }
      const canonical = await realpath(root.path);
      const before = sessions.size;
      for await (const s of adapter.discover({ ...root, path: canonical }, ctx)) add(s);
      diagnostic(ctx, adapter.manifest.id, canonical, `${sessions.size - before} sessions found · ${root.provenance}`, 'info');
    } catch (e) { diagnostic(ctx, adapter.manifest.id, root.path, (e as Error).message, 'error'); }
  };
  if (options.roots?.length) {
    for (const input of options.roots) {
      const file = path.resolve(input.replace(/^~(?=$|[\\/])/, ctx.home));
      if (options.agent) {
        const adapter = adapters.find(a => a.manifest.id === options.agent);
        if (adapter) await scanRoot(adapter, { path: file, agent: adapter.manifest.id, provenance: 'explicit' });
        continue;
      }
      let unknown = 0;
      if (!(await stat(file).catch(() => null))) { diagnostic(ctx, 'generic', file, 'Explicit root is not accessible', 'error'); continue; }
      const priorDepth = ctx.maxDepth;
      ctx.maxDepth = options.recursive ? priorDepth : 0;
      for await (const candidate of walkFiles(file, ctx, p => /\.(jsonl|json|txt|db|vscdb)$/.test(p))) {
        try {
          const adapter = await detectedAdapter(candidate);
          if (adapter) {
            // The adapter reopens this same candidate, so count its file once.
            ctx.scanned--;
            await scanRoot(adapter, { path: candidate, agent: adapter.manifest.id, provenance: 'explicit' });
          }
          else unknown++;
        } catch (e) { diagnostic(ctx, 'generic', candidate, (e as Error).message); }
      }
      ctx.maxDepth = priorDepth;
      if (unknown) diagnostic(ctx, 'generic', file, `${unknown} files had no recognized trace format; use import for a role/content JSON conversation.`, 'info');
    }
  } else {
    const selected = adapters.filter(a => !options.agent || a.manifest.id === options.agent);
    await Promise.allSettled(selected.map(async adapter => {
      try { for (const root of await adapter.roots(ctx)) await scanRoot(adapter, root); }
      catch (e) { diagnostic(ctx, adapter.manifest.id, '', (e as Error).message, 'error'); }
    }));
  }
  const all = [...sessions.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
  if (cacheEnabled && !options.agent && checkBudget(ctx)) {
    try {
      const target = cachePath();
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ version: 2, sessions: all.slice(0, 10_000).map(s => ({ ...s, preview: s.title })) }), { mode: 0o600 });
      await rename(temp, target);
    } catch { diagnostic(ctx, 'generic', cachePath(), 'Metadata cache unavailable; discovery still works. Use --no-cache to disable it.', 'info'); }
  }
  const stopReason = ctx.signal.aborted ? 'cancelled' : Date.now() >= ctx.deadline ? 'time budget reached' : ctx.scanned >= ctx.maxFiles ? 'file budget reached'
    : ctx.diagnostics.some(d => d.level !== 'info') ? 'some sources could not be read completely' : 'finished';
  return { schemaVersion: 'trace-reader-cli/1', sessions: all.filter(s => visible(s, options)),
    scan: { complete: stopReason === 'finished', rootsChecked, filesScanned: ctx.scanned, skipped: ctx.skipped, durationMs: Date.now() - start, stopReason,
      emptyHidden: options.includeEmpty ? 0 : all.filter(s => isEmptySession(s) && visible(s, { ...options, includeEmpty: true })).length }, diagnostics: ctx.diagnostics };
}
export async function inspect(session: Session, options: DiscoveryOptions = {}): Promise<Transcript> {
  const adapter = ['trace-reader', 'generic-json'].includes(session.locator.format) ? genericAdapter : adapters.find(a => a.manifest.id === session.agent);
  if (!adapter) throw new Error(`Unsupported adapter: ${session.agent}`);
  return adapter.read(session, context({ ...options, timeout: options.timeout ?? 30 }));
}
export async function importFile(input: string, options: DiscoveryOptions = {}): Promise<Transcript> {
  const file = await realpath(path.resolve(input.replace(/^~(?=$|[\\/])/, os.homedir())));
  const ctx = context(options);
  if (!(await stat(file)).isFile()) throw new Error('Import expects a regular file. Use scan --root PATH --recursive for a directory.');
  const adapter = await detectedAdapter(file);
  if (!adapter || adapter === genericAdapter) return importGeneric(file, ctx);
  const choices: Session[] = [];
  for await (const s of adapter.discover({ path: file, agent: adapter.manifest.id, provenance: 'explicit' }, ctx)) choices.push(s);
  if (choices.length !== 1) throw new Error(choices.length ? 'This store has multiple sessions. Use scan --root PATH --agent AGENT, then inspect a session ID.' : 'No supported session found in this file.');
  return adapter.read(choices[0]!, ctx);
}
