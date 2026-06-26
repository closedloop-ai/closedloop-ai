import { log } from "@repo/observability/log";

let maxPerMinute = Number(process.env.TELEMETRY_RATE_LIMIT_PER_MINUTE ?? "60");
if (!Number.isFinite(maxPerMinute) || maxPerMinute <= 0) {
  log.warn("Invalid TELEMETRY_RATE_LIMIT_PER_MINUTE, defaulting to 60");
  maxPerMinute = 60;
}

const WINDOW_MS = 60_000;

type RateLimiter = {
  isRateLimited: (key: string) => boolean;
  remove: (key: string) => void;
  /** Drop keys whose sliding window has gone empty (idle-key eviction). */
  prune: () => void;
};

export function createRateLimiter(
  maxPerWindow: number,
  windowMs = WINDOW_MS
): RateLimiter {
  /** Per-key sliding-window timestamps (ms) of recent events. */
  const timestamps = new Map<string, number[]>();

  function isRateLimited(key: string): boolean {
    const now = Date.now();
    const windowStart = now - windowMs;
    const existing = timestamps.get(key) ?? [];
    const recent = existing.filter((t) => t > windowStart);

    if (recent.length >= maxPerWindow) {
      timestamps.set(key, recent);
      return true;
    }

    recent.push(now);
    timestamps.set(key, recent);
    return false;
  }

  function remove(key: string): void {
    timestamps.delete(key);
  }

  // Evict keys whose window has fully aged out. Without this, every distinct
  // key ever seen (e.g. a client-controlled app.installation.id or churning
  // client IP on an unauthenticated endpoint) would persist forever as an empty
  // array — an unbounded memory leak. Callers that key on attacker-influenced
  // values should call this periodically (see the keyless telemetry sweep).
  function prune(): void {
    const windowStart = Date.now() - windowMs;
    for (const [key, entries] of timestamps) {
      if (!entries.some((t) => t > windowStart)) {
        timestamps.delete(key);
      }
    }
  }

  return { isRateLimited, remove, prune };
}

const defaultRateLimiter = createRateLimiter(maxPerMinute);

/**
 * Attempt to record an event for `key`.
 * Returns `true` if the event is rate-limited, `false` if allowed.
 */
export const isRateLimited = defaultRateLimiter.isRateLimited;

/** Clean up state for a disconnected key. */
export const remove = defaultRateLimiter.remove;
