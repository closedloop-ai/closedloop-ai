/**
 * @file cloud-read-readiness-contract.ts
 * @description The node-free payload the main process hands the renderer so the
 * app-core read source can wait for the desktop→cloud backlog to drain
 * (ISS-5477).
 *
 * WHY THIS EXISTS. `resolveDesktopAppCoreMode` used to switch the renderer's
 * read source on `authenticated && online` alone. It had no input for sync state
 * at all, so at the instant a user signed in the app started reading a cloud that
 * had not yet received a single row — and the user watched a populated app become
 * an empty one. Signing up appeared to delete their data.
 *
 * WHAT IT CARRIES, AND WHAT IT REFUSES TO. This is a PROJECTION of the ISS-5387
 * burn-down ({@link SyncLaneBurndown}), deliberately narrowed to the three things
 * a read-source decision needs — each lane's drain state, how much it still owes,
 * and how much it gave up on — plus whether the initial parse/import backlog is
 * complete. It does NOT re-derive readiness from raw row counts: the drain state
 * is computed once, by the burn-down, using each lane's OWN pending predicate.
 * (ISS-5445: 3,490 of 3,508 invocation-outbox rows sit under an unscoped template
 * key that the delivery predicate never sees, so a naive `WHERE status='pending'`
 * count reports a backlog that does not exist.)
 *
 * Counts, states, and booleans only. No session titles, file paths, payload
 * bodies, or credentials — the burn-down's own no-content rule applies here
 * unchanged, and this payload additionally crosses an IPC boundary.
 *
 * THE ONE STATE THAT MEANS CAUGHT UP. `drained`. Not "the queue is empty", not
 * "the lane stopped", and emphatically not `drained_with_dead_letters`, which
 * means the lane GAVE UP — cutting over on it loses exactly the rows that failed.
 * {@link isCloudReadBacklogDrained} enforces that by delegating to the burn-down's
 * own {@link SyncLaneDrainState} vocabulary rather than restating it.
 */

import type { CloudReadLaneNotApplicableReason } from "./cloud-read-lane-applicability.js";
import type {
  SyncBurndownSnapshot,
  SyncLaneBurndown,
  SyncLaneId,
} from "./sync-burndown-contract.js";
import { SYNC_LANE_IDS, SyncLaneDrainState } from "./sync-burndown-contract.js";

/** One lane's readiness, projected from its burn-down row. */
export type CloudReadLaneReadiness = {
  lane: SyncLaneId;
  state: SyncLaneDrainState;
  /**
   * Items the lane would ACTUALLY deliver, counted with its own pending
   * predicate. `null` when the lane has no per-item queue (the component
   * inventory is a cursor position, not a queue) or could not measure it —
   * unknown, never zero.
   */
  itemsRemaining: number | null;
  /** True when {@link itemsRemaining} is a floor (`>= N`), not an exact count. */
  itemsRemainingIsLowerBound: boolean;
  /** Items the lane ABANDONED. Always measurable; `0` is a real zero. */
  deadLetteredCount: number;
  /**
   * ISS-5768: rows the lane counted but could NOT classify — a status string
   * this build does not recognize (a version-skewed or corrupt row). Carried
   * through the projection because it is a SECOND, independent way a lane fails
   * to establish that it owes nothing: `classifyLaneDrainState` answers
   * `remaining_unknown` on `unmeasuredRows > 0` even when `itemsRemaining`
   * measures a clean `0`. Dropping it here let the whole-app aggregate round
   * such a lane down to "drained" — the exact defect this projection exists to
   * prevent, one level in.
   */
  unmeasuredRows: number;
  /**
   * ISS-6206 (shafty023 review on #5050): why this app's CONFIGURATION puts the
   * lane out of play, or `null` when nothing does — see
   * `cloud-read-lane-applicability.ts` for why a stopped sample is not allowed
   * to answer this and a persisted switch is.
   *
   * Optional so an older main process that never populates it degrades to
   * "unknown", which the aggregate treats as still-waiting rather than as
   * permanently unattestable.
   */
  notApplicableReason?: CloudReadLaneNotApplicableReason | null;
};

