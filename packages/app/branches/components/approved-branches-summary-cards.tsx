"use client";

import {
  type BranchListMetricBundle,
  type BranchListMetricValue,
  BranchMetricAvailability,
  BranchMetricId,
} from "@repo/api/src/types/branch-metrics";
// Cross-slice on purpose (ISS-8510/ISS-7422): the pending comparison shell uses
// the same delta-slot shimmer as the Sessions summary row so Branches cannot
// drift into a second geometry for the same shared MetricCard slot.
import { SUMMARY_COMPARISON_SHELL_SHIMMER } from "@repo/app/agents/components/sessions/sessions-summary-delta-slots";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import {
  partialStripCardClass,
  SummaryCardRow,
} from "@repo/app/shared/components/summary-card-row";
import { SummaryMetricsLoadingRow } from "@repo/app/shared/components/summary-metrics-loading-row";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useMetricCardHideUnavailable } from "@repo/app/shared/feature-flags/use-metric-card-hide-unavailable";
import { LIST_SUMMARY_LOADING_DETAIL } from "@repo/app/shared/lib/list-summary-loading-detail";
import { hiddenMetricCardIds } from "@repo/app/shared/lib/metric-card-hide-policy";
import { isSummaryMetricsLoading } from "@repo/app/shared/lib/summary-metrics-loading";
import { CardDensity } from "@repo/design-system/components/ui/card-density";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { resolveBranchesListPerDollar } from "../lib/branches-list-per-dollar";
import { isBranchesSummaryCardVisible } from "../lib/branches-summary-card-visibility";
import { BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY } from "../lib/branches-summary-honest-loading-flag";
import { useBranchMetricLabels } from "../lib/use-branch-metric-labels";
import {
  CanonicalMetricCard,
  type CardSpec,
} from "./approved-branch-metric-card";

/**
 * The resolver's LOC arm with no bundle — its copy, and nothing else.
 *
 * The label is deliberately empty here: the vocabulary gate owns that word and
 * is a hook, so only the render can resolve it. Nothing reads this object's
 * `label`.
 */
const LOC_ARM_LABEL = { locLabel: "" };
const LOC_ARM = resolveBranchesListPerDollar(undefined, LOC_ARM_LABEL);

const ACTIVE_BRANCHES_CARD: CardSpec = {
  id: BranchMetricId.ActiveBranches,
  // ISS-12309 (ruling, Cosimo Corrigan, 2026-10-08): the RANGE-SCOPED count, so
  // this card and the Branches list beneath it describe one population. The
  // shipped field counts the unwindowed cohort, which printed 769 beside a list
  // of 87. Preferring the companion is keyed on what the producer sent, never on
  // the reader — the distinction `CardSpec.select` draws — and the fallback is
  // reachable only from a producer predating the additive field.
  select: (bundle) =>
    bundle.windowScoped?.activeBranches ?? bundle.activeBranches,
  polarity: MetricPolarity.HigherIsBetter,
  caption: "in progress",
  info: {
    what: "Branches still in progress (not merged, closed, or canceled).",
    how: "Based on the Branch status already stored in ClosedLoop; no live GitHub request is made for this metric.",
  },
};

const MEDIAN_PR_SIZE_CARD: CardSpec = {
  id: BranchMetricId.MedianPrSize,
  select: (bundle) => bundle.medianPrSize,
  gitHubTruth: true,
  polarity: MetricPolarity.LowerIsBetter,
  caption: "lines changed",
  info: {
    what: "Median gross lines changed per distinct merged pull request.",
    how: "Uses additions + deletions and assigns each merged pull request to the selected period by mergedAt.",
  },
};

const MERGE_RATE_CARD: CardSpec = {
  id: BranchMetricId.MergeRate,
  select: (bundle) => bundle.mergeRatePct,
  gitHubTruth: true,
  polarity: MetricPolarity.HigherIsBetter,
  caption: "of decided PRs",
  info: {
    what: "Share of decided pull requests in the selected outcome window that merged.",
    how: "Merged outcomes use mergedAt; closed-unmerged outcomes use closedAt. Open and draft pull requests are excluded.",
  },
};

