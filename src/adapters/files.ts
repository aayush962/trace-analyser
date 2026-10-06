import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { Adapter, Agent, Root, ScanContext, Session, TraceEvent, Transcript } from '../core/types.js';
import { contentText, iso, projectName, safeText, singleLine, stableId } from '../core/safe.js';
import { diagnostic, readJsonLines, walkFiles } from '../core/io.js';

const HEAD_BYTES = 512 * 1024;
const INSPECT_BYTES = 32 * 1024 * 1024;
type Obj = Record<string, any>;
type RecordLine = { value: unknown; line: number };
type Parsed = {
  nativeId: string | null; cwd: string | null; title: string; parentId: string | null;
  startedAt: string | null; updatedAt: string | null; recognized: boolean;
  events: TraceEvent[]; messages: number; tools: number; warnings: string[];
};
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null;
const describe = (v: unknown): string => safeText(typeof v === 'string' ? v : contentText(v) || JSON.stringify(v) || '');
function blank(): Parsed { return { nativeId: null, cwd: null, title: '', parentId: null, startedAt: null, updatedAt: null, recognized: false, events: [], messages: 0, tools: 0, warnings: [] }; }
function timestamp(parsed: Parsed, value: unknown): string | null {
  const t = iso(value);
  if (t) {
    if (!parsed.startedAt || t < parsed.startedAt) parsed.startedAt = t;
    if (!parsed.updatedAt || t > parsed.updatedAt) parsed.updatedAt = t;
  }
  return t;
}

