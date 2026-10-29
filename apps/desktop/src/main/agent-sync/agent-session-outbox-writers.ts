/**
 * @file agent-session-outbox-writers.ts
 * @description The durable-outbox write helpers for the agent-session sync lane,
 * extracted out of the grandfathered `agent-session-sync-service.ts` (over the
 * 1,000-line ceiling) as a cohesive, directly unit-testable sibling — the twin of
 * the in-memory `backfill-queue-feed.ts` (ISS-4546). Every helper skips when the
 * identity/source is unknown or the source has no matching outbox delegate
 * (fake/legacy sources behave exactly as before) and swallows write failures
 * into a warning — a failed durable write only loses a resume hint for this
 * process (no data loss; the next cold start re-derives and the server dedupes).
 * All are fire-and-forget EXCEPT the three awaited, confirmation-reporting
 * writes: `clearOutboxOnAck` (goal stage 2), `recordOutboxReEnqueue` (ISS-7216)
 * and `recordOutboxStall` (ISS-8605). Each doc says which caller must sequence
 * on the result — the first two are the ones about to discard the last in-memory
 * record of the work, and the third is the one whose column IS a session's only
 * terminal bound. `settleAckedPriorityUploads` (ISS-10332) is awaited too, but
 * reports nothing: a lost settle only re-sends a priority once more.
 *
 * The service resolves `sourceKey` (its `hydratedSourceKey ?? resolveSyncSourceKey()`)
 * and `source` (its `options.getSource()`) once per call and threads them in, so
 * these stay pure functions with no reach back into the service.
 *
 * No `void` operator on the fire-and-forget writes: `noVoid` is enforced for this
 * module (it is not in the sync service's `noVoid: off` override), and the trailing
 * `.catch` already discards the settled value.
 */
import { gatewayLog } from "../logging/gateway-logger.js";
import { reportMalformedOutboxClearCount } from "../telemetry/sync-outbox-clear-count-telemetry.js";
import { SessionLaneRun } from "./agent-session-lane-run.js";
import type { AcceptedAckDeps } from "./agent-session-sync-accepted-ack.js";
// The canonical closed sync-class union lives in the lightweight contract module
// so the writer, the service, and the tests never re-declare the
// `"backfill" | "incremental"` literal (PR #4098 review, davetho).
import type { AgentSessionSyncClass } from "./agent-session-sync-contract.js";
import type { SessionFoldRunnerView } from "./agent-session-sync-fold-runners.js";
import type { OutboxStallWrite } from "./agent-session-sync-lane-stall-fold.js";
// Type-only import back into the (grandfathered) service that owns these two
// contract types. Erased at runtime, so this creates no value-level import cycle
// even though the service imports this module's writer functions.
import type {
  AgentSessionOutboxEntry,
  AgentSessionSyncSource,
} from "./agent-session-sync-source.js";
import {
  OutboxClearCountKind,
  type OutboxClearVerdict,
  readClearedRowCount,
} from "./outbox-clear-result.js";
import type { PriorityUploadClaim } from "./priority-upload-claims.js";
import { readDeadLetterReEnqueueConfirmation } from "./sync-source-reply-boundary.js";

/** Log scope for the outbox write helpers (mirrors the sync service's `TAG`). */
const TAG = "agent-session-sync";

export type OutboxWriteTarget = {
  /** The identity the outbox rows are scoped under, or `null` when unknown (offline/legacy). */
  sourceKey: string | null;
  /** The sync source (its outbox delegates), or `null` for a source without one. */
  source: AgentSessionSyncSource | null;
};

function warnOutboxWriteFailure(message: string, error: unknown): void {
  gatewayLog.warn(
    TAG,
    `${message}: ${error instanceof Error ? error.message : String(error)}`
  );
}

