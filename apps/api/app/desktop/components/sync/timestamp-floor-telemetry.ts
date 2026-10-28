/**
 * @file timestamp-floor-telemetry.ts
 * @description ISS-8735 — the monitored event for a components-sync batch that
 * had to degrade a timestamp below the Postgres floor, and the bound that keeps
 * it from becoming an amplification vector.
 *
 * WHY THIS IS THROTTLED (review: whitlockk, chatgpt-codex-connector). The batch IS
 * the request and an authenticated desktop drives the request rate, so one warn
 * per request is one warn per replay — and a poisoned component is permanent
 * from the cloud's side: the degrade is accepted, the desktop is never told to
 * stop sending it, and nothing repairs the source value. The batch therefore
 * re-declares the same degradation on every pass, forever. That is exactly the
 * per-request emission `apps/api/AGENTS.md` ("Emission and Abuse Control")
 * names, and collapsing it to one warn per request was only half the bound the
 * rule asks for.
 *
 * `FixedWindowEmissionThrottle` supplies the other half, and the keyspace bound
 * the root `AGENTS.md` requires of any caller-keyed map: at most one event per
 * (org, compute target) per window plus one aggregate rollup, over a hard
 * max-entry LRU cap.
 *
 * THE FIRST OCCURRENCE ALWAYS EMITS — a key with no live window emits before it
 * can suppress anything, so a genuinely new (org, target) degrade is never the
 * one the bound eats. The throttle only ever collapses REPETITION.
 *
 * Process-local per serverless instance, matching the sibling throttles
 * (`degraded-metadata-merge.ts`, `session-ingestion-policy-denied-throttle.ts`).
 */

import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";
import type { DegradedTimestampTally } from "./timestamp-floor";

export const COMPONENT_TIMESTAMP_DEGRADED_EVENT =
  "desktop_component_timestamp_degraded";

/**
 * The human-readable message the first occurrence carries, kept beside the event
 * name so the log line stays readable to someone who is not querying by facet.
 */
export const COMPONENT_TIMESTAMP_DEGRADED_MESSAGE =
  "Degraded desktop component timestamps below the Postgres floor";

/**
 * The amplification unit: one tenant is what a replay drives. The coarse budget
 * keys on this alone, so its rollup names the org and deliberately carries NO
 * `computeTargetId` — that total spans every target the org owns, and stamping
 * one would attribute it to whichever target happened to be last.
 */
export type DegradedComponentTimestampOrgScope = {
  organizationId: string;
};

/** The tenant + caller this degradation is attributed to. */
export type DegradedComponentTimestampScope =
  DegradedComponentTimestampOrgScope & {
    computeTargetId: string;
  };

/**
 * The per-compute-target dedupe. `computeTargetId` in the key correlates
 * repeated degrades from ONE desktop install, which is what an operator wants
 * to see named.
 *
 * Exported so tests can reset it between cases; production code must not reach
 * into it.
 */
export const degradedComponentTimestampThrottle =
  new FixedWindowEmissionThrottle<DegradedComponentTimestampScope>({
    onFlush: (scope, occurrences, cause) =>
      emitDegradedComponentTimestampRollup(scope, occurrences, cause),
  });

/**
 * How many degrade events ONE organization may emit per window, across every
 * compute target it owns.
 */
export const DEGRADED_COMPONENT_TIMESTAMP_ORG_BUDGET = 10;

/**
 * WHY A SECOND, COARSER THROTTLE (review: davetho).
 *
 * `computeTargetId` in the finer key is what makes that bound EVICTABLE THROUGH
 * RESOURCE CHURN: the keyspace holds at most
 * {@link FIXED_WINDOW_EMISSION_MAX_ENTRIES} keys, so an org cycling one more
 * compute target than that evicts each key before it is ever reused — every
 * request is then a first occurrence and the emission stream never closes.
 * Memory was bounded; log volume was not. The LRU caps RESIDENT KEYS, not
 * events.
 *
 * This budget is keyed on `organizationId` ALONE — no per-target component — so
 * nothing the caller varies can evict it, and it is consulted BEFORE the target
 * key so a spent budget short-circuits without touching the finer map at all.
 *
 * The two rollups do not double-count: an occurrence the budget refuses never
 * reaches the target throttle, so `sum(occurrences)` over both stays the true
 * number of degraded batches. The cost is that heavy traffic from ONE target can
 * spend an org's budget for the window; the suppressed count is still flushed,
 * so the monitor sees the volume, only not the identity of every target behind
 * it.
 *
 * Same two-tier shape as `synced-agent-roster-telemetry.ts` (#5209 review); the
 * engine is not reimplemented here.
 */
