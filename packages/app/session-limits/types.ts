/**
 * @file types.ts
 * @description Frontend data contract for the subscription session-limit UI
 * (PRD-538). Mirrors the `/usage` utilization surface: a 5-hour session window,
 * a rolling weekly window (all models + per-model splits), and optional
 * extra-usage credits. Percentages are server-computed (0–100), NOT derived
 * from local token counts. The desktop main process maps the endpoint's
 * snake_case payload into this camelCase shape before it reaches the renderer.
 */

/** One rate-limit window: how much is used and when it resets. */
export type RateLimit = {
  /** Server-computed utilization percentage, 0–100. */
  utilization: number;
  /** ISO-8601 reset timestamp, or null when the window has no scheduled reset. */
  resetsAt: string | null;
};

/** Optional pay-as-you-go overage credits (Pro/Max plans). */
export type ExtraUsage = {
  isEnabled: boolean;
  /** Monthly credit ceiling in USD, or null for unlimited. */
  monthlyLimitUsd: number | null;
  /** Credits consumed this month in USD, or null when unknown. */
  usedCreditsUsd: number | null;
  /** Utilization of the monthly ceiling, 0–100, or null. */
  utilization: number | null;
};

/**
 * The snapshot-producer values — single source of truth for the source union,
 * shared by the web/desktop renderer (this package) and mirrored by the desktop
 * main process. The main process re-declares these literals (rather than
 * runtime-importing them) to keep its process free of the `@repo/app` runtime
 * graph, but `apps/desktop/src/shared/session-limits-channel` compile-guards its
 * copy against this type so the two unions cannot silently drift when a new
 * producer is added — see the `SessionLimitSourceTwin` assertion there.
 *  - `usage_api` — the owned `/api/oauth/usage` endpoint (AUTHORITATIVE);
 *  - `statusline` — continuous per-window percentages (RICH);
 *  - `rate_limit_event` — status/reset only (COARSE).
 */
export const SESSION_LIMIT_SOURCES = {
  UsageApi: "usage_api",
  Statusline: "statusline",
  RateLimitEvent: "rate_limit_event",
} as const;

/** Which producer captured the snapshot; drives the detail drawer's provenance. */
export type SessionLimitSource =
  (typeof SESSION_LIMIT_SOURCES)[keyof typeof SESSION_LIMIT_SOURCES];

/**
 * The subscription session-limit snapshot. Every window is nullable: a plan may
 * expose only a subset, and a non-subscription credential exposes none (the UI
 * hides itself — see {@link hasAnySessionLimit}).
 */
export type SessionLimits = {
  /** 5-hour rolling session window ("Current session"). */
  fiveHour: RateLimit | null;
  /** 7-day rolling window across all models ("Current week"). */
  sevenDay: RateLimit | null;
  /** 7-day window for Opus only (Max/Team plans). */
  sevenDayOpus: RateLimit | null;
  /** 7-day window for Sonnet only (Max/Team plans). */
  sevenDaySonnet: RateLimit | null;
  extraUsage: ExtraUsage | null;
  /** When the snapshot was fetched (ISO-8601), for staleness display. */
  fetchedAt: string | null;
  /**
   * Which producer captured this snapshot, for the detail drawer's provenance
   * line. Absent/null when unknown (the drawer then omits the source label).
   */
  source?: SessionLimitSource | null;
};

/**
 * The four states the session-limit UI must keep distinct (PRD-538 R6). A bare
 * `SessionLimits | null` cannot: it collapses "still fetching" into "nothing to
 * show", which is how a bar that actually means "we could not fetch" ends up
 * rendering as an honest-looking empty meter.
 *
 * The fourth state — a genuine 0% — is not a status: it is
 * {@link SessionLimitsStatus.Ready} carrying `utilization: 0`, and it must stay
 * that way. A measured zero is real data and renders as a real, empty bar; the
 * other three states never render a bar at all.
 */
export const SessionLimitsStatus = {
  /** The snapshot has not resolved yet — render a loading affordance, not a zero. */
  Loading: "loading",
  /**
   * No subscription snapshot is available (no credential, no producer, or the
   * bridge is absent) — the feature hides itself entirely. On a default macOS
   * install this is the COMMON case, not an edge case: the capture path reads
   * the per-profile plaintext credential and deliberately never touches the
   * Keychain (PRD-538 R5), so a Keychain-only sign-in resolves here.
   */
  Unavailable: "unavailable",
  /** A snapshot is present and renderable. */
  Ready: "ready",
} as const;

export type SessionLimitsStatus =
  (typeof SessionLimitsStatus)[keyof typeof SessionLimitsStatus];

/**
 * What the renderer knows about the session-limit snapshot right now. A
 * discriminated union rather than a nullable value, so no consumer can
 * accidentally treat "not yet fetched" as "nothing to show".
 */
export type SessionLimitsState =
  | { status: typeof SessionLimitsStatus.Loading }
  | { status: typeof SessionLimitsStatus.Unavailable }
  | { status: typeof SessionLimitsStatus.Ready; limits: SessionLimits };

/** True when at least one limit window is present (drives show/hide). */
export function hasAnySessionLimit(limits: SessionLimits | null): boolean {
  if (!limits) {
    return false;
  }
  // Extra usage only counts as renderable content when it has a utilization to
  // draw — the bars/detail views both require it, so gating the nav on
  // `isEnabled` alone would mount an empty trigger.
  return Boolean(
    limits.fiveHour ||
      limits.sevenDay ||
      limits.sevenDayOpus ||
      limits.sevenDaySonnet ||
      (limits.extraUsage?.isEnabled && limits.extraUsage.utilization !== null)
  );
}
