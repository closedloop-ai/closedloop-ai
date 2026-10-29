/**
 * @file persisted-cursor-hydration.ts
 * @description FEA-1962 / FEA-3473 / FEA-3659 — the once-per-identity hydration:
 * adopt stranded outbox rows, load the durable `sync_state` cursor, apply it, and
 * resume the un-acked prefix and its retry counters.
 *
 * Hoisted out of `agent-session-sync-service.ts` by ISS-8116 for the reason its
 * siblings were (`initial-backfill-walk.ts`, `backfill-queue-feed.ts`,
 * `incremental-cursor-feed.ts`): that file is a shrink-only grandfathered
 * hotspot, and the post-await guards this ticket adds are worth more behind an
 * injected-dependency seam, where they can be executed against synthetic inputs
 * rather than merely inspected. Behavior is unchanged by the move; the service
 * keeps a thin delegate that hands its own fields through.
 *
 * ISS-7988 — the marker invariant every DISCARD below is written against:
 * `hydratedSourceKey` asserts that every once-per-identity read for that key
 * landed. A discard retracts that assertion, but only if no later hydration has
 * since written its own marker.
 *
 * ISS-8594 is the ticket the paragraph that used to sit here deferred. The retry
 * read's own failures — a throw, or a reply this build cannot parse — now DO
 * retract the marker, under the same compare-and-swap, and the hydration answers
 * {@link OutboxResumeOutcome.ReadFailed} so the caller abandons the pass. Re-arming is correct precisely
 * BECAUSE the pass no longer proceeds: re-reading next tick is not re-issuing a
 * read into a send that already happened, it is the only door back for a budget
 * that was never seeded. Un-hydrating alone was never enough — the identity is
 * unchanged on a read failure, so nothing else abandoned the pass, and it ran on
 * to candidate selection and uploaded against empty budget maps.
 */

import type { PersistedLaneRunRead } from "../sync/lane-run-policy.js";
import { reportLaneStallClockAnomaly } from "../telemetry/sync-lane-stall-clock-telemetry.js";
import type { SignedInUserIdentity } from "../util/user-identity.js";
import { adoptStrandedOutboxRows } from "./adopt-stranded-outbox-rows.js";
import {
  requeueResumeOutboxIds,
  type SessionDispositionDeps,
} from "./agent-session-sync-dispositions.js";
import type {
  AgentSessionSyncSource,
  PersistedSyncState,
  SessionOutboxEngineState,
  SyncContractCapabilities,
} from "./agent-session-sync-source.js";
import { readPersistedSyncState } from "./persisted-sync-state-reply-boundary.js";
import {
  OutboxResumeOutcome,
  resumeSessionOutboxEngineState,
  type SessionOutboxEngineCounters,
} from "./session-outbox-engine-state.js";

/**
 * The per-row retry state a resume rehydrates, all by REFERENCE.
 *
 * The per-reason half is {@link SessionOutboxEngineCounters} itself rather than a
 * hand-kept copy of its members: ISS-8605 added two and the copy silently went
 * stale, which is exactly the drift an intersection makes a compile error.
 */
export type HydrationRetryCounters = SessionOutboxEngineCounters & {
  nextRetryAfterMs: Map<string, number>;
  laneStalledSinceMsById: Map<string, number>;
  deadLetterRecoveryCountById: Map<string, number>;
  ackOmittedCycleById: Map<string, number>;
};

