"use client";

import type {
  BranchAnalytics,
  BranchKpi,
  BranchMetricBasis,
} from "@repo/api/src/types/branch";
import {
  BRANCH_KPI_METRIC_BASIS,
  BranchBaselineScope,
  BranchKpiState,
} from "@repo/api/src/types/branch";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import {
  SummaryCardRow,
  summaryCardClass,
} from "@repo/app/shared/components/summary-card-row";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import {
  formatCurrencyWhole,
  formatLoc,
  formatLocPerDollar,
  formatNumber,
} from "@repo/app/shared/lib/format-utils";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { resolveBranchBaselineComparison } from "../lib/branch-baseline-comparison";
import { ApprovedBranchesSummaryCards } from "./approved-branches-summary-cards";
import { ConnectGitHubIndicator } from "./connect-github-indicator";

/**
 * Branches summary KPI cards (FEA-1948 / B6; FEA-2051). Prop-driven (FEA-3056
 * follow-up): the analytics read is fetched ONCE by a parent alongside the
 * branch list (`useBranchesPageData`) and passed down here, rather than each
 * mounting its own `useBranchAnalytics` query — the Branches screen renders
 * this alongside the list on every load, and two independent queries meant two
 * independent scans of the same underlying rows. The row surfaces ONLY
 * locally-computable KPIs (AI spend, LOC / $, Active branches, Merge rate,
 * Median PR size — no GitHub needed) so the page is useful without a GitHub
 * connection. GitHub-gated KPIs (active/merged PR counts, time-to-merge) are
 * intentionally NOT shown (FEA-2051) rather than rendered as empty
 * connect-GitHub placeholders — no hardcoded "86", no Sample badges.
 * `BranchKpiCard` keeps a defensive connect-GitHub affordance for any KPI a
 * future REST source reports as gated.
 */

const DELTA_LABEL = "vs. prior 30 days";

type CardSpec = {
  key: string;
  label: string;
  detail: string;
  /**
   * ISS-4737 — the caption to show INSTEAD of `detail` when this KPI is
   * unavailable. `detail` is written to sit under a number ("estimated cost in
   * range"), which under a "No data" glyph describes a value that isn't there;
   * MetricCard's own contract asks the caption to say WHY the value is absent
   * (see its `valueUnavailable` prop docs).
   *
   * REQUIRED, not optional (review of #4244). Every card in this row can go
   * unavailable — LOC/$ whenever nothing is LOC-enriched, Merge rate whenever
   * nothing is decided — so a filtered view routinely shows several "No data"
   * glyphs side by side. If only one of them captioned WHY, the same glyph
   * would carry two different grammars in one row and read as one card failing
   * differently from its neighbours. Making this required means a new card
   * cannot join the row without stating its own absent-state cause.
   *
   * House style, so the five read as one row: `no <missing thing> for these
   * branches` (or `… match these filters` for a card that only goes absent on
   * an empty subset). Name the POPULATION, never the date range — this row is
   * re-derived by `deriveFilteredBranchAnalytics` over the table's visible rows,
   * which is the window PLUS search PLUS facets PLUS pagination, so a search
   * that matches only zero-cost branches inside a range with real spend must not
   * be blamed on the range. And describe the absence, never the pipeline: "no
   * data" as a cause reads to a user like the read failed.
   */
  unavailableDetail: string;
  info: { what: string; how: string };
  select: (analytics: BranchAnalytics) => BranchKpi;
  format: (value: number) => string;
  /**
   * Which direction is good for this KPI (ISS-4633). Required, not defaulted, so
   * a new card must state whether a rise is a win before its delta chip can be
   * coloured — spend and PR size are lower-is-better.
   */
  polarity: MetricPolarity;
  /**
   * WHAT this card's value measures (ISS-4686). Read from the
   * `BRANCH_KPI_METRIC_BASIS` SSOT rather than declared locally, so the list and
   * the branch-detail cards cannot drift into describing the same KPI two ways.
   */
  basis: BranchMetricBasis;
};