/**
 * ISS-10021: the row's LOC per $, on the one dollar basis. Its own card rather
 * than a number swapped under the pushed card's copy, because the two entries in
 * `BRANCH_METRIC_DICTIONARY` state different formulas — field, copy and id move
 * together.
 *
 * ISS-11117: its figure and every word around it now come from
 * `resolveBranchesListPerDollar`, the one owner of both numerator arms, and the
 * row re-resolves them per render against the bundle it actually received. The
 * static copy below is that resolver's LOC arm, read once — NOT a second
 * spelling of it, which is how a `Pts / $` figure would come to sit under a
 * `LOC per $` caption.
 */
const CANONICAL_LOC_PER_DOLLAR_CARD: CardSpec = {
  id: BranchMetricId.CanonicalLocPerDollar,
  // The LOC-only projection, so this EXPORTED spec's figure and its static LOC
  // copy always describe one metric. The row overrides `select` (and the label,
  // caption, formatter and popover) per render from one resolver; a consumer
  // that reads the spec alone gets the arm its copy names.
  select: (bundle) =>
    bundle.canonicalLocPerDollar ?? bundle.pushedLocPerDollar ?? ABSENT_METRIC,
  // Its numerator is merged-PR publication LOC — the same evidence the Insights
  // catalog calls GitHub truth at `kpi:kloc`.
  gitHubTruth: true,
  polarity: MetricPolarity.HigherIsBetter,
  neverHidden: true,
  caption: LOC_ARM.caption,
  info: LOC_ARM.info,
};

const TOTAL_LOC_PUSHED_CARD: CardSpec = {
  id: BranchMetricId.TotalLocPushed,
  select: selectTotalLocPushed,
  polarity: MetricPolarity.HigherIsBetter,
  caption: "lines pushed in range",
  info: {
    what: "Gross lines pushed to origin across the matched branches, in the selected period.",
    how: "Additions plus deletions across pushes to origin, counted once per commit. Pushes without a merge are included; merged work with no recorded push is not.",
  },
};

/**
 * ISS-9957's row, in its fixed order: AI spend gives its slot to Total LOC
 * pushed, and LOC per $ is last. Removing the spend CARD does not retire the
 * cost figure — it remains what the ratio beside it divides by.
 *
 * The `caption` on each spec is authoritative over the prototype at
 * `apps/prototypes/app/p/branches`, which ISS-5727 (#4836, 2026-08-11)
 * rewrote to match a production drift (ISS-4472, #4414) rather than the
 * reverse. Product restored the approved prototype's captions (PR #3858) here
 * on 2026-09-22 (ISS-10540) — see `packages/app/branches/AGENTS.md` before
 * changing a caption or moving a disclosure back onto the card face.
 */
export const BRANCHES_SUMMARY_CANONICAL_CARD_SPECS: readonly CardSpec[] = [
  ACTIVE_BRANCHES_CARD,
  MEDIAN_PR_SIZE_CARD,
  TOTAL_LOC_PUSHED_CARD,
  MERGE_RATE_CARD,
  CANONICAL_LOC_PER_DOLLAR_CARD,
];

