/**
 * Time parsing (relative + ISO) and human-friendly formatting.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS: [RegExp, number][] = [
  [/^(?:m|min|mins|minute|minutes)$/i, MINUTE],
  [/^(?:h|hr|hrs|hour|hours)$/i, HOUR],
  [/^(?:d|day|days)$/i, DAY],
  [/^(?:w|wk|wks|week|weeks)$/i, 7 * DAY],
  [/^(?:mo|mon|mons|month|months)$/i, 30 * DAY],
  [/^(?:y|yr|yrs|year|years)$/i, 365 * DAY],
];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Parse a point in time. Accepts `now`, `today`, `yesterday`, relative offsets
 * (`30m`, `6h`, `7d`, `2w`, `3mo`, `1y`, optionally suffixed with ` ago`) and
 * local ISO-ish stamps (`2026-07`, `2026-07-01`, `2026-07-01 14:30`).
 * Returns undefined when the value is not understood.
 */
export function parseTime(input: string, now = Date.now()): number | undefined {
  const value = input.trim().replace(/\s+ago$/i, "").trim();
  if (!value) return undefined;

  const lower = value.toLowerCase();
  if (lower === "now") return now;
  if (lower === "today") return startOfDay(now);
  if (lower === "yesterday") return startOfDay(now) - DAY;

  const relative = lower.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/);
  if (relative) {
    const amount = Number(relative[1]);
    for (const [pattern, unit] of UNITS) {
      if (pattern.test(relative[2]!)) return now - amount * unit;
    }
    return undefined;
  }

  const iso = value.match(
    /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (iso) {
    // Local time, so "since:2026-07-01" means midnight where the user is.
    const date = new Date(
      Number(iso[1]),
      Number(iso[2]) - 1,
      iso[3] ? Number(iso[3]) : 1,
      iso[4] ? Number(iso[4]) : 0,
      iso[5] ? Number(iso[5]) : 0,
      iso[6] ? Number(iso[6]) : 0,
    );
    return Number.isNaN(date.getTime()) ? undefined : date.getTime();
  }

  return undefined;
}

/** "3m ago", "5h ago", "12d ago", "4mo ago". */
export function relativeTime(ms: number, now = Date.now()): string {
  const delta = now - ms;
  if (delta < 0) return "just now";
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 30 * DAY) return `${Math.floor(delta / DAY)}d ago`;
  if (delta < 365 * DAY) return `${Math.floor(delta / (30 * DAY))}mo ago`;
  return `${Math.floor(delta / (365 * DAY))}y ago`;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local "2026-07-25 10:31". */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local "2026-07-25". */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-07-25 10:31 (2h ago)". */
export function formatWhen(ms: number, now = Date.now()): string {
  return `${formatDateTime(ms)} (${relativeTime(ms, now)})`;
}
