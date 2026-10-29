/**
 * @file sync-burndown-contract.ts
 * @description The node-free vocabulary and pure decision logic behind the
 * desktop→cloud sync BURN-DOWN (ISS-5387).
 *
 * WHY THIS EXISTS. Every lane already logs each individual sync action, so the
 * logs answer "did something just happen?" — but nothing answered the two
 * questions an operator actually asks: **how much is still owed to the cloud**,
 * and **am I caught up?** `remaining incremental=N` counts SESSIONS, so one
 * 1.9 MiB session re-chunked into eleven parts reads as `1` while megabytes are
 * re-sent; `backfill=0` means the historical backfill lane drained, which reads
 * as "fully synced" and is a different question entirely.
 *
 * WHAT MAKES THIS HONEST. Three distinctions the vocabulary here refuses to
 * collapse, because collapsing them is how a reassuring number hides a stall:
 *
 *  1. **Given up on is not caught up.** A `dead_lettered` / `dead` row is an
 *     item the lane ABANDONED. An outbox that is empty because its rows were
 *     abandoned must never report "fully synced" — see
 *     {@link SyncLaneDrainState.DrainedWithDeadLetters}.
 *  2. **Not running is not synced.** A lane idle because it is disabled, has no
 *     credential, or has no compute target has not delivered anything; it has
 *     merely stopped trying. `never_started` / `idle_not_running` / `drained`
 *     are three different answers.
 *  3. **Activity is not progress.** A lane can log uploads all day while its
 *     DURABLE cursor stands still — reads keep working, only persistence is
 *     dead (the ISS-5347 shape: `sync_state` frozen at `data_revision 65` while
 *     the inventory lane logged 1,713 successful syncs that day). A burn-down
 *     that counted only items would have shown the same reassuring numbers.
 *     {@link detectCursorStall} is the counter-signal: work observed as
 *     completed while the durable cursor did not move.
 *
 * Values and pure functions only — no I/O, no timers, no store access. The
 * periodic sampler that feeds these lives in
 * `main/sync/sync-burndown-reporter.ts` and the aggregate reads it samples live
 * in `main/database/sync-burndown-store.ts`. Sits in `shared/` and is node-free
 * to match the `sync-lane-contract.ts` / `transcript-sync-status-contract.ts`
 * precedent for lane vocabularies.
 *
 * NOTHING HERE MAY CARRY CONTENT. Every field is a count, a size, an age, a
 * status, or a durable cursor position. No payload bodies, session titles, file
 * paths, or credentials — the emitted lines go to the persisted gateway log.
 */

import {
  type SyncLaneId as SyncLaneIdType,
  SyncLaneId as SyncLaneIdValue,
  SYNC_LANE_IDS as syncLaneIds,
} from "./sync-lane-id.js";

export const SyncLaneId = SyncLaneIdValue;
export type SyncLaneId = SyncLaneIdType;
export const SYNC_LANE_IDS = syncLaneIds;

/**
 * What a lane's burn-down actually says. Five states, because the three
 * "nothing is queued" cases mean completely different things.
 *
 * - `never_started` — the lane has not been started this launch. It owes nothing
 *   because it has never looked.
 * - `idle_not_running` — started, but its gate is shut: disabled, not connected,
 *   no credential, no compute target. Local work may well be waiting; the lane
 *   simply is not trying. **Not synced.**
 * - `draining` — running with work still owed.
 * - `drained_with_dead_letters` — running, nothing left to attempt, but the lane
 *   GAVE UP on one or more items. **Not synced.**
 * - `remaining_unknown` — running, and nothing is KNOWN to be owed, but the lane
 *   could not establish that it owes nothing: it has no measurable remainder at
 *   all, or some of its rows carry a status this build cannot classify. An
 *   unmeasured remainder is not a zero remainder. **Not synced.**
 * - `drained` — running, zero remaining, zero abandoned, nothing unmeasured. The
 *   only state that means caught up.
 */
export const SyncLaneDrainState = {
  NeverStarted: "never_started",
  IdleNotRunning: "idle_not_running",
  Draining: "draining",
  DrainedWithDeadLetters: "drained_with_dead_letters",
  RemainingUnknown: "remaining_unknown",
  Drained: "drained",
} as const;
export type SyncLaneDrainState =
  (typeof SyncLaneDrainState)[keyof typeof SyncLaneDrainState];

/**
 * What timestamp backs {@link SyncLaneBurndown.oldestPendingSinceIso}. The lanes
 * do not all record the same thing, and labelling them all "enqueued" would be a
 * lie on the ledger lane.
 *
 * - `pending_since` — when an outbox row last entered `pending`; retries leave
 *   it unchanged, while every re-pend restarts the delivery-debt age.
 * - `enqueued_at` — the outbox row's immutable `created_at`.
 * - `last_state_change` — the ledger row's `updated_at`. `transcript_sync_state`
 *   rows are created at DISCOVERY and live forever (they settle to `idle`), so
 *   `created_at` on a re-queued file is the day the file was first seen, not the
 *   age of the outstanding work.
 * - `no_per_item_timestamp` — the lane has no queue row or per-item timestamp,
 *   so it cannot measure a backlog age.
 */
export const OldestPendingBasis = {
  PendingSince: "pending_since",
  EnqueuedAt: "enqueued_at",
  LastStateChange: "last_state_change",
  NoPerItemTimestamp: "no_per_item_timestamp",
} as const;
export type OldestPendingBasis =
  (typeof OldestPendingBasis)[keyof typeof OldestPendingBasis];

/**
 * ISS-9744: WHAT {@link SyncLaneBurndown.deadLetteredCount} is a count of. The
 * lanes measure it from two incompatible populations and one cannot
 * dead-letter at all, so the bare number cannot be compared or summed across
 * lanes without this — the same "here is the number, here is what it is a
 * number of" pairing {@link OldestPendingBasis} makes for the age.
 *
 * NONE of these is a cumulative loss tally, and the outbox basis in particular
 * DECREASES: `invocation-sync-validation-redrive.ts` re-clones dead-lettered
 * rows and the session lane has its own re-pend doors, so a lane observed at 13
 * can read 7 on the next sample. A number that goes down cannot be a count of
 * permanently-lost items. Making one derivable needs a durable per-row attempt
 * count, which ISS-8591 owns.
 *
 * - `queue_status_count` — a `GROUP BY status` row count over the lane's own
 *   queue or ledger table, re-read every sample. Rows leave it.
 * - `abandoned_id_ledger` — the length of the durable id list the lane persists
 *   on its cursor row (`sync_state.dead_lettered_ids`). It survives a restart
 *   and names specific ids, but recovery and cap-eviction still remove entries.
 * - `no_dead_letter_state` — the lane has no give-up state at all, so its `0` is
 *   structural rather than measured and can never rise.
 * - `unmeasured` — the lane had no source key this sample, so
 *   `sync-burndown-store.ts` short-circuited before it queried anything and the
 *   `0` is a placeholder. NOT the same fact as `no_dead_letter_state`: that lane
 *   cannot have dead-letters, this one may have plenty and nobody looked.
 */
export const SyncLaneDeadLetteredBasis = {
  QueueStatusCount: "queue_status_count",
  AbandonedIdLedger: "abandoned_id_ledger",
  NoDeadLetterState: "no_dead_letter_state",
  Unmeasured: "unmeasured",
} as const;
export type SyncLaneDeadLetteredBasis =
  (typeof SyncLaneDeadLetteredBasis)[keyof typeof SyncLaneDeadLetteredBasis];

