/**
 * Time-window scoping for the org Usage Dashboard (FEA-1541).
 *
 * The dashboard previously rendered date-range-scoped totals (7d/30d/90d/all)
 * but lacked the shorter "today" window and an explicit "as of" indicator, so a
 * reader could not tell *what window* a total covered or *when* it was computed.
 *
 * This module adds a usage-page-local scope vocabulary (a superset of the org
 * ranges the endpoint can serve) rather than widening the shared `DateRange`
 * union — that union is consumed by ~20 branch/session/insights toolbars, and
 * broadening it there would be an unrelated exhaustive change. The start-date
 * math delegates to `getStartIsoForDays` (the single source of day-subtraction),
 * so window boundaries stay consistent with every other selector and never
 * double-count or drift.
 *
 * Session and billing-cycle scopes from the FEA-1541 spec are intentionally out
 * of scope here: the org `/loops/usage` endpoint aggregates across loops and has
 * no per-session boundary or billing-cycle anchor to filter on. Those windows
 * belong to the per-session and Settings→Cost surfaces, not this org rollup.
 */

import { getStartIsoForDays } from "@repo/app/shared/lib/format-utils";

/**
 * Ordered usage-window scopes. `"today"` is the trailing-24h day window (AC-007.1
 * "today"); `all` is preserved as the prior all-time total so no existing view is
 * lost. Kept as a const tuple so the option list and the exhaustive label map stay
 * in lockstep.
 */
export const USAGE_SCOPES = ["today", "7d", "30d", "90d", "all"] as const;

export type UsageScope = (typeof USAGE_SCOPES)[number];

export const USAGE_SCOPE_LABELS: Record<UsageScope, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

/** Day-length of each bounded scope; `all` is unbounded and handled separately. */
const SCOPE_DAYS: Record<Exclude<UsageScope, "all">, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export function parseUsageScope(value: string | null): UsageScope {
  return USAGE_SCOPES.includes(value as UsageScope)
    ? (value as UsageScope)
    : "30d";
}

/**
 * Inclusive lower-bound ISO timestamp for a scope, or `undefined` for the
 * unbounded `all` window. `now` is injectable for deterministic tests. Delegates
 * to the shared day-subtraction so the "today" window is exactly the trailing 24
 * hours and never disagrees with the 7d/30d boundaries by an off-by-one.
 */
export function getUsageScopeStartIso(
  scope: UsageScope,
  now: Date = new Date()
): string | undefined {
  const days = scope === "all" ? undefined : SCOPE_DAYS[scope];
  return getStartIsoForDays(days, now);
}

/**
 * Human-readable "as of" stamp for when the currently-displayed data was
 * computed/refreshed (AC-007.2). Locale-formatted date + time so the reader can
 * gauge freshness at a glance; screen-reader friendly as plain text.
 */
export function formatAsOf(at: Date): string {
  return at.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
