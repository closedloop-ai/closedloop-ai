/**
 * @file transcript-lane-give-up.ts
 * @description ISS-9884 (PLN-1986 §4 and §5): the transcript archive lane's
 * LANE give-up and its recovery door, on ISS-9418's shared give-up shape.
 *
 * A lane-wide failure does not advance a row's `retryCount` (invariant 4); the
 * row's durable `lane_stalled_since` bounds it instead (invariant 5). But the
 * terminal that bound reaches is an ACK-GATED skip, so an outage that refuses the
 * skip as well as the upload (a 401, a coded 403, the org policy off, the cloud
 * unreachable) never lets a row reach `dead`: past the ceiling it re-POSTs on the
 * capped hourly rung for as long as the outage lasts. The give-up ends that. Once
 * the lane has given up the drain holds, and rows keep `failed` + `last_error` +
 * `lane_stalled_since` — the honest state — with no owed row charged for it.
 *
 * The ceiling is crossed per ROW here, and that decides the shape:
 *
 * - The give-up is entered off a row's own durable clock through the shared
 *   `laneGiveUpState`, never off a run a gate opens in memory. The
 *   {@link LaneEnvironmentalDeferGate} is used for its give-up state alone — the
 *   hydrate, the two doors, the one-attempt credit, the widening window — and its
 *   pacing is unused, because every row paces on its own schedule.
 * - The stamp is ANCHORED to the first crossing (`LaneRunRecord.anchorGiveUp`).
 *   Crossings stagger across an outage, and a later row's crossing that moved the
 *   stamp would make the re-arm window measure the last fold instead of the
 *   give-up. The one write that may move a recorded stamp is the re-stamp earned
 *   by the failure of the attempt a re-arm bought.
 *
 * Every door REVIVES the rows the give-up paused, not only the lane (PLN-1986
 * D-5). Where the outage spares the skip route — `TRANSCRIPTS_BUCKET` unset, the
 * common case — each row is acked `dead` with `terminal_skip_reason =
 * environment_unavailable` as its own clock crosses, and a `dead` row is invisible
 * to `listReady`. A door that only cleared the stamp would re-open a drain with
 * nothing in it, and the merged "It resumes automatically once that's restored"
 * would stay false. So a revival is owed by a re-arm (window or event), by an
 * answer that ends a give-up, and by the first hydration of an identity with no
 * give-up on record — the last covering rows whose stamp write never landed. It
 * runs before the drain pass the door opens, and revives only the rows that
 * pass's OWN compute target paused: the drain uploads a revived row under that
 * target, so a row another account or target paused, or one paused before the
 * row recorded its target, is not this identity's to revive. A revived row's run
 * restarts at its next failure, but it cannot buy an unbounded one: that failure
 * re-stamps the lane.
 *
 * Nothing here emits telemetry. The `sync.lane.gave_up` / `sync.lane.rearmed`
 * producer for this lane is out of scope for ISS-9884, so
 * `SyncLane.TranscriptArchive` stays `Unclassified` in both give-up telemetry
 * maps and this give-up is visible in the log and the durable column only.
 */

import {
  LaneGiveUpStampDefect,
  type LaneGiveUpStampRead,
  laneGiveUpState,
  readLaneGiveUpStamp,
} from "../../shared/lane-give-up.js";
import type { TranscriptLaneRecoveryStore } from "../database/transcript-lane-recovery-delegates.js";
import { LaneEnvironmentalDeferGate } from "../sync/lane-environmental-defer.js";
import {
  LaneRunRecord,
  laneGiveUpStampOnly,
  sourceLaneGiveUpStampPersist,
} from "../sync/lane-run-record.js";
import { TranscriptSyncClientError } from "../transcript/desktop-transcripts-client.js";

/**
 * The transcript lane's `sync_state.source_key` kind. Its own prefix, so the row
 * can never be read as a session or component cursor (invariant 2), and with NO
 * payload-revision segment: that segment is a cursor-invalidation lever, this
 * lane has no cursor, and carrying one would reset the give-up on every bump.
 */
export const TRANSCRIPT_ARCHIVE_SYNC_SOURCE_KIND =
  "transcript_archive" as const;

export type TranscriptLaneGiveUpDeps = {
  /**
   * Re-resolved per durable write, never captured: the db-host source is a proxy
   * that goes null while the host restarts.
   */
  getStore: () => TranscriptLaneRecoveryStore | null;
  log: (message: string) => void;
};

