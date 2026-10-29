/**
 * Best-effort in-memory fixed-window rate limiter shared by the desktop
 * control-plane surfaces (agent-sessions sync, analytics ingest, transcript
 * sync). Per the apps/api serverless rule it keys on a stable principal and
 * bounds memory with TTL eviction + a hard max entry count. Serverless
 * instances are ephemeral, so this only throttles a hot single instance — it is
 * abuse control, not a durable authorization primitive.
 */

/**
 * Default budget shared by every subclass that passes no options (analytics,
 * agent-sessions sync, transcript sync). Lane-specific sizing rationale lives
 * with the owning subclass — the analytics lane's PRD-736 D6 rationale is on
 * `DesktopAnalyticsRateLimiter` in `desktop-analytics-handler.ts`.
 */
export const FIXED_WINDOW_RATE_LIMIT_MAX_REQUESTS = 120;
export const FIXED_WINDOW_RATE_LIMIT_WINDOW_MS = 60_000;
export const FIXED_WINDOW_RATE_LIMIT_MAX_ENTRIES = 10_000;

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export type FixedWindowRateLimiterOptions = {
  maxEntries?: number;
  maxRequests?: number;
  windowMs?: number;
};

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly maxEntries: number;
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(options: FixedWindowRateLimiterOptions = {}) {
    this.maxEntries = options.maxEntries ?? FIXED_WINDOW_RATE_LIMIT_MAX_ENTRIES;
    this.maxRequests =
      options.maxRequests ?? FIXED_WINDOW_RATE_LIMIT_MAX_REQUESTS;
    this.windowMs = options.windowMs ?? FIXED_WINDOW_RATE_LIMIT_WINDOW_MS;
  }

  /**
   * Returns true if the request is allowed, false if the window is exhausted.
   * `cost` charges more than one unit (ISS-11946: a byte budget charges the
   * body size); the first attempt in a window is always admitted.
   */
  attempt(key: string, now: number, cost = 1): boolean {
    this.pruneExpired(now);

    const current = this.entries.get(key);
    if (!current || now >= current.resetAt) {
      this.entries.set(key, { count: cost, resetAt: now + this.windowMs });
      this.pruneOldestEntries();
      return true;
    }

    if (current.count + cost > this.maxRequests) {
      return false;
    }

    current.count += cost;
    return true;
  }

  clear(): void {
    this.entries.clear();
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) {
        this.entries.delete(key);
      }
    }
  }

  private pruneOldestEntries(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }
}

/**
 * ISS-10014: the `Retry-After` a throttled caller is told to wait, in the
 * delta-seconds form RFC 9110 defines — a non-negative INTEGER, so the window
 * is rounded UP: `1.5` is rejected by the desktop's parser and silently
 * dropped, and rounding down would name a wait shorter than the window.
 *
 * The whole window rather than the key's true remainder: `attempt()` answers
 * allowed/refused and does not surface `resetAt`, and the whole window is the
 * bound that is always true. Over-stating is the safe direction — the hint is
 * a MINIMUM wait, so a caller that waits it out always finds its budget
 * refilled, while a short hint would invite a retry into the same exhausted
 * window.
 */
export function fixedWindowRetryAfterSeconds(windowMs: number): number {
  return Math.max(1, Math.ceil(windowMs / 1000));
}

export const FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS =
  fixedWindowRetryAfterSeconds(FIXED_WINDOW_RATE_LIMIT_WINDOW_MS);