/**
 * FEA-3473: append `pending` outbox rows for newly-enqueued ids. Fire-and-forget.
 * Skipped when the identity/source is unknown or the source has no outbox
 * delegate (fake/legacy sources behave exactly as before).
 *
 * ISS-8612 corrected WHY a lost write is survivable, because the reason recorded
 * here was the wrong one and a wrong reason is what gets a real guard deleted.
 * It used to say "the next cold start re-enumerates" — that is FEA-3473's INITIAL
 * SEED argument (`seedThenPersistInitialBackfill`, which is awaited for exactly
 * that reason), and it does not hold for this writer: the corpus re-walk runs
 * only when NO cursor was ever persisted, so an already-synced device resumes its
 * cursor and skips it entirely. Its sibling {@link recordOutboxRePend} already
 * said so, and the two docstrings contradicted each other about the same
 * property.
 *
 * The guarantee is the DURABLE CURSOR, not the walk. This writer's ids are on a
 * queue when it fires, so they are in `unackedIds` with a live-scan stamp, and
 * `resolveCursorPrefixBoundary` caps the recordable watermark at the OLDEST such
 * stamp and serializes an empty tied-top set. The resume scan is then
 * `updated_at >= boundary`, which re-selects the row by construction. Losing this
 * write therefore costs a resume HINT and nothing else — even a crash in the same
 * instant leaves the persisted cursor at or below the row, because invariant 1
 * means the row leaves `unackedIds` only on a verified ack. Pinned end to end by
 * `test/agent-session-sync-cursor-prefix-restart.test.ts`, which wipes the outbox
 * before its restart precisely to model this write having never landed.
 */
export function recordOutboxEnqueue(
  target: OutboxWriteTarget,
  ids: string[],
  syncClass: AgentSessionSyncClass
): void {
  if (ids.length === 0) {
    return;
  }
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.enqueueOutboxEntries)) {
    return;
  }
  const entries: AgentSessionOutboxEntry[] = ids.map((externalSessionId) => ({
    externalSessionId,
    syncClass,
  }));
  Promise.resolve(source.enqueueOutboxEntries(sourceKey, entries)).catch(
    (error) => {
      warnOutboxWriteFailure(
        `failed to record ${entries.length} outbox enqueue(s)`,
        error
      );
    }
  );
}

/**
 * FEA-3473: clear the durable outbox rows for ids that just received a VERIFIED
 * server ack. This is the per-item durable progress — advanced ONLY on ack, never
 * on send (mirrors `TranscriptSyncState`).
 *
 * Goal stage 2 (atomic row-level ack): NOT fire-and-forget, unlike every other
 * writer in this module. The caller AWAITS this and treats the durable clear as
 * the ack processing itself — in-memory dequeue and cursor persistence happen
 * only after the delete committed, so a kill between ack-receipt and clear can
 * no longer exist as separate steps. The underlying `sqliteClearOutboxEntries`
 * is a single `deleteMany` statement, so the N-row clear is one transaction.
 *
 * `cleared` is `true` when the durable delete committed OR there was nothing
 * durable to clear (no ids, unknown identity, a fake/legacy source without an
 * outbox delegate — those sources have no rows to strand, so ack processing
 * proceeds in-memory exactly as before). It is `false` on a failed write
 * (warn-logged): the caller must then leave the acked rows queued so the next
 * pass re-sends them (bounded — the server dedupes an already-applied payload)
 * and re-attempts the clear on the re-ack, instead of dequeuing in memory while
 * the durable ledger still says `pending` (the "acked work re-sends on every
 * launch" bug).
 *
 * ISS-7957: `deletedRowCount` is the number of rows the delete ACTUALLY removed,
 * read back through `readClearedRowCount` because this result crosses the
 * db-host IPC boundary. It is OMITTED — never coerced to `0` — whenever no count
 * was measured: a source with no outbox delegate, a peer that predates the
 * field, or a reply whose shape cannot be believed. An omitted count reads as
 * "unmeasured" downstream; a `0` reads as "measured, cleared nothing", which is
 * the alarming value on the alert that has to tell those two apart.
 *
 * ISS-8179: those last two are not the same event, and this frame is where they
 * stop being reported as one. A peer that predates the field stays SILENT — it
 * is expected version skew, and root `AGENTS.md` forbids alarming on a peer
 * being older. A reply that CARRIES a `deletedRowCount` the boundary rejects is
 * IPC corruption or a producer defect, and rides two sinks: the desktop-local
 * log, which is the only one that may name the `sourceKey` and the acked-id
 * count, and the monitored `sync.outbox_clear_count.invalid` category, which is
 * content-free and latched once per process. The count is still OMITTED and the
 * ack still succeeds either way — reporting the anomaly changes nothing about
 * what this returns.
 *
 * Note the deliberate asymmetry with `cleared`: a zero-row delete is still a
 * SUCCESS. Nothing here gates on the count. The one constrained use downstream
 * (ISS-10429, in the cursor-stall detector) is described in
 * `outbox-clear-result.ts`.
 */
