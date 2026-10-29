/**
 * @file transcript-uploading-recovery.ts
 * @description The archive lane's two IN-PROCESS re-arms for rows this process
 * left `uploading` — a batch settle flush that rejected (ISS-4849) and an upload
 * the db-host child died under (ISS-5808) — so neither waits for the sweep's
 * lease reclaim.
 *
 * Split out of `transcript-drain-queue.ts` (ISS-9884), which was still near 900
 * lines after its terminal-skip extraction. A real seam rather than a line-count
 * slice: both recoveries own one bounded piece of in-memory state, both end in
 * the same identity-scoped `requeueUnsettledBatch`, and neither touches the
 * claim set, the retry ladder or the lane give-up. The drain decides WHEN to
 * call them; this module decides what they do.
 */

import type {
  TranscriptRowIdentity,
  TranscriptSyncStore,
} from "../database/transcript-sync-store.js";
import {
  type TranscriptFingerprint,
  transcriptQueueKey,
} from "./transcript-sync-types.js";

/**
 * ISS-4849: how many CONSECUTIVE failed batch flushes the drain will recover
 * in-process before it stops trying and leaves the rows to boot recovery.
 *
 * The recovery re-queues the batch so the next 5s tick retries it in the running
 * process instead of stranding it `uploading` until the next app launch. The cap
 * is what keeps that from becoming a spin: if the flush keeps failing while the
 * READS still succeed (so the drain keeps picking work), we stop re-arming and
 * let the sweep's lease reclaim own it. The counter resets on the first
 * flush that lands, so a transient blip never consumes the budget permanently.
 */
const MAX_FLUSH_RECOVERY_ATTEMPTS = 3;

/**
 * ISS-5808: cap on the identities held for host-exit re-arm.
 *
 * Only rows THIS process claimed can land in the set, and each drain claims at
 * most `concurrency`, so it grows a batch at a time — but a host that stays down
 * across many drains would still accumulate. Past the cap we stop remembering
 * and say so; those rows fall back to the sweep's lease reclaim, which is the
 * pre-ISS-5808 behaviour and loses nothing. An unbounded Set fed by external
 * input is exactly what the repo's memory-leak rule forbids.
 */
const MAX_HOST_EXIT_ABANDONED_ROWS = 256;

export type TranscriptUploadingRecoveryDeps = {
  now: () => string;
  log: (message: string) => void;
};

/** One drain queue's in-process `uploading` re-arms. */
export class TranscriptUploadingRecovery {
  private readonly deps: TranscriptUploadingRecoveryDeps;
  /**
   * ISS-4849: consecutive `recordBatchSettled` rejections. Reset to 0 by the
   * first flush that lands, so this bounds a PERSISTENT flush failure without
   * ever consuming the budget for a transient one.
   */
  private flushRecoveryAttempts = 0;
  /**
   * ISS-5808 (whitlockk review) — rows this process left `uploading` because the
   * db-host child died mid-upload, keyed by {@link transcriptQueueKey}.
   *
   * `uploading` is invisible to `listReady`, so nothing re-picks them. The FIRST
   * shape of this fix re-armed them by re-running the sweeper's recovery, then
   * an unscoped reset of EVERY `uploading` row — safe only at boot, "because no
   * upload is in flight in a fresh process" (ISS-7097 replaced it with a leased
   * reclaim for exactly this reason). Here the service is live with overlapping
   * drains, so it could
   * reset a sibling's legitimately-active claim and have that row re-uploaded
   * after its settle landed. This set is the identity-scoped replacement:
   * `requeueUnsettledBatch` touches exactly these identities, and only while
   * they are still `uploading`, so a row that settled in the meantime is left
   * alone. Bounded by {@link MAX_HOST_EXIT_ABANDONED_ROWS}.
   */
  private readonly hostExitAbandoned = new Map<string, TranscriptRowIdentity>();

  constructor(deps: TranscriptUploadingRecoveryDeps) {
    this.deps = deps;
  }

  /**
   * ISS-4849: a flush that WROTE something landed, so the settle path is
   * healthy again and the consecutive-failure budget resets. Whether a flush
   * wrote anything is the caller's to decide: an empty one proves nothing.
   */
  noteFlushLanded(): void {
    this.flushRecoveryAttempts = 0;
  }

  /**
   * ISS-4849: re-arm a batch whose coalesced settle flush REJECTED.
   *
   * Without this, `recordBatchSettled` failing left every claimed row
   * `uploading` — invisible to `listReady`, and re-armed only by the then
   * boot-only sweep recovery. A single transient db-host blip therefore stranded a whole
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
  async recoverFailedFlush(
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
  rememberHostExitAbandoned(fp: TranscriptFingerprint): void {
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
   * sibling's live claim (the reason an unscoped reset is wrong here) and never
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
  async recoverHostExitAbandoned(store: TranscriptSyncStore): Promise<void> {
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