/** One failed attempt, as the give-up needs to see it. */
export type TranscriptLaneFailure = {
  error: unknown;
  laneWide: boolean;
  /** The row's run origin — the failure instant when this failure opens it. */
  stalledSince: string;
  now: string;
  /** The target the attempt ran against, snapshotted before it. */
  computeTargetId: string | null;
};

/** One transcript lane's give-up, for the compute target it last hydrated. */
export class TranscriptLaneGiveUp {
  private readonly deps: TranscriptLaneGiveUpDeps;

  private readonly gate = new LaneEnvironmentalDeferGate();

  private readonly stamp: LaneRunRecord;

  /** The identity whose durable row has been consulted, or `null` before it. */
  private hydratedSourceKey: string | null = null;

  /** The hydration in flight, so overlapping drains read the row once. */
  private pendingHydration: {
    sourceKey: string;
    done: Promise<boolean>;
  } | null = null;

  /** A door has opened and the paused rows have not been revived for it yet. */
  private revivalOwed = false;

  /**
   * A recovery event no hydrated gate has taken yet. Latched, because the gate is
   * rebuilt per identity: `readStamp` resets it before adopting the durable
   * stamp, so an event landing before this process's first hydration, while one
   * is pending, or ahead of a target switch the drain has not seen would be wiped,
   * and the lane would sit out its window.
   */
  private recoverySignalPending = false;

  /** The give-up whose re-arm has already been noted, so it revives once. */
  private reArmedStampMs: number | null = null;

  /** Transition latches, so a persistently failing read logs once, not per tick. */
  private hydrateFailing = false;

  private revivalFailing = false;

  constructor(deps: TranscriptLaneGiveUpDeps) {
    this.deps = deps;
    this.stamp = new LaneRunRecord({
      getPersist: () =>
        sourceLaneGiveUpStampPersist(() => this.deps.getStore()),
      onWriteFailed: (message) =>
        this.deps.log(
          `transcript lane give-up write failed: ${message}; this process still holds the lane, and a relaunch before the next write re-derives the give-up from the rows' own clocks`
        ),
      // Every failure above is logged, so there is no held outcome to reset.
      onWriteSucceeded: () => undefined,
      onPersistUnavailable: () =>
        this.deps.log(
          "transcript lane give-up write skipped: no store is available; the give-up is in-memory until the next write"
        ),
    });
  }

  /**
   * Hold this drain pass? `true` means attempt nothing.
   *
   * Runs what the pass needs in order: consult the identity's durable stamp,
   * then — when a door has opened — revive the rows the give-up paused, so the
   * ready read that follows has them. A stamp that could not be READ holds
   * nothing: an unread stamp adopts nothing, exactly as an unreadable one does.
   */
  async holdDrain(
    store: TranscriptLaneRecoveryStore,
    computeTargetId: string | null,
    now: string
  ): Promise<boolean> {
    if (computeTargetId === null) {
      return false;
    }
    const nowMs = Date.parse(now);
    const sourceKey = buildTranscriptSyncSourceKey(computeTargetId);
    if (!(await this.hydrate(store, sourceKey, nowMs))) {
      return false;
    }
    if (this.recoverySignalPending) {
      // Taken by the identity this pass runs under, now that its stamp is read.
      this.recoverySignalPending = false;
      this.gate.noteRecoverySignal();
    }
    if (this.gate.isGivenUp(nowMs)) {
      return true;
    }
    this.noteReArm(nowMs);
    await this.reviveIfOwed(store, now, computeTargetId);
    return false;
  }

  /**
   * Fold one failed attempt. A lane-wide one may cross its row's ceiling, or
   * spend the attempt a re-arm bought; one the server ANSWERED — any status that
   * is not lane-wide, including a row-attributable 4xx — proves the lane is
   * reachable and ends the give-up. A local throw with no status says nothing
   * about the lane either way.
   */
  noteFailure(failure: TranscriptLaneFailure): void {
    const sourceKey = this.ownedSourceKey(failure.computeTargetId);
    if (sourceKey === null) {
      return;
    }
    if (failure.laneWide) {
      this.noteLaneWideFailure(
        sourceKey,
        Date.parse(failure.stalledSince),
        Date.parse(failure.now)
      );
      return;
    }
    if (
      failure.error instanceof TranscriptSyncClientError &&
      failure.error.status !== undefined
    ) {
      this.noteAnswered(sourceKey);
    }
  }