export async function clearOutboxOnAck(
  target: OutboxWriteTarget,
  ids: string[]
): Promise<OutboxClearVerdict> {
  if (ids.length === 0) {
    // Nothing was asked for; this is a measured zero, not an absent measurement.
    return { cleared: true, deletedRowCount: 0 };
  }
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.clearOutboxEntries)) {
    return { cleared: true };
  }
  try {
    const reading = readClearedRowCount(
      await source.clearOutboxEntries(sourceKey, ids)
    );
    if (reading.kind === OutboxClearCountKind.Malformed) {
      warnUnbelievableClearCount(sourceKey, ids.length);
      reportMalformedOutboxClearCount();
    }
    return reading.kind === OutboxClearCountKind.Measured
      ? { cleared: true, deletedRowCount: reading.deletedRowCount }
      : { cleared: true };
  } catch (error) {
    warnOutboxWriteFailure(
      `failed to clear ${ids.length} acked outbox row(s)`,
      error
    );
    return { cleared: false };
  }
}

/**
 * FEA-3473: durably mark an intentionally-abandoned session `dead_lettered` in the
 * outbox with a recorded `reason`. Every in-memory dead-letter funnels through
 * `markDeadLettered`, which calls this, so a stuck item is always recorded (never
 * silently dropped) and can never block cursor persistence.
 *
 * FEA-3659: propagate the exhausted `attemptCount` so the outbox row records the
 * real number of retries a transient failure burned before dead-lettering,
 * instead of a misleading 0. Deterministic classes dead-letter at attempt 0.
 */
export function recordOutboxDeadLetter(
  target: OutboxWriteTarget,
  id: string,
  reason: string,
  attemptCount = 0,
  permanentAttemptCount: number | null = null,
  deadLetterRecoveryCount: number | null = null
): void {
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.markOutboxDeadLettered)) {
    return;
  }
  Promise.resolve(
    source.markOutboxDeadLettered(
      sourceKey,
      id,
      reason,
      attemptCount,
      permanentAttemptCount,
      deadLetterRecoveryCount
    )
  ).catch((error) => {
    warnOutboxWriteFailure(
      `failed to mark outbox row ${id} dead-lettered`,
      error
    );
  });
}

/**
 * FEA-3697: durably flip a RECOVERED dead-letter's outbox row back to `pending` so
 * a restart's `loadPendingOutboxIds` re-discovers it. Called from every site that
 * DELETES an id from the in-memory `deadLetteredIds` set, so the durable outbox can
 * never be left `dead_lettered` for a row the lane no longer holds.
 *
 * ISS-7216 (PR #5708 review, whitlockk): AWAITED and CONFIRMATION-REPORTING, the
 * posture {@link clearOutboxOnAck} established for a durable write whose caller
 * is about to discard its last in-memory record of the work. `true` means the
 * outbox demonstrably owes the row (the flip committed, or it was already off
 * `dead_lettered` — pending/withheld/acked-and-cleared, where nothing is owed to
 * the dead-letter set), or that there is no durable ledger to lose it (unknown
 * identity, or a fake/legacy source without the delegate — the same "nothing
 * durable" `true` `clearOutboxOnAck` returns). `false` means the row may still be
 * sitting `dead_lettered`, which is invisible to `loadPendingOutboxIds`, to
 * stranded-row adoption, and to the incremental scan. It never rejects.
 *
 * ⚠️ Whether the caller MUST honor that result differs by caller:
 *
 * - `recoverExpiredDeadLetters` / `promoteDeadLetterIfIdle` may ignore it. They
 *   re-queue the id onto a live lane, the cursor cannot advance while a queue is
 *   non-empty, and the id stays in `deadLetteredIds` regardless — so a failed
 *   write costs only this process's durable hint.
 * - `enforceDeadLetterCap` MUST gate on it. Its whole purpose is to remove the id
 *   from `deadLetteredIds`, so it has no such fallback: a failed write it treated
 *   as success would lose the session. Two ways that failure arrives and only one
 *   of them throws — a rejected write (a locked or closing DB, a db-host IPC
 *   fault), and a write that matches ZERO ROWS while the row is still
 *   `dead_lettered`, which resolves normally. Hence a reported confirmation
 *   rather than the absence of an exception.
 */