/**
 * Everything the renderer needs to decide whether reading the cloud would tell
 * the user the truth.
 *
 * `sampledAtIso` is `null` when the burn-down has never taken a sample — during
 * boot, before the db host is up, or while the reporter is stopped. That is
 * UNKNOWN readiness, not drained readiness, and it must keep the reader on Local
 * (bounded by the renderer's fail-open; see `desktop-app-core-mode.ts`).
 */
export type CloudReadReadinessSnapshot = {
  /** When the burn-down last sampled, or `null` if it never has. */
  sampledAtIso: string | null;
  /**
   * Has the initial collector parse/import backlog finished? The same signal the
   * sidebar's "Dashboard ready" affordance reads
   * (`RendererReadinessGates.isInitialCollectorImportComplete`). A cloud read
   * before this is complete is reading a cloud that cannot yet have received
   * rows this machine has not even parsed.
   */
  importComplete: boolean;
  lanes: readonly CloudReadLaneReadiness[];
};

/** The snapshot for "we cannot answer yet" — never mistaken for drained. */
export function unknownCloudReadReadiness(): CloudReadReadinessSnapshot {
  return {
    sampledAtIso: null,
    importComplete: false,
    lanes: [],
  };
}

/**
 * Project a burn-down sample into the read-source payload.
 *
 * A `null` sample yields {@link unknownCloudReadReadiness} rather than an empty
 * lane list with a timestamp: "no lanes owe anything" and "we have not looked"
 * are the exact two things this whole ticket exists to keep apart.
 */
export function projectCloudReadReadiness(input: {
  importComplete: boolean;
  snapshot: SyncBurndownSnapshot | null;
  /**
   * ISS-6206: this app's configuration answer for a lane, supplied by the main
   * process from its persisted settings. Omitted by callers that have no
   * settings to read, in which case every lane answers `null` — nothing is
   * permanently unattestable, so a surface keeps waiting. That is the
   * under-claiming default, and it is the safe one.
   */
  notApplicableReason?: (
    lane: SyncLaneId
  ) => CloudReadLaneNotApplicableReason | null;
}): CloudReadReadinessSnapshot {
  if (!input.snapshot) {
    return unknownCloudReadReadiness();
  }
  const resolveReason = input.notApplicableReason;
  return {
    sampledAtIso: input.snapshot.sampledAtIso,
    importComplete: input.importComplete,
    lanes: input.snapshot.lanes.map((lane) =>
      projectLane(lane, resolveReason?.(lane.lane) ?? null)
    ),
  };
}

/**
 * Is every lane genuinely caught up? An empty lane list answers `false`: a
 * snapshot that measured no lanes has not established that nothing is owed.
 */
export function isCloudReadBacklogDrained(
  snapshot: CloudReadReadinessSnapshot
): boolean {
  return (
    snapshot.lanes.length > 0 &&
    snapshot.lanes.every((lane) => lane.state === SyncLaneDrainState.Drained)
  );
}

/**
 * How many items are still owed across every lane, or `null` when the total
 * cannot be measured. `null` is "unknown", so a caller must render it as
 * unknown rather than as a reassuring total that omits a lane.
 *
 * TWO WAYS THE TOTAL IS UNKNOWN, and an empty lane list is the second one.
 * A lane that could not size its own remainder is the obvious one. The other is
 * a snapshot that measured NO lanes — the contract's own
 * {@link unknownCloudReadReadiness}, which `parse-cloud-read-readiness`
 * deliberately admits because the burn-down answers it for the first minute of
 * every launch. Summing an empty list to `0` collapses "measured no lanes" into
 * "owes zero items": the cutover chip renders on `sync_not_established` and
 * would print "Uploading history · 0 to go" off a snapshot that never counted
 * anything, which is the same fabricated-zero class this module exists to
 * prevent. `isCloudReadBacklogDrained` already refuses an empty list for the
 * same reason; this is the totals half of that refusal.
 */
export function totalCloudReadItemsRemaining(
  snapshot: CloudReadReadinessSnapshot
): number | null {
  if (snapshot.lanes.length === 0) {
    return null;
  }
  let total = 0;
  for (const lane of snapshot.lanes) {
    if (lane.itemsRemaining === null) {
      return null;
    }
    total += lane.itemsRemaining;
  }
  return total;
}

/** How many items every lane has collectively given up on. Always measurable. */
export function totalCloudReadDeadLettered(
  snapshot: CloudReadReadinessSnapshot
): number {
  let total = 0;
  for (const lane of snapshot.lanes) {
    total += lane.deadLetteredCount;
  }
  return total;
}

