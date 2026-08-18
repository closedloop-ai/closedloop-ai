"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import { cn } from "@repo/design-system/lib/utils";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// FEA-4020: the dashboard has ONE range/scope selection, and all of its section
// queries are keyed on it — so a range or scope change refetches every visible
// widget at once. Rather than dim every row and float a separate spinner over
// each (nine indicators telling the user one fact, each dropping text under the
// contrast floor, tearing widget subtrees down on the refresh flip, and
// colliding with the per-widget expand button), the whole dashboard carries a
// SINGLE "Refreshing" indicator in the header next to the range picker. Stale
// content stays fully visible and untouched underneath while the new range's
// numbers arrive; nothing reflows, no widget remounts, and no chart/toggle state
// is reset.
//
// The affordance is gated on the user-driven inputs (the applied range/scope),
// NOT on raw `isFetching`: a background poll or a db-change invalidation
// refetches the same range and must not flash the indicator (the desktop
// Recent-Sessions list polls every ~2s, which would otherwise strobe forever).
// It only shows while a refetch that a user *asked for* is in flight.

// Onset delay: a warm-cache refetch that resolves in well under this never
// paints the indicator, so a sub-perceptual refresh reads as instant rather
// than a flicker of chrome.
const REFRESHING_ONSET_MS = 400;
// Minimum on-screen time once shown, so a refetch that finishes just after the
// onset delay can't stutter the indicator off a frame later.
const REFRESHING_MIN_VISIBLE_MS = 600;

const REFRESHING_LABEL = "Refreshing";

/**
 * Derives whether the dashboard should show its single header "Refreshing"
 * indicator from (a) whether any section query is currently fetching and (b)
 * whether the user-driven request key (range + scope) has changed since the last
 * settle. A refetch at the *same* key — a poll tick or a db-change
 * invalidation — is deliberately ignored so background activity never flashes
 * the indicator. The returned boolean is debounced with an onset delay and a
 * minimum visible floor to avoid flicker on fast, warm-cache refetches.
 *
 * @param requestKey a stable string identifying the current user-driven inputs
 *   (e.g. `${period}:${scope}`). When it changes while a query is fetching, that
 *   fetch is treated as user-requested.
 * @param anyFetching true while any dashboard section query is in flight.
 * @param settled true once every section has settled (success or error) at
 *   least once — i.e. past the first load. The indicator never competes with the
 *   first-load skeletons.
 */
export function useDashboardRefreshing({
  requestKey,
  anyFetching,
  settled,
}: {
  requestKey: string;
  anyFetching: boolean;
  settled: boolean;
}): boolean {
  // The request key we last observed as fully settled. A fetch is
  // "user-requested" only while the live key differs from this.
  const settledKeyRef = useRef<string | null>(null);
  const [visible, setVisible] = useState(false);
  const onsetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minVisibleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownAtRef = useRef<number | null>(null);

  // Record the key as settled once nothing is fetching, so the next fetch at a
  // *new* key is recognized as user-requested (and a fetch at the same key is
  // not).
  if (settled && !anyFetching) {
    settledKeyRef.current = requestKey;
  }

  const userRequested =
    settled &&
    anyFetching &&
    settledKeyRef.current !== null &&
    settledKeyRef.current !== requestKey;

  useEffect(() => {
    const clearOnset = () => {
      if (onsetTimerRef.current) {
        clearTimeout(onsetTimerRef.current);
        onsetTimerRef.current = null;
      }
    };

    if (userRequested) {
      // Schedule the onset unless we're already showing (or already scheduled).
      if (!(visible || onsetTimerRef.current)) {
        onsetTimerRef.current = setTimeout(() => {
          onsetTimerRef.current = null;
          shownAtRef.current = Date.now();
          setVisible(true);
        }, REFRESHING_ONSET_MS);
      }
      return clearOnset;
    }

    // No longer refreshing: cancel a pending onset, and hold the indicator up
    // for the remainder of its minimum-visible floor before clearing it.
    clearOnset();
    if (!visible) {
      return;
    }
    const elapsed = Date.now() - (shownAtRef.current ?? 0);
    const remaining = Math.max(0, REFRESHING_MIN_VISIBLE_MS - elapsed);
    minVisibleTimerRef.current = setTimeout(() => {
      minVisibleTimerRef.current = null;
      shownAtRef.current = null;
      setVisible(false);
    }, remaining);
    return () => {
      if (minVisibleTimerRef.current) {
        clearTimeout(minVisibleTimerRef.current);
        minVisibleTimerRef.current = null;
      }
    };
  }, [userRequested, visible]);

  return visible;
}

/**
 * The single header "Refreshing" indicator for the dashboard, shown while a
 * user-driven range/scope change is refetching the section queries. Built from
 * the design-system `Chip` (muted variant) and the shared `RefreshCwIcon` so it
 * matches every other in-flight affordance in the product (e.g. the branch
 * refresh status), and rendered as a polite `role="status"` live region so
 * assistive tech announces the in-flight state and its clearance. It carries no
 * dimming or overlay — the stale content stays fully legible underneath.
 *
 * Renders nothing when not refreshing (so it occupies no header space at rest).
 * Shared across the web (`InsightsOverviewDashboard`) and desktop
 * (`first-launch-dashboard`) surfaces.
 */
export function DashboardRefreshingIndicator({
  refreshing,
  className,
}: {
  refreshing: boolean;
  className?: string;
}) {
  return (
    // The live region is always mounted so a screen reader picks up the
    // transition into and out of "Refreshing"; the visible Chip is present only
    // while refreshing.
    <div aria-live="polite" className={cn("min-w-0", className)} role="status">
      {refreshing ? (
        <Chip size="sm" variant="muted">
          <RefreshCwIcon aria-hidden="true" className="animate-spin" />
          {REFRESHING_LABEL}
        </Chip>
      ) : null}
    </div>
  );
}

export { REFRESHING_LABEL, REFRESHING_MIN_VISIBLE_MS, REFRESHING_ONSET_MS };