export async function recordOutboxReEnqueue(
  target: OutboxWriteTarget,
  id: string
): Promise<boolean> {
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.reEnqueueRecoveredDeadLetter)) {
    return true;
  }
  try {
    // ISS-8135: the reply crosses the db-host boundary, where its `boolean`
    // annotation is an assertion about the peer rather than a fact about the
    // bytes — and `enforceDeadLetterCap` gates on TRUTHINESS, so an unreadable
    // verdict that merely looked truthy released this session's last in-memory
    // reference. Anything that is not literally a boolean is "not confirmed".
    return readDeadLetterReEnqueueConfirmation(
      await source.reEnqueueRecoveredDeadLetter(sourceKey, id)
    );
  } catch (error) {
    warnOutboxWriteFailure(
      `failed to re-enqueue recovered outbox row ${id}`,
      error
    );
    return false;
  }
}

/**
 * FEA-3659: durably record a transient retry-with-backoff on an outbox row so the
 * persisted `attempt_count` / `next_attempt_at` reflect the in-memory per-session
 * retry budget. Fire-and-forget, mirroring `recordOutboxDeadLetter`: a failed
 * write only loses the durable backoff hint, never blocks the sync.
 */
export function recordOutboxRetry(
  target: OutboxWriteTarget,
  id: string,
  attemptCount: number,
  nextAttemptAtMs: number,
  reason: string,
  laneStalledSince: string | null,
  permanentAttemptCount?: number | null
): void {
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.recordOutboxRetry)) {
    return;
  }
  Promise.resolve(
    source.recordOutboxRetry(
      sourceKey,
      id,
      attemptCount,
      new Date(nextAttemptAtMs).toISOString(),
      reason,
      laneStalledSince,
      permanentAttemptCount
    )
  ).catch((error) => {
    warnOutboxWriteFailure(
      `failed to record outbox retry for row ${id}`,
      error
    );
  });
}

/**
 * ISS-8605: the ENVIRONMENTAL defer's durable write, ACKNOWLEDGED — resolves
 * `true` only once the row committed.
 *
 * Same statement as {@link recordOutboxRetry} and deliberately not the same
 * contract. For a row-attributable defer the persisted `attempt_count` is a
 * durable hint beside an in-memory budget that terminates the row either way, so
 * fire-and-forget costs a hint. For an environmental defer the counters are
 * tallies and `lane_stalled_since` is the row's ONLY terminal path, so a write
 * that silently failed returns the row to an unbounded stall — see
 * `agent-session-sync-lane-stall-fold.ts`, which re-issues on `false`.
 *
 * Never rejects: a caller that had to catch could not tell a refused write from
 * a crashed one, and the refusal is the case it has to act on.
 */
export async function recordOutboxStall(
  target: OutboxWriteTarget,
  write: OutboxStallWrite
): Promise<boolean> {
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.recordOutboxRetry)) {
    // No durable outbox to stamp, so the ceiling genuinely is in-memory only.
    // Reporting success here would be the silent loss this writer exists to
    // surface.
    return false;
  }
  try {
    await source.recordOutboxRetry(
      sourceKey,
      write.id,
      write.attemptCount,
      new Date(write.nextAttemptAtMs).toISOString(),
      write.reason,
      write.laneStalledSince
    );
    return true;
  } catch (error) {
    warnOutboxWriteFailure(
      `failed to record the durable lane-stall clock for row ${write.id}`,
      error
    );
    return false;
  }
}

/**
 * ISS-7246: durably mark withheld sessions — those the drain judged
 * unsubstantive — so no lane owes them and the idle-tick outbox reconciliation
 * stops re-arming them.
 *
 * Fire-and-forget like its siblings: a failed write leaves the rows `pending`,
 * which is exactly today's behavior (they get re-queued, re-judged idle, and
 * re-withheld on a later pass) — wasted work, never lost data.
 */