export const degradedComponentTimestampOrgBudget =
  new FixedWindowEmissionThrottle<DegradedComponentTimestampOrgScope>({
    maxPerWindow: DEGRADED_COMPONENT_TIMESTAMP_ORG_BUDGET,
    onFlush: (scope, occurrences, cause) =>
      emitDegradedComponentTimestampRollup(scope, occurrences, cause),
  });

/**
 * Raise the monitored event for a batch that degraded at least one timestamp.
 * Silent on an empty tally — this reports a degradation, so a `0` would be
 * traffic rather than signal.
 *
 * The tally's keys are the fixed `ComponentTimestampField` members and its
 * values are counts, so nothing here is component content.
 *
 * NEVER THROWS. A failure to REPORT the degradation must not also change what
 * the sync writes.
 */
export function reportDegradedComponentTimestamps(
  context: Readonly<DegradedComponentTimestampScope>,
  degraded: DegradedTimestampTally
): void {
  if (Object.keys(degraded).length === 0) {
    return;
  }
  const scope: DegradedComponentTimestampScope = {
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
  };
  const orgScope: DegradedComponentTimestampOrgScope = {
    organizationId: context.organizationId,
  };
  try {
    const now = Date.now();
    // The stable org budget goes FIRST, so churning `computeTargetId` cannot
    // bypass it by evicting the finer key before it is ever reused.
    const budget = degradedComponentTimestampOrgBudget.record(
      orgScope.organizationId,
      orgScope,
      now
    );
    if (budget.flushedSuppressedCount > 0) {
      emitDegradedComponentTimestampRollup(
        orgScope,
        budget.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    if (!budget.emit) {
      return;
    }
    const decision = degradedComponentTimestampThrottle.record(
      buildDegradedComponentTimestampKey(scope),
      scope,
      now
    );
    if (decision.flushedSuppressedCount > 0) {
      emitDegradedComponentTimestampRollup(
        scope,
        decision.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    if (decision.emit) {
      log.warn(COMPONENT_TIMESTAMP_DEGRADED_MESSAGE, {
        ...scope,
        event: COMPONENT_TIMESTAMP_DEGRADED_EVENT,
        degraded,
        occurrences: 1,
      });
    }
  } catch (error) {
    log.warn("[desktop-components] Failed to report degraded timestamps", {
      event: COMPONENT_TIMESTAMP_DEGRADED_EVENT,
      computeTargetId: scope.computeTargetId,
      error: parseError(error),
    });
  }
}

/** Composite-key delimiter. Both key parts are ids, so `|` cannot collide. */
const KEY_DELIMITER = "|";

function buildDegradedComponentTimestampKey(
  scope: DegradedComponentTimestampScope
): string {
  return [scope.organizationId, scope.computeTargetId].join(KEY_DELIMITER);
}

/**
 * The rollup for reports a closed window suppressed, emitted as ONE event
 * carrying their total so `sum(occurrences)` still tracks how often a degraded
 * batch landed. It deliberately omits `degraded` — the suppressed batches did
 * not necessarily poison the same fields, and a summed per-field tally would
 * report one recurring component once per pass — and carries `aggregated` so a
 * monitor can tell a rollup from a first occurrence.
 *
 * `flushedBy` is the CAUSE the throttle reported, never a constant this module
 * picks (the ISS-7360 lesson): stamping one literal would tell an operator the
 * key cap was hit when a quiet key was merely drained.
 */
function emitDegradedComponentTimestampRollup(
  scope: DegradedComponentTimestampOrgScope & { computeTargetId?: string },
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(COMPONENT_TIMESTAMP_DEGRADED_MESSAGE, {
    ...scope,
    event: COMPONENT_TIMESTAMP_DEGRADED_EVENT,
    occurrences,
    aggregated: true,
    flushedBy,
  });
}
