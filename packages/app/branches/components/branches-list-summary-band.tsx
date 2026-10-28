"use client";

import type { BranchAnalytics } from "@repo/api/src/types/branch";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { ListReadErrorAlert } from "@repo/app/shared/components/list-read-error-alert";
import { SUMMARY_CARD_SURFACE_BAND_PROPS } from "@repo/app/shared/components/summary-card-row";
import {
  DATE_RANGE_LABELS,
  type DateRange,
} from "@repo/app/shared/lib/format-utils";
import { Button } from "@repo/design-system/components/ui/button";
import type { ReactNode } from "react";
import type { BranchCohortNoticeModel } from "../lib/branch-cohort-transparency";
import { resolveBranchesSummaryCardVisibility } from "../lib/branches-summary-card-visibility";
import { branchesSummaryReservesDeltaSlot } from "../lib/branches-summary-delta-slot";
import { BranchCohortNotice } from "./branch-cohort-notice";
import { BranchesSummaryCards } from "./branches-summary-cards";
import { GitHubConnectReturnNotice } from "./github-connect-return-notice";

export type BranchesListSummaryBandProps = {
  readonly cohortNotice: BranchCohortNoticeModel;
  readonly comparisonSuppressedByFilter: boolean;
  readonly dateRange: DateRange;
  readonly githubReturnStatus?: string | null;
  readonly onSummaryRetry: () => unknown;
  readonly summaryAnalyticsErrored: boolean;
  readonly summaryCards: BranchAnalytics | undefined;
  readonly summaryCardsErrored: boolean;
  readonly summaryCardsPending: boolean;
  readonly summaryCardsReloading: boolean;
  /**
   * ISS-10544: does the HOST serve the Branches metric-card trend series?
   *
   * A host capability rather than a read this shared band could perform: the
   * answer DIFFERS per shell. Web graduated `branches-metric-card-trend-sparkline`
   * (operator ruling, 2026-09-17); the desktop renderer still resolves the key at
   * `useDesktopBranchMetricSparkline`, and its signed-out readers resolve every
   * PostHog key false by design. Defaults to `false` so a mount that never
   * answered — a story, a fixture — renders exactly the row it renders today.
   */
  readonly trendSparkline?: boolean;
  /** The connect ask a card with an unavailable value offers; see `CanonicalMetricCard`. */
  readonly githubConnect?: GitHubConnectTarget;
  /**
   * What became of this band's ask, rendered by the host that owns the handoff.
   *
   * It travels with `githubConnect` because the two are one affordance: a
   * desktop reader who refuses the sign-in, or whose connect never opened, has
   * nothing else on this screen to learn it from — the stalled-load slot's own
   * status mounts only while the blocking read has produced nothing (tamsinb,
   * ISS-12638).
   */
  readonly githubConnectOutcome?: ReactNode;
  /** ISS-12664 @see ApprovedBranchesSummaryCards `hiddenCardIds`. */
  readonly hiddenSummaryCards?: ReadonlySet<string>;
};

/**
 * Shared Branches summary band placed by the list surface and reused by legacy
 * hosts.
 *
 * A card whose value is unavailable offers the host's connect ask in place of
 * its caption when the host passes `githubConnect` (ISS-12638, operator
 * instruction). `githubReturnStatus` stays because the return leg still lands
 * on this route from the stalled-load slot's ask.
 */
export function BranchesListSummaryBand({
  cohortNotice,
  comparisonSuppressedByFilter,
  dateRange,
  githubReturnStatus,
  onSummaryRetry,
  summaryAnalyticsErrored,
  summaryCards,
  summaryCardsErrored,
  summaryCardsPending,
  summaryCardsReloading,
  trendSparkline = false,
  githubConnect,
  githubConnectOutcome,
  hiddenSummaryCards,
}: BranchesListSummaryBandProps) {
  const cardsHidden =
    resolveBranchesSummaryCardVisibility(hiddenSummaryCards).allHidden;
  return (
    <>
      {/* #7544 / ISS-11472: the band's cards take its spare width instead of
          pinning to `--summary-card-min` and stranding the remainder as a dead
          gutter to the right of the last card — the reported regression, at
          every desktop width. The whole treatment is the shared set, not a
          choice this band makes; the `layout` prop that used to pick between a
          surface and a stacked arm is gone with the v1 host that asked for the
          stacked one.

          Only the CARD stretches. The row stays the fixed, horizontally-scrolling
          rank it was, because `GridTableListSurface` seats this band as a
          non-shrinking flex item beside the table's `min-h-0 flex-1` scroll
          region: a rank the strip gains is a rank the table loses. Measured on
          the launched desktop shell at 768x800, swapping this band onto the
          `wrapBelow` grid stacked four cards, took the band from 188.57px to
          549px and left the scroll region 0px tall, with its rows still
          reporting visible and unclickable
          (`apps/desktop/test/e2e/branches-awaiting-sync-row.spec.ts`). The
          gutter and the rank are independent defects; the shared set fixes the
          gutter on both bands and keeps the rank on both. */}
      {cardsHidden ? null : (
        <BranchesSummaryCards
          analytics={summaryCards}
          approvedComparisonSuppressedByFilter={comparisonSuppressedByFilter}
          approvedReservesDeltaSlot={branchesSummaryReservesDeltaSlot(
            dateRange
          )}
          {...SUMMARY_CARD_SURFACE_BAND_PROPS}
          githubConnect={githubConnect}
          hiddenCardIds={hiddenSummaryCards}
          isError={summaryCardsErrored}
          isPending={summaryCardsPending}
          isReloading={summaryCardsReloading}
          trendSparkline={trendSparkline}
        />
      )}
      {githubConnectOutcome}
      {summaryAnalyticsErrored ? (
        <ListReadErrorAlert
          action={
            <Button
              onClick={onSummaryRetry}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          }
          title="Couldn't load the summary metrics."
        />
      ) : null}
      <GitHubConnectReturnNotice status={githubReturnStatus ?? null} />
      <BranchCohortNotice
        model={cohortNotice}
        rangeLabel={DATE_RANGE_LABELS[dateRange]}
      />
    </>
  );
}