export function ApprovedBranchesSummaryCards({
  metrics,
  isPending,
  isReloading = false,
  isError,
  className,
  cardClassName,
  wrapBelow = false,
  comparisonSuppressedByFilter = false,
  reservesPendingComparisonSlot,
  trendSparkline = false,
  githubConnect,
  hiddenCardIds,
}: {
  /**
   * ISS-12664: cards the reader chose not to see. Applied AFTER the availability
   * gate and the loading decision, which are judged over all five, so hiding a
   * card changes what paints and nothing about what any card computes.
   */
  hiddenCardIds?: ReadonlySet<string>;
  /** See {@link CanonicalMetricCard}'s `githubConnect`. */
  githubConnect?: GitHubConnectTarget;
  metrics: BranchListMetricBundle | undefined;
  isPending: boolean;
  /**
   * ISS-9887: the bundle in hand describes the scope the reader has LEFT — the
   * host's `isPlaceholderData` under `keepPreviousData`. Sessions has folded this
   * into its loading decision since FEA-4177; this row never did, so a window
   * change re-stated the previous window's KPI values as current until the
   * refetch landed. Defaults to `false`, and it is inert unless the honest-loading
   * gate is on, so no caller changes behavior by not passing it.
   */
  isReloading?: boolean;
  isError: boolean;
  className?: string;
  cardClassName: string;
  wrapBelow?: boolean;
  /**
   * ISS-5714 (review thread): did the local filtered-metrics fallback REPLACE
   * the producer's comparisons? Not "is a facet active" — an exact cohort
   * response is the filtered cohort's own metrics, and captioning a gap in those
   * as a filter problem blames the user's facet for a missing data window. See
   * `ApprovedBranchCohortAnalytics.comparisonSuppressedByFilter`, the only
   * defensible source for this flag.
   */
  comparisonSuppressedByFilter?: boolean;
  reservesPendingComparisonSlot?: boolean;
  /**
   * ISS-10544: does the HOST serve the trend series, forwarded unchanged to
   * every card. Defaults to `false` so a mount that has not answered — a story,
   * a fixture — keeps exactly the row it renders today rather than inheriting a
   * capability nobody claimed for it.
   */
  trendSparkline?: boolean;
}) {
  const honestLoadingEnabled = useFeatureFlagEnabledOptional(
    BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY
  );
  const hideUnavailable = useMetricCardHideUnavailable();
  // ISS-10667: the shell names each card the way the settled card will, through
  // the resolver both read.
  const branchMetricLabel = useBranchMetricLabels();
  // ISS-11117: the per-dollar card's figure, label, caption, unit and popover
  // resolved in ONE object, so a Pensero number cannot reach the row under
  // LOC's words. Keyed on what the PRODUCER sent — see the resolver's docblock
  // for why that is the whole gate and no reader flag is read here.
  const perDollar = resolveBranchesListPerDollar(metrics, {
    locLabel: branchMetricLabel(BranchMetricId.CanonicalLocPerDollar),
  });
  const cards = BRANCHES_SUMMARY_CANONICAL_CARD_SPECS.map((card) =>
    card.id === BranchMetricId.CanonicalLocPerDollar
      ? {
          ...card,
          caption: perDollar.caption,
          formatValue: perDollar.format,
          info: perDollar.info,
          label: perDollar.label,
          select: () => perDollar.value,
        }
      : card
  );
  // ISS-9887: the reload half of the loading question, read through the shared
  // fold both list summary rows now use. It is ANDed with this row's own gate
  // rather than folded by the hosts, so with the gate off `isReloading` cannot
  // reach any branch below — including the hide policy, whose behavior under
  // `metric-card-hide-unavailable` is therefore unchanged by this ticket.
  const summaryLoading = isSummaryMetricsLoading({
    isPending,
    isServingPreviousScope: honestLoadingEnabled === true && isReloading,
  });
  // A FAILED read is not a wait, and it outranks one: skeletoning it would take
  // away the reader's only signal that something broke. So the error branch below
  // keeps the row even while a refetch for the failed scope is in flight.
  const shouldRenderHonestLoading =
    honestLoadingEnabled === true && summaryLoading && !isError;
  const hidden = hiddenByGate({
    cards,
    comparisonSuppressedByFilter,
    enabled: hideUnavailable && !summaryLoading,
    isError,
    metrics,
  });
  const shownCards = cards.filter((card) =>
    isBranchesSummaryCardVisible(card.id, hiddenCardIds)
  );
  if (shownCards.length === 0) {
    return null;
  }
  const resolvedCardClassName = partialStripCardClass({
    anyCardHidden: hidden.size > 0 || shownCards.length < cards.length,
    cardClassName,
    wrapBelow,
  });

  if (shouldRenderHonestLoading) {
    return (
      <SummaryMetricsLoadingRow
        cardClassName={resolvedCardClassName}
        // ISS-9887: never filtered by the DATA-derived `hidden` set, which during
        // a reload is the outgoing scope's and would claim which metrics are
        // computable for a window not yet read. Only the reader's own choice
        // (ISS-12664) narrows the shell.
        cards={shownCards.map((card) => ({
          info: card.info,
          key: card.id,
          label: card.label ?? branchMetricLabel(card.id),
        }))}
        className={className}
        deltaPlaceholder={comparisonShellPlaceholder(
          reservesPendingComparisonSlot
        )}
        loadingDetail={LIST_SUMMARY_LOADING_DETAIL}
        wrapBelow={wrapBelow}
      />
    );
  }

  return (
    <SummaryCardRow
      className={className}
      // ISS-10540: one density tier on both listing strips (see the row's
      // `density` prop); the Sessions strip and both loading rows pin the same.
      density={CardDensity.Compact}
      wrapBelow={wrapBelow}
    >
      {shownCards.map((card) => (
        <CanonicalMetricCard
          card={card}
          cardClassName={resolvedCardClassName}
          comparisonSuppressedByFilter={comparisonSuppressedByFilter}
          githubConnect={githubConnect}
          hidden={hidden.has(card.id)}
          isError={isError}
          // ISS-9887: with the gate on, every non-error wait is the shared
          // loading strip above, so a card reaching this row while the read is
          // unsettled is a FAILED one with a refetch behind it — and it has to
          // say "Unavailable" rather than tell the reader to wait for a read
          // that already broke. Gate off, `summaryLoading` IS `isPending` and
          // the shipped dimmed dash is unchanged.
          isPending={summaryLoading && honestLoadingEnabled !== true}
          key={card.id}
          metrics={metrics}
          trendSparkline={trendSparkline}
        />
      ))}
    </SummaryCardRow>
  );
}

