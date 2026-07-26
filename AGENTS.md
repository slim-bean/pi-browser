# Agent notes

pi extension providing `/history` and the `browser_history` tool — search over
local browser history databases. See README.md for usage and architecture.

## Key facts

- Zero npm dependencies. Uses `node:sqlite` (Node ≥ 22), loaded by pi via jiti;
  no build step. Extension code must stay Node strip-types compatible (no
  parameter properties, no enums) so `test/*.ts` runs with plain `node`;
  relative imports need explicit `.ts` extensions.
- Installable as a pi package (`package.json` `pi.extensions` → `./extension/index.ts`;
  pi deps are `peerDependencies` per docs/packages.md) via
  `pi install git:github.com/slim-bean/pi-browser[@tag]`. **Currently installed
  as a local package**: `"../../projects/pi-browser"` in `~/.pi/agent/settings.json`
  `packages` (paths resolve relative to that file). Loaded in place, so edits
  need only `/reload`. A symlink in `~/.pi/agent/extensions/` is the alternative
  — never both, or the command becomes `/history:1` and `/history:2`.
- Every non-`node:` import must be in `peerDependencies`: `pi-coding-agent`,
  `pi-tui`, `pi-ai` (`StringEnum`), `typebox` (`Type`). pi's jiti loader aliases
  all of them to its own copies (`dist/core/extensions/loader.js`), so they must
  never be installed here — npm ≥ 7 auto-installs root peer deps, which for a git
  install means a second, unused pi tree (53 packages, ~300 MB). Each peer is
  therefore marked `optional` in **`peerDependenciesMeta`**, which npm, pnpm and
  yarn all read as "do not install this; the host provides it".
  Do not use an `.npmrc` `omit=peer` for this: pi installs git packages with
  `npm install --omit=dev`, and a CLI `--omit` *replaces* the `omit` array from
  `.npmrc`. (`legacy-peer-deps=true` also works but is a blunt project-wide
  switch that disables peer conflict detection for real dependencies too; pi
  itself passes `--legacy-peer-deps` for npm-source packages, not git ones.)
  Verify after changing peers: `git clone` to a temp dir,
  `npm install --omit=dev`, expect no `node_modules`.
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
- Typecheck (no local typescript dep): install `typescript` + `@types/node`
  somewhere, symlink `node_modules/@types` to it, then `tsc -p .`
  (`tsconfig.json` covers `extension/` and `test/`).
- End-to-end tool check without the TUI:
  `pi -ne -e ./extension/index.ts -t browser_history -p "use browser_history to find ..."`.
- Manual: run `pi` anywhere and use `/history`.
