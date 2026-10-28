import {
  type BranchListMetricBundle,
  type BranchListMetricValue,
  BranchMetricAvailability,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  NUMERATOR_PROVIDER_DESCRIPTORS,
  NumeratorProvider,
  perDollarShortLabelFor,
} from "@repo/api/src/types/numerator-provider";
import { formatPenseroPointsPerDollar } from "@repo/app/shared/lib/format-utils";

/**
 * ISS-11117 — the Branches LISTING's per-dollar card, number and words chosen
 * ONCE.
 *
 * The sibling of `branch-detail-per-dollar.ts`, and it exists for the same
 * reason that one does: the card used to pick its figure in one expression and
 * its label, caption, unit and popover in four others, so swapping the
 * numerator under it is exactly how a Pensero number ends up rendered as
 * `LOC per $`. A caller cannot take {@link BranchesListPerDollar.value} without
 * also taking the label that names what it counts, because they arrive in one
 * object.
 *
 * ## The selection is keyed on the PRODUCER, never on the reader
 *
 * `CardSpec.select`'s own contract (ISS-9961) forbids a card choosing its
 * arithmetic from a flag the READER holds: two people on the same data would
 * see different numbers with nothing on screen saying which. It is not needed
 * here, and that is the point of putting the gate server-side: the API
 * publishes `penseroPointsPerDollar` only for a principal who passes the server
 * half of `pensero-points-per-dollar`, so by the time a bundle reaches this
 * function the reader question is already answered and every consumer of one
 * response renders one answer. It also removes a whole class of desktop/web
 * divergence — a client-side flag delivery that fails (`MissingBridge`,
 * `EvaluationFailed`, still-`Pending`) cannot shut a gate that is not read
 * here.
 */
export type BranchesListPerDollar = {
  /** Which numerator the figure counts. The card branches on nothing else. */
  readonly providerId: NumeratorProvider;
  /** The selected metric, comparison and series included. */
  readonly value: BranchListMetricValue;
  /** The card's heading — also its loading shell's heading. */
  readonly label: string;
  /** The fixed scope phrase under the value. */
  readonly caption: string;
  /** How the figure renders, unit included. Travels with the label. */
  readonly format: (value: number) => string;
  /** The info popover, whose `how` must describe the numerator in play. */
  readonly info: { readonly what: string; readonly how: string };
};

/**
 * Choose the Branches-listing per-dollar metric and the words describing it.
 *
 * The LOC arm is the shipped card, moved rather than rewritten: the same
 * `canonicalLocPerDollar ?? pushedLocPerDollar ?? absent` preference, the same
 * caption and popover, and a label the caller resolves through the vocabulary
 * hook and hands in, so the ISS-10667 gate still owns that word.
 *
 * The Pensero arm is selected only when there is a Pensero MEASUREMENT to
 * select. Presence is not enough and truthiness is the bug it avoids: a
 * `BranchListMetricValue` is an object, so one holding `{state: Unavailable}`
 * is truthy too, and selecting on that would swap a perfectly computable LOC
 * ratio for an empty `Pts / $ —`. A genuine `0` IS a measurement and IS
 * published, which is why this tests the STATE and not the value.
 */
export function resolveBranchesListPerDollar(
  bundle: BranchListMetricBundle | undefined,
  options: { readonly locLabel: string }
): BranchesListPerDollar {
  const pensero = bundle?.penseroPointsPerDollar;
  if (isPublishable(pensero?.current)) {
    return penseroPresentation(pensero);
  }
  return locPresentation(bundle, options.locLabel);
}

/** The shipped LOC/$ card, unchanged. */
function locPresentation(
  bundle: BranchListMetricBundle | undefined,
  locLabel: string
): BranchesListPerDollar {
  return {
    providerId: NumeratorProvider.Loc,
    value:
      bundle?.canonicalLocPerDollar ?? bundle?.pushedLocPerDollar ?? ABSENT,
    label: locLabel,
    caption: "lines changed per dollar",
    format: (value) => formatBranchListPerDollar(value, NumeratorProvider.Loc),
    info: {
      what: "Verified publication lines per dollar of total estimated cost, in the selected period.",
      how: "Deduplicated successful-push or merged-PR additions + deletions divided by the total estimated cost of the same branches in this range, each Session's estimated cost counted once with every billing type included.",
    },
  };
}

