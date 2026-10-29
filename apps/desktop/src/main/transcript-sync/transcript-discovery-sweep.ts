/**
 * @file transcript-discovery-sweep.ts
 * @description The archive lane's periodic full-discovery pass (PLN-1288 tasks
 * 3 & 5, AC7): fingerprint every local transcript file so anything created or
 * grown while the app was closed is enqueued, then drain.
 *
 * Split out of `transcript-sync-service.ts`. It owns the once-per-episode latches
 * the sweep sequences against — the FEA-3932 dead-letter redrive and the FEA-3463
 * consent-tier suppression log — plus the two RECURRING recoveries (ISS-4647's
 * stranded blobs, ISS-7097's expired upload leases), because the ORDER those fire
 * in relative to the tier gate is the load-bearing part of this pass and keeping
 * them beside it is what makes that order reviewable.
 */
import { TranscriptSyncClass } from "../../shared/transcript-sync-status-contract.js";
import type { TranscriptSyncStore } from "../database/transcript-sync-store.js";
import { importHealthEventForMaterializeRejection } from "./opencode-materialize-outcome.js";
import {
  observeTranscriptRef,
  type TranscriptObserveDeps,
} from "./transcript-observe.js";
import type { TranscriptSyncServiceOptions } from "./transcript-sync-options.js";
import {
  TRANSCRIPT_UPLOAD_LEASE_MS,
  type TranscriptFileRef,
} from "./transcript-sync-types.js";

export type TranscriptDiscoverySweeperDeps = {
  opts: TranscriptSyncServiceOptions;
  observe: TranscriptObserveDeps;
  /** PRD-532 §7 consent gate — see `TranscriptSyncService.tierAllowsSync`. */
  tierAllowsSync: () => boolean;
  now: () => string;
  log: (message: string) => void;
  concurrency: number;
  drainOnce: () => Promise<void>;
};

export class TranscriptDiscoverySweeper {
  /** FEA-3932: one-shot dead-letter redrive runs once per service lifetime. */
  private redriven = false;
  /**
   * One-shot guard so the sweep logs "suppressed by tier" once per closed
   * episode rather than every 30 min (FEA-3463). Reset when the tier reopens so
   * a later re-closure logs again.
   */
  private tierSuppressedLogged = false;
  /**
   * ISS-11449 (whitlockk review): a sweep that found no store yet. The startup sweep
   * and the sign-in kick can both land before the dashboard DB is ready, and
   * nothing else re-kicks discovery for 30 minutes, so the sweep stays owed
   * until a drain tick finds the store (see {@link isAwaitingStore}).
   */
  private awaitingStore = false;

  private readonly deps: TranscriptDiscoverySweeperDeps;

  /**
   * ISS-7097: the instant this lane began taking upload claims. Any
   * `uploadingSince` older than it was stamped by a process that is gone, so the
   * reclaim can re-arm it without waiting out the lease — which is what keeps
   * crash recovery immediate on relaunch instead of trailing by up to an hour.
   */
  private readonly claimableFrom: string;

  constructor(deps: TranscriptDiscoverySweeperDeps) {
    this.deps = deps;
    this.claimableFrom = deps.now();
  }

  /**
   * Discovery sweep: fingerprint every local transcript file (backfill class) so
   * files created/grown while the app was closed are enqueued, then drain. Runs
   * even while offline (queue is built locally; uploads wait for connectivity).
   */
  async sweepOnce(): Promise<void> {
    const { opts } = this.deps;
    if (!opts.isEnabled()) {
      return;
    }
    const store = opts.getStore();
    if (!store) {
      this.awaitingStore = true;
      return;
    }
    this.awaitingStore = false;
    await this.reclaimExpiredUploadLeases(store);
    await this.rearmStrandedBlobs(store);
    // FEA-3463: honor the consent tier before growing the queue. The drain
    // (`shouldRun`) early-returns while the tier is closed, so any rows observed
    // here would sit `queued` forever and the queue would grow every 30-min
    // sweep. Skip the discovery write entirely and log once so the DB state
    // stays honest. The recoveries above are bounded and still run; the next
    // sweep after the tier is set re-discovers and enqueues these files.
    if (!this.deps.tierAllowsSync()) {
      if (!this.tierSuppressedLogged) {
        this.tierSuppressedLogged = true;
        this.deps.log(
          "transcript sweep suppressed by consent tier; queue not grown"
        );
      }
      return;
    }
    this.tierSuppressedLogged = false;
    await this.runOneShotRedrive();
    await this.runMaterialize();
    const refs = await opts.discover();
    const skipped = await this.observeRefsBounded(store, refs);
    this.deps.log(
      skipped > 0
        ? `transcript sweep observed ${refs.length - skipped} of ${refs.length} file(s) (${skipped} skipped)`
        : `transcript sweep observed ${refs.length} file(s)`
    );
    await this.deps.drainOnce();
  }