export function recordOutboxWithheld(
  target: OutboxWriteTarget,
  ids: string[]
): void {
  if (ids.length === 0) {
    return;
  }
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.markOutboxWithheld)) {
    return;
  }
  Promise.resolve(source.markOutboxWithheld(sourceKey, ids)).catch((error) => {
    warnOutboxWriteFailure(
      `failed to mark ${ids.length} outbox row(s) withheld`,
      error
    );
  });
}

/**
 * ISS-7246: durably return withheld rows to `pending` when their sessions gain
 * new local activity, so a session that becomes substantive uploads instead of
 * staying withheld forever (`enqueueOutboxEntries` never touches `status`).
 *
 * Fire-and-forget, and the cursor is what makes that safe: the id is on the
 * incremental queue when this fires, and `persistCursorIfCaughtUp` refuses to
 * advance the durable watermark while either queue holds work. So a rejected
 * write followed by a crash leaves the persisted cursor BEHIND the bump, and the
 * next launch's incremental read re-selects the session and re-attempts the
 * flip. (The cold-start corpus walk is NOT that path — an already-synced device
 * resumes its cursor and skips the walk entirely.)
 */
export function recordOutboxRePend(
  target: OutboxWriteTarget,
  ids: string[]
): void {
  if (ids.length === 0) {
    return;
  }
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.rePendWithheldOutbox)) {
    return;
  }
  Promise.resolve(source.rePendWithheldOutbox(sourceKey, ids)).catch(
    (error) => {
      warnOutboxWriteFailure(
        `failed to re-pend ${ids.length} withheld outbox row(s)`,
        error
      );
    }
  );
}

/**
 * ISS-7265 AC3: record the tiling debt for sessions the server CONFIRMED while
 * their tiling was stripped, and settle it for those it confirmed intact.
 *
 * One call for both halves because they are one fact read two ways off the same
 * delivery, and splitting them invites a caller to record without settling —
 * which would leave a repaired session owed forever and re-bump it on the next
 * pass. Fire-and-forget with a warning: a failed record means the debt is not
 * remembered for THIS delivery, which the next stripped delivery of the same
 * session re-records, and a failed settle means one extra bump later. Neither
 * loses data, so neither may fail a sync tick.
 */
export async function recordActivityTilingDebt(
  target: OutboxWriteTarget,
  debt: { owed: readonly string[]; settled: readonly string[] }
): Promise<void> {
  const { source } = target;
  if (debt.settled.length > 0 && source?.settleActivityTilingDebt) {
    // NOT awaited: a lost settle costs one redundant re-queue that the next
    // intact delivery settles again. Nothing is lost by it.
    Promise.resolve(source.settleActivityTilingDebt([...debt.settled])).catch(
      (error) => {
        warnOutboxWriteFailure(
          `failed to settle ${debt.settled.length} activity-tiling debt(s)`,
          error
        );
      }
    );
  }
  if (!(debt.owed.length > 0 && source?.recordActivityTilingDebt)) {
    return;
  }
  // AWAITED, unlike every other writer here and unlike the settle above. The
  // caller runs this immediately BEFORE the durable outbox clear, and only an
  // await makes that ordering real: once the clear commits there is no other
  // record anywhere that this session shipped without its tiling, so a write
  // still in flight at that moment is a debt that a kill loses outright.
  //
  // A REJECTION is still only warned, deliberately, and does not abort the ack.
  // The failure would need a stripped delivery AND a store write failure in the
  // same instant, and even then the strip is not silent: this very batch's
  // Success event carries `tiling_stripped_count` and
  // `sync.payload_shaping = tiling_stripped`, and the cloud row records it. The
  // REPAIR is best effort on that path; the VISIBILITY this ticket exists for is
  // not, and buying the repair by refusing the ack would re-send whole sessions
  // over a maintenance write.
  try {
    await source.recordActivityTilingDebt([...debt.owed]);
  } catch (error) {
    warnOutboxWriteFailure(
      `failed to record ${debt.owed.length} owed activity tiling(s)`,
      error
    );
  }
}

