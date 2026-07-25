# Agent notes

pi extension providing `/history` and the `browser_history` tool — search over
local browser history databases. See README.md for usage and architecture.

## Key facts

- Zero npm dependencies. Uses `node:sqlite` (Node ≥ 22), loaded by pi via jiti;
  no build step. Extension code must stay Node strip-types compatible (no
  parameter properties, no enums) so `test/*.ts` runs with plain `node`;
  relative imports need explicit `.ts` extensions.
- Installable as a pi package (`package.json` `pi.extensions` → `./extension/index.ts`;
  pi deps are `peerDependencies` per docs/packages.md). Locally installed by
  symlink: `~/.pi/agent/extensions/browser-history -> ./extension`. After edits,
  `/reload` in pi.
- `node_modules/@earendil-works/{pi-coding-agent,pi-tui,pi-ai}` and
  `node_modules/typebox` are symlinks into the global pi install so tests and
  editors resolve pi imports outside pi.
- Snapshot cache: `~/.pi/agent/browser-history/snapshots` (override with
  `PI_BROWSER_HISTORY_CACHE`). Safe to delete anytime; `/history --clear-cache`
  does it.

## Gotchas

- **Chromium locks its History db** (`locking_mode = EXCLUSIVE`), so reads fail
  while the browser runs — hence the mtime-keyed copies in `snapshot.ts`. Copies
  are opened read-only first, then read-write as a fallback so SQLite can roll
  back a hot journal captured mid-transaction. Never write to a live database.
- **`node:sqlite` returns integers as JS numbers** and throws `RangeError` above
  2^53. Chromium timestamps (µs since 1601) exceed that, so every epoch
  conversion happens in SQL (`last_visit_time / 1000 - 11644473600000`), never in
  JS. Time filters compare against the converted alias for the same reason.
- Engine differences live in `baseSelect()` only: Chromium `urls`, Firefox
  `moz_places`, Safari `history_items` + `history_visits` (titles live on visits;
  `v.title` beside `MAX(v.visit_time)` picks the latest visit's title). Filters
  are applied by wrapping that projection, so there is one condition builder.
- `hidden` column presence is probed per database (`PRAGMA table_info`) — old
  Chromium/Firefox schemas lack it.
- Terms are matched with `LIKE ... ESCAPE '\'` and `%`/`_`/`\` are escaped in
  `escapeLike`; host filters use a coarse `LIKE` prefilter plus exact
  host/subdomain matching in JS.
- Panel highlighting uses `String.split(/(term)/)`, whose match/non-match parity
  breaks if empty pieces are filtered out — keep them as `""` (regression test in
  `test/unit.ts`).
- Safari needs Full Disk Access; permission failures are surfaced per source via
  `describeOpenError` and never abort the whole query.
- Result quality depends on collapsing near-identical URLs (same host + path +
  title). Without it, Google Docs/dashboard query-string variants fill the list.

## Testing

- `node test/unit.ts` — parsing, SQL building, scoring, merging/collapsing,
  formatting, panel keys. Builds synthetic Chromium/Firefox databases in a temp
  dir; no pi and no real history needed.
- `node test/smoke.ts [query]` — real history: lists sources, runs sample
  queries, prints per-keystroke latency (expect ~10–50 ms).
- `node test/render.ts [query] [width]` — prints the panel with ANSI colours to
  eyeball layout and highlighting.
- End-to-end tool check without the TUI:
  `pi -ne -e ./extension/index.ts -t browser_history -p "use browser_history to find ..."`.
- Manual: run `pi` anywhere and use `/history`.