/** Does any lane report having ABANDONED work it will never deliver? */
export function hasCloudReadDeadLetters(
  snapshot: CloudReadReadinessSnapshot
): boolean {
  return snapshot.lanes.some(
    (lane) =>
      lane.state === SyncLaneDrainState.DrainedWithDeadLetters ||
      lane.deadLetteredCount > 0
  );
}

/**
 * A comparable fingerprint of everything the cutover decision reads.
 *
 * The renderer's fail-open is keyed on this CHANGING, not on wall-clock time
 * since sign-in: a bound that fired while a real backlog was draining would
 * reintroduce the very defect this ticket fixes. Any movement — a lane state
 * transition, a queue getting shorter (or longer), the import completing —
 * proves the system is alive and resets the stall clock. Only a fingerprint that
 * stands still is evidence of a wedge.
 *
 * `sampledAtIso` is deliberately NOT part of it. The burn-down re-stamps every
 * sample whether or not anything moved, so including it would make the clock
 * reset forever and the bound unreachable — the same "activity is not progress"
 * trap ISS-5347 documented.
 */
export function cloudReadReadinessFingerprint(
  snapshot: CloudReadReadinessSnapshot
): string {
  const lanes = snapshot.lanes
    .map(
      (lane) =>
        `${lane.lane}:${lane.state}:${lane.itemsRemaining ?? "unknown"}${
          lane.itemsRemainingIsLowerBound ? "+" : ""
        }:${lane.deadLetteredCount}:${lane.unmeasuredRows}:${
          lane.notApplicableReason ?? "applicable"
        }`
    )
    .join("|");
  return `import=${snapshot.importComplete}|${lanes}`;
}

function projectLane(
  lane: SyncLaneBurndown,
  notApplicableReason: CloudReadLaneNotApplicableReason | null
): CloudReadLaneReadiness {
  return {
    lane: lane.lane,
    state: lane.state,
    itemsRemaining: lane.itemsRemaining,
    itemsRemainingIsLowerBound: lane.itemsRemainingIsLowerBound,
    deadLetteredCount: lane.deadLetteredCount,
    unmeasuredRows: lane.unmeasuredRows,
    notApplicableReason,
  };
}

/**
 * ISS-5768: does this lane still owe the cloud anything?
 *
 * Shape-agnostic on purpose, and the reason is the defect this function exists
 * to close. The predicate reads only the three quantities EVERY lane reports —
 * so a lane added later is counted the moment the burn-down measures it, with no
 * edit here and no way to be silently excluded. Excluding a lane must take a
 * deliberate act; being counted is the default.
 *
 * Unknown is owed, and there are TWO ways a lane can be unknown. A `null`
 * remainder means the lane could not count at all. `unmeasuredRows > 0` means it
 * counted but could not CLASSIFY some rows — a status string this build does not
 * recognize — which `classifyLaneDrainState` answers `remaining_unknown` on even
 * when the measured remainder is a clean `0`. Both are "could not establish that
 * it owes nothing", and an unmeasured remainder is not a zero remainder.
 * Abandoned is owed too: a dead-lettered item is work the user still has on this
 * machine and the cloud still does not have, whatever the lane decided about it.
 *
 * Deliberately NOT keyed on {@link SyncLaneDrainState}: a lane whose gate is
 * shut (transcript upload disabled, a closed org policy) with a MEASURED empty
 * queue owes nothing, and reporting it as outstanding forever would be its own
 * lie in the opposite direction.
 */
export function cloudReadLaneOwesWork(lane: {
  itemsRemaining: number | null;
  deadLetteredCount: number;
  unmeasuredRows: number;
}): boolean {
  return (
    lane.itemsRemaining === null ||
    lane.itemsRemaining > 0 ||
    lane.deadLetteredCount > 0 ||
    lane.unmeasuredRows > 0
  );
}

/**
 * The whole-app answer to "is this machine's history in the cloud?".
 *
 * - `unknown` — nobody has looked, a lane cannot measure its remainder, or the
 *   initial import is still discovering history no lane has been offered yet.
 *   NEVER renders as complete; an uncomputable state is named, not shown as its
 *   happy value.
 * - `outstanding` — at least one item is still on this machine.
 * - `abandoned` — nothing left to attempt, but a lane GAVE UP on something.
 * - `drained` — every lane owes nothing. The only state that means "up to date".
 */
