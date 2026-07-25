/**
 * Cross-browser history search.
 *
 * Each source is queried directly with parameterised LIKE conditions (no index
 * to build or keep fresh), then results are merged by URL, scored in JS and
 * sorted. Histories are small enough — tens of thousands of rows — that a full
 * scan per query stays in the low tens of milliseconds.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Group, ParsedQuery, Sort } from "./query.ts";
import { describeOpenError, openHistoryDb } from "./snapshot.ts";
import { filterSources, type Engine, type HistorySource } from "./sources.ts";

const DAY = 86_400_000;

/** Pages behind these schemes are browser UI, not visited web pages. */
const INTERNAL_SCHEMES = [
  "chrome:",
  "chrome-extension:",
  "chrome-untrusted:",
  "chrome-search:",
  "chrome-devtools:",
  "devtools:",
  "edge:",
  "brave:",
  "vivaldi:",
  "opera:",
  "arc:",
  "about:",
  "moz-extension:",
  "safari-extension:",
  "safari-resource:",
  "data:",
  "blob:",
  "javascript:",
  "view-source:",
];

export interface HistoryEntry {
  url: string;
  title: string;
  host: string;
  /** Summed visit count across matching sources. */
  visits: number;
  lastVisitMs: number;
  /** Source labels the page was found in, e.g. ["chrome/Ed Work"]. */
  sources: string[];
  /** How many near-identical URLs collapsed into this entry (1 = none). */
  variants: number;
  score: number;
}

export interface SiteEntry {
  host: string;
  pages: number;
  visits: number;
  lastVisitMs: number;
  sources: string[];
  exampleUrl: string;
  exampleTitle: string;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  sort?: Sort;
  group?: Group;
  /** Collapse same-title pages that differ only in query string / fragment (default true). */
  collapse?: boolean;
  /** Max rows read per source before giving up on completeness. */
  candidateLimit?: number;
  now?: number;
  /** Include browser-internal pages (chrome://, about:, extensions). */
  includeInternal?: boolean;
}

export interface SourceError {
  source: string;
  message: string;
}

export interface SearchResult {
  entries: HistoryEntry[];
  sites: SiteEntry[];
  /** Unique matching pages before the limit was applied. */
  totalMatches: number;
  /** Sources actually read for this query. */
  sources: { id: string; label: string; copied: boolean }[];
  errors: SourceError[];
  /** True when a source hit `candidateLimit` and results may be incomplete. */
  truncated: boolean;
  elapsedMs: number;
  sort: Sort;
  group: Group;
  limit: number;
}

interface RawRow {
  url: string;
  title: string;
  visits: number;
  ms: number;
  sourceLabel: string;
}

