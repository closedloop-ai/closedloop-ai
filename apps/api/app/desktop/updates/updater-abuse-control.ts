export const DesktopUpdaterRateLimitRoute = {
  Feed: "feed",
  Asset: "asset",
} as const;
export type DesktopUpdaterRateLimitRoute =
  (typeof DesktopUpdaterRateLimitRoute)[keyof typeof DesktopUpdaterRateLimitRoute];

export const DesktopUpdaterRateLimitErrorCode = {
  RateLimited: "desktop_updater_rate_limited",
} as const;

export const DesktopUpdaterRateLimitError =
  "Desktop updater rate limit exceeded" as const;

export const DesktopUpdaterRateLimitWindowSeconds = 60;
export const DesktopUpdaterRateLimitMaxEntries = 2000;

export const DesktopUpdaterRateLimitLimit = {
  FeedClient: 30,
  AssetClientResource: 20,
  GlobalFeed: 300,
  GlobalAsset: 300,
} as const;

const DesktopUpdaterRateLimitScope = {
  Client: "client",
  Global: "global",
} as const;

export type DesktopUpdaterRateLimitRejection = {
  allowed: false;
  retryAfterSeconds: number;
  limit: number;
  windowSeconds: number;
  route: DesktopUpdaterRateLimitRoute;
};

export type DesktopUpdaterRateLimitResult =
  | { allowed: true }
  | DesktopUpdaterRateLimitRejection;

type RateLimitEntry = {
  resetAt: number;
  count: number;
};

type RateLimitAttempt =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; limit: number };
type DesktopUpdaterRateLimitScope =
  (typeof DesktopUpdaterRateLimitScope)[keyof typeof DesktopUpdaterRateLimitScope];
type RateLimitCheck = {
  key: string;
  limit: number;
  scope: DesktopUpdaterRateLimitScope;
};

const DesktopUpdaterRateLimitWindowMs = 60_000;
const UnknownDesktopUpdaterClientKey = "unknown";
const ClientAddressHeaders = [
  "x-vercel-forwarded-for",
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "fly-client-ip",
] as const;

class DesktopUpdaterFixedWindowLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  attempt(key: string, limit: number, now: number): RateLimitAttempt {
    this.pruneExpired(now);

    const current = this.entries.get(key);
    if (!current || now >= current.resetAt) {
      this.entries.set(key, {
        count: 1,
        resetAt: now + DesktopUpdaterRateLimitWindowMs,
      });
      this.pruneOldestEntries();
      return { allowed: true };
    }

    if (current.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((current.resetAt - now) / 1000)
        ),
        limit,
      };
    }

    current.count += 1;
    return { allowed: true };
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
    while (this.entries.size > DesktopUpdaterRateLimitMaxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }
}

const desktopUpdaterClientRateLimiter = new DesktopUpdaterFixedWindowLimiter();
const desktopUpdaterGlobalRateLimiter = new DesktopUpdaterFixedWindowLimiter();
let testNow: (() => number) | null = null;

export function consumeDesktopUpdaterRateLimit(
  request: Request,
  input:
    | { route: typeof DesktopUpdaterRateLimitRoute.Feed }
    | { route: typeof DesktopUpdaterRateLimitRoute.Asset; assetName: string }
): DesktopUpdaterRateLimitResult {
  const now = testNow?.() ?? Date.now();
  const clientKey = getDesktopUpdaterClientKey(request.headers);
  const checks: RateLimitCheck[] =
    input.route === DesktopUpdaterRateLimitRoute.Feed
      ? [
          {
            key: `desktop-updater:feed:${clientKey}`,
            limit: DesktopUpdaterRateLimitLimit.FeedClient,
            scope: DesktopUpdaterRateLimitScope.Client,
          },
          {
            key: "desktop-updater:feed:global",
            limit: DesktopUpdaterRateLimitLimit.GlobalFeed,
            scope: DesktopUpdaterRateLimitScope.Global,
          },
        ]
      : [
          {
            key: `desktop-updater:asset:${clientKey}:${input.assetName}`,
            limit: DesktopUpdaterRateLimitLimit.AssetClientResource,
            scope: DesktopUpdaterRateLimitScope.Client,
          },
          {
            key: "desktop-updater:asset:global",
            limit: DesktopUpdaterRateLimitLimit.GlobalAsset,
            scope: DesktopUpdaterRateLimitScope.Global,
          },
        ];

  for (const check of checks) {
    const limiter =
      check.scope === DesktopUpdaterRateLimitScope.Global
        ? desktopUpdaterGlobalRateLimiter
        : desktopUpdaterClientRateLimiter;
    const result = limiter.attempt(check.key, check.limit, now);
    if (!result.allowed) {
      return {
        allowed: false,
        retryAfterSeconds: result.retryAfterSeconds,
        limit: result.limit,
        windowSeconds: DesktopUpdaterRateLimitWindowSeconds,
        route: input.route,
      };
    }
  }

  return { allowed: true };
}

export function resetDesktopUpdaterRateLimiterForTests(): void {
  desktopUpdaterClientRateLimiter.clear();
  desktopUpdaterGlobalRateLimiter.clear();
  testNow = null;
}

export function setDesktopUpdaterRateLimiterNowForTests(
  now: (() => number) | null
): void {
  testNow = now;
}

function getDesktopUpdaterClientKey(headers: Headers): string {
  for (const header of ClientAddressHeaders) {
    const value = normalizeClientAddress(headers.get(header));
    if (value !== null) {
      return value;
    }
  }

  return UnknownDesktopUpdaterClientKey;
}

function normalizeClientAddress(value: string | null): string | null {
  const firstValue = value?.split(",")[0]?.trim().toLowerCase();
  if (!firstValue) {
    return null;
  }

  return firstValue.slice(0, 128);
}
