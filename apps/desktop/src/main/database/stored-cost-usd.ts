/**
 * @file stored-cost-usd.ts
 * @description ISS-7229 — the one place that turns a stored
 * `authoritative_cost_usd` into a number, for every reader that goes through the
 * raw-query path.
 *
 * It is shared rather than restated because the two readers that needed it
 * disagreed. `authoritativeCostPatch` (the sync payload) coerced with a bare
 * `Number(stored)`, and the re-sync heal pass first tested `typeof stored ===
 * "number"` — and the column does not arrive as either. The driver maps `REAL`
 * to a Prisma `Decimal`, so the `typeof` test reported every backfilled session
 * unusable, and `Number()` happened to work only because `Decimal` carries a
 * `valueOf`. One of those failed loudly in a test; the other would have shipped.
 *
 * ── Its relationship to `syncableCostUsd` ─────────────────────────────────────
 * `sync-source-session-analytics.ts` carries a near-twin, and marisolashgrove was
 * right on #6406 to point at it: the policy here is deliberately the same one —
 * `typeof` BEFORE the range test because `Number("")` is a confident `0`, and
 * the ceiling checked against the CANONICALIZED figure so the check and the
 * write cannot disagree in the seventh decimal.
 *
 * What this module adds, and the reason it is not simply a call to that one, is
 * the step before the policy: `syncableCostUsd` takes `number | null | undefined`
 * and its `typeof` gate therefore REJECTS the `Decimal` the raw-query path
 * actually hands back. Coercion has to happen first, and only the callers that
 * read through `$queryRawUnsafe` need it.
 *
 * The two ceilings stay two constants ON PURPOSE. `MAX_SESSION_ESTIMATED_COST_USD`
 * is read off `SessionDetail.estimatedCost` and `MAX_AUTHORITATIVE_COST_USD` off
 * `SessionDetail.authoritativeCostUsd`; both are `Decimal(14, 6)` today, so the
 * numbers coincide. Collapsing them would make a future width change to one
 * column silently move the other's limit, which is the opposite of what each
 * docstring says it is for.
 */
import { canStoreAuthoritativeCostUsd } from "@repo/api/src/constants";

/**
 * A stored cost as a number, or `null` when the column holds something that is
 * not one.
 *
 * Each shape the boundary can produce is NAMED. `bigint` and the numeric string
 * are not observed today but cost one branch each, and the alternative to naming
 * them is repeating the failure above the next time a driver or column type
 * moves. Anything unrecognised returns `null`: nothing here coerces an
 * unfamiliar value into a number, because a fabricated cost is worse than a
 * missing one.
 */
export function coerceStoredCostUsd(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    // `Number("")` is 0 — a blank column read as a measured zero is exactly the
    // fabricated figure this path exists to avoid.
    return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber: unknown }).toNumber === "function"
  ) {
    const parsed = (value as { toNumber: () => unknown }).toNumber();
    return typeof parsed === "number" && Number.isFinite(parsed)
      ? parsed
      : null;
  }
  return null;
}

/**
 * A stored cost this device is willing to publish, or `null`.
 *
 * Adds the two policy tests {@link coerceStoredCostUsd} deliberately leaves out:
 * a cost is never negative, and a figure past the cloud column's width cannot
 * land there. Refusing at the producer is what keeps an unpublishable figure out
 * of the payload in the first place, rather than relying on the receiver to drop
 * it — and a reported `0` survives both tests, because Claude charging nothing
 * is a measurement.
 */
export function publishableStoredCostUsd(value: unknown): number | null {
  const costUsd = coerceStoredCostUsd(value);
  if (
    costUsd === null ||
    costUsd < 0 ||
    !canStoreAuthoritativeCostUsd(costUsd)
  ) {
    return null;
  }
  return costUsd;
}
