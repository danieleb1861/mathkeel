const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Half-life of the wake: it reads as recent for an hour, then fades out. */
export const WAKE_HALF_LIFE_MS = 25 * MINUTE;
const WAKE_FLOOR = 0.06;

export function ago(from: string, now: number): string {
  const elapsed = now - Date.parse(from);
  if (!Number.isFinite(elapsed)) return "unknown time";
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  const days = Math.floor(elapsed / DAY);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export function stamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Visible strength of a wake in [0, 1], or 0 once it has faded out. */
export function wakeStrength(changedAt: string, now: number): number {
  const elapsed = Math.max(0, now - Date.parse(changedAt));
  if (!Number.isFinite(elapsed)) return 0;
  const strength = 2 ** (-elapsed / WAKE_HALF_LIFE_MS);
  return strength < WAKE_FLOOR ? 0 : strength;
}

export function percent(share: number): string {
  const value = Math.max(0, Math.min(1, share)) * 100;
  return value > 0 && value < 1 ? "<1" : String(Math.round(value));
}
