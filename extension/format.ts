/**
 * Compact text rendering of search results for the LLM (two lines per hit).
 */
import { describeFilters, type ParsedQuery } from "./query.ts";
import type { SearchResult } from "./search.ts";
import type { HistorySource } from "./sources.ts";
import { formatDateTime, formatWhen, relativeTime } from "./time.ts";

const MAX_TITLE = 120;
const MAX_URL = 300;

function trim(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function header(result: SearchResult, query: ParsedQuery): string {
  const pages = plural(result.totalMatches, "matching page");
  const summary =
    result.group === "site"
      ? `${plural(result.sites.length, "site")} across ${pages}`
      : result.totalMatches > result.entries.length
        ? `${pages} (showing ${result.entries.length})`
        : pages;
  const parts = [`Browser history: ${summary}`];
  if (query.text) parts.push(`query "${query.text}"`);
  const filters = describeFilters(query, formatDateTime);
  parts.push(...filters);
  parts.push(`sort ${result.sort}`);
  if (result.sources.length > 0) {
    parts.push(`sources ${result.sources.map((source) => source.label).join(", ")}`);
  }
  return parts.join(" · ");
}

function notes(result: SearchResult, query: ParsedQuery, sources: HistorySource[]): string[] {
  const lines: string[] = [];
  for (const error of query.errors) lines.push(`Ignored filter: ${error}`);
  for (const error of result.errors) lines.push(`Unavailable: ${error.source} — ${error.message}`);
  if (result.truncated) {
    lines.push("Row cap reached; narrow with site:/since: for complete counts.");
  }
  if (result.totalMatches === 0) {
    lines.push(
      `No matches. Available sources: ${sources.map((source) => source.label).join(", ") || "none"}.`,
    );
    lines.push(
      'Syntax: terms, "exact phrase", -exclude, site:example.com, since:7d, until:yesterday, in:chrome.',
    );
  }
  return lines;
}

export function formatResults(
  result: SearchResult,
  query: ParsedQuery,
  sources: HistorySource[],
  now = Date.now(),
): string {
  const lines: string[] = [];

  if (result.group === "site") {
    lines.push(header(result, query));
    lines.push("");
    result.sites.forEach((site, index) => {
      const rank = String(index + 1).padStart(2, " ");
      lines.push(
        `${rank}. ${site.host} — ${plural(site.pages, "page")} · ${plural(site.visits, "visit")} · last ${formatWhen(site.lastVisitMs, now)} · ${site.sources.join(", ")}`,
      );
      lines.push(
        `    e.g. ${trim(site.exampleTitle || "(no title)", MAX_TITLE)} — ${trim(site.exampleUrl, MAX_URL)}`,
      );
    });
  } else {
    lines.push(header(result, query));
    lines.push("");
    result.entries.forEach((entry, index) => {
      const rank = String(index + 1).padStart(2, " ");
      const variants =
        entry.variants > 1 ? ` · +${plural(entry.variants - 1, "similar url")}` : "";
      lines.push(
        `${rank}. ${trim(entry.title || "(no title)", MAX_TITLE)} — ${formatDateTime(entry.lastVisitMs)} (${relativeTime(entry.lastVisitMs, now)}) · ${plural(entry.visits, "visit")}${variants} · ${entry.sources.join(", ")}`,
      );
      lines.push(`    ${trim(entry.url, MAX_URL)}`);
    });
  }

  const trailing = notes(result, query, sources);
  if (trailing.length > 0) {
    lines.push("");
    lines.push(...trailing);
  }
  return lines.join("\n").trimEnd();
}

/** `/history --sources` and error messages. */
export function formatSources(sources: HistorySource[]): string {
  if (sources.length === 0) return "No browser history databases found.";
  const lines = [`${plural(sources.length, "history database")} found:`];
  for (const source of sources) {
    lines.push(
      `  ${source.id.padEnd(24)} ${source.engine.padEnd(9)} ${relativeTime(source.mtimeMs).padEnd(10)} ${source.dbPath}`,
    );
  }
  return lines.join("\n");
}