const CARDS: CardSpec[] = [
  {
    key: "spend",
    label: "AI spend",
    detail: "estimated cost in range",
    // The card now goes to "No data" on a zero total as well as an unpriced one,
    // and it re-derives as the user filters — so the caption has to say why the
    // number it was just showing went away, not restate the metric. "no cost to
    // report" (not "no cost data") because a subset priced at exactly $0 DOES
    // have cost data, it is just zero; and "for these branches" (not "in range")
    // because the population is the matched rows, which a search or a facet
    // narrows independently of the date window.
    unavailableDetail: "no cost to report for these branches",
    info: {
      // ISS-4737: the card is re-derived over the MATCHED (filtered, windowed)
      // branches, not the whole corpus — the same vocabulary the LOC/$ card
      // beside it and the Sessions summary already use. Keep "in the selected
      // range" too: LOC/$ names "the in-range AI spend" to contrast its own
      // lifetime denominator, so this card must keep defining that term. The
      // absent state is NOT restated here — the caption under the value already
      // carries it, and saying it twice 40px apart in different words reads as
      // two different facts.
      what: "Total estimated AI cost across the matched branches, in the selected range.",
      how: "Summed from local session token usage, no GitHub needed.",
    },
    select: (analytics) => analytics.totalSpendUsd,
    // Big aggregate spend headline → whole dollars ($9,061), no cents. Per-branch
    // and per-session costs keep cents via formatCost (see format-utils.ts).
    format: formatCurrencyWhole,
    polarity: MetricPolarity.LowerIsBetter,
    basis: BRANCH_KPI_METRIC_BASIS.totalSpendUsd,
  },
  {
    key: "loc-per-dollar",
    label: LOC_PER_DOLLAR_LABEL,
    detail: "lines changed per lifetime dollar",
    // Two causes, one caption: the ratio is absent when no matched branch is
    // LOC-enriched (no numerator) AND when their enriched lifetime spend is
    // zero or absent (no denominator). Naming both keeps the caption true
    // whichever one fired.
    unavailableDetail: "no line counts or cost for these branches",
    info: {
      what: "Total lines changed (added + removed) per dollar of each matched branch's share of its sessions' lifetime spend.",
      // ISS-4632: the denominator is LIFETIME spend, not the in-range "AI spend"
      // figure beside it — both the churn numerator and the spend denominator are
      // lifetime so the ratio doesn't inflate as the window narrows. So this
      // "lifetime cost" is a different population than the windowed AI-spend card;
      // the copy says so to keep the two reconcilable.
      // ISS-4689: and it is no longer a session's WHOLE lifetime cost either — a
      // session's cost is even-split across the branches it touched GLOBALLY, so a
      // matched branch carries only its 1/N share. The moment a session has
      // branches outside the window or the facet, "the matched branches' lifetime
      // cost" overstates the denominator, so the copy names the share explicitly.
      // Same wording holds on the older-server fallback — same split, smaller N.
      how: "Lines changed ÷ each matched branch's share of its sessions' lifetime cost (not the in-range AI spend), over branches with line counts.",
    },
    select: (analytics) => analytics.locPerDollar,
    // ISS-4667: the shared LOC/$ formatter, so this card and the Sessions,
    // session-detail, Agents and pack cards round the same metric identically —
    // and a genuinely small ratio never floors to "0.00" on one of them.
    format: formatLocPerDollar,
    polarity: MetricPolarity.HigherIsBetter,
    basis: BRANCH_KPI_METRIC_BASIS.locPerDollar,
  },
  {
    key: "active-branches",
    label: "Active branches",
    detail: "in progress",
    // The ONLY absent cause here is an empty subset — a 0 over a non-empty one
    // is a real, Available 0 ("everything merged"), so this caption never has to
    // explain away a genuine zero.
    unavailableDetail: "no branches match these filters",
    info: {
      what: "Branches still in progress (not merged or closed).",
      how: "Count by local branch status, no GitHub needed.",
    },
    select: (analytics) => analytics.activeBranchCount,
    format: formatNumber,
    // Neutral, not higher-is-better (review on #4148): this counts work in
    // progress (not merged, not closed). A rise means more unfinished branches —
    // the same condition "Review backlog" reads as lower-is-better in Insights —
    // so colouring a rise green would claim a win and contradict that sibling
    // metric. Report the movement without a verdict.
    polarity: MetricPolarity.Neutral,
    basis: BRANCH_KPI_METRIC_BASIS.activeBranchCount,
  },
  {
    key: "merge-rate",
    label: "Merge rate",
    detail: "of decided PRs",
    // Absent exactly when the denominator is empty — no matched branch's PR has
    // reached a terminal outcome yet. Naming the decided population, not the
    // range, so a still-open corpus doesn't read as a broken read.
    unavailableDetail: "no decided PRs for these branches",
    info: {
      what: "Share of decided PRs (merged or closed) that merged.",
      how: "Merged ÷ decided (merged + closed) over the local corpus; still-open PRs are excluded until they reach a terminal outcome.",
    },
    select: (analytics) => analytics.mergeRate,
    format: (value) => `${Math.round(value)}%`,
    polarity: MetricPolarity.HigherIsBetter,
    basis: BRANCH_KPI_METRIC_BASIS.mergeRate,
  },
  {
    key: "pr-size",
    // FEA-3574 review (median dual-home): scoped caption so this whole-corpus
    // Median PR size can't be confused with the Sessions bar's same-labeled card
    // (scoped to merged PRs linked to the matched sessions — "per merged PR in
    // these sessions"). Here it's the whole local branch corpus: "per merged PR".
    label: "Median PR size",
    detail: "per merged PR",
    // Absent when no matched branch contributes a size: nothing merged, or the
    // merged ones have no line counts (un-enriched branches are excluded from
    // the median rather than folded in as 0).
    unavailableDetail: "no merged PR sizes for these branches",
    info: {
      what: "Median lines changed per merged PR.",
      how: "Median of additions + deletions across merged PRs.",
    },
    select: (analytics) => analytics.medianPrSize,
    format: formatLoc,
    // A growing median PR is a review-health regression, not a delivery win.
    polarity: MetricPolarity.LowerIsBetter,
    basis: BRANCH_KPI_METRIC_BASIS.medianPrSize,
  },
];

