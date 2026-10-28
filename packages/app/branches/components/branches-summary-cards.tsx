"use client";

import type { BranchAnalytics } from "@repo/api/src/types/branch";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { summaryCardClass } from "@repo/app/shared/components/summary-card-row";
import { ApprovedBranchesSummaryCards } from "./approved-branches-summary-cards";

/**
 * Branches summary KPI cards (FEA-1948 / B6; FEA-2051). Prop-driven (FEA-3056
 * follow-up): the analytics read is fetched ONCE by a parent alongside the
 * branch list (`useBranchesPageData`) and passed down here, rather than each
 * mounting its own `useBranchAnalytics` query — the Branches screen renders
 * this alongside the list on every load, and two independent queries meant two
 * independent scans of the same underlying rows.
 *
 * ISS-9961 deleted this file's SECOND definition of the same five cards — a
 * local `CARDS` array rendered by a local `BranchKpiCard`, reached only when the
 * `approved` prop was false. Both live hosts (the web Branches page and the
 * desktop `BranchesView`) passed `approved`, so that row was unreachable in
 * production and had already drifted from the one readers actually see: it
 * called Active branches Neutral where the shipped row calls it
 * HigherIsBetter. Two definitions of one row is how the unseen one drifts, so
 * there is now exactly one, and this component is the thin seam that names the
 * canonical bundle's props for its two hosts.
 */
export function BranchesSummaryCards({
  className,
  cardClassName,
  analytics: data,
  isPending,
  isReloading = false,
  isError,
  wrapBelow = false,
  approvedComparisonSuppressedByFilter = false,
  approvedReservesDeltaSlot,
  trendSparkline = false,
  githubConnect,
  hiddenCardIds,
}: {
  /** ISS-12664 @see ApprovedBranchesSummaryCards `hiddenCardIds`. */
  hiddenCardIds?: ReadonlySet<string>;
  /** The ask a card offers when its value is unavailable; see `CanonicalMetricCard`. */
  githubConnect?: GitHubConnectTarget;
  /** Layout for the card container (desktop passes its dashboard grid). */
  className?: string;
  /**
   * Forwarded to `SummaryCardRow`: below `md` pair the cards two-up in a
   * full-width grid (an odd last card spans both columns) instead of the
   * non-wrapping horizontally-scrolling flex line, then return to the shared
   * auto-fit tracks at `md+`.
   *
   * Plumbed for the desktop hosts (ISS-4787 follow-up, stage review). They used
   * to pass a grid `className` that overrode the row's own `display` to get the
   * `md+` half of this, which left their narrow layout stacking one card per row
   * while the row's own `wrapBelow` paired them — the same strip with two
   * different narrow treatments. Defaults to `false`; callers opt in when their
   * approved surface uses the shared paired-narrow / auto-fit-wide contract.
   */
  wrapBelow?: boolean;
  /** Per-card styling. Defaults to the selected row mode's shared card class. */
  cardClassName?: string;
  /** The fetched analytics, or `undefined` while the parent's read is pending. */
  analytics: BranchAnalytics | undefined;
  /** Loading state from the parent's combined read. */
  isPending: boolean;
  /**
   * ISS-9887: the read is serving the PREVIOUS scope's payload
   * (`isPlaceholderData`). The approved row folds it into the loading decision
   * so stale-scope metrics do not restate themselves as current.
   */
  isReloading?: boolean;
  /** Error state from the parent's combined read. */
  isError: boolean;
  /**
   * ISS-5714 (review thread): did the local filtered-metrics fallback replace
   * the approved cards' comparisons? NOT "are facets active" — an exact
   * cohort response carries the filtered cohort's own producer metrics, and a
   * gap in those is a data-availability gap the filter did not cause. Callers
   * pass `ApprovedBranchCohortAnalytics.comparisonSuppressedByFilter`.
   */
  approvedComparisonSuppressedByFilter?: boolean;
  /**
   * Whether the selected date range has a finite prior-comparison slot to
   * reserve while the approved producer bundle has not loaded yet.
   */
  approvedReservesDeltaSlot?: boolean;
  /**
   * ISS-10544 — does THIS host serve the trend sparkline on a metric card?
   *
   * The one host capability on this seam whose two production answers differ:
   * the web app graduated `branches-metric-card-trend-sparkline` (operator
   * ruling, 2026-09-17) and answers yes unconditionally, while the desktop
   * renderer still resolves the key and answers no for the signed-out readers
   * that key can never open for. A host therefore has to be ASKED — a read in
   * this shared module could only give both shells the same answer, which is
   * the state the ruling replaced.
   *
   * Defaults to `false` so a fixture that has not answered renders the row it
   * renders today; the two production hosts both answer, asserted over their own
   * source in `apps/app/__tests__/branch-metric-sparkline-host-parity.test.tsx`.
   */
  trendSparkline?: boolean;
}) {
  const resolvedCardClassName = cardClassName ?? summaryCardClass(wrapBelow);

  return (
    <ApprovedBranchesSummaryCards
      cardClassName={resolvedCardClassName}
      className={className}
      comparisonSuppressedByFilter={approvedComparisonSuppressedByFilter}
      githubConnect={githubConnect}
      hiddenCardIds={hiddenCardIds}
      isError={isError}
      isPending={isPending}
      isReloading={isReloading}
      metrics={data?.canonicalMetrics}
      reservesPendingComparisonSlot={approvedReservesDeltaSlot}
      trendSparkline={trendSparkline}
      wrapBelow={wrapBelow}
    />
  );
}
