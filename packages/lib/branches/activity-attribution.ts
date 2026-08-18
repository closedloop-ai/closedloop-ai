import type { BranchActivitySegment } from "@repo/api/src/types/branch";

/**
 * FEA-2276 — the SINGLE, Node-safe per-session activity-spend attribution kernel,
 * shared by BOTH branch read surfaces so they cannot compute divergent
 * per-activity spend (the web+desktop authenticated-parity requirement):
 *
 * - web/cloud   — `apps/api/app/branches/branch-read-service.ts` (getBranchDetail),
 *                 over `agent_session_activity_segments` + `agent_session_token_events`.
 * - desktop     — `apps/desktop/src/main/branch/shared-branches-api.ts`
 *                 (`toEnrichedBranchSession`), over the light-hydrated
 *                 `activitySegmentRows` + `tokenEvents` on the loaded session.
 *
 * It NEVER re-classifies or re-prices: each producer hands it the classifier's
 * raw span tiling (FEA-2269) and the already-priced per-turn spend events
 * (`token_events.cost_usd_estimated` / `AgentSessionTokenEvent.estimatedCost`),
 * and this kernel only JOINS spend to spans by timestamp — the PLN-1196 §4
 * attribution rule: each turn's instant falls in exactly one half-open
 * `[startMs, endMs)` window. Summed in integer micro-cents so per-segment totals
 * are exact (mirrors the desktop coverage attribution in
 * `apps/desktop/src/main/telemetry/attribution-metrics.ts` `attributeSegmentSpendUsd`,
 * which this generalizes to also carry tokens and emit the shared
 * `BranchActivitySegment` DTO).
 */

/** Micro-cents per USD (1 USD = 100 cents × 10_000 micro-cents). */
export const MICRO_CENTS_PER_USD = 1_000_000;

/**
 * Round a USD amount to integer micro-cents (the single rounding boundary).
 * Exported so the branch rollup shares ONE definition (no re-declared constant /
 * inlined round-trip) — grep-first, don't reimplement.
 */
export function usdToMicroCents(usd: number): number {
  return Math.round(usd * MICRO_CENTS_PER_USD);
}

/** Convert integer micro-cents back to USD. Shared with the branch rollup. */
export function microCentsToUsd(micro: number): number {
  return micro / MICRO_CENTS_PER_USD;
}

/**
 * A raw classifier span to attribute spend into — the taxonomy-agnostic subset of
 * `SyncedActivitySegmentRow` this kernel needs. `phase` is verbatim (bounded free
 * string). Half-open `[startMs, endMs)` in epoch-ms.
 */
export type ActivitySegmentSpan = {
  phase: string;
  startMs: number;
  endMs: number;
  confidence: number;
};

/**
 * A per-turn spend event: its instant, already-priced cost, and token counts.
 * `costUsd` is `null` when the turn/model did not price — its tokens still count
 * (real usage) but it contributes no cost, so an all-unpriced span stays `null`
 * (never coerced to 0).
 */
export type ActivitySpendEvent = {
  /** epoch-ms instant of the turn (`token_events.created_at` / `eventCreatedAt`). */
  tMs: number;
  /** Already-priced turn cost (USD); `null`/absent when the turn did not price. */
  costUsd: number | null;
  /** Exact evidence that priced cost existed before a lossy aggregate rounding. */
  positiveCostSignal?: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Stable persisted identity used to deduplicate repeated link projections. */
  sourceId?: string;
};

type SegmentAccumulator = {
  span: ActivitySegmentSpan;
  microCents: number;
  /** True once any covered event contributed a priced (non-null) cost. */
  anyPriced: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sourceEventIds: string[];
  costEvents: NonNullable<BranchActivitySegment["costEvents"]>[number][];
};

/** A span is renderable only with finite bounds and positive duration. */
function isValidSpan(span: ActivitySegmentSpan): boolean {
  return (
    Number.isFinite(span.startMs) &&
    Number.isFinite(span.endMs) &&
    span.endMs > span.startMs
  );
}

