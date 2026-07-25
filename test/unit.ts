/**
 * Unit tests: query parsing, time parsing, SQL building, scoring/merging,
 * text formatting and panel key handling.
 *
 * Run: node test/unit.ts
 * Requires node_modules/@earendil-works symlinks (see AGENTS.md).
 */
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { formatResults, formatSources } from "../extension/format.ts";
import {
  HistoryPanel,
  ResultsList,
  styleWithTerms,
  type PanelAction,
} from "../extension/panel.ts";
import { normalizeHost, parseQuery } from "../extension/query.ts";
import { HistoryStore, buildQuery, hostOf, scoreEntry, urlKey } from "../extension/search.ts";
import type { HistoryEntry } from "../extension/search.ts";
import type { HistorySource } from "../extension/sources.ts";
import { formatDateTime, parseTime, relativeTime } from "../extension/time.ts";

const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);
const DAY = 86_400_000;

// --- time --------------------------------------------------------------------
assert.equal(parseTime("now", NOW), NOW);
assert.equal(parseTime("7d", NOW), NOW - 7 * DAY);
assert.equal(parseTime("6 hours ago", NOW), NOW - 6 * 3_600_000);
assert.equal(parseTime("2w", NOW), NOW - 14 * DAY);
assert.equal(parseTime("3mo", NOW), NOW - 90 * DAY);
assert.equal(parseTime("30m", NOW), NOW - 1_800_000);
assert.equal(parseTime("1y", NOW), NOW - 365 * DAY);
assert.equal(parseTime("garbage", NOW), undefined);
assert.equal(parseTime("5 fortnights", NOW), undefined, "unknown unit rejected");
assert.equal(new Date(parseTime("2026-07-01", NOW)!).getDate(), 1, "ISO date is local midnight");
assert.equal(new Date(parseTime("2026-07-01 14:30", NOW)!).getHours(), 14);
assert.equal(parseTime("today", NOW), new Date(NOW).setHours(0, 0, 0, 0));
assert.equal(parseTime("yesterday", NOW), new Date(NOW).setHours(0, 0, 0, 0) - DAY);

assert.equal(relativeTime(NOW - 30_000, NOW), "just now");
assert.equal(relativeTime(NOW - 5 * 60_000, NOW), "5m ago");
assert.equal(relativeTime(NOW - 3 * 3_600_000, NOW), "3h ago");
assert.equal(relativeTime(NOW - 4 * DAY, NOW), "4d ago");
assert.equal(relativeTime(NOW - 90 * DAY, NOW), "3mo ago");
assert.equal(relativeTime(NOW - 800 * DAY, NOW), "2y ago");

// --- query parsing -----------------------------------------------------------
const q1 = parseQuery('loki "chunk cache" -grafana site:GitHub.com since:7d in:chrome', NOW);
assert.deepEqual(q1.terms, ["loki", "chunk cache"]);
assert.deepEqual(q1.excluded, ["grafana"]);
assert.deepEqual(q1.hosts, ["github.com"]);
assert.deepEqual(q1.browsers, ["chrome"]);
assert.equal(q1.sinceMs, NOW - 7 * DAY);
assert.equal(q1.untilMs, undefined);
assert.equal(q1.text, "loki chunk cache");
assert.deepEqual(q1.errors, []);

const q2 = parseQuery("until:yesterday since:bogus http://example.com/x", NOW);
assert.equal(q2.untilMs, new Date(NOW).setHours(0, 0, 0, 0) - DAY);
assert.equal(q2.sinceMs, undefined);
assert.equal(q2.errors.length, 1, "bad time is reported, not thrown");
assert.deepEqual(q2.terms, ["http://example.com/x"], "unknown key: kept as a search term");

