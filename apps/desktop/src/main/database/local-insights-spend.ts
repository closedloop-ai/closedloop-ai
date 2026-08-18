/**
 * Desktop-local spend-by-session-outcome aggregate (ISS-4463).
 *
 * Split out of `local-insights.ts` — which was over the file-size ceiling and
 * shrink-only at the time — rather than grown into it. The seam is a real
 * responsibility:
 * this module owns ONE chart's read and its cent allocation, and takes the
 * already-built window scope predicate rather than a `Range`, so it never has to
 * import the composition root back.
 */

import type { CategoryBucket } from "@closedloop-ai/loops-api/insights";
import {
  SPEND_OUTCOME_LABELS_WITH_RUNNING,
  SPEND_OUTCOME_ORDER_WITH_RUNNING,
  SpendOutcome,
} from "@closedloop-ai/loops-api/insights";
import type { DesktopPrisma } from "./prisma-client.js";

/** One pre-grouped (outcome, spend) row of the local scan. */
type OutcomeSpendRow = { outcome: string; value: number };

/**
 * USD spend for the window, split by the originating session's lifecycle
 * outcome.
 *
 * Computed locally rather than left absent so the desktop Labs toggle is honest
 * OFFLINE: without it, opting in on a signed-out desktop produced only empty
 * tiles even when local sessions had both spend and outcome data (codex, #4282).
 * It shares the Agents section's spend basis — `token_usage` over the same
 * window predicate as the model breakdown — so the two local charts describe the
 * same dollars, exactly as they do in the cloud.
 *
 * `ends_with_error` is NOT a terminality signal: the live hook and the import
 * writer both stamp a non-null 0/1 on ACTIVE rows. Terminality is therefore
 * decided by `ended_at`, so a running session's spend never receives an "ended"
 * verdict it has not reached.
 *
 * @param scopeSql the shared `FROM token_usage … WHERE started_at BETWEEN $1 AND $2`
 *   fragment, so this read cannot drift from the sibling spend queries' scope.
 * @param allocate the shared largest-remainder USD allocator, injected so the
 *   buckets conserve the period total using the same routine as every other
 *   local money breakdown.
 */
export async function computeLocalSpendByOutcome(
  prisma: DesktopPrisma,
  scopeSql: string,
  startIso: string,
  endIso: string,
  allocate: (values: Readonly<Record<string, number>>) => Record<string, number>
): Promise<CategoryBucket[]> {
  // ISS-5938: on the reader pool, not the writer-bound `prisma.client` — this is
  // a full-window aggregate over `token_usage ⋈ sessions`, the same class of read
  // as the model breakdown it shares a scope (and a card) with.
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<OutcomeSpendRow[]>(
      `SELECT scoped.outcome AS outcome,
            COALESCE(SUM(scoped.cost), 0) AS value
     FROM (
       SELECT CASE
                WHEN s.ended_at IS NULL THEN '${SpendOutcome.Running}'
                WHEN s.ends_with_error = 1 THEN '${SpendOutcome.Errored}'
                WHEN s.ends_with_error = 0 THEN '${SpendOutcome.Clean}'
                ELSE '${SpendOutcome.Unknown}'
              END AS outcome,
              t.cost_usd_estimated AS cost
       ${scopeSql}
     ) scoped
     GROUP BY scoped.outcome`,
      startIso,
      endIso
    )
  );

  // Allocated (not independently rounded) so the buckets conserve the period's
  // total spend to the cent, and always emitted in the shared order so an
  // outcome with no spend reads as a measured zero rather than an omission.
  const allocated = allocate(
    Object.fromEntries(
      SPEND_OUTCOME_ORDER_WITH_RUNNING.map((outcome) => [
        outcome,
        Number(rows.find((row) => row.outcome === outcome)?.value ?? 0),
      ])
    )
  );
  return SPEND_OUTCOME_ORDER_WITH_RUNNING.map((outcome) => ({
    key: outcome,
    label: SPEND_OUTCOME_LABELS_WITH_RUNNING[outcome],
    value: allocated[outcome] ?? 0,
  }));
}
