/**
 * @file lane-run-record.ts
 * @description PLN-2028 (ISS-10053, ISS-9963, ISS-10043): the durable half of a
 * lane's environmental RUN — keeping the four `sync_state` lane-run columns in
 * step with the in-memory gate, and no more often than that.
 *
 * `LaneEnvironmentalDeferGate` decides when a lane opens a run and when it gives
 * up; migration 0091 supplies where that survives a relaunch. This is the seam
 * between them, and it exists as its own module for two reasons. The component
 * lane it first serves has no headroom to absorb it. And the session lane needs
 * the identical bookkeeping against the identical row under a different
 * `source_key` prefix — two copies of "write it only when it changed" is exactly
 * the SSOT drift this repo keeps paying for. For the same reason it owns the
 * persist derivations: how a clone-safe write is derived from a `source` is ONE
 * decision, and the ISS-4620 crash is what a second copy of it costs.
 *
 * THE WRITE IS ACKNOWLEDGED, because the origin IS the bound — a lost one does
 * not delay the ceiling, it removes it: the next launch opens a fresh 24h run and
 * a desktop restarting inside an outage never reaches the terminal path at all.
 * So a rejected write is re-attempted once with the identical record (PLN-2028
 * D5), writes are serialized per tracker so a clear can never be overtaken by the
 * write it supersedes, and a re-attempt that a newer record has overtaken is
 * DROPPED rather than landed — a stale retry arriving after a clear would
 * resurrect a run the lane has already ended.
 *
 * WHAT IT IS NOT: a queue or an unbounded retry ladder. After the single
 * re-attempt the failure is NAMED rather than thrown, the believed value is
 * forgotten so the next reconcile re-issues, and the in-memory gate still governs
 * this process either way.
 */