assert.deepEqual(parseQuery('site:"my site.com"', NOW).hosts, ["my site.com"], "quoted filter value");
assert.deepEqual(parseQuery("", NOW).terms, []);
assert.equal(normalizeHost("https://www.GitHub.com:443/foo?x=1"), "github.com");
assert.equal(normalizeHost("sub.example.com."), "sub.example.com");

// --- SQL building ------------------------------------------------------------
const built = buildQuery("chromium", parseQuery("loki -spam site:github.com since:1d", NOW), 100);
assert.match(built.sql, /FROM urls/);
assert.match(built.sql, /last_visit_time \/ 1000 - 11644473600000/);
assert.match(built.sql, /hidden = 0/);
assert.match(built.sql, /url LIKE \? ESCAPE '\\' OR title LIKE \?/);
assert.match(built.sql, /NOT LIKE/);
assert.deepEqual(built.params, [
  NOW - DAY,
  "%loki%",
  "%loki%",
  "%spam%",
  "%spam%",
  "%github.com%",
  100,
]);
assert.match(buildQuery("firefox", parseQuery("x", NOW), 10).sql, /moz_places/);
assert.match(buildQuery("safari", parseQuery("x", NOW), 10).sql, /history_visits/);
assert.doesNotMatch(
  buildQuery("chromium", parseQuery("x", NOW), 10, false).sql,
  /hidden = 0/,
  "hidden filter is skipped when the column is absent",
);
assert.deepEqual(buildQuery("chromium", parseQuery("50%_x", NOW), 10).params.slice(0, 2), [
  "%50\\%\\_x%",
  "%50\\%\\_x%",
], "LIKE wildcards in terms are escaped");

// --- url helpers -------------------------------------------------------------
assert.equal(hostOf("https://www.Example.com/a/b"), "example.com");
assert.equal(hostOf("not a url"), "");
assert.equal(urlKey("https://www.example.com/"), urlKey("https://example.com"));
assert.equal(urlKey("https://example.com/a/"), urlKey("https://example.com/a"));
assert.notEqual(urlKey("https://example.com/a#one"), urlKey("https://example.com/a#two"));

// --- scoring -----------------------------------------------------------------
const base = { title: "Loki docs", url: "https://grafana.com/docs/loki", host: "grafana.com", visits: 5 };
const fresh = scoreEntry({ ...base, lastVisitMs: NOW - 3_600_000 }, ["loki"], NOW);
const stale = scoreEntry({ ...base, lastVisitMs: NOW - 200 * DAY }, ["loki"], NOW);
assert(fresh > stale, "recent visits rank higher");
const titleHit = scoreEntry(
  { title: "Loki release notes", url: "https://x.test/a", host: "x.test", visits: 1, lastVisitMs: NOW },
  ["loki"],
  NOW,
);
const urlHit = scoreEntry(
  { title: "Release notes", url: "https://x.test/loki", host: "x.test", visits: 1, lastVisitMs: NOW },
  ["loki"],
  NOW,
);
assert(titleHit > urlHit, "title matches beat URL matches");
assert(
  scoreEntry({ ...base, visits: 200, lastVisitMs: NOW }, ["loki"], NOW) >
    scoreEntry({ ...base, visits: 1, lastVisitMs: NOW }, ["loki"], NOW),
  "frequent pages rank higher",
);

// --- HistoryStore over synthetic databases -----------------------------------
const dir = mkdtempSync(join(tmpdir(), "pi-browser-history-test-"));
const chromePath = join(dir, "History");
const firefoxPath = join(dir, "places.sqlite");
const CHROME_EPOCH_OFFSET = 11_644_473_600_000;

