import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { AGENTS, type ScanResult, type Session, type Transcript } from '../core/types.js';
import { safeText, singleLine } from '../core/safe.js';
import { AGENT_COLORS, AGENT_LABELS, bytesLabel, cell, clip, clipLine, filterSessions, groupRows, sortSessions, timeLabel, wrap } from './format.js';

export interface AppProps {
  onScan: (onSession: (session: Session) => void, signal: AbortSignal) => Promise<ScanResult>;
  onInspect: (session: Session) => Promise<Transcript>;
  onExport: (session: Session) => Promise<string>;
  initialAgent?: string;
}

const C = { accent: '#68DEC4', text: '#E4E9EF', muted: '#8B9AA8', dim: '#536470', line: '#304450', selected: '#193A40', warning: '#E5BF7B' };
type Screen = 'list' | 'inspect' | 'help' | 'diagnostics';
type DisplayLine = { text: string; color?: string; bold?: boolean };
const sourceFilters = ['all', ...AGENTS];
const errText = (error: unknown): string => singleLine(error instanceof Error ? error.message : error);

function Button({ shortcut, children, active = false, disabled = false }: { shortcut: string; children: string; active?: boolean; disabled?: boolean }) {
  return <Text color={disabled ? C.dim : active ? '#082B2B' : C.text} backgroundColor={active ? C.accent : '#25343C'}> {shortcut} {children} </Text>;
}
function Rule({ width }: { width: number }) {
  return <Text color={C.line}>{'─'.repeat(Math.max(0, width))}</Text>;
}
function Filler({ count }: { count: number }) {
  return <>{Array.from({ length: Math.max(0, count) }, (_, index) => <Text key={index}> </Text>)}</>;
}

function traceLines(transcript: Transcript | null, width: number): DisplayLine[] {
  if (!transcript) return [];
  const lines: DisplayLine[] = [];
  const session = transcript.session;
  for (const text of [
    `${AGENT_LABELS[session.agent]} · ${session.evidence} · ${session.messages ?? 'Unknown'} messages · ${session.toolCalls ?? 'Unknown'} tools`,
    `Project: ${session.cwd ?? session.project ?? 'Unknown'}`,
    `Updated: ${session.updatedAt ?? 'Unknown'} (${session.timeSource})`,
    `Source: ${session.locator.path}`,
    `ID: ${session.id} · native ${session.nativeId}`,
  ]) lines.push(...wrap(text, width, 4).map(text => ({ text, color: C.dim })));
  lines.push({ text: '' });
  for (const warning of transcript.warnings) {
    lines.push(...wrap(`! ${warning}`, width, 10).map(text => ({ text, color: C.warning })));
  }
  if (transcript.truncated) lines.push({ text: 'Partial transcript · reader limits reached', color: C.warning });
  for (const event of transcript.events) {
    if (lines.length >= 20_000) {
      lines.push({ text: 'Display limit reached. Export to inspect the remaining events.', color: C.warning });
      break;
    }
    const role = singleLine(event.role || event.kind).toUpperCase();
    const color = event.role === 'user' ? C.accent : event.kind.startsWith('tool') ? '#E5BF7B' : C.text;
    const timestamp = event.timestamp ? `  ${new Date(event.timestamp).toLocaleString()}` : '';
    const location = event.source.line ? `  · line ${event.source.line}` : event.source.row ? `  · row ${event.source.row}` : '';
    lines.push({ text: clip(`${role}${timestamp}${location}`, width), color, bold: true });
    lines.push(...wrap(event.text || '(No text content)', width, Math.max(1, Math.min(2000, 20_000 - lines.length))).map(text => ({ text, color: C.muted })));
    lines.push({ text: '' });
  }
  if (!lines.length) lines.push({ text: 'This source exposes metadata only; no readable events were found.', color: C.muted });
  return lines;
}