export function BranchesSummaryCards({
  className,
  cardClassName,
  analytics: data,
  isPending,
  isError,
  showDelta = true,
  wrapBelow = false,
  onConnectGitHub,
  approved = false,
  approvedComparisonSuppressedByFilter = false,
}: {
  /** Layout for the card container (desktop passes its dashboard grid). */
  className?: string;
  /**
   * Forwarded to {@link SummaryCardRow}: below `md` pair the cards two-up in a
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
  /** Error state from the parent's combined read. */
  isError: boolean;
  /**
   * Whether to show the "vs. prior 30 days" delta. The baseline is fixed at 30
   * days, so the delta is only meaningful when the window itself is 30 days —
   * callers pass `false` for any other window to avoid an apples-to-oranges %.
   */
  showDelta?: boolean;
  /**
   * Surface-owned "connect GitHub" action for the gated KPI cards. When
   * provided, each gated card's connect affordance renders a live CTA that
   * fires this handler (desktop passes its sign-in → GitHub App connect flow);
   * when omitted the affordance stays informational only, so the web shell and
   * any other caller keep today's behavior.
   */
  onConnectGitHub?: () => void | Promise<void>;
  /** Render the canonical PRD-601 five-card bundle. */
  approved?: boolean;
  /**
   * ISS-5714 (review thread): did the local filtered-metrics fallback replace
   * the approved cards' comparisons? NOT "are facets active" — an exact
   * cohort response carries the filtered cohort's own producer metrics, and a
   * gap in those is a data-availability gap the filter did not cause. Callers
   * pass `ApprovedBranchCohortAnalytics.comparisonSuppressedByFilter`.
   */
  approvedComparisonSuppressedByFilter?: boolean;
}) {
  const resolvedCardClassName = cardClassName ?? summaryCardClass(wrapBelow);

  if (approved) {
    return (
      <ApprovedBranchesSummaryCards
        cardClassName={resolvedCardClassName}
        className={className}
        comparisonSuppressedByFilter={approvedComparisonSuppressedByFilter}
        isError={isError}
        isPending={isPending}
        metrics={data?.canonicalMetrics}
        wrapBelow={wrapBelow}
      />
    );
  }
  return (
    <SummaryCardRow className={className} wrapBelow={wrapBelow}>
      {CARDS.map((card) => (
        <BranchKpiCard
          card={card}
          cardClassName={resolvedCardClassName}
          isError={isError}
          isPending={isPending}
          key={card.key}
          kpi={data ? card.select(data) : null}
          onConnectGitHub={onConnectGitHub}
          showDelta={showDelta}
        />
      ))}
    </SummaryCardRow>
  );
}

