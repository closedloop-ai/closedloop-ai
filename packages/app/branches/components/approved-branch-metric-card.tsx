"use client";

import {
  BRANCH_METRIC_DICTIONARY,
  type BranchListMetricBundle,
  type BranchListMetricValue,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricId,
  type BranchMetricResult,
  BranchMetricUnit,
} from "@repo/api/src/types/branch-metrics";
// Cross-slice on purpose (ISS-5714): `KpiDeltaPlaceholder` is the ONE
// "no comparison" affordance in this app, already rendered in this exact
// `MetricCard` slot by Insights and by the Sessions summary row (FEA-3960).
// Re-declaring a branches-local variant is how the slot drifted into a bare
// "Unavailable" under a real number in the first place.
import { NumeratorProvider } from "@repo/api/src/types/numerator-provider";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { KpiDeltaPlaceholder } from "@repo/app/insights/components/kpi-delta-placeholder";
import { GatedMetricIndicatorVariant } from "@repo/app/shared/components/gated-metric-indicator";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import { KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import { LIST_SUMMARY_LOADING_DETAIL } from "@repo/app/shared/lib/list-summary-loading-detail";
import {
  METRIC_CARD_NO_DATA_LABEL,
  MetricCard,
} from "@repo/design-system/components/ui/primitives/metric-card";
import type { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { ReactNode } from "react";
import { describeMissingBranchComparison } from "../lib/branch-list-comparison-copy";
import { formatBranchListPerDollar } from "../lib/branches-list-per-dollar";
import { useBranchMetricLabels } from "../lib/use-branch-metric-labels";
import { ConnectGitHubIndicator } from "./connect-github-indicator";

export type CardSpec = {
  id: BranchMetricId;
  /**
   * ISS-9961: ONE derivation per metric, for every reader.
   *
   * This took a second `treatment` argument carrying flag reads, and each card
   * picked WHICH field it summed from them. Two signed-in users on the same
   * data, window and filters therefore saw different numbers on the same card,
   * with nothing on screen saying which basis they got. ISS-9970 removed two of
   * those gates by deleting the companion fields outright; this removes the
   * last one, `rangeScoped`, which still steered Active branches. A flag may
   * gate whether a surface SHIPS; it may never pick which arithmetic a shipped
   * card performs, so the selector is a pure projection of the bundle.
   *
   * A selector may still PREFER an optional companion — the ratio card prefers
   * `canonicalLocPerDollar` over `pushedLocPerDollar` — because that preference
   * is keyed on what the PRODUCER sent, so every reader of one response gets one
   * answer. What is gone is selection keyed on the READER.
   */
  select: (bundle: BranchListMetricBundle) => BranchListMetricValue;
  polarity: MetricPolarity;
  info: { what: string; how: string };
  /**
   * The fixed scope phrase under the value, the shape the Sessions strip uses
   * ("input + output + cache"). Same words on every render of the card; a
   * Partial value keeps its `*` and carries its disclosure in the info popover
   * (`metricInfo`). The words are the approved prototype's captions (PR #3858,
   * the visual authority PRD-600 and PRD-601 name); Total LOC pushed replaced
   * AI spend after that prototype, and its phrase was approved by product with
   * the rest on 2026-09-22 (ISS-10540).
   */
  caption: string;
  /**
   * ISS-11117: this card's heading, when the row resolved it alongside the
   * figure instead of naming the metric by id.
   *
   * The per-dollar card's label depends on WHICH NUMERATOR its producer sent,
   * so it cannot be looked up from `card.id` — the id is the same either way.
   * Supplied together with `select` and `formatValue` by one resolver, which is
   * what stops a `Pts / $` figure rendering under a `LOC per $` heading.
   * Absent, the vocabulary resolver names the card as it always has.
   */
  label?: string;
  /**
   * ISS-11117: how this card's figure renders, when the row resolved it
   * alongside the label. Absent, the metric's dictionary unit decides.
   */
  formatValue?: (value: number) => string;
  /**
   * Whether a GitHub connection is what produces this metric's evidence.
   *
   * marisolashgrove, ISS-12638: the connect ask is keyed on THIS, plus the host's
   * own connection state — never on the value's availability bucket.
   * `Unavailable` is the one word five different producers use for five
   * different shortfalls, so an ask keyed on it promised a fix on cards GitHub
   * has no part in. Active branches says so in its own popover ("no live GitHub
   * request is made for this metric"), and Total LOC pushed is push evidence,
   * not merged-PR evidence.
   *
   * The GitHub-truth members match the Insights catalog's own set for the same
   * metrics (`GITHUB_TRUTH_TILE_IDS`: `kpi:pr-size`, `kpi:merge-rate`,
   * `kpi:kloc`), so the two surfaces do not disagree about which figures a
   * connection lights up.
   */
  gitHubTruth?: boolean;
  /**
   * ISS-9958 acceptance 1 and 4: this card renders in every window and filter
   * state, so the ISS-9730 hide gate may not retire it. A ratio the reader
   * cannot find is the defect that ticket exists to end, and hiding it is not
   * the fix for an evidence gap.
   */
  neverHidden?: boolean;
};

/**
 * One tile of the approved Branches summary row.
 *
 * ISS-9960 gave this its own module rather than leaving it beside the row that
 * renders it, when this card still asked a feature flag a question of its own.
 * The operator ruling of 2026-09-16 withdrew that question — the comparison slot
 * is not gated at all — so this module reads no feature flag to decide what goes
 * in its delta slot. The seam stays because the file-size split is worth keeping
 * on its own terms.
 *
 * ISS-10544 took the sparkline read out of this module for the other reason:
 * `trendSparkline` is a capability whose answer differs per shell, so there is
 * no read this shared module could perform that would be right for both. The
 * shells answer it at their own read sites and this card asks them — see the
 * prop's own docblock. ISS-10540 retired `metric-partial-disclosure` (operator
 * ruling, Tamsin, 2026-09-21), and product ruled on 2026-09-22 that the
 * caption under the value is the card's fixed scope phrase from the approved
 * prototype (PR #3858), with a Partial value's disclosure carried in the info
 * popover — so the only flag this module still reads is the delta pill's
 * treatment, through `useMetricDeltaTreatment`.
 */
export function CanonicalMetricCard({
  card,
  cardClassName,
  metrics,
  isPending,
  isError,
  comparisonSuppressedByFilter,
  hidden,
  trendSparkline,
  githubConnect,
}: {
  card: CardSpec;
  /**
   * The ask a card offers in place of its "Unavailable" caption. Present only
   * when the host knows a connection would help (signed out, or no GitHub data
   * source), so a card never asks a reader who is already connected.
   */
  githubConnect?: GitHubConnectTarget;
  cardClassName: string;
  metrics: BranchListMetricBundle | undefined;
  isPending: boolean;
  isError: boolean;
  comparisonSuppressedByFilter: boolean;
  /** ISS-9730: does the row's gate retire this card entirely? */
  hidden: boolean;
  /**
   * ISS-10544: does this card's HOST serve the trend series its producer sent?
   *
   * A host capability, not a threaded flag read, and it has to be one: the
   * answer now DIFFERS per shell, so no read in this shared module can produce
   * it. `branches-metric-card-trend-sparkline` graduated on web (operator
   * ruling, 2026-09-17) and still gates the desktop renderer, whose signed-out
   * readers resolve every PostHog key false by design. Each shell answers at its
   * own read site and hands the answer down, exactly as `deltaTreatment` above
   * reaches `MetricCard`.
   */
  trendSparkline: boolean;
}) {
  // ISS-5842 (ISS-4779 closed-by-default): opt in to the unified delta pill
  // only when this surface's own gate is on — PostHog on web, Labs on desktop.
  const deltaTreatment = useMetricDeltaTreatment();
  // ISS-10667: this card's own read of the vocabulary gate. The RESOLVER
  // arrives, never the gate, so the branches below cannot name one metric two
  // ways.
  const branchMetricLabel = useBranchMetricLabels();
  const definition = BRANCH_METRIC_DICTIONARY[card.id];
  const label = card.label ?? branchMetricLabel(card.id);
  if (isPending || isError || !metrics) {
    return (
      <MetricCard
        className={cardClassName}
        detail={
          isPending
            ? LIST_SUMMARY_LOADING_DETAIL
            : BRANCH_METRIC_UNAVAILABLE_DETAIL
        }
        info={card.info}
        label={label}
        muted
        value={KPI_NO_VALUE}
      />
    );
  }
  const metric = card.select(metrics);
  const current = metric.current;
  // The ask stands in for a figure a GitHub connection would produce. The
  // availability check is an absence test, not the attribution: it is what keeps
  // the ask from replacing a number the producer DID send, and keeps it off a
  // `NoData` card (an empty cohort, which connecting does not populate) or an
  // `N/A` one (an answer, not a shortfall).
  if (
    githubConnect &&
    !hidden &&
    card.gitHubTruth === true &&
    !hasNumericValue(current) &&
    current.state === BranchMetricAvailability.Unavailable
  ) {
    return renderGitHubAskCard({
      cardClassName,
      githubConnect,
      info: metricInfo(card, metrics.label),
      label,
    });
  }
  if (!hasNumericValue(current)) {
    const absent = absentValuePresentation(card, current.state, hidden);
    return (
      <MetricCard
        className={cardClassName}
        detail={availabilityDetail(current.state, comparisonSuppressedByFilter)}
        // ISS-9730: `MetricCard` refuses to hide a `muted` card because on every
        // other surface `muted` means a FAILED read — and the failed and pending
        // reads are the branch above, so anything reaching here is a value the
        // producer could not compute. State that in the primitive's own
        // vocabulary while the gate is on, so ONE implementation does the
        // hiding rather than this file growing a second one. Gate off, both
        // props are byte-for-byte what they ship today.
        hideWhenUnavailable={hidden}
        info={metricInfo(card, metrics.label)}
        label={label}
        muted={absent.muted}
        value={absent.value}
        valueUnavailable={absent.valueUnavailable}
        valueUnavailableLabel={absent.valueUnavailableLabel}
      />
    );
  }
  const delta = comparisonDelta(metric);
  const detail = card.caption;
  const info = metricInfo(card, metrics.label, current);
  const value = `${
    card.formatValue
      ? card.formatValue(current.value)
      : formatMetric(current.value, definition.unit)
  }${current.state === BranchMetricAvailability.Partial ? "*" : ""}`;
  // The comparison slot, drawn whenever there is a comparison to speak about.
  //
  // ISS-9960 originally retired this slot behind a gate, on the evidence that
  // "No comparison" was the steady state of every tile in every window. That
  // evidence was manufactured by a defect: `buildBranchMetricComparison`
  // refused a delta the moment either window was Partial, and on real data
  // every non-count Branches metric is Partial, so the producer's refusal — not
  // an uncomputable comparison — is what emptied the slot. ISS-10540 removes
  // that refusal (ISS-10208 measured it; its #7447 closed unmerged). The
  // operator ruling of 2026-09-16 reversed the retirement: this card behaves
  // like the Sessions summary cards, publishing the comparison whenever there
  // is one and leaving the slot empty only on genuine absence.
  //
  // `All time` is that genuine absence, and the only one: `metricValue` returns
  // a bare `{ current }` for that label
  // (`packages/lib/branches/branch-list-metrics.ts`), so those cards have no
  // comparison window to speak about and get no slot.
  const placeholder = comparisonPlaceholder(
    metric,
    metrics.label,
    comparisonSuppressedByFilter
  );
  // The caption is the card's scope phrase in every arm: it names the
  // population the figure describes, so it neither contradicts a "No
  // comparison" chip (a bare window label under one did, marisolashgrove #6846)
  // nor goes missing on an all-time bundle (codex, #7017). The window label
  // lives in the chip's own caption (`deltaLabel`), once.
  if (delta === undefined) {
    return (
      <MetricCard
        className={cardClassName}
        deltaPlaceholder={placeholder}
        detail={detail}
        info={info}
        label={label}
        // ISS-10363: the series is an operand of its own. This arm is exactly
        // where the shipped card drew nothing — no comparable delta, so no chip,
        // so no mark — while the producer had a whole period's shape to show.
        sparkline={trendSparkline ? metric.series : undefined}
        sparklineWithoutDelta={trendSparkline}
        value={value}
      />
    );
  }
  return (
    <MetricCard
      className={cardClassName}
      delta={delta}
      deltaLabel={metrics.label}
      deltaPolarity={card.polarity}
      deltaTreatment={deltaTreatment}
      detail={detail}
      info={info}
      label={label}
      // With a chip present the mark rides INSIDE it, replacing the directional
      // glyph — `MetricCard`'s shipped behavior, newly fed.
      sparkline={trendSparkline ? metric.series : undefined}
      value={value}
    />
  );
}

export function hasNumericValue(
  result: BranchMetricResult<number>
): result is Extract<BranchMetricResult<number>, { value: number }> {
  return (
    result.state === BranchMetricAvailability.Complete ||
    result.state === BranchMetricAvailability.Partial
  );
}

function unavailableValue(state: BranchMetricAvailability): string | null {
  if (state === BranchMetricAvailability.NotApplicable) {
    return "N/A";
  }
  if (state === BranchMetricAvailability.Unavailable) {
    return KPI_NO_VALUE;
  }
  return null;
}

/**
 * How an absent value presents itself — and why the exempt card presents it
 * differently.
 *
 * `muted` dims the whole card and means a FAILED read everywhere else in the
 * app. The card the row is forbidden to hide (ISS-9958) is precisely the one a
 * reader meets in an empty state, with its neighbours gone, so dimming it to
 * 50% beside full-opacity siblings would report a broken read where the truth
 * is "nobody could compute this". That state already has a treatment — the
 * "No data" slot FEA-4236 built — so the exempt card takes it instead.
 */
function absentValuePresentation(
  card: CardSpec,
  state: BranchMetricAvailability,
  hidden: boolean
): {
  muted: boolean;
  value: string | null;
  valueUnavailable: boolean;
  valueUnavailableLabel: string;
} {
  const exempt = card.neverHidden === true;
  return {
    muted:
      !(hidden || exempt) && state === BranchMetricAvailability.Unavailable,
    value: exempt ? null : unavailableValue(state),
    valueUnavailable: hidden || exempt,
    // The slot's word has to agree with the caption beside it. `N/A` is an
    // answer about the population, so a NotApplicable ratio captioned "N/A"
    // must not print "No data" above it — two different absences in one tile.
    valueUnavailableLabel:
      state === BranchMetricAvailability.NotApplicable
        ? "N/A"
        : METRIC_CARD_NO_DATA_LABEL,
  };
}

/**
 * The percentage this card's chip grades, or nothing.
 *
 * A plain value check, matching the Sessions summary cards: the input is a
 * number or it is not. Running it through an availability verdict instead is
 * how a percentage the producer had in hand got withheld — the defect the
 * 2026-09-16 ruling on ISS-9960 reversed — and across the wire a skewed
 * producer can pair a real number with a state this client does not expect.
 *
 * `deltaPct` is chained, not dereferenced (whitlockk review): `comparison` is a
 * cross-repo payload, so a producer on either side of a skew can send the
 * object without that key. Reading through it takes the no-comparison path the
 * way an absent `comparison` already does, instead of throwing inside a render
 * the Branches row now runs on every card. `comparisonPlaceholder` chains the
 * same key for the same reason.
 */
function comparisonDelta(metric: BranchListMetricValue): number | undefined {
  const value = metric.comparison?.deltaPct?.value;
  return typeof value === "number" ? value : undefined;
}

function renderGitHubAskCard({
  cardClassName,
  githubConnect,
  info,
  label,
}: {
  cardClassName: string;
  githubConnect: GitHubConnectTarget;
  info: ReturnType<typeof metricInfo>;
  label: string;
}) {
  return (
    <MetricCard
      className={cardClassName}
      detail={
        <ConnectGitHubIndicator
          connect={githubConnect}
          variant={GatedMetricIndicatorVariant.Card}
          withSupportingCopy
        />
      }
      info={info}
      label={label}
      value={null}
    />
  );
}

function availabilityDetail(
  state: BranchMetricAvailability,
  comparisonSuppressedByFilter: boolean
): string {
  if (state === BranchMetricAvailability.NotApplicable) {
    return "N/A";
  }
  if (state === BranchMetricAvailability.NoData) {
    return "No data";
  }
  if (comparisonSuppressedByFilter) {
    return "Not available with filters applied";
  }
  return BRANCH_METRIC_UNAVAILABLE_DETAIL;
}

/**
 * The info popover's copy. A Partial value's disclosure (the footnote its `*`
 * promises) is appended to `how` here rather than printed under the value, so
 * the caption slot keeps the card's fixed scope phrase (Tamsin, 2026-09-22).
 */
function metricInfo(
  card: CardSpec,
  label: BranchMetricComparisonLabel,
  current?: BranchMetricResult<number>
): CardSpec["info"] {
  const how =
    card.id === BranchMetricId.ActiveBranches &&
    label !== BranchMetricComparisonLabel.AllTime
      ? `${card.info.how} Comparisons use Branch status at each period boundary.`
      : card.info.how;
  if (current?.state === BranchMetricAvailability.Partial) {
    return { ...card.info, how: `${how} ${current.disclosure}` };
  }
  return { ...card.info, how };
}

/**
 * What stands in for a delta chip this card cannot draw — and it says WHAT it
 * cannot draw.
 *
 * ISS-5714: this slot used to be the bare word `Unavailable`, rendered in the
 * footer directly beneath the value. `MEDIAN PR SIZE` then read `148 LOC*` with
 * `Unavailable` under it — a figure and a denial of that figure in one tile,
 * with nothing on screen telling the reader which to believe. The figure was
 * real; only the period-over-period COMPARISON was missing. So the slot now
 * names the missing thing instead of leaving an unscoped denial under a number.
 *
 * It reuses the shared `KpiDeltaPlaceholder` the Insights tiles and the Sessions
 * summary row already render in this same slot (FEA-3960), rather than a fourth
 * hand-rolled string: one "No comparison" affordance with the reason in a
 * tooltip and an `sr-only` sentence, and the sentences themselves live in
 * `branch-list-comparison-copy.ts` beside the branch-detail set.
 *
 * `All time` is the sole range with no comparison window. A finite-range bundle
 * from an older producer may omit the additive `comparison` field; that is
 * typed as a missing comparison instead of leaving a bare `WoW`/`MoM`/`QoQ`
 * caption that never says what happened.
 */
function comparisonPlaceholder(
  metric: BranchListMetricValue,
  label: BranchMetricComparisonLabel,
  comparisonSuppressedByFilter: boolean
): ReactNode | undefined {
  const comparison = metric.comparison;
  if (comparison) {
    return (
      <KpiDeltaPlaceholder
        reason={describeMissingBranchComparison({
          state:
            comparison.deltaPct?.state ?? BranchMetricAvailability.Unavailable,
          label: comparison.label,
          comparisonSuppressedByFilter,
        })}
      />
    );
  }
  if (label === BranchMetricComparisonLabel.AllTime) {
    return;
  }
  return (
    <KpiDeltaPlaceholder
      reason={describeMissingBranchComparison({
        state: BranchMetricAvailability.Unavailable,
        label,
        comparisonSuppressedByFilter,
      })}
    />
  );
}

/**
 * These cards' copy and units (`LOC`, `LOC/$`) are hardcoded English, so their
 * figures are pinned to one canonical locale rather than inherited from the
 * viewer's. An inherited locale renders the AI-spend card's `$1,234.56` as
 * `1.234,56 $` on a de-DE box — a cost figure a US reader misreads by three
 * orders of magnitude (ISS-7336).
 */
const METRIC_LOCALE = "en-US";

function formatMetric(value: number, unit: BranchMetricUnit): string {
  if (unit === BranchMetricUnit.Usd) {
    return new Intl.NumberFormat(METRIC_LOCALE, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  }
  if (unit === BranchMetricUnit.Percentage) {
    return `${round(value, 1)}%`;
  }
  if (unit === BranchMetricUnit.LinesPerDollar) {
    // ISS-11117: ONE implementation of the per-dollar figure, shared with the
    // resolver that picks which numerator this card renders — so the label's arm
    // and the number's rounding cannot come apart. The LOC output is unchanged.
    return formatBranchListPerDollar(value, NumeratorProvider.Loc);
  }
  if (unit === BranchMetricUnit.Lines) {
    return `${Math.round(value).toLocaleString(METRIC_LOCALE)} LOC`;
  }
  return Math.round(value).toLocaleString(METRIC_LOCALE);
}

function round(value: number, digits: number): string {
  return new Intl.NumberFormat(METRIC_LOCALE, {
    maximumFractionDigits: digits,
  }).format(value);
}

export const BRANCH_METRIC_UNAVAILABLE_DETAIL = "Unavailable";
