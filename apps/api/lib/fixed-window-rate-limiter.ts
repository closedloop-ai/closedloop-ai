/**
 * Best-effort in-memory fixed-window rate limiter shared by the desktop
 * control-plane surfaces (agent-sessions sync, analytics ingest, transcript
 * sync). Per the apps/api serverless rule it keys on a stable principal and
 * bounds memory with TTL eviction + a hard max entry count. Serverless
 * instances are ephemeral, so this only throttles a hot single instance — it is
 * abuse control, not a durable authorization primitive.
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

  /** Returns true if the request is allowed, false if the window is exhausted. */
  attempt(key: string, now: number): boolean {
    this.pruneExpired(now);

    const current = this.entries.get(key);
    if (!current || now >= current.resetAt) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      this.pruneOldestEntries();
      return true;
    }

    if (current.count >= this.maxRequests) {
      return false;
    }

    current.count += 1;
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
