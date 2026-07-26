# pi-browser-history

Search your **local browser history** from pi — find that page you visited last
week without remembering where it was.

Reads the history databases of every browser profile on the machine (Chrome,
Chromium, Edge, Brave, Arc, Vivaldi, Opera, Firefox, Safari), merges the same
page across browsers, and ranks by match quality + recency + visit count.
Everything is local and read-only; nothing is sent anywhere.

Two entry points:

- **`/history [query]`** — live search panel, results update on every keystroke.
- **`browser_history` tool** — the LLM can look pages up for you ("find the PR I
  was reading yesterday about chunk caching").

## Usage

```
/history                     most recently visited pages, type to search
/history loki chunk cache    prefill the panel with a query
/history --sources           list the history databases that were found
/history --clear-cache       delete cached database copies
```

Panel keys:

- type — refine the search (every keystroke re-queries)
- `↑`/`↓` (or `Ctrl+P`/`Ctrl+N`) — navigate results
- `Enter` — open the page in your default browser
- `Tab` — copy the URL to the clipboard
- `Shift+Tab` — append the URL (and title) to the pi prompt
- `Esc` — cancel

### Query syntax

The same syntax works in the panel and in the tool's `query` parameter:

| Syntax | Meaning |
| --- | --- |
| `loki chunk` | all bare terms must appear in the title or URL (case-insensitive) |
| `"exact phrase"` | phrase match, including spaces |
| `-grafana` | exclude pages matching this term |
| `site:github.com` | only this host and its subdomains |
| `since:7d` / `after:2026-07-01` | only visits at or after that time |
| `until:yesterday` / `before:2026-07-01 14:30` | only visits at or before that time |
| `in:chrome` / `in:ed-work` / `in:firefox` | only these browsers, profiles or source ids |

Times accept `30m`, `6h`, `7d`, `2w`, `3mo`, `1y` (optionally `... ago`), `now`,
`today`, `yesterday`, or local `YYYY-MM[-DD[ HH:MM]]`.

### Tool parameters

`browser_history` takes `query` plus optional `site`, `since`, `until`,
`browsers`, `limit` (default 25), `sort` (`relevance` | `recent` | `visits`) and
`group` (`page` | `site`). `group: "site"` aggregates per host — useful for
"which sites do I use for X". An empty query returns the most recent pages.

## Install

As a pi package — from the git remote, or from a local checkout:

```bash
pi install git:github.com/slim-bean/pi-browser          # tracks the default branch
pi install git:github.com/slim-bean/pi-browser@v0.1.0   # pinned tag
pi install /path/to/pi-browser                         # local checkout
pi -e git:github.com/slim-bean/pi-browser              # try it for one run
```

`pi install` records the source in `~/.pi/agent/settings.json` (use `-l` for
`.pi/settings.json` in the current project). You can also add it by hand — paths
are resolved relative to the settings file that contains them:

```json
{
  "packages": [
    "../../projects/pi-browser",
    "git:github.com/slim-bean/pi-browser@v0.1.0"
  ]
}
```

A local path is loaded in place, so edits apply on the next `/reload` — no
reinstall and no symlink needed. `pi list` shows what is configured.

Nothing is downloaded beyond the repo: the pi packages it imports
(`pi-coding-agent`, `pi-tui`, `pi-ai`, `typebox`) are `peerDependencies` that pi
provides at load time, and `.npmrc` (`legacy-peer-deps=true`) stops npm ≥ 7 from
fetching its own copies — without it, every git install pulls a second, unused
pi dependency tree (~300 MB).

Alternatively, symlink the `extension/` directory into pi's global extensions
dir:

```bash
ln -sfn "$(pwd)/extension" ~/.pi/agent/extensions/browser-history
```

Pick one mechanism, not both: two registrations make pi rename the command to
`/history:1` and `/history:2`.

Then `/reload` (or restart pi). No `npm install` needed — zero runtime
dependencies.

**Safari** history lives in `~/Library/Safari`, which is TCC-protected: your
terminal needs Full Disk Access (System Settings › Privacy & Security › Full
Disk Access). Without it, Safari is reported as unavailable and other browsers
still work.

## How it works

- **Discovery** (`sources.ts`): known per-platform install paths; Chromium
  profile display names come from `Local State`, Firefox profiles from
  `places.sqlite` in each profile dir. Every profile is a separate *source* with
  an id (`chrome/ed-work`) you can filter on.
- **Locked databases** (`snapshot.ts`): Chromium holds `History` with
  `locking_mode = EXCLUSIVE`, so a running Chrome makes even reads fail. Each
  source is opened directly first and, if that fails, copied to
  `~/.pi/agent/browser-history/snapshots/<id>-<mtime>-<size>/history.db` (with
  its `-wal`/`-shm`/`-journal` sidecars) and read from there. The copy is keyed
  by mtime + size, so it is only re-made after the browser writes; stale copies
  are pruned. Deleting the cache is always safe.
- **Search** (`search.ts`): no index to build. Each source is queried with
  parameterised `LIKE` conditions over a normalised `url, title, visits, ms`
  projection (one base query per engine, one shared condition builder), then
  results are merged and scored in JS. Timestamps are converted in SQL —
  Chromium µs since 1601, Firefox µs since 1970, Safari seconds since 2001.
- **Merging**: identical URLs across profiles collapse into one row (visits
  summed, most recent visit and its title kept, sources listed). Pages that
  share host + path + title but differ in query string/fragment also collapse
  (`?tab=`, `?usp=`, `#heading=` variants of one doc), reported as `+N similar
  urls`.
- **Ranking**: `3 × match + 2 × recency + frequency`, where match prefers title
  (1.0) over host (0.9), path (0.75) and query string (0.5), recency halves
  every 7 days and frequency saturates near 60 visits. `sort: "recent"` /
  `"visits"` bypass the blend; an empty query implies `recent`.
- **Speed**: full `LIKE` scans of ~10–20k rows per profile run in ~10–50 ms, so
  the panel can query on every keystroke. Snapshot copies (~50 ms for a 17 MB
  Chrome history) happen once per panel session, before the panel paints.

## Layout

```
extension/
  index.ts      entry: browser_history tool + /history command + actions
  sources.ts    browser/profile discovery per platform
  snapshot.ts   lock-safe opening, mtime-keyed database copies
  query.ts      query syntax parser (terms, -exclude, site:, since:, in:)
  time.ts       relative/ISO time parsing and formatting
  search.ts     per-engine SQL, merging, collapsing, scoring, HistoryStore
  format.ts     compact text output for the LLM
  panel.ts      live TUI search panel
test/
  unit.ts       parsing, SQL building, scoring, merging, formatting, panel keys
                (synthetic SQLite databases; node test/unit.ts)
  smoke.ts      real history: sources, sample queries, keystroke latency
                (node test/smoke.ts [query])
  render.ts     prints the panel with colours for visual checks
                (node test/render.ts [query] [width])
```

## Roadmap

- Bookmarks and open tabs as additional sources.
- Full-page-text search via an optional local index of visited pages.
- `frecency`-style ranking using per-visit rows instead of aggregate counts.
