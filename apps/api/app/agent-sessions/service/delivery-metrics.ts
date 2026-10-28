// FEA-3156 / FEA-4295 — Sessions delivery-summary metrics (PRs shipped, median
// PR size, merged KLOC/$) for the Sessions page top row.
//
// This module owns the SCOPE + WINDOW decisions for the delivery cards (the cost
// denominator is decided by the composition root — see below) and
// delegates the row-prep + KPI math to `collectMergedPrsForScope` +
// `computeDeliveryMetricsFromPrs` (`@/lib/agent-session-delivery-metrics`), which
// project merged PRs into the delivery-KPI SSOT engine. Extracted from
// `getUsageSummary` (service.ts) so the usage composition root stays thin
// (AGENTS.md file-size discipline).
//
// FEA-4295 (thread davetho): the merged-PR count must be bounded by the SELECTED
// date range at the PR's authoritative `mergedAt`, NOT by the SESSION activity
// window. The Sessions summary `where` windows sessions on `lastActivityAt`, so a
// June session whose PR merged in July never reaches the delivery scan under that
// `where` — the count could only ever SHRINK the pre-windowed set and understated
// "merged in range". This module therefore builds a DELIVERY SCOPE that preserves
// every org/viewer/facet filter but STRIPS the session-activity date window
// (`startDate`/`endDate`), then hands the selected range to the delivery engine as
// the `DeliveryWindow` so the range is applied at `mergedAt` (and, for cost, at the
// synthetic carrier's `startedAt`). An older session's in-window merge is now
// counted.
//
// IN-WINDOW DENOMINATOR (ISS-6398, closing what the code called ISS-5610): the
// LOC-per-dollar numerator is bounded by the selected range at `mergedAt`, so its
// denominator must be the spend of that SAME range. It is passed IN by the usage
// composition root, which has already classified that windowed spend, rather than
// re-derived here.
//
// The merged-PR numerator keeps the stripped scope, which lets an older-than-window
// session's in-window merge be counted. The denominator is still the selected
// range's total estimated cost.

import type {
  DeliveryWindow,
  NormalizedPr,
} from "@repo/api/src/insights/delivery-kpis/normalized-rows";
import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { legacyKlocPerDollarFromLoc } from "@repo/api/src/utils/loc-per-dollar";
import type { Prisma } from "@repo/database";
import type { LimitFunction } from "p-limit";
import {
  type AgentSessionDeliveryMetrics,
  collectMergedPrsForScope,
  computeDeliveryMetricsFromPrs,
  resolveDeliveryMergeWindow,
} from "@/lib/agent-session-delivery-metrics";
import {
  type LocPerDollarCostBasis,
  toMergedLocPerDollarBasis,
} from "./loc-per-dollar-basis";
import {
  type LocPerDollarCoverageCounts,
  readLocPerDollarCoverageCounts,
  resolveNumeratorBranchCohort,
} from "./loc-per-dollar-coverage";
import type { SessionUsageInput } from "./records";
import type { UsageComparisonWindow } from "./usage-comparison";
import { buildUsageSummaryWhere } from "./usage-summary-where";

/** The merged-PR set behind the delivery cards, plus the window to evaluate it against. */
export type DeliveryPrScope = {
  prs: NormalizedPr[];
  mergeWindow: DeliveryWindow | null;
  /**
   * ISS-7705: whether the LOC/$ coverage probe was RUN for this scope.
   *
   * False when the scope found no merged PRs at all. That is not "coverage is
   * fine" — it is "there is no ratio to gate": `mergedLocPerDollar` is already
   * null on its own account, so the caller publishes no verdict rather than a
   * `complete` one that would assert coverage nobody measured.
   *
   * Kept separate from {@link coverageCounts} because `null` counts mean
   * something ELSE — probed and FAILED — which must publish a verdict.
   */
  coverageProbed: boolean;
  /**
   * The populations the probe read, or `null` when it was run and did not
   * complete. Meaningless unless {@link coverageProbed} is true.
   */
  coverageCounts: LocPerDollarCoverageCounts | null;
};

