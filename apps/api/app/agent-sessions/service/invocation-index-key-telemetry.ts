/**
 * @file invocation-index-key-telemetry.ts
 * @description ISS-8736 — the monitored event for an invocation part whose
 * index keys had to be projected, and the bound that keeps it from becoming an
 * amplification vector.
 *
 * WHY THIS IS THROTTLED (review: chatgpt-codex-connector). The part IS the
 * request and an authenticated desktop drives the request rate, so one warn per
 * part is one warn per replay — and an over-budget key is permanent from the
 * cloud's side: the projection is accepted, the desktop is never told to stop
 * sending it, and nothing repairs the source value. Every later re-sync of that
 * session therefore re-declares the same projection, forever. That is exactly
 * the per-request emission `apps/api/AGENTS.md` ("Emission and Abuse Control")
 * names, and collapsing the per-ITEM tally to one warn per part was only half
 * the bound the rule asks for.
 *
 * WHERE THE ENGINE LIVES (ISS-8255). The two-tier bound was built here first and
 * now lives in `lib/index-key-projection-telemetry.ts`, because the transcript
 * lane needed the identical bound and a second copy of it is the SSOT drift this
 * repo keeps paying for. This lane constructs that shared gate with its own
 * reason and its own budget, so its behaviour is unchanged: the reason is a
 * constant per lane, so keying on (org, reason) partitions exactly as keying on
 * (org) did while this lane was the only emitter.
 *
 * Process-local per serverless instance, matching the sibling throttles
 * (`timestamp-floor-telemetry.ts`, `synced-agent-roster-telemetry.ts`).
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

export const INVOCATION_INDEX_KEY_PROJECTED_EVENT =
  "desktop_invocation_index_key_projected";

/**
 * The human-readable message every occurrence carries, kept beside the event
 * name so the log line stays readable to someone who is not querying by facet.
 */
export const INVOCATION_INDEX_KEY_PROJECTED_MESSAGE =
  "Projected agent component invocation index keys";

/**
 * The amplification unit: one tenant is what a replay drives. The coarse budget
 * keys on this alone, so its rollup names the org and deliberately carries NO
 * `computeTargetId` — that total spans every target the org owns, and stamping
 * one would attribute it to whichever target happened to be last.
 */
export type InvocationIndexKeyOrgScope = {
  organizationId: string;
};

/** The tenant + caller this projection is attributed to. */
export type InvocationIndexKeyScope = InvocationIndexKeyOrgScope & {
  computeTargetId: string;
};

/**
 * This lane's instance of the shared org/reason choke point.
 *
 * Exported so tests can reset it between cases; production code must not reach
 * into it.
 */
export const invocationIndexKeyProjectionGate =
  new IndexKeyProjectionEmissionGate({
    reason: IndexKeyProjectionReason.Invocation,
    onRollup: (scope, occurrences, cause) =>
      emitInvocationIndexKeyRollup(scope, occurrences, cause),
  });

/** The part a projection is attributed to, for the first-occurrence log line. */
export type InvocationIndexKeyPartContext = InvocationIndexKeyScope & {
  externalSessionId: string;
  externalGenerationId: string;
  partIndex: number;
};

/**
 * Raise the monitored event for a part that projected at least one index key.
 * Silent on a zero tally — this reports a projection, so a `0` would be traffic
 * rather than signal.
 *
 * `projectedCount` is a count of bound keys, never key content: an over-budget
 * value is unbounded caller input and must not reach a log line.
 *
 * NEVER THROWS. A failure to REPORT the projection must not also change what
 * the ingest wrote — the part is already committed when this runs.
 */
export function reportInvocationIndexKeyProjections(
  context: Readonly<InvocationIndexKeyPartContext>,
  projectedCount: number
): void {
  if (projectedCount === 0) {
    return;
  }
  const scope: InvocationIndexKeyScope = {
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
  };
  try {
    if (!invocationIndexKeyProjectionGate.record(scope, Date.now())) {
      return;
    }
    log.warn(INVOCATION_INDEX_KEY_PROJECTED_MESSAGE, {
      ...scope,
      event: INVOCATION_INDEX_KEY_PROJECTED_EVENT,
      externalSessionId: context.externalSessionId,
      externalGenerationId: context.externalGenerationId,
      partIndex: context.partIndex,
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
      event: INVOCATION_INDEX_KEY_PROJECTED_EVENT,
      computeTargetId: scope.computeTargetId,
      error: parseError(error),
    });
  }
}

/**
 * The rollup for reports a closed window suppressed, emitted as ONE event
 * carrying their total so `sum(occurrences)` still tracks how often a part
 * landed projected. It deliberately omits `projectedCount` — the suppressed
 * parts did not necessarily project the same number of keys, and a summed tally
 * would report one recurring session once per pass — and carries `aggregated`
 * so a monitor can tell a rollup from a first occurrence.
 *
 * It also raises no `INDEX_KEY_PROJECTED_METRIC`: that metric's `count` means
 * KEYS BOUND on one part, and an occurrence total is a different quantity that
 * would corrupt the cross-lane tally if summed into the same field.
 *
 * `flushedBy` is the CAUSE the throttle reported, never a constant this module
 * picks (the ISS-7360 lesson): stamping one literal would tell an operator the
 * key cap was hit when a quiet key was merely drained.
 */
function emitInvocationIndexKeyRollup(
  scope: InvocationIndexKeyOrgScope & { computeTargetId?: string },
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(INVOCATION_INDEX_KEY_PROJECTED_MESSAGE, {
    ...scope,
    event: INVOCATION_INDEX_KEY_PROJECTED_EVENT,
    occurrences,
    aggregated: true,
    flushedBy,
  });
}