/**
 * The Pensero points card. Every string names points rather than lines — a card
 * whose number is Pensero's while its `how` still describes additions and
 * deletions would be the same failure as a wrong label, written in prose.
 */
function penseroPresentation(
  value: BranchListMetricValue
): BranchesListPerDollar {
  return {
    providerId: NumeratorProvider.Pensero,
    value,
    label: perDollarShortLabelFor(NumeratorProvider.Pensero),
    caption: "points delivered per dollar",
    format: (points) =>
      formatBranchListPerDollar(points, NumeratorProvider.Pensero),
    info: {
      what: "Pensero delivery points per dollar of total estimated cost.",
      how: "Every role's share of each Pensero-scored interaction on these branches, counted once per interaction, divided by the SAME total estimated cost the LOC ratio divides, each Session's estimated cost counted once with every billing type included. Pensero delivery history is swept backwards and is never provably complete, so this total is a lower bound.",
    },
  };
}

/**
 * Whether a listing result is a MEASUREMENT the card may render.
 *
 * `Partial` is the only state a Pensero result takes when it has a number at
 * all (ISS-9930: acquisition cannot prove completeness), so admitting
 * `Complete` alone would drop every published Pensero value back onto the LOC
 * card. `Complete` stays accepted as version-skew surface, not as a live
 * producer state.
 */
function isPublishable(
  result: BranchMetricResult<number> | undefined
): result is BranchMetricResult<number> {
  return (
    result?.state === BranchMetricAvailability.Complete ||
    result?.state === BranchMetricAvailability.Partial
  );
}

/**
 * The card's figure for one provider — `12.34 LOC/$`, `12.3 Pts/$`.
 *
 * THE ONE implementation, and the card's own `formatMetric` delegates to it for
 * `BranchMetricUnit.LinesPerDollar` — so the arm the resolver picks and the arm
 * the card renders cannot round differently. (The reverse direction is not
 * available: `formatMetric` lives in a `"use client"` component module, which a
 * lib this bundle-sensitive must not import.)
 *
 * Each provider's numeric part comes from ITS canonical formatter, never a
 * re-rounding: Pensero through `formatPenseroPointsPerDollar`, which keeps the
 * `smallRatioDigits` floor so a measured 0.03 renders `0.03` and not a `0` that
 * claims nothing was delivered (the ISS-4667 lie). LOC keeps the two-decimal
 * `Intl` call this card has always used — deliberately NOT `formatLocPerDollar`,
 * whose adaptive rule renders a different string, because AC2 requires the LOC
 * arm to be byte-identical to what ships today.
 *
 * Pinned to one canonical locale for the reason the card module states: these
 * units are hardcoded English, and an inherited locale renders a `1,234.56`
 * ratio as `1.234,56` on a de-DE box.
 */
export function formatBranchListPerDollar(
  value: number,
  providerId: NumeratorProvider
): string {
  const unit = NUMERATOR_PROVIDER_DESCRIPTORS[providerId].shortUnitLabel;
  const figure =
    providerId === NumeratorProvider.Pensero
      ? formatPenseroPointsPerDollar(value)
      : new Intl.NumberFormat(PER_DOLLAR_CARD_LOCALE, {
          maximumFractionDigits: LOC_PER_DOLLAR_CARD_FRACTION_DIGITS,
        }).format(value);
  return `${figure} ${unit}/$`;
}

const PER_DOLLAR_CARD_LOCALE = "en-US";

/**
 * Two, as the shipped card rounds — NOT the LOC descriptor's `fractionDigits`,
 * which is `0` because a COUNT of lines is whole. A RATIO of lines to dollars
 * is not, and this card has always shown its two decimals.
 */
const LOC_PER_DOLLAR_CARD_FRACTION_DIGITS = 2;

/** What the card selects when its producer omitted every ratio field. */
const ABSENT: BranchListMetricValue = {
  current: { state: BranchMetricAvailability.Unavailable, value: null },
};
