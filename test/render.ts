/**
 * Visual check for the live panel: renders it against the real browser history
 * with ANSI colours, so layout/highlighting problems are obvious.
 *
 * Run: node test/render.ts [query] [width]
 */
import { HistoryPanel } from "../extension/panel.ts";
import { parseQuery } from "../extension/query.ts";
import { HistoryStore } from "../extension/search.ts";
import { discoverSources } from "../extension/sources.ts";

const COLORS: Record<string, string> = {
  accent: "\x1b[36m",
  text: "\x1b[0m",
  dim: "\x1b[90m",
  muted: "\x1b[37m",
  warning: "\x1b[33m",
  border: "\x1b[90m",
  error: "\x1b[31m",
};
const theme = {
  fg: (color: string, value: string) => `${COLORS[color] ?? ""}${value}\x1b[0m`,
  bold: (value: string) => `\x1b[1m${value}\x1b[0m`,
};

const query = process.argv[2] ?? "";
const width = Number(process.argv[3] ?? 120);

const store = new HistoryStore(discoverSources());
const panel = new HistoryPanel({
  theme,
  initialQuery: query,
  runSearch: (text) => {
    const parsed = parseQuery(text, Date.now());
    const result = store.search(parsed, { limit: 50 });
    return {
      entries: result.entries,
      terms: parsed.terms,
      total: result.totalMatches,
      notes: result.errors.map((error) => `${error.source}: ${error.message}`),
    };
  },
  done: () => {},
});

panel.handleInput("\x1b[B"); // move selection down once
console.log(panel.render(width).join("\n"));
store.close();
