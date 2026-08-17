/**
 * @file parse-cloud-read-readiness.ts
 * @description ISS-5768 (wongk review on #4809): validate the readiness
 * snapshot at the IPC boundary before the whole-app backlog is derived from it.
 *
 * WHY THIS EXISTS. `getRuntimeStatus()` is typed `Promise<unknown>`
 * (`desktop-api.d.ts`), and the renderer's shared 1s poll fans one payload out
 * to every status hook in a single loop. Handing an unvalidated
 * `cloudReadReadiness` straight to `resolveCloudSyncBacklog` meant any object at
 * all was treated as a full snapshot: a partial or version-skewed
 * `{ cloudReadReadiness: {} }` reached `snapshot.lanes.length` and THREW, which
 *
 *   1. aborted the fan-out loop, so every listener after this one never saw the
 *      payload at all, and
 *   2. was swallowed by the poller's own `.catch()`, so the failure was silent —
 *      leaving the last good value cached and a History Sync cell frozen on
 *      "Up to date" while the app could no longer measure anything.
 *
 * A stale completeness claim surviving a failed read is the same defect this
 * ticket exists to fix, one layer down. Anything that does not validate becomes
 * the `unknown` backlog, which renders as "Checking…" and can never render as
 * "Up to date".
 *
 * ON THE CLOSED `lane` / `state` UNIONS. Both are pinned to the burn-down's own
 * vocabulary, so a snapshot naming a lane this build has never heard of is
 * rejected as a whole and answers `unknown`. That under-claims rather than
 * over-claims — it can never turn owed work into "Up to date" — and main and
 * renderer ship in one Electron build, so the case is a dev/partial install, not
 * a shipped skew. The aggregate's "a lane added later is counted by default"
 * property is unaffected in-process: `cloudReadLaneOwesWork` still enumerates
 * nothing, and once both ends ship together the new lane validates and counts.
 */

import { z } from "zod";
import { CloudReadLaneNotApplicableReason } from "../../shared/cloud-read-lane-applicability";
import type {
  CloudReadLaneReadiness,
  CloudReadReadinessSnapshot,
  CloudSyncBacklog,
  ResolveCloudSyncBacklogOptions,
} from "../../shared/cloud-read-readiness-contract";
import { resolveCloudSyncBacklog } from "../../shared/cloud-read-readiness-contract";
import {
  classifyLaneDrainState,
  SYNC_LANE_IDS,
  SyncLaneDrainState,
  SyncLaneId,
} from "../../shared/sync-burndown-contract";

/** A count the payload may carry: finite, whole, and never negative. */
const countSchema = z.number().int().nonnegative();

/**
 * Derived from the const objects themselves, so a lane or drain state added to
 * the burn-down vocabulary is accepted here without a second edit.
 *
 * `satisfies Record<keyof CloudReadLaneReadiness, …>` is a COMPILE-TIME
 * keys-covered guard, and it is load-bearing at a boundary like this one: a
 * field added to the projection that nobody teaches this shape would be dropped
 * from every parsed lane silently, on every sample and every retry, while the
 * in-process path that skips this schema kept working — so the producer's own
 * tests would never see it. With the guard, the next added field fails `tsc`
 * here instead.
 */
const laneShape = {
  lane: z.enum(SyncLaneId),
  state: z.enum(SyncLaneDrainState),
  // `null` is "could not measure", which the aggregate treats as owed work. A
  // negative or fractional count is neither, so it fails the whole snapshot
  // rather than being coerced into a reassuring number.
  itemsRemaining: countSchema.nullable(),
  itemsRemainingIsLowerBound: z.boolean(),
  deadLetteredCount: countSchema,
  unmeasuredRows: countSchema,
  // Additive and optional: a main process that does not populate it degrades to
  // `null`, which reads as "no configuration answer" and keeps a surface
  // waiting rather than letting it settle on a lane it cannot account for.
  notApplicableReason: z
    .enum(CloudReadLaneNotApplicableReason)
    .nullish()
    .transform((reason) => reason ?? null),
} satisfies Record<keyof CloudReadLaneReadiness, z.ZodTypeAny>;

/**
 * ISS-6206 (wongk review on #5050): a lane's state and its counts must be a
 * combination {@link classifyLaneDrainState} can actually EMIT.
 *
 * Per-field validation alone still admitted pairs the canonical classifier can
 * never produce — `draining` with `itemsRemaining: 0`, or `remaining_unknown`
 * with a measured zero and no unmeasured rows. Both reach the aggregate's
 * zero-total branch, where strict lane readiness reads them as a SETTLED
 * `laneReadinessUnattested` and lets startup dismiss, rather than degrading to
 * the pending `unknown` a payload we cannot trust deserves.
 *
 * The invariants are not restated here — the classifier is re-run and its answer
 * compared, so this can never drift from the rule it enforces. `never_started`
 * and `idle_not_running` are exempt because the classifier answers them from
 * LIVENESS and returns before it reads a single count: every count combination
 * is genuinely reachable under them (a lane behind a shut gate can hold any
 * queue at all), so constraining them here would reject real payloads.
 */
