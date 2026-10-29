/**
 * @file row-level-ack-contract-telemetry.ts
 * @description ISS-8622 — the producer-band counter for sync requests that
 * arrived WITHOUT `wantsAcceptedSessionIds`, and the bound that keeps it from
 * being an amplification vector.
 *
 * It lives beside `upsert-sessions-batch.ts` rather than inside it for the same
 * reason `activity-tiling-strip.ts` and `synced-agent-roster-telemetry.ts` do:
 * a throttle is process-lifetime state a test has to be able to reset, and the
 * batch module is already at the file-size ceiling the root `AGENTS.md` sets.
 *
 * WHY THIS IS THROTTLED (#7410 review, whitlockk and tamsinb, independently).
 * Per-batch is the wrong unit to stop at, and this emission is the one in the
 * ingest that makes that obvious: every neighbour here reports an ANOMALY, so
 * per-batch already means per-anomaly, while this one fires on a NORMAL,
 * expected request. A legacy build is legacy on every pass, so the un-throttled
 * shape is one `log.info` per sync per legacy target for the whole migration
 * window — a busy target ticks at 5s, and the route's rate limiter would permit
 * 120/min. That is the per-request amplification `apps/api/AGENTS.md`
 * ("Emission and Abuse Control") names, and being expected rather than
 * exceptional is not an exemption from it: `cron-invocation-accepted-throttle`
 * folds an ACCEPTANCE heartbeat on exactly these terms.
 *
 * WHAT THE THROTTLE BUYS BEYOND VOLUME — the reason it is not merely noise
 * reduction. {@link SessionSyncMetric.RowLevelAckNotRequested} used to instruct
 * its dashboard to COUNT DISTINCT `computeTargetId`, because the question is
 * how many legacy TARGETS remain, not how many requests they sent. Keyed on
 * (org, target) with a budget of one, the throttle emits at most one
 * `count: 1` record per target per window, and folds the repeats into a rollup
 * that carries `occurrences` and no `count` — so a bucketed `sum(count)` IS the
 * distinct-target reading, and the instruction became a property. An instruction
 * only binds the consumer that read it; a property binds every consumer. What
 * the bucket has to be, and why a range sum is not the same reading, are on the
 * metric.
 *
 * `FixedWindowEmissionThrottle` supplies both bounds: at most one event per
 * (org, compute target) per window plus one aggregate rollup, and a hard
 * max-entry LRU cap on the keyspace, since an unbounded map would only trade a
 * log leak for a memory leak (root `AGENTS.md`). The keyspace needs no second,
 * coarser budget the way `corruptAgentRosterThrottle` does: a compute target
 * must already exist under the organization for the ingest to run at all, so it
 * is bounded by (orgs × their real targets) and nothing a caller varies within
 * a request can grow it.
 *
 * THE FIRST OCCURRENCE ALWAYS EMITS. A key with no live window emits before it
 * can suppress anything, so a target that has just appeared in the legacy band
 * is never the one the bound eats — the throttle only ever collapses REPETITION,
 * which is what the fleet-upgrade signal has too much of.
 *
 * WHAT `sum(occurrences)` IS WORTH (the #5508 lesson). A suppressed count is
 * materialised by an event, never by a clock: the next legacy request on the
 * SAME key rolling its window over, or an LRU eviction. Nothing wires
 * `drainExpired` to a terminal path here — matching `activity-tiling-strip.ts`
 * — so a burst followed by quiet stays pending in process memory and a
 * serverless instance that freezes first loses its terminal window. Read the
 * sum as an eventual lower bound, not a total. The reading that gates
 * PRD-699 §8.3 does not depend on it: that one is "did any record appear for
 * this target in this window", which the first occurrence alone answers.
 */

import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";
import { SessionSyncMetric } from "./session-sync-metrics";

/**
 * The STABLE emission key: what an operator would act on, with no per-request
 * component. `sessionCount` deliberately stays OUT of it — it varies per
 * request, so keying on it would give every batch its own window and throttle
 * nothing.
 */