/** Client-injected context can have a user role but is not a human prompt. */
function promptTitle(value: string): string {
  let cleaned = value.trim();
  if (/^# AGENTS\.md instructions for\b/i.test(cleaned)) return '';
  cleaned = cleaned.replace(/<(environment_context|system-reminder|external_codex_apps_open_page|codex_apps_open_page_instructions|turn_aborted|permissions instructions|collaboration_mode|goal_context|recommended_plugins|skills_instructions|app-context|codex_apps_client_time_context)>[\s\S]*?<\/\1>/gi, '').trim();
  if (/^# AGENTS\.md instructions for\b/i.test(cleaned)) return '';
  if (/^<(?:environment_context|turn_aborted|system-reminder|goal_context|recommended_plugins|skills_instructions|app-context|codex_apps_client_time_context)(?:\s|>)/i.test(cleaned)) return '';
  // File-attachment envelopes put the actual user request after their inventory.
  const request = /(?:^|\n)## My request:\s*\n([\s\S]+)$/.exec(cleaned);
  if (request) cleaned = request[1].trim();
  return singleLine(cleaned).slice(0, 180);
}
function event(line: number, suffix: string, kind: TraceEvent['kind'], value: unknown, ts: string | null, raw: unknown, role?: string): TraceEvent {
  return { id: `${line}:${suffix}`, kind, ...(role ? { role } : {}), text: describe(value), timestamp: ts, source: { line }, raw };
}

function parseClaude(records: RecordLine[], file: string): Parsed {
  const out = blank();
  const seenMessages = new Set<string>();
  const seenTools = new Set<string>();
  const seenBlocks = new Set<string>();
  const filenameId = path.basename(file, '.jsonl');
  const subagent = filenameId.startsWith('agent-');
  let customTitle = '';
  let unknownRecords = 0;
  for (const { value, line } of records) {
    const r = object(value), m = object(r.message);
    const known = ['user', 'assistant', 'system', 'summary', 'custom-title', 'queue-operation', 'attachment', 'last-prompt', 'file-history-snapshot', 'progress'].includes(r.type);
    if (!known) {
      unknownRecords++;
      out.events.push(event(line, 'unknown', 'unknown', `Unrecognized record type: ${singleLine(r.type || 'unknown').slice(0, 100)}`, iso(r.timestamp), value));
      continue;
    }
    if (text(r.sessionId) || ((r.type === 'user' || r.type === 'assistant') && Object.keys(m).length)) out.recognized = true;
    // Subagent transcripts carry the parent's sessionId. Never merge them into it.
    out.nativeId ??= subagent ? filenameId : text(r.sessionId);
    if (subagent && text(r.sessionId)) out.parentId ??= r.sessionId;
    out.parentId ??= text(r.parentSessionId) ?? text(r.parent_session_id);
    // parentUuid is the previous message, NOT a parent session.
    out.cwd ??= text(r.cwd);
    const ts = timestamp(out, r.timestamp);
    if (r.type === 'custom-title' && text(r.customTitle)) customTitle = singleLine(r.customTitle).slice(0, 180);
    if (r.type === 'user' || r.type === 'assistant') {
      const role = text(m.role) ?? r.type;
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
      const messageId = text(m.id) ?? text(r.uuid) ?? `line-${line}`;
      const messageText = blocks.filter((b: unknown) => object(b).type === 'text').map((b: Obj) => contentText(b)).filter(Boolean).join('\n');
      const meaningful = role !== 'user' || (!r.isMeta && !!promptTitle(messageText));
      if (messageText) {
        // A streaming response can be persisted in multiple content blocks with one message.id.
        const blockKey = `${messageId}:text:${messageText}`;
        if (!seenBlocks.has(blockKey)) {
          seenBlocks.add(blockKey);
          out.events.push(event(line, 'message', meaningful ? 'message' : 'metadata', messageText, ts, value, role));
        }
        if (meaningful && !seenMessages.has(messageId)) { seenMessages.add(messageId); out.messages++; }
        if (!out.title && role === 'user' && !r.isMeta) out.title = promptTitle(messageText);
      }
      for (let i = 0; i < blocks.length; i++) {
        const b = object(blocks[i]);
        if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          const key = text(b.id) ?? `${line}:${i}`;
          if (!seenTools.has(key)) {
            seenTools.add(key); out.tools++;
            out.events.push(event(line, `tool-${i}`, 'tool-call', `${b.name ?? 'tool'}\n${describe(b.input)}`, ts, blocks[i], 'assistant'));
          }
        } else if (b.type === 'tool_result') {
          const key = `result:${b.tool_use_id ?? line}:${describe(b.content)}`;
          if (!seenBlocks.has(key)) { seenBlocks.add(key); out.events.push(event(line, `result-${i}`, 'tool-result', b.content, ts, blocks[i], 'tool')); }
        } else if (b.type !== 'text') {
          // Preserve evidence of images/thinking/unknown blocks, without inventing textual messages.
          out.events.push(event(line, `block-${i}`, 'metadata', b.type === 'thinking' ? b.thinking : `[${b.type ?? 'unknown content'}]`, ts, blocks[i], role));
        }
      }
    } else {
      out.events.push(event(line, 'metadata', 'metadata', r.summary ?? r.lastPrompt ?? r.customTitle ?? r.type, ts, value));
    }
  }
  if (unknownRecords) out.warnings.push(`Preserved ${unknownRecords} unrecognized Claude record${unknownRecords === 1 ? '' : 's'}; message and tool counts may be incomplete`);
  if (customTitle) out.title = customTitle;
  out.nativeId ??= filenameId;
  return out;
}

function parseCodex(records: RecordLine[], file: string): Parsed {
  const out = blank();
  const canonical = new Map<string, number>();
  const seenTools = new Set<string>();
  const seenIds = new Set<string>();
  const mirrorKey = (role: string, value: string) => `${role}\0${value}`;
  // Rollouts often persist each message twice: a response item and an event notification.
  // Count matched occurrences, so two real identical prompts are still two messages.
  for (const { value } of records) {
    const r = object(value), p = object(r.payload);
    if (r.type !== 'response_item' || p.type !== 'message') continue;
    const body = contentText(p.content);
    if (body && (p.role === 'user' || p.role === 'assistant')) {
      const key = mirrorKey(p.role, body); canonical.set(key, (canonical.get(key) ?? 0) + 1);
    }
  }
  for (const { value, line } of records) {
    const r = object(value), p = object(r.payload);
    if (!text(r.type) || !Object.keys(p).length) continue;
    const ts = timestamp(out, r.timestamp);
    if (r.type === 'session_meta') {
      out.recognized = true;
      out.nativeId ??= text(p.id) ?? text(p.session_id);
      out.cwd ??= text(p.cwd);
      out.parentId ??= text(p.parent_thread_id) ?? text(object(object(p.source).subagent).thread_spawn?.parent_thread_id) ?? text(p.forked_from_id);
      timestamp(out, p.timestamp);
      if (p.history_base) out.warnings.push('This rollout references inherited history; only records in this file are shown');
      out.events.push(event(line, 'session', 'metadata', 'Session metadata', ts, value));
    } else if (r.type === 'turn_context') {
      out.cwd ??= text(p.cwd);
      out.events.push(event(line, 'context', 'metadata', 'Turn context', ts, value));
    } else if (r.type === 'response_item') {
      out.recognized = true;
      if (p.type === 'message') {
        const role = text(p.role) ?? 'unknown', body = contentText(p.content);
        const id = text(p.id);
        if (id && seenIds.has(`message:${id}`)) continue;
        if (id) seenIds.add(`message:${id}`);
        const meaningful = !!body && (role === 'assistant' || (role === 'user' && !!promptTitle(body)));
        out.events.push(event(line, 'message', meaningful ? 'message' : 'metadata', body || '[non-text content]', ts, value, role));
        if (meaningful) out.messages++;
        if (!out.title && role === 'user') out.title = promptTitle(body);
      } else if (['function_call', 'custom_tool_call', 'mcp_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call', 'image_generation_call'].includes(p.type)) {
        const key = text(p.call_id) ?? text(p.id) ?? `line-${line}`;
        if (!seenTools.has(key)) {
          seenTools.add(key); out.tools++;
          out.events.push(event(line, 'tool', 'tool-call', `${p.name ?? p.type}\n${describe(p.arguments ?? p.input ?? p.action)}`, ts, value, 'assistant'));
        }
      } else if (['function_call_output', 'custom_tool_call_output', 'mcp_tool_call_output', 'tool_search_output'].includes(p.type)) {
        out.events.push(event(line, 'result', 'tool-result', p.output ?? p.tools, ts, value, 'tool'));
      } else {
        out.events.push(event(line, 'item', 'metadata', p.type === 'reasoning' ? contentText(p.summary) || '[reasoning]' : p.type ?? 'Response item', ts, value));
      }
    } else if (r.type === 'event_msg' && (p.type === 'user_message' || p.type === 'agent_message')) {
      const role = p.type === 'user_message' ? 'user' : 'assistant';
      const body = contentText(p.message), key = mirrorKey(role, body), matches = canonical.get(key) ?? 0;
      if (matches > 0) { canonical.set(key, matches - 1); continue; }
      out.recognized = true;
      const meaningful = !!body && (role !== 'user' || !!promptTitle(body));
      out.events.push(event(line, 'message-event', meaningful ? 'message' : 'metadata', body, ts, value, role));
      if (meaningful) out.messages++;
      if (!out.title && role === 'user') out.title = promptTitle(body);
    } else {
      out.events.push(event(line, 'metadata', 'metadata', p.type ?? r.type, ts, value));
    }
  }
  out.nativeId ??= path.basename(file, '.jsonl');
  return out;
}

function roots(ctx: ScanContext, agent: Agent, variable: string, defaultDir: string, stores: string[]): Root[] {
  const locations: { base: string; provenance: Root['provenance'] }[] = [];
  const custom = ctx.env[variable];
  if (custom) locations.push({ base: path.resolve(custom.startsWith('~/') ? path.join(ctx.home, custom.slice(2)) : custom), provenance: 'environment' });
  locations.push({ base: path.join(ctx.home, defaultDir), provenance: 'default' });
  const unique = new Set<string>();
  return locations.flatMap(({ base, provenance }) => stores.map(store => ({ agent, path: path.join(base, store), provenance, label: store }))).filter(root => !unique.has(root.path) && !!unique.add(root.path));
}

/** Codex's native index carries user-visible names even when context fills the preview. */
async function codexTitles(root: Root, ctx: ScanContext): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (!['sessions', 'archived_sessions'].includes(path.basename(root.path))) return titles;
  const file = path.join(path.dirname(root.path), 'session_index.jsonl');
  try {
    const index = await readJsonLines(file, ctx, { maxBytes: Math.min(ctx.maxFileBytes, 1024 * 1024) });
    for (const { value } of index.records) {
      const r = object(value), id = text(r.id), name = text(r.thread_name);
      if (id && name) titles.set(id, singleLine(name).slice(0, 180));
    }
    if (index.truncated || index.warnings.length) diagnostic(ctx, 'codex', file, 'Native title index was only partly readable; remaining sessions use transcript previews.', 'info');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostic(ctx, 'codex', file, 'Native title index unavailable; using transcript previews.', 'info');
  }
  return titles;
}

