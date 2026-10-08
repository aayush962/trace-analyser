import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { AGENTS, type ScanResult, type Session, type Transcript } from '../core/types.js';
import { safeText, singleLine } from '../core/safe.js';
import { isEmptySession } from '../core/activity.js';
import { AGENT_LABELS, cell, clip, clipLine, filterSessions, groupRows, sortSessions, wrap } from './format.js';
import { C } from './theme.js';
import { Activity } from './motion.js';
import { Reader } from './Reader.js';
import { Library, ROW_ACTIONS, type RowAction } from './Library.js';
import { libraryLayout } from './library-layout.js';

export interface AppProps {
  onScan: (onSession: (session: Session) => void, signal: AbortSignal) => Promise<ScanResult>;
  onInspect: (session: Session) => Promise<Transcript>;
  onExport: (session: Session) => Promise<string>;
  initialAgent?: string;
  initialIncludeEmpty?: boolean;
  reducedMotion?: boolean;
  demo?: boolean;
}

type Screen = 'list' | 'inspect' | 'help' | 'diagnostics' | 'palette';
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

export function App({ onScan, onInspect, onExport, initialAgent, initialIncludeEmpty = false, reducedMotion = false, demo = false }: AppProps) {
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
  const [rowAction, setRowAction] = useState<RowAction>('inspect');
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [oldest, setOldest] = useState(false);
  const [includeEmpty, setIncludeEmpty] = useState(initialIncludeEmpty);
  const [motionOff, setMotionOff] = useState(reducedMotion);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandIndex, setCommandIndex] = useState(0);
  const previousScreen = useRef<Screen>('list');
  const requestId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const controller = new AbortController();
    const found = new Map<string, Session>();
    let dirty = false;
    setScanning(true);
    setResult(null);
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

  const librarySessions = useMemo(() => includeEmpty ? sessions : sessions.filter(s => !isEmptySession(s)), [sessions, includeEmpty]);
  const emptyCount = useMemo(() => sessions.filter(isEmptySession).length, [sessions]);
  const filtered = useMemo(() => {
    const matches = filterSessions(librarySessions, query, agent);
    return oldest ? [...matches].reverse() : matches;
  }, [librarySessions, query, agent, oldest]);
  const selectedIndex = Math.max(0, filtered.findIndex(session => session.id === selectedId));
  const selected = filtered[selectedIndex];
  useEffect(() => { setRowAction('inspect'); }, [selected?.id]);
  useEffect(() => {
    if (filtered[0] && (!selectedId || !scanning && !filtered.some(session => session.id === selectedId))) setSelectedId(filtered[0].id);
  }, [selectedId, filtered, scanning]);
  const grouped = useMemo(() => groupRows(filtered), [filtered]);
  const bodyHeight = libraryLayout(width, height, detailsExpanded).body;
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
  const documentLines = screen === 'diagnostics' ? diagnosticLines : [];
  const maxScroll = Math.max(0, documentLines.length - documentHeight);
  const currentScroll = Math.min(scroll, maxScroll);
  const backToList = () => { requestId.current++; setBusy(false); setScreen('list'); setScroll(0); };
  const commands = [
    { name: 'Open selected trace', hint: 'Reading and evidence timeline', key: '↵', run: () => { if (selected) void inspect(selected); else setScreen('list'); } },
    { name: 'Search sessions', hint: 'Titles, projects and harnesses', key: '/', run: () => { setScreen('list'); setSearching(true); } },
    { name: 'Change source filter', hint: 'Cycle available harnesses', key: 'f', run: () => { setAgent(sourceFilters[(sourceFilters.indexOf(agent) + 1) % sourceFilters.length]); setSelectedId(null); setScreen('list'); } },
    { name: 'Refresh discovery', hint: 'Read the local stores again', key: 'r', run: () => { setScreen('list'); if (!scanning) setRefresh(v => v + 1); } },
    { name: 'Source diagnostics', hint: 'Coverage, locations and warnings', key: 'd', run: () => { setScreen('diagnostics'); setScroll(0); } },
    { name: 'Toggle row details', hint: 'Source location, coverage and preview', key: 'Space', run: () => { setDetailsExpanded(v => !v); setScreen('list'); } },
    { name: 'Change sort order', hint: 'Newest or oldest sessions first', key: 's', run: () => { setOldest(v => !v); setListScroll(0); setScreen('list'); } },
    { name: includeEmpty ? 'Hide empty sessions' : 'Show empty sessions', hint: `${emptyCount} confirmed empty · unreadable traces stay visible`, key: 'v', run: () => { setIncludeEmpty(v => !v); setNotice(''); setScreen('list'); } },
    { name: motionOff ? 'Enable animations' : 'Reduce motion', hint: 'Quiet idle screens in either mode', key: 'm', run: () => { setMotionOff(v => !v); setScreen(previousScreen.current); } },
    { name: 'Keyboard guide', hint: 'Learn the controls', key: '?', run: () => setScreen('help') },
  ].filter(command => command.name.toLowerCase().includes(commandQuery.toLowerCase()));

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }
    if (tooSmall) { if (input === 'q') exit(); return; }
    if (key.ctrl && input === 'p') {
      if (screen === 'palette') setScreen(previousScreen.current);
      else { previousScreen.current = screen; setScreen('palette'); setCommandQuery(''); setCommandIndex(0); }
      return;
    }
    if (screen === 'palette') {
      if (key.escape) { setScreen(previousScreen.current); return; }
      if (key.return) { commands[Math.min(commandIndex, commands.length - 1)]?.run(); return; }
      if (key.downArrow) { setCommandIndex(v => Math.min(commands.length - 1, v + 1)); return; }
      if (key.upArrow) { setCommandIndex(v => Math.max(0, v - 1)); return; }
      if (key.backspace || key.delete) setCommandQuery(v => Array.from(v).slice(0, -1).join(''));
      else if (!key.ctrl && !key.meta) setCommandQuery(v => (v + safeText(input)).slice(0, 80));
      setCommandIndex(0); return;
    }
    if (screen === 'inspect' && transcript) {
      return; // The reader owns its navigation and search keys.
    }
    if (searching) {
      if (key.escape || key.return) { setSearching(false); setRowAction('inspect'); return; }
      if (key.backspace || key.delete) setQuery(value => Array.from(value).slice(0, -1).join(''));
      else if (key.ctrl && input === 'u') setQuery('');
      else if (!key.ctrl && !key.meta && input) setQuery(value => (value + safeText(input).replace(/[\r\n\t]/g, ' ')).slice(0, 200));
      setSelectedId(null);
      setListScroll(0);
      return;
    }
    if (input === 'q') {
      if (screen === 'list') exit();
      else backToList();
      return;
    }
    if (key.escape) {
      if (screen !== 'list') backToList();
      else if (rowAction !== 'inspect') setRowAction('inspect');
      else if (detailsExpanded) setDetailsExpanded(false);
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
    if (input === 'm') { setMotionOff(v => !v); return; }
    if (input === '/') { setSearching(true); setNotice(''); return; }
    if (input === 'f') {
      setAgent(sourceFilters[(sourceFilters.indexOf(agent) + 1) % sourceFilters.length]);
      setSelectedId(null); setListScroll(0); setNotice(''); return;
    }
    if (input === 's') { setOldest(v => !v); setListScroll(0); return; }
    if (input === 'v') { setIncludeEmpty(v => !v); setNotice(''); return; }
    if (input === ' ') { setDetailsExpanded(v => !v); return; }
    if (key.leftArrow || key.rightArrow || key.tab || input === 'h' || input === 'l') {
      const delta = key.leftArrow || input === 'h' || key.tab && key.shift ? -1 : 1;
      setRowAction(current => ROW_ACTIONS[(ROW_ACTIONS.indexOf(current) + delta + ROW_ACTIONS.length) % ROW_ACTIONS.length]);
      return;
    }
    if (input === 'r' && !scanning) { setRefresh(value => value + 1); return; }
    if (input === 'o' && selected && !busy) { void inspect(selected); return; }
    if (key.return && selected && !busy) {
      if (rowAction === 'inspect') void inspect(selected);
      else if (rowAction === 'export') void exportTrace(selected);
      else setDetailsExpanded(v => !v);
      return;
    }
    const delta = key.downArrow || input === 'j' ? 1 : key.upArrow || input === 'k' ? -1
      : key.pageDown || key.ctrl && input === 'd' ? Math.max(1, bodyHeight - 2)
      : key.pageUp || key.ctrl && input === 'u' ? -Math.max(1, bodyHeight - 2) : 0;
    const boundary = input === 'g' || key.home ? 0 : input === 'G' || key.end ? filtered.length - 1 : null;
    if (filtered.length && (delta || boundary !== null)) {
      setSelectedId(current => {
        const index = Math.max(0, filtered.findIndex(session => session.id === current));
        return filtered[Math.max(0, Math.min(filtered.length - 1, boundary ?? index + delta))].id;
      });
      setRowAction('inspect');
    }
  });

  const status = scanning ? `Discovering · ${librarySessions.length} found` : `${librarySessions.length} traces${result && !result.scan.complete ? ' · partial' : ''}`;
  const heading = screen === 'list' ? 'LOCAL TRACES' : screen === 'inspect' ? 'TRACE INSPECTOR' : screen === 'help' ? 'KEYBOARD GUIDE' : screen === 'palette' ? 'COMMAND PALETTE' : 'SOURCE DIAGNOSTICS';
  const footerMessage = notice || (screen === 'list'
    ? `${filtered.length ? selectedIndex + 1 : 0}/${filtered.length}${query || agent !== 'all' ? ` matches · ${sessions.length} total` : ''}${selected?.evidence === 'metadata only' ? ' · metadata only' : ''}  ·  ${scanning ? 'Reading local sources…' : '↑↓ navigate · / search · f source · ? help'}`
    : screen === 'help' ? 'All actions are local. Escape returns to the trace list.' : `${documentLines.length ? currentScroll + 1 : 0}–${Math.min(documentLines.length, currentScroll + documentHeight)} of ${documentLines.length} lines · ↑↓ scroll · PgUp/PgDn page · Esc back`);

  if (tooSmall) return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    <Text color={C.accent}>{clip('TRACE READER', width)}</Text>
    {height > 1 && <Text color={C.muted}>{clip('Resize terminal to at least 48 × 12.', width)}</Text>}
    {height > 2 && <Text color={C.dim}>{clip('q quit · discovery continues in the background', width)}</Text>}
  </Box>;

  if (screen === 'list') return <Library width={width} height={height} sessions={librarySessions} filteredCount={filtered.length}
    selected={selected} selectedIndex={selectedIndex} rows={grouped} start={visibleStart} agent={agent} query={query} searching={searching}
    scanning={scanning} busy={busy} result={result} notice={notice} reducedMotion={motionOff} demo={demo} action={rowAction}
    expanded={detailsExpanded} oldest={oldest} emptyCount={emptyCount} includeEmpty={includeEmpty} />;

  return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    <Box width={width} paddingX={1} justifyContent="space-between" height={1}>
      <Text bold color={C.accent}>◈ TRACE READER</Text>
      {scanning ? <Activity reduced={motionOff} label={clip(`Discovering · ${sessions.length} found`, width - 21)} />
        : <Text color={C.muted}>{clip(`${status}  ·  ${demo ? 'SYNTHETIC DEMO' : 'LOCAL ONLY'}`, Math.max(0, width - 19))}</Text>}
    </Box>
    <Rule width={width} />
    <Box paddingX={1} height={1} justifyContent="space-between">
      <Text bold color={C.text}>{heading}</Text>
      <Text color={C.dim}>{width >= 60 ? 'ctrl+p commands  ·  ? help' : ''}</Text>
    </Box>
    {transcript && <Box display={screen === 'inspect' ? 'flex' : 'none'} flexDirection="column">
      <Box paddingX={1} height={1}><Text color={C.text} bold>{clip(inspected?.title ?? '', width - 2)}</Text></Box>
      <Reader key={inspected?.id} trace={transcript} width={width} height={Math.max(1, height - 7)} reducedMotion={motionOff} onBack={backToList} active={screen === 'inspect'}
        onExport={() => { if (inspected && !busy) void exportTrace(inspected); }} onMotion={() => setMotionOff(v => !v)} onHelp={() => setScreen('help')} />
    </Box>}
    {screen === 'palette' ? <Box flexDirection="column" paddingX={2} height={Math.max(1, height - 6)} overflow="hidden">
      <Text> </Text>
      <Text color={C.accent}>{clip(`› ${commandQuery || 'Find a command…'} ▏`, width - 4)}</Text>
      <Text> </Text>
      {commands.slice(Math.max(0, commandIndex - Math.max(1, Math.floor((height - 10) / 2)) + 1), Math.max(0, commandIndex - Math.max(1, Math.floor((height - 10) / 2)) + 1) + Math.max(1, Math.floor((height - 10) / 2))).map(command => <Box key={command.name} flexDirection="column" height={2}>
        <Text color={command === commands[commandIndex] ? C.text : C.muted} backgroundColor={command === commands[commandIndex] ? C.selected : undefined}>{cell(`${command === commands[commandIndex] ? '›' : ' '} ${command.name}`, width - 12)}<Text color={C.accent}>{cell(command.key, 8)}</Text></Text>
        <Text color={C.dim}>{clip(`  ${command.hint}`, width - 4)}</Text>
      </Box>)}
      {!commands.length && <Text color={C.dim}>No matching commands. Backspace to edit.</Text>}
    </Box> : screen === 'help' ? <Box flexDirection="column" paddingX={2} height={Math.max(1, height - 6)} overflow="hidden">
      <Text> </Text>
      {[
        ['↑ ↓ / j k', 'Move between traces or scroll the inspector'],
        ['Enter', 'Open the reading; Enter on a finding opens evidence'],
        ['← → / Tab', 'Choose an action on the selected row; Enter runs it'],
        ['1 / 2 / 3', 'Reading / timeline / raw source; Tab cycles tabs'],
        ['Ctrl+P', 'Search the command palette'],
        ['/', 'Search titles, projects, IDs, and preview text'],
        ['f / s / v', 'Source filter / sort order / show empty sessions'],
        ['Space / o', 'Expand row details / open the selected trace'],
        ['e', 'Export the selected trace to a local file'],
        ['r / m', 'Refresh discovery / toggle reduced motion'],
        ['d', 'View checked locations, warnings, and coverage'],
        ['PgUp PgDn', 'Move one page; g / G jump to first / last'],
        ['Esc', 'Back, leave search, or clear a search'],
        ['q / Ctrl+C', 'q returns from a panel; q on the list quits'],
      ].slice(0, Math.max(0, height - 10)).map(([key, description]) => <Text key={key}><Text color={C.accent}>{cell(key, 14)}</Text><Text color={C.muted}>{clip(description, width - 18)}</Text></Text>)}
      {height >= 23 && <><Text> </Text><Text color={C.dim}>{clip('Unknown message counts are shown as —. Metadata-only sources are labeled.', width - 4)}</Text><Text color={C.dim}>{clip('Time uses the local timezone; filesystem-derived times are labeled in preview.', width - 4)}</Text></>}
    </Box> : screen === 'inspect' && transcript ? null : <>
      <Box paddingX={2} height={1}><Text color={C.muted}>{clip(screen === 'inspect' ? inspected?.title ?? '' : 'What was checked, what was skipped, and why', width - 4)}</Text></Box>
      <Rule width={width} />
      <Box paddingX={2} flexDirection="column" height={documentHeight} overflow="hidden">
        {screen === 'inspect' && busy && !transcript ? <Activity reduced={motionOff} label="Reading local trace…" /> : documentLines.slice(currentScroll, currentScroll + documentHeight).map((line, index) => <Text key={currentScroll + index} color={line.color ?? C.text} bold={line.bold}>{clipLine(line.text, contentWidth) || ' '}</Text>)}
        <Filler count={documentHeight - Math.min(documentHeight, documentLines.length - currentScroll) - (busy && !transcript && screen === 'inspect' ? 1 : 0)} />
      </Box>
    </>}
    <Rule width={width} />
    <Box paddingX={1} height={1} gap={1}>
      <>
        <Button shortcut="Esc" active>Back</Button>
        {screen === 'inspect' && <Button shortcut="e" disabled={busy}>Export</Button>}
        {width >= 70 && <Text color={C.dim}>{screen === 'inspect' ? '1 reading · 2 timeline · 3 source' : '↑↓ navigate'}</Text>}
      </>
    </Box>
    <Box paddingX={1} height={1}><Text color={notice ? C.warning : C.dim}>{clip(notice || (screen === 'inspect' && transcript ? 'On-device reading · no model request · known secrets scrubbed on export' : screen === 'palette' ? '↑↓ choose · Enter run · Esc dismiss' : footerMessage), width - 2)}</Text></Box>
  </Box>;
}
