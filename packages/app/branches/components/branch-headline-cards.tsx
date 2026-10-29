"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  BRANCH_METRIC_DICTIONARY,
  BranchMetricAvailability,
  BranchMetricId,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { NumeratorProvider } from "@repo/api/src/types/numerator-provider";
import { resolveBranchDetailPerDollar } from "@repo/app/branches/lib/branch-detail-per-dollar";
import {
  displayableBranchMetricValue,
  isNotComputableBranchMetricState,
} from "@repo/app/branches/lib/branch-metric-value";
import {
  BRANCH_CYCLE_TIME_LABEL,
  branchPullRequestCycleAbsence,
} from "@repo/app/branches/lib/branch-outcome-copy";
import { formatBranchDurationMs } from "@repo/app/branches/lib/format-branch-duration-ms";
import { formatBranchLeadTimeMs } from "@repo/app/branches/lib/format-branch-lead-time-ms";
import { useBranchMetricLabels } from "@repo/app/branches/lib/use-branch-metric-labels";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useMetricCardHideUnavailable } from "@repo/app/shared/feature-flags/use-metric-card-hide-unavailable";
import {
  BRANCH_DETAIL_METRIC_HONESTY_FEATURE_FLAG_KEY,
  PENSERO_POINTS_PER_DOLLAR_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { hiddenMetricCardIds } from "@repo/app/shared/lib/metric-card-hide-policy";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { ReactNode } from "react";

export type BranchHeadlineCardsProps = {
  detail: BranchPageDetail;
};

/**
 * The three approved Branch outcome cards, in their fixed ORDER.
 *
 * Fixed order, not a fixed set: with `metric-card-hide-unavailable` on, a card
 * whose metric nobody could compute renders nothing, so the row can be two
 * cards or one. The survivors keep this relative order and never reshuffle —
 * what a reader loses is a card, never the ranking of the cards beside it.
 */
export function BranchHeadlineCards({ detail }: BranchHeadlineCardsProps) {
  const honest = useFeatureFlagEnabledOptional(
    BRANCH_DETAIL_METRIC_HONESTY_FEATURE_FLAG_KEY
  );
  const hideUnavailable = useMetricCardHideUnavailable();
  const metrics = detail.canonicalMetrics;
  // Scoped to the two PR-CYCLE metrics below. "LOC per $" is Branch-lifetime
  // measured — its own tooltip says the selected pull request does not change it
  // — so a pull-request reason would be a different wrong answer, not a fix.
  //
  // Resolved UNCONDITIONALLY, and gated only where it speaks (`honest`, below).
  // It answers two different questions for two independently-keyed features:
  // which SENTENCE a cycle card prints, which is the honesty key's; and whether
  // the absence is one the hide key may retire a card over, which is not.
  const cycleAbsence = branchPullRequestCycleAbsence(
    detail.associatedPullRequests,
    Boolean(detail.selectedPullRequest)
  );
  // ISS-9814 (ISS-4779 closed-by-default): its OWN key again, separate from
  // `pensero-integration` — that one decides whether an org may have delivery
  // rows AT ALL, this one decides whether a reader sees them as the numerator.
  // The write gate has to be on before rows exist; the display gate has to stay
  // off until they do.
  const penseroPoints = useFeatureFlagEnabledOptional(
    PENSERO_POINTS_PER_DOLLAR_FEATURE_FLAG_KEY
  );
  const branchMetricLabel = useBranchMetricLabels();
  // AC6: the number and every word describing it are chosen together, once.
  // Pulling `result` out of this object without its `label` is not expressible.
  const perDollar = resolveBranchDetailPerDollar(metrics, {
    penseroPointsEnabled: penseroPoints === true,
    populationMatched: false,
  });
  const locPerDollar = metricPresentation(
    perDollar.result,
    // The winning provider's own formatter, not LOC's — see BranchDetailPerDollar.
    perDollar.format,
    perDollar.unavailableDetail,
    honest
  );
  const leadTime = withAbsenceReason(
    metricPresentation(
      metrics?.leadTimeMs,
      honest ? formatBranchDurationMs : formatBranchLeadTimeMs,
      "Not applicable to the selected pull request's latest cycle.",
      honest
    ),
    cycleAbsence,
    honest
  );
  const abandonment = withAbsenceReason(
    metricPresentation(
      metrics?.abandonmentTimeMs,
      honest ? formatBranchDurationMs : formatDurationMs,
      "Not applicable to the selected pull request's latest cycle.",
      honest
    ),
    cycleAbsence,
    honest
  );
  // ISS-10667: the LOC card's label comes from the vocabulary resolver, which
  // returns the dictionary word with the gate closed. The Pensero card is a
  // different metric and this ruling does not govern it.
  const locLabel =
    perDollar.providerId === NumeratorProvider.Loc
      ? branchMetricLabel(BranchMetricId.DetailLocPerDollar)
      : perDollar.label;
  const cycleLabel = honest
    ? BRANCH_CYCLE_TIME_LABEL
    : BRANCH_METRIC_DICTIONARY[BranchMetricId.LeadTime].label;
  const abandonmentLabel =
    BRANCH_METRIC_DICTIONARY[BranchMetricId.AbandonmentTime].label;
  const locDetail = supportingDetail(locPerDollar, perDollar.detail);
  // ISS-9749 (ISS-4779 closed-by-default): this row is wired because it reads
  // the SAME `BranchMetricAvailability` machine the Branches strip does, so
  // "nobody could compute this" already arrives as its own state rather than
  // being inferred from a nullish value. `metricPresentation` marks it; the
  // row-level all-or-nothing rule is the shared helper's.
  const cards = [
    {
      id: BranchMetricId.DetailLocPerDollar,
      notComputable: locPerDollar.notComputable,
    },
    { id: BranchMetricId.LeadTime, notComputable: leadTime.notComputable },
    {
      id: BranchMetricId.AbandonmentTime,
      notComputable: abandonment.notComputable,
    },
  ];
  const hidden = hiddenMetricCardIds({ cards, enabled: hideUnavailable });

  return (
    <div className="bq-statcards" data-partial={hidden.size > 0 || undefined}>
      <MetricCard
        detail={locDetail}
        hideWhenUnavailable={hidden.has(BranchMetricId.DetailLocPerDollar)}
        info={withDisclosure(perDollar.info, locPerDollar)}
        label={locLabel}
        unitLabel={perDollar.unitLabel}
        value={locPerDollar.value}
        valueUnavailable={locPerDollar.unavailable}
        valueUnavailableLabel={locPerDollar.unavailableLabel}
      />
      <MetricCard
        detail={supportingDetail(leadTime, "First code pushed → merge")}
        hideWhenUnavailable={hidden.has(BranchMetricId.LeadTime)}
        info={withDisclosure(
          {
            what: "Wall-clock time from the selected pull request cycle's first qualifying code push until merge.",
            how: "Merged cycles only. Open, draft, and closed-unmerged cycles are not applicable.",
          },
          leadTime
        )}
        label={cycleLabel}
        value={leadTime.value}
        valueUnavailable={leadTime.unavailable}
        valueUnavailableLabel={leadTime.unavailableLabel}
      />
      <MetricCard
        detail={supportingDetail(
          abandonment,
          "First code pushed → close without merge"
        )}
        hideWhenUnavailable={hidden.has(BranchMetricId.AbandonmentTime)}
        info={withDisclosure(
          {
            what: "Wall-clock time spent on the selected pull request cycle before it closed without merging.",
            how: "Closed-unmerged cycles only. Merged, open, and draft cycles are not applicable.",
          },
          abandonment
        )}
        label={abandonmentLabel}
        value={abandonment.value}
        valueUnavailable={abandonment.unavailable}
        valueUnavailableLabel={abandonment.unavailableLabel}
      />
    </div>
  );
}

/**
 * ISS-6957: replaces an availability sentence with the pull-request reason, but
 * ONLY where there is no value to state. A card holding a number keeps it — the
 * absence explains a missing value, it does not outrank a present one.
 *
 * ISS-9749: an absence that arrives with a REASON is never hidden. All three
 * reasons `branchPullRequestCycleAbsence` distinguishes are outside ISS-9730's
 * one retirable state: "No PR selected" is something the reader did and can
 * undo, "This branch has no pull request." is an answer about the population
 * exactly as `N/A` is, and "Pull request history isn't available yet." is a read
 * that did not land, which ISS-9730 forbids hiding. Retiring any of them would
 * delete the only thing on screen telling the reader the metric exists. That is
 * the same exclusion the Branches strip makes for "Not available with filters
 * applied", and it is why this clears `notComputable` rather than merely
 * re-captioning.
 *
 * TWO KEYS, AND ONLY ONE OF THEM MAY REACH THE CLASSIFICATION (whitlockk review on
 * #6852). `restated` is the `branch-detail-metric-honesty` key: it owns the
 * WORDING, so with it off the card keeps its shipped availability sentence. It
 * does NOT own whether `metric-card-hide-unavailable` may retire the card,
 * because the two keys are independent — nothing orders them, and on desktop the
 * honesty key is a local Labs toggle while the hide key ships through PostHog,
 * so hide-on/honesty-off is what every desktop reader gets the moment the hide
 * key is enabled. Gating the classification on `restated` made a card that is
 * merely awaiting a PR selection vanish in exactly that state.
 */
function withAbsenceReason(
  presentation: MetricPresentation,
  absence: { detail: string; label: string } | null,
  restated: boolean
): MetricPresentation {
  if (!(absence && presentation.unavailable)) {
    return presentation;
  }
  if (!restated) {
    return { ...presentation, notComputable: false };
  }
  return {
    ...presentation,
    detail: absence.detail,
    notComputable: false,
    unavailableLabel: absence.label,
  };
}

function supportingDetail(
  presentation: MetricPresentation,
  caption: string | null
): ReactNode {
  if (presentation.unavailable) {
    return presentation.detail;
  }
  if (presentation.detail && caption) {
    return `${caption} · ${presentation.detail}`;
  }
  return presentation.detail ?? caption;
}

function metricPresentation(
  result: BranchMetricResult<number> | undefined,
  format: (value: number) => string,
  notApplicableDetail: string,
  honest: boolean
): MetricPresentation {
  const presentation = honest
    ? honestMetricPresentation(result, format, notApplicableDetail)
    : shippedMetricPresentation(result, format, notApplicableDetail);
  // Decided from the producer's availability word ONCE, outside both renders:
  // the two branches disagree about wording and formatting, and must never
  // disagree about which cards ISS-9730's gate may retire.
  return { ...presentation, notComputable: isNotComputable(result) };
}

function honestMetricPresentation(
  result: BranchMetricResult<number> | undefined,
  format: (value: number) => string,
  notApplicableDetail: string
): MetricPresentationBase {
  if (!result) {
    return unavailablePresentation();
  }

  switch (result.state) {
    case BranchMetricAvailability.Complete: {
      const metric = displayableBranchMetricValue(result);
      if (!metric) {
        return unavailablePresentation();
      }
      return {
        detail: null,
        unavailable: false,
        unavailableLabel: "No data",
        value: format(metric.value),
      };
    }
    case BranchMetricAvailability.Partial: {
      const metric = displayableBranchMetricValue(result);
      if (!metric) {
        return unavailablePresentation();
      }
      return {
        detail: null,
        disclosure: result.disclosure,
        unavailable: false,
        unavailableLabel: "No data",
        value: `${format(metric.value)}*`,
      };
    }
    case BranchMetricAvailability.Unavailable:
      return unavailablePresentation();
    case BranchMetricAvailability.NotApplicable:
      return {
        detail: notApplicableDetail,
        unavailable: true,
        unavailableLabel: "N/A",
        value: null,
      };
    case BranchMetricAvailability.NoData:
      return {
        detail: "No qualifying data.",
        unavailable: true,
        unavailableLabel: "No data",
        value: null,
      };
    default: {
      return unavailablePresentation();
    }
  }
}

function shippedMetricPresentation(
  result: BranchMetricResult<number> | undefined,
  format: (value: number) => string,
  notApplicableDetail: string
): MetricPresentationBase {
  if (!result || result.state === BranchMetricAvailability.Unavailable) {
    return unavailablePresentation();
  }
  if (result.state === BranchMetricAvailability.NotApplicable) {
    return {
      detail: notApplicableDetail,
      unavailable: true,
      unavailableLabel: "N/A",
      value: null,
    };
  }
  if (result.state === BranchMetricAvailability.NoData) {
    return {
      detail: "No qualifying data.",
      unavailable: true,
      unavailableLabel: "No data",
      value: null,
    };
  }
  if (result.value === null) {
    return unavailablePresentation();
  }
  const formatted = format(result.value);
  if (result.state === BranchMetricAvailability.Partial) {
    return {
      detail: null,
      disclosure: result.disclosure,
      unavailable: false,
      unavailableLabel: "No data",
      value: `${formatted}*`,
    };
  }
  return {
    detail: null,
    unavailable: false,
    unavailableLabel: "No data",
    value: formatted,
  };
}

/** The fallback absence: an unreadable value, or a state outside the enum. */
function unavailablePresentation(): MetricPresentationBase {
  return {
    detail: "Evidence is unavailable.",
    unavailable: true,
    unavailableLabel: "Unavailable",
    value: null,
  };
}

/**
 * ISS-9730's fourth state, read off the producer's availability word.
 *
 * `unavailable` above is true for FOUR different reasons on this row, and only
 * this one may retire a card: not computable, versus not applicable (`N/A` is an
 * answer about the population), a reason the reader caused (`withAbsenceReason`
 * clears it), and a producer contradiction — a `Complete` or `Partial` result
 * whose value will not display, which is a defect to surface rather than an
 * absence to hide. Applied once, for both the honest and shipped renders: they
 * legitimately disagree about wording, and must never disagree about which
 * cards may go. WHICH states qualify is the Branches strip's answer too, so it
 * is owned by `isNotComputableBranchMetricState` rather than restated here.
 */
function isNotComputable(
  result: BranchMetricResult<number> | undefined
): boolean {
  // A missing bundle is the whole read, not this metric — the same shape as a
  // fetch that did not land, which ISS-9730 forbids hiding.
  if (!result) {
    return false;
  }
  return isNotComputableBranchMetricState(result.state);
}

type MetricPresentationBase = {
  detail: string | null;
  /**
   * A Partial value's disclosure, carried to the info popover rather than the
   * caption (Tamsin, 2026-09-22): the caption keeps the card's scope phrase.
   */
  disclosure?: string;
  unavailable: boolean;
  unavailableLabel: string;
  value: string | null;
};

type MetricPresentation = MetricPresentationBase & {
  /** Whether ISS-9730's gate may retire this card. See {@link isNotComputable}. */
  notComputable: boolean;
};

/**
 * The info popover's copy, with a Partial value's disclosure appended to `how`
 * so the `*` on the value still has its footnote somewhere the reader can open.
 */
function withDisclosure(
  info: { what: string; how?: string },
  presentation: MetricPresentation
): { what: string; how?: string } {
  if (!presentation.disclosure) {
    return info;
  }
  return {
    ...info,
    how: info.how
      ? `${info.how} ${presentation.disclosure}`
      : presentation.disclosure,
  };
}