/** The service state one hydration reads and seeds, injected rather than reached for. */
export type PersistedCursorHydrationDeps = {
  /** The source this pass opened; every durable read below goes through it. */
  source: AgentSessionSyncSource;
  /**
   * ISS-8116: the pass guard, carrying the source-state generation AND the LIVE
   * source key. Re-read before EVERY post-await state application, not merely by
   * the caller after this returns.
   */
  isCurrentSourceState: () => boolean;
  /** The identity this pass is hydrating for, re-read live. */
  resolveLiveSourceKey: () => string | null;
  /**
   * ISS-5850 / ISS-7896: passed to the load so both sides compare the same
   * contract. It must be the WHOLE capability set, not one flag — the load and
   * the persist select a payload-contract revision from it, and a value that
   * disagrees between them makes every boot re-walk the corpus.
   */
  readContract: () => SyncContractCapabilities;
  readHydratedSourceKey: () => string | null;
  setHydratedSourceKey: (sourceKey: string | null) => void;
  readSourceDerivedStateKey: () => string | null;
  setSourceDerivedStateKey: (sourceKey: string | null) => void;
  clearSourceDerivedState: () => void;
  /** `this.options` — the identity/environment readers `adoptStrandedOutboxRows` needs. */
  syncOptions: {
    getSyncIdentity?: () => SignedInUserIdentity | null;
    getActiveEnvironmentKey?: () => string | null;
    /** ISS-9823: where {@link hydratePersistedCursorForPass} tees the outcome. */
    onResumeOutcome?: (outcome: OutboxResumeOutcome) => void;
  };
  /** Adopt the resumed watermark and the id set observed at it, and note it on disk. */
  applyResumedCursor: (
    observedTopUpdatedAt: string,
    observedIdsAtTopUpdatedAt: readonly string[]
  ) => void;
  /**
   * PLN-2028 (ISS-10053): adopt this identity's four durable lane-run columns
   * (`SessionFoldRunners.adoptLaneRun`). Separate from {@link applyResumedCursor}
   * because it is owed even when there is no watermark to resume: a lane can have
   * opened a run, or given up, before it ever acked a batch.
   */
  adoptLaneRun: (persisted: PersistedLaneRunRead | null | undefined) => void;
  /** Resumed dead-letters are SET ASIDE, never queued; INFINITE deadline. */
  deadLetteredIds: Map<string, number>;
  enforceDeadLetterCap: () => void;
  dispositionDeps: () => SessionDispositionDeps;
  retryCounters: HydrationRetryCounters;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
};

/**
 * FEA-1962: load the persisted cursor for the current principal/target the first
 * time we sync for it (and re-load after an identity change). A present watermark
 * resumes incremental sync from the last uploaded position; an absent one leaves
 * the cursor null so the initial walk performs a full backfill exactly as before.
 * Runs at most once per identity (guarded by `hydratedSourceKey`) so it never
 * re-queries mid-stream.
 *
 * ISS-8116 (davetho review): `isCurrentSourceState` is re-read before EVERY
 * post-await state application below, not merely by the caller after this
 * returns. `stop()` clears the single-flight `syncing` flag (`resetSourceState`),
 * so a pass for a NEW identity can run start-to-finish while one of these loads
 * is outstanding — and this hydration then wrote the OLD identity's watermark,
 * dead-letter set and `hydratedSourceKey` / `sourceDerivedStateKey` markers over
 * the live pass's own. A caller-side check cannot see that: by the time it runs,
 * the clobbering has happened. A discard writes nothing at all, so it leaves no
 * stale marker and the next pass re-reads the identity.
 *
 * ISS-8594: answers whether THIS IDENTITY IS HYDRATED AND THE PASS MAY CONTINUE.
 * Only {@link OutboxResumeOutcome.Seeded} continues it. The pass is abandoned on
 * a superseded discard (the caller's own identity guard was already going to
 * abandon that pass, so this only spells it), on a failed retry-state read, and
 * — the third condition, easy to miss because it predates the widened answer —
 * on a failed PENDING-IDS read. The last two are the ones nothing else would
 * have abandoned the pass for: the identity is unchanged, so the caller's own
 * guard reads true.
 *
 * ISS-9823: WHICH of those it was is now carried out rather than collapsed into
 * one `false`. FIVE non-continuing paths in TWO classes, and reporting the
 * second requires never reporting the first: the three
 * {@link OutboxResumeOutcome.Discarded} paths (adoption discard, post-`loadSyncState`
 * discard, post-retry-state discard) are ordinary account and compute-target
 * switches that happen on every sign-in, while the two
 * {@link OutboxResumeOutcome.ReadFailed} paths (a failed budget read, and a
 * thrown or unreadable pending-ids read) are a durable read that is failing. A
 * boolean cannot tell a caller which it got, so an alert derived from one would
 * fire on every account switch.
 *
 * Those five are the paths that RETURN. There is a sixth exit, and it returns
 * nothing: a thrown `loadSyncState` propagates out of here on purpose. Its
 * report is {@link hydratePersistedCursorForPass}'s, not this function's.
 */
