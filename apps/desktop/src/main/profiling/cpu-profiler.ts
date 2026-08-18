/**
 * ISS-4430 — V8 CPU profiling for a Node-side desktop process.
 *
 * Deliberately built on plain `node:inspector` with no `electron` import, so the
 * SAME module serves the Electron main process and the db-host utilityProcess
 * (which has no `electron` module and would crash on one).
 *
 * Every failure is swallowed and reported through the injected logger — this is
 * diagnostics, and a profiler that cannot start must never take the process it
 * was measuring down with it. The logger is injected rather than imported
 * because the two hosts log differently: main writes through `gatewayLog`, the
 * db-host worker posts over its reverse channel to the parent.
 *
 * Lifecycle note: `stopCpuProfiler` must be AWAITED before the host process
 * exits. `Profiler.stop` returns the samples in-memory and writing them is a
 * separate async step, so a `process.exit()` that races the write produces
 * either no file or a truncated one.
 */

import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";

type ProfilerLog = (message: string) => void;

/**
 * One profiler per process — V8 supports a single active CPU profile per
 * isolate, and both hosts start exactly one at boot. A module-level handle is
 * the honest model for that; the tests drive it through the real start/stop
 * lifecycle rather than around it.
 */
let activeSession: Session | null = null;
/**
 * Resolves once `Profiler.enable` + `Profiler.start` have landed. `stop` awaits
 * it so a stop that arrives before the (asynchronous) start completed still
 * produces a profile instead of an "already stopped" error.
 */
let startPromise: Promise<void> | null = null;

/**
 * Begin CPU profiling this process. Idempotent — a second call while a profile
 * is already running is ignored. Callers gate on
 * {@link resolveProfilingDir}; this function does not read the environment.
 */
export function startCpuProfiler(log?: ProfilerLog): void {
  if (activeSession) {
    return;
  }
  try {
    const session = new Session();
    session.connect();
    activeSession = session;
    startPromise = beginProfiling(session).catch((error: unknown) => {
      logProfilerFailure(log, "start", error);
    });
  } catch (error) {
    activeSession = null;
    startPromise = null;
    logProfilerFailure(log, "start", error);
  }
}

/**
 * Stop profiling and write the `.cpuprofile` to `outFile`. A no-op — resolving
 * immediately — when no profile is running, which is the production default.
 */
export async function stopCpuProfiler(
  outFile: string,
  log?: ProfilerLog
): Promise<void> {
  const session = activeSession;
  if (!session) {
    return;
  }
  activeSession = null;
  const pendingStart = startPromise;
  startPromise = null;
  try {
    await pendingStart;
    const { profile } = await session.post("Profiler.stop");
    await writeFile(outFile, JSON.stringify(profile), "utf8");
  } catch (error) {
    logProfilerFailure(log, "stop", error);
  } finally {
    try {
      session.disconnect();
    } catch {
      // Already disconnected (or the inspector channel died with the process);
      // there is nothing left to release.
    }
  }
}

async function beginProfiling(session: Session): Promise<void> {
  await session.post("Profiler.enable");
  await session.post("Profiler.start");
}

function logProfilerFailure(
  log: ProfilerLog | undefined,
  phase: "start" | "stop",
  error: unknown
): void {
  if (!log) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  log(`cpu-profiler ${phase} failed: ${message}`);
}
