/**
 * @file component-index-key-telemetry.ts
 * @description ISS-8255 — the monitored event for a components-sync batch whose
 * index keys had to be projected, and the bound that keeps it from becoming an
 * amplification vector.
 *
 * WHY THIS LANE NEEDED THE BOUND (#7213 review, whitlockk). ISS-8736 bounded the
 * invocation lane and ISS-8255 bounded the transcript lane, but the component
 * fan-out kept emitting straight from an authenticated request path. The batch
 * IS the request, a desktop drives the request rate, and an over-budget key is
 * permanent from the cloud's side: the projection is accepted, the desktop is
 * never told to stop sending it, and nothing repairs the source value, so every
 * later re-sync of that inventory re-declares the same projection forever. Two
 * lanes bounded out of four is not what `apps/api/AGENTS.md` ("Emission and
 * Abuse Control") asks — it asks it of EVERY path an authenticated caller can
 * drive, which is why the bound lives beside the metric rather than beside
 * whichever emitter a reviewer happened to read.
 *
 * Its own module rather than another block in `service.ts`, which is already
 * near the file-size ceiling: the report is its own concern, and the sibling
 * `timestamp-floor-telemetry.ts` sets the same precedent for this directory.
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

export const COMPONENT_INDEX_KEY_PROJECTED_EVENT =
  "desktop_component_index_key_projected";

/**
 * The human-readable message every occurrence carries, kept beside the event
 * name so the log line stays readable to someone who is not querying by facet.
 */
export const COMPONENT_INDEX_KEY_PROJECTED_MESSAGE =
  "Projected desktop component index keys";

/** The tenant + caller one batch's projections are attributed to. */
export type ComponentIndexKeyScope = {
  organizationId: string;
  computeTargetId: string;
};

/**
 * This lane's instance of the shared org/reason choke point.
 *
 * Exported so tests can reset it between cases; production code must not reach
 * into it beyond {@link reportComponentIndexKeyProjections}.
 */
export const componentIndexKeyProjectionGate =
  new IndexKeyProjectionEmissionGate({
    reason: IndexKeyProjectionReason.Component,
    onRollup: (scope, occurrences, flushedBy) =>
      emitComponentIndexKeyRollup(scope, occurrences, flushedBy),
  });

/**
 * ISS-8069: report the inventory's projected index keys, once per batch, and
 * only when at least one bound — emitting on zero would measure traffic rather
 * than the trade-off.
 *
 * NEVER THROWS. Failing to REPORT a projection must not change what the sync
 * wrote; the keys are already projected and already committed when this runs.
 */
export function reportComponentIndexKeyProjections(
  context: Readonly<ComponentIndexKeyScope>,
  projectedCount: number
): void {
  if (projectedCount === 0) {
    return;
  }
  const scope: ComponentIndexKeyScope = {
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
  };
  try {
    if (!componentIndexKeyProjectionGate.record(scope, Date.now())) {
      return;
    }
    log.warn(COMPONENT_INDEX_KEY_PROJECTED_MESSAGE, {
      ...scope,
      event: COMPONENT_INDEX_KEY_PROJECTED_EVENT,
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
    log.warn("[desktop-components] Failed to report projected index keys", {
      event: COMPONENT_INDEX_KEY_PROJECTED_EVENT,
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
function emitComponentIndexKeyRollup(
  scope: { organizationId: string; computeTargetId?: string },
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(COMPONENT_INDEX_KEY_PROJECTED_MESSAGE, {
    ...scope,
    event: COMPONENT_INDEX_KEY_PROJECTED_EVENT,
    occurrences,
    aggregated: true,
    flushedBy,
  });
}
