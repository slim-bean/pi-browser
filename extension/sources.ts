/**
 * Browser history database discovery.
 *
 * Finds every local history SQLite file for the Chromium family, Firefox and
 * Safari, on macOS / Linux / Windows. Pure filesystem inspection — nothing here
 * opens a database (see snapshot.ts).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Storage layout of a history database. Determines the SQL used to read it. */
export type Engine = "chromium" | "firefox" | "safari";

export interface HistorySource {
  /** Stable filter id, e.g. "chrome", "chrome/ed-work", "firefox/default-release". */
  id: string;
  /** Browser family id, e.g. "chrome", "brave", "firefox", "safari". */
  browser: string;
  /** Human profile name, when the browser has profiles. */
  profile: string | undefined;
  /** Display label, e.g. "chrome/Ed Work". */
  label: string;
  engine: Engine;
  dbPath: string;
  mtimeMs: number;
  size: number;
}

interface FileStat {
  mtimeMs: number;
  size: number;
}

interface ChromiumRoot {
  browser: string;
  dir: string;
}

function statSafe(path: string): FileStat | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return undefined;
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return undefined;
  }
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function chromiumRoots(): ChromiumRoot[] {
  const home = homedir();
  if (process.platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return [
      { browser: "chrome", dir: join(support, "Google", "Chrome") },
      { browser: "chrome-beta", dir: join(support, "Google", "Chrome Beta") },
      { browser: "chrome-canary", dir: join(support, "Google", "Chrome Canary") },
      { browser: "chromium", dir: join(support, "Chromium") },
      { browser: "edge", dir: join(support, "Microsoft Edge") },
      { browser: "brave", dir: join(support, "BraveSoftware", "Brave-Browser") },
      { browser: "vivaldi", dir: join(support, "Vivaldi") },
      { browser: "arc", dir: join(support, "Arc", "User Data") },
      { browser: "dia", dir: join(support, "Dia", "User Data") },
      { browser: "opera", dir: join(support, "com.operasoftware.Opera") },
      { browser: "opera-gx", dir: join(support, "com.operasoftware.OperaGX") },
    ];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const roaming = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      { browser: "chrome", dir: join(local, "Google", "Chrome", "User Data") },
      { browser: "chromium", dir: join(local, "Chromium", "User Data") },
      { browser: "edge", dir: join(local, "Microsoft", "Edge", "User Data") },
      { browser: "brave", dir: join(local, "BraveSoftware", "Brave-Browser", "User Data") },
      { browser: "vivaldi", dir: join(local, "Vivaldi", "User Data") },
      { browser: "opera", dir: join(roaming, "Opera Software", "Opera Stable") },
    ];
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [
    { browser: "chrome", dir: join(config, "google-chrome") },
    { browser: "chrome-beta", dir: join(config, "google-chrome-beta") },
    { browser: "chromium", dir: join(config, "chromium") },
    { browser: "edge", dir: join(config, "microsoft-edge") },
    { browser: "brave", dir: join(config, "BraveSoftware", "Brave-Browser") },
    { browser: "vivaldi", dir: join(config, "vivaldi") },
    { browser: "opera", dir: join(config, "opera") },
  ];
}

function firefoxProfileRoots(): string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    return [join(home, "Library", "Application Support", "Firefox", "Profiles")];
  }
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [join(roaming, "Mozilla", "Firefox", "Profiles")];
  }
  return [
    join(home, ".mozilla", "firefox"),
    join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
    join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
  ];
}

/** Chromium `Local State` maps profile directories to display names. */
function chromiumProfileNames(root: string): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const state = JSON.parse(readFileSync(join(root, "Local State"), "utf8"));
    const cache = state?.profile?.info_cache;
    if (cache && typeof cache === "object") {
      for (const [dir, info] of Object.entries(cache as Record<string, { name?: unknown }>)) {
        if (typeof info?.name === "string" && info.name.trim()) names.set(dir, info.name.trim());
      }
    }
  } catch {
    // Local State is optional (missing, unreadable or not JSON) — fall back to dir names.
  }
  return names;
}

const SKIP_PROFILE_DIRS = new Set(["System Profile", "Guest Profile"]);

