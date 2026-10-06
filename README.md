# Trace reader

A local terminal browser for saved coding-agent sessions. Find the conversation, see what evidence it contains, inspect it, and export it for the reader we're building next.

**Developer preview · local only · no account or model API key.** No network requests are made by discovery, inspection, or export.

## Run it

Requires **Node 22.13 or newer**. Node 24 LTS is a good default. Node 22 may print an experimental warning for its built-in SQLite reader; there are no native addon builds or Python requirements.

```sh
npm ci
npm run build
npm start
```

For a global command from this checkout:

```sh
npm install -g .
trace-reader
```

For development, use `npm run dev`. To make an installable archive, use `npm pack`, then `npm install -g ./trace-reader-0.1.0.tgz`.

The package is **not published**. `npx trace-reader` is the intended release experience, not an available installation command today. The registry returned no package for this name on October 6, 2026; that does not reserve it. A scoped package is the fallback.

## Browse

The TUI opens in an alternate screen and restores the terminal when it exits. It has date-grouped sessions, source colors, a responsive metadata preview, and visible action buttons. It is keyboard-first; mouse clicking is not implemented.

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move between sessions |
| `/` | Search titles, project names, IDs, and preview metadata |
| `f` | Cycle source filters |
| `Enter` | Inspect the transcript |
| `e` | Export the current session to a `.trace.json` file in the working directory |
| `r` | Refresh discovery |
| `d` | Source diagnostics |
| `?` | Help |
| `Esc` | Back / clear search |
| `q` | Back, or quit from the list |

In the inspector, arrows scroll, Space/Page Down advances, and `g`/`G` jumps to the beginning/end. Exact counts are shown only when the reader has enough data; `—` means unknown in the TUI (`…` in plain lists). Opening a session reads more of its contents and updates the inspector counts.

## Commands

```sh
trace-reader list --agent codex --since 7d --json
trace-reader list --project trace-reader --limit 100 --no-cache
trace-reader search "auth retry"
trace-reader inspect LOCAL_ID
trace-reader scan --root ~/Downloads --recursive
trace-reader scan --root /custom/claude/projects --agent claude-code
trace-reader import ./session.jsonl
trace-reader export LOCAL_ID --out ./session.trace.json
trace-reader export --file ./session.jsonl --out ./session.trace.json
trace-reader doctor
trace-reader adapters --json
trace-reader roots
trace-reader cache path
trace-reader cache clear
```

Without a TTY, the default command becomes a finite plain list. `--json` produces one versioned object with scan completeness and diagnostics; warnings do not corrupt stdout. `--plain` forces the line-oriented view. `NO_COLOR=1` and `--no-color` disable styling.

Default discovery hides archived and explicit child sessions. Use `--include-archived` and `--include-children` to show them. For sessions found through custom roots, pass the same `--root` to subsequent `inspect`/`export` commands so they can be located again. IDs remain stable for the same physical source file or database row.

Exit codes: `0` success (including an empty completed scan), `1` operational failure, `2` invalid application arguments, `3` unsupported/invalid import, `4` partial scan or bounded import/export, `130` interrupted. Inspect the diagnostics as well as the exit code. Commander may use exit code `1` for its own option syntax errors.

## Implemented sources

| Source | Discovery | Status and limits |
| --- | --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR/projects`, `~/.claude/projects` | Preview. JSONL messages, tool calls/results, explicit subagents. Unknown records are retained. |
| Codex | `CODEX_HOME/{sessions,archived_sessions}`, `~/.codex/...` | Preview. JSONL rollouts, source metadata, tools, archive and lineage flags. Duplicate message notifications are not double-counted. Inherited-history references are reported but not followed. |
| Cursor | `~/.cursor/projects/.../agent-transcripts`, OS-specific Cursor `User/globalStorage` and `workspaceStorage` | Experimental. JSONL, legacy text, composer/bubble SQLite. Format is undocumented. File transcripts and database snapshots may represent the same conversation and appear separately. |
| Hermes | `HERMES_HOME`, platform default, named profiles | Preview. Read-only `state.db` sessions/messages. Unknown schemas produce diagnostics. Legacy JSONL trajectories are not indexed. |
| Explicit imports | Selected JSON files and `.trace.json` packages | Role/content arrays and our portable JSON format. Generic JSON is never automatically assumed to be a conversation. |

Run `adapters --json` for the source-linked registry. Compatibility is fixture-tested and smoke-tested on this Mac, not a guarantee across every vendor version or OS. CI is configured for Node 22/24 on macOS, Linux, and Windows; those remote jobs have not been run from this checkout.

There is no universal trace format. Known-store discovery does not crawl the whole home directory. Explicit recursive scans use structural recognition and bounded traversal; unsupported serialization, cloud-only conversations, deleted sessions, and histories that were never saved cannot be discovered. ChatGPT exports/ZIPs, compressed Codex rollouts, Gemini, OTLP, and other harnesses are future importers.

## Data handling

- Source transcripts and databases are read only. SQLite uses a consistent read transaction, committed WAL data, schema allowlists, query-only mode, and disabled extensions. Discovery never invokes a harness, resumes a task, or changes its settings.
- A replaceable metadata index stores bounded session metadata in the OS cache directory. `--no-cache` bypasses both reading and writing it. Cached rows appear immediately, then reconcile with the current scan. Incremental per-file invalidation is not implemented yet.
- Reads are bounded: 30 seconds by default, 100,000 candidate entries, depth 10, 32 MiB per inspected transcript, 4 MiB per JSONL record, and 30,000 parsed records/events. Discovery uses smaller head reads. The CLI reports omissions; it does not claim those previews are full captures.
- Traversal skips dependency/build folders and descendant symlinks. An explicitly selected root symlink resolves once. Network-mount detection is not implemented; point scans only at local folders you intend to inspect.
- Terminal control sequences and bidirectional override characters are removed from displayed text. Imported instructions are inert data.
- Export produces a versioned package with source-addressed events and raw evidence where available. It strips recognized credential patterns and home-directory prefixes. **This is heuristic scrubbing, not guaranteed anonymization. Review exports before sharing.** Large binary attachments and all arbitrary secret formats are not comprehensively detected.
- Export creates a private file, refuses accidental overwrite, and prevents replacing its source. `--force` atomically replaces an existing destination. Nothing is uploaded.

The first portable JSON schema is provisional. It is suitable for local round-trips; a browser importer and backend still need their own validation and compatibility gates. A snapshot digest is an identity aid, not a signature or authorization mechanism.

## Development

```sh
npm run check       # types, tests, build
npm run dev -- --no-cache
npm run build
node dist/cli.js --help
```

`src/adapters` owns vendor-specific formats. `src/core` owns bounded I/O, discovery, portable packages, and scrubbing. `src/ui` is a React/Ink view over those APIs. `src/cli.tsx` supplies both interactive and scriptable commands. This starts as one package; split browser-safe importers into workspace packages when the web surface exists.

Tests use synthetic fixtures created in temporary directories; no personal traces are checked in. They cover JSONL boundaries, role/tool semantics, IDs, profiles, live SQLite WAL data and unchanged source bytes, terminal safety, keyboard interactions at 80/120/160 columns, option propagation, overwrite protection, and export round-trips.

See [terminal library research](docs/tui-research.md) and [phase-one implementation notes](docs/phase-one.md). The two original planning documents remain as reference material, with their broader scope deferred.
