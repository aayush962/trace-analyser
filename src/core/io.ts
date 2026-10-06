import { open, readdir, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Agent, ScanContext } from './types.js';

const SKIP = new Set(['node_modules', '.git', '.cache', 'dist', 'build', 'vendor', '__pycache__', 'Caches', 'Cache', 'Keychains', 'Cookies', 'Network', 'BrowserMetrics']);
export function checkBudget(ctx: ScanContext): boolean {
  return !ctx.signal.aborted && Date.now() < ctx.deadline && ctx.scanned < ctx.maxFiles;
}
export function diagnostic(ctx: ScanContext, agent: Agent, file: string, message: string, level: 'info' | 'warning' | 'error' = 'warning'): void {
  if (ctx.diagnostics.length < 500) ctx.diagnostics.push({ agent, path: file, message, level });
}
export async function* walkFiles(root: string, ctx: ScanContext, accept: (file: string) => boolean): AsyncGenerator<string> {
  let canonical: string;
  try { canonical = await realpath(root); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') diagnostic(ctx, 'generic', root, `Cannot read location: ${(e as Error).message}`);
    return;
  }
  async function* walk(dir: string, depth: number): AsyncGenerator<string> {
    if (!checkBudget(ctx)) return;
    const stat = await lstat(dir).catch(() => null);
    if (!stat || stat.isSymbolicLink()) { ctx.skipped++; return; }
    if (stat.isFile()) { ctx.scanned++; if (accept(dir)) yield dir; return; }
    if (!stat.isDirectory()) { ctx.skipped++; return; }
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (e) { diagnostic(ctx, 'generic', dir, `Cannot list folder: ${(e as Error).message}`); return; }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (!checkBudget(ctx)) return;
      const next = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { ctx.skipped++; continue; }
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name) || entry.name.startsWith('.')) { ctx.skipped++; continue; }
        if (depth >= ctx.maxDepth) {
          ctx.skipped++;
          if (ctx.maxDepth > 0) diagnostic(ctx, 'generic', next, 'Depth limit reached; nested folder was not inspected');
          continue;
        }
        yield* walk(next, depth + 1);
      } else if (entry.isFile()) { ctx.scanned++; if (accept(next)) yield next; }
      else ctx.skipped++;
    }
  }
  yield* walk(canonical, 0);
}

export interface JsonLine { value: any; line: number }
export async function readJsonLines(file: string, ctx: ScanContext, options: { maxBytes?: number } = {}): Promise<{ records: JsonLine[]; warnings: string[]; truncated: boolean; bytes: number }> {
  // NONBLOCK prevents a swapped FIFO from hanging before fstat. NOFOLLOW
  // prevents replacing a discovered file with a descendant symlink on POSIX.
  const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(file, flags);
  const records: JsonLine[] = [];
  const warnings: string[] = [];
  let truncated = false, position = 0, line = 0, pending = Buffer.alloc(0), dropping = false;
  const warn = (s: string) => { if (warnings.length < 20) warnings.push(s); };
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Only regular transcript files can be read');
    const limit = Math.min(before.size, options.maxBytes ?? ctx.maxFileBytes);
    const parse = (buffer: Buffer) => {
      line++;
      if (!buffer.length) return;
      try { records.push({ value: JSON.parse(buffer.toString('utf8')), line }); }
      catch { truncated = true; warn(`Invalid or incomplete JSON at line ${line}`); }
    };
    while (position < limit && !ctx.signal.aborted && Date.now() < ctx.deadline && records.length < ctx.maxEvents) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const data = chunk.subarray(0, bytesRead);
      let from = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 10) continue;
        if (!dropping) {
          const full = Buffer.concat([pending, data.subarray(from, i)]);
          if (full.length <= ctx.maxRecordBytes) parse(full);
          else { line++; warn(`Oversized record omitted at line ${line}`); truncated = true; }
        } else { line++; dropping = false; }
        pending = Buffer.alloc(0); from = i + 1;
        if (records.length >= ctx.maxEvents) { truncated = true; break; }
      }
      if (records.length >= ctx.maxEvents) break;
      if (!dropping) {
        pending = Buffer.concat([pending, data.subarray(from)]);
        if (pending.length > ctx.maxRecordBytes) { dropping = true; pending = Buffer.alloc(0); warn(`Oversized record omitted at line ${line + 1}`); truncated = true; }
      }
    }
    if (position >= before.size && pending.length && !dropping && records.length < ctx.maxEvents) parse(pending);
    if (position < before.size || ctx.signal.aborted || records.length >= ctx.maxEvents) { truncated = true; warn(`Bounded read: inspected ${position} of ${before.size} bytes`); }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) { truncated = true; warn('Session changed while reading; this is a bounded snapshot'); }
    return { records, warnings, truncated, bytes: before.size };
  } finally { await handle.close(); }
}
export async function readJson(file: string, ctx: ScanContext): Promise<unknown> {
  const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(file, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > ctx.maxFileBytes) throw new Error(`JSON file exceeds ${ctx.maxFileBytes} byte limit or is not a regular file`);
    if (ctx.signal.aborted) throw new Error('Cancelled');
    // Fixed boundary avoids unbounded growth if a producer appends while we read.
    const buf = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return JSON.parse(buf.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}
