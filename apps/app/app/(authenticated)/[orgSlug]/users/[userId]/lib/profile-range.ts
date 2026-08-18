/**
 * Time-window scoping for the user profile page (FEA-4064).
 *
 * The profile previously rendered undifferentiated lifetime totals with no
 * stated window, so a visitor could not tell what period the headline numbers
 * covered. This module adds a profile-page-local range vocabulary (30d / 90d /
 * 1y, matching the prototype header) that drives the ranged headline metrics.
 *
 * It is a page-local vocabulary rather than a widening of the shared `DateRange`
 * union (which ~20 branch/session/insights toolbars consume) — that would be an
 * unrelated exhaustive change. The start-date math delegates to
 * `getStartIsoForDays`, the single source of day-subtraction, so the window
 * boundaries stay consistent with every other selector and never drift.
 *
 * The contribution heatmap keeps its own fixed trailing-52-week window and is
 * intentionally NOT scoped by this range — a heatmap is a year grid by
 * definition.
 */

import { getStartIsoForDays } from "@repo/app/shared/lib/format-utils";

/**
 * Ordered profile-window scopes. Kept as a const tuple so the toggle's option
 * list and the exhaustive label map stay in lockstep.
 */
export const PROFILE_RANGES = ["30d", "90d", "1y"] as const;

export type ProfileRange = (typeof PROFILE_RANGES)[number];

export const PROFILE_RANGE_LABELS: Record<ProfileRange, string> = {
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "1y": "Last year",
};

/** Compact labels for the segmented toggle itself. */
export const PROFILE_RANGE_SHORT_LABELS: Record<ProfileRange, string> = {
  "30d": "30d",
  "90d": "90d",
  "1y": "1y",
};

/** Day-length of each profile scope. */
const PROFILE_RANGE_DAYS: Record<ProfileRange, number> = {
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

export const DEFAULT_PROFILE_RANGE: ProfileRange = "30d";

export function parseProfileRange(value: string | null): ProfileRange {
  return PROFILE_RANGES.includes(value as ProfileRange)
    ? (value as ProfileRange)
    : DEFAULT_PROFILE_RANGE;
}

/**
 * Inclusive lower-bound ISO timestamp for a profile range. `now` is injectable
 * for deterministic tests. Delegates to the shared day-subtraction so the
 * window boundaries never disagree with the other selectors by an off-by-one.
 */
export function getProfileRangeStartIso(
  range: ProfileRange,
  now: Date = new Date()
): string | undefined {
  return getStartIsoForDays(PROFILE_RANGE_DAYS[range], now);
}