export const CloudSyncBacklogState = {
  Unknown: "unknown",
  Outstanding: "outstanding",
  Abandoned: "abandoned",
  Drained: "drained",
} as const;
export type CloudSyncBacklogState =
  (typeof CloudSyncBacklogState)[keyof typeof CloudSyncBacklogState];

/**
 * ISS-6206: one lane's own remainder, kept as a lane-scoped count instead of
 * being folded into a cross-lane scalar.
 *
 * The burn-down's lane vocabulary states outright that these totals are NEVER
 * summed — "an outbox item, a transcript file, and a cursor position do not add
 * up to a meaningful number" — and the reporter proves it: the session lane
 * counts outbox ROWS, the transcript lane counts FILES (each possibly
 * megabytes), and the component lane counts rows past a cursor. Only a
 * per-lane count carries a unit a reader can act on.
 */
export type CloudSyncLaneRemainder = {
  lane: SyncLaneId;
  /** Items this lane still owes. Always > 0 — settled lanes are not listed. */
  itemsRemaining: number;
  /** True when this lane's own count is a floor (`>= N`), not exact. */
  itemsRemainingIsLowerBound: boolean;
};

/**
 * The whole-app backlog, with the counts that back it carried alongside so copy
 * never has to fabricate one. `itemsRemaining` stays `null` when any lane could
 * not measure — a caller must render that as unknown rather than as a
 * reassuring total that quietly omits a lane.
 */
export type CloudSyncBacklog = {
  state: CloudSyncBacklogState;
  /**
   * ISS-6206: the CROSS-LANE sum, and a heterogeneous one — see
   * {@link CloudSyncLaneRemainder} for why the units do not add up. It survives
   * as the aggregate's own "is anything owed" input and as the pre-ISS-6206
   * rendering path, but a caller with {@link laneRemainders} in hand must
   * present those instead.
   */
  itemsRemaining: number | null;
  /** At least one lane's remainder is a floor (`>= N`), not an exact count. */
  itemsRemainingIsLowerBound: boolean;
  /**
   * ISS-6206: the per-lane breakdown behind {@link itemsRemaining}, in the
   * burn-down's canonical lane order, listing only lanes that still owe
   * something. EMPTY when the caller did not ask for strict lane readiness,
   * which is what keeps the flag-off path rendering exactly the pre-ISS-6206
   * copy.
   */
  laneRemainders: readonly CloudSyncLaneRemainder[];
  /**
   * ISS-6206: this `unknown` is SETTLED, not pending. Every lane owes nothing,
   * but not every lane reached `drained`, and the lanes that fell short did so
   * for a reason THIS APP'S CONFIGURATION carries rather than one a sample
   * observed — so no later sample of the same configuration can attest it. Only
   * ever `true` alongside `state === "unknown"`, and only under
   * {@link ResolveCloudSyncBacklogOptions.strictLaneReadiness}.
   *
   * shafty023 review on #5050: the finality is NOT inferred from the stopped
   * sample itself. `idle_not_running` covers connectivity, credential, policy
   * and compute-target gates that reopen on their own, so a snapshot with one of
   * those keeps this `false` and the `unknown` stays PENDING —
   * {@link cloudReadLaneReadinessIsFinal} is the predicate, and
   * `cloud-read-lane-applicability.ts` is where a reason may legitimately come
   * from.
   *
   * It exists because `unknown` otherwise answers two questions with one word.
   * "Still checking, wait" converges; "nothing here can be verified" does not,
   * and a caller that treats the second as the first waits forever. A progress
   * surface must read this before deciding it is still waiting on the cloud; a
   * completeness surface must NOT — `unknown` is not `drained` either way, and
   * an unattested backlog may never render as caught up.
   */
  laneReadinessUnattested: boolean;
  deadLetteredCount: number;
};

/** Options for {@link resolveCloudSyncBacklog}. */
export type ResolveCloudSyncBacklogOptions = {
  /**
   * ISS-6206: require each lane's CANONICAL drain state before claiming the
   * whole app is caught up, and carry the per-lane breakdown.
   *
   * Defaults to `false` so an un-opted-in build keeps the exact behavior it
   * shipped with (the desktop Labs gate that turns this on is closed by
   * default). With it `true`, a `never_started` or `idle_not_running` lane
   * measuring a clean zero can no longer round the aggregate up to `drained`.
   */
  strictLaneReadiness?: boolean;
};