/**
 * ISS-10082: was this lane's queue actually QUERIED this sample?
 *
 * `readSyncBurndown` short-circuits a lane whose source key is null, and the
 * placeholder it returns is byte-identical to a lane that queried its queue and
 * found it empty. `sync-burndown-store.ts` is the only layer that knows which of
 * the two happened, so it states it on the counts it returns rather than
 * leaving a reader to re-derive it from the key — which cannot work, because `readInvocationCounts` has TWO
 * null-key branches and only one of them is a placeholder.
 *
 * - `counted` — the numbers alongside this came from a read. That INCLUDES
 *   ISS-8768's never-promoted branch, which queries no outbox but runs the real
 *   bounded template probe: promotion writes the delivery cursor and the outbox
 *   rows in ONE transaction (`invocation-sync-promotion.ts`), so a target with no
 *   cursor row can have no outbox rows either and those zeros are structural, not
 *   placeholders. Reporting that branch as unqueried would null a genuinely
 *   measured backlog and retire the gate-shut alert ISS-8768 exists to raise.
 * - `unqueried` — the lane had no source key, nothing was read, and every count
 *   alongside this is a placeholder.
 *
 * NOT interchangeable with `deadLetteredBasis === Unmeasured`, which is true for
 * the never-promoted branch as well: that probe counts the BACKLOG and never the
 * abandoned rows, so the two answer different questions.
 */
export const SyncLaneRemainderBasis = {
  Counted: "counted",
  Unqueried: "unqueried",
} as const;
export type SyncLaneRemainderBasis =
  (typeof SyncLaneRemainderBasis)[keyof typeof SyncLaneRemainderBasis];

/**
 * ISS-10082: may a lane publish its remainders as numbers, per
 * {@link SyncLaneRemainderBasis}?
 *
 * An exhaustive `Record` rather than a comparison or a set of "unmeasured"
 * spellings, so a basis added later fails `tsc` HERE and has to state its
 * answer, instead of widening to a default `true` and republishing a placeholder
 * zero as a measured one.
 */
const REMAINDER_IS_MEASURED: Record<SyncLaneRemainderBasis, boolean> = {
  [SyncLaneRemainderBasis.Counted]: true,
  [SyncLaneRemainderBasis.Unqueried]: false,
};

/**
 * Read {@link REMAINDER_IS_MEASURED}, failing CLOSED.
 *
 * `=== true` rather than a bare lookup: the basis reaches the reporter across the
 * db-host structured-clone boundary, where the type does not constrain the
 * runtime value, and a plain-object lookup on `constructor` or `__proto__`
 * answers truthy — which here would publish a placeholder as a measurement, the
 * exact failure this ticket closes. Anything that is not a declared measured
 * basis reads as unmeasured.
 */
export function remainderIsMeasured(basis: SyncLaneRemainderBasis): boolean {
  return REMAINDER_IS_MEASURED[basis] === true;
}

/**
 * One lane's burn-down at one sample. Every quantity is nullable where the lane
 * genuinely cannot measure it — a fabricated `0` is exactly the reassuring
 * number this ticket exists to stop emitting, so "unknown" stays `null` and the
 * formatter prints it as `unknown`.
 */
export type SyncLaneBurndown = {
  lane: SyncLaneId;
  state: SyncLaneDrainState;
  /**
   * Items the lane would ACTUALLY deliver, counted with the lane's own pending
   * predicate — never a raw `WHERE status='pending'`. The invocation outbox
   * holds ~3.5k rows under the UNSCOPED template key
   * (`agent_component_invocations`) that the target-scoped lane clones from;
   * counting those reports a multi-thousand-item backlog that does not exist.
   * `null` when the store had no source key this sample and short-circuited
   * before reading the queue at all (ISS-10082) — "unknown", never zero. That is
   * now the ONLY cause: every lane with a key publishes a number, the component
   * lane included, whose `rowsRemaining` is a count once it has a target.
   */
  itemsRemaining: number | null;
  /**
   * True when {@link itemsRemaining} is a FLOOR rather than an exact count —
   * the lane's probe is bounded, so a backlog past the cap is reported as
   * `>= N`. Printing the capped value as exact is the same reassuring lie as a
   * fabricated zero: a 3,500-session backlog must not read as `items=200`.
   */
  itemsRemainingIsLowerBound: boolean;
  /**
   * Of {@link itemsRemaining}, how many are ELIGIBLE to be worked right now —
   * pending AND past their backoff deadline, the lane's own ready predicate.
   *
   * `null` where the lane keeps no per-row retry deadline and so cannot tell
   * deferred work from ready work, and — ISS-10082 — where the store never
   * queried the queue. That `null` is load-bearing and is not a zero:
   * {@link detectNoProgressStall} suppresses on a measured `0` (every item is
   * deferred, so completing nothing is the schedule working) and must never
   * suppress on an unmeasured one.
   */
  readyItemsRemaining: number | null;
  /**
   * Rows the lane counted but could NOT classify — a status string this build
   * does not know, from a version-skewed or corrupt row. They are neither
   * pending nor dead-lettered nor settled, so folding them into any of those
   * buckets would make the burn-down claim something it did not measure. A
   * non-zero value disqualifies the lane from `drained`.
   */
  unmeasuredRows: number;
  /** Bytes still owed, where the lane persists a size. `null` when unmeasurable. */
  bytesRemaining: number | null;
  /** Chunks/parts still owed, where the payload is chunked. `null` otherwise. */
  chunksRemaining: number | null;
  /**
   * Items the lane is holding in an abandoned state AT THIS SAMPLE. Never a
   * cumulative loss tally, and NOT always measurable — read it with
   * {@link deadLetteredBasis}, which says what population it counted and
   * whether anything was counted at all.
   */
  deadLetteredCount: number;
  /**
   * What {@link deadLetteredCount} counted (see
   * {@link SyncLaneDeadLetteredBasis}). Required, not optional: every lane knows
   * its own basis, and a consumer forced to infer it from the lane id is the
   * collapse ISS-9744 closed.
   */
  deadLetteredBasis: SyncLaneDeadLetteredBasis;
  /**
   * ISS-10082: did the store QUERY this lane's queue this sample (see
   * {@link SyncLaneRemainderBasis})? Required, like {@link deadLetteredBasis}
   * and {@link resumeBlocked}: a lane added later must state its answer rather
   * than inherit a reassuring one.
   *
   * Carried rather than derived from `deadLetteredBasis`. The two agree on every
   * other lane and come APART on the invocation lane, where ISS-8768's
   * never-promoted branch reads `unmeasured` dead letters beside a `counted`
   * remainder — treating one as the other is what sank both earlier designs for
   * this ticket. Main-process only: `projectLane` does not carry it across IPC,
   * because no renderer consumer asks the question.
   */
  remainderBasis: SyncLaneRemainderBasis;
  /**
   * ISS-9823: was this lane's once-per-identity resume read failing at this
   * sample? See {@link LaneDrainStateInput.resumeBlocked} for why the classifier
   * reads it as liveness. Reported on the row, not merely folded into
   * {@link SyncLaneBurndown.state}, because the readiness payload's renderer
   * RE-RUNS `classifyLaneDrainState` over the projected counts and rejects the
   * lane on any disagreement — a state it cannot re-derive is a state it refuses.
   *
   * Only the session lane can currently report `true`; every other lane states a
   * structural `false`.
   */
  resumeBlocked: boolean;
  /**
   * When the oldest outstanding item started owing. Null means no complete age
   * observation exists: nothing is owed, this lane has no per-item timestamp,
   * or a pending timestamp is absent or malformed through legacy/version skew.
   */
  oldestPendingSinceIso: string | null;
  /** How the oldest-pending timestamp should be read (see {@link OldestPendingBasis}). */
  oldestPendingBasis: OldestPendingBasis;
  /** Age of {@link oldestPendingSinceIso} at sample time. The "how far behind am I" number. */
  oldestPendingAgeMs: number | null;
  /**
   * Does this lane keep a durable `sync_state` watermark AT ALL?
   *
   * Load-bearing, not cosmetic. The session-metadata and component-inventory
   * lanes persist a cursor; the invocation-parts lane keeps its position in
   * `agent_component_invocation_sync_cursors`, and the transcript lane's durable
   * state is a per-file byte offset. For those two, "no cursor" is the DESIGN,
   * not a symptom — so {@link detectCursorStall} must not read their permanent
   * absence of a watermark as the ISS-5347 failure and cry wolf on every drain.
   */
  tracksDurableCursor: boolean;
  /**
   * The lane's DURABLE cursor position (`sync_state.observed_top_updated_at`),
   * or `null` when the lane keeps no cursor / has never persisted one.
   */
  durableCursorValue: string | null;
  /** When that cursor row was last written, and how stale that write is now. */
  durableCursorWrittenAtIso: string | null;
  durableCursorAgeMs: number | null;
  /**
   * ISS-10429: the position the durable cursor is waiting on, in the same units
   * as {@link durableCursorValue}. On the session lane this is the oldest
   * `updated_at` among the rows the lane still owes IN MEMORY, which is the row
   * the acked-contiguous watermark cannot pass (ISS-8041). The outbox table
   * cannot supply it: a row whose fire-and-forget enqueue write was lost holds
   * the watermark with no table row.
   *
   * `null` when the row cannot be named: nothing is owed, an owed row has no
   * live-scan stamp, the lane writes no cursor right now, the value belongs to a
   * different identity from the sample, or the lane is not the session lane.
   * Optional and additive; absent reads as unknown. Main-process only:
   * `projectLane` does not carry it across IPC.
   */
  cursorBoundaryValue?: string | null;
  /**
   * Work the lane was OBSERVED completing since the previous sample — acked
   * items for a queue lane, records sent for the cursor lane. Paired with the
   * cursor above, this is the stall detector: activity without cursor movement.
   */
  workCompletedSincePrevious: number | null;
  /**
   * Bytes the lane put on the wire since the previous sample. Read against
   * {@link workCompletedSincePrevious} this is where re-send amplification
   * becomes legible: megabytes sent while the item count barely moves is one
   * growing session being re-uploaded whole, not progress.
   */
  bytesSentSincePrevious: number | null;
  /**
   * ISS-7401: rows this lane reports having removed from its own queue since
   * the previous sample. REPORTED, not proven — see below.
   *
   * Exists to answer the triage question net depth cannot. The session lane
   * holds its watermark at the acked-contiguous prefix boundary (ISS-8041), so
   * on an install whose enqueue rate matches its drain rate
   * {@link itemsRemaining} stays flat while the cursor tracks only the OLDEST
   * still-owed row — a lane delivering every row on time can look much like a
   * lane pinned by one retrying row. This count rides the stall alert so an
   * operator can tell which population a given stall belongs to.
   *
   * An input to {@link detectCursorStall} ONLY together with
   * {@link cursorBoundaryValue} (ISS-10429). The count alone cannot tell the
   * two populations apart: a lane pinned by one retrying row still deletes the
   * newer rows behind it. PR #5915 removed a suppression that trusted the count
   * alone, when a delete that matched zero rows could still report one. Since
   * ISS-7957 the count is the delete's own row count, and a source with no
   * outbox delegate reports none.
   *
   * `null` where the lane does not measure one — never a fabricated `0`, which
   * would read as "delivered nothing". Optional and additive: absent from a
   * payload built before this field existed, which reads as unmeasured.
   */
  queueRowsClearedSincePrevious?: number | null;
  /**
   * ISS-7096: still-`pending` rows PARKED under this lane's
   * `<lanePrefix>:parked:<org>` partitions — another identity's (in practice,
   * another environment's) work, inert until that environment is active.
   * Deliberately NOT part of {@link itemsRemaining}: parked work is not owed by
   * this environment and must never hold the drain open. Optional and
   * additive: absent from a payload built before this field existed, which
   * reads as unknown — never as zero, never as owed.
   */
  parkedCount?: number | null;
  /**
   * ISS-7246: rows this lane has moved to `withheld` — a local session that is
   * not substantive yet, so nothing is owed until it gains activity. Like
   * {@link parkedCount} it is deliberately NOT part of {@link itemsRemaining}
   * (an unsubstantive session must never hold the drain open) and deliberately
   * not hidden either, so a phantom-heavy install stays legible in the
   * burn-down line. Optional and additive: absent from a payload built before
   * this field existed, which reads as unknown — never as zero.
   */
  withheldCount?: number | null;
};

