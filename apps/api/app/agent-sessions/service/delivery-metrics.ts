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
// FEA-4295 (thread shafty023): the merged-PR count must be bounded by the SELECTED
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
// denominator must be the spend of that SAME range — the in-window API-billed cost
// (`apiEstimatedCost`, the not-subscription-covered bucket = metered + unknown). It
// is passed IN by the usage composition root, which has already classified it over
// the windowed summary `where`, rather than re-derived here.
//
// That divisor is the figure the Cost card shows on its DEFAULT basis only. Under
// the ISS-4773 cost-honesty flag the Cost headline drops to `meteredEstimatedCost`
// and discloses the unknown share separately, so whenever unknown spend is non-zero
// the two tiles no longer multiply out — see the same caveat, and the flag-ON copy
// that avoids the claim, in `sessions-summary-cards.tsx`. Do not restate "the same
// figure the Cost card shows" unqualified; it is only true with the flag off.
//
// It used to be derived from the date-window-STRIPPED delivery scope instead, on the
// argument (thread shafty023) that both sides should span one session set. That made
// the two sides span different TIME: a windowed numerator over an all-time divisor,
// so a 7-day view divided a week of merged lines by every dollar the org had ever
// spent and understated the ratio by orders of magnitude (ISS-6398 measured ~517x).
// Cohort identity at the session level cannot buy back a denominator the reader's
// selected window does not describe, and the card cannot reconcile against the Cost
// tile it sits next to. The merged-PR NUMERATOR keeps the stripped scope, which is
// what still lets an older-than-window session's in-window merge be counted.

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { legacyKlocPerDollarFromLoc } from "@repo/api/src/utils/loc-per-dollar";
import {
  type AgentSessionDeliveryMetrics,
  collectMergedPrsForScope,
  computeDeliveryMetricsFromPrs,
  resolveDeliveryMergeWindow,
} from "@/lib/agent-session-delivery-metrics";
import type { SessionUsageInput } from "./records";
import type { UsageComparisonWindow } from "./usage-comparison";
import { buildUsageSummaryWhere } from "./usage-summary-where";

/**
 * The Sessions delivery-summary metrics for `input`, plus — when `priorWindow` is
 * given — the same scope's merged-PR count for that adjacent window (ISS-5809).
 *
 * Builds the delivery scope (facet filters preserved, session-activity date window
 * stripped) so an older session's in-window merge is counted, resolves the selected
 * range as the delivery `DeliveryWindow`, and divides by `windowedApiCost` — the
 * API-billed spend of the SELECTED window (ISS-6398).
 *
 * The prior count is FREE. The delivery scope deliberately strips the
 * session-activity date window (see the module header), so the scope is identical
 * for both periods and the selected range is applied downstream at each PR's own
 * `mergedAt`. One probe, one keyset pass — then the collected merged-PR set is
 * evaluated against two `DeliveryWindow`s in memory.
 *
 * Only `mergedPrCount` is returned for the prior period. `medianPrSize` is not
 * compared, and `mergedLocPerDollar` deliberately is not either: since ISS-6398 its
 * denominator is the spend of the CURRENT window. The prior window's spend is
 * computed elsewhere in the same request (`usage-comparison.ts` runs the shared
 * classifier over the prior `where`) but only AFTER this pass, so it is not
 * available here and a prior ratio would divide prior lines by current dollars.
 * That is why `windowedApiCost` is applied to the current window only and the prior
 * evaluation carries `null` — a prior LOC/$ built on the wrong dollars must not
 * exist even unread.
 */
export async function computeDeliverySummaryMetricsWithPrior(
  input: SessionUsageInput,
  priorWindow: UsageComparisonWindow | null,
  windowedApiCost: number | null
): Promise<{
  metrics: AgentSessionDeliveryMetrics;
  priorMergedPrCount: number | null;
}> {
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
  const prs = await collectMergedPrsForScope(
    input.organizationId,
    deliveryWhere
  );
  const metrics = computeDeliveryMetricsFromPrs(
    prs,
    windowedApiCost,
    mergeWindow
  );
  if (priorWindow === null) {
    return { metrics, priorMergedPrCount: null };
  }
  // Cost `null` for the prior evaluation: only `mergedPrCount` is read from it,
  // and the current window's dollars are not the prior window's (see the doc
  // above). A null denominator makes the prior LOC/$ unavailable rather than
  // silently wrong, so it cannot be picked up later by mistake.
  const priorMetrics = computeDeliveryMetricsFromPrs(
    prs,
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
 */
export function toDeliverySummaryFields(
  metrics: AgentSessionDeliveryMetrics
): Pick<
  AgentSessionUsageSummary,
  | "medianPrSize"
  | "mergedKlocPerDollar"
  | "mergedLocPerDollar"
  | "mergedPrCount"
> {
  return {
    mergedPrCount: metrics.mergedPrCount,
    medianPrSize: metrics.medianPrSize,
    mergedLocPerDollar: metrics.mergedLocPerDollar,
    mergedKlocPerDollar: legacyKlocPerDollarFromLoc(metrics.mergedLocPerDollar),
  };
}