/**
 * ISS-5768: collapse a readiness snapshot into the ONE completeness claim any
 * user-facing "up to date" indicator may make.
 *
 * WHY THIS EXISTS. `AgentSessionSyncProgress.caughtUp` is a per-lane truth —
 * the session backfill/incremental queues, and nothing else. Presented as a
 * whole-app claim it reported "Up to date" on a machine owing 2,985 component
 * rows with one item dead-lettered, beside a `Cloud (partial)` badge reading off
 * this very snapshot and saying so. A per-lane truth rendered as a whole-app
 * claim is the defect; this is the aggregate that replaces it.
 *
 * A `null` snapshot is what an older main process (no `cloudReadReadiness` in
 * its runtime-status payload) degrades to, and it answers `unknown` — never
 * drained.
 *
 * IMPORT-PENDING IS OWED WORK NO LANE CAN SEE (codex review on #4809). While the
 * initial collector parse/import is still running, history exists on this
 * machine that has not entered ANY sync lane's queue yet — so every lane can
 * report a clean remainder and the machine still owe the cloud thousands of
 * items. `resolveBacklogBlocker` (the read-source gate reading this same
 * snapshot) already refuses to cut over on `!importComplete` for exactly that
 * reason; the aggregate refuses to claim completeness on it for the same one.
 * A measured total is a FLOOR while discovery runs, and a lane-clean machine is
 * `unknown`, never `drained` or `abandoned` — both of those are terminal claims.
 */
export function resolveCloudSyncBacklog(
  snapshot: CloudReadReadinessSnapshot | null,
  options: ResolveCloudSyncBacklogOptions = {}
): CloudSyncBacklog {
  const unknown: CloudSyncBacklog = {
    state: CloudSyncBacklogState.Unknown,
    itemsRemaining: null,
    itemsRemainingIsLowerBound: false,
    laneRemainders: [],
    laneReadinessUnattested: false,
    deadLetteredCount: 0,
  };
  if (
    snapshot === null ||
    snapshot.sampledAtIso === null ||
    snapshot.lanes.length === 0
  ) {
    return unknown;
  }
  const itemsRemaining = totalCloudReadItemsRemaining(snapshot);
  const deadLetteredCount = totalCloudReadDeadLettered(snapshot);
  const itemsRemainingIsLowerBound = snapshot.lanes.some(
    (lane) => lane.itemsRemainingIsLowerBound
  );
  const totals = {
    itemsRemaining,
    itemsRemainingIsLowerBound,
    laneRemainders: options.strictLaneReadiness
      ? cloudSyncLaneRemainders(snapshot)
      : [],
    laneReadinessUnattested: false,
    deadLetteredCount,
  };
  if (itemsRemaining === null || snapshot.lanes.some(laneHasUnclassifiedRows)) {
    // A lane owes something we cannot size, or holds rows it could not classify.
    // Report the dead-letter count we DO know (callers warn on it regardless of
    // state) and refuse to name a total we cannot stand behind. Tested before
    // the drained branch only for readability — neither condition can hold while
    // no lane owes anything, since both are ways of owing.
    return { ...totals, state: CloudSyncBacklogState.Unknown };
  }
  if (!snapshot.importComplete) {
    return resolveImportPendingBacklog({ ...totals, itemsRemaining });
  }
  // ISS-6206: owing nothing is NOT the same as having caught up.
  // `cloudReadLaneOwesWork` is deliberately state-agnostic (a lane behind a shut
  // gate with a measured empty queue must not read as `outstanding` forever),
  // which left `never_started` and `idle_not_running` lanes free to round the
  // whole-app aggregate up to a TERMINAL claim on a measured zero — a lane that
  // never ran, reported as "Up to date". `isCloudReadBacklogDrained` is this
  // module's canonical all-lanes-drained predicate; a lane that owes nothing but
  // cannot prove it delivered anything answers `unknown`, the honest middle the
  // terminal states cannot express.
  //
  // Gated on the TOTAL rather than nested under the `drained` door (wongk review
  // on #5050): `cloudReadLaneOwesWork` is true on `deadLetteredCount > 0`, so a
  // guard living inside that door was skipped entirely by a lane-clean snapshot
  // carrying one dead letter, which then fell through to `abandoned` — the other
  // terminal claim, and the ISS-5768 defect moved one branch over. `drained` and
  // `abandoned` are reachable only at a zero total, so testing the total here
  // closes both doors with one condition and cannot intercept `outstanding`.
  // ISS-6206 (wongk review on #5050): a shortfall that is ONLY dead letters is
  // already terminal, so it must not enter the pending branch. Every lane has
  // finished; one of them gave up, and no later sample of this configuration
  // reclassifies a dead-lettered lane. Held here, the Connection Status cell
  // read "1 item couldn't sync. Still checking whether the rest of your history
  // is synced." forever — a promise of an answer that could never arrive — while
  // the identical snapshot without the strict flag correctly answered
  // `abandoned`. Two paths over one snapshot must not disagree about whether it
  // has settled.
  if (
    options.strictLaneReadiness &&
    itemsRemaining === 0 &&
    !isCloudReadBacklogDrained(snapshot) &&
    !everyLaneFinishedWithDeadLetters(snapshot)
  ) {
    return {
      ...totals,
      state: CloudSyncBacklogState.Unknown,
      laneReadinessUnattested: cloudReadLaneReadinessIsFinal(snapshot),
    };
  }
  if (!snapshot.lanes.some(cloudReadLaneOwesWork)) {
    return { ...totals, state: CloudSyncBacklogState.Drained };
  }
  if (itemsRemaining > 0) {
    return { ...totals, state: CloudSyncBacklogState.Outstanding };
  }
  return { ...totals, state: CloudSyncBacklogState.Abandoned };
}

