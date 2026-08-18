/**
 * ISS-4430 — per-channel wall-time capture for `ipcMain.handle`.
 *
 * There is no timing middleware in the desktop IPC surface, and the ~30
 * `register*` calls in `desktop-ipc-registration.ts` each register their own
 * handlers, so there is no single list of channels to wrap after the fact. The
 * cheapest correct seam is to patch `ipcMain.handle` for the DURATION of that
 * registration block: every handler registered while the patch is installed gets
 * wrapped, and the original `handle` is restored immediately afterwards.
 *
 * Scope is therefore exactly the static registration block. A handler registered
 * later (dynamically, or from a subsystem that starts after boot) is
 * deliberately unprofiled rather than silently patched for the process lifetime.
 *
 * The wrapper is transparent: it returns the handler's value unchanged, rethrows
 * its error unchanged, and swallows every timing/sink failure. A profiling
 * problem can never become an IPC problem.
 */

import {
  defaultProfilingClock,
  type ProfilingClock,
  type ProfilingIpcRow,
  type ProfilingSink,
  readMonotonicMs,
} from "../../shared/profiling.js";

/**
 * The `ipcMain.handle` surface this module patches. Structural (rather than
 * `Electron.IpcMain`) so this module never imports `electron` and a test can
 * drive it with a plain object registrar.
 */
export type ProfilingIpcMain = {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void;
};

/** Restores the original `ipcMain.handle`. Safe to call more than once. */
export type UninstallIpcProfiling = () => void;

/**
 * Patch `ipcMain.handle` so each subsequently registered handler records its
 * wall time. Returns the uninstall function; the caller MUST invoke it in a
 * `finally` so a throwing registrar cannot leak the patch for the rest of the
 * process lifetime.
 */
export function installIpcProfiling(
  ipcMain: ProfilingIpcMain,
  sink: ProfilingSink<ProfilingIpcRow>,
  clock: ProfilingClock = defaultProfilingClock
): UninstallIpcProfiling {
  const originalHandle = ipcMain.handle;

  ipcMain.handle = function profilingHandle(
    channel: string,
    listener: (...args: unknown[]) => unknown
  ): void {
    originalHandle.call(
      ipcMain,
      channel,
      wrapHandler(channel, listener, sink, clock)
    );
  };

  return () => {
    ipcMain.handle = originalHandle;
  };
}

/**
 * Run `register` with IPC profiling installed and restore `ipcMain.handle`
 * afterwards — including when `register` throws. This composition is the whole
 * safety property (a leaked patch would wrap every later registration for the
 * rest of the process lifetime), so it lives here as one tested primitive rather
 * than as a `try`/`finally` the call site is trusted to get right.
 */
export function withIpcProfiling(
  ipcMain: ProfilingIpcMain,
  sink: ProfilingSink<ProfilingIpcRow>,
  register: () => void,
  clock?: ProfilingClock
): void {
  const uninstall = installIpcProfiling(ipcMain, sink, clock);
  try {
    register();
  } finally {
    uninstall();
  }
}

function wrapHandler(
  channel: string,
  listener: (...args: unknown[]) => unknown,
  sink: ProfilingSink<ProfilingIpcRow>,
  clock: ProfilingClock
): (...args: unknown[]) => unknown {
  return (...args: unknown[]): unknown => {
    const startedAt = readMonotonicMs(clock);
    if (startedAt === null) {
      // The clock is unusable; run the handler completely untouched rather than
      // record a duration we cannot compute.
      return listener(...args);
    }
    let result: unknown;
    try {
      result = listener(...args);
    } catch (error) {
      record(sink, clock, channel, startedAt);
      throw error;
    }
    if (!isPromiseLike(result)) {
      record(sink, clock, channel, startedAt);
      return result;
    }
    return Promise.resolve(result).then(
      (value) => {
        record(sink, clock, channel, startedAt);
        return value;
      },
      (error: unknown) => {
        record(sink, clock, channel, startedAt);
        throw error;
      }
    );
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "then") === "function"
  );
}

function record(
  sink: ProfilingSink<ProfilingIpcRow>,
  clock: ProfilingClock,
  channel: string,
  startedAt: number
): void {
  try {
    sink.append({
      channel,
      ms: clock.nowMs() - startedAt,
      ts: clock.nowEpochMs(),
    });
  } catch {
    // Fail-open: instrumentation never affects the instrumented operation.
  }
}
