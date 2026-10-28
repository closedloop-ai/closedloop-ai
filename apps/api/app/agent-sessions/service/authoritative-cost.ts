import { canStoreAuthoritativeCostUsd } from "@repo/api/src/constants";
import type { Prisma } from "@repo/database";

/**
 * ISS-7229: what the session-detail response serves for
 * `authoritativeCostUsd`, read from `session_detail.authoritative_cost_usd`.
 *
 * The Desktop's OTel sync writes the column. Loops used to be a second producer
 * with a loop-event fallback read; ISS-12435 (PRD-795) removed Loops and
 * backfilled that fallback's figures into the column, so the column is the only
 * source.
 *
 * The stored value is re-validated so a figure past the column's width reads as
 * absent rather than as a number. A stored `0` is a reported zero and survives
 * as one. `undefined` (a select that omits the column) and `null` both mean no
 * figure.
 */
export function readStoredAuthoritativeCostUsd(
  storedCostUsd: Prisma.Decimal | null | undefined
): number | null {
  if (storedCostUsd == null) {
    return null;
  }
  const stored = storedCostUsd.toNumber();
  return canStoreAuthoritativeCostUsd(stored) ? stored : null;
}
