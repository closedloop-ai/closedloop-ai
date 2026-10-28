import {
  BranchMetricAvailability,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import {
  NumeratorProvider,
  perDollarLabelFor,
  perDollarUnitLabelFor,
} from "@repo/api/src/types/numerator-provider";
import {
  formatLocPerDollar,
  formatPenseroPointsPerDollar,
} from "@repo/app/shared/lib/format-utils";

/**
 * ISS-9814 AC6 — "the label travels with the value".
 *
 * The branch-detail headline card used to pick its number and its wording with
 * separate expressions: a flag chose between two `BranchMetricResult`s, while
 * the label, the unit chip, the supporting sentence and the info popover were
 * four independent literals that all said LOC. Swapping the numerator under that
 * shape is exactly how a Pensero number ends up rendered as `LOC/$`.
 *
 * So the choice is made ONCE, here, and the number leaves with the words that
 * describe it. A caller cannot take {@link BranchDetailPerDollar.result} without
 * also taking the label that names what it counts, because they arrive in one
 * object.
 */
export type BranchDetailPerDollar = {
  /** Which numerator the value counts. The card branches on nothing else. */
  readonly providerId: NumeratorProvider;
  /** The selected ratio, or `undefined` when no producer supplied one. */
  readonly result: BranchMetricResult<number> | undefined;
  /** The card's heading — also its disclosure panel's heading. */
  readonly label: string;
  /** The compact unit printed beside the number. */
  readonly unitLabel: string;
  /**
   * How to render the number. Travels with the label for the same reason the
   * label travels with the value: LOC/$ rounds to whole numbers above 10, which
   * would print a 25.5 pts/$ measurement as "26" for a provider whose feed
   * emits tenths verbatim. Precision is part of what the unit means.
   */
  readonly format: (value: number | null | undefined) => string;
  /** The supporting line under the value. */
  readonly detail: string;
  /** The sentence shown in place of a value nobody could compute. */
  readonly unavailableDetail: string;
  /** The info popover, whose `how` must describe the numerator in play. */
  readonly info: { readonly what: string; readonly how: string };
};

/** The metrics this resolver reads. Narrower than the whole detail bundle. */
export type BranchDetailPerDollarMetrics = {
  readonly locPerDollar?: BranchMetricResult<number>;
  readonly populationMatchedLocPerDollar?: BranchMetricResult<number>;
  readonly penseroPointsPerDollar?: BranchMetricResult<number>;
};

/**
 * Choose the branch-detail per-dollar metric and the words that describe it.
 *
 * ## The LOC arm is byte-identical to the shipped card
 *
 * Every string in it is the one the card rendered before this change, and the
 * unit chip now reads `perDollarUnitLabelFor(Loc)` in place of a hardcoded
 * `"LOC/$"` — equal by construction and pinned by a test. AC2 requires the
 * flag-off render to be indistinguishable from today, so the LOC arm is not
 * "regenerated LOC copy", it is the same copy moved.
 *
 * ## Pensero is selected only when there is a Pensero number to select
 *
 * `penseroPointsEnabled` is the display flag. On its own it is not enough: an
 * org inside the rollout with an EMPTY `delivery_points` table, or a branch no
 * delivery row resolved to, produces no `penseroPointsPerDollar` at all, and
 * that must read as *no Pensero data* — the card keeps rendering LOC/$ — never
 * as `0 pts/$`. So the flag and the presence of the field must BOTH hold.
 *
 * A present result whose value is `0` is a different case entirely and is
 * selected: that is a measured zero, and it renders `0` under the Pensero label
 * (AC3). The distinction is carried by presence-vs-value, which is why the
 * producer omits the field rather than sending a nullable zero.
 */
export function resolveBranchDetailPerDollar(
  metrics: BranchDetailPerDollarMetrics | undefined,
  options: {
    readonly penseroPointsEnabled: boolean;
    readonly populationMatched: boolean;
  }
): BranchDetailPerDollar {
  const pensero = metrics?.penseroPointsPerDollar;
  if (options.penseroPointsEnabled && isPublishable(pensero)) {
    return penseroPresentation(pensero);
  }
  return locPresentation(metrics, options.populationMatched);
}

/**
 * Whether a Pensero result is a MEASUREMENT the card may render.
 *
 * Presence alone is not enough, and testing the object's truthiness is the bug
 * this replaces: a `BranchMetricResult` is an object, so `{state: Unavailable,
 * value: null}` is truthy too. Selecting on that swapped a perfectly computable
 * LOC/$ for an empty "Pensero pts / $ —" whenever a branch's delivery evidence
 * was refused, which AC2 says must render LOC/$ instead.
 *
 * A genuine `0` IS a measurement and IS published — that is AC3, and it is why
 * this tests the STATE rather than the value.
 *
 * Partial counts (ISS-9930, operator ruling 2026-09-17). It is the only state a
 * Pensero result now takes when it has a number at all, so admitting `Complete`
 * alone would drop every published Pensero value back to the LOC/$ card — the
 * same withholding the ruling removed one layer down.
 *
 * `Complete` stays accepted as version-skew surface, not as a live producer
 * state: a client built after that ruling still reads responses from a cloud
 * deployed before it, and dropping the arm would blank the card for that window.
 */
function isPublishable(
  result: BranchMetricResult<number> | undefined
): result is BranchMetricResult<number> {
  return (
    result?.state === BranchMetricAvailability.Complete ||
    result?.state === BranchMetricAvailability.Partial
  );
}

/** The shipped LOC/$ card, unchanged. */
function locPresentation(
  metrics: BranchDetailPerDollarMetrics | undefined,
  populationMatched: boolean
): BranchDetailPerDollar {
  return {
    providerId: NumeratorProvider.Loc,
    // Falls back to the shipped field when a version-skewed producer omits the
    // companion, so an older response degrades to today's card, not an empty one.
    result:
      (populationMatched
        ? metrics?.populationMatchedLocPerDollar
        : undefined) ?? metrics?.locPerDollar,
    label:
      LOC_METRIC_DEFINITION[LocMetricDefinitionId.BranchDetailPublicationLoc]
        .label,
    unitLabel:
      LOC_METRIC_DEFINITION[LocMetricDefinitionId.BranchDetailPublicationLoc]
        .unitLabel,
    format: formatLocPerDollar,
    detail: "Lifetime verified publication LOC ÷ lifetime qualifying cost",
    unavailableDetail: "No positive lifetime qualifying cost.",
    info: {
      what: "Lifetime verified publication lines per qualifying Session dollar for this Branch.",
      how: "Deduplicated successful-push or merged-PR additions + deletions across the Branch lifetime divided by lifetime Build, Review, and Rework cost. Changing the selected pull request does not change this Branch-level metric.",
    },
  };
}

/**
 * The Pensero points card. Every string names points rather than lines — a card
 * whose number is Pensero's while its `how` still describes additions and
 * deletions would be the AC6 failure in prose instead of in the label.
 */
function penseroPresentation(
  result: BranchMetricResult<number>
): BranchDetailPerDollar {
  return {
    providerId: NumeratorProvider.Pensero,
    result,
    label: perDollarLabelFor(NumeratorProvider.Pensero),
    unitLabel: perDollarUnitLabelFor(NumeratorProvider.Pensero),
    format: formatPenseroPointsPerDollar,
    detail: "Lifetime Pensero delivery points ÷ lifetime qualifying cost",
    unavailableDetail: "No positive lifetime qualifying cost.",
    info: {
      what: "Lifetime Pensero delivery points per qualifying Session dollar for this Branch.",
      how: "Every role's share of each Pensero-scored interaction on this Branch, counted once per interaction, divided by the same lifetime Build, Review, and Rework cost the LOC ratio uses. Changing the selected pull request does not change this Branch-level metric.",
    },
  };
}