/**
 * Collects the merged-PR set the Sessions delivery cards summarize — the whole
 * DB half of the read (one probe, one keyset pass).
 *
 * Builds the delivery scope (facet filters preserved, session-activity date window
 * stripped) so an older session's in-window merge is counted, and resolves the
 * selected range as the delivery `DeliveryWindow`.
 *
 * The prior-period count is FREE because the scope deliberately strips the
 * session-activity date window (see the module header): the scope is identical for
 * both periods, so the one collected set is evaluated against two `DeliveryWindow`s
 * in memory by {@link foldDeliverySummaryMetricsWithPrior}.
 *
 * @param limiter The caller's request-wide fan-out budget. Both reads below chunk
 *   their id lists, and ISS-6136 made those chunks run concurrently — so without
 *   a limiter handed down, this stage would open one budget here, a second in
 *   `collectMergedPrsForScope` and a third in the coverage probe. Call bounds
 *   compose by ADDITION, and that these two happen not to overlap today is an
 *   ordering detail of this function, not a bound.
 */
export async function collectDeliveryPrScope(
  input: SessionUsageInput,
  denominatorWhere: Prisma.SessionDetailWhereInput,
  priorWindow: UsageComparisonWindow | null,
  limiter?: LimitFunction
): Promise<DeliveryPrScope> {
  const mergeWindow = resolveDeliveryMergeWindow(
    input.filters.startDate,
    input.filters.endDate
  );
  // The delivery scope carries every facet filter but NOT the session-activity
  // date window: an older-than-window session whose PR merged in the window must
  // still reach the scan. When a range is selected we strip both bounds; with no
  // range (`mergeWindow === null`) the scope already has no date window, so the
  // usage `where` is reused as-is.
  const deliveryWhere =
    mergeWindow === null
      ? await buildUsageSummaryWhere(input)
      : await buildUsageSummaryWhere(stripDateWindow(input));
  const { prs, mergedBranches } = await collectMergedPrsForScope(
    input.organizationId,
    deliveryWhere,
    // ISS-9924: read only the PRs the folds can count — merged in this window or
    // in `priorWindow`. `foldDeliverySummaryMetricsWithPrior` must be handed the
    // SAME prior window, or its prior count is taken over a set this read cut.
    spanMergeWindows(mergeWindow, priorWindow),
    limiter
  );
  // ISS-7705: gate the ratio only when there IS a ratio. The cohort is the
  // branches whose PRs merged INSIDE the window — the population the LOC
  // actually came from — so an org whose only merged PRs landed outside the
  // range contributes no lines, needs no divisor, and is not probed at all. That
  // also keeps the commonest read there is (a broad dashboard with no PR links,
  // which `collectMergedPrsForScope` short-circuits before touching a PR row)
  // free of any coverage query.
  const numeratorCohort = resolveNumeratorBranchCohort(
    mergedBranches,
    mergeWindow
  );
  const coverageProbed = numeratorCohort.size > 0;
  const coverageCounts = coverageProbed
    ? await readLocPerDollarCoverageCounts(
        input.organizationId,
        numeratorCohort,
        deliveryWhere,
        denominatorWhere,
        limiter
      )
    : null;
  return { prs, mergeWindow, coverageProbed, coverageCounts };
}

/**
 * The delivery metrics for an already-collected {@link DeliveryPrScope}, plus —
 * when `priorWindow` is given — that scope's merged-PR count for the adjacent
 * window (ISS-5809).
 *
 * ISS-7343: this half is deliberately PURE. `windowedCostUsd` is only ever a
 * divisor, so keeping it out of {@link collectDeliveryPrScope} is what lets the
 * usage composition root run the delivery scan concurrently with the cost split
 * that produces it, instead of behind it.
 *
 * Only `mergedPrCount` is read from the prior evaluation. `mergedLocPerDollar`
 * is deliberately not compared: since ISS-6398 its denominator is the spend of
 * the CURRENT window, and the prior window's spend is computed elsewhere in the
 * same request (`usage-comparison.ts`). So the prior evaluation carries a `null`
 * denominator — a prior LOC/$ built on current dollars must not exist even unread.
 */
