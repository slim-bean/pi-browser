# pi-browser-history

Search your **local browser history** from pi — find that page you visited last
week without remembering where it was.

Reads the history databases of every browser profile on the machine (Chrome,
Chromium, Edge, Brave, Arc, Vivaldi, Opera, Firefox, Safari), merges the same
page across browsers, and ranks by match quality + recency + visit count.
History access is read-only. By default, queries run locally; optional remote mode
queries your configured browser-fetch gateway. Tool results are provided to the LLM.

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

## Additional browser profiles

Dedicated automation profiles outside normal browser installation paths can be
included explicitly. Set `PI_BROWSER_HISTORY_CHROMIUM_ROOTS` to a JSON array:

```bash
export PI_BROWSER_HISTORY_CHROMIUM_ROOTS='[{"browser":"assistant","dir":"~/.local/share/pi-assistant/chrome-profile"}]'
```

`dir` is the Chromium **user-data directory** (containing `Default/History`, not
`History` itself). `browser` is a lowercase source id used in attribution and
`in:assistant` / `browsers: ["assistant"]` filters. Ordinary browser sources remain
enabled; duplicate database paths are read only once. Invalid configuration produces
an explicit error. Missing/empty profiles appear once Chrome writes history. Chrome
on a remote machine requires access to its history files; CDP alone does not make
them local.

For integrations/tests, `discoverSources({extraChromiumRoots, includeDefaults})`
accepts the same objects; defaults are included unless explicitly disabled. History
records a visit, not proof that a human read or endorsed a page. `/history` Enter
still opens the OS default browser; assistant tools select their live tabs separately.

## Remote browser history (same gateway port as CDP/fetch)

```bash
export PI_BROWSER_HISTORY_URL=http://browser-fetch.browser-test.svc.cluster.local:8377
export PI_BROWSER_HISTORY_TOKEN_FILE=/run/secrets/browser-fetch/token
# Or PI_BROWSER_HISTORY_TOKEN=…
```

When configured, `browser_history` obtains source metadata and normalized records
from the gateway's native **history protocol v2**, not local databases. The tool's
parameters/query syntax are unchanged. Query parsing, exact-host filtering, merging,
ranking, grouping and formatting happen here, using the same pipeline as local
history—not in the server. Authentication/network/database failures never fall back
to unrelated local history. Token files take precedence; redirects are refused.
Each HTTP response is capped at 8 MiB and 20 seconds. Remote searches share a 20,000
candidate budget across selected profiles and retain at most 16 MiB of row text.
Truncation is explicit; narrow filters before treating counts/rankings as complete.
Use the gateway's **root token**; reader/driver credentials don't grant history.

`/history <query>` prints a remote result rather than opening the local live-search
panel; `/history --sources` lists remote source labels. Remote cache maintenance is
server-owned, so `--clear-cache` does not clear local or remote files in remote mode.
Unset the remote URL to return to ordinary local behavior.

### Independent server/client implementations

browser-fetch reads only its operator-configured Chromium history root, using a
native Go SQLite reader. It does not install this extension, run Node, or return
agent-formatted text. This extension uses `GET /history/sources` and sends structured
prefilters to `POST /history/query` (version 2, sourceId, terms/excluded/hosts, absolute
millisecond bounds, candidate limit). The result is bounded records, not a database
or profile download. The server's `hosts` filter is coarse; shared client-side
processing does exact host/subdomain checks before presenting results. Date strings
and display times use the **client's** timezone (as local history does); the wire
carries absolute Unix milliseconds. Set the agent's TZ if you need a specific zone.

Remote source IDs/labels are directory-based (`assistant/Default`, etc.); local
sources can still use browser display names. Use `/history --sources` for available
IDs or `in:assistant` for the source family. There is no per-request path or SQL input.

**Migration:** `bin/history.ts` and its helper protocol were removed. Use a native-v2
browser-fetch image with `BROWSER_FETCH_HISTORY_ROOT`; remove old server helper env
settings/build args. Old server responses are rejected with update advice—there is
no v1 helper fallback. Local history configuration/behavior stays intact. Once on v2,
client formatting/ranking updates no longer require rebuilding browser-fetch.

The extension advertises `{remoteHistory: true, historyProtocol: 2}` through
`pi-browser:capabilities:v1`. Unit tests: `node --test test/*.test.ts`.

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
    "../../projects/pi-extensions/pi-browser",
    "git:github.com/slim-bean/pi-browser@v0.1.0"
  ]
}
```

A local path is loaded in place, so edits apply on the next `/reload` — no
reinstall and no symlink needed. `pi list` shows what is configured.

Nothing is downloaded beyond the repo: the pi packages it imports
(`pi-coding-agent`, `pi-tui`, `pi-ai`, `typebox`) are `peerDependencies` marked
`optional` in `peerDependenciesMeta`, because pi injects them at load time.
Without that marker npm ≥ 7 auto-installs them, and every git install drags in a
second, unused pi dependency tree (~300 MB).

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
  api.ts        shared validated query/result contract
  remote.ts     native v2 record client; uses the shared local ranking/formatting pipeline
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
