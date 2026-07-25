/**
 * Lock-safe access to live browser history databases.
 *
 * Chromium browsers hold their History database with `PRAGMA locking_mode =
 * EXCLUSIVE`, so a running Chrome makes even read-only queries fail with
 * "database is locked". Firefox/Safari are usually readable in place. Strategy:
 * try the real file first, and fall back to a cached copy keyed by the source
 * file's mtime + size (so the copy is only re-made after the browser writes).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HistorySource } from "./sources.ts";

/** SQLite sidecar files that must travel with a copied database. */
const SIDECARS = ["-wal", "-shm", "-journal"];

export function cacheDir(): string {
  return (
    process.env.PI_BROWSER_HISTORY_CACHE ??
    join(homedir(), ".pi", "agent", "browser-history", "snapshots")
  );
}

function sourceKey(source: HistorySource): string {
  const digest = createHash("sha1").update(source.dbPath).digest("hex").slice(0, 8);
  return `${source.id.replace(/[^a-zA-Z0-9._-]+/g, "_")}-${digest}`;
}

function isPermissionError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error);
  return /EPERM|operation not permitted|unable to open database file|SQLITE_CANTOPEN/i.test(message);
}

/** Human-readable reason a source could not be read. */
export function describeOpenError(source: HistorySource, error: unknown): string {
  const message = String((error as { message?: unknown })?.message ?? error);
  if (isPermissionError(error) && source.engine === "safari") {
    return `${message} — Safari history needs Full Disk Access for your terminal (System Settings › Privacy & Security › Full Disk Access)`;
  }
  if (isPermissionError(error)) {
    return `${message} — your terminal may need file access permission for ${source.dbPath}`;
  }
  return message;
}

function tryOpen(path: string, readOnly: boolean): DatabaseSync | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly });
    // Force a real read: the exclusive-lock error only surfaces on first access.
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return db;
  } catch {
    try {
      db?.close();
    } catch {
      // ignore
    }
    return undefined;
  }
}

/**
 * Copy `source` (plus SQLite sidecars) into the cache and return the copy path.
 * The copy is built in a temp directory and renamed into place, so a partially
 * copied database is never observed as valid.
 */
export function ensureSnapshot(source: HistorySource): string {
  const root = cacheDir();
  const key = sourceKey(source);
  const dirName = `${key}-${Math.round(source.mtimeMs)}-${source.size}`;
  const dir = join(root, dirName);
  const dbPath = join(dir, "history.db");
  if (existsSync(dbPath)) {
    pruneSnapshots(key, dirName);
    return dbPath;
  }

  mkdirSync(root, { recursive: true });
  const tmp = join(root, `.tmp-${key}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    copyFileSync(source.dbPath, join(tmp, "history.db"));
    for (const suffix of SIDECARS) {
      const sidecar = `${source.dbPath}${suffix}`;
      if (existsSync(sidecar)) copyFileSync(sidecar, join(tmp, `history.db${suffix}`));
    }
    renameSync(tmp, dir);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    // Another process may have won the race and created the same snapshot.
    if (!existsSync(dbPath)) throw error;
  }
  pruneSnapshots(key, dirName);
  return dbPath;
}

/** Drop older snapshots of the same source. */
export function pruneSnapshots(key: string, keep: string): void {
  const root = cacheDir();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === keep || !entry.startsWith(`${key}-`)) continue;
    rmSync(join(root, entry), { recursive: true, force: true });
  }
}

export interface OpenedDb {
  db: DatabaseSync;
  /** Path actually opened (the live file, or a cached copy). */
  path: string;
  /** True when reading a cached copy rather than the live database. */
  copied: boolean;
}

/** Open a source for reading, copying it first if the browser holds the lock. */
export function openHistoryDb(source: HistorySource): OpenedDb {
  const direct = tryOpen(source.dbPath, true);
  if (direct) return { db: direct, path: source.dbPath, copied: false };

  const snapshot = ensureSnapshot(source);
  // The copy is disposable: allow read-write so SQLite can roll back a hot
  // journal that was mid-transaction when we copied it. We never write to it.
  const db = tryOpen(snapshot, true) ?? tryOpen(snapshot, false);
  if (!db) throw new Error(`could not read history database copy at ${snapshot}`);
  return { db, path: snapshot, copied: true };
}

/** Delete every cached snapshot. Safe at any time; copies are rebuilt on demand. */
export function clearSnapshots(): number {
  const root = cacheDir();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    rmSync(join(root, entry), { recursive: true, force: true });
    removed++;
  }
  return removed;
}
