// FEA-2952 / PLN-1323 — the declarative KPI registry (THE modifiability layer).
//
// Each delivery KPI is expressed as DATA, not code: which population it selects,
// which per-row measure it takes, how it aggregates, an optional post-aggregate
// transform, rounding, whether to restrict to enriched PRs, and its display
// metadata (label / help / format). `computeDeliveryKpis` (compute.ts) walks this
// registry uniformly, so changing a metric's DEFINITION never touches the engine
// — it's a one-line data edit here.
//
// The exact formulas were ratified (FEA-2952) as the Phase-0 defaults encoded
// below — kept as-is, adjusted as needed. Where a definition differs from what
// today's surfaces compute, a `// DECIDED (FEA-2952): ...` comment records the
// choice (what we kept, what the old surfaces did, and how to revisit).

import type { KpiFormat as KpiFormatType } from "../../types/insights.ts";
import { KpiFormat } from "../../types/insights.ts";
import type { AggregationKey } from "./aggregations.ts";
import type {
  BranchMeasureKey,
  PrMeasureKey,
  SessionMeasureKey,
} from "./measures.ts";
import type {
  BranchPopulationKey,
  PrPopulationKey,
  SessionPopulationKey,
} from "./populations.ts";

/** Canonical keys for every delivery KPI. Const-object enum per repo convention. */
export const DeliveryKpiKey = {
  MergeRate: "mergeRate",
  PrSize: "prSize",
  Kloc: "kloc",
  Cost: "cost",
  CostPerMergedPr: "costPerMergedPr",
  TokensPerKloc: "tokensPerKloc",
  TimeToMerge: "timeToMerge",
  ActivePrCount: "activePrCount",
  MergedKlocPerDollar: "mergedKlocPerDollar",
  MergedCount: "mergedCount",
  DecidedCount: "decidedCount",
  ReviewBacklog: "reviewBacklog",
  CapturedPrCount: "capturedPrCount",
  SessionsCount: "sessionsCount",
  SessionTokensTotal: "sessionTokensTotal",
} as const;
export type DeliveryKpiKey =
  (typeof DeliveryKpiKey)[keyof typeof DeliveryKpiKey];

/**
 * Post-aggregate transforms, referenced by key from a KPI definition. Kept as a
 * small named set (rather than inline closures) so definitions stay pure data and
 * a transform's meaning is discoverable in one place.
 */
export const KpiTransform = {
  /** Divide the aggregate by 1000 (lines → KLOC). */
  PerThousand: "perThousand",
} as const;
export type KpiTransform = (typeof KpiTransform)[keyof typeof KpiTransform];

/**
 * A "derived" KPI is computed from OTHER already-computed KPI values rather than
 * from a single population→measure→aggregate pipeline (e.g. cost-per-merged-PR is
 * cost ÷ mergedCount). It names its numerator and denominator KPI keys plus a
 * scale, and the engine forms the ratio (null when the denominator is 0/null).
 */
type DerivedSpec = {
  numeratorKpi: DeliveryKpiKey;
  denominatorKpi: DeliveryKpiKey;
  /** Multiplies the ratio, e.g. 100 to render a fraction as a percent. */
  scale?: number;
};

type BaseKpiDefinition = {
  key: DeliveryKpiKey;
  label: string;
  help: string;
  format: KpiFormatType;
  aggregate: AggregationKey;
  transform?: KpiTransform;
  /** Decimal places for the final value. Omit for no rounding. */
  round?: number;
  /**
   * When true this KPI is a private building block for derived KPIs and is
   * excluded from the public result map (e.g. the decided-PR count that only
   * exists to be the merge-rate denominator).
   */
  internal?: boolean;
};

/** A KPI measured over a PR population. */
export type PrKpiDefinition = BaseKpiDefinition & {
  source: "pr";
  population: PrPopulationKey;
  measure: PrMeasureKey;
  /** Restrict the population to rows with `enriched === true` before measuring. */
  onlyEnriched?: boolean;
};