  /** Whether a sweep is owed to a store that was not ready when it ran. */
  isAwaitingStore(): boolean {
    return this.awaitingStore;
  }

  /**
   * ISS-7097: revive rows whose durable `uploading` claim expired — an upload
   * whose settle never landed. Ready queries exclude `uploading` and observe
   * deliberately won't re-queue it, so such a row is reachable by nothing else.
   * Runs before the drain and ABOVE the consent tier gate, because it only
   * settles rows that already exist rather than growing the queue.
   *
   * RECURRING, and that is the fix. Its predecessor `recoverStaleUploads` was
   * latched to the first successful sweep per process, so a settle lost at
   * minute 31 waited for the next app START — 21+ hours on the install that
   * raised this. Losing a settle is not a boot-only condition, exactly as ISS-4647
   * found for stranded blobs (see {@link rearmStrandedBlobs}, whose docblock makes
   * the same argument). What the old one could NOT do is run on a tick: it matched
   * every `uploading` row unconditionally, so it would have reset the claim of an
   * upload running concurrently in this very process. The lease is what removes
   * that hazard — a claim younger than {@link TRANSCRIPT_UPLOAD_LEASE_MS} does not
   * match — so no latch is needed and none is kept.
   *
   * A claim older than {@link claimableFrom} skips the lease wait entirely: it
   * belongs to a process that no longer exists, so a crash two minutes into an
   * upload still recovers on the next sweep after relaunch rather than sitting
   * out the remaining 58 minutes of a lease nobody holds.
   */
  private async reclaimExpiredUploadLeases(
    store: TranscriptSyncStore
  ): Promise<void> {
    const revived = await this.runRecovery(
      "expired upload-lease recovery",
      () =>
        store.requeueExpiredUploadLeases({
          now: this.deps.now(),
          leaseMs: TRANSCRIPT_UPLOAD_LEASE_MS,
          claimableFrom: this.claimableFrom,
        })
    );
    if (revived !== null && revived > 0) {
      this.deps.log(
        `transcript sync reclaimed ${revived} expired upload lease(s)`
      );
    }
  }