export async function hydratePersistedCursor(
  deps: PersistedCursorHydrationDeps
): Promise<OutboxResumeOutcome> {
  const { source } = deps;
  const sourceKey = deps.resolveLiveSourceKey();
  const hydratedOnEntry = deps.readHydratedSourceKey();
  if (sourceKey === hydratedOnEntry) {
    // ISS-9823: `Seeded`, and never a short-circuit over a fault — every
    // non-`Seeded` path below re-arms `hydratedSourceKey`, so a failing read can
    // never reach here and clear the level it just set. It IS reachable with no
    // read having landed, when both keys are `null`: no compute target, so there
    // is no durable resume read to fail and nothing to report.
    return OutboxResumeOutcome.Seeded;
  }
  // ISS-7988: the marker value THIS invocation is responsible for. It starts as
  // whatever was on the field at entry (the previous identity's, or null on the
  // first hydration) and becomes `sourceKey` once this pass writes its own.
  let ownedMarker = hydratedOnEntry;
  // `hydratedSourceKey` asserts that every once-per-identity read for that key
  // landed. A discard retracts that assertion — but only if no LATER hydration
  // has since written its own, hence the compare-and-swap. An unconditional null
  // here clobbers a live pass's marker (ISS-8116 proved a superseding pass can
  // run start-to-finish while this continuation is parked); a bare return leaves
  // a marker asserting reads that this pass has since wiped.
  const reArm = () => {
    if (deps.readHydratedSourceKey() === ownedMarker) {
      deps.setHydratedSourceKey(null);
    }
  };
  // Identity changed (account / compute-target switch) or first hydration: drop
  // cursor/queue state derived from a different principal so we never upload the
  // new account's sessions against the old account's watermark.
  // ISS-6067: keyed on what the in-memory state belongs to, NOT on
  // `hydratedSourceKey` — the discard below nulls that marker while leaving this
  // pass's state seeded, which the old condition read as "nothing to clear".
  const derivedStateKey = deps.readSourceDerivedStateKey();
  if (derivedStateKey !== null && derivedStateKey !== sourceKey) {
    deps.clearSourceDerivedState();
  }
  // Before the `loadPendingOutboxIds` resume below, so a re-keyed row is
  // re-queued by this same pass. Never throws.
  await adoptStrandedOutboxRows(source, sourceKey, deps.syncOptions);
  if (!deps.isCurrentSourceState()) {
    // ISS-7988: `clearSourceDerivedState()` above already wiped what the entry
    // marker named, so returning without re-arming leaves it asserting reads
    // whose state is gone and short-circuits every later pass for that key.
    reArm();
    // ISS-9823: a RACE, not a fault — the identity moved while adoption was in
    // flight, which is what an account or compute-target switch looks like.
    return OutboxResumeOutcome.Discarded;
  }
  if (!(sourceKey && source.loadSyncState)) {
    // No identity yet, or a source without persistence → in-memory only, which
    // means today's full-backfill-on-restart behavior. Nothing async can fail
    // here, so mark the identity hydrated immediately.
    deps.setHydratedSourceKey(sourceKey);
    deps.setSourceDerivedStateKey(sourceKey);
    return OutboxResumeOutcome.Seeded;
  }
  // Mark the identity hydrated only AFTER a successful load. If loadSyncState
  // throws (e.g. the sync_state table is transiently unavailable), leaving
  // hydratedSourceKey unchanged lets the next sync tick retry the load instead of
  // the early-return guard permanently wedging the session on a full backfill and
  // ignoring the persisted watermark until restart. ISS-9823 re-review: the throw
  // is now REPORTED on its way past (`hydratePersistedCursorForPass`) and still
  // propagates, so everything this paragraph describes is unchanged.
  //
  // ISS-8115 — the cursor crosses the db-host IPC boundary, where its static type
  // is an assertion about the peer rather than a fact about the bytes. An
  // unreadable cursor degrades to `null` (full backfill: re-walks, loses nothing)
  // instead of seeding a half-trusted watermark that silently skips rows, and
  // instead of throwing out of hydration on `new Set(<non-iterable>)`.
  const persisted = readPersistedSyncState(
    await source.loadSyncState(sourceKey, deps.readContract())
  );
  if (!deps.isCurrentSourceState()) {
    // ISS-7988: same reason as the adoption discard above.
    reArm();
    // ISS-9823: a race, for the same reason the adoption discard is one.
    return OutboxResumeOutcome.Discarded;
  }
  deps.setHydratedSourceKey(sourceKey);
  ownedMarker = sourceKey;
  // Re-asserted here, not before the awaits: a `stop()` that landed mid-load
  // already ran `clearSourceDerivedState`, and what follows belongs to `sourceKey`.
  deps.setSourceDerivedStateKey(sourceKey);
  // ISS-9418: after the marker, because the writer resolves its identity from it.
  // Unconditional, and an absent record is adopted as "no run" rather than
  // skipped: the belief is what anchors a later fold to the FIRST give-up and
  // what stops a healthy lane paying a write to clear a stamp it never had.
  deps.adoptLaneRun(persisted);
  if (persisted?.observedTopUpdatedAt) {
    applyResumedCursor(deps, persisted, persisted.observedTopUpdatedAt);
  }

  return await resumeDurableOutboxState(deps, sourceKey, reArm);
}