/** A KPI measured over a branch population. */
export type BranchKpiDefinition = BaseKpiDefinition & {
  source: "branch";
  population: BranchPopulationKey;
  measure: BranchMeasureKey;
};

/** A KPI measured over a session population. */
export type SessionKpiDefinition = BaseKpiDefinition & {
  source: "session";
  population: SessionPopulationKey;
  measure: SessionMeasureKey;
};

/** A KPI derived from other computed KPI values (a ratio of two of them). */
export type DerivedKpiDefinition = Omit<
  BaseKpiDefinition,
  "aggregate" | "transform"
> & {
  source: "derived";
  derived: DerivedSpec;
};

export type DeliveryKpiDefinition =
  | PrKpiDefinition
  | BranchKpiDefinition
  | SessionKpiDefinition
  | DerivedKpiDefinition;

/**
 * THE registry — one entry per delivery KPI, each a Phase-0 canonical default.
 *
 * Ordered base-before-derived so the engine resolves in a single pass: base KPIs
 * populate the value table, then derived KPIs read from it.
 */
export const DELIVERY_KPI_REGISTRY: readonly DeliveryKpiDefinition[] = [
  // --- Base counts ---
  // Merged count = COUNT of merged PRs.
  {
    key: DeliveryKpiKey.MergedCount,
    source: "pr",
    population: "mergedPrs",
    measure: "one",
    aggregate: "count",
    label: "Merged PRs",
    help: "PRs merged in range.",
    format: KpiFormat.Number,
  },
  // Decided count = COUNT of decided PRs (merged + closed). Internal — exists
  // only as the merge-rate denominator.
  {
    key: DeliveryKpiKey.DecidedCount,
    source: "pr",
    population: "decidedPrs",
    measure: "one",
    aggregate: "count",
    internal: true,
    label: "Decided PRs",
    help: "Merged + closed PRs in range.",
    format: KpiFormat.Number,
  },
  // Active PR count = COUNT of open/draft PRs.
  {
    key: DeliveryKpiKey.ActivePrCount,
    source: "pr",
    population: "activePrs",
    measure: "one",
    aggregate: "count",
    label: "Active PRs",
    help: "Open or draft PRs in range.",
    format: KpiFormat.Number,
  },
  // Review backlog = COUNT of open (non-draft) PRs awaiting review.
  {
    key: DeliveryKpiKey.ReviewBacklog,
    source: "pr",
    population: "reviewBacklogPrs",
    measure: "one",
    aggregate: "count",
    label: "Review backlog",
    help: "Open PRs awaiting review.",
    format: KpiFormat.Number,
  },
  // Captured PR count = COUNT of all captured PRs (raw ingest).
  {
    key: DeliveryKpiKey.CapturedPrCount,
    source: "pr",
    population: "capturedPrs",
    measure: "one",
    aggregate: "count",
    label: "Captured PRs",
    help: "PRs observed in range, any state.",
    format: KpiFormat.Number,
  },
  // Sessions count = COUNT of sessions in window.
  {
    key: DeliveryKpiKey.SessionsCount,
    source: "session",
    population: "sessions",
    measure: "one",
    aggregate: "count",
    label: "Sessions",
    help: "Agent sessions started in range.",
    format: KpiFormat.Number,
  },
  // --- Size / latency distributions ---
  // PR size = MEDIAN gross lines over MERGED PRs, enriched-only.
  //
  // MODIFIABILITY (PR size): to switch this KPI from median PR size to the mean,
  // flip the aggregate on the line below (`aggregate: "median"` → `"mean"`); to
  // count NET lines instead of gross, change `measure: "linesGross"` → `"linesNet"`.
  //
  // DECIDED (FEA-2952): keeping enriched-only (onlyEnriched:true). The old cloud
  // surface medianed over ALL merged PRs, letting un-enriched rows contribute
  // placeholder 0s and understate the median; the SSOT default excludes them.
  // Revisit as needed.
  {
    key: DeliveryKpiKey.PrSize,
    source: "pr",
    population: "mergedPrs",
    measure: "linesGross",
    aggregate: "median", // ← change to "mean" for average PR size
    onlyEnriched: true,
    label: "Median PR size",
    help: "Median gross lines changed per merged PR (enriched PRs only).",
    format: KpiFormat.Number,
  },
  // Time to merge = MEDIAN (mergedAt − createdAt) over merged PRs, in ms.
  //
  // DECIDED (FEA-2952): keeping the PR-open anchor, TTM = mergedAt − createdAt.
  // The old cloud surface measured "first commit → merge"; the SSOT uses PR
  // creation (the only anchor the NormalizedPr contract carries). Revisit as
  // needed — switching to first-commit would require adding a `firstCommitAt`
  // field to the contract + adapters.
  {
    key: DeliveryKpiKey.TimeToMerge,
    source: "pr",
    population: "mergedPrs",
    measure: "mergeLatencyMs",
    aggregate: "median",
    label: "Median time to merge",
    help: "Median PR-open → merge latency.",
    format: KpiFormat.Duration,
  },
  // KLOC = SUM gross lines over MERGED PRs, divided by 1000, rounded to 1 dp.
  //
  // DECIDED (FEA-2952): intentionally NO onlyEnriched here (unlike PrSize above).
  // KLOC is a SUM, so an un-enriched merged PR (null additions/deletions →
  // linesGross 0) folds in as 0 rather than skewing the result — this matches the
  // historical dashboard behavior (FEA-2159: un-enriched PRs count as 0 lines in
  // the total). PrSize needs onlyEnriched because a MEDIAN can't 0-pad without
  // being dragged down; a SUM can. Consequence to accept: while enrichment lags,
  // KLOC (and tokensPerKloc, which divides by it) undercounts the true landed
  // lines — a known, bounded understatement, not a bug. Revisit if the undercount
  // ever needs an "enrichment N% complete" signal.
  //
  // MODIFIABILITY (KLOC): the flagship example of the registry's whole point. To
  // count all lines a session generated in its branch instead of only lines that
  // landed in merged PRs, change three fields on this one entry — no engine
  // change: `source: "branch"`, `population: "sessionBranches"`,
  // `measure: "branchLinesGross"`. (All three already exist as primitives.)
  {
    key: DeliveryKpiKey.Kloc,
    source: "pr",
    population: "mergedPrs", // ← change to "sessionBranches" to count all lines generated in a branch from a session
    measure: "linesGross",
    aggregate: "sum",
    transform: KpiTransform.PerThousand,
    round: 1,
    label: "KLOC merged",
    help: "Thousands of gross lines landed in merged PRs.",
    format: KpiFormat.Number,
  },
  // --- Cost / usage totals ---
  // Cost = SUM session cost over sessions in window.
  // NOTE: dedup of multi-row sessions is a ROW-PREP concern handled by the
  // adapter (see NormalizedSession docs); this sums naively.
  // NOTE (billing mode, FEA-2957): the metered-vs-subscription split is likewise a
  // ROW-PREP concern — the adapter must exclude subscription-covered
  // "would-have-cost" from `costUsd` (headline = metered + unknown, never
  // subscription; see apps/desktop/src/shared/billing-mode.ts) so this naive SUM
  // matches the desktop headline instead of overstating real spend. CostPerMergedPr
  // divides this value, so it inherits the same guarantee. Crucially the split
  // zeroes `costUsd`, it does NOT drop the session: a subscription session stays a
  // row in `sessions[]` (with costUsd 0), so SessionsCount and the per-session
  // ratios stay correct while this SUM ignores it. See NormalizedSession docs.
  {
    key: DeliveryKpiKey.Cost,
    source: "session",
    population: "sessions",
    measure: "cost",
    aggregate: "sum",
    round: 2,
    label: "Cost",
    help: "Total agent spend (USD) in range.",
    format: KpiFormat.Currency,
  },
  // Session tokens total = SUM tokens over sessions. Internal — numerator for
  // tokens-per-KLOC (tokens are surfaced elsewhere as their own tile).
  {
    key: DeliveryKpiKey.SessionTokensTotal,
    source: "session",
    population: "sessions",
    measure: "tokens",
    aggregate: "sum",
    internal: true,
    label: "Tokens",
    help: "Total tokens across sessions in range.",
    format: KpiFormat.Tokens,
  },
  // --- Derived KPIs (read from the base KPI values above) ---
  // Merge rate = MergedCount ÷ DecidedCount, as a percent.
  //
  // DECIDED (FEA-2952): keeping the DECIDED denominator, merged/(merged+closed)
  // (via DecidedCount), so still-open PRs don't drag the rate down. The old cloud
  // + desktop surfaces used MERGED / (all captured PRs) — a captured-cohort
  // fraction that gave a different, lower number. FEA-3151 reconciled the cloud
  // surface onto THIS definition: apps/api/app/insights/service.ts getDelivery now
  // computes merge rate via `ssotMergeRateFromCounts` (parity.ts), which runs this
  // registry entry through the shared engine — so cloud, desktop, and web all read
  // one definition. Revisit as needed.
  {
    key: DeliveryKpiKey.MergeRate,
    source: "derived",
    derived: {
      numeratorKpi: DeliveryKpiKey.MergedCount,
      denominatorKpi: DeliveryKpiKey.DecidedCount,
      scale: 100,
    },
    round: 0,
    label: "Merge rate",
    help: "Merged as a share of decided PRs (merged + closed).",
    format: KpiFormat.Percent,
  },
  // Cost per merged PR = Cost ÷ MergedCount.
  {
    key: DeliveryKpiKey.CostPerMergedPr,
    source: "derived",
    derived: {
      numeratorKpi: DeliveryKpiKey.Cost,
      denominatorKpi: DeliveryKpiKey.MergedCount,
    },
    round: 2,
    label: "Cost per merged PR",
    help: "Total cost divided by merged PR count.",
    format: KpiFormat.Currency,
  },
  // Merged KLOC per dollar = KLOC ÷ Cost.
  //
  // Derived (NOT computed from display-rounded KLOC): the engine divides by the
  // RAW, un-rounded KLOC from the base value table, so a sub-100-line window
  // (whose KLOC rounds to 0.0 for display) still divides honestly instead of
  // fabricating 0.00 KLOC/$. Powers the Sessions "KLOC per $" delivery card
  // (apps/api/lib/agent-session-delivery-metrics.ts).
  {
    key: DeliveryKpiKey.MergedKlocPerDollar,
    source: "derived",
    derived: {
      numeratorKpi: DeliveryKpiKey.Kloc,
      denominatorKpi: DeliveryKpiKey.Cost,
    },
    label: "KLOC per $",
    help: "Thousands of gross lines landed in merged PRs per dollar of agent spend.",
    format: KpiFormat.Number,
  },
  // Tokens per KLOC = (sum tokens) ÷ KLOC.
  //
  // DECIDED (FEA-2952): tokens-per-thousand-landed-lines — numerator is raw
  // summed tokens, denominator is KLOC (already /1000). Revisit as needed (e.g.
  // if tokens-per-merged-PR is ever wanted instead).
  {
    key: DeliveryKpiKey.TokensPerKloc,
    source: "derived",
    derived: {
      numeratorKpi: DeliveryKpiKey.SessionTokensTotal,
      denominatorKpi: DeliveryKpiKey.Kloc,
    },
    round: 0,
    label: "Tokens per KLOC",
    help: "Total tokens divided by thousands of lines landed.",
    format: KpiFormat.Number,
  },
];
