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

/**
 * The desktop→cloud sync lanes this burn-down measures, per
 * `main/sync/AGENTS.md`. They are NOT the same shape and their totals are NEVER
 * summed: an outbox item, a transcript file, and a cursor position do not add up
 * to a meaningful number.
 *
 * All FIVE state machines in `main/sync/AGENTS.md` are here, including the
 * trace-comment lane. Its delivery status lives on the entity row rather than in
 * a separate outbox — for offline-authoring atomicity — but that is a difference
 * in storage SHAPE, not a lane that owes nothing: a `local_pending` comment is
 * undelivered local work exactly like a pending outbox row, and it can sit that
 * way indefinitely (the lane has no dead-letter state, so a permanently-rejected
 * comment retries forever). Omitting it let `ALL LANES FULLY SYNCED` print while
 * a user's comments were still on disk.
 */
export const SyncLaneId = {
  /** `agent_session_sync_outbox` — outbox (queue), `pending` / `dead_lettered`. */
  SessionMetadata: "session_metadata",
  /** `agent_component_invocation_sync_outbox` — outbox (queue). */
  InvocationParts: "invocation_parts",
  /** `transcript_sync_state` — per-file protocol ledger, five states. */
  TranscriptArchive: "transcript_archive",
  /** Persisted keyset cursor sweep — the queue is "rows past the cursor". */
  ComponentInventory: "component_inventory",
  /** `trace_comments.sync_status` — CRUD delivery state ON the entity row. */
  TraceComments: "trace_comments",
} as const;
export type SyncLaneId = (typeof SyncLaneId)[keyof typeof SyncLaneId];

/** Every lane, in the order burn-down lines are emitted. */
export const SYNC_LANE_IDS: readonly SyncLaneId[] = [
  SyncLaneId.SessionMetadata,
  SyncLaneId.InvocationParts,
  SyncLaneId.TranscriptArchive,
  SyncLaneId.ComponentInventory,
  SyncLaneId.TraceComments,
];

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
 * - `enqueued_at` — the outbox row's `created_at`: genuinely "how long has this
 *   item owed delivery".
 * - `last_state_change` — the ledger row's `updated_at`. `transcript_sync_state`
 *   rows are created at DISCOVERY and live forever (they settle to `idle`), so
 *   `created_at` on a re-queued file is the day the file was first seen, not the
 *   age of the outstanding work.
 */
export const OldestPendingBasis = {
  EnqueuedAt: "enqueued_at",
  LastStateChange: "last_state_change",
} as const;
export type OldestPendingBasis =
  (typeof OldestPendingBasis)[keyof typeof OldestPendingBasis];

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
   * `null` when the lane has no per-item queue (component inventory is a cursor
   * position, not a queue).
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
   * deferred work from ready work. That `null` is load-bearing and is not a
   * zero: {@link detectNoProgressStall} suppresses on a measured `0` (every item
   * is deferred, so completing nothing is the schedule working) and must never
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
  /** Items the lane ABANDONED. Always measurable; `0` is a real zero. */
  deadLetteredCount: number;
  /** When the oldest outstanding item started owing; `null` when nothing is owed. */
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
   * Items still owed. `null` means the lane could NOT measure its remainder —
   * which is emphatically not the same as measuring it and finding zero, so it
   * yields {@link SyncLaneDrainState.RemainingUnknown}, never `drained`.
   */
  itemsRemaining: number | null;
  deadLetteredCount: number;
  /** Rows counted but not classifiable (see {@link SyncLaneBurndown.unmeasuredRows}). */
  unmeasuredRows: number;
};

/**
 * Classify one lane. Order is load-bearing:
 *
 *  - liveness is decided BEFORE queue depth, so an empty queue behind a shut
 *    gate can never be reported as drained;
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
 * signal is specifically "moving, but recording nothing anywhere".
 */
