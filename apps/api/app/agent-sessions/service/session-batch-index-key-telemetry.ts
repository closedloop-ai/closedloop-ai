/**
 * @file session-batch-index-key-telemetry.ts
 * @description ISS-8255 — the monitored event for a session-sync batch whose
 * index keys had to be projected, and the bound that keeps it from becoming an
 * amplification vector.
 *
 * WHY THIS LANE NEEDED THE BOUND (#7213 review, whitlockk). ISS-8736 bounded the
 * invocation lane and ISS-8255 bounded the transcript lane, but the session
 * batch kept emitting straight from an authenticated request path. Collapsing
 * the per-ROW tally to one event per batch — which `upsertSessionsBatch`
 * already did — bounds the emission by PAYLOAD SIZE, not by request rate: the
 * batch is still the request, `payload.sessions` is caller-supplied under a
 * per-minute limit, and an over-budget key is permanent from the cloud's side,
 * so every later re-sync of that session re-declares the same projection
 * forever. That is the half of `apps/api/AGENTS.md` ("Emission and Abuse
 * Control") a per-batch collapse does not reach.
 *
 * Its own module rather than another block in `upsert-sessions-batch.ts`, which
 * is over the file-size ceiling's smell threshold and may only shrink: the
 * report is its own concern, and it joins the sibling telemetry modules this
 * directory already keeps (`status-fold-telemetry.ts`,
 * `degraded-metadata-merge.ts`).
 *
 * Process-local per serverless instance, like every sibling throttle here.
 */

import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { INDEX_KEY_PROJECTED_METRIC } from "@/lib/index-key-projection";
import {
  IndexKeyProjectionEmissionGate,
  IndexKeyProjectionReason,
} from "@/lib/index-key-projection-telemetry";
import type { EmissionRollupCause } from "@/lib/observability/fixed-window-emission-throttle";

export const SESSION_BATCH_INDEX_KEY_PROJECTED_EVENT =
  "desktop_session_batch_index_key_projected";

/**
 * The human-readable message every occurrence carries, kept beside the event
 * name so the log line stays readable to someone who is not querying by facet.
 */
export const SESSION_BATCH_INDEX_KEY_PROJECTED_MESSAGE =
  "Projected desktop agent session index keys";

/** The tenant + caller one batch's projections are attributed to. */
export type SessionBatchIndexKeyScope = {
  organizationId: string;
  computeTargetId: string;
};

/**
 * This lane's instance of the shared org/reason choke point.
 *
 * Exported so tests can reset it between cases; production code must not reach
 * into it beyond {@link reportSessionBatchIndexKeyProjections}.
 */
export const sessionBatchIndexKeyProjectionGate =
  new IndexKeyProjectionEmissionGate({
    reason: IndexKeyProjectionReason.SessionBatch,
    onRollup: (scope, occurrences, flushedBy) =>
      emitSessionBatchIndexKeyRollup(scope, occurrences, flushedBy),
  });

/**
 * ISS-8069: report the batch's projected index keys, once per batch, and only
 * when at least one bound.
 *
 * Emitting on zero would make this measure traffic rather than the trade-off it
 * describes. What a non-zero value MEANS: a producer is sending a value on an
 * INDEXED column that no legitimate harness, model, repository name, content
 * hash or session id could be, and the stored key is a lossy projection of it.
 * The actionable response is to find the producer, not to repair rows.
 *
 * NEVER THROWS. Failing to REPORT a projection must not change what the batch
 * wrote; the keys are already projected and already committed when this runs.
 */
export function reportSessionBatchIndexKeyProjections(
  context: Readonly<SessionBatchIndexKeyScope>,
  projectedCount: number
): void {
  if (projectedCount === 0) {
    return;
  }
  const scope: SessionBatchIndexKeyScope = {
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
  };
  try {
    if (!sessionBatchIndexKeyProjectionGate.record(scope, Date.now())) {
      return;
    }
    log.warn(SESSION_BATCH_INDEX_KEY_PROJECTED_MESSAGE, {
      ...scope,
      event: SESSION_BATCH_INDEX_KEY_PROJECTED_EVENT,
      projectedCount,
      occurrences: 1,
    });
    emitTelemetryMetric({
      metric: INDEX_KEY_PROJECTED_METRIC,
      organizationId: scope.organizationId,
      computeTargetId: scope.computeTargetId,
      count: projectedCount,
    });
  } catch (error) {
    log.warn("[agent-sessions] Failed to report projected index keys", {
      event: SESSION_BATCH_INDEX_KEY_PROJECTED_EVENT,
      computeTargetId: scope.computeTargetId,
      error: parseError(error),
    });
  }
}

/**
 * The rollup for reports a closed window suppressed, emitted as ONE event
 * carrying their total so `sum(occurrences)` still tracks how often a batch
 * landed projected. It deliberately omits `projectedCount` — the suppressed
 * batches did not necessarily bind the same number of keys — and carries
 * `aggregated` so a monitor can tell a rollup from a first occurrence.
 *
 * It raises no {@link INDEX_KEY_PROJECTED_METRIC}: that metric's `count` means
 * KEYS BOUND in one batch, and an occurrence total is a different quantity that
 * would corrupt the cross-lane tally if summed into the same field.
 *
 * `flushedBy` is the CAUSE the throttle reported, never a constant this module
 * picks (the ISS-7360 lesson): stamping one literal would tell an operator the
 * key cap was hit when a quiet key was merely drained.
 */
function emitSessionBatchIndexKeyRollup(
  scope: { organizationId: string; computeTargetId?: string },
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(SESSION_BATCH_INDEX_KEY_PROJECTED_MESSAGE, {
    ...scope,
    event: SESSION_BATCH_INDEX_KEY_PROJECTED_EVENT,
    occurrences,
    aggregated: true,
    flushedBy,
  });
}
