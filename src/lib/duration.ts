export const MIN_ROW_TIMEOUT_SECONDS = 30;
export const MAX_ROW_TIMEOUT_SECONDS = 3600;

/**
 * Parses human durations: "90", "90s", "2m", "2 min", "1h", "1h 30m", "00:02:30", "2:30".
 * Returns seconds, or null when unparseable.
 */
export function parseDurationToSeconds(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? Math.round(input) : null;

  const raw = String(input).trim().toLowerCase();
  if (!raw) return null;

  // clock form h:mm:ss or m:ss
  if (/^\d+(:\d{1,2}){1,2}$/.test(raw)) {
    const parts = raw.split(":").map((p) => Number(p));
    const [a, b, c] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
    return Math.round((a ?? 0) * 3600 + (b ?? 0) * 60 + (c ?? 0));
  }

  // bare number => seconds
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw));

  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    matched = true;
    const value = Number(m[1]);
    const unit = m[2] ?? "s";
    if (unit.startsWith("h")) total += value * 3600;
    else if (unit.startsWith("m")) total += value * 60;
    else total += value;
  }
  if (!matched) return null;
  return Math.round(total);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || parts.length === 0) parts.push(`${sec}s`);
  return parts.join(" ");
}
