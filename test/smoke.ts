/**
 * Smoke test against the real browser history on this machine: lists sources,
 * runs a few queries, and measures per-keystroke latency for the live panel.
 *
 * Run: node test/smoke.ts [query]
 */
import { formatResults, formatSources } from "../extension/format.ts";
import { parseQuery } from "../extension/query.ts";
import { HistoryStore } from "../extension/search.ts";
import { discoverSources } from "../extension/sources.ts";

const sources = discoverSources();
console.log(formatSources(sources));
if (sources.length === 0) process.exit(0);

const store = new HistoryStore(sources);
const now = Date.now();
const term = process.argv[2] ?? "github";

function run(label: string, input: string, options: Record<string, unknown> = {}): void {
  const query = parseQuery(input, now);
  const started = Date.now();
  const result = store.search(query, { now, limit: 5, ...options });
  console.log(`\n### ${label}  (${Date.now() - started}ms, ${result.totalMatches} matches)`);
  console.log(formatResults(result, query, sources, now));
}

run("most recent pages", "");
run(`search "${term}"`, term);
run(`sites for "${term}"`, term, { group: "site" });
run(`"${term}" in the last 2 days`, `${term} since:2d`);

// Live-panel latency: the panel re-queries on every keystroke.
const typed = term.split("").map((_, index) => term.slice(0, index + 1));
console.log("\n### keystroke latency");
for (const prefix of typed) {
  const started = Date.now();
  const result = store.search(parseQuery(prefix, now), { now, limit: 50 });
  console.log(`  ${prefix.padEnd(20)} ${String(Date.now() - started).padStart(4)}ms  ${result.totalMatches} matches`);
}

store.close();
