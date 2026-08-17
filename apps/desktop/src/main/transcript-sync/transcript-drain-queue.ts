/**
 * @file transcript-drain-queue.ts
 * @description The archive lane's upload pump: claim due files at bounded
 * concurrency, run them through the per-file executor, and settle the result on
 * the retry ladder (PLN-1288 task 3).
 *
 * Split out of `transcript-sync-service.ts`. The automatic drain and the
 * FEA-3489 user-initiated force-archive live together on purpose — they are two
 * entry points onto ONE executor and they arbitrate through the SAME `inFlight`
 * claim set. Separating them would put that set behind an accessor and make it
 * possible to add a third caller that forgets to claim, which is exactly the
 * race (a concurrent drain grabbing a freshly-revived row at offset 0 and
 * re-dead-lettering it) the claim exists to prevent.
 */
import {
  TranscriptSkipReason,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { isRecoverableDbHostExitError } from "../../shared/db-host-exit-error.js";
import type { TranscriptForceArchiveResult } from "../../shared/transcript-read-contract.js";
import { TranscriptSyncStatus } from "../../shared/transcript-sync-status-contract.js";
import type { TranscriptSettle } from "../database/transcript-sync-settle.js";
import type {
  TranscriptRowIdentity,
  TranscriptSyncStore,
} from "../database/transcript-sync-store.js";
import {
  type TranscriptSyncExecutor,
  type TranscriptSyncResult,
  TranscriptSyncRevokedError,
} from "./transcript-sync-executor.js";
import {
  isoAfter,
  TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX,
  TRANSCRIPT_SYNC_MAX_CONSECUTIVE_FAILURES,
  type TranscriptFingerprint,
  transcriptQueueKey,
  transcriptRetryDelayMs,
} from "./transcript-sync-types.js";

const READY_BATCH_LIMIT = 32;

/**
 * FEA-3489: max bypass windows a single force-archive drives back-to-back before
 * yielding. An oversized transcript can exceed one plan window (a huge or still-
 * appending file), so the forced upload continues under the cap-bypass until the
 * server catches up — otherwise the next AUTOMATIC drain, which never bypasses,
 * would re-hit the size cap and dead-letter the partially-uploaded row. Bounded
 * (no unbounded wait): a pathologically fast-growing file that never catches up
 * within this many windows returns `caughtUp:false` and the durable lane owns the
 * rest (the row stays queued; a re-force resumes from the advanced cursor).
 */
const FORCE_SYNC_MAX_WINDOWS = 8;

/**
 * ISS-4849: how many CONSECUTIVE failed batch flushes the drain will recover
 * in-process before it stops trying and leaves the rows to boot recovery.
 *
 * The recovery re-queues the batch so the next 5s tick retries it in the running
 * process instead of stranding it `uploading` until the next app launch. The cap
 * is what keeps that from becoming a spin: if the flush keeps failing while the
 * READS still succeed (so the drain keeps picking work), we stop re-arming and
 * let `requeueStale` own it at the next boot. The counter resets on the first
 * flush that lands, so a transient blip never consumes the budget permanently.
 */
const MAX_FLUSH_RECOVERY_ATTEMPTS = 3;

/**
 * ISS-5808: cap on the identities held for host-exit re-arm.
 *
 * Only rows THIS process claimed can land in the set, and each drain claims at
 * most `concurrency`, so it grows a batch at a time — but a host that stays down
 * across many drains would still accumulate. Past the cap we stop remembering
 * and say so; those rows fall back to `requeueStale` at the next boot, which is
 * the pre-ISS-5808 behaviour and loses nothing. An unbounded Set fed by external
 * input is exactly what the repo's memory-leak rule forbids.
 */
const MAX_HOST_EXIT_ABANDONED_ROWS = 256;

/** The store + executor pair the pump is currently bound to. */
export type TranscriptSyncRuntime = {
  store: TranscriptSyncStore;
  executor: TranscriptSyncExecutor;
};

export type TranscriptDrainQueueDeps = {
  /** Every precondition (flag, online, consent tier, store) in one gate. */
  shouldRun: () => boolean;
  /** Current store + a matching executor, or null before the db-host is ready. */
  resolveRuntime: () => TranscriptSyncRuntime | null;
  /**
   * ISS-4621: snapshotted BEFORE each upload attempt so the ack-gated
   * `retries_exhausted` skip records under the target the attempt (and its
   * cloud rows) belong to, not one a mid-attempt reconnect switched to.
   */
  getComputeTargetId: () => string | null;
  now: () => string;
  log: (message: string) => void;
  concurrency: number;
};

export class TranscriptDrainQueue {
  private readonly inFlight = new Set<string>();
  private readonly deps: TranscriptDrainQueueDeps;
  /**
   * ISS-4849: consecutive `recordBatchSettled` rejections. Reset to 0 by the
   * first flush that lands, so this bounds a PERSISTENT flush failure without
   * ever consuming the budget for a transient one.
   */
  private flushRecoveryAttempts = 0;
  /**
   * ISS-5808 (wongk review) — rows this process left `uploading` because the
   * db-host child died mid-upload, keyed by {@link transcriptQueueKey}.
   *
   * `uploading` is invisible to `listReady`, so nothing re-picks them. The FIRST
   * shape of this fix re-armed them by re-running the sweeper's boot recovery,
   * `requeueStale` — but that resets EVERY `uploading` row, and its own contract
   * says that is safe only at boot "because no upload is in flight in a fresh
   * process". Here the service is live with overlapping drains, so it could
   * reset a sibling's legitimately-active claim and have that row re-uploaded
   * after its settle landed. This set is the identity-scoped replacement:
   * `requeueUnsettledBatch` touches exactly these identities, and only while
   * they are still `uploading`, so a row that settled in the meantime is left
   * alone. Bounded by {@link MAX_HOST_EXIT_ABANDONED_ROWS}.
   */
  private readonly hostExitAbandoned = new Map<string, TranscriptRowIdentity>();

  constructor(deps: TranscriptDrainQueueDeps) {
    this.deps = deps;
  }

  /**
   * Drain queued/failed files that are due, live-first, at bounded concurrency.
   *
   * There is deliberately NO batch-wide re-entrancy guard: overlapping
   * `drainOnce` calls (the 5s tick, `refresh`, and hook-driven live enqueues)
   * are allowed to run concurrently so a slot freed by a fast upload can be
   * refilled — and a live transcript arriving mid-batch can preempt into it —
   * without waiting for the whole in-flight batch's slowest upload to finish
   * (FEA-3388, AC4 ~5min freshness). Concurrency stays bounded because the
   * claim loop below is synchronous: it re-reads `inFlight.size` on every
   * iteration and only `add`s a key with no `await` in between, so no two
   * overlapping drains can push `inFlight` past `concurrency`, and the existing
   * `inFlight.has` check still prevents double-claiming the same file.
   */
  async drainOnce(): Promise<void> {
    if (!this.deps.shouldRun()) {
      return;
    }
    const runtime = this.deps.resolveRuntime();
    if (!runtime) {
      return;
    }
    // ISS-5808: re-arm anything a db-host exit stranded `uploading`, BEFORE the
    // busy-slot short-circuit below — those rows are invisible to `listReady`,
    // so starving this behind a full batch would leave them stranded exactly
    // while the lane is busiest.
    await this.recoverHostExitAbandoned(runtime.store);
    // Cheap short-circuit: skip the listReady round-trip when every slot is busy.
    if (this.inFlight.size >= this.deps.concurrency) {
      return;
    }
    const ready = await runtime.store.listReady(
      this.deps.now(),
      READY_BATCH_LIMIT
    );
    const toRun: TranscriptFingerprint[] = [];
    for (const fp of ready) {
      // Re-check the live count each iteration (not a pre-await snapshot) so
      // concurrent drains can't collectively over-subscribe the slots.
      if (this.inFlight.size >= this.deps.concurrency) {
        break;
      }
      const key = transcriptQueueKey(fp.externalSessionId, fp.fileKey);
      if (!this.inFlight.has(key)) {
        this.inFlight.add(key); // claim synchronously before any await
        toRun.push(fp);
      }
    }
    // ISS-4723 PR2: collect every file's TERMINAL settle from this batch and
    // flush them in ONE `recordBatchSettled` write instead of one write per
    // file (at concurrency N that is up to N settle writes competing with the
    // backfill, each a checkpoint-eligible write). `markUploading` still lands
    // per-file inside `syncFile` (the FEA-2827 growth-signal guard), so only the
    // settle is deferred. A settle that never lands (crash before flush) is
    // harmless — the row is still `uploading` and `requeueStale` revives it on
    // boot, then the server-authoritative cursor re-plans it. The drain-queue's
    // OWN exception settles (`recordFailure` / `requeueRevoked`) stay immediate
    // writes: they are the rarer error paths and carry their own ack-gated
    // dead-letter logic.
    //
    // `allSettled`, NOT `all`: every worker must finish handing its terminal
    // settle to the collector BEFORE the flush. With `Promise.all`, a worker
    // whose OWN drain-queue write (`recordFailure` / `requeueRevoked` in the
    // `catch`) rejects would reject the aggregate immediately, flushing only the
    // settles collected so far while a slower sibling is still uploading; that
    // sibling would then append its settle AFTER the sole flush and strand its
    // row `uploading` until restart recovery. Waiting for all workers closes
    // that window. We still surface the first rejection after the flush so a
    // stop/mid-batch write failure is not swallowed.
    const settles: TranscriptSettle[] = [];
    const outcomes = await Promise.allSettled(
      toRun.map((fp) =>
        this.processFile(runtime.store, runtime.executor, fp, (settle) => {
          settles.push(settle);
        })
      )
    );
    // ISS-4849: a REJECTED flush leaves every file in this batch `uploading` —
    // a status `listReady` excludes — so without in-process recovery the whole
    // batch is stranded until the next boot's `requeueStale`. Re-arm it here,
    // bounded, then still surface the failure to the caller.
    try {
      await runtime.store.recordBatchSettled(settles);
      // Only a flush that actually WROTE something proves the settle path is
      // healthy again (wongk review). An overlapping tick that collected no
      // settles — e.g. while a just-recovered row is back in flight — reaches
      // `recordBatchSettled([])`, which is a no-op success; resetting on that
      // would put the next real flush back at attempt 1 and let a persistent
      // settle failure re-queue forever instead of handing off to boot recovery
      // after MAX_FLUSH_RECOVERY_ATTEMPTS.
      if (settles.length > 0) {
        this.flushRecoveryAttempts = 0;
      }
    } catch (flushError) {
      await this.recoverFailedFlush(runtime.store, toRun);
      throw flushError;
    }
    const firstRejection = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected"
    );
    if (firstRejection) {
      throw firstRejection.reason;
    }
  }

  private async processFile(
    store: TranscriptSyncStore,
    executor: TranscriptSyncExecutor,
    fp: TranscriptFingerprint,
    collectSettle: (settle: TranscriptSettle) => void
  ): Promise<void> {
    const key = transcriptQueueKey(fp.externalSessionId, fp.fileKey);
    // Snapshot the target BEFORE the attempt so a reconnect mid-attempt cannot
    // make the terminal skip below record under a different target identity
    // than the one the attempt (and its cloud rows) belong to.
    const attemptComputeTargetId = this.deps.getComputeTargetId();
    try {
      const result = await executor.syncFile(fp, {
        settleCollector: collectSettle,
      });
      // A successful upload that isn't caught up leaves the row queued; the next
      // drain tick continues it (bounded progress, no recursion).
      if (result.kind === "uploaded" && !result.caughtUp) {
        this.deps.log(`transcript ${fp.fileKey} advanced; more to sync`);
      }
    } catch (error) {
      if (error instanceof TranscriptSyncRevokedError) {
        // FEA-3907: the privacy gate revoked egress mid-upload (user lowered the
        // Data & Sync level to Off). This is NOT a failure — no bytes escaped, so
        // do NOT advance the retry ladder or dead-letter. ISS-4621: settle the
        // row back to `queued`, NOT `idle` — the `shouldRun` gate suppresses the
        // drain while the tier is closed, and the row resumes the moment it
        // reopens. Idling here relied on the next observe re-queuing "unsynced
        // growth", but observe only re-queues on a CHANGE, so an ended session's
        // transcript (which never changes again) was stranded at zero bytes
        // forever — the SES-78221 limbo minted at the source.
        await store.requeueRevoked(
          fp.externalSessionId,
          fp.fileKey,
          this.deps.now()
        );
        this.deps.log(`transcript ${fp.fileKey} upload aborted: sync revoked`);
        return;
      }
      // ISS-5808 (wongk review): the db-host child died under this upload and a
      // replacement is already coming. That is not THIS FILE's failure, so it
      // must not touch the retry ladder: `recordFailure` increments
      // `retryCount`, and a run of host exits would climb a healthy transcript
      // to TRANSCRIPT_SYNC_MAX_CONSECUTIVE_FAILURES and dead-letter it with a
      // `retries_exhausted` skip the cloud then believes. Swallowing it was also
      // hiding the exit from the lane's own recovery — this catch never
      // rethrew, so the service's detached-task handler never saw the one error
      // class it exists to react to. Remember the identity for the re-arm, log
      // it as an abandonment (matching the collector's wording for the same
      // event), and rethrow.
      if (isRecoverableDbHostExitError(error)) {
        this.rememberHostExitAbandoned(fp);
        this.deps.log(
          `transcript ${fp.fileKey} upload abandoned: db-host exited mid-upload; retry budget untouched`
        );
        throw error;
      }
      await this.recordFailure(
        store,
        executor,
        fp,
        error,
        "failed",
        attemptComputeTargetId
      );
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * FEA-3489 (PRD-536): user-initiated force-archive of ONE oversized transcript
   * that the automatic lane dead-lettered because it exceeded
   * `TRANSCRIPT_SYNC_MAX_FILE_BYTES`. Revives that single dead row (scoped in
   * the store to the whole-file-cap terminal ONLY) and drives its resumable upload
   * with the size cap waived, continuing across plan windows until the server
   * catches up or a bounded window count is reached.
   *
   * Reuses the existing resumable multipart upload lane and every gate that lane
   * enforces (privacy tier, online compute target). Returns the canonical
   * {@link TranscriptForceArchiveResult} so the renderer renders an honest state:
   *  - `notFound`: no dead row for `(externalSessionId, fileKey)` (nothing to do).
   *  - `permanent`: the row IS dead, but for a reason the size-cap bypass cannot
   *    fix (source gone, or a single redacted JSONL line over the per-line wire
   *    limit) — terminal, NOT retryable.
   *  - `unavailable`: the sync lane is off / offline / not permitted, or another
   *    pass already holds this file — retryable.
   *  - `uploaded` / `noop`: the forced upload settled. `caughtUp:false` means more
   *    chunks remain; the automatic drain now bypasses the cap for a
   *    partially-synced row (`syncedByteOffset > 0`), so the durable lane truly
   *    owns the remainder and it is NOT re-dead-lettered.
   *  - `failed`: a RETRYABLE transient upload failure.
   *
   * Concurrency: the `inFlight` key is claimed BEFORE the revive so a concurrent
   * automatic drain (or a second force call) cannot grab the freshly-`queued` row
   * at offset 0 and re-dead-letter it between revive and the first upload
   * (mirrors `drainOnce`/`processFile`; released in `finally`). Bounded work: at
   * most {@link FORCE_SYNC_MAX_WINDOWS} `syncFile` attempts, no unbounded wait and
   * no whole-file buffering (each window streams a bounded delta).
   */
  async forceSyncOversized(
    externalSessionId: string,
    fileKey: string
  ): Promise<TranscriptForceArchiveResult> {
    if (!this.deps.shouldRun()) {
      return { kind: "unavailable" };
    }
    const runtime = this.deps.resolveRuntime();
    if (!runtime) {
      return { kind: "unavailable" };
    }
    const { store, executor } = runtime;
    // Claim the queue key FIRST so neither a concurrent automatic drain nor a
    // second force call can process this file between the revive and the first
    // upload window. A busy key means another pass already owns it — the caller
    // can retry once it settles.
    const key = transcriptQueueKey(externalSessionId, fileKey);
    if (this.inFlight.has(key)) {
      return { kind: "unavailable" };
    }
    this.inFlight.add(key);
    try {
      const revived = await store.reviveForForcedSync({
        externalSessionId,
        fileKey,
        now: this.deps.now(),
      });
      if (revived === 0) {
        // Nothing eligible was revived: either there is no dead row (nothing to
        // do) or the row is dead for a reason the bypass cannot fix (terminal).
        return await this.classifyIneligibleForceSync(store, {
          externalSessionId,
          fileKey,
        });
      }
      const fp = await store.get(externalSessionId, fileKey);
      if (!fp) {
        // Revived above but vanished before re-read (concurrent prune): gone.
        return { kind: "notFound" };
      }
      return await this.runForcedSyncWindows(store, executor, fp);
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Resolve the result when `reviveForForcedSync` revived nothing. The store
   * scopes the revive to the whole-file-cap terminal, so a zero count is either a
   * missing row (`notFound`) or a `dead` row terminal for a NON-cap reason
   * (`permanent`) — the latter must NOT invite a retry the bypass cannot satisfy.
   */
  private async classifyIneligibleForceSync(
    store: TranscriptSyncStore,
    ref: { externalSessionId: string; fileKey: string }
  ): Promise<TranscriptForceArchiveResult> {
    const existing = await store.get(ref.externalSessionId, ref.fileKey);
    const isCapTerminal =
      existing?.lastError?.startsWith(
        TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX
      ) ?? false;
    if (existing?.status === TranscriptSyncStatus.Dead && !isCapTerminal) {
      return {
        kind: "permanent",
        reason: existing.lastError ?? "transcript permanently unavailable",
      };
    }
    return { kind: "notFound" };
  }

  /**
   * Drive the bypass upload across plan windows until the server catches up or the
   * bounded window count is reached. A single window can leave an oversized file
   * `queued` with `caughtUp:false`; because the executor now also bypasses the cap
   * for a resume-in-progress row (`syncedByteOffset > 0`), the automatic drain
   * carries any remainder to completion instead of re-dead-lettering it — so even
   * hitting the window cap is safe (the durable lane owns the rest).
   */
  private async runForcedSyncWindows(
    store: TranscriptSyncStore,
    executor: TranscriptSyncExecutor,
    initial: TranscriptFingerprint
  ): Promise<TranscriptForceArchiveResult> {
    const { externalSessionId, fileKey } = initial;
    let latest = initial;
    for (let window = 0; window < FORCE_SYNC_MAX_WINDOWS; window += 1) {
      // Same pre-attempt snapshot as processFile: the terminal skip must record
      // under the target this window's attempt ran against, not a target a
      // mid-attempt reconnect switched to.
      const attemptComputeTargetId = this.deps.getComputeTargetId();
      let result: TranscriptSyncResult;
      try {
        result = await executor.syncFile(latest, { bypassSizeCap: true });
      } catch (error) {
        if (error instanceof TranscriptSyncRevokedError) {
          // ISS-4621 parity with processFile: consent revoked mid-forced-upload
          // is NOT a failure — no ladder advance, no dead-letter, and the row
          // must not burn its revived force attempt on a `failed` settle (at
          // offset zero that would send the file back through the size cap).
          // Re-queue clean; the drain resumes it when the tier reopens.
          await store.requeueRevoked(
            externalSessionId,
            fileKey,
            this.deps.now()
          );
          this.deps.log(
            `transcript ${fileKey} force-sync aborted: sync revoked`
          );
          return { kind: "failed", reason: "sync revoked" };
        }
        return await this.recordFailure(
          store,
          executor,
          latest,
          error,
          "force-sync",
          attemptComputeTargetId
        );
      }
      if (result.kind === "noop") {
        return { kind: "noop" };
      }
      if (result.kind === "skipped") {
        // A terminal skip (source gone, redacted line too long) is NOT fixable by
        // the bypass — surface it as `permanent` (no retry invitation). Transient
        // skips (no complete line yet, materialized source not ready) are
        // retryable `failed`.
        return result.permanent
          ? { kind: "permanent", reason: result.reason }
          : { kind: "failed", reason: result.reason };
      }
      if (result.caughtUp) {
        return { kind: "uploaded", caughtUp: true };
      }
      // Not caught up: the cursor advanced. Re-read and continue the next window;
      // bail to the durable lane if the row vanished (concurrent prune).
      const next = await store.get(externalSessionId, fileKey);
      if (!next) {
        return { kind: "uploaded", caughtUp: false };
      }
      latest = next;
    }
    // Window cap reached without catching up (a fast-growing file): the durable
    // lane (cap-bypassed while `syncedByteOffset > 0`) owns the remainder.
    return { kind: "uploaded", caughtUp: false };
  }

  /**
   * Advance the shared retry ladder for ONE upload exception and map it to a
   * `failed` (retryable) result. Both entry points settle failures here so the
   * backoff, the dead-letter threshold, and the FEA-3555 missing-source reset
   * cannot drift apart; `label` only distinguishes the two in the log line.
   *
   * The row is left `queued`/`failed` (dead-lettered only once the consecutive-
   * failure threshold is hit — and, per ISS-4621, only once the cloud
   * acknowledged the `retries_exhausted` skip); because any committed bytes
   * advanced `syncedByteOffset`, even a later automatic drain resumes past the
   * cap rather than re-dead-lettering.
   */
  private async recordFailure(
    store: TranscriptSyncStore,
    executor: TranscriptSyncExecutor,
    fp: TranscriptFingerprint,
    error: unknown,
    label: "failed" | "force-sync",
    attemptComputeTargetId: string | null
  ): Promise<TranscriptForceArchiveResult> {
    const message = error instanceof Error ? error.message : String(error);
    const retryCount = fp.retryCount + 1;
    const deadEligible = retryCount >= TRANSCRIPT_SYNC_MAX_CONSECUTIVE_FAILURES;
    // ISS-4621: the consecutive-failure dead-letter is ack-gated like every
    // other terminal path — the row goes `dead` only once the cloud
    // acknowledged a `retries_exhausted` skip. Before this, the generic
    // dead-letter NEVER told the cloud, so the transcript read `syncing`
    // forever with no failure reason (the row is invisible to re-observation
    // unless the file changes). On a failed ack the row stays `failed` on the
    // capped backoff ladder: the next attempt retries the upload itself first
    // (the outage may have passed) and re-attempts the skip only if it fails
    // again. A later file change still revives a dead row, and a successful
    // upload then supersedes the skip server-side.
    //
    // ISS-4695 (Item 1): the skip carries the server's authoritative status,
    // and each of its three outcomes settles the row DIFFERENTLY — mirroring
    // the executor's `settleTerminalSkip` so the two terminal paths cannot
    // drift:
    //  - `skipped`: the cloud RECORDED the skip → dead-letter the row.
    //  - `uploaded`: a verified archive already exists (the server refused to
    //    mask readable bytes with a late skip). The transcript is actually
    //    synced, so collapsing this into a `false` dead flag and recording
    //    ANOTHER failed/backoff attempt would leave the row `failed` and make
    //    forced sync report `failed` — the panel would say the sync failed for
    //    an archive the cloud can read (the ISS-4695 lie). Settle the row
    //    readable and report `uploaded` instead; do NOT keep it on the retry
    //    ladder. ISS-4815: that settle is the DURABLE `markCloudUploaded`, so
    //    the acknowledgement survives a relaunch instead of the row being
    //    re-armed as a stranded blob.
    //  - `unacknowledged` (`{ acked: false }` offline/transport, or a
    //    version-skewed non-terminal status): ambiguous, so stay on the capped
    //    backoff ladder and retry the upload itself next drain.
    const terminalSkip = deadEligible
      ? await classifyTerminalSkip(executor, fp, attemptComputeTargetId)
      : "unacknowledged";
    const nowIso = this.deps.now();
    if (terminalSkip === "uploaded") {
      // ISS-4815: settled DURABLY (`cloudUploadedAt`), so a row whose local
      // cursor never advanced is not re-armed by the stranded-blob recovery on
      // the next launch and made to replay this terminal skip. Scoped to
      // `attemptComputeTargetId` — the target that classified this skip and gave
      // the `uploaded` answer — so switching targets later re-arms the row
      // instead of treating that cloud's archive as proof the new one has it.
      await store.markCloudUploaded(
        fp.externalSessionId,
        fp.fileKey,
        nowIso,
        attemptComputeTargetId
      );
      this.deps.log(
        label === "force-sync"
          ? `transcript ${fp.fileKey} force-sync settled uploaded (cloud holds a verified archive)`
          : `transcript ${fp.fileKey} settled uploaded (cloud holds a verified archive)`
      );
      return { kind: "uploaded", caughtUp: true };
    }
    const dead = terminalSkip === "skipped";
    await store.recordFailure({
      externalSessionId: fp.externalSessionId,
      fileKey: fp.fileKey,
      retryCount,
      // FEA-3555: a present-file transient failure (network/S3/plan error) is
      // NOT a missing-source observation, so reset the isolated missing-source
      // run — it must not feed the terminal `source_gone` threshold.
      missingSourceCount: 0,
      dead,
      nextAttemptAt: dead
        ? null
        : isoAfter(nowIso, transcriptRetryDelayMs(retryCount)),
      lastError: message,
      now: nowIso,
    });
    this.deps.log(
      label === "force-sync"
        ? `transcript ${fp.fileKey} force-sync failed: ${message}`
        : `transcript ${fp.fileKey} failed (attempt ${retryCount}${deadLetterLogSuffix(deadEligible, dead)}): ${message}`
    );
    return { kind: "failed", reason: message };
  }

  /**
   * ISS-4849: re-arm a batch whose coalesced settle flush REJECTED.
   *
   * Without this, `recordBatchSettled` failing left every claimed row
   * `uploading` — invisible to `listReady`, and re-armed only by the boot-only
   * `requeueStale`. A single transient db-host blip therefore stranded a whole
   * batch of already-uploaded transcripts until the operator restarted the app.
   *
   * Bounded on both axes:
   *  - `MAX_FLUSH_RECOVERY_ATTEMPTS` consecutive failures, then we stop re-arming
   *    and let boot recovery own it — so a persistently failing flush cannot
   *    become a re-queue/re-drain spin;
   *  - the store call is scoped to rows still `uploading`, so a settle that DID
   *    land in the partially-applied batch is never resurrected.
   *
   * Never throws: the caller is already about to rethrow the flush error, and a
   * failed recovery must not replace that (more actionable) error with its own.
   * The row stays `uploading` in that case — exactly the state boot recovery
   * expects.
   */
  private async recoverFailedFlush(
    store: TranscriptSyncStore,
    batch: readonly TranscriptFingerprint[]
  ): Promise<void> {
    this.flushRecoveryAttempts += 1;
    if (this.flushRecoveryAttempts > MAX_FLUSH_RECOVERY_ATTEMPTS) {
      this.deps.log(
        `transcript batch settle flush failed ${this.flushRecoveryAttempts} time(s) in a row; leaving ${batch.length} row(s) uploading for boot recovery`
      );
      return;
    }
    try {
      const revived = await store.requeueUnsettledBatch(batch, this.deps.now());
      this.deps.log(
        `transcript batch settle flush failed; re-queued ${revived} unsettled row(s) in-process (attempt ${this.flushRecoveryAttempts}/${MAX_FLUSH_RECOVERY_ATTEMPTS})`
      );
    } catch (recoveryError) {
      const message =
        recoveryError instanceof Error
          ? recoveryError.message
          : String(recoveryError);
      this.deps.log(
        `transcript batch settle recovery failed: ${message}; ${batch.length} row(s) left uploading for boot recovery`
      );
    }
  }

  /**
   * ISS-5808: record one identity a db-host exit stranded `uploading`.
   *
   * Keyed, so the same file abandoned by two successive exits is remembered
   * once. Past the cap we stop remembering and say so once per overflow —
   * silently dropping would make the boot-recovery fallback invisible.
   */
  private rememberHostExitAbandoned(fp: TranscriptFingerprint): void {
    if (this.hostExitAbandoned.size >= MAX_HOST_EXIT_ABANDONED_ROWS) {
      this.deps.log(
        `transcript host-exit recovery set is full (${MAX_HOST_EXIT_ABANDONED_ROWS}); ${fp.fileKey} left uploading for boot recovery`
      );
      return;
    }
    this.hostExitAbandoned.set(
      transcriptQueueKey(fp.externalSessionId, fp.fileKey),
      { externalSessionId: fp.externalSessionId, fileKey: fp.fileKey }
    );
  }

  /**
   * ISS-5808: move the rows a db-host exit stranded back to `queued`, by
   * IDENTITY.
   *
   * `requeueUnsettledBatch` is scoped to `status = uploading` AND these
   * identities and leaves the retry ladder alone, so it can never disturb a
   * sibling's live claim (the reason `requeueStale` is wrong here) and never
   * resurrects a row that legitimately settled while the host was away.
   *
   * A failure means the replacement child is not serving yet: keep the
   * identities and let the next drain retry. Only the identities SUBMITTED in
   * this call are cleared, so a row abandoned concurrently is not dropped on the
   * floor.
   *
   * There is deliberately NO kick, and therefore no kick budget to bound. An
   * earlier shape of this fix had the service schedule an extra recovery pass on
   * each host exit; because that pass could itself die on the same host it was a
   * self-referential chain, and every attempt to bound it had the same failure
   * mode — a signal meant as "recovery succeeded" also fired mid-storm and
   * re-armed the bound (codex review), which is the ISS-5789 defect. Running the
   * re-arm at the top of the ORDINARY 5-second drain removes the chain entirely:
   * it is a fixed-rate retry that cannot recurse, and it costs at most one tick
   * of latency versus kicking immediately.
   */
  private async recoverHostExitAbandoned(
    store: TranscriptSyncStore
  ): Promise<void> {
    if (this.hostExitAbandoned.size === 0) {
      return;
    }
    const submitted = [...this.hostExitAbandoned.entries()];
    try {
      const revived = await store.requeueUnsettledBatch(
        submitted.map(([, identity]) => identity),
        this.deps.now()
      );
      for (const [key] of submitted) {
        this.hostExitAbandoned.delete(key);
      }
      this.deps.log(
        `transcript host-exit recovery re-queued ${revived} of ${submitted.length} stranded row(s)`
      );
    } catch (error) {
      this.deps.log(
        `transcript host-exit recovery failed: ${error instanceof Error ? error.message : String(error)}; retrying ${submitted.length} row(s) on the next drain`
      );
    }
  }
}

/**
 * ISS-4621: log suffix for the consecutive-failure ladder. Distinguishes a
 * completed dead-letter (cloud acknowledged the terminal skip) from one held
 * back because the ack failed — the row stays `failed` and the transition
 * re-runs next drain, which the operator should be able to see in the logs.
 */
function deadLetterLogSuffix(deadEligible: boolean, dead: boolean): string {
  if (!deadEligible) {
    return "";
  }
  return dead ? ", dead-lettered" : ", dead-letter pending cloud ack";
}

/**
 * ISS-4695 (Item 1): emit the `retries_exhausted` terminal skip and classify
 * the server's authoritative answer into the same three outcomes the executor's
 * `settleTerminalSkip` uses, so the retries-exhausted terminal path and the
 * per-attempt terminal path cannot drift:
 *  - `skipped`: the cloud RECORDED the terminal skip (`acked`, status
 *    `skipped`) → the caller may dead-letter the local row.
 *  - `uploaded`: a verified archive already exists — the server refused to mask
 *    readable bytes with a late skip. NOT a failure: the caller settles the row
 *    readable rather than keeping it on the retry ladder (dead-lettering would
 *    project `failedPermanent` for a synced transcript, the ISS-4695 lie).
 *  - `unacknowledged`: `{ acked: false }` (offline / transport error) OR any
 *    other version-skewed non-terminal status — ambiguous, so the caller keeps
 *    the row on the retry ladder.
 */
async function classifyTerminalSkip(
  executor: TranscriptSyncExecutor,
  fp: TranscriptFingerprint,
  attemptComputeTargetId: string | null
): Promise<"skipped" | "uploaded" | "unacknowledged"> {
  const emit = await executor.notifyPermanentSkip(
    fp,
    TranscriptSkipReason.RetriesExhausted,
    attemptComputeTargetId
  );
  if (!emit.acked) {
    return "unacknowledged";
  }
  if (emit.status === TranscriptUploadStatus.Skipped) {
    return "skipped";
  }
  if (emit.status === TranscriptUploadStatus.Uploaded) {
    return "uploaded";
  }
  return "unacknowledged";
}
