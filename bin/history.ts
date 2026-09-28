#!/usr/bin/env node
/** JSON stdin/stdout helper for browser-fetch. Node >=22.19; no dependencies. */
import { searchHistory, validateParams } from "../extension/api.ts";
import { configuredChromiumRoots, discoverSources } from "../extension/sources.ts";

try {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > 128 * 1024) throw new TypeError("History request is too large");
    chunks.push(data);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!request || !["search", "sources"].includes(request.operation)) throw new TypeError("Unknown history operation");
  if (request.operation === "search") validateParams(request.params);
  // Never discover the helper host's other browsers. Roots are operator-owned
  // environment configuration; the request cannot provide paths or commands.
  const roots = configuredChromiumRoots();
  if (!roots.length) throw new Error("Configure PI_BROWSER_HISTORY_CHROMIUM_ROOTS on the history helper host");
  const sources = discoverSources({ extraChromiumRoots: roots, includeDefaults: false });
  const result = request.operation === "search" ? searchHistory(request.params, sources) : {
    version: 1, sources: sources.map(({ id, browser, profile, label }) => ({ id, browser, profile, label })),
  };
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ version: 1, error: (error as Error).message,
    code: error instanceof TypeError || error instanceof SyntaxError ? "bad_request" : "history_unavailable" }));
}