function comparisonShellPlaceholder(reservesDeltaSlot: boolean | undefined) {
  return reservesDeltaSlot ? SUMMARY_COMPARISON_SHELL_SHIMMER : undefined;
}
/**
 * Which of this row's cards the ISS-9730 gate retires.
 *
 * Whether a card goes is partly a ROW-level question, so it is answered once
 * here rather than per card, and the all-or-nothing rule that answers ISS-9730
 * acceptance 3 belongs to `hiddenMetricCardIds` rather than to this row — the
 * branch detail strip reaches the same decision through the same helper.
 *
 * What is local to this row is which of its own states count as not computable.
 * A failed read and a still-pending read are excluded by `enabled` at the call
 * site (they are the branch above `CanonicalMetricCard`'s availability case),
 * and a card captioned "Not available with filters applied" is excluded here:
 * hiding it deletes the reader's only signal that their own facet, rather than
 * the data, caused the absence. ISS-9749 confirmed that exclusion rather than
 * overturning it.
 */
function hiddenByGate({
  cards,
  enabled,
  metrics,
  isError,
  comparisonSuppressedByFilter,
}: {
  cards: readonly CardSpec[];
  enabled: boolean;
  metrics: BranchListMetricBundle | undefined;
  isError: boolean;
  comparisonSuppressedByFilter: boolean;
}): ReadonlySet<BranchMetricId> {
  if (!(enabled && metrics) || isError || comparisonSuppressedByFilter) {
    return new Set();
  }
  // A card is not computable when it HAS NO NUMBER. `BranchMetricResult` carries
  // `value` on every arm — a real number on Complete and Partial, `null` on the
  // rest — so the value itself answers this, and a PARTIAL figure is a number
  // the reader can use rather than something to withhold.
  //
  // `NotApplicable` is excluded because it is not an absence: N/A is an answer
  // about the population and the card renders it, so there is something to show.
  const hidden = hiddenMetricCardIds({
    cards: cards.map((card) => {
      const current = card.select(metrics).current;
      return {
        id: card.id,
        notComputable:
          current.value == null &&
          current.state !== BranchMetricAvailability.NotApplicable,
      };
    }),
    enabled: true,
  });
  // Subtracted AFTER the row-level decision, never by withholding the card from
  // it: `hiddenMetricCardIds` answers "would this row go empty" over the real
  // five, and dropping a candidate first would let that all-or-nothing rule be
  // judged on four. A card marked `neverHidden` then simply cannot be in the
  // result, so ISS-9958's ratio renders its own absent state instead of
  // vanishing (acceptance 1 and 4).
  const neverHidden = new Set(
    cards.filter((card) => card.neverHidden).map((card) => card.id)
  );
  if (neverHidden.size === 0) {
    return hidden;
  }
  return new Set([...hidden].filter((id) => !neverHidden.has(id)));
}

/**
 * ISS-9957: the pushed-lines total, or nothing.
 *
 * No fallback to another field. A producer predating {@link
 * BranchListMetricBundle.totalLocPushed} has no pushed-lines figure to give, and
 * the shipped LOC total counts a different set of lines, so substituting it
 * would put a number the reader cannot act on under this card's copy.
 */
function selectTotalLocPushed(
  bundle: BranchListMetricBundle
): BranchListMetricValue {
  return bundle.totalLocPushed ?? ABSENT_METRIC;
}

/** What a card selects when its producer omitted the field entirely. */
const ABSENT_METRIC: BranchListMetricValue = {
  current: { state: BranchMetricAvailability.Unavailable, value: null },
};