/** A whole sample: every lane, at one instant. */
export type SyncBurndownSnapshot = {
  sampledAtIso: string;
  lanes: readonly SyncLaneBurndown[];
};

/** Inputs to {@link classifyLaneDrainState}. */
export type LaneDrainStateInput = {
  /** Has the lane been started this launch? */
  started: boolean;
  /** Is the lane's live gate open (connected, consented, credentialed, targeted)? */
  gateOpen: boolean;
  /**
   * ISS-9823: is the lane's once-per-identity RESUME READ currently failing, so
   * that every pass is abandoned before it can enqueue anything?
   *
   * A LIVENESS fact, not a queue-depth one. The condition is self-reinforcing —
   * the abort is what keeps the outbox empty — so on a device that was already
   * caught up the lane measures `pending = 0` and every count-based signal
   * agrees it is caught up while local data never leaves the machine.
   *
   * The classifier reads it AFTER the `itemsRemaining > 0` branch and BEFORE
   * every branch that claims the queue emptied; {@link classifyLaneDrainState}
   * states why each side of that position is load-bearing.
   *
   * REQUIRED, deliberately: an optional flag defaulting to `false` would let a
   * construction site be added that silently never reports the condition, and
   * `tsc` finding every site is the point.
   */
  resumeBlocked: boolean;
  /**
   * Items still owed. `null` means the lane could NOT measure its remainder —
   * which is emphatically not the same as measuring it and finding zero, so it
   * yields {@link SyncLaneDrainState.RemainingUnknown}, never `drained`.
   */
  itemsRemaining: number | null;
  deadLetteredCount: number;
  /**
   * ISS-9807: what {@link deadLetteredCount} — and every other count on this
   * input — is a count of. `unmeasured` means the store short-circuited on a
   * null source key before it ran a statement, so EVERY count here is a
   * placeholder rather than a figure (see {@link isLaneMeasured}); such a lane
   * has not established that it owes nothing and answers
   * {@link SyncLaneDrainState.RemainingUnknown}, never `drained`.
   *
   * `null` is reserved for the one caller that cannot know: the renderer's IPC
   * boundary re-deriving a payload from a main process that predates the
   * field. It re-derives exactly as that build did — the rule is skipped — and
   * no producer may pass it. Nullable rather than optional so `tsc` still
   * finds every construction site.
   */
  deadLetteredBasis: SyncLaneDeadLetteredBasis | null;
  /** Rows counted but not classifiable (see {@link SyncLaneBurndown.unmeasuredRows}). */
  unmeasuredRows: number;
};

/**
 * Classify one lane. Order is load-bearing:
 *
 *  - liveness is decided BEFORE queue depth, so an empty queue behind a shut
 *    gate can never be reported as drained;
 *  - a MEASURED backlog answers `draining` even when ISS-9823's resume read is
 *    failing, and that position is the alert this ticket must not cost: such a
 *    lane IS holding rows it is not delivering, and `draining` on both samples
 *    is what `detectNoProgressStall` and `maybeWarnNoProgress` require, so
 *    reading the blocked resume ahead of this count would silently retire the
 *    `sync.durable_cursor.stalled` error that already fires for a wedged device
 *    with a backlog — an alert that works today, not the deferred new one;
 *  - the blocked resume is read immediately AFTER that, ahead of every branch
 *    that claims the queue emptied — `deadLetteredCount` included. A wedged
 *    device that also gave up on some sessions would otherwise answer
 *    `drained_with_dead_letters`, which is still "caught up, with a caveat";
 *  - an UNMEASURED lane (ISS-9807) is read right after the blocked resume and
 *    ahead of the dead-letter branch, for the same reason: its zeros were never
 *    taken, so neither "caught up" nor "caught up, with a caveat" can be
 *    claimed from them;
 *  - dead-letters are checked BEFORE `drained`, so "gave up" can never be
 *    reported as "caught up";
 *  - and an unmeasured remainder is checked before `drained` too, so a lane
 *    that could not count what it owes is never rounded down to caught up.
 *    A `null` remainder is UNKNOWN, not zero — collapsing the two is how a
 *    gate-open cursor sweep printed `ALL LANES FULLY SYNCED` in the middle of
 *    its first backfill.
 */
