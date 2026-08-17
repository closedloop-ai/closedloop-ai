/**
 * @file transcript-discovery-sweep.ts
 * @description The archive lane's periodic full-discovery pass (PLN-1288 tasks
 * 3 & 5, AC7): fingerprint every local transcript file so anything created or
 * grown while the app was closed is enqueued, then drain.
 *
 * Split out of `transcript-sync-service.ts`. It owns the three once-per-episode
 * latches the sweep sequences against — boot recovery, the FEA-3932 dead-letter
 * redrive, and the FEA-3463 consent-tier suppression log — because the ORDER
 * those fire in relative to the tier gate is the load-bearing part of this pass
 * and keeping them beside it is what makes that order reviewable.
 */
import { TranscriptSyncClass } from "../../shared/transcript-sync-status-contract.js";
import type { TranscriptSyncStore } from "../database/transcript-sync-store.js";
import {
  observeTranscriptRef,
  type TranscriptObserveDeps,
} from "./transcript-observe.js";
import type { TranscriptSyncServiceOptions } from "./transcript-sync-options.js";
import type { TranscriptFileRef } from "./transcript-sync-types.js";

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
  /** Boot recovery (requeue stale `uploading` rows) runs once per start. */
  private staleRequeued = false;
  /** FEA-3932: one-shot dead-letter redrive runs once per service lifetime. */
  private redriven = false;
  /**
   * One-shot guard so the sweep logs "suppressed by tier" once per closed
   * episode rather than every 30 min (FEA-3463). Reset when the tier reopens so
   * a later re-closure logs again.
   */
  private tierSuppressedLogged = false;

  private readonly deps: TranscriptDiscoverySweeperDeps;

  constructor(deps: TranscriptDiscoverySweeperDeps) {
    this.deps = deps;
  }

  /**
   * A fresh start re-runs crash recovery — a stop mid-upload can itself leave an
   * `uploading` row behind. The redrive latch is deliberately NOT reset: it is
   * one-shot for the whole process lifetime. The stranded-blob re-arm needs no
   * reset at all — ISS-4647 made it recurring (see {@link rearmStrandedBlobs}).
   */
  resetForRestart(): void {
    this.staleRequeued = false;
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
      return;
    }
    await this.recoverStaleUploads(store);
    await this.rearmStrandedBlobs(store);
    // FEA-3463: honor the consent tier before growing the queue. The drain
    // (`shouldRun`) early-returns while the tier is closed, so any rows observed
    // here would sit `queued` forever and the queue would grow every 30-min
    // sweep. Skip the discovery write entirely and log once so the DB state
    // stays honest. Boot recovery above is bounded and still runs; the next
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

  /**
   * Boot recovery: revive rows a crash/force-quit stranded in `uploading` (ready
   * queries exclude them and observe won't re-queue them). Runs on the first
   * sweep the store is available for, before the drain — and ABOVE the consent
   * tier gate, because it only settles rows that already exist rather than
   * growing the queue.
   */
  private async recoverStaleUploads(store: TranscriptSyncStore): Promise<void> {
    if (this.staleRequeued) {
      return;
    }
    // ISS-4647: the latch is burned only AFTER the mutation succeeded. Setting
    // it first meant one transient db-host rejection disabled crash recovery for
    // the whole process lifetime — a rejected sweep must be re-attempted by the
    // next one, not silently written off.
    const revived = await this.runRecovery("stale-upload recovery", () =>
      store.requeueStale(this.deps.now())
    );
    if (revived === null) {
      return;
    }
    this.staleRequeued = true;
    if (revived > 0) {
      this.deps.log(
        `transcript sync requeued ${revived} stale uploading row(s)`
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
