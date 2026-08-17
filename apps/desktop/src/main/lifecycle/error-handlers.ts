/**
 * Process-level error handlers for uncaught exceptions and unhandled rejections.
 *
 * No Electron imports -- this file is testable with plain tsx --test.
 */

import {
  isOutputStreamBrokenPipeError,
  type OutputStreamState,
} from "../../shared/broken-pipe.js";
import {
  OBSERVABILITY_SHUTDOWN_DEADLINE_MS,
  raceShutdownDeadline,
} from "../telemetry/shutdown-deadline.js";

export const CRASH_DIALOG_TITLE = "Closedloop encountered a fatal error";

function isSpawnEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    "syscall" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT" &&
    typeof (err as NodeJS.ErrnoException).syscall === "string" &&
    (err as NodeJS.ErrnoException).syscall!.startsWith("spawn")
  );
}

type CrashDialogDeps = {
  showDialog: (title: string, body: string) => void;
  getLogFilePath?: () => string;
};

type ProcessErrorHandlerDeps = Partial<CrashDialogDeps> & {
  log: (msg: string) => void;
  exit: (code: number) => void;
  emitException?: (error: unknown) => void;
  /**
   * Drain the telemetry emitted by {@link ProcessErrorHandlerDeps.emitException}
   * before exit (ISS-6328). Production ships exceptions through Batch
   * processors with a ~5s delay, and `app.exit()` skips `before-quit`, so
   * without this the crash event never leaves the machine. Awaited under
   * {@link OBSERVABILITY_SHUTDOWN_DEADLINE_MS} so a wedged relay socket cannot
   * hold the process open.
   */
  flushTelemetry?: () => Promise<void>;
  /**
   * The process output streams a broken-pipe uncaught exception may be
   * attributed to. Defaults to the real `process.stdout`/`process.stderr`;
   * injected so a test can drive the closed-pipe case without tearing down the
   * runner's own streams.
   */
  outputStreams?: readonly (OutputStreamState | null | undefined)[];
};

/**
 * Handler for process 'uncaughtException' events.
 *
 * If the error is a spawn ENOENT (child process not found), or a broken-pipe
 * write ATTRIBUTABLE to a closed stdout/stderr (ISS-5089), it logs the error and
 * returns without calling exit -- this suppresses the Electron crash dialog for
 * a missing executable and for an expected shutdown. All other errors are logged
 * then exit(1) is called.
 *
 * The broken-pipe branch is process-wide, so a bare code check is not enough:
 * `EBADF` and `ERR_STREAM_DESTROYED` are also what an unrelated descriptor or a
 * destroyed socket looks like, and suppressing those would leave the process
 * alive after a real fault. Suppression therefore requires one of the process's
 * own output streams to actually be gone -- see
 * {@link isOutputStreamBrokenPipeError}.
 */
export async function handleUncaughtException(
  error: Error,
  deps: ProcessErrorHandlerDeps
): Promise<void> {
  if (isSpawnEnoent(error)) {
    deps.log(
      `[error-handler] suppressed spawn ENOENT: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
    );
    return;
  }
  if (
    isOutputStreamBrokenPipeError(
      error,
      deps.outputStreams ?? [process.stdout, process.stderr]
    )
  ) {
    // ISS-5089: the output pipe closing is an expected end-of-life event (Ctrl-C
    // on `just desktop-dev`, a supervisor exiting first), not an application
    // fault. GatewayLogger already keeps console egress from raising it, but a
    // write from anywhere else — or one in flight before the stream guard is
    // installed — must not be recorded as a crash or trigger the crash dialog.
    // Narrowed to a broken pipe on a stream that is DEMONSTRABLY gone, so an
    // unrelated EBADF or destroyed-stream fault still takes the fatal path.
    deps.log(
      `[error-handler] suppressed broken-pipe write: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
    );
    return;
  }
  emitExceptionSafely(deps, error);
  deps.log(
    `[error-handler] uncaught exception: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
  );
  showDialogSafely(
    deps,
    CRASH_DIALOG_TITLE,
    formatCrashDialogBody(
      error.message,
      safeGetLogFilePath(deps.getLogFilePath)
    )
  );
  await flushTelemetrySafely(deps);
  deps.exit(1);
}

/**
 * Handler for process 'unhandledRejection' events.
 *
 * Guards all property access behind an instanceof Error check.
 * If the rejection is a spawn ENOENT, it is suppressed (only logged).
 * All other Error rejections are logged then exit(1) is called to preserve
 * Node.js default termination guarantee.
 */
export async function handleUnhandledRejection(
  reason: unknown,
  deps: ProcessErrorHandlerDeps
): Promise<void> {
  if (!(reason instanceof Error)) {
    emitExceptionSafely(deps, reason);
    deps.log(
      `[error-handler] unhandled rejection (non-Error): ${String(reason)}`
    );
    // This branch does NOT exit, so the app keeps running — flush anyway, or a
    // non-Error rejection sits in the batch until the next unrelated export.
    await flushTelemetrySafely(deps);
    return;
  }

  if (isSpawnEnoent(reason)) {
    deps.log(
      `[error-handler] suppressed spawn ENOENT rejection: ${reason.message}${reason.stack ? `\n${reason.stack}` : ""}`
    );
    return;
  }

  emitExceptionSafely(deps, reason);
  deps.log(
    `[error-handler] unhandled rejection: ${reason.message}${reason.stack ? `\n${reason.stack}` : ""}`
  );
  showDialogSafely(
    deps,
    CRASH_DIALOG_TITLE,
    formatCrashDialogBody(
      reason.message,
      safeGetLogFilePath(deps.getLogFilePath)
    )
  );
  await flushTelemetrySafely(deps);
  deps.exit(1);
}

function emitExceptionSafely(
  deps: ProcessErrorHandlerDeps,
  error: unknown
): void {
  try {
    deps.emitException?.(error);
  } catch {
    // Telemetry cannot interfere with the existing process crash path.
  }
}

async function flushTelemetrySafely(
  deps: ProcessErrorHandlerDeps
): Promise<void> {
  const flush = deps.flushTelemetry;
  if (!flush) {
    return;
  }
  try {
    // The cap is the whole point: a wedged relay socket must not turn a crash
    // into a hang. raceShutdownDeadline abandons still-pending work and swallows
    // its late rejection.
    await raceShutdownDeadline(flush(), OBSERVABILITY_SHUTDOWN_DEADLINE_MS);
  } catch {
    // Telemetry cannot interfere with the existing process crash path.
  }
}

function showDialogSafely(
  deps: ProcessErrorHandlerDeps,
  title: string,
  body: string
): void {
  try {
    deps.showDialog?.(title, body);
  } catch {
    // Dialog cannot interfere with the exit path.
  }
}

function safeGetLogFilePath(fn?: () => string): string | undefined {
  try {
    return fn?.();
  } catch {
    return undefined;
  }
}

export function formatCrashDialogBody(
  errorMessage: string,
  logFilePath?: string
): string {
  let body = `An unexpected error occurred.\n\n${errorMessage}`;
  if (logFilePath) {
    body += `\n\nDetails have been written to:\n${logFilePath}`;
  }
  return body;
}

export function showStartupCrashDialog(
  title: string,
  errorMessage: string,
  deps: CrashDialogDeps
): void {
  const logPath = safeGetLogFilePath(deps.getLogFilePath);
  try {
    deps.showDialog(title, formatCrashDialogBody(errorMessage, logPath));
  } catch {
    // Dialog unavailable — exit path must not be blocked.
  }
}