function makeAdapter(agent: 'claude-code' | 'codex'): Adapter {
  const isClaude = agent === 'claude-code';
  const parse = isClaude ? parseClaude : parseCodex;
  const format = isClaude ? 'claude-jsonl' : 'codex-jsonl';
  async function load(root: Root, file: string, ctx: ScanContext, head: boolean, titles = new Map<string, string>()): Promise<Transcript | null> {
    const result = await readJsonLines(file, ctx, { maxBytes: Math.min(ctx.maxFileBytes, head ? HEAD_BYTES : INSPECT_BYTES) });
    const parsed = parse(result.records, file);
    if (!parsed.recognized) return null;
    const fileStat = await stat(file);
    const incomplete = result.truncated || result.warnings.length > 0 || parsed.warnings.length > 0 || parsed.events.length > ctx.maxEvents;
    const warnings = [...result.warnings, ...parsed.warnings];
    if (parsed.events.length > ctx.maxEvents) warnings.push(`Event limit reached (${ctx.maxEvents}); remaining events omitted`);
    if (incomplete) warnings.push(head ? 'Partial discovery preview; open the session to inspect more. Counts are unknown.' : 'Incomplete transcript read; counts are unknown.');
    const session: Session = {
      id: stableId(agent, file, parsed.nativeId!), nativeId: parsed.nativeId!, agent,
      title: titles.get(parsed.nativeId!) || parsed.title || '(No user prompt in inspected records)',
      cwd: parsed.cwd, project: projectName(parsed.cwd),
      startedAt: parsed.startedAt,
      updatedAt: incomplete ? fileStat.mtime.toISOString() : parsed.updatedAt ?? fileStat.mtime.toISOString(),
      timeSource: !incomplete && parsed.updatedAt ? 'recorded' : 'filesystem',
      messages: incomplete ? null : parsed.messages, toolCalls: incomplete ? null : parsed.tools,
      bytes: result.bytes, archived: root.label === 'archived_sessions' || file.split(path.sep).includes('archived_sessions'),
      parentId: parsed.parentId, preview: parsed.title, warnings,
      evidence: parsed.tools ? 'messages + tools' : parsed.messages ? 'messages' : 'metadata only',
      locator: { path: file, root: root.path, format },
    };
    return { session, events: parsed.events.slice(0, ctx.maxEvents), warnings, truncated: incomplete };
  }
  return {
    manifest: {
      id: agent, name: isClaude ? 'Claude Code' : 'Codex', status: 'preview', formats: [format],
      limitations: isClaude
        ? 'Persisted local JSONL only. Internal format may change; deleted or non-persisted sessions cannot be recovered. Preview counts are unknown when bounded.'
        : 'Local rollout JSONL, including archives. Inherited history references are reported, not followed. Preview counts are unknown when bounded.',
      sources: isClaude
        ? ['https://code.claude.com/docs/en/sessions']
        : ['https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs', 'https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs'],
    },
    roots: ctx => isClaude ? roots(ctx, agent, 'CLAUDE_CONFIG_DIR', '.claude', ['projects']) : roots(ctx, agent, 'CODEX_HOME', '.codex', ['sessions', 'archived_sessions']),
    async *discover(root, ctx) {
      const titles = isClaude ? new Map<string, string>() : await codexTitles(root, ctx);
      for await (const file of walkFiles(root.path, ctx, file => file.endsWith('.jsonl') && (isClaude || root.provenance === 'explicit' || path.basename(file).startsWith('rollout-')))) {
        try {
          const transcript = await load(root, file, ctx, true, titles);
          if (transcript) yield transcript.session;
          else diagnostic(ctx, agent, file, 'No supported transcript records found in the bounded preview', 'info');
        } catch (error) { diagnostic(ctx, agent, file, `Cannot read transcript: ${(error as Error).message}`); }
      }
    },
    async read(session, ctx) {
      const root: Root = { path: session.locator.root, agent, provenance: 'explicit' };
      const titles = isClaude ? new Map<string, string>() : await codexTitles(root, ctx);
      const transcript = await load(root, session.locator.path, ctx, false, titles);
      if (!transcript) throw new Error('No supported transcript records found');
      return transcript;
    },
  };
}

export const claudeAdapter = makeAdapter('claude-code');
export const codexAdapter = makeAdapter('codex');