function laneCountsMatchState(lane: CloudReadLaneReadiness): boolean {
  if (
    lane.state === SyncLaneDrainState.NeverStarted ||
    lane.state === SyncLaneDrainState.IdleNotRunning
  ) {
    return true;
  }
  return (
    classifyLaneDrainState({
      started: true,
      gateOpen: true,
      itemsRemaining: lane.itemsRemaining,
      deadLetteredCount: lane.deadLetteredCount,
      unmeasuredRows: lane.unmeasuredRows,
    }) === lane.state
  );
}

const laneSchema = z
  .object(laneShape)
  .refine(
    laneCountsMatchState,
    "lane state and counts must be a combination classifyLaneDrainState can emit"
  );

/**
 * ISS-6206 (wongk review on #5050): a NON-EMPTY lane list must be the EXACT
 * {@link SYNC_LANE_IDS} set — every lane once, no lane twice, nothing else.
 *
 * `z.array(laneSchema)` alone only proved that whatever lanes ARE present are
 * well-formed, and every all-lanes predicate downstream is an `every`/`some`
 * over that array. A payload carrying one drained lane therefore satisfied
 * `isCloudReadBacklogDrained` and rendered "Up to date" for a machine whose
 * other four lanes were never measured, and a duplicated lane was summed twice
 * into the cross-lane total. Neither is a shape the types can prevent: this
 * crosses an IPC boundary from a `Promise<unknown>`, so a truncated, partial, or
 * version-skewed payload is reachable at runtime.
 *
 * Failing the whole snapshot sends it to the `unknown` backlog, which renders as
 * unverified and can never render as complete — the same under-claim direction
 * as the closed `lane`/`state` unions above.
 *
 * THE EMPTY LIST IS NOT THAT SHAPE. It is the contract's own
 * {@link unknownCloudReadReadiness} — "we have not sampled yet" — which the
 * burn-down legitimately answers for the first minute of EVERY launch, before
 * its first sample lands. Rejecting it collapsed the very distinction this
 * ticket exists to preserve ("not looked yet" vs. "unusable payload") into one
 * `null`, and routed a normal launch into the cutover poll's failure ladder,
 * backing 5s off to 60s and holding the app on Local long after the cloud was
 * demonstrably drained. It is admitted here, and BOTH aggregates over the lane
 * list under-claim on it: `isCloudReadBacklogDrained` answers `false` (nothing
 * can read it as complete) and `totalCloudReadItemsRemaining` answers `null`
 * (nothing can render it as a measured "0 to go"). Admitting a payload is only
 * safe as far as every aggregate over it refuses to round it up — the drained
 * predicate alone was NOT that proof. A truncated or duplicated list is still
 * rejected.
 */
const lanesSchema = z.array(laneSchema).refine((lanes) => {
  if (lanes.length === 0) {
    return true;
  }
  const seen = new Set(lanes.map((lane) => lane.lane));
  return (
    seen.size === lanes.length &&
    SYNC_LANE_IDS.every((laneId) => seen.has(laneId))
  );
}, "lanes must be empty or carry each known sync lane exactly once");

/** Keys-covered for the same reason {@link laneShape} is — see its docblock. */
const snapshotShape = {
  sampledAtIso: z.string().min(1).nullable(),
  importComplete: z.boolean(),
  lanes: lanesSchema,
} satisfies Record<keyof CloudReadReadinessSnapshot, z.ZodTypeAny>;

const readinessSnapshotSchema = z.object(snapshotShape);

/**
 * The whole-app backlog carried by a runtime-status payload, or the `unknown`
 * backlog when the field is absent, malformed, or from a build whose vocabulary
 * this one does not recognize.
 *
 * Never throws: the shared runtime-status poll fans one payload out to every
 * status hook in a single loop, so a throw here silently starves every listener
 * behind it.
 */
export function parseCloudReadReadinessBacklog(
  value: unknown,
  options: ResolveCloudSyncBacklogOptions = {}
): CloudSyncBacklog {
  return resolveCloudSyncBacklog(
    parseCloudReadReadinessSnapshot(value),
    options
  );
}

/**
 * ISS-6206 (wongk review on #5050): the SAME validator, on the readiness channel
 * that does not go through the runtime-status poll.
 *
 * The identical payload also arrives via `getCloudReadReadiness()`, whose
 * `desktop-api.d.ts` return type is a claim about the preload, not a runtime
 * check — the value crosses IPC. `use-cloud-read-cutover` forwarded it straight
 * to `resolveCloudReadCutover`, and `resolveBacklogBlocker` only iterates the
 * lanes it is given, so a truncated one-lane drained payload cut the app over to
 * reading the CLOUD — the user's local history disappearing is the exact
 * ISS-5477 symptom — while the runtime-status surface, correctly, still said
 * "Checking…". Two channels carrying one payload must not disagree about
 * whether it is a payload at all.
 *
 * Exported rather than re-declared for the same reason: a second copy of these
 * rules is a second thing to keep in step, and the copy that drifts is the one
 * guarding the cutover.
 *
 * Returns `null` for anything that does not validate. Never throws.
 */
export function parseCloudReadReadinessSnapshot(
  value: unknown
): CloudReadReadinessSnapshot | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = readinessSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