import type {
  LaneGiveUpSource,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import type { PersistedLaneRun } from "../agent-sync/sync-cursor-state-source.js";

/**
 * What a lane believes its four lane-run columns hold, in the units the gate
 * speaks. `null` means the column is CLEAR, never unknown — the tracker's own
 * "unknown" is having no belief for the identity at all.
 */
export type LaneRunState = {
  stalledSinceMs: number | null;
  gaveUpAtMs: number | null;
  reason: SyncReason | null;
  source: LaneGiveUpSource | null;
};

/** The clone-safe durable write a lane derives from its source. */
export type LaneRunPersist = (
  sourceKey: string,
  run: PersistedLaneRun
) => void | Promise<void>;

export type LaneRunRecordOptions = {
  /**
   * Re-resolved on every write, never captured. The DB-host source is a proxy
   * that goes null while the host restarts, and a null captured once would
   * silently disable the durable write for the life of the lane — the ISS-5347
   * cursor freeze, in a second place.
   */
  getPersist: () => LaneRunPersist | undefined;
  /** Name a dropped write. Transition-logged by the caller, not per attempt. */
  onWriteFailed: (message: string) => void;
  /**
   * The write LANDED — reported because `onWriteFailed` above is
   * transition-logged. A logger that fires only on a CHANGED outcome swallows
   * the second, genuinely new failure for as long as nothing tells it the first
   * one ended, so this reset is what keeps a RECURRING persist failure
   * reportable. A caller whose failure hook logs unconditionally has nothing to
   * reset and says so with a no-op.
   */
  onWriteSucceeded: () => void;
  /** Name a lane that has no durable lane-run write available at all. */
  onPersistUnavailable: () => void;
};

/**
 * Tracks what this lane's four lane-run columns currently say, so the gate's
 * state can be reconciled against them on every environmental outcome without
 * issuing a write on every tick.
 *
 * Scoped to a `sourceKey`: an identity change is a different lane, and adopting
 * one lane's run as another's is the invariant-2 defect the cursor identity
 * guards already exist for. (PLN-2028 D2: the store keys the record by (lane,
 * compute target), so a session capability flip that only changes the key reaches
 * the same row and costs this tracker one redundant write.)
 */
export class LaneRunRecord {
  private readonly options: LaneRunRecordOptions;

  /**
   * Whose row this tracker has an opinion about — tracked SEPARATELY from the
   * believed value below, and that separation is load-bearing. A failed write
   * forgets what the columns hold but not which identity was consulted, so the
   * next reconcile re-issues the write instead of being refused as un-hydrated.
   */
  private consultedSourceKey: string | null = null;

  /** What the columns are believed to hold, or `null` when nothing is known. */
  private believed: LaneRunState | null = null;

  /**
   * Which write is the CURRENT one. A re-attempt carrying an older sequence has
   * been superseded and is dropped: landing it would rewrite a record the lane
   * has already moved past, and after a clear that means resurrecting a run.
   */
  private issuedSeq = 0;

  /**
   * The write chain, so writes are serialized per tracker (D5). Only the FIRST
   * write of a tracker's life reaches the store synchronously; the chain is never
   * reset, so every later write is queued behind it. That ordering is what stops
   * a clear racing the give-up it replaces.
   */
  private inFlight: Promise<void> | null = null;

  constructor(options: LaneRunRecordOptions) {
    this.options = options;
  }

  /**
   * Adopt the record just read off disk for `sourceKey`, without writing it back.
   *
   * A hydration is the one moment the columns are known to be current, so
   * recording them here is what stops the very next reconcile from re-writing
   * values that are already there.
   */
  adopt(sourceKey: string, run: LaneRunState): void {
    this.consultedSourceKey = sourceKey;
    this.believed = run;
  }

  /**
   * Drop the identity — target switch, stop, or a hydration that could not
   * consult the durable row. The next reconcile then writes unconditionally,
   * because nothing is known about the new row.
   */
  clearIdentity(): void {
    this.consultedSourceKey = null;
    this.believed = null;
  }

  /**
   * Write `run` for `sourceKey` if and only if it differs from what the columns
   * are believed to hold.
   *
   * Called after every environmental outcome, which on a healthy lane is every
   * accepted batch — hence the equality gate. Without it a lane that never gives
   * up would issue one redundant SQLite write per successful send, on the same
   * single-connection queue every other lane's writes serialize behind.
   *
   * The believed value is updated OPTIMISTICALLY and forgotten if the write and
   * its one re-attempt both fail, so the equality gate can never suppress a
   * re-issue of a record that never reached the columns.
   *
   * The CALLER owns the precondition that the durable row has been consulted for
   * this key. The gate reads empty for a fresh identity, and writing that before
   * hydration would clobber a run the lane has not read yet.
   */
  reconcile(sourceKey: string, run: LaneRunState): void {
    if (
      this.consultedSourceKey === sourceKey &&
      this.believed !== null &&
      sameLaneRun(this.believed, run)
    ) {
      return;
    }
    if (!this.options.getPersist()) {
      this.options.onPersistUnavailable();
      return;
    }
    this.consultedSourceKey = sourceKey;
    this.believed = run;
    this.issuedSeq += 1;
    this.dispatch(sourceKey, toPersistedLaneRun(run), this.issuedSeq);
  }

  /**
   * Stamp a give-up ANCHORED to the first one on record for `sourceKey`: a stamp
   * this lane already holds wins over `gaveUpAtMs`.
   *
   * For a lane whose ceiling is crossed per ROW rather than lane-wide — the
   * session lane, whose per-row stall origins stagger across a long outage —
   * every later dead-letter fold would otherwise re-anchor the column to the
   * instant it NOTICED. The stamp then slides forward for as long as the outage
   * lasts, so the re-arm window measures the last fold rather than the give-up,
   * which is the durable-column version of the unbounded retry.
   *
   * The rest of the believed record is carried through unchanged, so anchoring a
   * stamp can never clear a run origin or a producer written beside it.
   *
   * A believed give-up of `null` is NOT an anchor — never hydrated, cleared by an
   * answer, or forgotten by a failed write all mean nothing is on record to hold,
   * so `gaveUpAtMs` is written. Anchoring to a value that never landed would
   * anchor to a fiction.
   */
  anchorGiveUp(sourceKey: string, gaveUpAtMs: number): void {
    const held = this.consultedSourceKey === sourceKey ? this.believed : null;
    this.reconcile(sourceKey, {
      stalledSinceMs: held?.stalledSinceMs ?? null,
      gaveUpAtMs: held?.gaveUpAtMs ?? gaveUpAtMs,
      reason: held?.reason ?? null,
      source: held?.source ?? null,
    });
  }

  /**
   * Serialize this write behind any in-flight one (D5). The chain is never
   * cleared, so only a tracker's FIRST write is issued synchronously and every
   * later one is deferred by a microtask — which is why {@link attempt}
   * re-resolves the persist instead of trusting the caller's check.
   *
   * The terminal `catch` is what keeps the chain ALIVE. {@link attempt} names a
   * refusal rather than throwing, but it names it through the caller's hooks, and
   * one of those throwing would leave `inFlight` REJECTED — after which every
   * later `.then(attempt)` propagates that rejection without ever running its own
   * attempt, so one bad log line ends this lane's durable writes for the life of
   * the process (tamsinb review). Swallowed rather than reported because the
   * hooks are the only channel there is and one of them is what threw.
   */
  private dispatch(
    sourceKey: string,
    record: PersistedLaneRun,
    seq: number
  ): void {
    const attempt = () => this.attempt(sourceKey, record, seq, 0);
    this.inFlight = (
      this.inFlight ? this.inFlight.then(attempt) : attempt()
    ).catch(() => undefined);
  }

  /**
   * One durable write, with the single acknowledged re-attempt the run origin
   * owes (D5). A failed WRITE never throws: a lane-run write is best-effort
   * against an in-memory gate that governs this process either way, so a refusal
   * is NAMED and must not take down the tick that issued it. A caller hook that
   * throws is contained by {@link dispatch}.
   */
  private async attempt(
    sourceKey: string,
    record: PersistedLaneRun,
    seq: number,
    attemptsMade: number
  ): Promise<void> {
    // Re-resolved per attempt, not captured: the db host may have come back
    // between the rejection and the re-attempt, which is the case the re-attempt
    // exists for.
    const persist = this.options.getPersist();
    if (!persist) {
      // The SAME condition `reconcile` reports, reached later because a chained
      // write re-resolves the delegate. It owes the operator that outcome and not
      // the write-FAILED one, or one incident reads as two different ones
      // depending on when the db host went down. The belief is still forgotten:
      // it was recorded optimistically for a write that never happened.
      this.forgetBelief(sourceKey, seq);
      this.options.onPersistUnavailable();
      return;
    }
    const failure = await laneRunPersistFailure(persist, sourceKey, record);
    if (failure === null) {
      // Reported OUTSIDE the write's own catch. Inside it, a success hook that
      // threw was read as a rejected write and re-issued a persist that had
      // already landed (tamsinb review).
      this.options.onWriteSucceeded();
      return;
    }
    if (seq !== this.issuedSeq) {
      // Superseded while in flight. Re-attempting would land a record the lane
      // has already moved past — after a clear, that resurrects the run.
      return;
    }
    if (attemptsMade === 0) {
      await this.attempt(sourceKey, record, seq, 1);
      return;
    }
    this.noteWriteFailed(sourceKey, failure, seq);
  }

  /** A dropped write leaves the columns BEHIND the gate, so say so. */
  private noteWriteFailed(
    sourceKey: string,
    message: string,
    seq: number
  ): void {
    this.forgetBelief(sourceKey, seq);
    this.options.onWriteFailed(message);
  }

  /**
   * Forget what the columns were believed to hold, so the next reconcile
   * re-issues rather than comparing against values that never landed. Scoped to
   * the write that is still CURRENT — a superseded one describes a record the
   * lane has already moved past — and the consulted identity is KEPT, so the
   * re-issue is not mistaken for a write before hydration.
   */
  private forgetBelief(sourceKey: string, seq: number): void {
    if (this.consultedSourceKey === sourceKey && seq === this.issuedSeq) {
      this.believed = null;
    }
  }
}

/** A `source`-shaped object that MAY carry a durable lane-run write. */
export type LaneRunPersistSource = {
  recordLaneRun?: (
    sourceKey: string,
    run: PersistedLaneRun
  ) => void | Promise<void>;
  recordLaneGiveUp?: (
    sourceKey: string,
    gaveUpAt: string | null
  ) => void | Promise<void>;
};

/**
 * The record a producer that only knows its give-up INSTANT writes — the stamp
 * alone, with no run origin, cause or producer claimed.
 *
 * Named rather than spelled out at each call site so "stamp-only" is one shape:
 * a caller that spread three `null`s by hand would be asserting the other three
 * columns are clear, which for a lane that does record them is a silent erase.
 */
export function laneGiveUpStampOnly(gaveUpAtMs: number | null): LaneRunState {
  return {
    stalledSinceMs: null,
    gaveUpAtMs,
    reason: null,
    source: null,
  };
}

/**
 * Derive the clone-safe whole-record write from a `source`-shaped object,
 * re-resolved per call.
 *
 * ONE copy of the ISS-4620 hazard on purpose. The DB-host source is a proxy that
 * resolves every property it does not know to an op PATH, so calling THROUGH
 * `source` is what keeps the posted arguments clone-safe and a `.bind` here is
 * the fatal crash.
 */
export function sourceLaneRunPersist(
  getSource: () => LaneRunPersistSource | null
): LaneRunPersist | undefined {
  const source = getSource();
  if (!source?.recordLaneRun) {
    return undefined;
  }
  return (key, run) => source.recordLaneRun?.(key, run);
}

/**
 * The same derivation against the stamp-only store alias, for a producer that
 * has not been moved onto the whole record yet (the session lane, until PLN-2028
 * M4).
 *
 * It writes `lane_gave_up_at` and nothing else, which is the point: a lane that
 * does not yet compute an origin, cause or producer must not send three `null`s
 * that CLEAR columns another writer may own. Delete this with its last caller.
 */
export function sourceLaneGiveUpStampPersist(
  getSource: () => LaneRunPersistSource | null
): LaneRunPersist | undefined {
  const source = getSource();
  if (!source?.recordLaneGiveUp) {
    return undefined;
  }
  return (key, run) => source.recordLaneGiveUp?.(key, run.laneGaveUpAt);
}

function sameLaneRun(left: LaneRunState, right: LaneRunState): boolean {
  return (
    left.stalledSinceMs === right.stalledSinceMs &&
    left.gaveUpAtMs === right.gaveUpAtMs &&
    left.reason === right.reason &&
    left.source === right.source
  );
}

/**
 * The record as the store takes it. Every field is named, so a write is a record
 * and never a patch.
 *
 * A non-finite instant becomes `null` rather than reaching `toISOString`, which
 * throws on one — and the store REFUSES an empty or unparseable value outright
 * (`assertWritableLaneRunColumns`), so a fabricated stamp could not be persisted
 * even if it got this far. `null` is the honest answer: the column is clear.
 */
function toPersistedLaneRun(run: LaneRunState): PersistedLaneRun {
  return {
    laneStalledSince: isoInstantOrNull(run.stalledSinceMs),
    laneGaveUpAt: isoInstantOrNull(run.gaveUpAtMs),
    laneGaveUpReason: run.reason,
    laneGaveUpSource: run.source,
  };
}

function isoInstantOrNull(atMs: number | null): string | null {
  return atMs === null || !Number.isFinite(atMs)
    ? null
    : new Date(atMs).toISOString();
}

/**
 * Run one durable write and answer with the message it was REFUSED with, or
 * `null` when it landed.
 *
 * The catch covers the persist and nothing else, so what the caller does with
 * either outcome cannot be mistaken for the write's own.
 */
async function laneRunPersistFailure(
  persist: LaneRunPersist,
  sourceKey: string,
  record: PersistedLaneRun
): Promise<string | null> {
  try {
    await persist(sourceKey, record);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
