/**
 * pi-browser-history: search the local browser history from pi.
 *
 * - `browser_history` tool  — lets the LLM find pages you visited.
 * - `/history [query]`      — live search panel; open, copy or quote a page.
 * - `/history --sources`    — list the history databases that were found.
 * - `/history --clear-cache`— drop cached database copies.
 */
import { spawnSync } from "node:child_process";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatResults, formatSources } from "./format.ts";
import { HistoryPanel, type PanelAction, type PanelSearch } from "./panel.ts";
import { normalizeHost, parseQuery, type Group, type Sort } from "./query.ts";
import { HistoryStore } from "./search.ts";
import { clearSnapshots } from "./snapshot.ts";
import { discoverSources, type HistorySource } from "./sources.ts";
import { parseTime } from "./time.ts";

const STATUS_KEY = "browser-history";
const PANEL_LIMIT = 50;
const DEFAULT_LIMIT = 25;

const QUERY_SYNTAX =
  'Query syntax: bare terms (all must match the title or URL), "exact phrase", -exclude, ' +
  "site:example.com, since:7d, until:yesterday, in:chrome. " +
  "Times accept 30m/6h/7d/2w/3mo/1y, today, yesterday, or 2026-07-01[ 14:30].";

function openUrl(url: string): boolean {
  const command: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const result = spawnSync(command[0], command[1], { stdio: "ignore" });
  return result.status === 0;
}

function copyToClipboard(text: string): boolean {
  const commands: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
          ];
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { input: text });
    if (result.status === 0) return true;
  }
  return false;
}

function requireTime(value: string, now: number, label: string): number {
  const parsed = parseTime(value, now);
  if (parsed === undefined) {
    throw new Error(
      `Could not parse ${label}="${value}". Use 30m/6h/7d/2w/3mo/1y, today, yesterday, or 2026-07-01[ 14:30].`,
    );
  }
  return parsed;
}

function splitList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : value.split(",");
  return list.map((item) => item.trim()).filter(Boolean);
}