const chrome = new DatabaseSync(chromePath);
chrome.exec(
  `CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER,
                      last_visit_time INTEGER, hidden INTEGER DEFAULT 0)`,
);
const insertChrome = chrome.prepare(
  "INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?)",
);
const chromeTime = (ms: number): number => (ms + CHROME_EPOCH_OFFSET) * 1000;
insertChrome.run("https://github.com/grafana/loki/pull/1", "Fix chunk cache", 12, chromeTime(NOW - 3_600_000), 0);
insertChrome.run("https://example.com/hidden", "Hidden page", 1, chromeTime(NOW - 3_600_000), 1);
insertChrome.run("chrome://settings/", "Settings", 40, chromeTime(NOW - 60_000), 0);
insertChrome.run("https://grafana.com/docs/loki/", "Loki docs", 3, chromeTime(NOW - 40 * DAY), 0);
insertChrome.run("https://news.test/spam", "Loki spam", 1, chromeTime(NOW - 2 * DAY), 0);
// Same doc reached three ways: should collapse into one entry.
insertChrome.run("https://docs.test/d/1/edit?tab=t.0", "Loki design - Docs", 2, chromeTime(NOW - 3 * DAY), 0);
insertChrome.run("https://docs.test/d/1/edit?usp=drive_web", "Loki design - Docs", 1, chromeTime(NOW - 4 * DAY), 0);
insertChrome.run("https://docs.test/d/1/edit#heading=h.1", "Loki design - Docs", 3, chromeTime(NOW - 5 * DAY), 0);
chrome.close();

const firefox = new DatabaseSync(firefoxPath);
firefox.exec(
  `CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER,
                            last_visit_date INTEGER, hidden INTEGER DEFAULT 0)`,
);
const insertFirefox = firefox.prepare(
  "INSERT INTO moz_places (url, title, visit_count, last_visit_date, hidden) VALUES (?, ?, ?, ?, ?)",
);
// Same page as Chrome (trailing slash differs) plus a Firefox-only page.
insertFirefox.run("https://github.com/grafana/loki/pull/1/", "Fix chunk cache", 4, (NOW - 7_200_000) * 1000, 0);
insertFirefox.run("https://mozilla.test/loki", "Loki on Firefox", 2, (NOW - 5 * DAY) * 1000, 0);
firefox.close();

const sources: HistorySource[] = [
  {
    id: "chrome",
    browser: "chrome",
    profile: "Work",
    label: "chrome/Work",
    engine: "chromium",
    dbPath: chromePath,
    mtimeMs: NOW,
    size: 1,
  },
  {
    id: "firefox",
    browser: "firefox",
    profile: "default",
    label: "firefox/default",
    engine: "firefox",
    dbPath: firefoxPath,
    mtimeMs: NOW,
    size: 1,
  },
];

const store = new HistoryStore(sources);
const lokiQuery = parseQuery("loki", NOW);
const loki = store.search(lokiQuery, { now: NOW, limit: 10 });
assert.deepEqual(loki.errors, [], "both synthetic sources readable");
const urls = loki.entries.map((entry) => entry.url);
assert(urls.includes("https://github.com/grafana/loki/pull/1"), "chromium hit");
assert(urls.includes("https://mozilla.test/loki"), "firefox hit");
assert(!urls.some((url) => url.startsWith("chrome://")), "internal pages excluded");
assert(!urls.includes("https://example.com/hidden"), "hidden rows excluded");
const merged = loki.entries.find((entry) => entry.url.includes("/pull/1"))!;
assert.deepEqual(merged.sources.sort(), ["chrome/Work", "firefox/default"], "merged across browsers");
assert.equal(merged.visits, 16, "visit counts summed");
assert.equal(merged.lastVisitMs, NOW - 3_600_000, "most recent visit wins");
assert.equal(loki.entries[0]!.url, "https://github.com/grafana/loki/pull/1", "best hit first");
assert.equal(loki.sort, "relevance");

const recent = store.search(parseQuery("", NOW), { now: NOW, limit: 3 });
assert.equal(recent.sort, "recent", "empty query falls back to recency");
assert.equal(recent.entries[0]!.url, "https://github.com/grafana/loki/pull/1");

