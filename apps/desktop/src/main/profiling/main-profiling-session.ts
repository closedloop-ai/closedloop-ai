/**
 * ISS-4430 — the Electron main process's profiling session.
 *
 * One module owns the whole main-side lifecycle (CPU profile, IPC sink, render
 * commit sink, optional Chromium content trace) so the two call sites that wire
 * it in — `startup.ts` and `desktop-ipc-registration.ts` — each stay a couple of
 * delegating lines instead of growing a profiling subsystem inline.
 *
 * EVERY export here is a no-op when `CLOSEDLOOP_PROFILE_DIR` is unset, which is
 * the production default: `startMainProfiling` returns before touching the
 * inspector, the sink getters return `null` (so their consumers keep their
 * existing code path verbatim), and {@link withProfilingExit} returns the exit
 * callback it was handed, unwrapped and unchanged.
 *
 * The db-host utilityProcess has its own session module — it cannot import
 * `electron`, which this file does.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { contentTracing } from "electron";
import {
  describeProfilingError,
  isProfilingTraceEnabled,
  ProfilingArtifactFile,
  type ProfilingIpcRow,
  type ProfilingRenderCommitRow,
  type ProfilingSink,
  resolveProfilingDir,
} from "../../shared/profiling.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { startCpuProfiler, stopCpuProfiler } from "./cpu-profiler.js";
import { createJsonlSink, type JsonlSink } from "./jsonl-sink.js";

/**
 * Categories that make a content trace worth its overhead for this app: the
 * DevTools timeline (paint/layout/commit), V8 execution, and Blink. snake_case
 * keys are Chromium's own trace-config wire format.
 */
const CONTENT_TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "v8",
  "v8.execute",
  "blink",
  "toplevel",
];

/**
 * `undefined` until the first resolution. Resolved lazily rather than at import
 * so this module has no import-time side effect on the boot graph.
 */
let resolvedProfileDir: string | null | undefined;
let ipcSink: JsonlSink | null = null;
let renderCommitSink: JsonlSink | null = null;
let contentTracingActive = false;

/**
 * Start the main-process CPU profiler. Call as early in `run()` as the launch
 * is known to be the one that will actually boot.
 */
export function startMainProfiling(): void {
  const dir = profileDir();
  if (!dir) {
    return;
  }
  ensureProfileDir(dir);
  startCpuProfiler(profilingLog);
}

/**
 * Start the optional Chromium content trace. Must run after the app `ready`
 * event — `contentTracing` is not available before it.
 */
export function startMainContentTracing(): void {
  if (!isProfilingTraceEnabled(process.env)) {
    return;
  }
  contentTracing
    .startRecording({ included_categories: CONTENT_TRACE_CATEGORIES })
    .then(() => {
      contentTracingActive = true;
    })
    .catch((error: unknown) => {
      profilingLog(
        `content tracing failed to start: ${describeProfilingError(error)}`
      );
    });
}

/** IPC timing sink, or `null` when profiling is off. */
export function getIpcProfilingSink(): ProfilingSink<ProfilingIpcRow> | null {
  const dir = profileDir();
  if (!dir) {
    return null;
  }
  ipcSink ??= createJsonlSink(path.join(dir, ProfilingArtifactFile.Ipc));
  return ipcSink;
}

/** Render-commit sink, or `null` when profiling is off. */
export function getRenderCommitProfilingSink(): ProfilingSink<ProfilingRenderCommitRow> | null {
  const dir = profileDir();
  if (!dir) {
    return null;
  }
  renderCommitSink ??= createJsonlSink(
    path.join(dir, ProfilingArtifactFile.RenderCommits)
  );
  return renderCommitSink;
}

/**
 * Write every main-process artifact and close the sinks. Awaited on the quit
 * path — `Profiler.stop` hands back samples that still have to be serialized, so
 * an exit that races this produces a missing or truncated profile.
 */
export async function stopMainProfiling(): Promise<void> {
  const dir = profileDir();
  if (!dir) {
    return;
  }
  await stopCpuProfiler(
    path.join(dir, ProfilingArtifactFile.MainCpuProfile),
    profilingLog
  );
  await stopContentTracing(dir);
  await ipcSink?.close();
  await renderCommitSink?.close();
  ipcSink = null;
  renderCommitSink = null;
}

const PROFILING_EXIT_TIMEOUT_MS = 30_000;

/**
 * Wrap a process-exit callback so profiling artifacts are flushed before the
 * process goes away. Returns `exit` ITSELF when profiling is off, so the quit
 * path is byte-identical in production — no extra closure, no deferred tick.
 */
export function withProfilingExit(
  exit: (code: number) => void
): (code: number) => void {
  if (!profileDir()) {
    return exit;
  }
  // `exit` is declared `(code: number) => void`, so returning a promise here is
  // assignable and the caller stays unchanged. The `finally` guarantees the
  // process still exits even if flushing throws unexpectedly.
  return async (code: number) => {
    try {
      await Promise.race([
        stopMainProfiling(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            profilingLog(
              "profiling flush timed out during shutdown — exiting without waiting for artifacts"
            );
            resolve();
          }, PROFILING_EXIT_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } finally {
      exit(code);
    }
  };
}

function profileDir(): string | null {
  resolvedProfileDir ??= resolveProfilingDir(process.env);
  return resolvedProfileDir;
}

function ensureProfileDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    profilingLog(
      `profile dir could not be created: ${describeProfilingError(error)}`
    );
  }
}

async function stopContentTracing(dir: string): Promise<void> {
  if (!contentTracingActive) {
    return;
  }
  contentTracingActive = false;
  try {
    await contentTracing.stopRecording(
      path.join(dir, ProfilingArtifactFile.ContentTrace)
    );
  } catch (error) {
    profilingLog(
      `content tracing failed to stop: ${describeProfilingError(error)}`
    );
  }
}

function profilingLog(message: string): void {
  gatewayLog.warn("profiling", message);
}