/**
 * ISS-10332: stop re-sending the priorities an acked payload carried. Awaited so
 * the reset lands before the ack's outbox clear; a failure is only warned — the
 * marker stays set and the next sync of that session sends the value again.
 */
export async function settleAckedPriorityUploads(
  target: OutboxWriteTarget,
  claims: readonly PriorityUploadClaim[]
): Promise<void> {
  const { source } = target;
  if (!(claims.length > 0 && source?.settlePriorityUploads)) {
    return;
  }
  try {
    await source.settlePriorityUploads([...claims]);
  } catch (error) {
    warnOutboxWriteFailure(
      `failed to settle ${claims.length} priority upload claim(s)`,
      error
    );
  }
}

/**
 * ISS-7265 AC3: ask the lane to re-deliver every owed tiling, once per CAPABILITY
 * WINDOW, and only under the capability whose absence forced the strip.
 *
 * The `activityChunkingSupported` gate is the whole correctness argument, not a
 * convenience: under that capability the payload builder paginates the tiling
 * across chunks and CANNOT strip, so the re-delivery this provokes actually
 * carries the rows. Bumping without it would re-strip, re-record, and buy
 * nothing but sync-cursor churn.
 */
export function repairOwedActivityTilings(
  target: OutboxWriteTarget,
  activityChunkingSupported: boolean
): void {
  const { source } = target;
  if (!(activityChunkingSupported && source?.requeueOwedActivityTilings)) {
    return;
  }
  Promise.resolve(source.requeueOwedActivityTilings()).catch((error) => {
    warnOutboxWriteFailure("failed to re-queue owed activity tiling(s)", error);
  });
}

/**
 * ISS-7730: durably end the lane-wide stall run for `ids`. Fire-and-forget like
 * its siblings: a failed write leaves a stale clock on disk, which at worst
 * abandons the row one outage early on a later relaunch — never data loss, and
 * the dead-letter recovery lifecycle still re-drives it.
 */
export function clearOutboxLaneStall(
  target: OutboxWriteTarget,
  ids: string[]
): void {
  if (ids.length === 0) {
    return;
  }
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.clearOutboxLaneStall)) {
    return;
  }
  Promise.resolve(source.clearOutboxLaneStall(sourceKey, ids)).catch(
    (error) => {
      warnOutboxWriteFailure(
        `failed to clear the lane-stall clock on ${ids.length} outbox row(s)`,
        error
      );
    }
  );
}