export function App({ onScan, onInspect, onExport, initialAgent }: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const width = Math.max(1, columns || 80);
  const height = Math.max(1, rows || 24);
  const tooSmall = width < 48 || height < 12;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agent, setAgent] = useState(initialAgent && sourceFilters.includes(initialAgent) ? initialAgent : 'all');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [screen, setScreen] = useState<Screen>('list');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [inspected, setInspected] = useState<Session | null>(null);
  const [scroll, setScroll] = useState(0);
  const [listScroll, setListScroll] = useState(0);
  const requestId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const controller = new AbortController();
    const found = new Map<string, Session>();
    let dirty = false;
    setScanning(true);
    setNotice('');
    const flush = () => {
      if (dirty && !controller.signal.aborted) {
        setSessions(sortSessions([...found.values()]));
        dirty = false;
      }
    };
    const timer = setInterval(flush, 100);
    void onScan(session => { found.set(session.id, session); dirty = true; }, controller.signal)
      .then(scan => {
        if (controller.signal.aborted) return;
        setSessions(sortSessions(scan.sessions));
        setResult(scan);
        setScanning(false);
        if (!scan.scan.complete) setNotice(`Partial discovery · ${scan.scan.stopReason}`);
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        flush();
        setScanning(false);
        setNotice(`Discovery failed · ${errText(error)}`);
      })
      .finally(() => clearInterval(timer));
    return () => { controller.abort(); clearInterval(timer); };
  }, [onScan, refresh]);

  const filtered = useMemo(() => filterSessions(sessions, query, agent), [sessions, query, agent]);
  const selectedIndex = Math.max(0, filtered.findIndex(session => session.id === selectedId));
  const selected = filtered[selectedIndex];
  useEffect(() => {
    if (!selectedId && filtered[0]) setSelectedId(filtered[0].id);
  }, [selectedId, filtered]);
  const grouped = useMemo(() => groupRows(filtered), [filtered]);
  const sidePreview = width >= 126;
  const sideWidth = sidePreview ? Math.min(52, Math.floor(width * 0.31)) : 0;
  const listWidth = width - 2 - (sidePreview ? sideWidth + 3 : 0);
  const bodyHeight = Math.max(1, height - 10);
  const selectedRow = grouped.findIndex(row => row.kind === 'session' && row.session.id === selected?.id);
  const visibleStart = Math.min(Math.max(0, grouped.length - bodyHeight), Math.max(0,
    selectedRow < listScroll ? selectedRow : selectedRow >= listScroll + bodyHeight ? selectedRow - bodyHeight + 1 : listScroll));
  useEffect(() => { setListScroll(visibleStart); }, [visibleStart]);

  const inspect = useCallback(async (session: Session) => {
    const id = ++requestId.current;
    setInspected(session);
    setTranscript(null);
    setScreen('inspect');
    setScroll(0);
    setBusy(true);
    setNotice('');
    try {
      const content = await onInspect(session);
      if (mounted.current && id === requestId.current) setTranscript(content);
    } catch (error) {
      if (mounted.current && id === requestId.current) setNotice(`Cannot read trace · ${errText(error)}`);
    } finally {
      if (mounted.current && id === requestId.current) setBusy(false);
    }
  }, [onInspect]);
  const exportTrace = useCallback(async (session: Session) => {
    if (busy) return;
    setBusy(true);
    setNotice('Exporting locally…');
    try {
      const filename = await onExport(session);
      if (mounted.current) setNotice(`Saved · ${safeText(filename)}`);
    } catch (error) {
      if (mounted.current) setNotice(`Export failed · ${errText(error)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [onExport, busy]);
  const contentWidth = width - 4;
  const inspectorLines = useMemo(() => traceLines(transcript, contentWidth), [transcript, contentWidth]);
  const diagnosticLines = useMemo<DisplayLine[]>(() => {
    const lines: DisplayLine[] = [];
    if (result) {
      const scan = result.scan;
      lines.push({ text: `${scan.complete ? 'Discovery complete' : 'Partial discovery'} · ${scan.rootsChecked} roots · ${scan.filesScanned} files · ${scan.skipped} skipped · ${(scan.durationMs / 1000).toFixed(1)}s`, color: C.accent });
      if (!scan.complete) lines.push(...wrap(scan.stopReason, contentWidth).map(text => ({ text, color: C.warning })));
      lines.push({ text: '' });
      for (const diagnostic of result.diagnostics) {
        lines.push({ text: clip(`${AGENT_LABELS[diagnostic.agent]} · ${diagnostic.level.toUpperCase()}`, contentWidth), color: diagnostic.level === 'info' ? C.accent : C.warning, bold: true });
        lines.push(...wrap(diagnostic.path, contentWidth, 5).map(text => ({ text, color: C.dim })));
        lines.push(...wrap(diagnostic.message, contentWidth, 20).map(text => ({ text, color: C.muted })));
        lines.push({ text: '' });
      }
      if (!result.diagnostics.length) lines.push({ text: 'No source diagnostics reported.', color: C.muted });
    } else lines.push({ text: scanning ? 'Source checks are running. Results will appear when discovery finishes.' : 'No completed source checks are available.', color: C.muted });
    return lines;
  }, [result, contentWidth, scanning]);
  const documentHeight = Math.max(1, height - 8);
  const documentLines = screen === 'diagnostics' ? diagnosticLines : inspectorLines;
  const maxScroll = Math.max(0, documentLines.length - documentHeight);
  const currentScroll = Math.min(scroll, maxScroll);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }
    if (tooSmall) { if (input === 'q') exit(); return; }
    if (searching) {
      if (key.escape || key.return) { setSearching(false); return; }
      if (key.backspace || key.delete) setQuery(value => Array.from(value).slice(0, -1).join(''));
      else if (key.ctrl && input === 'u') setQuery('');
      else if (!key.ctrl && !key.meta && input) setQuery(value => (value + safeText(input).replace(/[\r\n\t]/g, ' ')).slice(0, 200));
      setSelectedId(null);
      setListScroll(0);
      return;
    }
    if (input === 'q') {
      if (screen === 'list') exit();
      else { setScreen('list'); setScroll(0); }
      return;
    }
    if (key.escape) {
      if (screen !== 'list') { setScreen('list'); setScroll(0); }
      else if (query) { setQuery(''); setSelectedId(null); }
      return;
    }
    if (input === '?') { setScreen(value => value === 'help' ? 'list' : 'help'); setScroll(0); return; }
    if (input === 'd' && !key.ctrl) { setScreen(value => value === 'diagnostics' ? 'list' : 'diagnostics'); setScroll(0); return; }
    if (input === 'e' && (screen === 'list' ? selected : inspected) && !busy && screen !== 'help' && screen !== 'diagnostics') {
      void exportTrace((screen === 'list' ? selected : inspected)!); return;
    }
    if (screen === 'inspect' || screen === 'diagnostics') {
      if (key.downArrow || input === 'j') setScroll(Math.min(maxScroll, currentScroll + 1));
      if (key.upArrow || input === 'k') setScroll(Math.max(0, currentScroll - 1));
      if (key.pageDown || input === ' ' || key.ctrl && input === 'd') setScroll(Math.min(maxScroll, currentScroll + documentHeight));
      if (key.pageUp || key.ctrl && input === 'u') setScroll(Math.max(0, currentScroll - documentHeight));
      if (input === 'g' || key.home) setScroll(0);
      if (input === 'G' || key.end) setScroll(maxScroll);
      return;
    }
    if (screen !== 'list') return;
    if (input === '/') { setSearching(true); setNotice(''); return; }
    if (input === 'f') {
      setAgent(sourceFilters[(sourceFilters.indexOf(agent) + 1) % sourceFilters.length]);
      setSelectedId(null); setListScroll(0); setNotice(''); return;
    }
    if (input === 'r' && !scanning) { setRefresh(value => value + 1); return; }
    if (key.return && selected && !busy) { void inspect(selected); return; }
    let next = selectedIndex;
    if (key.downArrow || input === 'j') next++;
    if (key.upArrow || input === 'k') next--;
    if (key.pageDown || key.ctrl && input === 'd') next += Math.max(1, bodyHeight - 2);
    if (key.pageUp || key.ctrl && input === 'u') next -= Math.max(1, bodyHeight - 2);
    if (input === 'g' || key.home) next = 0;
    if (input === 'G' || key.end) next = filtered.length - 1;
    if (filtered.length && next !== selectedIndex) setSelectedId(filtered[Math.max(0, Math.min(filtered.length - 1, next))].id);
  });

  const counts = useMemo(() => new Map(AGENTS.map(source => [source, sessions.filter(session => session.agent === source).length])), [sessions]);
  const status = scanning ? `Discovering · ${sessions.length} found` : `${sessions.length} traces${result && !result.scan.complete ? ' · partial' : ''}`;
  const heading = screen === 'list' ? 'LOCAL TRACES' : screen === 'inspect' ? 'TRACE INSPECTOR' : screen === 'help' ? 'KEYBOARD GUIDE' : 'SOURCE DIAGNOSTICS';
  const footerMessage = notice || (screen === 'list'
    ? `${filtered.length ? selectedIndex + 1 : 0}/${filtered.length}${query || agent !== 'all' ? ` matches · ${sessions.length} total` : ''}${selected?.evidence === 'metadata only' ? ' · metadata only' : ''}  ·  ${scanning ? 'Reading local sources…' : '↑↓ navigate · / search · f source · ? help'}`
    : screen === 'help' ? 'All actions are local. Escape returns to the trace list.' : `${documentLines.length ? currentScroll + 1 : 0}–${Math.min(documentLines.length, currentScroll + documentHeight)} of ${documentLines.length} lines · ↑↓ scroll · PgUp/PgDn page · Esc back`);

  if (tooSmall) return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    <Text color={C.accent}>{clip('TRACE READER', width)}</Text>
    {height > 1 && <Text color={C.muted}>{clip('Resize terminal to at least 48 × 12.', width)}</Text>}
    {height > 2 && <Text color={C.dim}>{clip('q quit · discovery continues in the background', width)}</Text>}
  </Box>;

  return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    <Box width={width} paddingX={1} justifyContent="space-between" height={1}>
      <Text bold color={C.accent}>◈ TRACE READER</Text>
      <Text color={C.muted}>{clip(`${status}  ·  LOCAL ONLY`, Math.max(0, width - 19))}</Text>
    </Box>
    <Rule width={width} />
    <Box paddingX={1} height={1} justifyContent="space-between">
      <Text bold color={C.text}>{heading}</Text>
      <Text color={C.dim}>{width >= 60 ? 'No account · no uploads' : ''}</Text>
    </Box>
    {screen === 'list' ? <>
      <Box paddingX={1} height={1} gap={1}>
        <Text color={agent === 'all' ? C.accent : C.dim} bold={agent === 'all'}>All {sessions.length}</Text>
        {AGENTS.filter(source => width >= 105 || (counts.get(source) ?? 0) > 0 || source === agent).map(source => <Text key={source} color={agent === source ? C.accent : C.dim} bold={agent === source}>{AGENT_LABELS[source]} {counts.get(source)}</Text>)}
      </Box>
      <Box paddingX={1} height={1}>
        <Text color={searching ? C.accent : C.muted}>{clip(`${searching ? '›' : '/'} ${query || (searching ? 'Type to filter…' : 'Search titles, projects, IDs')} ${searching ? '▏' : ''}`, width - 2)}</Text>
      </Box>
      <Rule width={width} />
      <Box paddingX={1} height={1}>
        <Text color={C.dim}>{cell('  TIME', 9)}{cell('SOURCE', 10)}{cell('SESSION', Math.max(8, listWidth - (listWidth >= 98 ? 46 : 26)))}{listWidth >= 98 ? cell('PROJECT', 20) : ''}{cell('MSGS', 7)}</Text>
      </Box>
      <Box height={bodyHeight} paddingX={1}>
        <Box flexDirection="column" width={listWidth} height={bodyHeight} overflow="hidden">
          {filtered.length ? grouped.slice(visibleStart, visibleStart + bodyHeight).map((row, index) => row.kind === 'date'
            ? <Text key={`date-${row.label}-${index}`} color={C.accent}>{clipLine(`  ${row.label}`, listWidth)}</Text>
            : <SessionRow key={row.session.id} session={row.session} selected={row.session.id === selected?.id} width={listWidth} />)
            : <>
              <Text> </Text>
              <Text color={C.text}>{clip(scanning ? '  Looking for local agent traces…' : query || agent !== 'all' ? '  No matching traces.' : '  No traces found in the configured sources.', listWidth)}</Text>
              {bodyHeight > 3 && <Text color={C.muted}>{clip(query ? '  Escape clears your search. f changes the source.' : '  Press d for source locations and diagnostics.', listWidth)}</Text>}
              {bodyHeight > 4 && !query && <Text color={C.muted}>{clip('  Add a location with --root <path> or --help.', listWidth)}</Text>}
            </>}
          {filtered.length > 0 && <Filler count={bodyHeight - Math.min(bodyHeight, grouped.length - visibleStart)} />}
        </Box>
        {sidePreview && <>
          <Box width={3} flexDirection="column">{Array.from({ length: bodyHeight }, (_, index) => <Text key={index} color={C.line}> │ </Text>)}</Box>
          <Preview session={selected} width={sideWidth} height={bodyHeight} />
        </>}
      </Box>
    </> : screen === 'help' ? <Box flexDirection="column" paddingX={2} height={Math.max(1, height - 6)} overflow="hidden">
      <Text> </Text>
      {[
        ['↑ ↓ / j k', 'Move between traces or scroll the inspector'],
        ['Enter', 'Read the selected trace in the inspector'],
        ['/', 'Search titles, projects, IDs, and preview text'],
        ['f', 'Cycle the harness filter'],
        ['e', 'Export the selected trace to a local file'],
        ['r', 'Refresh discovery'],
        ['d', 'View checked locations, warnings, and coverage'],
        ['PgUp PgDn', 'Move one page; g / G jump to first / last'],
        ['Esc', 'Back, leave search, or clear a search'],
        ['q / Ctrl+C', 'q returns from a panel; q on the list quits'],
      ].slice(0, Math.max(0, height - 10)).map(([key, description]) => <Text key={key}><Text color={C.accent}>{cell(key, 14)}</Text><Text color={C.muted}>{clip(description, width - 18)}</Text></Text>)}
      {height >= 23 && <><Text> </Text><Text color={C.dim}>{clip('Unknown message counts are shown as —. Metadata-only sources are labeled.', width - 4)}</Text><Text color={C.dim}>{clip('Time uses the local timezone; filesystem-derived times are labeled in preview.', width - 4)}</Text></>}
    </Box> : <>
      <Box paddingX={2} height={1}><Text color={C.muted}>{clip(screen === 'inspect' ? inspected?.title ?? '' : 'What was checked, what was skipped, and why', width - 4)}</Text></Box>
      <Rule width={width} />
      <Box paddingX={2} flexDirection="column" height={documentHeight} overflow="hidden">
        {screen === 'inspect' && busy && !transcript ? <Text color={C.accent}>Reading local trace…</Text> : documentLines.slice(currentScroll, currentScroll + documentHeight).map((line, index) => <Text key={currentScroll + index} color={line.color ?? C.text} bold={line.bold}>{clipLine(line.text, contentWidth) || ' '}</Text>)}
        <Filler count={documentHeight - Math.min(documentHeight, documentLines.length - currentScroll) - (busy && !transcript && screen === 'inspect' ? 1 : 0)} />
      </Box>
    </>}
    <Rule width={width} />
    <Box paddingX={1} height={1} gap={1}>
      {screen === 'list' ? <>
        <Button shortcut="↵" active disabled={!selected || busy}>Inspect</Button>
        <Button shortcut="e" disabled={!selected || busy}>Export</Button>
        {width >= 57 && <Button shortcut="r" disabled={scanning}>Refresh</Button>}
        {width >= 76 && <Button shortcut="d">Sources</Button>}
        {width >= 93 && <Button shortcut="?">Help</Button>}
      </> : <>
        <Button shortcut="Esc" active>Back</Button>
        {screen === 'inspect' && <Button shortcut="e" disabled={busy}>Export</Button>}
        {width >= 70 && <Text color={C.dim}>PgUp / PgDn scroll</Text>}
      </>}
    </Box>
    <Box paddingX={1} height={1}><Text color={notice ? C.warning : C.dim}>{clip(footerMessage, width - 2)}</Text></Box>
  </Box>;
}

function SessionRow({ session, selected, width }: { session: Session; selected: boolean; width: number }) {
  const showProject = width >= 98;
  const titleWidth = Math.max(8, width - (showProject ? 46 : 26));
  return <Text backgroundColor={selected ? C.selected : undefined} color={C.text} wrap="truncate-end">
    <Text color={selected ? C.accent : C.dim}>{cell(`${selected ? '›' : ' '} ${timeLabel(session)}`, 9)}</Text>
    <Text color={AGENT_COLORS[session.agent]}>{cell(AGENT_LABELS[session.agent], 10)}</Text>
    <Text bold={selected} color={selected ? C.text : '#ADB9C3'}>{cell(`${session.parentId ? '↳ ' : ''}${session.title || 'Untitled trace'}`, titleWidth - 1)} </Text>
    {showProject && <Text color={C.muted}>{cell(session.project ?? '—', 19)} </Text>}
    <Text color={session.messages === null ? C.dim : C.muted}>{cell(session.messages === null ? '—' : String(session.messages), 7)}</Text>
  </Text>;
}

function Preview({ session, width, height }: { session?: Session; width: number; height: number }) {
  if (!session) return <Box width={width}><Text color={C.dim}>Select a trace to preview</Text></Box>;
  const lines: DisplayLine[] = [
    { text: AGENT_LABELS[session.agent].toUpperCase(), color: AGENT_COLORS[session.agent], bold: true },
    ...wrap(session.title || 'Untitled trace', width, 3).map(text => ({ text, color: C.text, bold: true })),
    { text: '' },
    { text: clip(session.cwd ?? session.project ?? 'Project unavailable', width), color: C.muted },
    { text: `${session.messages ?? '—'} messages · ${session.toolCalls ?? '—'} tools · ${session.bytes ? bytesLabel(session.bytes) : 'size unknown'}`, color: C.dim },
    { text: session.evidence, color: session.evidence === 'metadata only' ? C.warning : C.accent },
    ...(session.timeSource === 'filesystem' ? [{ text: 'Time inferred from file modification', color: C.warning }] : []),
    ...(session.archived ? [{ text: 'Archived session', color: C.dim }] : []),
    { text: '' },
    ...wrap(session.preview || 'No text preview available. Enter opens the trace.', width, Math.max(1, height - 10)).map(text => ({ text, color: C.muted })),
    ...(session.warnings.length ? [{ text: clip(`! ${session.warnings[0]}`, width), color: C.warning }] : []),
  ];
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">{lines.slice(0, height).map((line, index) => <Text key={index} color={line.color} bold={line.bold}>{clip(line.text, width) || ' '}</Text>)}</Box>;
}
