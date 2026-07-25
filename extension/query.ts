/**
 * Query syntax shared by the `/history` panel and the `browser_history` tool.
 *
 *   loki chunk cache          all terms must appear in the title or URL
 *   "exact phrase"            quoted phrases match verbatim
 *   -grafana                  exclude matches
 *   site:github.com           limit to a host (or subdomains of it)
 *   since:7d until:yesterday  time window (see time.ts for accepted values)
 *   in:chrome                 limit to a browser, profile or source id
 */
import { parseTime } from "./time.ts";

export type Sort = "relevance" | "recent" | "visits";
export type Group = "page" | "site";

export interface ParsedQuery {
  raw: string;
  /** Terms that must all match (title or URL, case-insensitive substring). */
  terms: string[];
  /** Terms that must not match. */
  excluded: string[];
  /** Host filters; a page matches a host or any of its subdomains. */
  hosts: string[];
  /** Browser / profile / source-id filters. */
  browsers: string[];
  sinceMs: number | undefined;
  untilMs: number | undefined;
  /** Plain search text (terms only), for display and highlighting. */
  text: string;
  /** Filter values that could not be parsed. */
  errors: string[];
}

const HOST_KEYS = ["site", "host", "domain"];
const SINCE_KEYS = ["since", "after", "from"];
const UNTIL_KEYS = ["until", "before", "to"];
const BROWSER_KEYS = ["in", "browser", "source"];

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Strip scheme, `www.`, path and trailing dots from a host filter. */
export function normalizeHost(value: string): string {
  return unquote(value)
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^\.+|\.+$/g, "");
}

export function parseQuery(input: string, now = Date.now()): ParsedQuery {
  const query: ParsedQuery = {
    raw: input,
    terms: [],
    excluded: [],
    hosts: [],
    browsers: [],
    sinceMs: undefined,
    untilMs: undefined,
    text: "",
    errors: [],
  };

  // Quoted phrases stay whole; `key:"two words"` stays whole too.
  const tokens = input.match(/[^\s:"]+:"[^"]*"?|"[^"]*"?|\S+/g) ?? [];
  for (const token of tokens) {
    const colon = token.indexOf(":");
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    const rawValue = colon > 0 ? token.slice(colon + 1) : "";
    const value = unquote(rawValue);

    if (key && value) {
      if (HOST_KEYS.includes(key)) {
        const host = normalizeHost(value);
        if (host) query.hosts.push(host);
        continue;
      }
      if (BROWSER_KEYS.includes(key)) {
        query.browsers.push(value);
        continue;
      }
      if (SINCE_KEYS.includes(key) || UNTIL_KEYS.includes(key)) {
        const parsed = parseTime(value, now);
        if (parsed === undefined) {
          query.errors.push(`could not parse ${key}:${value}`);
        } else if (SINCE_KEYS.includes(key)) {
          query.sinceMs = parsed;
        } else {
          query.untilMs = parsed;
        }
        continue;
      }
      // Unknown key: fall through so URLs like "http://x" stay searchable.
    }

    if (token.startsWith("-") && token.length > 1) {
      const excluded = unquote(token.slice(1));
      if (excluded) query.excluded.push(excluded);
      continue;
    }

    const term = unquote(token);
    if (term) query.terms.push(term);
  }

  query.text = query.terms.join(" ");
  return query;
}

/** Human summary of the active filters, for result headers. */
export function describeFilters(query: ParsedQuery, formatTime: (ms: number) => string): string[] {
  const parts: string[] = [];
  if (query.hosts.length > 0) parts.push(`site: ${query.hosts.join(", ")}`);
  if (query.excluded.length > 0) parts.push(`excluding: ${query.excluded.join(", ")}`);
  if (query.sinceMs !== undefined) parts.push(`since ${formatTime(query.sinceMs)}`);
  if (query.untilMs !== undefined) parts.push(`until ${formatTime(query.untilMs)}`);
  if (query.browsers.length > 0) parts.push(`in: ${query.browsers.join(", ")}`);
  return parts;
}