/**
 * Index of the FIRST span whose half-open `[startMs, endMs)` contains `tMs`, or
 * -1 when none does. The classifier tiles contiguously and non-overlapping, so
 * "first covering" is deterministic; a turn in a gap (no covering span) is
 * dropped here and surfaces as the branch rollup's `unattributed` residual.
 */
function spanIndexAt(
  spans: readonly SegmentAccumulator[],
  tMs: number
): number {
  if (!Number.isFinite(tMs)) {
    return -1;
  }
  for (let i = 0; i < spans.length; i += 1) {
    const { span } = spans[i];
    if (tMs >= span.startMs && tMs < span.endMs) {
      return i;
    }
  }
  return -1;
}

/**
 * Attribute a session's already-priced per-turn spend across its classifier
 * spans, producing the priced `BranchActivitySegment[]` the branch rollup folds.
 *
 * Malformed spans (non-finite bounds / non-positive duration) are dropped — never
 * positioned — so a corrupt row can't fabricate a slice. Returns segments in the
 * SAME order as the (valid) input spans. An empty `spans` array returns `[]`;
 * a session with genuinely no tiling should pass `[]` and the rollup routes its
 * whole spend to `unattributed`.
 */
export function attributeBranchSessionActivity(
  spans: readonly ActivitySegmentSpan[],
  events: readonly ActivitySpendEvent[]
): BranchActivitySegment[] {
  const accumulators: SegmentAccumulator[] = [];
  for (const span of spans) {
    if (isValidSpan(span)) {
      accumulators.push({
        span,
        microCents: 0,
        anyPriced: false,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        sourceEventIds: [],
        costEvents: [],
      });
    }
  }

  for (const event of events) {
    const index = spanIndexAt(accumulators, event.tMs);
    if (index < 0) {
      continue;
    }
    const acc = accumulators[index];
    acc.inputTokens += event.inputTokens;
    acc.outputTokens += event.outputTokens;
    acc.cacheReadTokens += event.cacheReadTokens ?? 0;
    acc.cacheWriteTokens += event.cacheWriteTokens ?? 0;
    if (event.sourceId) {
      acc.sourceEventIds.push(event.sourceId);
      if (
        event.costUsd !== null &&
        Number.isFinite(event.costUsd) &&
        event.costUsd >= 0
      ) {
        acc.costEvents.push({
          sourceEventId: event.sourceId,
          occurredAtMs: event.tMs,
          costUsd: event.costUsd,
        });
      }
    }
    if (event.costUsd != null && Number.isFinite(event.costUsd)) {
      acc.microCents += usdToMicroCents(event.costUsd);
      // Only a POSITIVE cost marks the span priced. The two surfaces represent an
      // unpriced turn asymmetrically — cloud's `estimatedCost` is a non-nullable
      // `@default(0)` Decimal (unpriced → 0), desktop's is nullable (unpriced →
      // null) — so keying `anyPriced` off "not null" would make an all-unpriced
      // span resolve to `0` on cloud but `null` on desktop, breaking the very
      // cross-surface parity this kernel exists to guarantee. Treating 0 as
      // "no priced signal" makes both surfaces symmetric (a genuinely $0.00 span
      // is indistinguishable from unpriced anyway, and `null` is the honest read).
      if (hasPositiveCostSignal(event)) {
        acc.anyPriced = true;
      }
    }
  }

  return accumulators.map((acc) => ({
    phase: acc.span.phase,
    startMs: acc.span.startMs,
    endMs: acc.span.endMs,
    costUsd: acc.anyPriced ? microCentsToUsd(acc.microCents) : null,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    ...(acc.sourceEventIds.length > 0
      ? { sourceEventIds: [...new Set(acc.sourceEventIds)].sort() }
      : {}),
    ...(acc.costEvents.length > 0
      ? {
          costEvents: [...acc.costEvents].sort(
            (left, right) =>
              left.occurredAtMs - right.occurredAtMs ||
              left.sourceEventId.localeCompare(right.sourceEventId)
          ),
        }
      : {}),
    confidence: acc.span.confidence,
  }));
}

function hasPositiveCostSignal(event: ActivitySpendEvent): boolean {
  return (
    (event.costUsd !== null && event.costUsd > 0) ||
    event.positiveCostSignal === true
  );
}
