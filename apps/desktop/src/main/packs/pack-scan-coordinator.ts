/**
 * @file pack-scan-coordinator.ts — main-process orchestrator for the pack scan
 * (FEA-3628).
 *
 * Electron only allows `utilityProcess.fork` from the MAIN process, so the
 * pure-compute pack-scan worker is forked and driven here, NOT inside the
 * db-host. A scan is a three-step dance:
 *
 *   1. read  — ask the db-host for the recent project roots
 *              (`packScanner.recentRoots`), the scanner's single DB read.
 *   2. compute — run the heavy filesystem walk / parsing in the worker
 *                (owns no DB connection).
 *   3. apply — hand the plan back to the db-host, the SOLE SQLite writer
 *              (`packScanner.apply`).
 *
 * Because compute happens off the db-host, its JS thread stays free to serve
 * renderer DB reads while a scan runs — the whole point of the feature. If the
 * worker is unavailable or fails, we fall back to `packScanner.run`, which does
 * compute+write entirely in the db-host (the pre-FEA-3628 behavior) so a scan
 * still completes.
 *
 * Redundant triggers (install/uninstall fire-and-forget, startup) are coalesced
 * single-flight: while a scan runs, extra calls join it and schedule at most one
 * trailing rerun, so back-to-back installs never stack N scans.
 */

import type { DefinitionRootsResolution } from "./definition-discovery.js";
import type { PackScanComputeResult } from "./pack-scanner.js";
import { createSingleFlightRunner } from "./single-flight-runner.js";
import type { PackScanRunner } from "./utility-process-pack-scan-runner.js";

type RawStoreOp = (name: string, args?: unknown[]) => Promise<unknown>;

export type PackScanCoordinator = {
  /** Trigger a scan. Coalesces with any in-flight scan; resolves when settled. */
  run(): Promise<void>;
  /** Tear down the worker; further `run()` calls resolve immediately. */
  stop(): void;
};

export function createPackScanCoordinator(deps: {
  rawStoreOp: RawStoreOp;
  /** Returns a runner, or null to always use the in-db-host fallback (golden/test). */
  createRunner: () => PackScanRunner | null;
  log?: (message: string) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}): PackScanCoordinator {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date().toISOString());

  let runner: PackScanRunner | null = null;
  let runnerInitialized = false;

  const getRunner = (): PackScanRunner | null => {
    if (!runnerInitialized) {
      runnerInitialized = true;
      try {
        runner = deps.createRunner();
      } catch (error) {
        log(`pack-scan runner init failed: ${errMsg(error)}`);
        runner = null;
      }
    }
    return runner;
  };

  /**
   * The ISS-5274 definition pass, run after the inventory has landed.
   *
   * Same read→compute→apply shape as the scan itself: the db-host resolves the
   * roots (it owns the environment and the project-root read), the worker does
   * the recursive walk, the db-host applies. Every degrade is
   * complete-or-fall-back — an omitted payload or ANY failure before apply
   * routes to the full on-host walk, so the catalog still converges. Presence
   * of a payload asserts completeness; a partial set is never applied.
   *
   * `stopped` is re-checked before EVERY heavy step. `PackScanRunner.stop()`
   * rejects pending work and kills the child but sets no latch of its own, so a
   * `computeDefinitions` issued after shutdown would fork a BRAND-NEW worker
   * mid-teardown and start the whole home-tree walk; and a fallback issued then
   * would queue that walk into a db-host that is closing.
   */
  const runDefinitionPass = async (
    activeRunner: PackScanRunner,
    isStopped: () => boolean
  ): Promise<void> => {
    let resolution: DefinitionRootsResolution;
    let outcome: Awaited<ReturnType<PackScanRunner["computeDefinitions"]>>;
    try {
      if (isStopped()) {
        return;
      }
      resolution = (await deps.rawStoreOp(
        "packScanner.definitionRoots"
      )) as DefinitionRootsResolution;
      if (isStopped()) {
        return;
      }
      outcome = await activeRunner.computeDefinitions(resolution.scanRoots);
    } catch (error) {
      if (isStopped()) {
        return;
      }
      log(
        `definition worker path failed; falling back to in-db-host walk: ${errMsg(error)}`
      );
      await deps.rawStoreOp("packScanner.collectDefinitions");
      return;
    }
    if (outcome.omitted) {
      if (isStopped()) {
        return;
      }
      log(
        `definition payload omitted (${outcome.reason}); falling back to in-db-host walk`
      );
      await deps.rawStoreOp("packScanner.collectDefinitions");
      return;
    }
    if (isStopped()) {
      return;
    }
    // Apply errors surface rather than triggering the on-host walk: the walk
    // already succeeded, so re-walking would repeat the expensive part to retry
    // a bounded DB write. The next trigger retries.
    await deps.rawStoreOp("packScanner.applyDefinitions", [
      outcome.definitions,
      resolution.context,
    ]);
  };

  const executeOnce = async (): Promise<void> => {
    // Stamp scan start BEFORE compute so apply's prune tombstones only rows this
    // scan did not refresh (upserts write last_seen_at >= scanStartedAt).
    const scanStartedAt = now();
    const activeRunner = getRunner();
    const isStopped = () => singleFlight.isStopped();
    if (activeRunner) {
      let result: PackScanComputeResult;
      // Only the READ + COMPUTE (the worker) can fall back to the in-db-host
      // scan — that is the part the worker exists to offload. If the WORKER
      // succeeds, apply is a plain bounded DB write; re-running the whole heavy
      // scan on an apply hiccup would just repeat the same writes, so let apply
      // errors surface and rely on the next trigger to retry.
      try {
        const roots = (await deps.rawStoreOp(
          "packScanner.recentRoots"
        )) as string[];
        result = await activeRunner.computeScan(roots);
      } catch (error) {
        // Don't kick off the heavy in-db-host scan during shutdown.
        if (isStopped()) {
          return;
        }
        log(
          `pack-scan worker path failed; falling back to in-db-host scan: ${errMsg(error)}`
        );
        await deps.rawStoreOp("packScanner.run");
        return;
      }
      if (isStopped()) {
        return;
      }
      // Inventory lands FIRST, exactly as before — the definition pass attaches
      // content to rows this apply may have just created.
      await deps.rawStoreOp("packScanner.apply", [result, scanStartedAt]);
      await runDefinitionPass(activeRunner, isStopped);
      return;
    }
    if (isStopped()) {
      return;
    }
    // No worker: `packScanner.run` still does compute + walk + writes in-host.
    await deps.rawStoreOp("packScanner.run");
  };

  const singleFlight = createSingleFlightRunner({
    execute: executeOnce,
    onError: (error) => log(`pack scan failed: ${errMsg(error)}`),
    onStop: () => runner?.stop(),
  });

  return {
    run: () => singleFlight.run(),
    stop: () => singleFlight.stop(),
  };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