const siteFiltered = store.search(parseQuery("site:github.com", NOW), { now: NOW });
assert.equal(siteFiltered.totalMatches, 1, "host filter is exact (not substring)");

const excluded = store.search(parseQuery("loki -spam", NOW), { now: NOW });
assert(!excluded.entries.some((entry) => entry.url.includes("spam")), "exclusion applied");

const windowed = store.search(parseQuery("loki since:3d", NOW), { now: NOW });
assert(
  windowed.entries.every((entry) => entry.lastVisitMs >= NOW - 3 * DAY),
  "since filter applied",
);

const byBrowser = store.search(parseQuery("loki in:firefox", NOW), { now: NOW });
assert.deepEqual(byBrowser.sources.map((source) => source.id), ["firefox"], "in: filters sources");

const collapsed = loki.entries.filter((entry) => entry.host === "docs.test");
assert.equal(collapsed.length, 1, "query-string variants collapse into one entry");
assert.equal(collapsed[0]!.variants, 3, "variant count reported");
assert.equal(collapsed[0]!.visits, 6, "variant visits summed");
assert.equal(collapsed[0]!.url, "https://docs.test/d/1/edit?tab=t.0", "most recent variant represents");
assert.equal(
  store.search(lokiQuery, { now: NOW, limit: 50, collapse: false }).entries.filter(
    (entry) => entry.host === "docs.test",
  ).length,
  3,
  "collapse can be disabled",
);

const grouped = store.search(lokiQuery, { now: NOW, group: "site", limit: 10 });
const hosts = grouped.sites.map((site) => site.host);
assert(hosts.includes("github.com") && hosts.includes("grafana.com"), "sites grouped by host");
assert.equal(grouped.sites.find((site) => site.host === "github.com")!.pages, 1);

const visitSorted = store.search(lokiQuery, { now: NOW, sort: "visits", limit: 10 });
assert.equal(visitSorted.entries[0]!.visits, 16, "visits sort");

const unknownBrowser = store.search(parseQuery("loki in:netscape", NOW), { now: NOW });
assert.equal(unknownBrowser.entries.length, 0, "unknown browser filter matches nothing");
assert.match(
  unknownBrowser.errors[0]!.message,
  /available: chrome, firefox/,
  "unknown browser filter lists valid source ids",
);

const missing = new HistoryStore([{ ...sources[0]!, id: "gone", dbPath: join(dir, "nope.db") }]);
const missingResult = missing.search(lokiQuery, { now: NOW });
assert.equal(missingResult.errors.length, 1, "unreadable source reported, not thrown");
assert.equal(missingResult.entries.length, 0);
missing.close();

// --- formatting --------------------------------------------------------------
const text = formatResults(loki, lokiQuery, sources, NOW);
assert(text.startsWith("Browser history:"), "header");
assert(text.includes('query "loki"'), "query echoed");
assert(text.includes("https://github.com/grafana/loki/pull/1"), "urls listed");
assert(text.includes("16 visits"), "visit counts listed");
assert(text.includes("+2 similar urls"), "collapsed variants noted");
assert(/matching pages \(showing \d+\)/.test(formatResults(store.search(parseQuery("loki", NOW), { now: NOW, limit: 1 }), lokiQuery, sources, NOW)), "header pluralised with limit");
assert(text.includes(formatDateTime(NOW - 3_600_000)), "absolute timestamps listed");
assert(text.includes("1h ago"), "relative timestamps listed");

const emptyQuery = parseQuery("zzzznothing", NOW);
const emptyText = formatResults(store.search(emptyQuery, { now: NOW }), emptyQuery, sources, NOW);
assert(emptyText.includes("No matches"), "empty result explains itself");
assert(emptyText.includes("Syntax:"), "empty result documents the syntax");

const siteText = formatResults(grouped, lokiQuery, sources, NOW);
assert(siteText.includes("github.com — 1 page"), "site rows");
assert(siteText.includes("e.g. "), "site example page");

