/** Shared local/remote history query contract. No pi imports or networking. */
import { formatResults } from "./format.ts";
import { normalizeHost, parseQuery, type Sort, type Group } from "./query.ts";
import { HistoryStore } from "./search.ts";
import { discoverSources, type HistorySource } from "./sources.ts";
import { parseTime } from "./time.ts";

export interface HistoryParams {
  query?: string; site?: string; since?: string; until?: string; browsers?: string[];
  limit?: number; sort?: Sort; group?: Group;
}
export function validateParams(value: unknown): HistoryParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected a history query object");
  const p = value as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!["query", "site", "since", "until", "browsers", "limit", "sort", "group"].includes(key)) throw new TypeError(`Unknown history parameter: ${key}`);
    if (p[key] === undefined) continue;
    if (["query", "site", "since", "until"].includes(key) && (typeof p[key] !== "string" || (p[key] as string).length > 4096)) throw new TypeError(`${key} must be a string of at most 4096 characters`);
  }
  if (p.browsers !== undefined && (!Array.isArray(p.browsers) || p.browsers.length > 100 || p.browsers.some((s) => typeof s !== "string" || s.length > 256))) throw new TypeError("browsers must be an array of source names");
  if (p.limit !== undefined && (!Number.isInteger(p.limit) || (p.limit as number) < 1 || (p.limit as number) > 200)) throw new TypeError("limit must be an integer from 1 to 200");
  if (p.sort !== undefined && !["relevance", "recent", "visits"].includes(p.sort as string)) throw new TypeError("Invalid history sort");
  if (p.group !== undefined && !["page", "site"].includes(p.group as string)) throw new TypeError("Invalid history group");
  return p as HistoryParams;
}

export function searchHistory(input: unknown, sources: HistorySource[] = discoverSources()) {
  const params = validateParams(input);
  if (!sources.length) throw new Error("No browser history databases found in the configured sources");
  const now = Date.now();
  const query = parseQuery(params.query ?? "", now);
  for (const host of (params.site ?? "").split(",")) {
    const normalized = normalizeHost(host);
    if (normalized) query.hosts.push(normalized);
  }
  for (const key of ["since", "until"] as const) {
    if (!params[key]) continue;
    const time = parseTime(params[key]!, now);
    if (time === undefined) throw new TypeError(`Could not parse ${key}; use a relative time or ISO date`);
    if (key === "since") query.sinceMs = time; else query.untilMs = time;
  }
  query.browsers.push(...(params.browsers ?? []));
  const store = new HistoryStore(sources);
  try {
    const result = store.search(query, { limit: params.limit ?? 25, sort: params.sort, group: params.group, now });
    return {
      version: 1 as const,
      content: [{ type: "text" as const, text: formatResults(result, query, sources, now) }],
      details: {
        query: query.raw, totalMatches: result.totalMatches, sort: result.sort, group: result.group,
        elapsedMs: result.elapsedMs, truncated: result.truncated,
        sources: result.sources.map((s) => s.label), errors: result.errors,
        entries: result.entries.map((e) => ({ title: e.title, url: e.url, lastVisit: new Date(e.lastVisitMs).toISOString(), visits: e.visits, sources: e.sources })),
        sites: result.sites.map((s) => ({ host: s.host, pages: s.pages, visits: s.visits, lastVisit: new Date(s.lastVisitMs).toISOString(), exampleUrl: s.exampleUrl })),
      },
    };
  } finally { store.close(); }
}
export type HistoryResponse = ReturnType<typeof searchHistory>;
