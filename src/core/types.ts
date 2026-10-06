export const AGENTS = ['claude-code', 'codex', 'cursor', 'hermes', 'generic'] as const;
export type Agent = typeof AGENTS[number];
export interface Root { path: string; agent: Agent; provenance: 'default' | 'environment' | 'explicit'; label?: string }
export interface Locator { path: string; root: string; format: string; key?: string }
export interface Session {
  id: string; nativeId: string; agent: Agent; title: string;
  project: string | null; cwd: string | null;
  startedAt: string | null; updatedAt: string | null;
  timeSource: 'recorded' | 'filesystem' | 'unknown';
  messages: number | null; toolCalls: number | null; bytes: number;
  archived: boolean; parentId: string | null;
  preview: string; warnings: string[];
  evidence: 'messages + tools' | 'messages' | 'metadata only';
  locator: Locator;
}
export interface TraceEvent {
  id: string; kind: 'message' | 'tool-call' | 'tool-result' | 'metadata' | 'unknown';
  role?: string; text: string; timestamp: string | null;
  source: { line?: number; row?: string; pointer?: string }; raw?: unknown;
}
export interface Transcript { session: Session; events: TraceEvent[]; warnings: string[]; truncated: boolean }
export interface Diagnostic { agent: Agent; path: string; level: 'info' | 'warning' | 'error'; message: string }
export interface ScanContext {
  home: string; platform: NodeJS.Platform; env: Record<string, string | undefined>;
  signal: AbortSignal; deadline: number; maxFiles: number; maxDepth: number;
  maxFileBytes: number; maxRecordBytes: number; maxEvents: number;
  scanned: number; skipped: number; diagnostics: Diagnostic[];
}
export interface Manifest { id: Agent; name: string; status: 'preview' | 'experimental' | 'import-only'; formats: string[]; limitations: string; sources: string[] }
export interface Adapter {
  manifest: Manifest;
  roots(ctx: ScanContext): Root[] | Promise<Root[]>;
  discover(root: Root, ctx: ScanContext): AsyncGenerator<Session>;
  read(session: Session, ctx: ScanContext): Promise<Transcript>;
}
export interface ScanResult {
  schemaVersion: 'trace-reader-cli/1'; sessions: Session[];
  scan: { complete: boolean; rootsChecked: number; filesScanned: number; skipped: number; durationMs: number; stopReason: string };
  diagnostics: Diagnostic[];
}
