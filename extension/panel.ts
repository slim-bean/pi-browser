/**
 * Live browser-history search panel: input on top, results below, re-queried on
 * every keystroke. Enter opens the page, Tab copies the URL, Shift+Tab drops the
 * URL into the pi prompt.
 */
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Text,
  matchesKey,
  truncateToWidth,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { HistoryEntry } from "./search.ts";
import { relativeTime } from "./time.ts";

const MAX_VISIBLE = 6;

export type PanelActionType = "open" | "copy" | "insert";

export interface PanelAction {
  type: PanelActionType;
  entry: HistoryEntry;
}

export interface PanelSearch {
  entries: HistoryEntry[];
  /** Plain terms, for highlighting. */
  terms: string[];
  /** Total unique matches before the display limit. */
  total: number;
  /** Non-fatal problems (unreadable source, bad filter) to show in the header. */
  notes: string[];
}

export interface MiniTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Colour `text` with `base`, highlighting query terms with `accent`. */
export function styleWithTerms(
  text: string,
  terms: string[],
  theme: MiniTheme,
  base: string,
  accent: string,
): string {
  const usable = terms.map(escapeRegex).filter(Boolean);
  if (usable.length === 0) return theme.fg(base, text);
  const pattern = new RegExp(`(${usable.join("|")})`, "gi");
  // split() with one capture group alternates non-match/match; empty leading or
  // trailing pieces must be kept (as "") so that parity stays correct.
  return text
    .split(pattern)
    .map((part, index) => {
      if (part === "") return "";
      return index % 2 === 1 ? theme.bold(theme.fg(accent, part)) : theme.fg(base, part);
    })
    .join("");
}

/** Scrollable list of history hits. Navigation is driven by the parent panel. */
export class ResultsList {
  private entries: HistoryEntry[] = [];
  private terms: string[] = [];
  private selected = 0;
  private scroll = 0;
  private readonly theme: MiniTheme;

  constructor(theme: MiniTheme) {
    this.theme = theme;
  }

  setEntries(entries: HistoryEntry[], terms: string[]): void {
    this.entries = entries;
    this.terms = terms;
    this.selected = 0;
    this.scroll = 0;
  }

  getSelected(): HistoryEntry | undefined {
    return this.entries[this.selected];
  }

  moveUp(): void {
    if (this.selected > 0) this.selected--;
  }

  moveDown(): void {
    if (this.selected < this.entries.length - 1) this.selected++;
  }

  render(width: number): string[] {
    const theme = this.theme;
    if (this.entries.length === 0) {
      return [truncateToWidth(theme.fg("dim", "  no matches"), width)];
    }
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + MAX_VISIBLE) this.scroll = this.selected - MAX_VISIBLE + 1;

    const lines: string[] = [];
    const end = Math.min(this.scroll + MAX_VISIBLE, this.entries.length);
    if (this.scroll > 0) {
      lines.push(truncateToWidth(theme.fg("dim", `   ↑ ${this.scroll} more`), width));
    }

    for (let i = this.scroll; i < end; i++) {
      const entry = this.entries[i]!;
      const isSelected = i === this.selected;
      const prefix = isSelected ? theme.fg("accent", "❯ ") : "  ";
      const variants = entry.variants > 1 ? ` · +${entry.variants - 1}` : "";
      const metaPlain = `  ${relativeTime(entry.lastVisitMs)} · ${entry.visits}×${variants} · ${entry.sources.join(", ")}`;
      const titlePlain = (entry.title || entry.host || entry.url).replace(/\s+/g, " ").trim();
      const avail = Math.max(20, width - 2 - metaPlain.length);
      const title = titlePlain.length > avail ? `${titlePlain.slice(0, avail - 1)}…` : titlePlain;
      lines.push(
        truncateToWidth(
          prefix +
            styleWithTerms(title, this.terms, theme, isSelected ? "accent" : "text", "warning") +
            theme.fg("dim", metaPlain),
          width,
        ),
      );
      lines.push(
        truncateToWidth(
          "    " + styleWithTerms(entry.url, this.terms, theme, isSelected ? "muted" : "dim", "warning"),
          width,
        ),
      );
    }

    if (end < this.entries.length) {
      lines.push(truncateToWidth(theme.fg("dim", `   ↓ ${this.entries.length - end} more`), width));
    }
    return lines;
  }

  invalidate(): void {
    // stateless render: nothing cached
  }
}

export interface HistoryPanelOptions {
  theme: MiniTheme;
  tui?: Pick<TUI, "requestRender">;
  initialQuery?: string;
  /** Runs on every keystroke. Must be fast and must not throw. */
  runSearch: (query: string) => PanelSearch;
  done: (action: PanelAction | null) => void;
}

export class HistoryPanel extends Container implements Focusable {
  private readonly input: Input;
  private readonly list: ResultsList;
  private readonly headerText: Text;
  private readonly options: HistoryPanelOptions;
  private lastQuery: string;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(options: HistoryPanelOptions) {
    super();
    this.options = options;
    const theme = options.theme;

    this.input = new Input();
    this.input.setValue(options.initialQuery ?? "");
    this.input.onSubmit = () => {
      const entry = this.list.getSelected();
      if (entry) options.done({ type: "open", entry });
    };
    this.input.onEscape = () => options.done(null);

    this.list = new ResultsList(theme);
    this.headerText = new Text("", 1, 0);

    this.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
    this.addChild(this.headerText);
    this.addChild(this.input);
    this.addChild(new Text("", 0, 0));
    this.addChild(this.list);
    this.addChild(
      new Text(
        theme.fg("dim", "↑↓ navigate · enter open in browser · tab copy url · shift+tab insert in prompt · esc cancel"),
        1,
        0,
      ),
    );
    this.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));

    this.lastQuery = this.input.getValue();
    this.refresh();
  }

  getQuery(): string {
    return this.input.getValue();
  }

  private refresh(): void {
    const theme = this.options.theme;
    const query = this.input.getValue();
    const search = this.options.runSearch(query);
    this.list.setEntries(search.entries, search.terms);
    const label = search.total > search.entries.length
      ? `${search.entries.length} of ${search.total} pages`
      : `${search.total} page${search.total === 1 ? "" : "s"}`;
    const notes = search.notes.length > 0 ? `  ·  ${search.notes.join(" · ")}` : "";
    this.headerText.setText(
      theme.fg("accent", theme.bold("Browser history")) +
        theme.fg("muted", `  ·  ${query.trim() ? label : `${label} · type to search`}`) +
        theme.fg("warning", notes),
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.list.moveUp();
    } else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.list.moveDown();
    } else if (matchesKey(data, "shift+tab")) {
      const entry = this.list.getSelected();
      if (entry) this.options.done({ type: "insert", entry });
    } else if (matchesKey(data, "tab")) {
      const entry = this.list.getSelected();
      if (entry) this.options.done({ type: "copy", entry });
    } else {
      this.input.handleInput(data);
      const query = this.input.getValue();
      if (query !== this.lastQuery) {
        this.lastQuery = query;
        this.refresh();
      }
    }
    this.options.tui?.requestRender();
  }

  override invalidate(): void {
    super.invalidate();
    this.refresh(); // theme may have changed: rebuild pre-baked strings
  }
}