/** ISS-5768: rows the lane counted but could not classify. See {@link cloudReadLaneOwesWork}. */
function laneHasUnclassifiedRows(lane: CloudReadLaneReadiness): boolean {
  return lane.unmeasuredRows > 0;
}

/**
 * The backlog while the initial import is still discovering history (codex
 * review on #4809). Whatever the lanes measured is a FLOOR — the rows still
 * being parsed have not been offered to a queue yet — so a positive remainder
 * is reported as "at least N" and a lane-clean machine is `unknown` rather than
 * `drained` or `abandoned`. Both of those assert that discovery has finished,
 * which is precisely what `importComplete === false` denies.
 *
 * ISS-6206 (wongk review on #5050): the floor has to reach the PER-LANE
 * remainders too, not just the aggregate. Both renderers prefer
 * {@link CloudSyncBacklog.laneRemainders} when it is populated, so an aggregate
 * marked "at least" whose lanes each still carry
 * `itemsRemainingIsLowerBound: false` rendered a flat, confident "2,985 activity
 * records" while discovery was still finding more — the aggregate's own hedge
 * never reached the copy that was actually shown. A lane's count is a floor for
 * exactly the reason the total is: rows not yet parsed have not been offered to
 * that lane either.
 *
 * The `unknown` this returns is PENDING, never
 * {@link CloudSyncBacklog.laneReadinessUnattested}: discovery is actively
 * running, so a later sample genuinely can resolve it. Carrying the caller's
 * `false` through unchanged is what keeps a progress surface waiting here.
 */
function resolveImportPendingBacklog(totals: {
  itemsRemaining: number;
  itemsRemainingIsLowerBound: boolean;
  laneRemainders: readonly CloudSyncLaneRemainder[];
  laneReadinessUnattested: boolean;
  deadLetteredCount: number;
}): CloudSyncBacklog {
  return {
    ...totals,
    itemsRemainingIsLowerBound: true,
    laneRemainders: totals.laneRemainders.map((remainder) => ({
      ...remainder,
      itemsRemainingIsLowerBound: true,
    })),
    state:
      totals.itemsRemaining > 0
        ? CloudSyncBacklogState.Outstanding
        : CloudSyncBacklogState.Unknown,
  };
}

/**
 * ISS-6206: the per-lane breakdown that replaces the heterogeneous cross-lane
 * total in user-facing copy.
 *
 * Lanes come back in {@link SYNC_LANE_IDS} order — the burn-down's own canonical
 * sequence — for the reason the sort below records. A lane is listed only when
 * it has a MEASURED positive remainder. An unmeasurable lane is deliberately
 * absent rather than listed as zero — the aggregate has already answered
 * `unknown` for it, and a lane printed at `0` would claim a measurement that was
 * never taken.
 */