export function foldDeliverySummaryMetricsWithPrior(
  scope: DeliveryPrScope,
  priorWindow: UsageComparisonWindow | null,
  windowedCostUsd: number | null
): {
  metrics: AgentSessionDeliveryMetrics;
  priorMergedPrCount: number | null;
} {
  const metrics = computeDeliveryMetricsFromPrs(
    scope.prs,
    windowedCostUsd,
    scope.mergeWindow
  );
  if (priorWindow === null) {
    return { metrics, priorMergedPrCount: null };
  }
  const priorMetrics = computeDeliveryMetricsFromPrs(
    scope.prs,
    null,
    resolveDeliveryMergeWindow(priorWindow.startDate, priorWindow.endDate)
  );
  return { metrics, priorMergedPrCount: priorMetrics.mergedPrCount };
}

/** Returns `input` with the `startDate`/`endDate` filter bounds removed. */
function stripDateWindow(input: SessionUsageInput): SessionUsageInput {
  return {
    ...input,
    filters: { ...input.filters, startDate: undefined, endDate: undefined },
  };
}

/**
 * Projects `metrics` into the delivery fields of `AgentSessionUsageSummary`
 * (FEA-3156's Sessions top row), including the deprecated KLOC/$ alias.
 *
 * ISS-4667: `mergedLocPerDollar` (merged gross lines ÷ cost) is the canonical
 * field. We ALSO emit the deprecated `mergedKlocPerDollar` alias (LOC/$ ÷ 1000)
 * for one release: the cloud deploys ahead of the Desktop builds already
 * installed on people's machines, and a pre-ISS-4667 desktop reads
 * `usage.mergedKlocPerDollar` — dropping it would fall its Sessions bar card to a
 * neutral dash even though the server has the data. Per AGENTS.md Cross-Repo
 * Compatibility, keep the renamed field until a human approves removing the
 * shim. `null` stays `null` — never a fabricated legacy number. Living here (not
 * at the `getUsageSummary` composition root) keeps the alias's lifetime owned by
 * the module that owns the metric.
 *
 * ISS-9848: `mergedLocPerDollarBasis` is emitted HERE, from the divisor the
 * caller actually used, rather than at either composition root. Both producers
 * of this endpoint's summary — the live one and the TypedSQL candidate — go
 * through this helper, so the basis cannot describe one path's divisor while the
 * other publishes a different one. It rides the field even when the ratio is
 * `null`: the card renders its "how" caption either way, and a caption that
 * silently reverts to the client's compiled-in guess whenever the number is
 * absent is the same skew defect in a narrower window.
 */
export function toDeliverySummaryFields(
  metrics: AgentSessionDeliveryMetrics,
  costBasis: LocPerDollarCostBasis
): Pick<
  AgentSessionUsageSummary,
  | "medianPrSize"
  | "mergedKlocPerDollar"
  | "mergedLocPerDollar"
  | "mergedLocPerDollarBasis"
  | "mergedPrCount"
> {
  return {
    mergedPrCount: metrics.mergedPrCount,
    medianPrSize: metrics.medianPrSize,
    mergedLocPerDollar: metrics.mergedLocPerDollar,
    mergedLocPerDollarBasis: toMergedLocPerDollarBasis(costBasis.basis),
    mergedKlocPerDollar: legacyKlocPerDollarFromLoc(metrics.mergedLocPerDollar),
  };
}

/**
 * The merge window the delivery read must cover: the current window widened to
 * the prior one `foldDeliverySummaryMetricsWithPrior` evaluates, resolved the
 * same way that fold resolves it. `null` (all-time) whenever either evaluation
 * is unbounded.
 */
function spanMergeWindows(
  mergeWindow: DeliveryWindow | null,
  priorWindow: UsageComparisonWindow | null
): DeliveryWindow | null {
  if (mergeWindow === null || priorWindow === null) {
    return mergeWindow;
  }
  const prior = resolveDeliveryMergeWindow(
    priorWindow.startDate,
    priorWindow.endDate
  );
  if (prior === null) {
    return null;
  }
  return {
    start: Math.min(mergeWindow.start, prior.start),
    end: Math.max(mergeWindow.end, prior.end),
  };
}