  /** A successful attempt: the server answered, so the give-up is over. */
  noteLaneAnswered(computeTargetId: string | null): void {
    const sourceKey = this.ownedSourceKey(computeTargetId);
    if (sourceKey !== null) {
      this.noteAnswered(sourceKey);
    }
  }

  /**
   * The event door: a precondition this lane may have given up on changed
   * (org-policy transition, consent tier, sign-in). Buys exactly one attempt when
   * the lane has given up, and owes a revival either way — a revival that finds
   * nothing is one cheap write, and events are rare by construction.
   *
   * Latched, not applied here: the next pass to read its identity's stamp takes
   * it, so the attempt it buys belongs to the identity that pass runs under.
   */
  noteLaneRecoverySignal(): void {
    this.recoverySignalPending = true;
    this.revivalOwed = true;
  }

  private hydrate(
    store: TranscriptLaneRecoveryStore,
    sourceKey: string,
    nowMs: number
  ): Promise<boolean> {
    if (this.hydratedSourceKey === sourceKey) {
      return Promise.resolve(true);
    }
    if (this.pendingHydration?.sourceKey !== sourceKey) {
      this.pendingHydration = {
        sourceKey,
        done: this.readStamp(store, sourceKey, nowMs),
      };
    }
    return this.pendingHydration.done;
  }

  /**
   * Adopt `sourceKey`'s durable give-up. A first pass or a compute-target switch
   * alike: what is in memory belongs to another identity's row (invariant 2), so
   * none of it survives — which is also why a switch needs no explicit clear.
   */
  private async readStamp(
    store: TranscriptLaneRecoveryStore,
    sourceKey: string,
    nowMs: number
  ): Promise<boolean> {
    this.gate.reset();
    this.stamp.clearIdentity();
    this.hydratedSourceKey = null;
    this.reArmedStampMs = null;
    let laneGaveUpAt: string | null;
    try {
      laneGaveUpAt = await store.loadLaneGiveUp(sourceKey);
    } catch (error) {
      this.pendingHydration = null;
      if (!this.hydrateFailing) {
        this.hydrateFailing = true;
        this.deps.log(
          `transcript lane give-up read failed: ${errorMessage(error)}; the drain proceeds without it and re-reads next pass`
        );
      }
      return false;
    }
    this.pendingHydration = null;
    this.hydrateFailing = false;
    const read = readLaneGiveUpStamp(laneGaveUpAt ?? undefined, nowMs);
    this.noteStampDefect(read, laneGaveUpAt);
    // The believed COLUMN value is the raw one, so the future-stamp repair below
    // is a real write rather than an equality-gated no-op.
    this.stamp.adopt(sourceKey, laneGiveUpStampOnly(read.storedMs));
    this.gate.hydrateGiveUp(read.gaveUpAtMs, nowMs);
    this.hydratedSourceKey = sourceKey;
    const gaveUpAtMs = this.gate.giveUpStampMs();
    if (read.defect === LaneGiveUpStampDefect.Future) {
      this.stamp.reconcile(sourceKey, laneGiveUpStampOnly(gaveUpAtMs));
    }
    if (gaveUpAtMs === null) {
      // Nothing on record says this target's environment is still broken, so the
      // rows it paused whose stamp write never landed get one attempt. If it is
      // still broken they fail, cross again and re-stamp.
      this.revivalOwed = true;
    } else {
      this.deps.log(
        `transcript lane resumed a give-up recorded at ${isoInstant(gaveUpAtMs)}; the drain holds until a recovery door opens`
      );
    }
    return true;
  }

  private noteStampDefect(
    read: LaneGiveUpStampRead,
    laneGaveUpAt: string | null
  ): void {
    if (read.defect === LaneGiveUpStampDefect.Unreadable) {
      this.deps.log(
        `transcript lane give-up stamp was unreadable (${laneGaveUpAt}); the lane resumes attempting and re-stamps if the outage is still on`
      );
    }
    if (read.defect === LaneGiveUpStampDefect.Future) {
      this.deps.log(
        `transcript lane give-up stamp was ahead of the clock (${laneGaveUpAt}); normalized to now and rewritten so the re-arm window measures from a real instant`
      );
    }
  }