export function detectCursorStall(input: {
  previous: SyncLaneBurndown | null;
  current: SyncLaneBurndown;
}): boolean {
  const { previous, current } = input;
  if (!previous || previous.lane !== current.lane) {
    return false;
  }
  if (!current.tracksDurableCursor) {
    // This lane keeps no `sync_state` watermark by design. Its absence is not
    // evidence of anything, and treating it as a stall would fire on every
    // single drain — a permanently-crying alarm that teaches operators to
    // ignore the one case that matters.
    return false;
  }
  if ((current.workCompletedSincePrevious ?? 0) <= 0) {
    return false;
  }
  if (drainedQueueSincePrevious(previous, current)) {
    // The lane's QUEUE shrank. On the session lane a watermark is deliberately
    // NOT advanced while rows are still queued — the acked-contiguous rule, so a
    // restart can never skip a row that was not yet uploaded — and during a
    // historical backfill the watermark is parked at the corpus maximum from
    // pass zero, so accepted batches cannot move it at all. Durable progress in
    // that window is the OUTBOX draining, and it is durable: rows are deleted on
    // verified ack. Reading a motionless cursor there as a stall would fire on
    // every ordinary multi-pass backfill.
    return false;
  }
  if (
    previous.durableCursorWrittenAtIso === null &&
    current.durableCursorWrittenAtIso === null
  ) {
    // The lane has NEVER persisted a cursor while doing work. That is the
    // `buildComponentCursorPersist(null)` case exactly: not a frozen cursor, an
    // absent one — and just as invisible, so it counts.
    return true;
  }
  // Compared on the cursor VALUE, deliberately not on its written-at stamp:
  // `sqliteAdvanceSyncState` rewrites `updated_at` on every call whether or not
  // the watermark moved, so a fresh stamp is evidence a write was ATTEMPTED, not
  // that position was recorded. Requiring the stamp to be frozen too would miss
  // a lane re-persisting the same stale position forever.
  return previous.durableCursorValue === current.durableCursorValue;
}

/**
 * Did the lane's own queue get shorter since the previous sample? That is
 * durable progress independent of the `sync_state` watermark. Unknown depth on
 * either side is not evidence of progress, so it answers `false`.
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
    `deadLettered=${lane.deadLetteredCount}`,
    `unmeasured=${lane.unmeasuredRows}`,
    `oldestPending=${formatBurndownAge(lane.oldestPendingAgeMs)} (${lane.oldestPendingBasis})`,
    `cursor=${formatCursorPosition(lane)} age=${formatBurndownAge(lane.durableCursorAgeMs)}`,
    `sinceLastPass: done=${formatCount(lane.workCompletedSincePrevious)} sent=${formatBurndownBytes(lane.bytesSentSincePrevious)}`,
  ];
  return parts.join(" ");
}

/** The "this lane is genuinely caught up" line. */
export function formatLaneFullySyncedLine(lane: SyncLaneBurndown): string {
  return `[${lane.lane}] fully synced to cloud — 0 remaining, 0 dead-lettered`;
}

/**
 * The "this lane stopped owing work but did NOT catch up" line. Deliberately
 * worded as *gave up*, because that is what a dead-letter is.
 */
export function formatLaneDrainedWithDeadLettersLine(
  lane: SyncLaneBurndown
): string {
  return `[${lane.lane}] NOT fully synced — queue empty but ${lane.deadLetteredCount} item(s) were dead-lettered (gave up, not caught up)`;
}

/**
 * The "this lane has nothing KNOWN outstanding, but could not prove it is caught
 * up" line. Names which of the two causes applies, because they are different
 * problems: a lane with no measurable remainder at all versus a lane holding
 * rows whose status this build cannot read.
 */
export function formatLaneRemainingUnknownLine(lane: SyncLaneBurndown): string {
  const cause =
    lane.unmeasuredRows > 0
      ? `${lane.unmeasuredRows} row(s) carry a status this build cannot classify`
      : "this lane exposes no measurable remainder";
  return `[${lane.lane}] NOT reported as fully synced — nothing known outstanding, but ${cause}, so "caught up" cannot be established`;
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
 * ISS-5973: WHY a lane stall was raised. Two different failures reach the same
 * monitored sink, and an operator cannot act on either without knowing which.
 */
export const SyncLaneStallKind = {
  /** Work is completing, but the durable cursor is not recording it (ISS-5347). */
  CursorFrozen: "cursor_frozen",
  /** The lane is running with a live backlog and is completing NOTHING. */
  NoProgress: "no_progress",
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
  if (madeDurableProgressSincePrevious(previous, current)) {
    return false;
  }
  if (current.readyItemsRemaining === 0) {
    // Every item this lane owes is inside its own backoff window, so there is
    // nothing eligible to work RIGHT NOW and completing zero units is the
    // scheduled behaviour, not a stall. `protocol_unavailable` defers invocation
    // parts for five minutes against a one-minute sample, so without this a
    // routine outage would clear the three-sample threshold and raise the
    // monitored error every single time. `null` is NOT this case: it means the
    // lane cannot tell deferred from ready, and an unmeasured remainder must
    // never be read as an empty one.
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
