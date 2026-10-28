/**
 * @description ISS-5768 (whitlockk review on #4809): validate the readiness
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
 * THE `lane` ID IS OPEN; THE `state` UNION IS CLOSED (ISS-10375). A renderer is
 * not guaranteed to be the build that produced the payload — a dev renderer URL
 * or the browser-bridge mirror, both UNPACKAGED-only, since a packaged build
 * loads its own bundled renderer — and the operator ruled
 * (2026-09-16) that the renderer must tolerate a lane a newer main process adds
 * BEFORE any main process adds one. So a lane id this build does not know is
 * admitted rather than failing the whole snapshot, and it is COUNTED, never
 * dropped: every aggregate over the lane list is lane-agnostic
 * (`cloudReadLaneOwesWork` enumerates nothing), so such a lane holds the verdict
 * open while it owes, cannot size, or gave up on work, and stops holding it open
 * only on a `drained` that `laneCountsMatchState` re-derives from its own counts.
 * What the renderer cannot do is NAME it, so a per-lane count for it reads in the
 * generic unit. An unknown drain STATE is still rejected as a whole: that
 * vocabulary is what the verdict is computed from, and a state this build cannot
 * classify has no honest reading.
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
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
} from "../../shared/sync-burndown-contract";

/** A count the payload may carry: finite, whole, and never negative. */
const countSchema = z.number().int().nonnegative();