export function cloudSyncLaneRemainders(
  snapshot: CloudReadReadinessSnapshot
): readonly CloudSyncLaneRemainder[] {
  const remainders: CloudSyncLaneRemainder[] = [];
  for (const lane of snapshot.lanes) {
    if (lane.itemsRemaining !== null && lane.itemsRemaining > 0) {
      remainders.push({
        lane: lane.lane,
        itemsRemaining: lane.itemsRemaining,
        itemsRemainingIsLowerBound: lane.itemsRemainingIsLowerBound,
      });
    }
  }
  // ISS-6206 (shafty023 review on #5050): CANONICAL lane order, not remainder
  // size. These lanes count different units — 100 transcript FILES are not
  // "smaller" than 101 activity ROWS — so a numeric comparison across them is
  // the same dimensionless arithmetic this ticket removed from the aggregate,
  // and it made the sequence churn whenever two unrelated counts crossed.
  // Ordering by the burn-down's own fixed lane sequence is stable between
  // samples and states no priority the product has not decided;
  // `describeAllLaneRemainders` still names every lane, so no count is
  // unreachable.
  return remainders.sort(
    (a, b) => canonicalLaneIndex(a.lane) - canonicalLaneIndex(b.lane)
  );
}

/** Position of a lane in the burn-down's canonical emission order. */
function canonicalLaneIndex(lane: SyncLaneId): number {
  return SYNC_LANE_IDS.indexOf(lane);
}

/**
 * ISS-6206 (wongk review on #5050): has every lane FINISHED, with at least one
 * of them having given up?
 *
 * The two terminal drain states and nothing else. A single lane that merely
 * stopped — `never_started`, `idle_not_running`, `remaining_unknown` — makes
 * this false, because that lane's gate reopens on its own and "still checking"
 * is then the honest answer for the whole machine. That is the case
 * `cloudReadLaneReadinessIsFinal` and the strict pending branch exist for, and
 * this predicate deliberately does not intercept it.
 */
function everyLaneFinishedWithDeadLetters(
  snapshot: CloudReadReadinessSnapshot
): boolean {
  return (
    snapshot.lanes.some(
      (lane) => lane.state === SyncLaneDrainState.DrainedWithDeadLetters
    ) &&
    snapshot.lanes.every(
      (lane) =>
        lane.state === SyncLaneDrainState.Drained ||
        lane.state === SyncLaneDrainState.DrainedWithDeadLetters
    )
  );
}

/**
 * ISS-6206 (shafty023 review on #5050): is this snapshot's shortfall FINAL —
 * can no later sample of this same configuration turn it into `drained`?
 *
 * Only two things satisfy that. A lane that genuinely reached `drained` is
 * settled. A lane this app's configuration has switched off is settled for as
 * long as the switch stays off, and a flip re-runs this on the next sample. A
 * lane stopped for any other reason is NOT: `idle_not_running` covers
 * connectivity, credentials, org policy and compute-target state, and
 * `never_started` covers a lane that simply has not started yet — every one of
 * those reopens on its own, and the burn-down that follows will expose the work
 * that was newly eligible. Reading such a lane as final let a startup surface
 * latch shut moments before that happened.
 *
 * An absent reason (an older main process, or a caller with no settings to
 * read) answers `false` here, so the surface keeps waiting. Under-claiming is
 * the only safe direction: the cost of waiting is a panel that stays up, and
 * the cost of over-claiming is work the user is never told about.
 *
 * `drained_with_dead_letters` is absent from that list on purpose, not by
 * oversight: a snapshot whose ONLY shortfall is dead letters never reaches this
 * predicate — {@link everyLaneFinishedWithDeadLetters} routes it to the terminal
 * `abandoned` before the pending branch. What is left for this to judge is a
 * snapshot that still holds a merely-stopped lane, and there "still checking" is
 * the honest answer no matter what the other lanes did.
 */
export function cloudReadLaneReadinessIsFinal(
  snapshot: CloudReadReadinessSnapshot
): boolean {
  return snapshot.lanes.every(
    (lane) =>
      lane.state === SyncLaneDrainState.Drained ||
      (lane.notApplicableReason ?? null) !== null
  );
}
