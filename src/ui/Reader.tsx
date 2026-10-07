import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Transcript } from '../core/types.js';
import { normalizeTranscript, eventText } from '../core/normalize.js';
import { readSnapshot } from '../core/reading.js';
import type { NormalizedEvent } from '../schema/normalized.js';
import { singleLine } from '../core/safe.js';
import { clip, clipLine, cell, wrap, AGENT_LABELS } from './format.js';
import { C } from './theme.js';
import { Entrance } from './motion.js';

const label = (e: NormalizedEvent) => e.kind === 'message' ? e.role === 'user' ? 'USER' : e.role.toUpperCase()
  : e.kind === 'tool-call' ? e.name : e.kind === 'tool-result' ? e.outcome === 'reported-error' ? 'ERROR' : 'RESULT' : e.kind === 'unknown' ? e.nativeType ?? 'CONTEXT' : e.kind.toUpperCase();
const color = (e: NormalizedEvent) => e.kind === 'message' ? e.role === 'user' ? C.teal : C.text
  : e.kind === 'tool-call' ? C.accent : e.kind === 'tool-result' ? e.outcome === 'reported-error' ? C.error : C.muted : C.dim;
const glyph = (e: NormalizedEvent) => e.kind === 'message' ? e.role === 'user' ? '●' : '◇'
  : e.kind === 'tool-call' ? '╴' : e.kind === 'tool-result' ? e.outcome === 'reported-error' ? '!' : '↳' : '·';
