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
// ISS-10414 KEPT THAT INDICATOR AND ADDED A SECOND, NARROWER ONE — read the
// paragraph above as "one indicator for the dashboard-wide FACT", not as "no
// row may ever speak for itself". FEA-4020 assumed the sections land together,
// which is what makes nine indicators nine spellings of one fact. They do not:
// Delivery answers in a beat and Utilization/Agents can trail it by minutes, so
// a reader watching the global word sees the new range's Cost and merged PRs
// beside the previous range's Sessions KPI, Event Activity, model cost and
// autonomy — with nothing on screen saying which half is which. The global
// indicator answers "is anything still in flight"; {@link
// DashboardRowUpdatingNotice} answers "is what I am reading RIGHT HERE the
// selection I just made", which the global one cannot. It is shown only on the
// widgets whose sections are genuinely still serving the previous key, so it
// clears row by row as they land rather than painting every row at once — and
// it is rendered INSIDE each widget's own card, so it travels with the widget
// into the fullscreen expand dialog instead of being left behind in the grid.
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

  return useDebouncedVisibility(userRequested);
}

/**
 * Onset + minimum-visible debounce for an in-flight disclosure.
 *
 * Shared by the header indicator and {@link DashboardRowUpdatingNotice} so the
 * two cannot drift: a sub-perceptual refetch paints neither, and a refetch that
 * lands just after the onset cannot stutter either one off a frame later.
 * Review thread 2026-09-17: the row notice flipped the instant
 * `isPlaceholderData` did, so every section keyed on `period:scope` chipped
 * itself on the first frames after every range click — ten copies of one
 * sentence, the shape FEA-4020 was written to reject. Only the genuinely
 * lagging sections reach the onset.
 */
export function useDebouncedVisibility(active: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const onsetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minVisibleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownAtRef = useRef<number | null>(null);

  useEffect(() => {
    const clearOnset = () => {
      if (onsetTimerRef.current) {
        clearTimeout(onsetTimerRef.current);
        onsetTimerRef.current = null;
      }
    };

    if (active) {
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
  }, [active, visible]);

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
  // The live region is always mounted so a screen reader picks up the
  // transition into and out of "Refreshing"; the visible Chip is present only
  // while refreshing.
  return (
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

/**
 * ISS-10414: the per-row half of the disclosure. Shown on a dashboard row whose
 * insights section is still serving the PREVIOUS range/scope's payload, so the
 * numbers and axes under it are not the selection the reader just made.
 *
 * The visible word is short because it sits in a widget's own card, not in a
 * page header. The sentence a reader actually needs — WHICH data they are
 * looking at — reaches assistive tech through the sr-only live region below and
 * sighted readers through the chip's `title`. It is NOT an `aria-label` on the
 * chip: `Chip` renders a bare `<span>`, which maps to `role=generic`, and
 * accname prohibits naming there — so the sentence most likely never reached AT
 * at all, and neither test layer could see it because RTL `getByLabelText` and
 * Playwright `getByLabel` both read the attribute off the DOM rather than the
 * accessibility tree (review thread, 2026-09-17).
 *
 * The live region is ALWAYS mounted, for the reason
 * {@link DashboardRefreshingIndicator} carries the same note: a region inserted
 * into the DOM with its content already inside it is routinely not announced,
 * and a region that unmounts never announces the clearance. It is `sr-only`,
 * which is absolutely positioned and therefore out of flow, so a settled card
 * pays no gap for it — the VISIBLE half is what mounts and unmounts.
 *
 * Built from the same `Chip` + `RefreshCwIcon` as
 * {@link DashboardRefreshingIndicator} so the two read as one family rather
 * than two inventions.
 *
 * A pure renderer: the onset debounce lives at the OWNER, which also swaps the
 * period and delta captions, so the chip and the captions can never appear a
 * frame apart. See {@link useDebouncedVisibility}.
 */
export function DashboardRowUpdatingNotice({
  stale,
  className,
  description = ROW_UPDATING_DESCRIPTION,
}: {
  stale: boolean;
  className?: string;
  /**
   * The sentence naming WHICH selection the content belongs to. Defaults to the
   * whole-row claim; a widget whose metrics span BOTH selections overrides it,
   * because telling the reader everything on it is the previous range is a
   * different wrong claim in the same family (review thread, 2026-09-17).
   */
  description?: string;
}) {
  return (
    <>
      <span aria-live="polite" className="sr-only" role="status">
        {stale ? description : ""}
      </span>
      {stale ? (
        <div className={cn("min-w-0", className)}>
          <Chip size="sm" title={description} variant="muted">
            <RefreshCwIcon aria-hidden="true" className="animate-spin" />
            {ROW_UPDATING_LABEL}
          </Chip>
        </div>
      ) : null}
    </>
  );
}

const ROW_UPDATING_LABEL = "Updating";

const ROW_UPDATING_DESCRIPTION =
  "Updating — still showing the previous range and scope";

/**
 * The AI Impact card's counterpart. That card DIVIDES one section by another, so
 * a half-settled dashboard draws cost and merged PRs from the new selection and
 * tokens/model share from the old one — and the two ratios span the pair. The
 * whole-row sentence would assert that all four belong to the previous
 * selection, which is simply a different false claim (review thread,
 * 2026-09-17), so this one names the mix instead.
 */
const MIXED_SELECTION_DESCRIPTION =
  "Updating — some figures are still from the previous range and scope, so the ratios combine two selections";

/**
 * What a range-labelled widget says instead of the SELECTED period while its
 * section is stale. "Last 7 days" printed over a ninety-day grid is the exact
 * contradiction ISS-10414 was filed for: the label asserted the selection, the
 * pixels were the previous one. This asserts neither.
 *
 * "Previous selection" and not "Previous range": scope is in the query key too,
 * and desktop has a live Me/Organization control, so flipping scope with the
 * range untouched at 7d withdrew a window that was still true and left the
 * reader unable to tell which seven days they were looking at (review thread,
 * 2026-09-17). The chip's sentence already names both axes; this now does too.
 */
const STALE_PERIOD_LABEL = "Previous selection";

/**
 * The comparison caption's counterpart to {@link STALE_PERIOD_LABEL}, and the
 * SECOND range claim a stale row makes. `deltaLabel` ("vs. prior 30 days") is
 * derived from the picker, not from the payload, so a ninety-day row that has
 * not refetched yet renders its QoQ delta captioned as the seven-day
 * comparison the reader just selected — the same contradiction as the period
 * caption, one widget over (review thread, 2026-09-16). The chip's NUMBER is
 * still drawn: what is withheld is only the window it claims to compare.
 */
const STALE_DELTA_LABEL = "vs. the prior period";

export {
  MIXED_SELECTION_DESCRIPTION,
  REFRESHING_LABEL,
  REFRESHING_MIN_VISIBLE_MS,
  REFRESHING_ONSET_MS,
  ROW_UPDATING_DESCRIPTION,
  ROW_UPDATING_LABEL,
  STALE_DELTA_LABEL,
  STALE_PERIOD_LABEL,
};
