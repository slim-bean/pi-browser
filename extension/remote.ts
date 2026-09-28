import { readFileSync } from "node:fs";
import { validateParams, type HistoryResponse } from "./api.ts";

export function remoteUrl(): string | undefined {
  return process.env.PI_BROWSER_HISTORY_URL?.trim().replace(/\/+$/, "") || undefined;
}
export async function remoteHistory(operation: "search" | "sources", input: unknown = {}, signal?: AbortSignal): Promise<any> {
  const base = remoteUrl();
  if (!base) throw new Error("PI_BROWSER_HISTORY_URL is not configured");
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("PI_BROWSER_HISTORY_URL must be an http(s) gateway base URL without credentials/query/fragment");
  if (operation === "search") validateParams(input);
  const file = process.env.PI_BROWSER_HISTORY_TOKEN_FILE?.trim();
  const token = (file ? readFileSync(file, "utf8") : process.env.PI_BROWSER_HISTORY_TOKEN)?.trim();
  if (token && /[\r\n]/.test(token)) throw new Error("History gateway token contains an embedded newline");
  const response = await fetch(`${base}/history/${operation}`, {
    method: operation === "search" ? "POST" : "GET", redirect: "error",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: operation === "search" ? JSON.stringify(input) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  // Bound response memory, not merely the text handed to the model.
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error("Remote history response exceeds 2 MiB");
      chunks.push(value);
    }
  } finally { await reader?.cancel().catch(() => {}); }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok) throw new Error(`Remote history: ${result.error ?? `HTTP ${response.status}`} (no local fallback)`);
  if (result.version !== 1 || (operation === "sources" ? !Array.isArray(result.sources) :
      !Array.isArray(result.content) || result.content.some((c: any) => c.type !== "text" || typeof c.text !== "string") || !result.details)) {
    throw new Error("Incompatible remote history response");
  }
  return result;
}

export async function searchRemoteHistory(input: unknown, signal?: AbortSignal): Promise<HistoryResponse> {
  return remoteHistory("search", input, signal);
}