function chromiumSources(root: ChromiumRoot): HistorySource[] {
  if (!existsSync(root.dir)) return [];
  const names = chromiumProfileNames(root.dir);

  // Opera keeps History in the root; other Chromium browsers use profile dirs.
  const profileDirs = listDirs(root.dir).filter(
    (dir) => !SKIP_PROFILE_DIRS.has(dir) && existsSync(join(root.dir, dir, "History")),
  );
  const candidates: { dir: string | undefined; dbPath: string }[] = profileDirs.map((dir) => ({
    dir,
    dbPath: join(root.dir, dir, "History"),
  }));
  if (candidates.length === 0 && existsSync(join(root.dir, "History"))) {
    candidates.push({ dir: undefined, dbPath: join(root.dir, "History") });
  }

  const sources: HistorySource[] = [];
  for (const candidate of candidates) {
    const st = statSafe(candidate.dbPath);
    if (!st) continue;
    const profile = candidate.dir ? (names.get(candidate.dir) ?? candidate.dir) : undefined;
    sources.push({
      id: root.browser,
      browser: root.browser,
      profile,
      label: profile ? `${root.browser}/${profile}` : root.browser,
      engine: "chromium",
      dbPath: candidate.dbPath,
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  }
  return sources;
}

function firefoxSources(): HistorySource[] {
  const sources: HistorySource[] = [];
  for (const root of firefoxProfileRoots()) {
    for (const dir of listDirs(root)) {
      const dbPath = join(root, dir, "places.sqlite");
      const st = statSafe(dbPath);
      if (!st) continue;
      // Profile dirs look like "cehqnd04.default-release"; drop the salt.
      const profile = dir.includes(".") ? dir.slice(dir.indexOf(".") + 1) : dir;
      sources.push({
        id: "firefox",
        browser: "firefox",
        profile,
        label: `firefox/${profile}`,
        engine: "firefox",
        dbPath,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    }
  }
  return sources;
}

function safariSources(): HistorySource[] {
  if (process.platform !== "darwin") return [];
  const dbPath = join(homedir(), "Library", "Safari", "History.db");
  const st = statSafe(dbPath);
  if (!st) return [];
  return [
    {
      id: "safari",
      browser: "safari",
      profile: undefined,
      label: "safari",
      engine: "safari",
      dbPath,
      mtimeMs: st.mtimeMs,
      size: st.size,
    },
  ];
}

/**
 * Give every source a unique id. A browser with one profile keeps the bare
 * browser id ("chrome"); multiple profiles get "chrome/ed-work" style ids.
 */
function assignIds(sources: HistorySource[]): HistorySource[] {
  const perBrowser = new Map<string, HistorySource[]>();
  for (const source of sources) {
    const list = perBrowser.get(source.browser) ?? [];
    list.push(source);
    perBrowser.set(source.browser, list);
  }
  const used = new Set<string>();
  for (const list of perBrowser.values()) {
    for (const source of list) {
      let id = source.browser;
      if (list.length > 1) {
        const suffix = slug(source.profile ?? "") || "profile";
        id = `${source.browser}/${suffix}`;
      }
      let unique = id;
      let n = 2;
      while (used.has(unique)) unique = `${id}-${n++}`;
      used.add(unique);
      source.id = unique;
    }
  }
  return sources;
}

/** All history databases on this machine, most recently written first. */
export function discoverSources(): HistorySource[] {
  const sources: HistorySource[] = [];
  for (const root of chromiumRoots()) sources.push(...chromiumSources(root));
  sources.push(...firefoxSources());
  sources.push(...safariSources());
  assignIds(sources);
  return sources.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
}

/**
 * Filter sources by user-supplied names. A name matches the source id, browser
 * family, profile name or full label (all case/punctuation insensitive), so
 * `in:chrome` selects every Chrome profile and `in:ed-work` selects one.
 */
export function filterSources(sources: HistorySource[], names: string[]): HistorySource[] {
  if (names.length === 0) return sources;
  const wanted = names.map((name) => slug(name)).filter(Boolean);
  if (wanted.length === 0) return sources;
  return sources.filter((source) => {
    const keys = [slug(source.id), slug(source.browser), slug(source.label)];
    if (source.profile) keys.push(slug(source.profile));
    return wanted.some((name) => keys.includes(name));
  });
}