/** Every durable-outbox write a lane performs, bound to one live target. */
export type OutboxWriters = {
  enqueue(ids: string[], syncClass: AgentSessionSyncClass): void;
  /**
   * Awaited and success-reporting — the ack clear is the one sequenced write.
   * ISS-7957: also reports the rows the delete actually removed, omitted when
   * nothing measured one. See {@link clearOutboxOnAck}.
   */
  clearOnAck(ids: string[]): Promise<OutboxClearVerdict>;
  deadLetter(
    id: string,
    reason: string,
    attemptCount?: number,
    permanentAttemptCount?: number | null,
    deadLetterRecoveryCount?: number | null
  ): void;
  /** Awaited and confirmation-reporting — the cap door releases on its `true`. */
  reEnqueue(id: string): Promise<boolean>;
  /**
   * ISS-7730: `laneStalledSince` is the ISO start of the row's current unbroken
   * LANE-WIDE failure run, or null for a row-attributable defer — and null is a
   * clear, not a no-op, because an answered rejection ends any stall in
   * progress. Required rather than optional so a new defer class has to decide
   * which it is instead of silently inheriting a stale clock.
   */
  retry(
    id: string,
    attemptCount: number,
    nextAttemptAtMs: number,
    reason: string,
    laneStalledSince: string | null,
    permanentAttemptCount?: number | null
  ): void;
  /**
   * ISS-8605: the environmental defer's twin of {@link OutboxWriters.retry},
   * awaited and confirmation-reporting because `laneStalledSince` is that row's
   * only terminal bound. See {@link recordOutboxStall}.
   */
  stall(write: OutboxStallWrite): Promise<boolean>;
  markWithheld(ids: string[]): void;
  rePend(ids: string[]): void;
  /**
   * ISS-7265 AC3: the tiling-debt ledger's record + settle, in one call. Awaited
   * for the OWED half only — see the writer for why that half is sequenced.
   */
  recordTilingDebt(debt: {
    owed: readonly string[];
    settled: readonly string[];
  }): Promise<void>;
  /** ISS-10332: see {@link settleAckedPriorityUploads}. */
  settlePriorityUploads(claims: readonly PriorityUploadClaim[]): Promise<void>;
  /** ISS-7265 AC3: drain the debt once per capability window, under the capability. */
  repairOwedTilings(activityChunkingSupported: boolean): void;
  /** ISS-7730: a row-attributable rejection proves the lane answered. */
  clearLaneStall(ids: string[]): void;
  /**
   * PLN-2028 (ISS-10053, ISS-9963, ISS-10043): this lane's four durable
   * `sync_state` lane-run columns — the run origin, the give-up, its cause and
   * its producer.
   *
   * Lane-level, alongside — never instead of — the per-row recoverable
   * dead-letter the ceiling already writes. That dead-letter is what RELEASES
   * the watermark (a deferred row pins the cursor; only a RECORDED dead-letter
   * may advance past it), so replacing it with this record would stop the
   * session lane making progress for the whole outage.
   *
   * Held here rather than on the service for the reason `tilingRepairArmed` is:
   * the service is grandfathered and must not grow another member. Exposed
   * whole, because the fold runners own the gate every one of its operations
   * takes.
   */
  laneRun: SessionLaneRun;
  /**
   * The consumer-shaped views of the writes above — see
   * {@link OutboxWriterSlices}.
   */
  slices: OutboxWriterSlices;
};

/**
 * ISS-7246 (cr-60883): bind every writer above to one live target getter.
 *
 * The target is resolved per CALL, not captured: a lane's identity changes under
 * it (hydration, an account switch), and a writer that closed over a stale
 * `sourceKey` would write another account's partition. Extracted so the sync
 * service holds one collaborator instead of eight pass-through members — it is a
 * grandfathered over-ceiling file, and shared root `AGENTS.md` requires a change
 * that touches one to leave it smaller.
 */
export function createOutboxWriters(
  readTarget: () => OutboxWriteTarget
): OutboxWriters {
  // ISS-7265 AC3: the repair drain is a whole-ledger sweep, so it must not run
  // on every tick that observes the capability — but "once per lane lifetime" is
  // WRONG, and the difference is a stall. `activityChunkingSupported` is re-read
  // live every tick and flaps (reconnect, a server-version rollback, an account
  // switch onto a different backend), and a strip can ONLY happen while it is
  // false. So a latched one-shot would sweep, then sit inert through exactly the
  // window that creates new debts, stranding them until the next app START. The
  // flag is therefore re-armed whenever the capability goes away, which makes the
  // next `true` a fresh window — the moment new debts can exist and can finally
  // be repaired. Held here, beside the writers, so the grandfathered service does
  // not grow a member for it.
  let tilingRepairArmed = true;
  // PLN-2028: the lane's durable run, beside `tilingRepairArmed` and for the same
  // reason — the grandfathered service does not grow a member. The target is
  // re-read per call, so an identity switch writes the new lane's row and a null
  // `sourceKey` (pre-hello) simply writes nothing.
  const laneRun = new SessionLaneRun({
    readSourceKey: () => readTarget().sourceKey,
    getSource: () => readTarget().source,
    onWriteFailed: (message) =>
      warnOutboxWriteFailure("failed to write the durable lane run", message),
    // Named on the same local channel, under the same names the component twin
    // uses, so an operator who greps one lane's warning finds the other's.
    onRunDefect: (name, message) =>
      gatewayLog.warn(TAG, `lane run ${name}: ${message}`),
  });
  const writers: Omit<OutboxWriters, "slices"> = {
    laneRun,
    enqueue: (ids, syncClass) =>
      recordOutboxEnqueue(readTarget(), ids, syncClass),
    clearOnAck: (ids) => clearOutboxOnAck(readTarget(), ids),
    deadLetter: (
      id,
      reason,
      attemptCount = 0,
      permanentAttemptCount = null,
      deadLetterRecoveryCount = null
    ) =>
      recordOutboxDeadLetter(
        readTarget(),
        id,
        reason,
        attemptCount,
        permanentAttemptCount,
        deadLetterRecoveryCount
      ),
    reEnqueue: (id) => recordOutboxReEnqueue(readTarget(), id),
    retry: (
      id,
      attemptCount,
      nextAttemptAtMs,
      reason,
      laneStalledSince,
      permanentAttemptCount
    ) =>
      recordOutboxRetry(
        readTarget(),
        id,
        attemptCount,
        nextAttemptAtMs,
        reason,
        laneStalledSince,
        permanentAttemptCount
      ),
    stall: (write) => recordOutboxStall(readTarget(), write),
    markWithheld: (ids) => recordOutboxWithheld(readTarget(), ids),
    rePend: (ids) => recordOutboxRePend(readTarget(), ids),
    recordTilingDebt: (debt) => recordActivityTilingDebt(readTarget(), debt),
    settlePriorityUploads: (claims) =>
      settleAckedPriorityUploads(readTarget(), claims),
    repairOwedTilings: (activityChunkingSupported) => {
      if (!activityChunkingSupported) {
        tilingRepairArmed = true;
        return;
      }
      if (!tilingRepairArmed) {
        return;
      }
      tilingRepairArmed = false;
      repairOwedActivityTilings(readTarget(), activityChunkingSupported);
    },
    clearLaneStall: (ids) => clearOutboxLaneStall(readTarget(), ids),
  };
  return { ...writers, slices: buildOutboxWriterSlices(writers) };
}

