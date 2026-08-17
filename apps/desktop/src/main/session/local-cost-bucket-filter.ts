import {
  costFilterIncludesUnknown,
  matchesCostBucket,
  matchesUnknownCost,
  type SessionSubstantiveCounts,
  sessionCostIsNumeric,
} from "@repo/api/src/agent-session-filters";

/**
 * Decimal places to which the desktop-summed float cost is normalized before
 * bucket comparison, to match the cloud's Prisma `Decimal` column precision. The
 * desktop sums per-model float values (`sumTokenUsage`), which can introduce
 * sub-cent floating-point drift (e.g. `0.9999999999999998` instead of `1.0`) and
 * misplace a session at a bucket boundary relative to the cloud Decimal-exact
 * value. `matchesCostBucket` then rounds to the displayed 2dp on top of this, so
 * a `$1.00` row is not in "< $1" (FEA-4293).
 */
const COST_NORMALIZATION_DECIMALS = 6;
const COST_NORMALIZATION_FACTOR = 10 ** COST_NORMALIZATION_DECIMALS;

/**
 * Whether a local session falls into ANY of the selected cost buckets (OR within
 * the dimension). Extracted from `matchesLocalFacetFilters` into this sibling
 * helper (FEA-4293/4294 codex P1) so the grandfathered `shared-agent-sessions-api`
 * module stays shrinking, and so the cost-bucket rule — the DB-precision
 * normalization, the FEA-4294 numeric guard, and the shared-SSOT bucket match —
 * lives in one cohesive place.
 *
 * FEA-4294: a session whose cost is UNKNOWN (renders "—") has no numeric cost and
 * must not fall into any numeric bucket — its summed cost is a placeholder `0`
 * that would otherwise satisfy "< $1". Only a KNOWN cost (priced, or a
 * subscription session that still shows a `$` figure) is bucketed, mirroring the
 * cloud query's `SESSION_COST_KNOWN_WHERE` / reconciled-path guard.
 *
 * ISS-4481: the selectable Unknown/missing-cost option is the disjoint complement
 * — a row whose cost is unknown (renders "—") matches it, and only it, never a
 * numeric bucket. The dimension composes OR-within, mirroring the cloud
 * `buildCostBucketWhere` / reconciled `matchesCostFilter`. The numeric-vs-unknown
 * AVAILABILITY check gates on the SUBSTANTIVE-WORK counts and the RAW summed cost
 * — the SAME signals `deriveCostAvailability` renders through — so a no-work
 * subscription session reads Unknown, and a tiny raw positive cost (`0.0000004`,
 * which the cell shows as `$0.00`) reads KNOWN rather than being rounded to 0 and
 * mislabeled Unknown (wongk thread). Only the BUCKET-boundary comparison uses the
 * 6dp-normalized value, to stay Decimal-exact against the cloud column.
 *
 * `rawSummedCost` is the un-normalized `sumTokenUsage(session).estimatedCost`;
 * `billingMode` is the session's billing mode (null when unknown);
 * `substantiveCounts` are the session's turn/token/tool-use counts (derived
 * identically to the Idle badge); `costBuckets` is the selected cost-filter-id set
 * (an empty set is handled by the caller, which skips this dimension entirely).
 */
export function matchesLocalCostBucketFilter(
  rawSummedCost: number,
  billingMode: string | null,
  substantiveCounts: SessionSubstantiveCounts,
  costBuckets: readonly string[]
): boolean {
  // Availability (numeric vs "—") is decided on the RAW cost + work counts, the
  // exact signals the Cost cell renders through — so a sub-cent priced cost that
  // displays `$0.00` is KNOWN, not rounded to 0 and mislabeled Unknown.
  const availabilitySignals = {
    estimatedCost: rawSummedCost,
    billingMode,
    ...substantiveCounts,
  };
  if (
    costFilterIncludesUnknown(costBuckets) &&
    matchesUnknownCost(availabilitySignals)
  ) {
    return true;
  }
  if (!sessionCostIsNumeric(availabilitySignals)) {
    return false;
  }
  // The numeric bucket boundary compares on the DB-precision-normalized value so
  // sub-cent float drift can't misplace a session at a bucket edge relative to
  // the cloud Decimal column.
  const normalizedCost =
    Math.round(rawSummedCost * COST_NORMALIZATION_FACTOR) /
    COST_NORMALIZATION_FACTOR;
  return costBuckets.some((bucketId) =>
    matchesCostBucket(normalizedCost, bucketId)
  );
}