assert(formatSources(sources).includes("chrome"), "source listing");
assert.equal(formatSources([]), "No browser history databases found.");

store.close();
rmSync(dir, { recursive: true, force: true });

// --- panel -------------------------------------------------------------------
const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };

function makeEntries(count: number): HistoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://example.test/page-${i}`,
    title: `Page ${i} about loki`,
    host: "example.test",
    visits: i + 1,
    lastVisitMs: NOW - i * DAY,
    sources: ["chrome/Work"],
    variants: 1,
    score: 10 - i,
  }));
}

assert.equal(styleWithTerms("Loki docs", [], theme, "text", "warning"), "Loki docs");
assert.equal(styleWithTerms("Loki docs", ["loki"], theme, "text", "warning"), "Loki docs", "no-op theme");

const marks = {
  fg: (color: string, value: string) => (color === "warning" ? `[${value}]` : value),
  bold: (value: string) => value,
};
assert.equal(
  styleWithTerms("Loki docs about loki", ["loki"], marks, "text", "warning"),
  "[Loki] docs about [loki]",
  "matches highlighted, including at the start of the string",
);
assert.equal(
  styleWithTerms("Explore - Loki-Personal", ["loki"], marks, "text", "warning"),
  "Explore - [Loki]-Personal",
  "mid-string match highlighted",
);
assert.equal(
  styleWithTerms("a.b (c)", ["a.b", "(c)"], marks, "text", "warning"),
  "[a.b] [(c)]",
  "regex metacharacters in terms are escaped",
);

const list = new ResultsList(theme);
list.setEntries(makeEntries(9), ["loki"]);
let lines = list.render(100);
assert(lines.some((line) => line.includes("❯")), "selection marker");
assert(lines.some((line) => line.includes("Page 0 about loki")), "title rendered");
assert(lines.some((line) => line.includes("https://example.test/page-0")), "url rendered");
assert(lines.some((line) => line.includes("↓") && line.includes("more")), "scroll hint");

for (let i = 0; i < 20; i++) list.moveDown();
assert.equal(list.getSelected()!.url, "https://example.test/page-8", "clamped at the end");
lines = list.render(100);
assert(lines.some((line) => line.includes("↑") && line.includes("more")), "scrolled");
list.setEntries([], []);
assert(list.render(100).some((line) => line.includes("no matches")), "empty state");

const queries: string[] = [];
// Recorded rather than overwritten, so each assertion reads a fresh value
// (and TypeScript cannot narrow it away).
const actions: (PanelAction | null)[] = [];
const panel = new HistoryPanel({
  theme,
  initialQuery: "",
  runSearch: (query) => {
    queries.push(query);
    return { entries: makeEntries(query ? 3 : 1), terms: query.split(/\s+/).filter(Boolean), total: 42, notes: [] };
  },
  done: (result) => {
    actions.push(result);
  },
});
assert.deepEqual(queries, [""], "initial search");
panel.handleInput("l");
panel.handleInput("o");
assert.deepEqual(queries, ["", "l", "lo"], "search per keystroke");
assert.equal(panel.getQuery(), "lo");
assert(panel.render(100).some((line) => line.includes("3 of 42 pages")), "header counts");

panel.handleInput("\x1b[B"); // down
assert.equal(queries.at(-1), "lo", "navigation does not re-search");
panel.handleInput("\r");
assert.equal(actions.at(-1)?.type, "open");
assert.equal(actions.at(-1)?.entry.url, "https://example.test/page-1");

panel.handleInput("\t");
assert.equal(actions.at(-1)?.type, "copy");

panel.handleInput("\x1b[Z"); // shift+tab
assert.equal(actions.at(-1)?.type, "insert");

panel.handleInput("\x1b");
assert.equal(actions.at(-1), null, "escape cancels");
assert.equal(actions.length, 4, "one action per accepted key");

console.log("unit tests passed");
