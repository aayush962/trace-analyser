import type { Session, TraceEvent, Transcript, ScanResult } from './core/types.js';

/** Hand-authored synthetic sessions. No local trace or account is read. */
export function demoTraces(): Transcript[] {
  const specs = [
    ['Checkout retries after an expired token — investigate the failure and verify recovery', 'claude-code', 'storefront'],
    ['Make the command palette keyboard accessible', 'codex', 'workbench'],
    ['Investigate a slow search query', 'cursor', 'atlas'],
    ['Prepare release notes from the changelog', 'hermes', 'hermes'],
  ] as const;
  return specs.map(([title, agent, project], n) => {
    const scenario = [
      { file: 'src/checkout.ts', test: 'checkout', request: 'Checkout intermittently fails after a session expires. Find the cause, fix it, and verify the recovery path.',
        error: 'FAIL checkout › expired token\nExpected: 200\nReceived: 401\n\nThe request reused the expired token.',
        correction: 'Please check whether the retry uses the refreshed token, rather than just re-running the tests.',
        diagnosis: 'The retry closes over the original token. I’ll pass the refreshed token explicitly and add a regression test.',
        result: 'PASS checkout\n  ✓ refreshes expired token\n  ✓ retries the request once\n  ✓ surfaces a second failure\n\n3 tests passed.',
        response: 'The retry now uses the refreshed token. The three focused tests pass, including the new expired-token regression. I have not run the full integration suite.' },
      { file: 'src/command-palette.tsx', test: 'command-palette', request: 'Make the command palette fully keyboard accessible. Focus should return to the trigger after closing it.',
        error: 'FAIL palette › restores focus\nExpected: trigger button\nReceived: document.body',
        correction: 'Check what happens when Escape closes the palette, including where focus goes.',
        diagnosis: 'The close handler removes the dialog before restoring focus. I’ll keep a reference to the trigger.',
        result: 'PASS command-palette\n  ✓ focuses the search field\n  ✓ navigates results\n  ✓ restores focus on Escape',
        response: 'Keyboard focus returns to the trigger on Escape. The focused tests pass. Screen-reader behavior still needs a manual check.' },
      { file: 'src/search.ts', test: 'search', request: 'Search slows down on large projects. Find the expensive step and add a regression check.',
        error: 'FAIL search › large project\nExpected: fewer than 1000 inspected documents\nReceived: 12000',
        correction: 'Look at how candidate documents are selected before ranking.',
        diagnosis: 'The query ranks every document before filtering candidates. I’ll filter first and test the work performed.',
        result: 'PASS search\n  ✓ filters candidates before ranking\n  ✓ preserves result order\n  ✓ handles empty queries',
        response: 'Candidate filtering now happens before ranking. The work-count regression passes; end-to-end latency has not been measured.' },
      { file: 'CHANGELOG.md', test: 'release-notes', request: 'Prepare release notes from the changelog. Keep breaking changes explicit and verify the links.',
        error: '', correction: 'Please separate breaking changes from fixes and mention migration steps.',
        diagnosis: 'I’ll group the changes and verify the links again after the edits.',
        result: 'PASS release-notes\n  ✓ links resolve in the local docs index\n  ✓ version matches\n  ✓ migration section present',
        response: 'The release notes are drafted with breaking changes, migration steps and fixes. Local link checks pass. Nothing has been published.' },
    ][n];
    const now = Date.now() - n * 86_400_000;
    const events: TraceEvent[] = [];
    const add = (kind: TraceEvent['kind'], role: string, text: string, raw?: unknown) => {
      const i = events.length;
      events.push({ id: `demo-${n}-${i}`, kind, role, text, timestamp: new Date(now + i * 12_000).toISOString(), source: { line: i + 1 }, raw });
    };
    add('message', 'user', scenario.request,
      { type: 'user', message: { role: 'user', content: scenario.request } });
    add('message', 'assistant', `I’ll inspect ${scenario.file}, then run the focused checks.`);
    add('tool-call', 'assistant', `Read\n${JSON.stringify({ file_path: scenario.file })}`, { type: 'tool_use', id: `read-${n}`, name: 'Read', input: { file_path: scenario.file } });
    add('tool-result', 'tool', `Read ${scenario.file}.\n(Synthetic source excerpt.)`, { type: 'tool_result', tool_use_id: `read-${n}`, content: 'Synthetic source excerpt', is_error: false });
    for (let i = 0; i < 3; i++) {
      add('tool-call', 'assistant', `Bash\n${JSON.stringify({ command: `npm test -- ${scenario.test}` })}`, { type: 'tool_use', id: `test-${n}-${i}`, name: 'Bash', input: { command: `npm test -- ${scenario.test}` } });
      const failed = i < 2 && n !== 3;
      add('tool-result', 'tool', failed ? scenario.error : scenario.result,
        { type: 'tool_result', tool_use_id: `test-${n}-${i}`, is_error: failed, content: failed ? scenario.error : scenario.result });
      if (i === 1) {
        add('message', 'user', scenario.correction);
        add('message', 'assistant', scenario.diagnosis);
        add('tool-call', 'assistant', `Edit\n${JSON.stringify({ file_path: scenario.file })}`, { type: 'tool_use', id: `edit-${n}`, name: 'Edit', input: { file_path: scenario.file } });
        add('tool-result', 'tool', `Updated ${scenario.file} and its checks.`, { type: 'tool_result', tool_use_id: `edit-${n}`, is_error: false, content: `Updated ${scenario.file} and its checks.` });
      }
    }
    add('message', 'assistant', scenario.response);
    const session: Session = { id: `demo-${n}`, nativeId: `synthetic-${n}`, agent, title, project, cwd: `/demo/${project}`,
      startedAt: events[0].timestamp, updatedAt: events.at(-1)!.timestamp, timeSource: 'recorded',
      messages: events.filter(e => e.kind === 'message').length, toolCalls: events.filter(e => e.kind === 'tool-call').length,
      bytes: 4096, archived: false, parentId: null, preview: events[0].text, warnings: ['Synthetic demonstration. These events were authored for the demo.'],
      evidence: 'messages + tools', locator: { path: `/synthetic-demo/${n}.jsonl`, root: '/synthetic-demo', format: 'synthetic' } };
    return { session, events, truncated: false, warnings: session.warnings };
  });
}