/** Normalised base query per engine: url, title, visits, ms (epoch millis). */
function baseSelect(engine: Engine, hasHiddenColumn: boolean): string {
  if (engine === "chromium") {
    // Chromium stores microseconds since 1601-01-01.
    return `SELECT url AS url, IFNULL(title, '') AS title, visit_count AS visits,
                   CAST(last_visit_time / 1000 - 11644473600000 AS INTEGER) AS ms
            FROM urls
            WHERE last_visit_time > 0${hasHiddenColumn ? " AND hidden = 0" : ""}`;
  }
  if (engine === "firefox") {
    // Firefox stores microseconds since the Unix epoch.
    return `SELECT url AS url, IFNULL(title, '') AS title, visit_count AS visits,
                   CAST(last_visit_date / 1000 AS INTEGER) AS ms
            FROM moz_places
            WHERE last_visit_date IS NOT NULL${hasHiddenColumn ? " AND hidden = 0" : ""}`;
  }
  // Safari stores seconds since 2001-01-01, and titles live on visits.
  // `v.title` next to MAX(v.visit_time) resolves to the latest visit's row.
  return `SELECT i.url AS url, IFNULL(v.title, '') AS title, i.visit_count AS visits,
                 CAST((MAX(v.visit_time) + 978307200) * 1000 AS INTEGER) AS ms
          FROM history_items i JOIN history_visits v ON v.history_item = i.id
          GROUP BY i.id`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function likePattern(value: string): string {
  return `%${escapeLike(value)}%`;
}

export interface BuiltQuery {
  sql: string;
  params: (string | number)[];
}

/** Wrap the engine's base select with the query's filters. */
export function buildQuery(
  engine: Engine,
  query: ParsedQuery,
  candidateLimit: number,
  hasHiddenColumn = true,
): BuiltQuery {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.sinceMs !== undefined) {
    conditions.push("ms >= ?");
    params.push(Math.round(query.sinceMs));
  }
  if (query.untilMs !== undefined) {
    conditions.push("ms <= ?");
    params.push(Math.round(query.untilMs));
  }
  for (const term of query.terms) {
    conditions.push("(url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')");
    params.push(likePattern(term), likePattern(term));
  }
  for (const term of query.excluded) {
    conditions.push("(url NOT LIKE ? ESCAPE '\\' AND title NOT LIKE ? ESCAPE '\\')");
    params.push(likePattern(term), likePattern(term));
  }
  if (query.hosts.length > 0) {
    // Coarse pre-filter; exact host/subdomain matching happens in JS.
    conditions.push(
      `(${query.hosts.map(() => "url LIKE ? ESCAPE '\\'").join(" OR ")})`,
    );
    for (const host of query.hosts) params.push(likePattern(host));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(candidateLimit);
  return {
    sql: `SELECT url, title, visits, ms FROM (${baseSelect(engine, hasHiddenColumn)})
          ${where}
          ORDER BY ms DESC
          LIMIT ?`,
    params,
  };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isInternal(url: string): boolean {
  const lower = url.toLowerCase();
  return INTERNAL_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

function matchesHost(host: string, wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  return wanted.some((filter) => host === filter || host.endsWith(`.${filter}`));
}

/** Merge key: same page seen in several browsers should collapse into one row. */
export function urlKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

/** Same page reached through different query strings / fragments. */
function collapseKey(entry: HistoryEntry): string {
  const title = entry.title.trim().toLowerCase();
  try {
    const parsed = new URL(entry.url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${entry.host}${path}\u0000${title}`;
  } catch {
    return `${entry.url}\u0000${title}`;
  }
}

/**
 * Merge entries that share host, path and title. Docs, dashboards and search
 * pages otherwise fill the results with `?tab=`/`?usp=` variants of one page.
 * The most recently visited URL represents the group.
 */
export function collapseSimilar(entries: HistoryEntry[]): HistoryEntry[] {
  const groups = new Map<string, HistoryEntry>();
  for (const entry of entries) {
    const key = collapseKey(entry);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, entry);
      continue;
    }
    const keep = existing.lastVisitMs >= entry.lastVisitMs ? existing : entry;
    const drop = keep === existing ? entry : existing;
    keep.visits += drop.visits;
    keep.variants += drop.variants;
    if (!keep.title && drop.title) keep.title = drop.title;
    for (const source of drop.sources) {
      if (!keep.sources.includes(source)) keep.sources.push(source);
    }
    groups.set(key, keep);
  }
  return [...groups.values()];
}

/**
 * Where a term matched, best field first. Path matches (`/grafana/loki/pull/1`)
 * are meaningful; query-string matches are usually incidental.
 */
function termScore(term: string, title: string, url: string, host: string): number {
  const needle = term.toLowerCase();
  if (title.toLowerCase().includes(needle)) return 1;
  if (host.includes(needle)) return 0.9;
  const lower = url.toLowerCase();
  const queryStart = lower.indexOf("?");
  const path = queryStart === -1 ? lower : lower.slice(0, queryStart);
  if (path.includes(needle)) return 0.75;
  if (lower.includes(needle)) return 0.5;
  return 0;
}

/**
 * Blend match quality, recency and visit frequency.
 * Recency halves every 7 days; frequency saturates around 60 visits.
 */
export function scoreEntry(
  entry: { title: string; url: string; host: string; visits: number; lastVisitMs: number },
  terms: string[],
  now: number,
): number {
  let match = 1;
  if (terms.length > 0) {
    let total = 0;
    for (const term of terms) total += termScore(term, entry.title, entry.url, entry.host);
    match = total / terms.length;
    if (terms.length > 1 && entry.title.toLowerCase().includes(terms.join(" ").toLowerCase())) {
      match = Math.min(1.2, match + 0.2);
    }
  }
  const ageDays = Math.max(0, (now - entry.lastVisitMs) / DAY);
  const recency = 1 / (1 + ageDays / 7);
  const frequency = Math.min(1, Math.log1p(Math.max(0, entry.visits)) / Math.log1p(60));
  return 3 * match + 2 * recency + frequency;
}

function sortEntries(entries: HistoryEntry[], sort: Sort): HistoryEntry[] {
  const compare: Record<Sort, (a: HistoryEntry, b: HistoryEntry) => number> = {
    relevance: (a, b) => b.score - a.score || b.lastVisitMs - a.lastVisitMs,
    recent: (a, b) => b.lastVisitMs - a.lastVisitMs,
    visits: (a, b) => b.visits - a.visits || b.lastVisitMs - a.lastVisitMs,
  };
  return entries.sort(compare[sort]);
}

function groupSites(entries: HistoryEntry[], sort: Sort): SiteEntry[] {
  const sites = new Map<string, SiteEntry>();
  for (const entry of entries) {
    const host = entry.host || "(unknown)";
    const site = sites.get(host);
    if (!site) {
      sites.set(host, {
        host,
        pages: 1,
        visits: entry.visits,
        lastVisitMs: entry.lastVisitMs,
        sources: [...entry.sources],
        exampleUrl: entry.url,
        exampleTitle: entry.title,
        score: entry.score,
      });
      continue;
    }
    site.pages++;
    site.visits += entry.visits;
    if (entry.lastVisitMs > site.lastVisitMs) {
      site.lastVisitMs = entry.lastVisitMs;
    }
    if (entry.score > site.score) {
      site.score = entry.score;
      site.exampleUrl = entry.url;
      site.exampleTitle = entry.title;
    }
    for (const source of entry.sources) {
      if (!site.sources.includes(source)) site.sources.push(source);
    }
  }
  const list = [...sites.values()];
  for (const site of list) site.score += 0.5 * Math.log1p(site.pages);
  const compare: Record<Sort, (a: SiteEntry, b: SiteEntry) => number> = {
    relevance: (a, b) => b.score - a.score || b.lastVisitMs - a.lastVisitMs,
    recent: (a, b) => b.lastVisitMs - a.lastVisitMs,
    visits: (a, b) => b.visits - a.visits || b.lastVisitMs - a.lastVisitMs,
  };
  return list.sort(compare[sort]);
}

interface Handle {
  db?: DatabaseSync;
  error?: string;
  copied: boolean;
  hasHiddenColumn: boolean;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
    return rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}

/**
 * Holds lazily-opened history databases. Reuse one store for a burst of
 * queries (the live panel) and `close()` when done.
 */
export class HistoryStore {
  private readonly sources: HistorySource[];
  private readonly handles = new Map<string, Handle>();

  constructor(sources: HistorySource[]) {
    this.sources = sources;
  }

  getSources(): HistorySource[] {
    return this.sources;
  }

  private handle(source: HistorySource): Handle {
    const cached = this.handles.get(source.id);
    if (cached) return cached;
    let handle: Handle;
    try {
      const opened = openHistoryDb(source);
      handle = {
        db: opened.db,
        copied: opened.copied,
        hasHiddenColumn:
          source.engine === "safari"
            ? false
            : hasColumn(opened.db, source.engine === "firefox" ? "moz_places" : "urls", "hidden"),
      };
    } catch (error) {
      handle = { error: describeOpenError(source, error), copied: false, hasHiddenColumn: false };
    }
    this.handles.set(source.id, handle);
    return handle;
  }

  search(query: ParsedQuery, options: SearchOptions = {}): SearchResult {
    const started = Date.now();
    const now = options.now ?? started;
    const limit = Math.max(1, options.limit ?? 25);
    const candidateLimit = Math.max(limit, options.candidateLimit ?? 20_000);
    const group: Group = options.group ?? "page";
    // Without search terms, "relevance" degrades to "most recently visited".
    const sort: Sort = options.sort ?? (query.terms.length > 0 ? "relevance" : "recent");

    const active = filterSources(this.sources, query.browsers);
    const errors: SourceError[] = [];
    if (active.length === 0 && this.sources.length > 0) {
      errors.push({
        source: query.browsers.join(", "),
        message: `no such browser or profile; available: ${this.sources.map((source) => source.id).join(", ")}`,
      });
    }
    const used: { id: string; label: string; copied: boolean }[] = [];
    const rows: RawRow[] = [];
    let truncated = false;

    for (const source of active) {
      const handle = this.handle(source);
      if (!handle.db) {
        errors.push({ source: source.label, message: handle.error ?? "unavailable" });
        continue;
      }
      const built = buildQuery(source.engine, query, candidateLimit, handle.hasHiddenColumn);
      try {
        const result = handle.db.prepare(built.sql).all(...built.params) as {
          url: string;
          title: string;
          visits: number;
          ms: number;
        }[];
        if (result.length >= candidateLimit) truncated = true;
        for (const row of result) {
          rows.push({
            url: row.url,
            title: row.title ?? "",
            visits: Number(row.visits ?? 0),
            ms: Number(row.ms ?? 0),
            sourceLabel: source.label,
          });
        }
        used.push({ id: source.id, label: source.label, copied: handle.copied });
      } catch (error) {
        errors.push({ source: source.label, message: String((error as Error)?.message ?? error) });
      }
    }

    const merged = new Map<string, HistoryEntry>();
    for (const row of rows) {
      if (!options.includeInternal && isInternal(row.url)) continue;
      const host = hostOf(row.url);
      if (!matchesHost(host, query.hosts)) continue;

      const key = urlKey(row.url);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          url: row.url,
          title: row.title,
          host,
          visits: row.visits,
          lastVisitMs: row.ms,
          sources: [row.sourceLabel],
          variants: 1,
          score: 0,
        });
        continue;
      }
      existing.visits += row.visits;
      if (row.ms > existing.lastVisitMs) {
        existing.lastVisitMs = row.ms;
        existing.url = row.url;
        if (row.title) existing.title = row.title;
      } else if (!existing.title && row.title) {
        existing.title = row.title;
      }
      if (!existing.sources.includes(row.sourceLabel)) existing.sources.push(row.sourceLabel);
    }

    const entries =
      options.collapse === false ? [...merged.values()] : collapseSimilar([...merged.values()]);
    for (const entry of entries) entry.score = scoreEntry(entry, query.terms, now);
    sortEntries(entries, sort);

    return {
      entries: entries.slice(0, limit),
      sites: group === "site" ? groupSites(entries, sort).slice(0, limit) : [],
      totalMatches: entries.length,
      sources: used,
      errors,
      truncated,
      elapsedMs: Date.now() - started,
      sort,
      group,
      limit,
    };
  }

  close(): void {
    for (const handle of this.handles.values()) {
      try {
        handle.db?.close();
      } catch {
        // ignore
      }
    }
    this.handles.clear();
  }
}