/**
 * ISS-8179: the desktop-LOCAL half of reporting an unbelievable clear count.
 *
 * This is the only sink allowed to name the `sourceKey` and how many ids the ack
 * covered — the monitored category its caller emits alongside is content-free by
 * construction, the same split `sync-failure-diagnostic.ts` makes. It is a
 * `warn` and not an error because the clear itself COMMITTED: only the
 * bookkeeping is unreadable, and nothing downstream is denied.
 */
function warnUnbelievableClearCount(sourceKey: string, idCount: number): void {
  gatewayLog.warn(
    TAG,
    `durable clear of ${idCount} acked outbox row(s) under ${sourceKey} reported an unbelievable deletedRowCount; the rows are gone and the count is omitted`
  );
}

/**
 * One view per consumer of the writes above, each `Pick`ed off that consumer's
 * own deps type so the pair cannot drift.
 *
 * They exist so `agent-session-sync-service.ts` spreads ONE slice into each deps
 * object instead of restating eight pass-through members: it is a grandfathered
 * over-ceiling file, and this keeps a new write beside its siblings here rather
 * than growing that file. Held on the collaborator for the same reason
 * `tilingRepairArmed` is — the service does not grow a member for it either.
 */
export type OutboxWriterSlices = {
  folds: Pick<
    SessionFoldRunnerView,
    | "clearOutboxLaneStall"
    | "laneRun"
    | "recordOutboxRetry"
    | "recordOutboxStall"
  >;
  acceptedAck: Pick<
    AcceptedAckDeps,
    "clearOutboxDurably" | "recordTilingDebt" | "settlePriorityUploads"
  >;
};

function buildOutboxWriterSlices(
  writers: Omit<OutboxWriters, "slices">
): OutboxWriterSlices {
  return {
    folds: {
      recordOutboxRetry: (
        id,
        attemptCount,
        nextAttemptAt,
        reason,
        stalledSince,
        permanentAttemptCount
      ) =>
        writers.retry(
          id,
          attemptCount,
          nextAttemptAt,
          reason,
          stalledSince,
          permanentAttemptCount
        ),
      recordOutboxStall: (write) => writers.stall(write),
      clearOutboxLaneStall: (ids) => writers.clearLaneStall(ids),
      laneRun: writers.laneRun,
    },
    acceptedAck: {
      clearOutboxDurably: (ids) => writers.clearOnAck(ids),
      recordTilingDebt: (debt) => writers.recordTilingDebt(debt),
      settlePriorityUploads: (claims) => writers.settlePriorityUploads(claims),
    },
  };
}