export function classifyLaneDrainState(
  input: LaneDrainStateInput
): SyncLaneDrainState {
  if (!input.started) {
    return SyncLaneDrainState.NeverStarted;
  }
  if (!input.gateOpen) {
    return SyncLaneDrainState.IdleNotRunning;
  }
  if ((input.itemsRemaining ?? 0) > 0) {
    return SyncLaneDrainState.Draining;
  }
  // ISS-9823: the gate is open, the lane is trying, and it has nothing MEASURED
  // left to hand over — but its resume read is failing, so every pass aborts
  // before enqueueing and that zero was never measured against restored state.
  // It is unknown and unbounded, not zero.
  if (input.resumeBlocked) {
    return SyncLaneDrainState.RemainingUnknown;
  }
  if (input.deadLetteredBasis === SyncLaneDeadLetteredBasis.Unmeasured) {
    return SyncLaneDrainState.RemainingUnknown;
  }
  if (input.deadLetteredCount > 0) {
    return SyncLaneDrainState.DrainedWithDeadLetters;
  }
  if (input.itemsRemaining === null || input.unmeasuredRows > 0) {
    return SyncLaneDrainState.RemainingUnknown;
  }
  return SyncLaneDrainState.Drained;
}

/**
 * Is this lane genuinely caught up? The ONLY state that qualifies is
 * {@link SyncLaneDrainState.Drained}: not "the queue is empty", not "the lane
 * stopped", not "we gave up on the rest".
 */
export function isLaneFullySynced(lane: SyncLaneBurndown): boolean {
  return lane.state === SyncLaneDrainState.Drained;
}

/** Are ALL lanes simultaneously and genuinely caught up? */
export function areAllLanesFullySynced(
  lanes: readonly SyncLaneBurndown[]
): boolean {
  return lanes.length > 0 && lanes.every(isLaneFullySynced);
}

/**
 * The ISS-5347 detector: the lane completed work since the previous sample, yet
 * its durable cursor row did not move.
 *
 * This is the shape that hid a three-day freeze behind 1,713 successful-looking
 * log lines — `getSyncSource()` returned null during a db-host restart, the
 * persist callback resolved to `undefined`, and every advance moved the keyset
 * IN MEMORY while writing nothing. Reads never broke; only persistence died. A
 * restart would then have re-walked from the stale position.
 *
 * Returns false when there is no previous sample, when no work was observed
 * (a quiet lane is not a stalled one), when the lane keeps no durable cursor, or
 * when the lane recorded durable progress by its OTHER durable means — the
 * signal is specifically "moving, but recording nothing anywhere". Those means
 * are a queue that got shorter and, since ISS-10429, cleared outbox rows while
 * the row holding the watermark moved forward
 * ({@link clearedRowsPastCursorBoundary}). PR #5915 removed an earlier version
 * of the second rule that trusted the cleared count alone.
 */
export function detectCursorStall(input: {
  previous: SyncLaneBurndown | null;
  current: SyncLaneBurndown;
}): boolean {
  return classifyCursorStall(input) === CursorStallVerdict.Stalled;
}

/**
 * Did the lane's own queue get shorter since the previous sample? That is
 * durable progress independent of the `sync_state` watermark. Unknown depth on
 * either side is not evidence of progress, so it answers `false`.
 *
 * A queue that EMPTIED also got shorter, so this function covers the "or the
 * queue emptied" part of the ISS-10429 ruling. It reads depth only. The
 * cleared-row rule is {@link clearedRowsPastCursorBoundary}, and only
 * {@link detectCursorStall} uses it. {@link madeDurableProgressSincePrevious}
 * calls this function but deliberately does not use that rule. It is only
 * asked about samples with zero completed work, and a sample that cleared rows
 * had an accepted batch, so it always has completed work.
 */
function drainedQueueSincePrevious(
  previous: SyncLaneBurndown,
  current: SyncLaneBurndown
): boolean {
  if (previous.itemsRemaining === null || current.itemsRemaining === null) {
    return false;
  }
  return current.itemsRemaining < previous.itemsRemaining;
}

/**
 * ISS-10429: did the lane delete queue rows since the previous sample, AND did
 * the row holding the watermark move forward?
 *
 * Rulings by Perrin Upcott, 2026-09-16:
 *   1. Cleared rows count as durable progress only when the oldest pending row
 *      moved too, because a lane can delete newer rows while its oldest row is
 *      stuck, and that lane really is stalled. PR #5915 (ISS-7401) removed a
 *      suppression that trusted the count alone.
 *   2. Close the gap before merging: the row that counts is the one actually
 *      holding the watermark, {@link SyncLaneBurndown.cursorBoundaryValue}.
 *
 * `oldestPendingSinceIso` is deliberately not read here. The outbox table
 * orders rows by `created_at` and the watermark orders them by `updated_at`.
 * Worse, a row whose fire-and-forget enqueue write was lost holds the watermark
 * with no table row at all, so the table minimum can move while the stuck row
 * stays put. The boundary is the stamp recorded when a row was admitted, and a
 * scan skips an id already on its own queue. So a boundary that stays put means
 * the same row is still owed. A boundary that moves forward means the row the
 * watermark was waiting on has left the queues, with one exception: the
 * one-time backfill walk can restamp an id that is already on the incremental
 * queue with its newer `updated_at`.
 *
 * The boundary has to move strictly FORWARD, compared as raw strings the way
 * the watermark is (`agent-session-sync-cursor-prefix.ts`). A boundary that
 * moved BACKWARDS means an older row joined the queues, which says nothing
 * about the row that was waiting before.
 *
 * Anything unknown or impossible answers `false`, which keeps the verdict the
 * lane had before this rule. That covers a count that is absent, `null`, zero
 * or negative, or not a safe integer (a fractional or oversized count cannot be
 * a row count), and a boundary that is absent or `null` on either side. The
 * count is read from `current` only, because it describes the window between
 * the two samples.
 */
function clearedRowsPastCursorBoundary(
  previous: SyncLaneBurndown,
  current: SyncLaneBurndown
): boolean {
  const cleared = current.queueRowsClearedSincePrevious;
  if (
    !(
      typeof cleared === "number" &&
      Number.isSafeInteger(cleared) &&
      cleared > 0
    )
  ) {
    return false;
  }
  const before = previous.cursorBoundaryValue;
  const after = current.cursorBoundaryValue;
  if (typeof before !== "string" || typeof after !== "string") {
    return false;
  }
  return after > before;
}

