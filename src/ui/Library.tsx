import { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Session, ScanResult } from '../core/types.js';
import { AGENTS } from '../core/types.js';
import { C } from './theme.js';
import { Activity, Marquee } from './motion.js';
import { AGENT_COLORS, AGENT_LABELS, cell, clip, clipLine, timeLabel, bytesLabel, wrap, type ListRow } from './format.js';
import { libraryColumns, libraryLayout } from './library-layout.js';

export type RowAction = 'inspect' | 'export' | 'details';
export const ROW_ACTIONS: RowAction[] = ['inspect', 'export', 'details'];
export interface LibraryProps {
  width: number; height: number; sessions: Session[]; filteredCount: number; selected?: Session;
  selectedIndex: number; rows: ListRow[]; start: number; agent: string;
  query: string; searching: boolean; scanning: boolean; busy: boolean; result: ScanResult | null;
  notice: string; reducedMotion: boolean; demo: boolean; action: RowAction; expanded: boolean; oldest: boolean;
  emptyCount: number; includeEmpty: boolean;
}
function Rule({ width }: { width: number }) { return <Text color={C.line}>{'─'.repeat(Math.max(0, width))}</Text>; }
const right = (value: string, width: number) => cell(value, width).trimEnd().padStart(width);

const Row = memo(function Row({ session, selected, width, action, reducedMotion, animate, busy, stripe }: {
  session: Session; selected: boolean; width: number; action: RowAction; reducedMotion: boolean; animate: boolean; busy: boolean; stripe: boolean;
}) {
  const c = libraryColumns(width);
  const bg = selected ? C.selected : stripe ? C.panel : undefined;
  const title = `${session.activity === 'empty' ? '[empty] ' : ''}${session.parentId ? '↳ ' : ''}${session.title || 'Untitled trace'}`;
  return <Text backgroundColor={bg} color={selected ? C.text : C.muted} wrap="truncate-end">
    <Text color={selected ? C.accent : C.dim}>{selected ? '› ' : '  '}</Text>
    {c.time > 0 && <Text color={selected ? C.muted : C.dim}>{cell(timeLabel(session), c.time)}</Text>}
    <Text bold={selected} color={selected ? C.text : C.muted}><Marquee key={session.id} text={title} width={c.title - 2} active={selected && animate} reduced={reducedMotion} />{'  '}</Text>
    {c.source > 0 && <Text color={AGENT_COLORS[session.agent]}>{cell(AGENT_LABELS[session.agent], c.source)}</Text>}
    {c.project > 0 && <Text color={C.muted}>{cell(session.project ?? '—', c.project)}</Text>}
    {c.messages > 0 && <Text color={session.messages === null ? C.dim : C.muted}>{right(session.messages === null ? '—' : String(session.messages), c.messages - 2)}{'  '}</Text>}
    {c.tools > 0 && <Text color={session.toolCalls === null ? C.dim : C.muted}>{right(session.toolCalls === null ? '—' : String(session.toolCalls), c.tools - 2)}{'  '}</Text>}
    {ROW_ACTIONS.map((name, i) => {
      const size = i === 0 ? 9 : i === 1 ? 8 : c.actions - 17;
      const focused = selected && name === action;
      const text = name === 'inspect' ? 'Inspect' : name === 'export' ? 'Export' : c.actions === 26 ? 'Details' : 'Info';
      return <Text key={name} color={selected && busy ? C.dim : focused ? '#142A2B' : selected ? C.text : C.dim} backgroundColor={focused && !busy ? C.accent : bg}>
        {cell(`${focused ? '›' : ' '}${text}`, size - 1)}<Text backgroundColor={bg}> </Text>
      </Text>;
    })}
  </Text>;
});

