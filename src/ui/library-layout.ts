/** Fixed action columns survive every breakpoint; the title receives remaining cells. */
export function libraryColumns(width: number) {
  const time = width >= 74 ? 9 : 0;
  const source = width >= 60 ? 11 : 0;
  const project = width >= 110 ? width >= 145 ? 18 : 15 : 0;
  const messages = width >= 83 ? 7 : 0;
  const tools = width >= 140 ? 7 : 0;
  const actions = width >= 96 ? 26 : 23;
  return { width, cursor: 2, time, source, project, messages, tools, actions,
    title: Math.max(1, width - 2 - time - source - project - messages - tools - actions) };
}
export function libraryLayout(width: number, height: number, expanded: boolean) {
  const roomy = height >= 28 && width >= 80;
  const compact = height < 20;
  // Header+filters+table header, then contextual preview+status+keyboard footer.
  const top = roomy ? 11 : compact ? 6 : 8;
  const dock = compact ? 0 : expanded ? Math.min(8, Math.max(3, height - top - 7)) : 3;
  const bottom = dock + 3;
  return { roomy, compact, top, dock, bottom, body: Math.max(1, height - top - bottom), tableWidth: Math.max(1, width - 5) };
}
