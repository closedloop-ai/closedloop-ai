/**
 * @file lane-run-policy.ts
 * @description PLN-2028 (ISS-10043, ISS-9963): which producer may write a lane's
 * durable give-up, whose give-up a relaunch may resume into its gate, and how the
 * four persisted lane-run columns read back into a run a lane can hold.
 *
 * It exists because `sync_state` carries ONE give-up per (lane, compute target)
 * and the session lane has TWO producers writing it — the environmental gate and
 * the per-row ceiling fold. Nothing recorded which one wrote a stamp, so a
 * relaunch resumed a per-row ceiling as a lane-wide terminal hold and the lane
 * stopped collecting for a cause that was never lane-wide. The producer is now a
 * column, and what each (lane, producer) pair MEANS is decided here, once, rather
 * than at each adopting lane.
 *
 * Both tables are `Record`s over their closed unions, so a new lane or a new
 * producer fails `tsc` here instead of falling to a default that silently keeps
 * collecting. That is deliberate and is the shape this repo has shipped bugs
 * without: a hand-maintained side list widens to `string`, so the new member
 * compiles, misses every branch, and changes the answer quietly.
 *
 * THE READER IS THE OTHER HALF. `readLaneRunRecord` is the one place the four
 * columns become a run, so the two adopting lanes cannot disagree about what a
 * stored value means — the SSOT-by-copy defect `readLaneGiveUpStamp` already
 * exists to prevent for the stamp alone.
 *
 * WHAT IT DOES NOT OWN is the producer VOCABULARY. `LaneGiveUpSource` is a wire
 * dimension (`syncLaneGaveUp.source`), so it lives in
 * `@closedloop-ai/telemetry-contract` beside `SyncLane` and `SyncReason` and the
 * cloud schema derives its `z.enum` from the same const this lane writes
 * (tamsinb review). Decided HERE is only what each (lane, producer) pair means.
 */

