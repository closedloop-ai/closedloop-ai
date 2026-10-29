/**
 * The per-request tallies of what the sync batch could not store (dropped
 * usage buckets, unstorable session counters), folded per slice and reported
 * once per batch by `upsertSessionsBatch`.
 */
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import type { UpsertSessionsContext } from "./records";
import { boundSampledIdentifier } from "./sampled-identifier";
import { SessionSyncMetric } from "./session-sync-metrics";

/**
 * ISS-8330: how many DISTINCT dropped component keys one request's warn may
 * name. `componentKey` arrives from the wire, so an unbounded key list is the
 * same caller-driven amplification the per-slice emission it replaced would
 * have been — the cap turns the excess into a count rather than more log.
 */
export const MAX_DROPPED_USAGE_KEYS_PER_SYNC_REQUEST = 20;

/**
 * Tally one slice's dropped usage buckets into the batch's tally.
 *
 * The cap admits no new KEY once the set is full but keeps counting every drop,
 * so truncation loses unseen component names rather than understating how much
 * of the request was dropped — the same shape `foldObservedRepositories` keeps
 * for the discovery cap.
 */
export function foldDroppedUsageBuckets(
  tally: { count: number; keys: Set<string> },
  componentKeys: readonly string[] | undefined
): void {
  for (const componentKey of componentKeys ?? []) {
    tally.count += 1;
    if (tally.keys.size < MAX_DROPPED_USAGE_KEYS_PER_SYNC_REQUEST) {
      tally.keys.add(boundSampledIdentifier(componentKey));
    }
  }
}

export type UnstorableCounterTally = {
  count: number;
  fields: Set<string>;
  sessionIds: string[];
};

/**
 * ISS-8881: accumulate the counter fields a slice could not store.
 *
 * `fields` is uncapped on purpose — the key space is CLOSED (the seven
 * table-qualified names this code owns), so unlike `droppedUsageTally.keys` it
 * cannot be grown by a caller. `sessionIds` IS caller-driven, so it is bounded
 * twice, exactly as the dropped-bucket keys are: in CARDINALITY by
 * `MAX_DROPPED_USAGE_KEYS_PER_SYNC_REQUEST`, and in SIZE by
 * `boundSampledIdentifier`. The count cap alone bounds no bytes.
 */
export function foldUnstorableCounters(
  tally: UnstorableCounterTally,
  fields: readonly string[] | undefined,
  externalSessionId: string
): void {
  if (!fields || fields.length === 0) {
    return;
  }
  for (const field of fields) {
    tally.count += 1;
    tally.fields.add(field);
  }
  if (tally.sessionIds.length < MAX_DROPPED_USAGE_KEYS_PER_SYNC_REQUEST) {
    tally.sessionIds.push(boundSampledIdentifier(externalSessionId));
  }
}

/**
 * ISS-8881: report the session counters this request could not store, once.
 *
 * The field was OMITTED from its write rather than clamped, because a stored
 * ceiling value is indistinguishable from a real count (#6370). For the two
 * nullable `SessionDetail` columns that leaves the previous value in place; for
 * the usage rollup, whose five counters are `Int @default(0)`, a row that would
 * have been CREATED is withheld entirely rather than written with a fabricated
 * zero. Either way something a payload claimed is not on the row, so it is
 * stated here rather than swallowed.
 *
 * Each name is TABLE-QUALIFIED (`sessionDetail.turns`, `usageRollup.eventCount`)
 * because those two outcomes are not the same loss and a bare column name cannot
 * tell them apart — see `UNSTORABLE_ROLLUP_FIELD_PREFIX`.
 *
 * Silent when nothing was dropped, so the metric measures the defect rather
 * than sync traffic. In the `finally` with its neighbours so a batch that threw
 * part-way still reports what its committed slices dropped.
 *
 * NOT ALERTABLE on its own — adding a metric name does not create a Datadog
 * monitor; see the header of `service/session-sync-metrics.ts`.
 */
export function reportUnstorableCounters(
  context: UpsertSessionsContext,
  tally: UnstorableCounterTally
): void {
  if (tally.count === 0) {
    return;
  }
  log.warn("Dropped session counters that int4 columns cannot hold", {
    computeTargetId: context.computeTargetId,
    droppedCount: tally.count,
    fields: [...tally.fields],
    organizationId: context.organizationId,
    sessionIds: tally.sessionIds,
  });
  emitTelemetryMetric({
    metric: SessionSyncMetric.UnstorableCounterDropped,
    organizationId: context.organizationId,
    computeTargetId: context.computeTargetId,
    count: tally.count,
  });
}

/**
 * ISS-8330: report the usage buckets this request dropped, once.
 *
 * A bucket whose count cannot be stored in `int4` is dropped rather than clamped,
 * because a stored `PR_INT_MAX` is indistinguishable from a real count and
 * these columns are `_sum`-ed into org rollups. That leaves a hole — the row is
 * absent, and nothing downstream can tell it from a component that was never
 * used — so the drop is stated here rather than swallowed.
 *
 * Silent when nothing was dropped, so the metric measures the defect rather
 * than sync traffic. In the `finally` with its neighbours so a batch that threw
 * part-way still reports what its committed slices dropped.
 *
 * NOT ALERTABLE on its own — adding a metric name does not create a Datadog
 * monitor; see the header of `service/session-sync-metrics.ts`.
 */
export function reportDroppedUsageBuckets(
  context: UpsertSessionsContext,
  tally: { count: number; keys: Set<string> }
): void {
  if (tally.count === 0) {
    return;
  }
  log.warn("Dropped component usage buckets that overflowed int4", {
    componentKeys: [...tally.keys],
    computeTargetId: context.computeTargetId,
    droppedCount: tally.count,
    organizationId: context.organizationId,
  });
  emitTelemetryMetric({
    metric: SessionSyncMetric.UsageCountOverflowDropped,
    organizationId: context.organizationId,
    computeTargetId: context.computeTargetId,
    count: tally.count,
  });
}
