import "server-only";

/**
 * ISS-11117 — the ONE rule that keeps the Pensero points ratio's two terms over
 * the same period.
 *
 * ## The defect this exists to prevent
 *
 * Every per-dollar denominator on a LISTING is windowed. `canonicalLocPerDollar`
 * divides `canonicalEstimatedCostUsd`, which ISS-9956 folds over the WINDOWED
 * population precisely so it spans its own numerator's window
 * (`branch-analytics-read.ts:165` passes `visibleWindowedUsageByBranch`); the
 * Sessions summary divides the cost of the sessions matched by the request's
 * date range.
 *
 * Dividing a branch-LIFETIME numerator by one of those inflates the ratio as
 * the window narrows, by an amount no reader can see — a confident,
 * plausible-looking, wrong number, which is worse than no number.
 *
 * ## The rule: window BOTH terms, never withhold one
 *
 * This module used to answer that by publishing the ratio only when the request
 * bounded no window at all. Both listings default to `Last7Days`
 * (`DEFAULT_DATE_RANGE`, `packages/app/shared/lib/format-utils.ts:163`) and
 * `getStableUtcDateWindowForRange` sends a bound pair for every range but
 * "all" (`format-utils.ts:274`), so that rule published on the one view nobody
 * lands on — narrower than ISS-11117 AC1, which names no window exception
 * (tamsinb and chatgpt-codex-connector, PR #7863, independently).
 *
 * The numerator is windowable, and `delivery-point-read.ts` did not have to
 * change a predicate for it: the reason that read must not filter `deliveredOn`
 * is about RESOLUTION — the creator row acquires its branch from a sibling in
 * another window — so the read still fetches every share and
 * `attributeDeliveryPoints` applies the window to the shares it SUMS. The
 * resulting quantity is additive over disjoint windows and sums to the lifetime
 * total, which is exactly what a windowed cost basis may divide. See
 * `DeliveryPointWindow`.
 *
 * So this module no longer gates. It hands the reader the request's bounds as
 * the window the delivery fold takes (`penseroDeliveryWindow`), and the
 * all-time view is the absent window — the same lifetime-over-lifetime pairing
 * branch DETAIL ships (ISS-9814 AC4).
 */

import {
  type PenseroDateWindowQuery,
  penseroDeliveryWindow,
} from "@/lib/delivery-points/delivery-point-window";
import type { FeatureFlagIdentity } from "@/lib/feature-flag-identity";
import type { BranchPenseroNumerator } from "./branch-pensero-numerator";
import { cohortPenseroPointsReader } from "./branch-pensero-numerator";

/**
 * The cohort Pensero reader for a request, bound to the window its cost basis
 * covers.
 *
 * Always a reader: the ratio is computable on every view now, and the display
 * flag is still what decides whether a query is issued at all — the reader
 * checks it before any database work.
 */
export function cohortPenseroReaderForRequest(
  identity: FeatureFlagIdentity,
  organizationId: string,
  query: PenseroDateWindowQuery
): (
  branchArtifactIds: readonly string[]
) => Promise<BranchPenseroNumerator | null> {
  return cohortPenseroPointsReader(
    identity,
    organizationId,
    penseroDeliveryWindow(query)
  );
}
