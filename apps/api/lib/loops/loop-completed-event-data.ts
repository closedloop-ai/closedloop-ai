/**
 * @file loop-completed-event-data.ts
 * @description Builds the `data` payload a completed loop event is persisted
 * with in `loop_events.data`, including the `usageReconciliation` block's last
 * validation gate (PRD-538).
 *
 * That gate matters because the events route calls `validateNormalizedEvent`,
 * which only reports whether the payload validated and then discards
 * `safeParse().data` — so what reaches the orchestrator is still the raw nested
 * object the runner posted, unknown keys and all. Re-parsing here means the
 * persisted row is the schema's output, not the wire's input.
 *
 * Kept out of `loop-orchestrator.ts` on purpose: that file is over the 1,000
 * line ceiling and grandfathered shrink-only, so new logic lands in a sibling.
 */
import type { LoopEventCompleted } from "@closedloop-ai/loops-api/events";
import {
  type LoopUsageReconciliation,
  LoopUsageReconciliationSchema,
} from "@closedloop-ai/loops-api/events";

/**
 * Assemble the row payload for a completed loop event.
 *
 * Every optional field is OMITTED rather than nulled when absent, so a
 * historical read of an old row and a new one differ only by the keys that were
 * genuinely present.
 */
export function buildCompletedEventData(
  event: LoopEventCompleted
): Record<string, unknown> {
  const usageReconciliation = parseUsageReconciliationForPersistence(
    event.usageReconciliation
  );
  return {
    result: event.result,
    tokensUsed: event.tokensUsed ?? null,
    timestamp: event.timestamp,
    ...(event.results ? { results: event.results } : {}),
    ...(usageReconciliation ? { usageReconciliation } : {}),
  };
}

/**
 * Parse the reconciliation block for persistence, or return null when there is
 * nothing trustworthy to store.
 *
 * Valid-or-absent, never partially-corrupt. `LoopUsageReconciliationSchema`
 * already drops an individual corrupt `harness*` aggregate via `.catch`, so a
 * failure here means a load-bearing field (provenance, reconciliation status, a
 * headline cost) was itself invalid. Returning null omits the whole block
 * rather than persisting accounting we cannot stand behind, and rather than
 * failing the completion the block rides on.
 *
 * Returning the schema's output (not the input) also strips unknown keys, so a
 * newer desktop build's extra fields cannot land unvalidated in the row.
 */
function parseUsageReconciliationForPersistence(
  value: unknown
): LoopUsageReconciliation | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = LoopUsageReconciliationSchema.safeParse(value);
  return parsed.success ? withoutUndefinedValues(parsed.data) : null;
}

/**
 * Drop keys whose value is `undefined`.
 *
 * Zod's `.catch(undefined)` leaves a dropped aggregate as an OWN key holding
 * `undefined` rather than removing it. `JSON.stringify` would hide that, but
 * this object is handed to Prisma as a JSON column value, and an explicit
 * `undefined` in that position is exactly the ambiguity the cross-repo rule
 * warns about: absent must stay absent, never become a stored `null`. Deleting
 * the key makes omission the literal shape we persist.
 */
function withoutUndefinedValues(
  value: LoopUsageReconciliation
): LoopUsageReconciliation {
  const entries = Object.entries(value).filter(
    ([, fieldValue]) => fieldValue !== undefined
  );
  return Object.fromEntries(entries) as LoopUsageReconciliation;
}
