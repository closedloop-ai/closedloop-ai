import { registerRecoveredLoop } from "../../server/operations/symphony-loop.js";
import { isProcessRunning } from "../../server/operations/symphony-utils.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { JobStore } from "./job-store.js";

/**
 * Seed the in-process running-loop registry from persisted job state at boot,
 * so a launch command replayed into a FRESH Electron process cannot spawn a
 * second runner for a loop that is already running (ISS-5811).
 *
 * WHY THIS IS NEEDED. Both dedupe layers a replayed launch passes through are
 * per-process Maps that die with the process:
 *
 *   - `CloudCommandExecutor.trackedByCommandId` re-acks and replays buffered
 *     output for a commandId it has already seen, instead of executing twice.
 *   - `runningLoops` in `symphony-loop.ts` answers 409 "Loop is already running
 *     on this machine" for a loopId it is already tracking. It is the launch
 *     handler's ONLY pre-spawn guard -- the job store is not consulted until
 *     after the child is spawned.
 *
 * The runner child is `detached: true`, so it outlives its Electron process. A
 * command minted before a restart can still be delivered afterwards: the cloud
 * API replays an undelivered launch dispatch with the same commandId, and the
 * relay replays buffered commands on reconnect. That delivery lands on a fresh
 * executor whose maps are empty, while the original runner is still alive --
 * and nothing stops it spawning a duplicate.
 *
 * `BootRecoveryService.reattachLiveJobs` does call `registerRecoveredLoop`, but
 * it cannot close this window: it is started un-awaited, each job goes through a
 * cloud round-trip before registering, and `cloud-socket-startup.ts` gates the
 * socket on UI readiness only -- recovery is not in its dependency chain. So
 * commands can be accepted while the registry is still empty.
 *
 * This runs synchronously during boot, from the same persisted state and the
 * same liveness probe boot recovery uses, before the socket is scheduled. Boot
 * recovery re-registering the same loopId afterwards is an idempotent overwrite
 * of an identical entry; when it instead classifies the loop terminal, or finds
 * the process gone, it unregisters -- so a seeded entry cannot outlive its
 * runner and wedge a later legitimate launch of the same loopId.
 */
export function seedRunningLoopsFromJobStore(jobStore: JobStore): string[] {
  const seeded: string[] = [];
  // Same selection as BootRecoveryService.reattachLiveJobs: an active job with
  // a pid whose process is still in the table. Keep the two in step -- seeding
  // a loop recovery will not adopt would leave an entry nothing ever clears.
  for (const job of jobStore.listRunning()) {
    const { pid } = job;
    if (pid == null || !isProcessRunning(pid)) {
      continue;
    }
    registerRecoveredLoop(job.loopId, pid);
    seeded.push(job.loopId);
  }
  if (seeded.length > 0) {
    gatewayLog.info(
      "boot-recovery",
      `Seeded running-loop registry from persisted jobs before cloud command intake: ${seeded.join(", ")}`
    );
  }
  return seeded;
}
