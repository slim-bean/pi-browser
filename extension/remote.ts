import { readFileSync } from "node:fs";
import { prepareQuery, renderHistory, type HistoryResponse } from "./api.ts";
import { rankRows, type RawRow } from "./search.ts";
import { filterSources, type HistorySourceInfo } from "./sources.ts";

export const HISTORY_PROTOCOL = 2;
const MAX_CANDIDATES = 20_000;
const MAX_TOTAL_ROW_BYTES = 16 * 1024 * 1024;
export function remoteUrl(): string | undefined {
  return process.env.PI_BROWSER_HISTORY_URL?.trim().replace(/\/+$/, "") || undefined;
}

async function request(operation: "query" | "sources", input?: unknown, signal?: AbortSignal): Promise<unknown> {
  const base = remoteUrl();
  if (!base) throw new Error("PI_BROWSER_HISTORY_URL is not configured");
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("PI_BROWSER_HISTORY_URL must be an http(s) gateway base URL without credentials/query/fragment");
  const file = process.env.PI_BROWSER_HISTORY_TOKEN_FILE?.trim();
  const token = (file ? readFileSync(file, "utf8") : process.env.PI_BROWSER_HISTORY_TOKEN)?.trim();
  if (token && /[\r\n]/.test(token)) throw new Error("History gateway token contains an embedded newline");
  const response = await fetch(`${base}/history/${operation}`, {
    method: operation === "query" ? "POST" : "GET", redirect: "error",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: operation === "query" ? JSON.stringify(input) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) throw new Error("Remote history response exceeds 8 MiB");
      chunks.push(value);
    }
  } finally { await reader?.cancel().catch(() => {}); }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok) throw new Error(`Remote history: ${result?.error ?? `HTTP ${response.status}`} (no local fallback)`);
  if (result?.version !== HISTORY_PROTOCOL) throw new Error("Incompatible history protocol; update browser-fetch and pi-browser for native history v2");
  return result;
}

function isSource(value: any): value is HistorySourceInfo {
  return value && [value.id, value.browser, value.profile, value.label].every((v) => typeof v === "string" && v.length <= 512);
}

export async function remoteSources(signal?: AbortSignal): Promise<{ version: 2; sources: HistorySourceInfo[] }> {
  const result = await request("sources", undefined, signal) as { version: 2; sources?: HistorySourceInfo[] };
  if (!Array.isArray(result.sources) || result.sources.length > 64 || !result.sources.every(isSource) || new Set(result.sources.map((s) => s.id)).size !== result.sources.length) throw new Error("Invalid remote history sources");
  return { version: 2, sources: result.sources };
}

/** Interpret query syntax locally; the server receives only bounded structured SQL prefilters. */
export async function searchRemoteHistory(input: unknown, signal?: AbortSignal): Promise<HistoryResponse> {
  const { params, query, now } = prepareQuery(input);
  for (const filters of [query.terms, query.excluded, query.hosts]) if (filters.length > 64) throw new Error("Remote history supports at most 64 filters per field");
  const { sources } = await remoteSources(signal);
  const active = filterSources(sources, query.browsers);
  const rows: RawRow[] = [];
  const metadata = { sources: [] as { id: string; label: string; copied: boolean }[], errors: [] as { source: string; message: string }[], truncated: false, started: now };
  if (!active.length && sources.length) metadata.errors.push({ source: query.browsers.join(", "), message: `no such browser or profile; available: ${sources.map((s) => s.id).join(", ")}` });
  const limit = Math.max(1, Math.floor(MAX_CANDIDATES / Math.max(1, active.length)));
  let totalBytes = 0;
  for (const source of active) {
    signal?.throwIfAborted();
    const result = await request("query", {
      version: HISTORY_PROTOCOL, sourceId: source.id, terms: query.terms, excluded: query.excluded,
      hosts: query.hosts,
      sinceMs: query.sinceMs === undefined ? undefined : Math.round(query.sinceMs),
      untilMs: query.untilMs === undefined ? undefined : Math.round(query.untilMs), limit,
    }, signal) as { source?: HistorySourceInfo; rows?: Omit<RawRow, "sourceLabel">[]; truncated?: boolean };
    if (!isSource(result.source) || result.source.id !== source.id || typeof result.truncated !== "boolean" || !Array.isArray(result.rows) || result.rows.length > limit) throw new Error("Invalid remote history query result");
    metadata.sources.push({ id: source.id, label: source.label, copied: true });
    metadata.truncated ||= result.truncated;
    for (const row of result.rows) {
      if (!row || typeof row.url !== "string" || typeof row.title !== "string" || row.url.length > 16384 || row.title.length > 16384 || !Number.isSafeInteger(row.visits) || row.visits < 0 || !Number.isSafeInteger(row.ms) || Math.abs(row.ms) > 8640000000000000) throw new Error("Invalid remote history record");
      totalBytes += Buffer.byteLength(row.url) + Buffer.byteLength(row.title);
      if (totalBytes > MAX_TOTAL_ROW_BYTES) { metadata.truncated = true; break; }
      rows.push({ ...row, sourceLabel: source.label });
    }
    if (totalBytes > MAX_TOTAL_ROW_BYTES) break;
  }
  // Same exact-host filtering, deduplication, ranking, grouping and formatting as
  // local history. Nothing agent-specific needs to be installed on the server.
  const result = rankRows(rows, query, { limit: params.limit, sort: params.sort, group: params.group, now }, metadata);
  return renderHistory(result, query, sources, now);
}