function BranchKpiCard({
  card,
  cardClassName,
  kpi,
  isError,
  isPending,
  showDelta,
  onConnectGitHub,
}: {
  card: CardSpec;
  cardClassName: string;
  kpi: BranchKpi | null;
  isError: boolean;
  isPending: boolean;
  showDelta: boolean;
  onConnectGitHub?: () => void | Promise<void>;
}) {
  // ISS-5842 (ISS-4779 closed-by-default): opt in to the unified delta pill
  // only when this surface's own gate is on — PostHog on web, Labs on desktop.
  const deltaTreatment = useMetricDeltaTreatment();
  // A pending or failed analytics read is NOT demo data: dim the card with
  // `muted` (reduced opacity, NO "Sample" badge). `placeholder`'s badge means
  // "value is sample data pending real wiring", which would lie about a card
  // that is simply loading or whose read failed — matching the Sessions bar's
  // `muted`-on-error treatment so the two summary rows stay consistent.
  if (isPending) {
    return (
      <MetricCard
        className={cardClassName}
        detail="Loading"
        info={card.info}
        label={card.label}
        muted
        value="—"
      />
    );
  }

  if (isError) {
    return (
      <MetricCard
        className={cardClassName}
        detail="Unavailable"
        info={card.info}
        label={card.label}
        muted
        value="—"
      />
    );
  }

  if (!kpi) {
    return (
      <MetricCard
        className={cardClassName}
        detail={card.detail}
        info={card.info}
        label={card.label}
        placeholder
        value="—"
      />
    );
  }

  if (kpi.state === BranchKpiState.Available && kpi.value != null) {
    const delta = resolveListDelta({ card, kpi, showDelta });
    // `delta`/`deltaPolarity` are a paired union on MetricCard (wongk review on
    // #4148): pass the polarity only alongside a real number, so an absent delta
    // renders no chip rather than a defaulted green-rise reading.
    if (delta === undefined) {
      return (
        <MetricCard
          className={cardClassName}
          detail={card.detail}
          info={card.info}
          label={card.label}
          value={card.format(kpi.value)}
        />
      );
    }
    return (
      <MetricCard
        className={cardClassName}
        delta={delta}
        deltaLabel={DELTA_LABEL}
        deltaPolarity={card.polarity}
        deltaTreatment={deltaTreatment}
        detail={card.detail}
        info={card.info}
        label={card.label}
        value={card.format(kpi.value)}
      />
    );
  }

  // Gated (needs GitHub) → the connect-GitHub affordance, never a fake number.
  // A surface that owns a connect handler (desktop) makes this a live CTA; the
  // web shell and handler-less callers keep the informational-only affordance.
  // The value slot is genuine no-data (`value={null}` → muted "No data" glyph),
  // matching the branch DETAIL cards so a missing metric reads one way across the
  // list→detail flow rather than a bold 2xl dash here and "No data" there
  // (FEA-4229/4236 list parity).
  if (kpi.state === BranchKpiState.Gated) {
    return (
      <MetricCard
        className={cardClassName}
        detail={<ConnectGitHubIndicator compact onConnect={onConnectGitHub} />}
        info={card.info}
        label={card.label}
        value={null}
      />
    );
  }

  // Unavailable — no data on the local corpus yet (e.g. no LOC enrichment). Same
  // muted "No data" glyph as the detail cards, not a bold 2xl dash. ISS-4737:
  // every card captions the absent value with WHY it is absent (its required
  // `unavailableDetail`) rather than the metric description written for a
  // number, so all five "No data" states in this row read in one grammar.
  return (
    <MetricCard
      className={cardClassName}
      detail={card.unavailableDetail}
      info={card.info}
      label={card.label}
      value={null}
    />
  );
}

/**
 * The delta this card may print, or `undefined` for no chip (ISS-4686, #4242
 * review).
 *
 * These cards render `kpi.value` itself over the whole branch corpus, so their
 * population is `Corpus` and their measurement is the KPI's own. That makes the
 * corpus/corpus comparison honest TODAY — but reading `kpi.deltaPct` raw would
 * also print a verdict from the first BRANCH-scoped baseline a producer wires,
 * while the branch-detail card for the same KPI correctly showed "No
 * comparison". Both consumers therefore route through the one resolver, so the
 * list and the detail page cannot state incompatible things about the same KPI
 * on the same visit.
 *
 * `showDelta` stays the outer gate: the baseline is fixed at 30 days, so a
 * non-30-day window has nothing comparable regardless of scope. And unlike the
 * detail cards, a non-comparable KPI renders NO chip here rather than a "No
 * comparison" placeholder — the list has never shown a reason slot, and every
 * producer emits an unbaselined KPI today, so a placeholder would put five
 * permanent "No comparison" labels on the Branches header.
 */
function resolveListDelta({
  card,
  kpi,
  showDelta,
}: {
  card: CardSpec;
  kpi: BranchKpi;
  showDelta: boolean;
}): number | undefined {
  if (!showDelta) {
    return undefined;
  }
  const comparison = resolveBranchBaselineComparison({
    kpi,
    hasValue: kpi.value != null,
    valueNumber: kpi.value,
    valueScope: BranchBaselineScope.Corpus,
    // The card renders the KPI's own value, so its basis IS the KPI's basis —
    // both halves come from the `BRANCH_KPI_METRIC_BASIS` SSOT so they cannot
    // drift apart, and `comparisonScope` is the gate doing the work here.
    valueBasis: card.basis,
    baselineBasis: card.basis,
  });
  return comparison.comparable ? comparison.deltaPct : undefined;
}
