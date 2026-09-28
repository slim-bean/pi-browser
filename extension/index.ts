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
import { formatSources } from "./format.ts";
import { searchHistory } from "./api.ts";
import { remoteUrl, remoteSources, searchRemoteHistory } from "./remote.ts";
import { HistoryPanel, type PanelAction, type PanelSearch } from "./panel.ts";
import { parseQuery } from "./query.ts";
import { HistoryStore } from "./search.ts";
import { clearSnapshots } from "./snapshot.ts";
import { discoverSources, type HistorySource } from "./sources.ts";

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
  pi.events.on("pi-browser:capabilities:v1", (request) => {
    (request as { result?: unknown }).result = { remoteHistory: true, historyProtocol: 2 };
  });
  pi.registerTool({
    name: "browser_history",
    label: "Browser History",
    description:
      "Search configured browser history (local profiles or a remote gateway; check user/agent source labels) across Chrome, Chromium, " +
      "Edge, Brave, Arc, Vivaldi, Opera, Firefox and Safari profiles. Matching is case-insensitive " +
      "substring matching over page titles and URLs; results are merged per page across browsers and " +
      "ranked by match quality, recency and visit count. Use it to recover a page the user cannot name " +
      "exactly, find visits about a topic, or list previously used sites. " +
      "An empty query returns the most recently visited pages. When a remote gateway is configured, " +
      "searches that browser's history rather than this machine's; never falls back silently. " +
      QUERY_SYNTAX,
    promptSnippet:
      "Search local or remote browser history by text, site, and time window",
    promptGuidelines: [
      "Use browser_history to recover previously visited pages. Check source labels to distinguish user and assistant browsing; history records URLs/titles, not what someone read or concluded.",
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
    async execute(_toolCallId, params, signal) {
      const { content, details } = remoteUrl() ? await searchRemoteHistory(params, signal) : searchHistory(params);
      return { content, details };
    },
  });

  pi.registerCommand("history", {
    description: "Search browser history (live panel; --sources, --clear-cache)",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const input = (args ?? "").trim();
      if (remoteUrl()) {
        if (input === "--clear-cache") {
          ctx.ui.notify("Remote history caches are managed on the browser host; nothing local was cleared.", "info");
        } else if (input === "--sources") {
          const result = await remoteSources();
          ctx.ui.notify(result.sources.map((s: { id: string; label: string }) => `${s.id}: ${s.label}`).join("\n") || "No remote history sources yet", "info");
        } else {
          const result = await searchRemoteHistory({ query: input });
          ctx.ui.notify(result.content.map((c) => c.text).join("\n"), "info");
        }
        return;
      }

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