import {
  LaneGiveUpSource,
  SyncLane,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import {
  LaneGiveUpStampDefect,
  readLaneGiveUpStamp,
} from "../../shared/lane-give-up.js";
import type { PersistedSyncState } from "../agent-sync/agent-session-sync-source.js";
import { LANE_RUN_COLUMN_SCHEMAS } from "../agent-sync/sync-cursor-state-source.js";

/** What one (lane, producer) pair is allowed to do. */
export type LaneRunProducerPolicy = {
  /** Whether this lane has this producer at all. */
  produces: boolean;
  /**
   * Whether a stamp this producer wrote may be resumed into the lane's
   * environmental gate as a terminal hold on a relaunch.
   *
   * FALSE is not the same as `produces: false`: on a lane that PRODUCES one, a
   * row-ceiling give-up is a real give-up the lane must keep on record, and
   * resuming it into the LANE gate is the ISS-10043 bounce — a relaunch holds the
   * whole lane for a ceiling that was only ever per row.
   */
  resumesHold: boolean;
};

/**
 * PLN-2028: the producer table, exhaustive on both axes.
 *
 * The unwired lanes are named rather than defaulted. The transcript-archive
 * lane's terminal path (ISS-9884) is not on this branch, and this desktop has
 * no trace-comment lane (ISS-11213). Neither produces a lane-run give-up today,
 * and writing that down is what makes adding one a deliberate edit here.
 */
export const LANE_RUN_POLICY: Record<
  SyncLane,
  Record<LaneGiveUpSource, LaneRunProducerPolicy>
> = {
  [SyncLane.SessionMetadata]: {
    [LaneGiveUpSource.EnvironmentalGate]: { produces: true, resumesHold: true },
    [LaneGiveUpSource.RowCeiling]: { produces: true, resumesHold: false },
  },
  [SyncLane.ComponentInventory]: {
    [LaneGiveUpSource.EnvironmentalGate]: { produces: true, resumesHold: true },
    // This lane has no row queue at all, only a cursor position.
    [LaneGiveUpSource.RowCeiling]: { produces: false, resumesHold: false },
  },
  [SyncLane.InvocationParts]: {
    [LaneGiveUpSource.EnvironmentalGate]: {
      produces: false,
      resumesHold: false,
    },
    [LaneGiveUpSource.RowCeiling]: { produces: false, resumesHold: false },
  },
  [SyncLane.TranscriptArchive]: {
    [LaneGiveUpSource.EnvironmentalGate]: {
      produces: false,
      resumesHold: false,
    },
    [LaneGiveUpSource.RowCeiling]: { produces: false, resumesHold: false },
  },
  [SyncLane.TraceComments]: {
    [LaneGiveUpSource.EnvironmentalGate]: {
      produces: false,
      resumesHold: false,
    },
    [LaneGiveUpSource.RowCeiling]: { produces: false, resumesHold: false },
  },
};

/**
 * PLN-2028 D3: which producer a stamp with NO recorded producer belongs to.
 *
 * `lane_gave_up_source` is NULL on every row written before migration 0091, so
 * this is not a rare repair path — it is how every stamp on disk at upgrade
 * reads. Each lane resolves to the only producer it had at the time:
 *
 * - component → the gate, its only producer ever;
 * - session → the row ceiling, its only producer before ISS-8610 merged.
 *
 * The asymmetry is the point. Misreading a gate stamp as row-ceiling costs one
 * repeated 24h run; misreading a row-ceiling stamp as a gate give-up is the
 * ISS-10043 bounce, which holds a healthy lane. A lane with no producer resolves
 * to `null` and adopts nothing, because inventing a producer for a lane that
 * writes no give-up would make a corrupt row look like a give-up it never had.
 *
 * This covers an ABSENT producer only. A column holding a value this build does
 * not recognise is a different case and must not share the fallback: it was
 * written by a build that knew a producer this one does not, and resolving it to
 * the lane's legacy answer would make a component row read as a gate give-up and
 * resume a lane-wide hold for a producer that may never have been allowed one.
 */
export const LANE_RUN_LEGACY_SOURCE: Record<SyncLane, LaneGiveUpSource | null> =
  {
    [SyncLane.SessionMetadata]: LaneGiveUpSource.RowCeiling,
    [SyncLane.ComponentInventory]: LaneGiveUpSource.EnvironmentalGate,
    [SyncLane.InvocationParts]: null,
    [SyncLane.TranscriptArchive]: null,
    [SyncLane.TraceComments]: null,
  };

/** The lane-run columns as a LOADED cursor carries them — each absent when NULL. */
export type PersistedLaneRunRead = Pick<
  PersistedSyncState,
  "laneStalledSince" | "laneGaveUpAt" | "laneGaveUpReason" | "laneGaveUpSource"
>;

/**
 * One lane-run INSTANT, read back from its column.
 *
 * The same three answers for the run origin and the give-up stamp, because both
 * are ISO instants parsed back into a clock and a bad value means the same thing
 * in both: `atMs` is what to HOLD (normalized), `storedMs` is what the COLUMN
 * holds (raw), and their divergence is what makes a repair write a genuine
 * change rather than an equality-gated no-op.
 */
export type LaneRunInstantRead = {
  atMs: number | null;
  storedMs: number | null;
  defect: LaneGiveUpStampDefect | null;
};

/** A persisted lane run, read into the state a lane may hold. */
export type LaneRunRecordRead = {
  /** When the current environmental run opened (ISS-10053). */
  origin: LaneRunInstantRead;
  /** When the lane gave up on it (ISS-9418). */
  giveUp: LaneRunInstantRead;
  /** Why (ISS-9963), or `null` when it cannot be said. */
  reason: SyncReason | null;
  /** Which producer wrote it (ISS-10043), or `null` when the lane has none. */
  source: LaneGiveUpSource | null;
};

/**
 * Read a persisted lane run for `lane` — the ONE reader every adopting lane uses.
 *
 * PLN-2028 D6: an unreadable value degrades THAT FIELD and never the cursor, and
 * each field's degraded answer is the one that fails safe:
 *
 * - Unreadable origin → no origin, so the lane opens a fresh run rather than
 *   giving up on a duration it cannot substantiate — how `laneStallWindow`
 *   already treats an unreadable run origin.
 * - Future instant → clamped to now, on both instants, because a value ahead of
 *   the clock still says the thing HAPPENED. Dropping it would re-open a 24h run
 *   on every launch for as long as the skew lasted.
 * - Unknown reason → absent, and so is `lane_gave_up` itself
 *   ({@link RESUMABLE_GIVE_UP_REASON}).
 * - Absent producer → D3, per lane. An UNRECOGNISED one → `null`, which resumes
 *   no hold: a newer build's producer must not inherit the answer a legacy NULL
 *   gets, or a value this build cannot judge becomes a lane-wide terminal state.
 *
 * Reason and producer are forced to `null` when there is no give-up to attach
 * them to. A cause without a give-up is not a partial record, it is a
 * contradiction, and carrying it would let a lane announce a give-up it is not
 * holding.
 */
export function readLaneRunRecord(
  persisted: PersistedLaneRunRead,
  lane: SyncLane,
  nowMs: number
): LaneRunRecordRead {
  const origin = readLaneRunInstant(persisted.laneStalledSince, nowMs);
  const giveUp = readLaneRunInstant(persisted.laneGaveUpAt, nowMs);
  if (giveUp.atMs === null) {
    return { origin, giveUp, reason: null, source: null };
  }
  return {
    origin,
    giveUp,
    reason: readLaneGiveUpReason(persisted.laneGaveUpReason),
    source: readLaneGiveUpSource(persisted.laneGaveUpSource, lane),
  };
}

/** Whether a give-up this producer wrote may be resumed into `lane`'s gate. */
export function laneRunResumesHold(
  lane: SyncLane,
  source: LaneGiveUpSource | null
): boolean {
  return source === null ? false : LANE_RUN_POLICY[lane][source].resumesHold;
}

/**
 * The producer a give-up written by `lane`'s environmental GATE is attributed
 * to, or `null` when that lane produces none.
 *
 * The write half of {@link LANE_RUN_POLICY}. Spelling the producer at the writing
 * lane instead would make the table exhaustive on the read path only, so a lane
 * wired with `produces: false` could still stamp a gate give-up and typecheck
 * clean (marisolashgrove review). `null` is the fail-safe answer for such a lane:
 * an unattributed stamp resumes no hold anywhere it is read.
 */
export function laneGateGiveUpSource(lane: SyncLane): LaneGiveUpSource | null {
  return laneGiveUpSourceFor(lane, LaneGiveUpSource.EnvironmentalGate);
}

/**
 * The producer a give-up `source` writes on `lane` is attributed to, or `null`
 * when that lane does not have that producer.
 *
 * The general form of {@link laneGateGiveUpSource}, for the session lane's SECOND
 * producer (PLN-2028 M4). Both spellings resolve through the one table on the
 * write path, so a lane wired `produces: false` cannot stamp a give-up it has no
 * producer for, whichever producer is asking — and `null` is the fail-safe
 * answer, since an unattributed stamp resumes no hold anywhere it is read.
 */
export function laneGiveUpSourceFor(
  lane: SyncLane,
  source: LaneGiveUpSource
): LaneGiveUpSource | null {
  return LANE_RUN_POLICY[lane][source].produces ? source : null;
}

/**
 * One lane-run instant, over the reader that already owns what a stored instant
 * means. A second parse here would be two lanes disagreeing about which stored
 * values are measurements — the defect that reader was extracted to end.
 *
 * What this DOES add is the column's own domain. `Date.parse` accepts far more
 * than the store writes — `"0"` reads back as the year 2000 — and a corrupt TEXT
 * value arriving as a real instant 26 years in the past is a run origin already
 * past the 24h ceiling, so the next lane failure gives up on the spot (whitlockk
 * review). Held to {@link LANE_RUN_INSTANT_SCHEMA} first, so a value outside what
 * the write would have accepted is UNREADABLE rather than a measurement.
 */
function readLaneRunInstant(
  value: string | undefined,
  nowMs: number
): LaneRunInstantRead {
  if (
    value !== undefined &&
    !LANE_RUN_INSTANT_SCHEMA.safeParse(value).success
  ) {
    return {
      atMs: null,
      storedMs: null,
      defect: LaneGiveUpStampDefect.Unreadable,
    };
  }
  const read = readLaneGiveUpStamp(value, nowMs);
  return {
    atMs: read.gaveUpAtMs,
    storedMs: read.storedMs,
    defect: read.defect,
  };
}

/**
 * Narrow a stored reason to a cause a give-up can be announced with.
 *
 * DERIVED from an exhaustive `Record`, never a hand-written set: a set built from
 * today's members still compiles when a member is added, so the new one would
 * fall through as unknown and silently lose its cause. The `Record` fails `tsc`
 * instead.
 */
function readLaneGiveUpReason(value: string | undefined): SyncReason | null {
  if (value === undefined || !Object.hasOwn(RESUMABLE_GIVE_UP_REASON, value)) {
    return null;
  }
  const reason = value as SyncReason;
  return RESUMABLE_GIVE_UP_REASON[reason] ? reason : null;
}

/**
 * Narrow a stored producer: an ABSENT one resolves per D3, an unrecognised one
 * to `null`.
 *
 * Only the absent case is a legacy row. A value present but unknown came from a
 * build that had a producer this one does not, and there is no lane whose legacy
 * answer describes it — so it is reported as unattributable and resumes no hold,
 * which is the direction that cannot hold a healthy lane.
 */
function readLaneGiveUpSource(
  value: string | undefined,
  lane: SyncLane
): LaneGiveUpSource | null {
  if (value === undefined) {
    return LANE_RUN_LEGACY_SOURCE[lane];
  }
  return Object.hasOwn(LANE_GIVE_UP_SOURCE_IS_MEMBER, value)
    ? (value as LaneGiveUpSource)
    : null;
}

/**
 * Whether each `SyncReason` can be the CAUSE a resumed give-up announces.
 *
 * Only `lane_gave_up` cannot. It is the wire spelling of the give-up itself, so
 * reporting it here would answer "why did this lane give up?" with "it gave up".
 */
const RESUMABLE_GIVE_UP_REASON: Record<SyncReason, boolean> = {
  [SyncReason.AckClearFailed]: true,
  [SyncReason.AckOmitted]: true,
  [SyncReason.AckTimeout]: true,
  [SyncReason.FeatureDisabled]: true,
  [SyncReason.GenerationConflict]: true,
  [SyncReason.IngestionFailed]: true,
  [SyncReason.LocallyOversized]: true,
  [SyncReason.PartConflict]: true,
  [SyncReason.ProtocolUnsupported]: true,
  [SyncReason.RateLimited]: true,
  [SyncReason.SessionMissing]: true,
  [SyncReason.SourceMissing]: true,
  [SyncReason.TargetNotOwned]: true,
  [SyncReason.TransportError]: true,
  [SyncReason.TransportTimeout]: true,
  [SyncReason.TransportUnavailable]: true,
  [SyncReason.Unauthenticated]: true,
  [SyncReason.Unhydratable]: true,
  [SyncReason.UploadConflict]: true,
  [SyncReason.ValidationFailed]: true,
  [SyncReason.LaneGaveUp]: false,
  [SyncReason.LocalReadFailed]: true,
};

/** Membership, derived from the producer table so it cannot list a retired producer. */
const LANE_GIVE_UP_SOURCE_IS_MEMBER: Record<LaneGiveUpSource, true> = {
  [LaneGiveUpSource.EnvironmentalGate]: true,
  [LaneGiveUpSource.RowCeiling]: true,
};

/**
 * What a lane-run INSTANT column must hold, taken from the store's own domain so
 * the reader cannot accept a value the write refuses
 * (`assertWritableLaneRunColumns`). Both instants share it —
 * {@link LANE_RUN_COLUMN_SCHEMAS} names them separately because it is keyed by
 * column, not because their domains differ.
 */
const LANE_RUN_INSTANT_SCHEMA = LANE_RUN_COLUMN_SCHEMAS.laneGaveUpAt;

/** What a stored lane-run instant could not supply, as an operator greps it. */
export const LaneRunDefectName = {
  GiveUpStampUnreadable: "give-up-stamp-unreadable",
  GiveUpStampFuture: "give-up-stamp-future",
  RunOriginUnreadable: "run-origin-unreadable",
  RunOriginFuture: "run-origin-future",
} as const;

export type LaneRunDefectName =
  (typeof LaneRunDefectName)[keyof typeof LaneRunDefectName];

/** One named lane-run defect, for whatever diagnostic channel a lane owns. */
export type LaneRunDefectNote = {
  name: LaneRunDefectName;
  message: string;
};

/**
 * Name every lane-run column this read could not take at face value.
 *
 * NEVER silent, because the origin's failure mode is invisible from outside: an
 * unreadable `lane_stalled_since` hands back no origin, so the lane opens a fresh
 * run and the install reproduces the ISS-10053 defect on every launch with
 * nothing anywhere saying the column was corrupt (marisolashgrove review).
 *
 * Shared by both adopting lanes rather than written at each, so one name means
 * one thing wherever an operator finds it, and each lane spends it on the
 * channel it owns — the component sweep's transition logger, the session lane's
 * `onRunDefect` hook.
 */
export function laneRunDefectNotes(
  read: LaneRunRecordRead,
  persisted: PersistedLaneRunRead | null | undefined
): readonly LaneRunDefectNote[] {
  const notes: LaneRunDefectNote[] = [];
  if (read.giveUp.defect === LaneGiveUpStampDefect.Unreadable) {
    notes.push({
      name: LaneRunDefectName.GiveUpStampUnreadable,
      message: `durable lane give-up stamp was unreadable (${persisted?.laneGaveUpAt}); the lane resumes attempting and re-stamps if the outage is still on`,
    });
  }
  if (read.giveUp.defect === LaneGiveUpStampDefect.Future) {
    notes.push({
      name: LaneRunDefectName.GiveUpStampFuture,
      message: `durable lane give-up stamp was ahead of the clock (${persisted?.laneGaveUpAt}); normalized to now and rewritten so the re-arm window measures from a real instant`,
    });
  }
  if (read.origin.defect === LaneGiveUpStampDefect.Unreadable) {
    notes.push({
      name: LaneRunDefectName.RunOriginUnreadable,
      message: `durable lane run origin was unreadable (${persisted?.laneStalledSince}); the lane opens a fresh run rather than giving up on a duration it cannot substantiate`,
    });
  }
  if (read.origin.defect === LaneGiveUpStampDefect.Future) {
    notes.push({
      name: LaneRunDefectName.RunOriginFuture,
      message: `durable lane run origin was ahead of the clock (${persisted?.laneStalledSince}); normalized to now and rewritten so the ceiling measures from a real instant`,
    });
  }
  return notes;
}