  /** A given-up lane a door has re-armed owes the revival once per give-up. */
  private noteReArm(nowMs: number): void {
    const gaveUpAtMs = this.gate.giveUpStampMs();
    if (gaveUpAtMs === null || this.reArmedStampMs === gaveUpAtMs) {
      return;
    }
    this.reArmedStampMs = gaveUpAtMs;
    this.revivalOwed = true;
    this.deps.log(
      `transcript lane re-armed by ${this.gate.reArmTrigger(nowMs) ?? "a recovery door"}: one attempt, after reviving the rows paused on environment_unavailable`
    );
  }

  private async reviveIfOwed(
    store: TranscriptLaneRecoveryStore,
    now: string,
    computeTargetId: string
  ): Promise<void> {
    if (!this.revivalOwed) {
      return;
    }
    // Cleared before the await so an overlapping drain does not issue it twice.
    this.revivalOwed = false;
    try {
      const revived = await store.reviveEnvironmentUnavailableDeadLetters(
        now,
        computeTargetId
      );
      this.revivalFailing = false;
      if (revived > 0) {
        this.deps.log(
          `transcript lane revived ${revived} row(s) paused on environment_unavailable`
        );
      }
    } catch (error) {
      this.revivalOwed = true;
      if (!this.revivalFailing) {
        this.revivalFailing = true;
        this.deps.log(
          `transcript lane revival failed: ${errorMessage(error)}; retrying next pass`
        );
      }
    }
  }

  private noteLaneWideFailure(
    sourceKey: string,
    stalledSinceMs: number,
    nowMs: number
  ): void {
    const recordedMs = this.gate.giveUpStampMs();
    if (recordedMs !== null) {
      // Given up already. If a door had re-armed the lane this failure spent its
      // one attempt, and the gate re-stamps here and widens the next window. If
      // not, the gate changes nothing: an in-flight sibling of the pass that
      // already re-stamped, or a later row crossing, must not move the anchor.
      this.gate.noteEnvironmentalFailure(nowMs);
      const restampedMs = this.gate.giveUpStampMs();
      if (restampedMs !== recordedMs) {
        this.stamp.reconcile(sourceKey, laneGiveUpStampOnly(restampedMs));
        this.deps.log(
          `transcript lane gave up again at ${isoInstant(nowMs)}: the attempt a re-arm bought failed lane-wide`
        );
      }
      return;
    }
    if (!laneGiveUpState({ stalledSinceMs, gaveUpAtMs: null, nowMs }).givenUp) {
      return;
    }
    // Entered through the gate's durable-adoption seam, not its failure fold: the
    // ceiling this lane measures lives on the ROW, and the fold would measure a
    // run the gate opened in memory instead.
    this.gate.hydrateGiveUp(nowMs, nowMs);
    this.stamp.anchorGiveUp(sourceKey, nowMs);
    this.deps.log(
      `transcript lane GAVE UP at ${isoInstant(nowMs)}: a row's lane-wide run crossed the 24h ceiling; the drain holds until a recovery door opens`
    );
  }

  private noteAnswered(sourceKey: string): void {
    const heldGiveUp = this.gate.giveUpStampMs() !== null;
    this.gate.noteLaneAnswered();
    // Equality-gated, so a healthy lane pays no write for answering again.
    this.stamp.reconcile(sourceKey, laneGiveUpStampOnly(null));
    if (!heldGiveUp) {
      return;
    }
    this.reArmedStampMs = null;
    this.revivalOwed = true;
    this.deps.log(
      "transcript lane answered: give-up cleared; rows paused on environment_unavailable are revived before the next pass"
    );
  }

  /** The hydrated identity, when `computeTargetId` is it; `null` otherwise. */
  private ownedSourceKey(computeTargetId: string | null): string | null {
    if (computeTargetId === null || this.hydratedSourceKey === null) {
      return null;
    }
    const sourceKey = buildTranscriptSyncSourceKey(computeTargetId);
    return sourceKey === this.hydratedSourceKey ? sourceKey : null;
  }
}

/**
 * The durable give-up key for one compute target. A different target is a
 * different row, which is how a switch re-scopes the give-up (invariant 2).
 */
export function buildTranscriptSyncSourceKey(computeTargetId: string): string {
  return `${TRANSCRIPT_ARCHIVE_SYNC_SOURCE_KIND}:${computeTargetId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isoInstant(ms: number): string {
  return new Date(ms).toISOString();
}
