import { log } from "@repo/observability/log";

let maxPerMinute = Number(process.env.TELEMETRY_RATE_LIMIT_PER_MINUTE ?? "60");
if (!Number.isFinite(maxPerMinute) || maxPerMinute <= 0) {
  log.warn("Invalid TELEMETRY_RATE_LIMIT_PER_MINUTE, defaulting to 60");
  maxPerMinute = 60;
}

const WINDOW_MS = 60_000;

/** Per-key sliding-window timestamps (ms) of recent events. */
const timestamps = new Map<string, number[]>();

/**
 * Attempt to record an event for `key`.
 * Returns `true` if the event is allowed, `false` if rate-limited.
 */
export function isRateLimited(key: string): boolean {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const existing = timestamps.get(key) ?? [];
  const recent = existing.filter((t) => t > windowStart);

  if (recent.length >= maxPerMinute) {
    timestamps.set(key, recent);
    return true;
  }

  recent.push(now);
  timestamps.set(key, recent);
  return false;
}

/** Clean up state for a disconnected key. */
export function remove(key: string): void {
  timestamps.delete(key);
}