/**
 * Seed the watermark and the dead-letters the persisted cursor recorded.
 *
 * The dead-letters are SET ASIDE — do NOT push them onto the backfill queue. They
 * are revisited last (only once both queues are drained, via
 * `promoteDeadLetterIfIdle`), so a resumed session settles to the persisted
 * watermark without re-walking the whole corpus and without eagerly retrying the
 * abandoned rows. INFINITE deadline keeps `recoverExpiredDeadLetters` from
 * re-enqueueing them ahead of live work; the idle-cycle revisit is their path
 * back. Absent/legacy cursors carry `deadLetteredIds: []`.
 */
function applyResumedCursor(
  deps: PersistedCursorHydrationDeps,
  persisted: PersistedSyncState,
  observedTopUpdatedAt: string
): void {
  deps.applyResumedCursor(
    observedTopUpdatedAt,
    persisted.observedIdsAtTopUpdatedAt
  );
  const deadLetteredIds = persisted.deadLetteredIds ?? [];
  for (const id of deadLetteredIds) {
    if (!deps.deadLetteredIds.has(id)) {
      deps.deadLetteredIds.set(id, Number.POSITIVE_INFINITY);
    }
  }
  // Bound the seeded set (a legacy cursor persisted before the cap could carry
  // more than MAX_DEAD_LETTERED_IDS); the next persist rewrites it capped.
  deps.enforceDeadLetterCap();
  const deadLetterSuffix =
    deadLetteredIds.length > 0
      ? ` and set ${deadLetteredIds.length} dead-lettered session(s) aside for later`
      : "";
  deps.logInfo(
    `resumed agent-session sync from persisted cursor (${persisted.observedIdsAtTopUpdatedAt.length} id(s) at top) — skipping full backfill${deadLetterSuffix}`
  );
}

/**
 * FEA-3473 (AC-1): re-enqueue the sessions that were enqueued but not acked
 * before a kill/restart, then FEA-3659's retry counters for them.
 *
 * Their durable `pending` outbox rows survived the crash; an acked session's row
 * was cleared on ack, so this re-uploads ONLY the un-acked prefix (bounded by the
 * outbox size), NOT the whole corpus. Runs even when no cursor was persisted (a
 * kill mid-first-backfill leaves a populated outbox but no cursor yet). Skipped
 * for legacy/fake sources without the delegate. A pending id already set aside as
 * a resumed dead-letter is left alone (the dead-letter revisit is its path back).
 */