/**
 * The drain state is derived from the const object itself, so a state added to
 * the burn-down vocabulary is accepted here without a second edit. The lane id is
 * any non-blank string — see the module docblock.
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
  // ISS-10375: not `z.enum(SyncLaneId)`. That rejected the WHOLE snapshot the
  // moment a newer main process reported one more lane. `lanesSchema` still
  // requires every lane this build knows.
  //
  // davetho review on #7402: the blank check must not TRANSFORM the id.
  // `z.string().trim()` rewrote the wire identity before `lanesSchema` saw it,
  // so `" session_metadata "` was normalized into the canonical id and
  // satisfied the exact-known-lane requirement for a payload that never
  // carried that lane — a truncated snapshot reaching a `drained` verdict. A
  // padded id is not the lane it resembles; it is an id this build does not
  // know, and it fails the known-set check like any other.
  lane: z.string().refine((lane) => lane.trim().length > 0, "lane id is blank"),
  state: z.enum(SyncLaneDrainState),
  // `null` is "could not measure", which the aggregate treats as owed work. A
  // negative or fractional count is neither, so it fails the whole snapshot
  // rather than being coerced into a reassuring number.
  itemsRemaining: countSchema.nullable(),
  itemsRemainingIsLowerBound: z.boolean(),
  deadLetteredCount: countSchema,
  // ISS-9744: which population the count came from. Additive and optional at
  // this boundary for the same version-skew reason `parkedCount` is, and the
  // degrade is `unmeasured` — the under-claiming direction, which makes the
  // cross-lane total a FLOOR instead of letting an unlabelled number be read as
  // exact. ISS-9807 made it an input to the lane's own drain verdict, so the
  // degrade is applied AFTER `laneCountsMatchState` (see `laneSchema`): the
  // re-derivation must see the field as absent and skip the rule exactly as
  // the build that sent the payload did, or every unlabelled `drained` lane
  // would be refused and an older main process could never report caught up.
  deadLetteredBasis: z.enum(SyncLaneDeadLetteredBasis).nullish(),
  // ISS-9823: additive and optional, the `parkedCount` precedent — an older main
  // process that predates the field degrades to `false`, which re-derives the
  // drain state exactly as this boundary did before the field existed. It is NOT
  // a claim that the lane is healthy: a main process that CAN report the fault
  // sends `true`, and one that cannot never had the state to report.
  resumeBlocked: z
    .boolean()
    .nullish()
    .transform((blocked) => blocked ?? false),
  unmeasuredRows: countSchema,
  // Additive and optional: a main process that does not populate it degrades to
  // `null`, which reads as "no configuration answer" and keeps a surface
  // waiting rather than letting it settle on a lane it cannot account for.
  notApplicableReason: z
    .enum(CloudReadLaneNotApplicableReason)
    .nullish()
    .transform((reason) => reason ?? null),
  // ISS-7096: additive and optional — parked rows are another environment's
  // work, reported for legibility and never counted toward the drain. Absent
  // from an older main process's payload, which degrades to `null` (unknown).
  parkedCount: countSchema.nullish().transform((count) => count ?? null),
} satisfies Record<keyof CloudReadLaneReadiness, z.ZodTypeAny>;

/**
 * ISS-6206 (whitlockk review on #5050): a lane's state and its counts must be a
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
function laneCountsMatchState(lane: z.infer<typeof rawLaneSchema>): boolean {
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
      // ISS-9823: fed from the payload, not assumed. The classifier reads this
      // ahead of every branch that claims the queue emptied, so leaving it out
      // re-derives `drained` for a lane the main process correctly reported as
      // `remaining_unknown` and rejects the whole snapshot.
      resumeBlocked: lane.resumeBlocked,
      itemsRemaining: lane.itemsRemaining,
      deadLetteredCount: lane.deadLetteredCount,
      // ISS-9807: `null` when the payload predates the field — the classifier
      // then skips the basis rule, which IS the pre-field derivation.
      deadLetteredBasis: lane.deadLetteredBasis ?? null,
      unmeasuredRows: lane.unmeasuredRows,
    }) === lane.state
  );
}

const rawLaneSchema = z.object(laneShape);

const laneSchema = rawLaneSchema
  .refine(
    laneCountsMatchState,
    "lane state and counts must be a combination classifyLaneDrainState can emit"
  )
  .transform(
    (lane): CloudReadLaneReadiness => ({
      ...lane,
      deadLetteredBasis:
        lane.deadLetteredBasis ?? SyncLaneDeadLetteredBasis.Unmeasured,
    })
  );

/**
 * ISS-6206 (whitlockk review on #5050): a NON-EMPTY lane list must carry every
 * {@link SYNC_LANE_IDS} lane once, and no lane twice.
 *
 * ISS-10375 dropped "and nothing else": a lane id this build does not know is
 * admitted alongside them (see the module docblock), but only ALONGSIDE — it can
 * never stand in for a known lane that is missing, and it is duplicate-checked
 * like any other.
 *
 * `z.array(laneSchema)` alone only proved that whatever lanes ARE present are
 * well-formed, and every all-lanes predicate downstream is an `every`/`some`
 * over that array. A payload carrying one drained lane therefore satisfied
 * `isCloudReadBacklogDrained` and rendered "Up to date" for a machine whose
 * other lanes were never measured, and a duplicated lane was summed twice
 * into the cross-lane total. Neither is a shape the types can prevent: this
 * crosses an IPC boundary from a `Promise<unknown>`, so a truncated, partial, or
 * version-skewed payload is reachable at runtime.
 *
 * Failing the whole snapshot sends it to the `unknown` backlog, which renders as
 * unverified and can never render as complete — the same under-claim direction
 * as the closed `state` union above.
 *
 * THE EMPTY LIST IS NOT THAT SHAPE. It is the contract's own
 * {@link unknownCloudReadReadiness} — "we have not sampled yet" — which the
 * burn-down legitimately answers for the first minute of EVERY launch, before
 * its first sample lands. Rejecting it collapsed the very distinction this
 * ticket exists to preserve ("not looked yet" vs. "unusable payload") into one
 * `null`. It is admitted here, and BOTH aggregates over the lane
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
}, "lanes must be empty or carry each known sync lane exactly once, and no lane twice");

/** Keys-covered for the same reason {@link laneShape} is — see its docblock. */
const snapshotShape = {
  sampledAtIso: z.string().min(1).nullable(),
  importComplete: z.boolean(),
  lanes: lanesSchema,
} satisfies Record<keyof CloudReadReadinessSnapshot, z.ZodTypeAny>;

const readinessSnapshotSchema = z.object(snapshotShape);

/**
 * The whole-app backlog carried by a runtime-status payload, or the `unknown`
 * backlog when the field is absent, malformed, or carries a drain state this
 * build does not recognize. A lane id it does not recognize is not one of those
 * (ISS-10375).
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
 * The snapshot validator behind {@link parseCloudReadReadinessBacklog}.
 *
 * The payload crosses IPC, so its `desktop-api.d.ts` type is a claim about the
 * preload rather than a runtime check: a truncated, partial, or version-skewed
 * one is reachable here, and a one-lane drained payload read as a measurement
 * renders "Up to date" for lanes nobody counted.
 *
 * Returns `null` for anything that does not validate. Never throws.
 */
function parseCloudReadReadinessSnapshot(
  value: unknown
): CloudReadReadinessSnapshot | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = readinessSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
