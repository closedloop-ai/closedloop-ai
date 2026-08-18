/**
 * ISS-4430 — the db-host utilityProcess's profiling session.
 *
 * Separate from the main-process session because this process has no `electron`
 * module: importing the main session here would crash the worker at load. It
 * owns the worker's CPU profile and the per-op wall-time sink, and hands the
 * worker back a single object so `db-host-worker.ts` (821 lines, close to the
 * file ceiling) only gains a few delegating lines.
 *
 * Returns `null` when `CLOSEDLOOP_PROFILE_DIR` is unset, which makes the
 * worker's `measureOp` call site pass `undefined` for its options — exactly what
 * it passed before this existed.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  describeProfilingError,
  ProfilingArtifactFile,
  type ProfilingEnv,
  resolveProfilingDir,
} from "../../shared/profiling.js";
import type { MeasureOpOptions } from "../database/db-host/db-host-memory-watchdog.js";
import type { BoundedLaneTiming } from "../database/db-host/heavy-op-gate.js";
import { startCpuProfiler, stopCpuProfiler } from "./cpu-profiler.js";
import { createJsonlSink, type JsonlSink } from "./jsonl-sink.js";

export type DbHostProfilingSession = {
  /** Passed straight through to `measureOp` at the invoke choke point. */
  measureOpOptions: MeasureOpOptions;
  /**
   * Passed to `createDbHostOpLanes` so the bounded read lane records WHY an op
   * took as long as it did — waiting for a permit versus actually running.
   */
  onBoundedTiming: (op: string, timing: BoundedLaneTiming) => void;
  /** Write the CPU profile and flush the op sink. Await before exiting. */
  stop(): Promise<void>;
};

/**
 * Start db-host profiling, or return `null` when profiling is off.
 *
 * `env` is passed in (rather than read from `process.env` here) because the
 * utilityProcess inherits the parent's environment and the worker reads it at
 * module scope — keeping the read at the call site makes the gate visible
 * exactly where the worker boots.
 */
export function startDbHostProfiling(
  env: ProfilingEnv,
  log: (message: string) => void
): DbHostProfilingSession | null {
  const dir = resolveProfilingDir(env);
  if (!dir) {
    return null;
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    log(`profile dir could not be created: ${describeProfilingError(error)}`);
  }
  startCpuProfiler(log);
  const sink: JsonlSink = createJsonlSink(
    path.join(dir, ProfilingArtifactFile.DbOps)
  );
  const laneSink: JsonlSink = createJsonlSink(
    path.join(dir, ProfilingArtifactFile.DbLane)
  );
  return {
    measureOpOptions: { profiling: { sink } },
    onBoundedTiming(op, timing): void {
      laneSink.append({ op, ...timing, ts: Date.now() });
    },
    async stop(): Promise<void> {
      await stopCpuProfiler(
        path.join(dir, ProfilingArtifactFile.DbHostCpuProfile),
        log
      );
      await sink.close();
      await laneSink.close();
    },
  };
}