function requireSources(): HistorySource[] {
  const sources = discoverSources();
  if (sources.length === 0) {
    throw new Error(
      "No browser history databases found. Supported: Chrome, Chromium, Edge, Brave, Arc, Vivaldi, Opera, Firefox, Safari.",
    );
  }
  return sources;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_history",
    label: "Browser History",
    description:
      "Search the user's local browser history (pages they actually visited) across Chrome, Chromium, " +
      "Edge, Brave, Arc, Vivaldi, Opera, Firefox and Safari profiles. Matching is case-insensitive " +
      "substring matching over page titles and URLs; results are merged per page across browsers and " +
      "ranked by match quality, recency and visit count. Use it to recover a page the user cannot name " +
      "exactly, to check what they read about a topic, or to list the sites they use for something. " +
      "An empty query returns the most recently visited pages. " +
      QUERY_SYNTAX,
    promptSnippet:
      "Search the user's local browser history for pages they visited (by text, site, and time window)",
    promptGuidelines: [
      "Use browser_history when the user refers to a page, article, PR, doc, or site they visited recently but cannot name or link exactly.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            'Search terms plus optional inline filters ("exact phrase", -exclude, site:, since:, until:, in:). Empty for most recent pages.',
        }),
      ),
      site: Type.Optional(
        Type.String({
          description: "Restrict to a host and its subdomains, e.g. github.com. Comma-separated for several.",
        }),
      ),
      since: Type.Optional(
        Type.String({ description: "Only visits at or after this time (7d, 24h, today, 2026-07-01)." }),
      ),
      until: Type.Optional(
        Type.String({ description: "Only visits at or before this time (yesterday, 2026-07-01 14:30)." }),
      ),
      browsers: Type.Optional(
        Type.Array(Type.String(), {
          description: "Restrict to browsers, profiles or source ids (see the sources line in results).",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 200, description: `Max results (default ${DEFAULT_LIMIT}).` }),
      ),
      sort: Type.Optional(
        StringEnum(["relevance", "recent", "visits"] as const, {
          description: "Ranking: relevance (default), recent (last visit), visits (most visited).",
        }),
      ),
      group: Type.Optional(
        StringEnum(["page", "site"] as const, {
          description: "page (default) lists pages; site aggregates per host with page/visit counts.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const now = Date.now();
      const query = parseQuery(params.query ?? "", now);
      for (const host of splitList(params.site)) {
        const normalized = normalizeHost(host);
        if (normalized) query.hosts.push(normalized);
      }
      if (params.since) query.sinceMs = requireTime(params.since, now, "since");
      if (params.until) query.untilMs = requireTime(params.until, now, "until");
      query.browsers.push(...splitList(params.browsers));

      const sources = requireSources();
      const store = new HistoryStore(sources);
      try {
        const result = store.search(query, {
          limit: params.limit ?? DEFAULT_LIMIT,
          sort: params.sort as Sort | undefined,
          group: params.group as Group | undefined,
          now,
        });
        return {
          content: [{ type: "text", text: formatResults(result, query, sources, now) }],
          details: {
            query: query.raw,
            totalMatches: result.totalMatches,
            sort: result.sort,
            group: result.group,
            elapsedMs: result.elapsedMs,
            sources: result.sources.map((source) => source.label),
            errors: result.errors,
            entries: result.entries.map((entry) => ({
              title: entry.title,
              url: entry.url,
              lastVisit: new Date(entry.lastVisitMs).toISOString(),
              visits: entry.visits,
              sources: entry.sources,
            })),
            sites: result.sites.map((site) => ({
              host: site.host,
              pages: site.pages,
              visits: site.visits,
              lastVisit: new Date(site.lastVisitMs).toISOString(),
              exampleUrl: site.exampleUrl,
            })),
          },
        };
      } finally {
        store.close();
      }
    },
  });

  pi.registerCommand("history", {
    description: "Search browser history (live panel; --sources, --clear-cache)",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const input = (args ?? "").trim();

      if (input === "--clear-cache") {
        const removed = clearSnapshots();
        ctx.ui.notify(`Cleared ${removed} cached history database copies`, "info");
        return;
      }
      if (input === "--sources") {
        ctx.ui.notify(formatSources(discoverSources()), "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/history needs interactive mode; use the browser_history tool instead", "error");
        return;
      }

      let sources: HistorySource[];
      try {
        sources = requireSources();
      } catch (error: any) {
        ctx.ui.notify(error?.message ?? String(error), "error");
        return;
      }

      const store = new HistoryStore(sources);
      const runSearch = (text: string): PanelSearch => {
        try {
          const query = parseQuery(text, Date.now());
          const result = store.search(query, { limit: PANEL_LIMIT });
          return {
            entries: result.entries,
            terms: query.terms,
            total: result.totalMatches,
            notes: [
              ...query.errors,
              ...result.errors.map((error) => `${error.source}: ${error.message}`),
            ],
          };
        } catch (error: any) {
          return { entries: [], terms: [], total: 0, notes: [error?.message ?? String(error)] };
        }
      };

      // Warm up (copies locked databases) before the panel paints.
      ctx.ui.setStatus(STATUS_KEY, "reading browser history…");
      try {
        runSearch(input);
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }

      let action: PanelAction | null = null;
      try {
        action = await ctx.ui.custom<PanelAction | null>(
          (tui, theme, _keybindings, done) =>
            new HistoryPanel({ theme, tui, initialQuery: input, runSearch, done }),
        );
      } finally {
        store.close();
      }
      if (!action) return;

      const { url, title } = action.entry;
      if (action.type === "open") {
        if (openUrl(url)) ctx.ui.notify(`Opened ${url}`, "info");
        else ctx.ui.notify(`Could not open a browser for ${url}`, "warning");
        return;
      }
      if (action.type === "copy") {
        if (copyToClipboard(url)) ctx.ui.notify(`Copied ${url}`, "info");
        else ctx.ui.notify(`Clipboard unavailable: ${url}`, "warning");
        return;
      }
      const existing = ctx.ui.getEditorText();
      const snippet = title ? `${url} (${title})` : url;
      ctx.ui.setEditorText(existing ? `${existing.replace(/\s+$/, "")} ${snippet}` : snippet);
    },
  });
}
