/**
 * @file usage-reconciliation-event.ts
 * @description Composes the authoritative-capture + reconciliation primitives
 * into the additive fields the loop-completion event carries to the cloud
 * (PRD-538). Kept separate from `loop-finalizer.ts` so the composition is unit
 * testable without the finalizer's I/O and network deps.
 *
 * `derivedCostUsd` is computed with the Claude-Code PARITY engine
 * (`computeHarnessCost`). The live-hook stdout stream emits one assistant event
 * per message (not per content block, unlike the persistent transcript), so the
 * per-model sums are already dedup-correct and need no dedup pass here.
 */
import { computeHarnessCost } from "@repo/cost/harness-cost-parity";
import {
  detectSessionOrigin,
  type HarnessPermissionDenial,
  type HarnessResult,
  type ModelTokenUsage,
  type SessionOrigin,
} from "./token-usage.js";
import {
  type ReconciliationResult,
  reconcileSessionCost,
} from "./usage-reconciliation.js";

export type UsageReconciliationFields = {
  /** Deterministic provenance from result-envelope presence. */
  sessionOrigin: SessionOrigin;
  /** Claude Code's authoritative `result.total_cost_usd`, or null. */
  authoritativeCostUsd: number | null;
  /** Our genai-prices/parity-derived total, or null when unpriced. */
  derivedCostUsd: number | null;
  reconciliation: ReconciliationResult;
  harnessNumTurns: number | null;
  harnessDurationMs: number | null;
  /** Time spent inside API calls, as reported by the envelope. */
  harnessDurationApiMs: number | null;
  harnessStopReason: string | null;
  /** Session-total token usage straight from the envelope, or null. */
  harnessUsage: HarnessResult["usage"];
  /**
   * Per-model breakdown from the envelope. `null` when there is no envelope at
   * all — distinct from `{}`, which means the envelope carried no per-model
   * data. A persistent transcript must not report an empty breakdown as if the
   * harness had answered "no models".
   */
  harnessModelUsage: HarnessResult["modelUsage"] | null;
  /** See {@link HarnessResult.permissionDenials}: null is unknown, [] is none. */
  harnessPermissionDenials: HarnessPermissionDenial[] | null;
};

/**
 * Sum the parity-engine cost across a per-model token map. Returns null when no
 * model could be priced (so reconciliation reports `drifted`/`unavailable`
 * rather than a misleading $0).
 */
export function computeDerivedCostUsd(
  tokensByModel: Record<string, ModelTokenUsage>
): number | null {
  let total = 0;
  let anyPriced = false;
  for (const [model, counts] of Object.entries(tokensByModel)) {
    const result = computeHarnessCost({
      model,
      inputTokens: counts.input,
      outputTokens: counts.output,
      cacheReadTokens: counts.cacheRead,
      cacheWriteTokens: counts.cacheCreation,
    });
    if (result.priced && result.costUsd !== null) {
      total += result.costUsd;
      anyPriced = true;
    }
  }
  return anyPriced ? total : null;
}

/**
 * Build the additive usage-reconciliation fields for a completed loop from the
 * (optional) authoritative result envelope and the session's per-model token
 * totals.
 */
export function buildUsageReconciliation(
  harnessResult: HarnessResult | null,
  tokensByModel: Record<string, ModelTokenUsage>
): UsageReconciliationFields {
  const derivedCostUsd = computeDerivedCostUsd(tokensByModel);
  const authoritativeCostUsd = harnessResult?.totalCostUsd ?? null;
  return {
    sessionOrigin: detectSessionOrigin(harnessResult),
    authoritativeCostUsd,
    derivedCostUsd,
    reconciliation: reconcileSessionCost({
      derivedCostUsd,
      authoritativeCostUsd,
    }),
    harnessNumTurns: harnessResult?.numTurns ?? null,
    harnessDurationMs: harnessResult?.durationMs ?? null,
    harnessDurationApiMs: harnessResult?.durationApiMs ?? null,
    harnessStopReason: harnessResult?.stopReason ?? null,
    harnessUsage: harnessResult?.usage ?? null,
    harnessModelUsage: harnessResult?.modelUsage ?? null,
    harnessPermissionDenials: harnessResult?.permissionDenials ?? null,
  };
}

/**
 * Project the reconciliation fields into the `usageReconciliation` object the
 * completed loop event carries to the cloud.
 *
 * The seven fields shipped by PRD-538 PR1 keep their existing serialization
 * exactly — always present, `null` when absent — because consumers already read
 * them at that shape. The fields added here are NEW optional wire keys, so they
 * follow the cross-repo rule instead: an absent value is OMITTED rather than
 * serialized as `null`, so an older API build sees the same payload it sees
 * today. Callers must not re-add them as explicit nulls.
 */
export function toCompletedEventUsageReconciliation(
  fields: UsageReconciliationFields
): Record<string, unknown> {
  return {
    sessionOrigin: fields.sessionOrigin,
    authoritativeCostUsd: fields.authoritativeCostUsd,
    derivedCostUsd: fields.derivedCostUsd,
    reconciliationStatus: fields.reconciliation.status,
    reconciliationDeltaUsd: fields.reconciliation.deltaUsd,
    harnessNumTurns: fields.harnessNumTurns,
    harnessDurationMs: fields.harnessDurationMs,
    ...(fields.harnessDurationApiMs === null
      ? {}
      : { harnessDurationApiMs: fields.harnessDurationApiMs }),
    ...(fields.harnessStopReason === null
      ? {}
      : { harnessStopReason: fields.harnessStopReason }),
    ...(fields.harnessUsage === null
      ? {}
      : { harnessUsage: fields.harnessUsage }),
    ...(fields.harnessModelUsage === null
      ? {}
      : { harnessModelUsage: fields.harnessModelUsage }),
    ...(fields.harnessPermissionDenials === null
      ? {}
      : { harnessPermissionDenials: fields.harnessPermissionDenials }),
  };
}