const elapsed = (ms: number | null) => ms === null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m ${Math.floor(ms / 1000) % 60}s` : `${(ms / 3_600_000).toFixed(1)}h`;

function Ribbon({ events, at, width }: { events: NormalizedEvent[]; at: number; width: number }) {
  const cells = Math.max(1, Math.min(events.length, width - 13));
  const marker = events.length ? Math.floor(at / events.length * cells) : -1;
  return <Text><Text color={C.dim}>EVENT ORDER </Text>{Array.from({ length: cells }, (_, i) => {
    const e = events[Math.floor(i / cells * events.length)];
    return <Text key={i} color={i === marker ? C.accent : e ? color(e) : C.line}>{i === marker ? '◆' : '━'}</Text>;
  })}</Text>;
}

export function Reader({ trace, width, height, reducedMotion, onBack, onExport, onMotion, onHelp, active = true }: {
  trace: Transcript; width: number; height: number; reducedMotion: boolean; onBack: () => void;
  onExport: () => void; onMotion: () => void; onHelp: () => void; active?: boolean;
}) {
  const snapshot = useMemo(() => normalizeTranscript(trace), [trace]);
  const reading = useMemo(() => readSnapshot(snapshot), [snapshot]);
  const [tab, setTab] = useState<'reading' | 'timeline' | 'source'>('reading');
  const [finding, setFinding] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  const [showContext, setShowContext] = useState(false);
  const [filter, setFilter] = useState('');
  const [searching, setSearching] = useState(false);
  const [cameFromFinding, setCameFromFinding] = useState(false);
  const [anchorIndex, setAnchorIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const events = useMemo(() => snapshot.events.filter(e => (showContext || e.kind !== 'unknown') &&
    (!filter || `${label(e)} ${eventText(e)}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))), [snapshot, showContext, filter]);
  const at = Math.min(cursor, Math.max(0, events.length - 1));
  const event = events[at];
  useEffect(() => {
    if (!playing || reducedMotion || !active || tab !== 'timeline' || searching || at >= events.length - 1) {
      if (playing) setPlaying(false);
      return;
    }
    const timer = setInterval(() => { setCursor(v => Math.min(events.length - 1, v + 1)); setOffset(0); }, 1100);
    return () => clearInterval(timer);
  }, [playing, reducedMotion, active, tab, searching, at, events.length]);
  const focus = reading.observations[Math.min(finding, Math.max(0, reading.observations.length - 1))];
  const body = Math.max(1, height - 3);
  const readingColumns = width >= 110 && body >= 12;
  const notesWidth = Math.floor(width * .33);
  const findingsWidth = width - notesWidth - 5;
  const cards = Math.max(1, Math.floor((body - 4) / 4));
  const findingStart = Math.max(0, finding - cards + 1);
  const wide = width >= 96;
  const railWidth = wide ? Math.min(42, Math.floor(width * .34)) : 0;
  const detailWidth = Math.max(1, width - (wide ? railWidth + 3 : 2));
  const detailHeight = tab === 'timeline' ? Math.max(1, body - 3) : body;
  const source = event ? snapshot.records.find(r => r.id === event.evidence[0]?.recordId) : undefined;
  const sourceLabel = source?.location.kind === 'jsonl' ? `line ${source.location.line}` : source?.location.kind === 'sqlite' ? `row ${source.location.rowKey}` : 'source record';
  const detail = useMemo(() => {
    if (tab === 'source') return wrap([
      'SOURCE & COVERAGE', '', `Harness: ${AGENT_LABELS[trace.session.agent]}`,
      `Native session: ${trace.session.nativeId}`, `Source: ${trace.session.locator.path}`,
      `Project: ${trace.session.cwd ?? 'Unknown'}`, '',
      `Read: ${trace.truncated ? 'PARTIAL · reader limits or source problems' : 'Within reader limits · source completeness unknown'}`,
      'These counts describe retained events, not necessarily the entire session.',
      'Branches, inherited history, usage totals and task success are not inferred.',
      'Normalized locally · no AI request · source files unchanged', '',
      ...trace.warnings.map(w => `! ${w}`),
      ...(event ? ['', `SELECTED EVENT · ${event.id}`, `Evidence: ${sourceLabel}`, `Retained record: ${source?.captureKind ?? 'unknown'}`, '',
        JSON.stringify(source?.body.state === 'present' ? source.body.value : null, null, 2).slice(0, 100_000)] : []),
    ].join('\n'), width - 2, 3000);
    if (!event) return ['No matching events.', 'Press / to search, c to include context, or Esc to clear.'];
    return wrap(event.kind === 'unknown' ? JSON.stringify(event.data.state === 'present' ? event.data.value : null, null, 2).slice(0, 100_000)
      : eventText(event) || '(No text content recorded)', detailWidth, 3000);
  }, [tab, trace, event, source, sourceLabel, width, detailWidth]);
  const maxOffset = Math.max(0, detail.length - (tab === 'source' ? body : detailHeight));
  const scroll = Math.min(offset, maxOffset);
  const jump = (id: string) => {
    const next = events.findIndex(e => e.id === id);
    if (next >= 0) setCursor(next);
    else { setFilter(''); setShowContext(true); setCursor(snapshot.events.findIndex(e => e.id === id)); }
    setOffset(0); setTab('timeline');
  };
  useInput((input, key) => {
    if (key.ctrl && input === 'c') return;
    if (searching) {
      if (key.escape || key.return) { setSearching(false); return; }
      if (key.backspace || key.delete) setFilter(v => Array.from(v).slice(0, -1).join(''));
      else if (key.ctrl && input === 'u') setFilter('');
      else if (!key.ctrl && !key.meta) setFilter(v => (v + input.replace(/[\x00-\x1f\x7f]/g, '')).slice(0, 200));
      setCursor(0); setOffset(0); return;
    }
    if (input === 'e') { onExport(); return; }
    if (input === 'm') { onMotion(); return; }
    if (input === '?') { onHelp(); return; }
    if (input === 'p' && tab === 'timeline') {
      if (!reducedMotion) { if (at >= events.length - 1) setCursor(0); setPlaying(v => !v); }
      return;
    }
    if (key.escape || input === 'q') {
      if (filter) { setFilter(''); setCursor(0); }
      else if (tab !== 'reading') { setTab('reading'); setOffset(0); }
      else onBack();
      return;
    }
    if (input === '1' || input === '2' || input === '3' || key.tab) {
      const tabs = ['reading', 'timeline', 'source'] as const;
      setTab(key.tab ? tabs[(tabs.indexOf(tab) + (key.shift ? 2 : 1)) % 3] : tabs[Number(input) - 1]);
      setOffset(0); return;
    }
    if (input === '/' && tab === 'timeline') { setSearching(true); return; }
    if (input === 'c' && tab === 'timeline') { setShowContext(v => !v); setCursor(0); setOffset(0); return; }
    if (tab === 'reading') {
      if (key.downArrow || input === 'j') setFinding(v => Math.min(reading.observations.length - 1, v + 1));
      if (key.upArrow || input === 'k') setFinding(v => Math.max(0, v - 1));
      if (key.return && focus) { setCameFromFinding(true); setAnchorIndex(0); jump(focus.eventIds[0]); }
      if (input === 'o' && reading.request) { setCameFromFinding(false); jump(reading.request.eventId); }
      if (input === 'l' && reading.response) { setCameFromFinding(false); jump(reading.response.eventId); }
      return;
    }
    if (tab === 'timeline' && (input === '[' || input === ']') && cameFromFinding && focus) {
      const next = (anchorIndex + (input === ']' ? 1 : focus.eventIds.length - 1)) % focus.eventIds.length;
      setAnchorIndex(next); jump(focus.eventIds[next]); return;
    }
    if (key.pageDown || input === ' ' || key.ctrl && input === 'd') { setOffset(Math.min(maxOffset, scroll + detailHeight)); return; }
    if (key.pageUp || key.ctrl && input === 'u') { setOffset(Math.max(0, scroll - detailHeight)); return; }
    if (tab === 'source') {
      if (key.downArrow || input === 'j') setOffset(Math.min(maxOffset, scroll + 1));
      if (key.upArrow || input === 'k') setOffset(Math.max(0, scroll - 1));
      if (input === 'g') setOffset(0);
      if (input === 'G') setOffset(maxOffset);
      return;
    }
    let next = at;
    if (key.downArrow || input === 'j') next++;
    if (key.upArrow || input === 'k') next--;
    if (input === 'g' || key.home) next = 0;
    if (input === 'G' || key.end) next = events.length - 1;
    if (next !== at) { setPlaying(false); setCursor(Math.max(0, Math.min(events.length - 1, next))); setOffset(0); }
  }, { isActive: active });
  return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    <Box height={1} paddingX={1} gap={2}>
      {(['reading', 'timeline', 'source'] as const).map((name, i) => <Text key={name} bold={tab === name} color={tab === name ? C.accent : C.dim}>{i + 1} {name === 'source' ? 'Source' : name === 'reading' ? 'Reading' : 'Timeline'}</Text>)}
      {width >= 70 && <Text color={C.dim}>{trace.truncated ? '◐ Partial capture' : '○ Local observations'}</Text>}
    </Box>
    <Text color={C.line}>{'─'.repeat(width)}</Text>
    {tab === 'reading' && body < 12 ? <Box flexDirection="column" height={body} paddingX={1} overflow="hidden">
      <Text color={C.accent}>{clip(`OBSERVATIONS · ${reading.errors} reported errors · ${reading.tools} tools`, width - 2)}</Text>
      <Text color={focus?.tone === 'warning' ? C.error : C.text}>{clip(focus?.title ?? 'No matching patterns. Press 2 to read.', width - 2)}</Text>
      {body > 2 && <Text color={C.muted}>{clip(focus?.detail ?? 'Task success is not inferred.', width - 2)}</Text>}
      {body > 3 && <Text color={C.dim}>{clip('↑↓ choose · Enter evidence · 2 timeline', width - 2)}</Text>}
    </Box> : tab === 'reading' && readingColumns ? <Box flexDirection="column" height={body} paddingX={1} overflow="hidden">
      <Text color={C.teal}>{clip(`${reading.messages} message events   ·   ${reading.tools} tools   ·   ${reading.errors} reported errors   ·   ${elapsed(reading.elapsedMs)} recorded span`, width - 2)}</Text>
      <Text> </Text>
      <Box height={body - 2}>
        <Box flexDirection="column" width={findingsWidth}>
          <Text color={C.accent}>OBSERVATIONS <Text color={C.dim}> / {reading.observations.length} · recorded facts</Text></Text>
          <Text> </Text>
          {reading.observations.slice(findingStart, findingStart + cards).map(item => <Box key={item.id} flexDirection="column" height={4}>
            <Text color={item.tone === 'warning' ? C.error : C.teal} backgroundColor={item.id === focus?.id ? C.selected : undefined}>{cell(`${item.id === focus?.id ? '›' : ' '} ${item.title}`, findingsWidth)}</Text>
            <Text color={C.muted}>{clip(`  ${item.detail}`, findingsWidth)}</Text>
            <Text color={C.dim}>  {item.eventIds.length} evidence events  <Text color={C.accent}>↵ inspect</Text></Text>
            <Text> </Text>
          </Box>)}
          {!reading.observations.length && <><Text color={C.muted}>No matching patterns in the retained events.</Text><Text color={C.dim}>Open the timeline to read the exchange.</Text></>}
        </Box>
        <Box width={3} flexDirection="column">{Array.from({ length: body - 2 }, (_, i) => <Text key={i} color={C.line}> │ </Text>)}</Box>
        <Box width={notesWidth} flexDirection="column" overflow="hidden">
          <Text color={C.dim}>THE REQUEST <Text color={C.accent}>o ↗</Text></Text>
          {wrap(reading.request?.text ?? 'No user message is available.', notesWidth, Math.max(2, Math.floor((body - 6) / 2))).map((line, i) => <Text key={i} color={C.text}>{clipLine(line, notesWidth)}</Text>)}
          <Text> </Text>
          <Text color={C.dim}>LAST ASSISTANT MESSAGE <Text color={C.accent}>l ↗</Text></Text>
          {wrap(reading.response?.text ?? 'No assistant message recorded.', notesWidth, Math.max(2, Math.floor((body - 6) / 2))).map((line, i) => <Text key={i} color={C.muted}>{clipLine(line, notesWidth)}</Text>)}
          {body >= 20 && <><Text> </Text><Text color={C.dim}>An excerpt, not a verified outcome.</Text></>}
        </Box>
      </Box>
    </Box> : tab === 'reading' ? <Box flexDirection="column" height={body} paddingX={1} overflow="hidden">
      <Text color={C.teal}>{clip(`${reading.messages} message events   ${reading.tools} tools   ${reading.errors} reported errors   ${elapsed(reading.elapsedMs)} recorded span`, width - 2)}</Text>
      <Text> </Text>
      <Text color={C.dim}>THE REQUEST <Text color={C.accent}>o ↗</Text></Text>
      {wrap(reading.request?.text ?? 'No user message is available in this capture.', width - 2, body < 20 ? 2 : 3).map((line, i) => <Text key={i} color={C.text}>{clipLine(line, width - 2)}</Text>)}
      <Text> </Text>
      <Text color={C.dim}>LAST ASSISTANT MESSAGE <Text color={C.accent}>l ↗</Text></Text>
      <Text color={C.muted}>{clip(reading.response?.text ?? 'No assistant message recorded.', width - 2)}</Text>
      <Text> </Text>
      <Text color={C.accent}>OBSERVATIONS <Text color={C.dim}> · recorded facts · not an AI verdict</Text></Text>
      {reading.observations.length ? reading.observations.slice(Math.max(0, finding - Math.max(0, Math.floor((body - 11) / 3) - 1)), Math.max(0, finding - Math.max(0, Math.floor((body - 11) / 3) - 1)) + Math.max(1, Math.floor((body - 10) / 3))).map(item => <Box key={item.id} flexDirection="column" height={3}>
        <Text backgroundColor={focus?.id === item.id ? C.selected : undefined} color={item.tone === 'warning' ? C.error : C.teal}>
          {cell(`${focus?.id === item.id ? '›' : ' '} ${item.title}`, width - 2)}</Text>
        <Text color={C.muted}>{clip(`  ${item.detail}`, width - 2)}</Text>
        <Text color={C.dim}>  {item.eventIds.length} evidence event{item.eventIds.length === 1 ? '' : 's'} <Text color={C.accent}>↵ inspect</Text></Text>
      </Box>) : <>
        <Text color={C.muted}>No matching patterns in the retained events.</Text>
        <Text color={C.dim}>This does not establish task success. Open the timeline to read the exchange.</Text>
      </>}
    </Box> : tab === 'source' ? <Box flexDirection="column" height={body} paddingX={1}>
      {detail.slice(scroll, scroll + body).map((line, i) => <Text key={i} color={i === 0 && !scroll ? C.accent : C.muted}>{clipLine(line, width - 2) || ' '}</Text>)}
    </Box> : <Box height={body}>
      {wide && <Box width={railWidth} flexDirection="column" overflow="hidden">
        <Text color={C.dim}>  EVENT MAP · {events.length}</Text>
        {events.slice(Math.max(0, Math.min(at - Math.floor((body - 2) / 2), events.length - (body - 1))), Math.max(0, Math.min(at - Math.floor((body - 2) / 2), events.length - (body - 1))) + body - 1).map(e => <Text key={e.id} backgroundColor={e.id === event?.id ? C.selected : undefined} color={e.id === event?.id ? C.text : color(e)}>
          {cell(`${e.id === event?.id ? '›' : ' '} ${glyph(e)} ${label(e)}  ${singleLine(eventText(e)).slice(0, 70)}`, railWidth)}</Text>)}
      </Box>}
      {wide && <Box width={3} flexDirection="column">{Array.from({ length: body }, (_, i) => <Text key={i} color={C.line}> │ </Text>)}</Box>}
      <Box flexDirection="column" width={wide ? detailWidth : width} paddingX={wide ? 0 : 1} height={body} overflow="hidden">
        <Text color={event ? color(event) : C.dim} bold>{clip(`${event ? `${glyph(event)} ${label(event)}` : 'No events'}   ${events.length ? at + 1 : 0}/${events.length} · ${sourceLabel}`, detailWidth)}</Text>
        <Text color={C.dim}>{clip(searching ? `/ ${filter}▏` : filter ? `/ ${filter} · Esc clears` : `${showContext ? 'Context included' : 'Context hidden'} · / search · c context · ${playing ? 'Ⅱ p pause · 1.1s/event' : reducedMotion ? 'motion off' : '▷ p replay'}`, detailWidth)}</Text>
        <Ribbon events={events} at={at} width={detailWidth} />
        {detail.slice(scroll, scroll + detailHeight).map((line, i) => <Text key={`${event?.id}:${scroll + i}`} color={C.text}>{i === 0 ? <Entrance key={event?.id} reduced={reducedMotion}>{clipLine(line, detailWidth) || ' '}</Entrance> : clipLine(line, detailWidth) || ' '}</Text>)}
      </Box>
    </Box>}
    <Box height={1} paddingX={1}><Text color={C.dim}>{clip(tab === 'reading' ? `${reading.observations.length ? `${Math.max(0, finding) + 1}/${reading.observations.length} · ` : ''}↑↓ observations · ↵ evidence · 2 timeline · Esc library` : tab === 'timeline'
      ? `${cameFromFinding && focus ? `[ ] evidence ${anchorIndex + 1}/${focus.eventIds.length} · ` : ''}↑↓ events · PgUp/PgDn output · ${Math.min(detail.length, scroll + 1)}–${Math.min(detail.length, scroll + detailHeight)}/${detail.length} lines · Esc reading`
      : 'Raw source data · ↑↓ scroll · PgUp/PgDn page · Esc reading', width - 2)}</Text></Box>
  </Box>;
}