async function resumeDurableOutboxState(
  deps: PersistedCursorHydrationDeps,
  sourceKey: string,
  reArm: () => void
): Promise<OutboxResumeOutcome> {
  const { source } = deps;
  if (source.loadPendingOutboxIds) {
    // ISS-6067: guarded across the await — see `requeueResumeOutboxIds`. The pass
    // guard and the LIVE source key are both captured/compared there, because a
    // `stop()` bumps the generation while a bare compute-target flip does not, and
    // only the pair catches both.
    const resumed = await requeueResumeOutboxIds(
      {
        sourceKey,
        loadPendingIds: () => source.loadPendingOutboxIds?.(sourceKey),
        readLiveSourceKey: deps.resolveLiveSourceKey,
      },
      deps.dispositionDeps()
    );
    if (resumed !== OutboxResumeOutcome.Seeded) {
      // Same discipline as the `loadSyncState` load above: the identity counts as
      // hydrated only once its resume read actually landed. A discard can fire
      // without anything clearing `hydratedSourceKey` (a dropped socket makes
      // `shouldRun()` false and the compute target read back null), and this read
      // runs at most once per identity, so leaving it hydrated would strand the
      // un-acked prefix for the life of the process. ISS-7988 made the null a
      // compare-and-swap so it can only retract THIS pass's own marker.
      //
      // ISS-8594 changed what this non-`Seeded` answer COSTS, which the sibling
      // requeue path being an explicit non-goal is easy to read as "unchanged":
      // the caller now abandons the pass on it, where before it only left the
      // identity un-hydrated and ran on. `requeueResumeOutboxIds` answers
      // `ReadFailed` for a THROWN or unreadable `loadPendingOutboxIds` reply and
      // `Discarded` for a superseded identity, so a failed pending-ids read
      // abandons the pass for the same reason a failed budget read does — the
      // un-acked prefix was not re-enqueued, and selecting candidates without it
      // is selecting against state that was never restored.
      reArm();
      // ISS-9823: propagated rather than flattened. Both abandon the pass, but
      // only `ReadFailed` is a fault — mapping this whole arm to one or the other
      // gets exactly half the contract wrong, because the superseded arm shares
      // this exit with the two failure arms.
      //
      // `sourceDerivedStateKey` deliberately still names `sourceKey`: that is what
      // makes the next pass clear this state when a different identity arrives.
      // Stop rather than seed retry counters for a dropped identity.
      return resumed;
    }
  }

  // FEA-3659 — the read, its ISS-8115 boundary validation and the seeding it
  // feeds all live with the counter routing they depend on.
  const loadPendingSessionOutboxEngineState =
    selectPendingSessionOutboxEngineStateLoader(source);
  if (!loadPendingSessionOutboxEngineState) {
    return OutboxResumeOutcome.Seeded;
  }
  const counters = deps.retryCounters;
  const { outcome } = await resumeSessionOutboxEngineState(
    () => loadPendingSessionOutboxEngineState(sourceKey),
    {
      counters,
      nextRetryAfterMs: counters.nextRetryAfterMs,
      laneStalledSinceMsById: counters.laneStalledSinceMsById,
      deadLetterRecoveryCountById: counters.deadLetterRecoveryCountById,
      ackOmittedCycleById: counters.ackOmittedCycleById,
      deadLetteredIds: deps.deadLetteredIds,
      logInfo: deps.logInfo,
      logWarn: deps.logWarn,
      reportInvalidStallClock: reportLaneStallClockAnomaly,
    },
    deps.isCurrentSourceState
  );
  if (RESUME_OUTCOME_ABANDONS_THE_PASS[outcome]) {
    // ISS-8594: the budget was NOT read — the delegate threw, or answered a
    // shape this build cannot parse. Seeding nothing and carrying on is the
    // FEA-3659 bug shape on the error path: a row mid-backoff at
    // `attempt_count = 4` has no deadline to defer it, is selected this tick,
    // and its next rejection recomputes the count as 1, dodging the persisted
    // backoff and the dead-letter cap together. Re-arm so a later tick re-reads,
    // and answer {@link OutboxResumeOutcome.ReadFailed} so the caller abandons
    // the pass before selection. The
    // retry is deliberately unbounded: the rows stay `pending` so nothing is
    // lost, and the lane stays paused until THIS read recovers. That is not a
    // claim that the lane's other durable reads must be failing too — a fault
    // scoped to this one SELECT (a migration that did not apply, say) leaves
    // its siblings on the same table working, and the lane still waits.
    reArm();
    // ISS-9823: the outcome itself, not a flattened sentinel — a fourth member
    // marked abandoning would carry its own identity out instead of borrowing
    // this one's.
    return outcome;
  }
  if (!deps.isCurrentSourceState()) {
    // ISS-7988: `resumeSessionOutboxEngineState` discards its own load on a superseded
    // pass and seeds nothing. That read runs at most once per identity and the
    // marker was already written above, so without this the persisted retry
    // budget — the backoff deadlines that keep `pickReadyCandidates` deferring a
    // failed row — is stranded for the life of the process. A dropped socket
    // reaches here with the identity untouched, which is why no later pass
    // clears the marker on its own.
    reArm();
    // ISS-9823: the third of the three races — a superseded pass, not a fault.
    return OutboxResumeOutcome.Discarded;
  }
  return OutboxResumeOutcome.Seeded;
}