  /**
   * ISS-4647: run one recovery mutation best-effort, returning its row count or
   * `null` when it failed.
   *
   * Both recoveries run at the TOP of `sweepOnce`, so letting one reject would
   * abort the whole discovery pass — no materialize, no observe, no drain. That
   * was survivable while they were latched (the failure retired the call), but
   * once the stranded re-arm became recurring a persistently failing db-host
   * would have killed every sweep for the process lifetime. Recovery is a repair
   * lane, not a precondition for discovery: log and continue, and let the next
   * sweep re-attempt it.
   */
  private async runRecovery(
    label: string,
    run: () => Promise<number>
  ): Promise<number | null> {
    try {
      return await run();
    } catch (error) {
      this.deps.log(
        `transcript ${label} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * ISS-4621: re-arm STRANDED transcript blobs — rows that settled `idle`
   * without ever uploading a byte, which are otherwise invisible to both the
   * ready queue (idle) and the discovery sweep (a vanished source is never
   * re-observed), so they sit `missing`/`syncing` forever with no terminal state
   * (SES-78221). Re-queuing lets the drain either upload them (source present)
   * or dead-letter them via the bounded missing-source ladder (source gone).
   *
   * Runs BEFORE the tier gate because it only re-arms EXISTING rows (never grows
   * the queue with new files), and the drain's own `shouldRun` still gates any
   * egress by consent tier.
   *
   * ISS-4647: RECURRING (every sweep), not a one-shot boot recovery. Stranding is
   * not a boot-only condition — any row the executor settles `idle` at zero bytes
   * (a materialized source that isn't ready, a file with no complete JSONL line
   * yet, a revocation on an older build) becomes stranded the moment the session
   * ends and its file stops changing, i.e. LONG after the boot sweep already ran.
   * A one-shot latch also meant a single transient db-host rejection disabled
   * every retry for the process lifetime, because the latch was burned before the
   * mutation was even attempted. Running it on the sweep cadence heals rows
   * stranded mid-session and re-opens automatically when the consent tier does,
   * with no latch to burn. Cost is one bounded `updateMany` per 30-min sweep, and
   * re-arming is idempotent: a row the drain then terminates (uploaded or
   * dead-lettered) no longer matches the `idle` + zero-offset predicate.
   */
  private async rearmStrandedBlobs(store: TranscriptSyncStore): Promise<void> {
    const rearmed = await this.runRecovery("stranded-blob recovery", () =>
      store.requeueStrandedMissingBlobs({
        now: this.deps.now(),
        // ISS-4647: the recovery needs the CURRENT target to tell "the cloud has
        // these bytes" from "a previous target's cloud had them". Null (offline)
        // narrows the predicate back to never-uploaded rows.
        computeTargetId: this.deps.observe.getComputeTargetId(),
      })
    );
    if (rearmed !== null && rearmed > 0) {
      this.deps.log(
        `transcript sync re-armed ${rearmed} stranded missing-blob row(s)`
      );
    }
  }

  /**
   * FEA-3932: one-shot automatic dead-letter redrive (OpenCode-scoped). Called
   * from `sweepOnce` BELOW the consent-tier gate — a redriven `dead` row becomes
   * `queued`, and if the tier were closed the drain (`shouldRun`) would leave it
   * queued forever while the one-shot latch was already burned, so redrive would
   * never fire again once the lane reopened. Gated below the tier it only fires
   * on a sweep the lane can actually drain, and runs before the first materialize/
   * discovery so a redriven row is `queued` in time for THIS sweep's drain.
   * Guarded for the whole process lifetime.
   */
  private async runOneShotRedrive(): Promise<void> {
    if (this.redriven) {
      return;
    }
    this.redriven = true;
    if (!this.deps.opts.redriveOnStart) {
      return;
    }
    const redriven = await this.deps.opts.redriveOnStart();
    if (redriven > 0) {
      this.deps.log(`transcript sync redrove ${redriven} dead-lettered row(s)`);
    }
  }

  /**
   * FEA-3932: regenerate materialized projections (OpenCode) from their foreign
   * store BEFORE discovery so the enumerated files are fresh. Called from
   * `sweepOnce` after the consent-tier gate (it writes local projection files
   * that will be uploaded, so it must not run while transcript egress is
   * suppressed). Best-effort — a materialize failure must not abort discovery.
   */
  private async runMaterialize(): Promise<void> {
    if (!this.deps.opts.materialize) {
      return;
    }
    try {
      await this.deps.opts.materialize();
    } catch (error) {
      this.deps.log(
        `transcript materialize failed: ${error instanceof Error ? error.message : String(error)}`
      );
      // ISS-8600: a deliberate `stop()` settles through this same catch on the
      // ISS-4903 shutdown path, so the classifier returns nothing for it and
      // the seam is not called at all — reporting one would put a materialize
      // failure on every clean quit with a pass in flight. Swallowed on its own
      // because the sweep's best-effort posture covers the report too: a
      // throwing sink must not abort discovery any more than a failed pass does.
      const kind = importHealthEventForMaterializeRejection(error);
      if (kind) {
        try {
          this.deps.opts.noteMaterializeOutcome?.(kind);
        } catch {
          /* best-effort by contract — see above */
        }
      }
    }
  }

  /**
   * Observe every discovered ref at bounded concurrency (FEA-2835). The sweep
   * previously awaited `observeRef` one ref at a time, so the whole discovery
   * pass was a sequential chain of `fs.stat` + `store.observe` IPC round-trips —
   * re-run on startup and every 30 min over potentially thousands of historical
   * transcripts. Running the refs in fixed-size batches lets the per-item stat
   * I/O and db-host IPC latency pipeline (the write-transactions still serialize
   * in the db-host regardless). Each ref is individually guarded (FEA-3475): a
   * per-item try/catch logs and skips a failing observe (SQLite/IPC error,
   * pathological path) so later files in the same sweep are still enqueued —
   * preventing tail-starvation when a single bad file recurs across sweeps.
   */
  private async observeRefsBounded(
    store: TranscriptSyncStore,
    refs: TranscriptFileRef[]
  ): Promise<number> {
    const batchSize = Math.max(1, this.deps.concurrency);
    let skipped = 0;
    for (let start = 0; start < refs.length; start += batchSize) {
      const batch = refs.slice(start, start + batchSize);
      await Promise.all(
        batch.map(async (ref) => {
          try {
            await observeTranscriptRef(
              this.deps.observe,
              store,
              ref,
              TranscriptSyncClass.Backfill
            );
          } catch (error) {
            skipped += 1;
            const message =
              error instanceof Error ? error.message : String(error);
            this.deps.log(
              `transcript sweep skipped ${ref.sourcePath} (${ref.externalSessionId}/${ref.fileKey}): ${message}`
            );
          }
        })
      );
    }
    return skipped;
  }
}