/** Render a byte count for a log line, or `unknown` when unmeasurable. */
export function formatBurndownBytes(bytes: number | null): string {
  if (bytes === null) {
    return "unknown";
  }
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)}KiB`;
  }
  const mib = kib / 1024;
  if (mib < 1024) {
    return `${mib.toFixed(1)}MiB`;
  }
  return `${(mib / 1024).toFixed(2)}GiB`;
}

/** Render a duration for a log line, or `n/a` when there is nothing outstanding. */
export function formatBurndownAge(ageMs: number | null): string {
  if (ageMs === null) {
    return "n/a";
  }
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function formatCount(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

/**
 * Render an item count that may be a FLOOR. A bounded probe that hit its cap
 * knows only "at least this many", so the line says `>=200` — never the capped
 * number bare, which would read as an exact and reassuringly small backlog.
 */
function formatItemsRemaining(lane: SyncLaneBurndown): string {
  if (lane.itemsRemaining === null) {
    return "n/a";
  }
  return lane.itemsRemainingIsLowerBound
    ? `>=${lane.itemsRemaining}`
    : String(lane.itemsRemaining);
}

/**
 * Render the durable cursor position, keeping the two zero-cases apart:
 * `n/a` — this lane keeps no `sync_state` watermark at all — versus `none`,
 * which means it keeps one and has not written it yet. The second is a
 * condition worth looking at; the first never is.
 */
function formatCursorPosition(lane: SyncLaneBurndown): string {
  if (!lane.tracksDurableCursor) {
    return "n/a";
  }
  return lane.durableCursorValue ?? "none";
}

/**
 * Render the oldest-pending age, keeping ITS two null-cases apart exactly as
 * {@link formatCursorPosition} does above: `none` — the lane counted its queue
 * and nothing is owed — versus `n/a`, which means nobody counted.
 *
 * ISS-10082, one column over. The remainder learned to print `n/a` for a lane
 * the store short-circuited, but the age beside it printed `n/a` for that lane
 * AND for the drain the operator is waiting for, so the two read identically on
 * the one surface built to tell them apart. `oldestPendingBasis` cannot carry
 * the distinction: it names which TIMESTAMP backs the age, never whether one was
 * read.
 */
function formatOldestPending(lane: SyncLaneBurndown): string {
  if (!laneMeasuresOldestPendingAge(lane)) {
    return "n/a";
  }
  if (lane.oldestPendingAgeMs !== null) {
    return formatBurndownAge(lane.oldestPendingAgeMs);
  }
  return laneMeasuredAnEmptyQueue(lane) ? "none" : "n/a";
}

/**
 * The per-lane burn-down line. Counts, sizes, ages, and a cursor position —
 * never a session title, file path, payload body, or credential.
 *
 * `cursor` carries the durable position AND its age precisely because a moving
 * item count next to a frozen cursor is the failure this ticket exists to make
 * legible.
 */
export function formatLaneBurndownLine(lane: SyncLaneBurndown): string {
  const parts = [
    `[${lane.lane}] ${lane.state}`,
    `items=${formatItemsRemaining(lane)}`,
    `chunks=${formatCount(lane.chunksRemaining)}`,
    `bytes=${formatBurndownBytes(lane.bytesRemaining)}`,
    // ISS-9744: the basis rides the count for the same reason it rides
    // `oldestPending` below — an outbox status count and a durable abandoned-id
    // ledger are different populations, and neither is a running loss total.
    `deadLettered=${lane.deadLetteredCount} (${lane.deadLetteredBasis})`,
    `unmeasured=${lane.unmeasuredRows}`,
    `oldestPending=${formatOldestPending(lane)} (${lane.oldestPendingBasis})`,
    `cursor=${formatCursorPosition(lane)} age=${formatBurndownAge(lane.durableCursorAgeMs)}`,
    `sinceLastPass: done=${formatCount(lane.workCompletedSincePrevious)} sent=${formatBurndownBytes(lane.bytesSentSincePrevious)}`,
  ];
  if ((lane.parkedCount ?? 0) > 0) {
    // ISS-7096: parked work is another environment's, not owed here — but a
    // multi-environment device's held-back history must stay legible.
    parts.push(`parked=${lane.parkedCount}`);
  }
  if ((lane.withheldCount ?? 0) > 0) {
    // ISS-7246: not owed (the session is not substantive yet), but a large
    // phantom population is exactly what this line exists to make visible.
    parts.push(`withheld=${lane.withheldCount}`);
  }
  return parts.join(" ");
}

/** The "this lane is genuinely caught up" line. */
export function formatLaneFullySyncedLine(lane: SyncLaneBurndown): string {
  return `[${lane.lane}] fully synced to cloud — 0 remaining, 0 dead-lettered (${lane.deadLetteredBasis})`;
}

/**
 * The "this lane stopped owing work but did NOT catch up" line. Deliberately
 * worded as *gave up*, because that is what a dead-letter is.
 */
export function formatLaneDrainedWithDeadLettersLine(
  lane: SyncLaneBurndown
): string {
  return `[${lane.lane}] NOT fully synced — queue empty but ${lane.deadLetteredCount} item(s) were dead-lettered (${lane.deadLetteredBasis} at this sample; gave up, not caught up)`;
}

/**
 * The "this lane has nothing KNOWN outstanding, but could not prove it is caught
 * up" line. Names which of the FOUR causes applies, because they are different
 * problems: a lane whose once-per-identity resume read is failing, a lane the
 * store never queried, a lane holding rows whose status this build cannot read,
 * and a lane that exposes no measurable remainder at all. This is the only
 * surface that turns the state into a line a human reads, so a cause it cannot
 * name is a fault reported as a shrug.
 */
export function formatLaneRemainingUnknownLine(lane: SyncLaneBurndown): string {
  return `[${lane.lane}] NOT reported as fully synced — nothing known outstanding, but ${laneRemainingUnknownCause(lane)}, so "caught up" cannot be established`;
}

/** Which of {@link formatLaneRemainingUnknownLine}'s causes this lane has. */
function laneRemainingUnknownCause(lane: SyncLaneBurndown): string {
  if (lane.resumeBlocked) {
    // ISS-9823 review: named FIRST and named as a fault. It is the only one an
    // operator can act on, and the only one where the measured zeros above are
    // not evidence of anything.
    return "its once-per-identity resume read is failing, so every pass is abandoned before it can enqueue";
  }
  if (!remainderIsMeasured(lane.remainderBasis)) {
    // ISS-10082: second, because like the resume read it says the zeros on this
    // line were never measured. Read from the lane's OWN remainder basis, not
    // from `deadLetteredBasis`: the two come apart on the invocation lane, and a
    // never-promoted lane that DID count its backlog must never be described
    // with this sentence.
    return "it had no source key this sample, so the store never queried its queue";
  }
  if (lane.unmeasuredRows > 0) {
    return `${lane.unmeasuredRows} row(s) carry a status this build cannot classify`;
  }
  // The tail. Today's lanes cannot reach it — after ISS-10082 a `null`
  // remainder implies an unqueried lane, which the branch above catches — but
  // this function's own contract still admits a measured lane that publishes no
  // remainder, and `sync-burndown-log-lines.test.ts` builds exactly that. Kept
  // rather than folded into the branch above, because reporting it as
  // "0 row(s) carry a status this build cannot classify" is a sentence that
  // states a falsehood about a count it just read as zero.
  return "this lane exposes no measurable remainder";
}

/**
 * The all-lanes verdict. Emits the unambiguous "fully synced" ONLY when every
 * lane qualifies; otherwise it names which lanes disqualify it and why, so the
 * line can never be misread as a clean bill of health.
 */
export function formatAllLanesVerdictLine(
  lanes: readonly SyncLaneBurndown[]
): string {
  if (areAllLanesFullySynced(lanes)) {
    return `[sync-burndown] ALL LANES FULLY SYNCED to cloud (${lanes.length} lane(s), 0 remaining, 0 dead-lettered)`;
  }
  const blockers = lanes
    .filter((lane) => !isLaneFullySynced(lane))
    .map((lane) => `${lane.lane}=${lane.state}`)
    .join(" ");
  return `[sync-burndown] not fully synced — ${blockers}`;
}

/** The stall warning. Names the lane, the work it did, and the cursor that did not move. */
export function formatCursorStallLine(lane: SyncLaneBurndown): string {
  const cursor = lane.durableCursorValue ?? "none";
  return `[${lane.lane}] DURABLE CURSOR NOT ADVANCING — completed ${formatCount(lane.workCompletedSincePrevious)} unit(s) since the last pass while the persisted cursor stayed at ${cursor} (written ${formatBurndownAge(lane.durableCursorAgeMs)} ago). Uploads are succeeding but progress is not being recorded; a restart will re-walk from the stale position.`;
}

/**
 * ISS-5973: WHY a lane stall was raised. Four different failures reach the same
 * monitored sink, and an operator cannot act on any of them without knowing which.
 */
export const SyncLaneStallKind = {
  /** Work is completing, but the durable cursor is not recording it (ISS-5347). */
  CursorFrozen: "cursor_frozen",
  /** The lane is running with a live backlog and is completing NOTHING. */
  NoProgress: "no_progress",
  /**
   * ISS-8768: the lane's gate is SHUT while this machine is consented to deliver,
   * and local work is piling up behind it.
   */
  GateShutWithBacklog: "gate_shut_with_backlog",
  /**
   * ISS-9823: the lane is running, but its once-per-identity RESUME READ keeps
   * failing, so every pass is abandoned before it can enqueue anything.
   */
  ResumeReadFailed: "resume_read_failed",
} as const;
export type SyncLaneStallKind =
  (typeof SyncLaneStallKind)[keyof typeof SyncLaneStallKind];

/**
 * ISS-5973: how many CONSECUTIVE samples a running lane may complete zero work
 * against a live backlog before it is reported as stalled.
 *
 * Above one so an ordinary quiet interval — a lane mid-request, or one whose
 * whole ready set is inside a backoff window — cannot raise an alert. A lane that
 * is genuinely draining moves at least one unit across three samples.
 */
export const NO_PROGRESS_STALL_SAMPLES = 3;

/**
 * ISS-5973: the lane is RUNNING, still owes work, and completed none of it.
 *
 * ## The hole this closes
 *
 * {@link detectCursorStall} deliberately returns false when no work was observed
 * — "a quiet lane is not a stalled one" — because its signal is specifically
 * "moving, but recording nothing". That leaves the opposite failure completely
 * unmonitored: a lane that is neither moving NOR recording. Measured on a live
 * install (2026-08-11), the session lane held 2,928 outbox rows that were ready
 * (`next_attempt_at` NULL), correctly target-scoped, and had `attempt_count = 0`
 * — not one had ever been attempted, across two days and multiple app runs. Every
 * existing detector was silent, because silence was indistinguishable from a
 * healthy idle lane, and the only symptom was a number a human had to sit and
 * watch.
 *
 * {@link SyncLaneDrainState.Draining} already encodes BOTH preconditions — a lane
 * that is not running resolves to `IdleNotRunning`, and a lane with nothing owed
 * cannot be `Draining` — so a stalled-but-gated-off lane is correctly NOT
 * reported here. That distinction is load-bearing: `idle_not_running` is a
 * closed gate, which is a different defect with a different owner.
 *
 * Pure, and takes the consecutive count from the caller, so the threshold rule is
 * unit-testable without a clock or a reporter.
 */
export function detectNoProgressStall(input: {
  previous: SyncLaneBurndown | null;
  current: SyncLaneBurndown;
  consecutiveZeroWorkSamples: number;
}): boolean {
  const { previous, current } = input;
  if (!previous || previous.lane !== current.lane) {
    return false;
  }
  if (
    previous.state !== SyncLaneDrainState.Draining ||
    current.state !== SyncLaneDrainState.Draining
  ) {
    return false;
  }
  if ((current.workCompletedSincePrevious ?? 0) > 0) {
    return false;
  }
  if (zeroWorkExemptionFor(previous, current) !== ZeroWorkExemption.None) {
    return false;
  }
  return input.consecutiveZeroWorkSamples >= NO_PROGRESS_STALL_SAMPLES;
}

/**
 * Did the lane's DURABLE remainder shrink since the previous sample — either the
 * item queue or the byte remainder?
 *
 * The item half mirrors {@link drainedQueueSincePrevious}. The byte half is the
 * transcript lane specifically: an archive upload advances `synced_byte_offset`
 * on a file that is STILL in flight, so `bytesRemaining` falls while
 * `inFlightFiles` — and therefore `workCompletedSincePrevious`, which that lane
 * derives from the in-flight count — stays flat. A multi-megabyte session mid
 * upload would otherwise read as "completing nothing" and raise "local data is
 * not reaching the cloud" during the exact delivery it was reporting on.
 *
 * Read off the durable REMAINDER on both halves, deliberately not off
 * {@link SyncLaneBurndown.bytesSentSincePrevious}: on the session lane that field
 * is a wire counter, and bytes on the wire without the remainder moving is
 * re-send amplification — a stall wearing progress's clothes, and one this
 * detector must keep reporting. An unknown remainder on either side is not
 * evidence of progress, so it answers `false`.
 */
function madeDurableProgressSincePrevious(
  previous: SyncLaneBurndown,
  current: SyncLaneBurndown
): boolean {
  if (drainedQueueSincePrevious(previous, current)) {
    return true;
  }
  if (previous.bytesRemaining === null || current.bytesRemaining === null) {
    return false;
  }
  return current.bytesRemaining < previous.bytesRemaining;
}

/** The no-progress warning. Names the backlog the lane is running against and not touching. */
export function formatNoProgressStallLine(lane: SyncLaneBurndown): string {
  const remaining =
    lane.itemsRemaining === null ? "unknown" : formatCount(lane.itemsRemaining);
  const bound = lane.itemsRemainingIsLowerBound ? ">=" : "";
  return `[${lane.lane}] LANE NOT DRAINING — running with ${bound}${remaining} item(s) still owed and 0 unit(s) completed across ${NO_PROGRESS_STALL_SAMPLES} consecutive samples. The queue is not being worked; local data is not reaching the cloud.`;
}

/**
 * Why a zero-work sample does not count toward the no-progress threshold, if it
 * does not.
 *
 * {@link detectNoProgressStall} suppresses on these, and the reporter's
 * consecutive-sample tally has to skip the SAME set — a tally that advances
 * through a window the detector exempts arrives at the threshold already
 * satisfied, and pages on the first sample the exemption lifts (ISS-8142). One
 * classifier, so the tally and the detector cannot drift onto two notions of an
 * exempt sample, and a new exemption added here cannot be added to only one of
 * them.
 */
export const ZeroWorkExemption = {
  /** The sample counts: the lane owed eligible work and completed none. */
  None: "none",
  /**
   * Every item the lane owes is inside its own backoff window, so completing
   * zero units is the retry schedule working. `protocol_unavailable` defers
   * invocation parts for five minutes against a one-minute sample, so without
   * this a routine outage would raise the monitored error every time.
   */
  DeferredBackoff: "deferred_backoff",
  /**
   * The durable remainder shrank even though no unit completed — the transcript
   * lane advancing `synced_byte_offset` on a file that is still in flight. That
   * is affirmative progress, not a quiet lane.
   */
  DurableProgress: "durable_progress",
} as const;
export type ZeroWorkExemption =
  (typeof ZeroWorkExemption)[keyof typeof ZeroWorkExemption];

/**
 * Classify a zero-work sample against the exemptions the stall threshold honours.
 *
 * A `null` `readyItemsRemaining` is deliberately NOT an exemption: it means the
 * lane cannot tell deferred from ready, and an unmeasured remainder must never
 * be read as an empty one.
 */
export function zeroWorkExemptionFor(
  previous: SyncLaneBurndown | null,
  current: SyncLaneBurndown
): ZeroWorkExemption {
  // Tested BEFORE the previous-sample guard, deliberately: a fully deferred lane
  // is deferred on its own evidence and needs no predecessor to say so. Ordering
  // this after the guard left the FIRST sample after `start()` counting a
  // deferred window — the exact pre-load ISS-8142 exists to remove, surviving in
  // the one place a six-sample test could not see it.
  if (current.readyItemsRemaining === 0) {
    return ZeroWorkExemption.DeferredBackoff;
  }
  if (!previous || previous.lane !== current.lane) {
    return ZeroWorkExemption.None;
  }
  if (madeDurableProgressSincePrevious(previous, current)) {
    return ZeroWorkExemption.DurableProgress;
  }
  return ZeroWorkExemption.None;
}

/**
 * Does an exemption re-arm the reporter's consecutive-sample tally?
 *
 * An exhaustive `Record`, so a fourth {@link ZeroWorkExemption} cannot be added
 * without deciding this — a new member silently inheriting "does not re-arm"
 * is how a tally drifts back out of step with the detector.
 *
 * `DurableProgress` is deliberately `false`. It reads progress off a shrinking
 * `itemsRemaining`, and `pending` and `deadLettered` are disjoint buckets, so a
 * row being ABANDONED to the dead-letter queue shrinks the remainder and looks
 * identical to a delivery. Re-arming on it would let a lane that dead-letters at
 * least once every {@link NO_PROGRESS_STALL_SAMPLES} samples suppress its own
 * no-progress alert indefinitely — and `deadLetteredCount` only ships as a field
 * ON that alert, so the abandonment would go with it.
 */
export const ZERO_WORK_EXEMPTION_RE_ARMS_TALLY: Record<
  ZeroWorkExemption,
  boolean
> = {
  [ZeroWorkExemption.None]: false,
  [ZeroWorkExemption.DeferredBackoff]: true,
  [ZeroWorkExemption.DurableProgress]: false,
};

/**
 * ISS-8768: how many CONSECUTIVE samples a consented-but-gated lane may sit on a
 * live backlog before it is reported.
 *
 * Above one for the same reason {@link NO_PROGRESS_STALL_SAMPLES} is: a gate is
 * legitimately shut for the first moments of a launch, while the compute target
 * and the HTTP transport resolve. It is a SEPARATE constant rather than a reuse
 * of the no-progress threshold because the two bound different things — that one
 * bounds how long a running lane may fail to move, this one bounds how long a
 * gate may stay shut — and a single knob would tie a future tuning of one to the
 * other.
 */
export const GATE_SHUT_STALL_SAMPLES = 3;

/**
 * ISS-8768: is this lane NOT delivering — for either of the two reasons that are
 * not "caught up"?
 *
 * BOTH states have to be here, and missing the first is how this detector would
 * have failed on the very install it was written for. `started` is tracked by
 * OBSERVATION (`everRunningLanes`), so a lane whose gate has been shut since
 * launch has never been seen running and reports {@link
 * SyncLaneDrainState.NeverStarted} — FOREVER, not just for the first sample.
 * {@link SyncLaneDrainState.IdleNotRunning} is the state of a lane that ran and
 * then stopped. An unpaired machine is permanently the former.
 *
 * The distinction those two draw is "has not looked yet" vs "has stopped
 * trying", which matters for describing a lane and does NOT matter for the
 * question here: either way this machine is consented and nothing is reaching
 * the cloud. One predicate so the detector and the reporter's sample tally
 * cannot drift onto two notions of "not delivering".
 */
export function laneIsNotDelivering(state: SyncLaneDrainState): boolean {
  return (
    state === SyncLaneDrainState.NeverStarted ||
    state === SyncLaneDrainState.IdleNotRunning
  );
}

/**
 * ISS-8768: the machine is CONSENTED to deliver, the lane's gate is shut anyway,
 * and local work is accumulating behind it.
 *
 * ## The hole this closes
 *
 * {@link detectNoProgressStall} deliberately requires {@link
 * SyncLaneDrainState.Draining} on both samples, and its docstring names the
 * remainder as out of scope: "a stalled-but-gated-off lane is correctly NOT
 * reported here … `idle_not_running` is a closed gate, which is a different
 * defect with a different owner." This is that owner.
 *
 * Every other detector is blind to a shut gate by construction —
 * {@link detectCursorStall} needs work completed > 0, and both
 * {@link detectNoProgressStall} and {@link detectResumeBlockedStall} need the
 * lane RUNNING — so a lane whose gate closes stops emitting anything at all.
 * Measured on a live install (2026-09-01): the invocation-parts lane held 3,031
 * `pending` rows with `attempt_count = 0` and `last_error = NULL` — not one had
 * ever been ATTEMPTED — while the cloud recorded nothing for that user for three
 * weeks and every detector stayed silent. Nothing had failed, so nothing spoke.
 *
 * ## Why consent is the discriminator
 *
 * `idle_not_running` is the CORRECT and unremarkable state for a machine whose
 * user turned cloud delivery off, and alerting on that would be noise on every
 * deliberately-local install. What is not unremarkable is the CONTRADICTION: the
 * user's persisted consent tier says this machine should be delivering, and it
 * is not. That pairing — consented, gated, and owing work — has no benign
 * reading, which is what makes it alertable where a bare shut gate is not.
 *
 * A `null` remainder is UNKNOWN and never fires: an unmeasured queue is not
 * evidence of a backlog, and inventing one here would page on a probe failure.
 *
 * Pure, and takes the consecutive count from the caller, so the threshold rule is
 * unit-testable without a clock or a reporter.
 */
export function detectGatedBacklogStall(input: {
  previous: SyncLaneBurndown | null;
  current: SyncLaneBurndown;
  deliveryConsented: boolean;
  consecutiveGatedSamples: number;
}): boolean {
  if (!input.deliveryConsented) {
    return false;
  }
  const { previous, current } = input;
  if (!previous || previous.lane !== current.lane) {
    return false;
  }
  if (
    !(laneIsNotDelivering(previous.state) && laneIsNotDelivering(current.state))
  ) {
    return false;
  }
  if (current.itemsRemaining === null || current.itemsRemaining <= 0) {
    return false;
  }
  return input.consecutiveGatedSamples >= GATE_SHUT_STALL_SAMPLES;
}

/** The gated-backlog warning. Names the backlog stuck behind the shut gate. */
export function formatGatedBacklogStallLine(lane: SyncLaneBurndown): string {
  const remaining =
    lane.itemsRemaining === null ? "unknown" : formatCount(lane.itemsRemaining);
  const bound = lane.itemsRemainingIsLowerBound ? ">=" : "";
  return `[${lane.lane}] LANE GATE SHUT — this machine is consented to deliver, but the lane is not running and ${bound}${remaining} item(s) have been owed across ${GATE_SHUT_STALL_SAMPLES} consecutive samples. Local data is not reaching the cloud.`;
}

/**
 * ISS-9823: is this lane's once-per-identity resume read failing WHILE the lane
 * is trying to deliver?
 *
 * ONE predicate, so {@link detectResumeBlockedStall} and the reporter's
 * consecutive-sample tally cannot drift onto two notions of a qualifying
 * sample — the ISS-8142 shape, where a tally that advanced through samples the
 * detector does not count arrives at the threshold already satisfied and pages
 * on the first sample that does count.
 *
 * The running test is {@link laneIsNotDelivering}, deliberately NOT an equality
 * against {@link SyncLaneDrainState.Draining}: the condition reaches the
 * classifier from TWO states, and an equality would miss the one that matters.
 * A wedged lane still HOLDING rows answers `draining` (the measured backlog is
 * read first, so the pre-existing no-progress alert survives), while the
 * CAUGHT-UP device this ticket was filed about answers
 * {@link SyncLaneDrainState.RemainingUnknown} — the abort returns before
 * `enqueueIncrementalUpdates`, so no outbox row is ever written and `pending`
 * stays 0. Requiring `draining` would ship a detector that cannot fire on its
 * own bug, with every test still green.
 */
export function laneResumeReadIsBlocked(lane: SyncLaneBurndown): boolean {
  return lane.resumeBlocked && !laneIsNotDelivering(lane.state);
}

/**
 * ISS-9823: the lane is RUNNING and its once-per-identity resume read keeps
 * FAILING, so every pass is abandoned before it can enqueue anything.
 *
 * ## The hole this closes
 *
 * The other three detectors cannot see this on the device it matters on.
 * {@link detectCursorStall} needs work completed > 0,
 * {@link detectNoProgressStall} needs `draining` on BOTH samples, and
 * {@link detectGatedBacklogStall} needs a lane that is NOT running. A device
 * that was already caught up when the read started failing is running, is
 * completing nothing, and owes nothing MEASURABLE — because the abort is what
 * keeps the outbox empty — so every one of them is silent by construction, and
 * the burn-down reported the machine fully synced while local data never left
 * it.
 *
 * Thresholded at {@link NO_PROGRESS_STALL_SAMPLES} consecutive samples rather
 * than firing on the first, so one transient SQLite lock cannot page. Reusing
 * that constant rather than declaring a fourth is deliberate: it bounds the
 * same thing — how long a RUNNING lane may fail to make progress — where
 * {@link GATE_SHUT_STALL_SAMPLES} bounds how long a gate may stay shut.
 *
 * Pure, and takes the consecutive count from the caller, so the threshold rule
 * is unit-testable without a clock or a reporter.
 */
export function detectResumeBlockedStall(input: {
  current: SyncLaneBurndown;
  consecutiveResumeBlockedSamples: number;
}): boolean {
  if (!laneResumeReadIsBlocked(input.current)) {
    return false;
  }
  return input.consecutiveResumeBlockedSamples >= NO_PROGRESS_STALL_SAMPLES;
}

/**
 * The blocked-resume warning.
 *
 * It states the measured remainder and then says outright that the remainder is
 * not evidence, because on the device this alert exists for that number is `0`
 * — and a stall line reading `items=0` is the reassuring lie the whole burn-down
 * was built to stop printing.
 */
export function formatResumeBlockedStallLine(lane: SyncLaneBurndown): string {
  return `[${lane.lane}] RESUME READ FAILING — the lane is running, but its once-per-identity resume read has failed across ${NO_PROGRESS_STALL_SAMPLES} consecutive samples, so every pass is abandoned before it can enqueue. The measured remainder (items=${formatItemsRemaining(lane)}) is not evidence of anything. Local data is not reaching the cloud — a durable read is failing, so check for an unapplied desktop migration.`;
}

/**
 * Was this lane's DEAD-LETTER population read this sample?
 *
 * ISS-9246. `false` means the lane had no source key, so `sync-burndown-store.ts`
 * short-circuited before it read the abandoned rows and
 * {@link SyncLaneBurndown.deadLetteredCount} is a placeholder rather than a
 * figure. Its one consumer refuses to publish a telemetry row on that basis,
 * which is the right posture for a count nobody took.
 *
 * READ IT AS WHAT IT IS: a statement about the dead-letter basis, NOT a lane-wide
 * "was anything read at all". ISS-10082 established that the two come apart on
 * the invocation lane, and mistaking one for the other cost two rejected designs.
 * ISS-8768's never-promoted branch carries `Unmeasured` here — correctly, since
 * its probe counts the BACKLOG and never the abandoned rows — while
 * {@link SyncLaneBurndown.itemsRemaining} on that same row is a real measured
 * count that the gate-shut alert depends on. Gating a remainder on this
 * predicate nulls that backlog and retires the alert.
 *
 * The remainder's own measuredness is not derived here at all: the store states
 * it per sample (`SyncLaneRemainderBasis`) and the reporter publishes an unread
 * remainder as `null`, which is the value this contract already defines as
 * unknown.
 */
export function isLaneMeasured(lane: SyncLaneBurndown): boolean {
  return lane.deadLetteredBasis !== SyncLaneDeadLetteredBasis.Unmeasured;
}

/**
 * Did this lane COUNT its queue and find NOTHING OWED — as opposed to never
 * counting it?
 *
 * The third state ISS-10082 is about, stated positively. `unmeasured` and
 * `drained` are both easy to name; "measured, and genuinely zero" is the one
 * that gets collapsed into whichever neighbour is convenient, and it is the one
 * an operator waiting on a drain actually needs.
 *
 * One term per way the zeros can fail to be a measurement, matching the causes
 * {@link formatLaneRemainingUnknownLine} already enumerates — all of them, not
 * the ones that are easy to name:
 *
 *  - `resumeBlocked` (ISS-9823) — a failing once-per-identity resume read
 *    abandons every pass before it can enqueue, so a caught-up-looking `pending`
 *    of 0 was never measured against restored state. That cause is named FIRST
 *    there and named as a FAULT; it is the only one an operator can act on, and
 *    it is why this predicate cannot be written from counts alone.
 *  - `itemsRemaining === 0` — `finishLane` publishes `null` for exactly the
 *    lanes `sync-burndown-store.ts` short-circuited, so a `0` is a counted zero.
 *  - `unmeasuredRows === 0` — rules out a queue counted but not fully
 *    classifiable.
 *  - `oldestPendingSinceIso === null` — rules out a row whose timestamp would
 *    not parse, which `ageMsFrom` answers `null` for rather than fabricating a
 *    brand-new age.
 *
 * Deliberately NOT gated on {@link isLaneMeasured}, which answers for the
 * DEAD-LETTER column — on ISS-8768's never-promoted invocation branch that
 * column is unmeasured beside a genuinely counted remainder, and borrowing its
 * answer here would report a real drain as unknown.
 *
 * Exported because two renderings of this one fact need it and a second copy
 * would drift: the operator line prints `none`, the telemetry gauge publishes a
 * real `0` for the backlog age.
 */
export function laneMeasuredAnEmptyQueue(lane: SyncLaneBurndown): boolean {
  return (
    laneMeasuresOldestPendingAge(lane) &&
    !lane.resumeBlocked &&
    lane.itemsRemaining === 0 &&
    lane.unmeasuredRows === 0 &&
    lane.oldestPendingSinceIso === null
  );
}

/** Whether this lane records the per-item timestamp required to measure age. */
export function laneMeasuresOldestPendingAge(lane: SyncLaneBurndown): boolean {
  return lane.oldestPendingBasis !== OldestPendingBasis.NoPerItemTimestamp;
}

/**
 * ISS-10375: is this string a lane THIS build knows?
 *
 * The renderer's readiness parse admits a lane id it does not recognize, because
 * a newer main process may report a lane this renderer predates. Anything that
 * indexes a `Record<SyncLaneId, …>` with a payload's id has to narrow through
 * this first. Read from the const object rather than {@link SYNC_LANE_IDS}, so
 * the guard is exactly the key set such a `Record` is forced to cover.
 */
export function isSyncLaneId(value: string): value is SyncLaneId {
  return Object.values(SyncLaneId).some((lane) => lane === value);
}

/**
 * ISS-10429: what {@link classifyCursorStall} decided about one sample pair.
 * {@link detectCursorStall} is `Stalled` alone; the other two are both "no
 * alert" but mean different things to the episode latch in
 * `sync-burndown-stall-detectors.ts`.
 */
export const CursorStallVerdict = {
  /** No stall: nothing to compare, nothing done, or the cursor moved. */
  Clear: "clear",
  /** Work completed and the durable cursor recorded none of it. */
  Stalled: "stalled",
  /**
   * The cursor did not move, but cleared rows and a forward-moving cursor
   * boundary show durable progress. Not a stall. Whether it also ENDS an open
   * episode depends on whether the boundary has passed the row that episode
   * paged about, which only the stall watcher knows.
   */
  SteadyDrain: "steady_drain",
} as const;
export type CursorStallVerdict =
  (typeof CursorStallVerdict)[keyof typeof CursorStallVerdict];

/**
 * The verdict behind {@link detectCursorStall}; see that function for the rule.
 * The stall watcher reads it to tell an exempt sample from a recovered one.
 */
export function classifyCursorStall(input: {
  previous: SyncLaneBurndown | null;
  current: SyncLaneBurndown;
}): CursorStallVerdict {
  const { previous, current } = input;
  if (!previous || previous.lane !== current.lane) {
    return CursorStallVerdict.Clear;
  }
  if (!current.tracksDurableCursor) {
    // This lane keeps no `sync_state` watermark by design. Its absence is not
    // evidence of anything, and treating it as a stall would fire on every
    // single drain — a permanently-crying alarm that teaches operators to
    // ignore the one case that matters.
    return CursorStallVerdict.Clear;
  }
  if ((current.workCompletedSincePrevious ?? 0) <= 0) {
    return CursorStallVerdict.Clear;
  }
  if (drainedQueueSincePrevious(previous, current)) {
    // The lane's QUEUE shrank. On the session lane a watermark is never advanced
    // past a still-queued row — the acked-contiguous rule, so a restart can never
    // skip a row that was not yet uploaded — and during a historical backfill the
    // watermark is parked at the corpus maximum from pass zero, which ISS-8041's
    // never-move-backwards refusal keeps it at, so accepted batches cannot move
    // it at all. Durable progress in
    // that window is the OUTBOX draining, and it is durable: rows are deleted on
    // verified ack. Reading a motionless cursor there as a stall would fire on
    // every ordinary multi-pass backfill.
    return CursorStallVerdict.Clear;
  }
  if (
    previous.durableCursorWrittenAtIso === null &&
    current.durableCursorWrittenAtIso === null
  ) {
    // The lane has NEVER persisted a cursor while doing work. That is the
    // `buildComponentCursorPersist(null)` case exactly: not a frozen cursor, an
    // absent one — and just as invisible, so it counts.
    return CursorStallVerdict.Stalled;
  }
  // Compared on the cursor VALUE, deliberately not on its written-at stamp:
  // `sqliteAdvanceSyncState` rewrites `updated_at` on every call whether or not
  // the watermark moved, so a fresh stamp is evidence a write was ATTEMPTED, not
  // that position was recorded. Requiring the stamp to be frozen too would miss
  // a lane re-persisting the same stale position forever.
  if (previous.durableCursorValue !== current.durableCursorValue) {
    return CursorStallVerdict.Clear;
  }
  // A steady drain: rows are acked and deleted as fast as new ones arrive, so
  // the depth stays flat and the watermark stays held at a queued row. This
  // check comes after the never-persisted case on purpose, so a lane with no
  // cursor at all still alerts.
  return clearedRowsPastCursorBoundary(previous, current)
    ? CursorStallVerdict.SteadyDrain
    : CursorStallVerdict.Stalled;
}