/** A fuller library for trying table navigation; every entry is still synthetic. */
export function demoLibraryTraces(): Transcript[] {
  const titles = [
    ['Review token refresh and retry behavior', 'Add regression coverage for expired checkout sessions'],
    ['Restore keyboard focus when the command palette closes', 'Verify Escape and arrow-key navigation in the command palette'],
    ['Move candidate filtering ahead of search ranking', 'Check search behavior on a large project'],
    ['Review breaking changes and migration steps', 'Check release-note links before publishing'],
  ];
  return demoTraces().flatMap((trace, n) => [trace, ...titles[n].map((title, i) => {
    const offset = (i + 1) * 37 * 60_000;
    const events = trace.events.map(e => ({ ...e, timestamp: e.timestamp ? new Date(Date.parse(e.timestamp) - offset).toISOString() : null }));
    return { ...trace, events, session: { ...trace.session, id: `${trace.session.id}-sample-${i}`, nativeId: `${trace.session.nativeId}-sample-${i}`, title,
      startedAt: events[0].timestamp, updatedAt: events.at(-1)!.timestamp } };
  })]);
}

export async function scanDemo(traces: Transcript[], emit: (s: Session) => void, signal: AbortSignal): Promise<ScanResult> {
  const found: Session[] = [];
  const started = Date.now();
  for (const trace of traces) {
    if (signal.aborted) break;
    await new Promise(resolve => setTimeout(resolve, 100));
    if (signal.aborted) break;
    emit(trace.session); found.push(trace.session);
  }
  return { schemaVersion: 'trace-reader-cli/1', sessions: found,
    scan: { complete: !signal.aborted, rootsChecked: 0, filesScanned: 0, skipped: 0, durationMs: Date.now() - started, stopReason: 'Synthetic demo; no stores accessed' },
    diagnostics: [{ agent: 'generic', level: 'info', path: 'Built-in demo', message: 'Synthetic events only. No local stores or model providers were accessed.' }] };
}