type LegacyAckScope = {
  organizationId: string;
  computeTargetId: string;
};

/** Composite-key delimiter. Both key parts are ids, so `|` cannot collide. */
const KEY_DELIMITER = "|";

/**
 * Process-local per serverless instance, matching the sibling throttles.
 * Exported so tests can reset it between cases; production code must not reach
 * into it.
 */
export const legacyAckContractThrottle =
  new FixedWindowEmissionThrottle<LegacyAckScope>({
    onFlush: (scope, occurrences, cause) =>
      emitLegacyAckRollup(scope, occurrences, cause),
  });

/**
 * Report a sync request that did not ask for the row-level ack echo.
 *
 * Emitted only for the legacy shape. A request that DID ask is the intended
 * steady state and has nothing to describe, so counting it would make the metric
 * measure sync traffic — the bound `reportRuntimeBudgetDeferral` and
 * `ObservedRepositoryRecorded` keep. What a non-zero rate means, and what it
 * gates, are on {@link SessionSyncMetric.RowLevelAckNotRequested}.
 *
 * NEVER THROWS. It runs ahead of `assertHoldExpressible`, which rejects a
 * legacy batch carrying a held revision — a failure to REPORT the producer band
 * must not replace that rejection, or suppress it.
 */
export function reportRowLevelAckNotRequested(
  context: Readonly<LegacyAckScope>,
  rowLevelAck: boolean,
  sessionCount: number
): void {
  if (rowLevelAck) {
    return;
  }
  const scope: LegacyAckScope = {
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
  };
  try {
    const decision = legacyAckContractThrottle.record(
      buildLegacyAckKey(scope),
      scope,
      Date.now()
    );
    if (decision.flushedSuppressedCount > 0) {
      emitLegacyAckRollup(
        scope,
        decision.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    if (decision.emit) {
      emitTelemetryMetric({
        metric: SessionSyncMetric.RowLevelAckNotRequested,
        organizationId: scope.organizationId,
        computeTargetId: scope.computeTargetId,
        count: 1,
        sessionCount,
      });
    }
  } catch (error) {
    log.warn("[agent-sessions] Failed to report the legacy ack contract", {
      metric: SessionSyncMetric.RowLevelAckNotRequested,
      computeTargetId: scope.computeTargetId,
      error: parseError(error),
    });
  }
}

function buildLegacyAckKey(scope: LegacyAckScope): string {
  return [scope.organizationId, scope.computeTargetId].join(KEY_DELIMITER);
}

/**
 * The legacy requests one closed window suppressed, emitted as ONE record
 * carrying their total so `sum(occurrences)` still tracks how often a legacy
 * producer synced.
 *
 * Deliberately carries NO `count` — that field is what a first occurrence
 * stamps `1` on, and it is the field the distinct-target reading sums. Putting
 * a suppressed total there would make one busy target read as many, which is
 * the exact confusion this throttle exists to remove. Same separation
 * `emitComparisonLatencyRollup` keeps, for the same reason.
 *
 * It omits `sessionCount` too — the suppressed requests did not carry the same
 * sessions, and a desktop re-sends a session until it is acked, so a summed
 * count would report one stuck session once per retry. `sessionCount` is the
 * exposure ONE whole-batch ack covers, which is a per-request reading with no
 * meaning aggregated.
 *
 * `flushedBy` is the CAUSE the throttle reported, never a constant this module
 * picks (the ISS-7360 lesson): stamping one literal would tell an operator the
 * keyspace cap was hit when a quiet key was merely rolled over.
 */
function emitLegacyAckRollup(
  scope: LegacyAckScope,
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  emitTelemetryMetric({
    metric: SessionSyncMetric.RowLevelAckNotRequested,
    organizationId: scope.organizationId,
    computeTargetId: scope.computeTargetId,
    occurrences,
    aggregated: true,
    flushedBy,
  });
}