/**
 * ISS-8594 review: which {@link OutboxResumeOutcome} abandons the pass on its
 * own, as an exhaustive map rather than one `=== ReadFailed` comparison.
 *
 * The comparison it replaces compiled unchanged against a fourth member and fell
 * through to `return true` — read as a seeded budget, which is the one answer
 * this ticket exists to stop the hydration giving when nothing was read. A
 * `Record` over the union cannot be written without naming every member, so the
 * next one added fails `tsc` here instead.
 *
 * `Discarded` is `false` deliberately: a superseded pass is NOT a read failure,
 * and the `isCurrentSourceState()` re-check below is what owns it. Keeping that
 * ordering is what leaves the ISS-8116 superseded-pass behavior exactly as it
 * was.
 */
const RESUME_OUTCOME_ABANDONS_THE_PASS: Record<OutboxResumeOutcome, boolean> = {
  [OutboxResumeOutcome.Seeded]: false,
  [OutboxResumeOutcome.Discarded]: false,
  [OutboxResumeOutcome.ReadFailed]: true,
};

/**
 * ISS-9823: the entry the sync SERVICE calls, and the one place a pass's
 * outcome is teed — on EVERY exit, returned or thrown.
 *
 * Two callers want different things from one pass. `SessionResumeHealth` needs
 * WHICH of the three outcomes happened, on every pass including the successful
 * ones, because it holds a level and a clear matters as much as a set. The pass
 * itself needs only "may I continue", which is `Seeded` and nothing else.
 *
 * The tee lives here rather than at the call site because the caller is
 * `agent-session-sync-service.ts` — a shrink-only grandfathered file, the same
 * reason this module exists at all — and because threading the outcome up
 * through a caller that does not use it, only to compare it there, widens that
 * file for a value it never reads.
 *
 * ISS-9823 re-review: the resume makes THREE durable reads, and the third —
 * `loadSyncState` — is the one that leaves by THROWING. `hydratePersistedCursor`
 * deliberately does not catch it (ISS-8594: an un-hydrated identity is what
 * makes the next tick retry), so teeing only the returned outcomes reported
 * nothing at all on that read's failure. On a caught-up device that is the whole
 * defect this ticket exists to close: the pass aborts before
 * `enqueueIncrementalUpdates`, `pending` stays 0, the level is never set, and
 * the lane goes on classifying as `drained` while nothing leaves the machine.
 * The catch below is CONTROL-FLOW NEUTRAL — it reports and rethrows, so the
 * caller, the un-hydrated identity, and the retry it buys are all unchanged.
 */
export async function hydratePersistedCursorForPass(
  deps: PersistedCursorHydrationDeps
): Promise<boolean> {
  let outcome: OutboxResumeOutcome;
  try {
    outcome = await hydratePersistedCursor(deps);
  } catch (error) {
    deps.syncOptions.onResumeOutcome?.(answerThrownHydration(deps));
    throw error;
  }
  deps.syncOptions.onResumeOutcome?.(outcome);
  return outcome === OutboxResumeOutcome.Seeded;
}

/**
 * What a THROWN hydration reports, decided by the rule its resolved sibling uses.
 *
 * `hydratePersistedCursor` re-checks `isCurrentSourceState()` the instant
 * `loadSyncState` resolves and answers `Discarded` when the pass was superseded.
 * A `stop()` or compute-target switch tears down the db-host channel the read is
 * parked on, so the switch is a plausible CAUSE of the rejection rather than a
 * coincidence, and latching a fault there would report one on every sign-in that
 * happened to race a transient failure — the rule `answerFailedRead`
 * (`agent-session-sync-dispositions.ts`) already applies to the other two reads.
 * Answering here with the same check keeps the two exits from one await from
 * disagreeing about whether the identity held.
 */
function answerThrownHydration(
  deps: PersistedCursorHydrationDeps
): OutboxResumeOutcome {
  if (deps.isCurrentSourceState()) {
    return OutboxResumeOutcome.ReadFailed;
  }
  return OutboxResumeOutcome.Discarded;
}

type LoadPendingSessionOutboxEngineState = (
  sourceKey: string
) => SessionOutboxEngineState[] | Promise<SessionOutboxEngineState[]>;

function selectPendingSessionOutboxEngineStateLoader(
  source: AgentSessionSyncSource
): LoadPendingSessionOutboxEngineState | null {
  if (source.loadPendingOutboxRetryState) {
    return (sourceKey) => source.loadPendingOutboxRetryState?.(sourceKey) ?? [];
  }
  return source.loadPendingSessionOutboxEngineState
    ? (sourceKey) =>
        source.loadPendingSessionOutboxEngineState?.(sourceKey) ?? []
    : null;
}