export function Library(props: LibraryProps) {
  const { width, height, sessions, selected, selectedIndex, query, searching, scanning, busy, result, notice, reducedMotion, demo, action, expanded, oldest, agent } = props;
  const l = libraryLayout(width, height, expanded), c = libraryColumns(l.tableWidth);
  const counts = useMemo(() => new Map(AGENTS.map(a => [a, sessions.filter(s => s.agent === a).length])), [sessions]);
  const projects = useMemo(() => new Set(sessions.map(s => s.cwd ?? s.project).filter(Boolean)).size, [sessions]);
  const sourceCount = [...counts.values()].filter(n => n > 0).length;
  const warnings = result?.diagnostics.filter(d => d.level !== 'info').length ?? 0;
  const visible = props.rows.slice(props.start, props.start + l.body);
  const scrollSize = Math.max(1, Math.round(l.body * Math.min(1, l.body / Math.max(1, props.rows.length))));
  const scrollAt = Math.round(Math.max(0, l.body - scrollSize) * props.start / Math.max(1, props.rows.length - l.body));
  const position = `${props.filteredCount ? selectedIndex + 1 : 0}/${props.filteredCount}${query || agent !== 'all' ? ' matches' : ''}`;
  const status = scanning ? `${sessions.length} found` : `${sessions.length} traces${result && !result.scan.complete ? ' · partial' : ''}`;
  const headingRight = demo ? 'SYNTHETIC DEMO' : 'LOCAL ONLY';
  const detailWidth = width - 4;
  const tabs = [{ id: 'all', name: 'All', count: sessions.length }, ...AGENTS.filter(a => (counts.get(a) ?? 0) > 0 || a === agent || width >= 115).map(a => ({ id: a, name: AGENT_LABELS[a], count: counts.get(a) ?? 0 }))];
  let tabsUsed = 0;
  const shownTabs = tabs.filter(tab => { const size = tab.name.length + String(tab.count).length + 5; tabsUsed += size; return tabsUsed <= width - 10; });
  if (!shownTabs.some(tab => tab.id === agent)) {
    const current = tabs.find(tab => tab.id === agent);
    if (current) { shownTabs.pop(); shownTabs.push(current); }
  }
  const summary = result ? `${result.scan.rootsChecked} roots checked · ${(result.scan.durationMs / 1000).toFixed(1)}s${warnings ? ` · ${warnings} source warnings` : ''}` : 'Known local stores';
  const emptyStatus = props.emptyCount ? `${props.emptyCount} empty ${props.includeEmpty ? 'shown · v hide' : 'hidden · v show'}` : '';
  const details = selected ? [
    { text: `${AGENT_LABELS[selected.agent]} / ${selected.project ?? 'Unknown project'} · ${selected.title}`, color: C.text },
    { text: expanded ? `${selected.evidence} · ${selected.messages ?? '—'} messages · ${selected.toolCalls ?? '—'} tools · ${bytesLabel(selected.bytes)}${selected.archived ? ' · archived' : ''}`
      : selected.activity === 'empty' ? 'Empty session · no recorded conversation or tool activity' : selected.preview || `${selected.evidence} · ${selected.messages ?? '—'} messages · Space for source details`, color: C.dim },
    ...(expanded ? [
      { text: `Source ${selected.locator.path}`, color: C.muted },
      { text: `Native ${selected.nativeId} · ${selected.timeSource === 'filesystem' ? 'time from filesystem' : selected.updatedAt ?? 'time unknown'}`, color: C.muted },
      ...wrap(selected.preview || 'No text preview available.', detailWidth, Math.max(1, l.dock - 6)).map(text => ({ text, color: C.muted })),
      { text: selected.warnings[0] ?? 'Local preview · no model request', color: C.warning },
    ] : []),
  ] : [
    { text: 'Select a trace to see its details', color: C.text },
    { text: 'Everything stays on this machine.', color: C.dim },
  ];
  return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    <Box height={1} paddingX={2} justifyContent="space-between">
      <Text bold color={C.accent}>◈ TRACE READER</Text>
      <Text color={C.dim}>{clip(`${headingRight}${width >= 85 ? '   ctrl+p commands   ? help' : ''}`, width - 24)}</Text>
    </Box>
    {!l.compact && <Text> </Text>}
    <Box height={1} paddingX={2} justifyContent="space-between">
      <Text bold color={C.text}>LOCAL TRACES <Text color={C.dim}>{width >= 72 ? '/ Session library' : ''}</Text></Text>
      {scanning ? <Activity reduced={reducedMotion} label={clip(status, width - 39)} /> : <Text color={C.teal}>{clip(status, width - 36)}</Text>}
    </Box>
    {l.roomy && <>
      <Text> </Text>
      <Box height={2} paddingX={2}>
        {[
          [sessions.length.toLocaleString(), 'LOCAL SESSIONS'],
          [String(sourceCount), 'SOURCES FOUND'],
          [String(projects), 'PROJECTS'],
          [scanning ? 'Scanning' : result && !result.scan.complete ? 'Partial' : result ? 'Up to date' : 'Unavailable', 'DISCOVERY'],
        ].map(([value, label], i) => <Box key={label} width={Math.floor((width - 4) / 4)} flexDirection="column">
          <Text bold color={i === 3 ? scanning || result && !result.scan.complete ? C.warning : C.teal : C.text}>{value}</Text>
          <Text color={C.dim}>{label}</Text>
        </Box>)}
      </Box>
    </>}
    {!l.compact && <Text> </Text>}
    <Box paddingX={2} height={1} gap={1}>
      {shownTabs.map(tab => <Text key={tab.id} color={agent === tab.id ? C.accent : C.dim} bold={agent === tab.id} underline={agent === tab.id}>{tab.name} {tab.count}</Text>)}
      {width >= 75 && <Text color={C.dim}> f</Text>}
    </Box>
    <Box paddingX={2} height={1} justifyContent="space-between">
      <Text color={searching ? C.accent : C.muted}>{clip(`${searching ? '›' : '/'} ${query || (searching ? 'Type to filter…' : 'Search titles, projects, IDs')}${searching ? ' ▏' : ''}`, Math.max(1, width - 25))}</Text>
      <Text color={C.dim}>{oldest ? 'Oldest ↑' : 'Newest ↓'} <Text color={C.muted}>s</Text></Text>
    </Box>
    <Box height={1} paddingX={2}><Rule width={width - 4} /></Box>
    <Box height={1} paddingX={2}>
      <Text color={C.dim}>{cell('', c.cursor)}{c.time > 0 ? cell('TIME', c.time) : ''}{cell('TRACE', c.title)}{c.source > 0 ? cell('SOURCE', c.source) : ''}{c.project > 0 ? cell('PROJECT', c.project) : ''}{c.messages > 0 ? right('MSGS', c.messages - 2) + '  ' : ''}{c.tools > 0 ? right('TOOLS', c.tools - 2) + '  ' : ''}{cell(' ACTIONS', c.actions)}</Text>
    </Box>
    <Box height={l.body} paddingLeft={2} paddingRight={1}>
      <Box flexDirection="column" width={l.tableWidth} height={l.body} overflow="hidden">
        {visible.length ? visible.map((row, i) => row.kind === 'date'
          ? <Text key={`date:${row.label}:${props.start + i}`} color={C.dim}>{cell(`  ${row.label}`, l.tableWidth)}</Text>
          : <Row key={row.session.id} session={row.session} width={l.tableWidth} selected={row.session.id === selected?.id} action={action} reducedMotion={reducedMotion} animate={!searching && !busy && action === 'inspect'} busy={busy} stripe={row.index % 2 === 1} />)
          : <Box flexDirection="column" paddingTop={Math.min(2, Math.max(0, l.body - 3))}>
            <Text color={C.text}>{clip(scanning ? 'Looking for local agent traces…' : query || agent !== 'all' ? 'No matching traces.' : props.emptyCount && !props.includeEmpty ? 'Only empty sessions found.' : 'Your trace library starts here.', l.tableWidth)}</Text>
            {l.body > 2 && <Text color={C.muted}>{clip(query ? 'Esc clears the search · f changes source' : 'd checks source locations · r scans again', l.tableWidth)}</Text>}
            {l.body > 4 && <Text color={C.dim}>{clip('Import a folder with --root PATH, or try demo.', l.tableWidth)}</Text>}
          </Box>}
      </Box>
      <Box flexDirection="column" width={2}>
        {Array.from({ length: l.body }, (_, i) => <Text key={i} color={props.rows.length > l.body && i >= scrollAt && i < scrollAt + scrollSize ? C.muted : C.line}> {props.rows.length > l.body ? i >= scrollAt && i < scrollAt + scrollSize ? '┃' : '│' : ' '}</Text>)}
      </Box>
    </Box>
    {l.dock > 0 && <Box height={l.dock} flexDirection="column" paddingX={2} overflow="hidden">
      <Rule width={detailWidth} />
      {details.slice(0, l.dock - 1).map((line, i) => <Text key={i} color={line.color}>{clipLine(line.text, detailWidth)}</Text>)}
    </Box>}
    <Box height={1} paddingX={2}><Rule width={width - 4} /></Box>
    <Box height={1} paddingX={2} justifyContent="space-between">
      <Text color={notice ? C.warning : C.muted}>{clip(notice || (l.compact && expanded && selected ? `Source  ${selected.locator.path}` : `${position} · ${emptyStatus ? `${emptyStatus} · ` : ''}${scanning ? 'Reading local sources…' : summary}`), width - (width >= 90 ? 23 : 4))}</Text>
      {width >= 90 && <Text color={C.dim}>{reducedMotion ? 'motion off' : 'm reduce motion'}</Text>}
    </Box>
    <Box height={1} paddingX={2}><Text color={C.dim}>{clip(width >= 95 ? '↑↓ navigate   ←→ / Tab action   ↵ run   / search   Space details   r refresh   q quit'
      : '↑↓ row  ←→ action  ↵ run  / search  ? help', width - 4)}</Text></Box>
  </Box>;
}
