/**
 * @file agent-session-lane-run.ts
 * @description PLN-2028 M4 (ISS-10053, ISS-9963, ISS-10043): what the SESSION
 * lane RECORDS about its environmental run — the four `sync_state` lane-run
 * columns, and the `sync.lane.gave_up` a process holding a RESUMED give-up owes.
 *
 * The session twin of `agent-component-lane-give-up.ts`, extracted out of
 * `agent-session-outbox-writers.ts` at 901 lines against the 1,000-line ceiling:
 * everything here is about ONE record, and nothing here touches the outbox rows,
 * the cursor, or the dead-letter ledger.
 *
 * THE GATE IS PASSED IN, NEVER HELD. `createSessionFoldRunners` owns the gate's
 * lifetime (its identity resets and its pacing doors are fold-runner business),
 * so holding a second reference here would be two owners for one clock. Every
 * operation that writes takes it instead, which also means the run origin on the
 * row can only ever come from the gate that decided it.
 */

import {
  LaneGiveUpSource,
  SyncLane,
  type SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { LaneGiveUpStampDefect } from "../../shared/lane-give-up.js";
import type {
  LaneEnvironmentalDeferGate,
  LaneEnvironmentalDeferState,
} from "../sync/lane-environmental-defer.js";
import {
  type LaneRunDefectName,
  type LaneRunRecordRead,
  laneGateGiveUpSource,
  laneGiveUpSourceFor,
  laneRunDefectNotes,
  laneRunResumesHold,
  type PersistedLaneRunRead,
  readLaneRunRecord,
} from "../sync/lane-run-policy.js";
import {
  type LaneRunPersistSource,
  LaneRunRecord,
  sourceLaneRunPersist,
} from "../sync/lane-run-record.js";
import {
  clearSyncLaneGiveUpAnnouncement,
  reportSyncLaneGaveUp,
  reportSyncLaneReArmed,
} from "../telemetry/sync-lane-give-up-telemetry.js";
import { buildLaneRunSourceKey } from "./sync-lane-run-key.js";

export type SessionLaneRunOptions = {
  /**
   * The lane's LIVE source key, re-read per call — a hydration or an account
   * switch moves the identity under this collaborator, and a captured key would
   * write the previous target's row.
   */
  readSourceKey: () => string | null;
  /**
   * Re-resolved per write, never captured: the DB-host source is a proxy that
   * goes null while the host restarts, and a null captured once silently
   * disables the durable write for the life of the lane (the ISS-5347 cursor
   * freeze).
   */
  getSource: () => LaneRunPersistSource | null;
  /** Name a dropped lane-run write. */
  onWriteFailed: (message: string) => void;
  /**
   * Name a lane-run column a stored value could not supply. Separate from
   * {@link onWriteFailed} because nothing was dropped: the column held a value
   * this build cannot treat as a measurement, and the origin's version of that
   * is silent everywhere else — the lane simply opens a fresh run.
   */
  onRunDefect: (name: LaneRunDefectName, message: string) => void;
};

/**
 * The give-up this lane believes is on its row — instant, cause and PRODUCER as
 * one value.
 *
 * One object rather than three fields, so "holding none" and "holding one whose
 * cause or producer the row could not supply" cannot drift apart: a reason or a
 * producer left set beside a cleared stamp is a row that would let the next
 * process announce a give-up this lane is not holding.
 */
type SessionLaneGiveUp = {
  atMs: number;
  reason: SyncReason | null;
  source: LaneGiveUpSource | null;
};

/**
 * The run the ROW held when a hydration was REFUSED — durable evidence this
 * process did not supersede, and therefore may not write over.
 *
 * Deliberately NOT {@link SessionLaneGiveUp} in live state (D4): the gate is
 * still holding the run THIS process saw, so taking the row's cause there would
 * announce a give-up the gate is not holding and disarm the anchor guard. But
 * the row keeps what it keeps, and the next reconcile writes the WHOLE record —
 * so without this the live origin replaces an older one and a give-up nobody
 * superseded is nulled, which is ISS-10053's own defect written back to disk
 * (tamsinb review).
 */
type UnadoptedLaneRun = {
  originMs: number | null;
  giveUp: SessionLaneGiveUp | null;
};

/** One session lane's view of its four durable `sync_state` lane-run columns. */
export class SessionLaneRun {
  private readonly options: SessionLaneRunOptions;

  private readonly durableRun: LaneRunRecord;

  /**
   * Whose row this lane has READ, and therefore whose row it may reconcile
   * against the gate.
   *
   * PLN-2028 premise correction 7 put this precondition here rather than in
   * {@link LaneRunRecord}: the tracker writes whatever it is handed for any
   * identity, deliberately, because {@link SessionLaneRun.clear} runs on a path
   * that has not necessarily adopted and a tracker-side refusal would silently
   * turn a recovered lane's clear into a no-op. So the lane owns the half that
   * genuinely needs guarding — a reconcile before hydration would clobber a run
   * this process has not read (ISS-5347) — and the clear deliberately bypasses
   * it, because an all-null write cannot clobber anything.
   */
  private consultedSourceKey: string | null = null;

  /**
   * Which lane identity the ANNOUNCED give-up belongs to. The announcement latch
   * is keyed by LANE, which is what bounds it — so it needs an identity-switch
   * clear, or one target's outstanding give-up masks the next target's.
   *
   * Compared as a LANE-RUN key (PLN-2028 D2), not as the live source key: that
   * key carries the negotiated monitored-activity revision, which a hello ack
   * can move without the lane changing at all. Comparing whole keys read every
   * such renegotiation as an account switch and dropped a latch that was still
   * current.
   */
  private announcedSourceKey: string | null = null;

  private giveUp: SessionLaneGiveUp | null = null;

  /** What the row held when this lane REFUSED to adopt it. */
  private unadoptedRun: UnadoptedLaneRun | null = null;

  constructor(options: SessionLaneRunOptions) {
    this.options = options;
    this.durableRun = new LaneRunRecord({
      getPersist: () => sourceLaneRunPersist(() => this.options.getSource()),
      onWriteFailed: (message) => this.options.onWriteFailed(message),
      // Nothing to reset: this lane's failure hook logs every dropped write
      // rather than only the transitions, so no outcome is being held that a
      // success would have to clear.
      onWriteSucceeded: () => undefined,
      onPersistUnavailable: () => undefined,
    });
  }

  /**
   * Resume the whole lane RUN the previous process recorded for this identity,
   * and note that the columns are now current so the next reconcile does not
   * write back values that are already there.
   *
   * THE ORIGIN IS WHY THIS EXISTS (ISS-10053). Resuming the give-up instant alone
   * leaves the 24h ceiling in memory, and an install that restarts inside a long
   * outage re-opens a run on every launch and never terminates.
   *
   * ISS-10043 IS THE OTHER HALF, and it is why the stamp is filtered while the
   * origin is not. Only a producer whose give-up is LANE-WIDE may become a gate
   * hold: a row-ceiling stamp says individual rows exhausted their own budgets,
   * and holding the whole lane for it is the bounce this ticket exists to stop.
   * The origin resumes either way — it measures the outage, not the verdict.
   */
  adopt(
    gate: LaneEnvironmentalDeferGate,
    persisted: PersistedLaneRunRead | null | undefined,
    nowMs: number
  ): void {
    const sourceKey = this.identity();
    if (sourceKey === null) {
      // Pre-hello: there is no lane identity to attribute a run to, and inventing
      // one would read a row a different target will later own.
      return;
    }
    // Hydration is where an identity switch is seen EARLIEST — before the new
    // target has failed or answered anything — and this stays AHEAD of the
    // announcement below: a latch still held for the PREVIOUS target would
    // swallow this one as a duplicate and then be dropped, so this target's
    // give-up would reach nobody at all.
    this.noteIdentity(sourceKey);
    const read = readLaneRunRecord(
      persisted ?? {},
      SyncLane.SessionMetadata,
      nowMs
    );
    for (const note of laneRunDefectNotes(read, persisted)) {
      this.options.onRunDefect(note.name, note.message);
    }
    // The believed COLUMN values are the raw instants, never the normalized
    // anchors: that divergence is what makes the repair below a genuine write
    // rather than an equality-gated no-op. The producer is the RESOLVED one (D3).
    this.durableRun.adopt(sourceKey, {
      stalledSinceMs: read.origin.storedMs,
      gaveUpAtMs: read.giveUp.storedMs,
      reason: read.reason,
      source: read.source,
    });
    this.consultedSourceKey = sourceKey;
    const rowGiveUp =
      read.giveUp.atMs === null
        ? null
        : { atMs: read.giveUp.atMs, reason: read.reason, source: read.source };
    const resumedHoldAtMs = laneRunResumesHold(
      SyncLane.SessionMetadata,
      read.source
    )
      ? read.giveUp.atMs
      : null;
    // PLN-2028 D4 governs more than the gate. A gate that REFUSED the record is
    // still holding the run THIS process saw, so taking the row's give-up would
    // replace a live cause with a stale one and disarm the anchor guard below.
    // What the ROW holds is remembered separately instead: refusing to adopt it
    // is not superseding it, and {@link reconcile} owes it the difference.
    if (
      gate.hydrateRun(
        { stalledSinceMs: read.origin.atMs, gaveUpAtMs: resumedHoldAtMs },
        nowMs
      )
    ) {
      this.unadoptedRun = null;
      this.giveUp = rowGiveUp;
      this.announceResumedGiveUp(gate, resumedHoldAtMs, nowMs);
    } else {
      this.unadoptedRun = { originMs: read.origin.atMs, giveUp: rowGiveUp };
    }
    this.repairFutureRun(gate, read);
  }

  /**
   * Record the gate's own environmental outcome — after EVERY
   * `deferLaneEnvironmental`, not only the ones that gave up.
   *
   * The origin is written on every failure because the origin IS the bound: a run
   * whose opening never reached the row is a run the next launch restarts from
   * zero, which is the whole ISS-10053 defect.
   *
   * A gate give-up SUPERSEDES a row-ceiling stamp already on record, and is
   * written as-is rather than anchored. The two claims are different in kind —
   * the gate says the WORLD has been broken for this lane for a day, the ceiling
   * says enough individual rows ran out their own budgets — so the lane-wide one
   * wins, and its re-stamp after a spent re-arm is exactly what bounds the next
   * re-arm window. Anchoring swallowed that re-stamp, so a relaunch measured the
   * window from the FIRST give-up of the run.
   *
   * AND IT IS ANNOUNCED HERE, as the component twin announces its own
   * (tamsinb review; operator decision 2026-09-17). Reached only from a resume
   * before, this producer's `sync.lane.gave_up` arrived only when the user
   * happened to restart inside the outage — so the `environmental_gate` bucket
   * of the very per-producer grouping M5 adds held nothing but relaunches, while
   * the lane that went terminal live said nothing at all. The latch is what makes
   * this once per TRANSITION rather than once per failure, and what keeps a
   * resumed announcement for the same run from counting twice.
   */
  noteEnvironmentalOutcome(
    gate: LaneEnvironmentalDeferGate,
    state: LaneEnvironmentalDeferState,
    reason: SyncReason
  ): void {
    if (state.givenUp && state.gaveUpAtMs !== null) {
      this.giveUp = {
        atMs: state.gaveUpAtMs,
        reason,
        source: laneGateGiveUpSource(SyncLane.SessionMetadata),
      };
      // The duration is this failure's run age, EXCEPT when the failure OPENED
      // the run it is reporting: a relaunch resumes the stamp without an origin,
      // so the first failure after it measures `0` on a give-up that is
      // genuinely over a day old. Reported as unmeasured rather than as an
      // instant, exactly as the twin does.
      this.announceGiveUp(state.opened ? null : state.elapsedMs);
    }
    this.reconcile(gate.runOriginMs());
  }

  /**
   * Record the PER-ROW ceiling's give-up — anchored to the one this lane already
   * HOLDS, and re-reconciled so a dropped write re-issues.
   *
   * This lane's ceiling is crossed per ROW, so through a long outage the rows
   * added at different times run out at different real instants and each fold
   * reports the instant it NOTICED. Writing every one of those would slide the
   * column forward for as long as the outage lasted, so the re-arm window would
   * measure the last fold rather than the give-up.
   *
   * A gate stamp counts as "already on record" too, and that direction is the
   * ISS-10043 one: a lane-wide give-up must not be demoted to a per-row ceiling
   * by the next staggered fold, because the producer decides whether a relaunch
   * resumes it as a hold.
   */
  noteRowCeilingGiveUp(
    gate: LaneEnvironmentalDeferGate,
    gaveUpAtMs: number,
    reason: SyncReason
  ): void {
    if (this.giveUp !== null) {
      // The only re-issue this lane gets: a believed value whose write failed is
      // forgotten so the next reconcile re-sends it (`LaneRunRecord`).
      this.reconcile(gate.runOriginMs());
      return;
    }
    this.giveUp = {
      atMs: gaveUpAtMs,
      reason,
      source: laneGiveUpSourceFor(
        SyncLane.SessionMetadata,
        LaneGiveUpSource.RowCeiling
      ),
    };
    this.reconcile(gate.runOriginMs());
  }

  /**
   * The lane ANSWERED — null all four columns in one write, and answer the
   * `sync.lane.gave_up` this lane emitted.
   *
   * IT WRITES FOR AN IDENTITY THIS LANE NEVER ADOPTED, deliberately (PLN-2028
   * premise correction 7). Both answers — a verified ack and a row-attributable
   * rejection — reach here through the fold-runner funnel, on a path that has not
   * necessarily hydrated; refusing the write there would leave a give-up on the
   * row for a lane that has demonstrably just recovered. An all-null write is the
   * one shape that cannot clobber a run this process has not read, because there
   * is no run left to clobber: the server judged this lane's bytes.
   *
   * No `trigger` on the re-arm: this lane's give-up does not end at a recovery
   * DOOR. The server judged its bytes, which is stronger evidence than either
   * door gives — naming one would assert the precise distinction that field
   * exists to keep. A silent no-op for a lane that never announced a give-up,
   * which is every healthy batch.
   */
  clear(): void {
    const sourceKey = this.identity();
    if (sourceKey === null) {
      return;
    }
    // Reached only for THIS identity's give-up: a latch belonging to a different
    // target is dropped here rather than answered, so a fresh identity's first
    // answered batch cannot report the previous account's outage as having ended.
    this.noteIdentity(sourceKey);
    this.giveUp = null;
    // The row's own run goes with it: the server judged this lane's bytes, which
    // supersedes anything a refused hydration left unadopted.
    this.unadoptedRun = null;
    this.consultedSourceKey = sourceKey;
    this.durableRun.reconcile(sourceKey, {
      stalledSinceMs: null,
      gaveUpAtMs: null,
      reason: null,
      source: null,
    });
    reportSyncLaneReArmed({
      lane: SyncLane.SessionMetadata,
      trigger: null,
      // Unmeasured on purpose: the stamp this lane holds is the durable column's
      // believed value, and a clear that raced a failed write reads `null` from
      // it. A fabricated `0` would report the outage as having lasted no time.
      gaveUpForMs: null,
    });
  }

  /**
   * Drop the identity — target switch, stop, or a hydration that could not reach
   * the durable row. That row belongs to a different (lane, compute target) pair,
   * and its give-up is not this one's to anchor against (invariant 2).
   */
  clearIdentity(): void {
    this.durableRun.clearIdentity();
    this.consultedSourceKey = null;
    this.giveUp = null;
    this.unadoptedRun = null;
  }

  /**
   * ISS-9418 / ISS-9963: this process is now HOLDING a give-up it never saw
   * happen, and it has to be able to say so.
   *
   * Without the announcement the latch stays empty for this lane, so the ack that
   * ends the outage reaches `reportSyncLaneReArmed` with nothing to answer and is
   * suppressed BY DESIGN — a relaunch mid-outage whose original `gave_up` was
   * dropped at a shut send gate then reports NEITHER half of the pair.
   *
   * The cause comes OFF THE ROW rather than being reported as unknown (ISS-9963).
   * It is still `null` when the row cannot supply one — a legacy row, or a value
   * this build does not recognise — and that absence is reported as absence.
   *
   * The DURATION is reported only for a give-up the gate actually resumed, which
   * is a gate-produced one. `lane_stalled_since` is the LANE's run clock, and a
   * row-ceiling give-up's age is per row: measuring one against the other would
   * be a fabricated reading on the field that says how long this install has been
   * unable to deliver. Read back off the gate rather than from the record, so an
   * unreadable or already-clamped origin reports exactly what the gate accepted.
   */
  private announceResumedGiveUp(
    gate: LaneEnvironmentalDeferGate,
    resumedHoldAtMs: number | null,
    nowMs: number
  ): void {
    this.announceGiveUp(
      resumedHoldAtMs === null ? null : gate.stallAgeMs(nowMs)
    );
  }

  /**
   * Announce the give-up this lane is holding — idempotent, and THE ONE PLACE
   * this event's shape is built.
   *
   * `reportSyncLaneGaveUp` latches on ACCEPTANCE, so a repeat is free once the
   * event has landed and is a genuine re-attempt while the send gate is shut —
   * which is the same connectivity loss that drove the run past its ceiling. That
   * is what lets both callers announce unconditionally instead of detecting the
   * edge, and what keeps a live give-up and the resume of the SAME run from
   * reporting twice.
   *
   * `stalledForMs` is the CALLER's, because only the caller knows whether the
   * number it holds is a measurement, and a `null` from either is "unmeasured"
   * rather than zero.
   */
  private announceGiveUp(stalledForMs: number | null): void {
    if (this.giveUp === null) {
      return;
    }
    reportSyncLaneGaveUp({
      lane: SyncLane.SessionMetadata,
      reason: this.giveUp.reason,
      source: this.giveUp.source,
      stalledForMs,
      // This producer holds no queue reading — the depth lives in the fold that
      // owns the rows, and died with the previous process for a resumed one — so
      // a count here would be fabricated on the only channel a give-up is
      // observed.
      itemsOwed: null,
      deadLetteredCount: null,
    });
  }

  /**
   * Rewrite a row whose instants were AHEAD of the clock, with the live run's.
   *
   * A future anchor makes every elapsed reading measure zero for as long as the
   * skew lasts, which removes the widening recovery door by arithmetic. Issued
   * whether or not the gate took the record, as in the twin: a refusal leaves
   * the same unusable value for the next launch to read.
   */
  private repairFutureRun(
    gate: LaneEnvironmentalDeferGate,
    read: LaneRunRecordRead
  ): void {
    if (
      read.origin.defect === LaneGiveUpStampDefect.Future ||
      read.giveUp.defect === LaneGiveUpStampDefect.Future
    ) {
      this.reconcile(gate.runOriginMs());
    }
  }

  /**
   * Bring the four columns into step with the gate. Writes only on a genuine
   * change — a healthy lane answers on every accepted batch and must not pay a
   * SQLite write for saying so again.
   *
   * Refused for an identity this lane has not READ, which is the ISS-5347 half of
   * premise correction 7: the gate reads empty for a fresh identity, and writing
   * that before hydration would clobber a run the lane has not consulted.
   *
   * A cause and a producer are written ONLY beside a give-up, because the same
   * rule governs the read (`readLaneRunRecord`) and a row that disagreed with it
   * would let a later process announce a give-up this lane is not holding.
   *
   * AND IT NEVER LOWERS DURABLE EVIDENCE THIS PROCESS DID NOT SUPERSEDE. A
   * refused hydration (D4) leaves the row holding a run this lane deliberately
   * did not take, so the record written is the live state MERGED over it: the
   * earlier of the two origins, because the outage began when the row says it
   * began and refusing the record did not end it, and the row's give-up wherever
   * this process is holding none of its own. A live give-up still supersedes — it
   * is this lane giving up, not erasing somebody else's — and the clear still
   * clears, because the server answering is the one thing that ends the run.
   */
  private reconcile(originMs: number | null): void {
    const sourceKey = this.identity();
    if (sourceKey === null) {
      return;
    }
    this.noteIdentity(sourceKey);
    if (sourceKey !== this.consultedSourceKey) {
      return;
    }
    const giveUp = this.giveUp ?? this.unadoptedRun?.giveUp ?? null;
    this.durableRun.reconcile(sourceKey, {
      stalledSinceMs: earlierRunOrigin(
        originMs,
        this.unadoptedRun?.originMs ?? null
      ),
      gaveUpAtMs: giveUp?.atMs ?? null,
      reason: giveUp?.reason ?? null,
      source: giveUp?.source ?? null,
    });
  }

  /** The `sync_state` row this lane's run lives on, or `null` pre-hello. */
  private identity(): string | null {
    const sourceKey = this.options.readSourceKey();
    return sourceKey ? buildLaneRunSourceKey(sourceKey) : null;
  }

  /**
   * Note which identity the lane is acting for, dropping what was ANNOUNCED for a
   * different one.
   *
   * No `rearmed` on the switch: the previous target's outage did not end, this
   * machine simply stopped being the one collecting for it. A CHANGE, never a
   * first sighting — the lane's own give-up is announced moments after this
   * resolves the same identity, so treating the first key as a switch would drop
   * the latch for the announcement that is about to be made.
   */
  private noteIdentity(sourceKey: string): void {
    const previousSourceKey = this.announcedSourceKey;
    this.announcedSourceKey = sourceKey;
    if (previousSourceKey === null || previousSourceKey === sourceKey) {
      return;
    }
    clearSyncLaneGiveUpAnnouncement(SyncLane.SessionMetadata);
  }
}

/**
 * The origin a write may claim when the live run and an UNADOPTED row both name
 * one: the earlier of the two.
 *
 * The same outage that began earlier is still that outage — a process that
 * refused the row did not end that run, it only failed to see it start — so
 * writing the live origin over an older one shortens the very duration ISS-10053
 * exists to carry across a relaunch, and hands the next launch a ceiling that is
 * further away than the truth.
 */
function earlierRunOrigin(
  liveMs: number | null,
  rowMs: number | null
): number | null {
  if (liveMs === null) {
    return rowMs;
  }
  if (rowMs === null) {
    return liveMs;
  }
  return Math.min(liveMs, rowMs);
}
