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
   * ISS-8776 — announce the imminent teardown to the in-process supervisors
   * before anything else on a fatal branch.
   *
   * `exit` here is `app.exit()`, which skips `before-quit` and therefore skips
   * the whole graceful shutdown ordering. Without this call the db-host
   * supervisor never learns the app is going away, sees the teardown's own
   * child exit as a crash, and re-forks into a dying process. Invoked FIRST —
   * ahead of the telemetry emit, the modal crash dialog, and the bounded
   * telemetry flush — because those are seconds of wall time during which the
   * supervisor is otherwise fighting the shutdown.
   */
  beginShutdown?: () => void;
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
  beginShutdownSafely(deps);
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

  beginShutdownSafely(deps);
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

function beginShutdownSafely(deps: { beginShutdown?: () => void }): void {
  try {
    deps.beginShutdown?.();
  } catch {
    // A supervisor teardown cannot interfere with the existing crash path —
    // same contract as the dialog and telemetry helpers below.
  }
}

function emitExceptionSafely(
  deps: { emitException?: (error: unknown) => void },
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

export type BootstrapErrorHandlerDeps = {
  /**
   * Route the failure to the pre-init telemetry queue. Shares
   * {@link emitExceptionSafely} with the full-featured pair above, so a throw
   * from the bridge cannot reach the bootstrap crash path.
   */
  emitException: (error: unknown) => void;
  showDialog: (message: string) => void;
  exit: (code: number) => void;
};

/**
 * The bootstrap `uncaughtException` handler `index.ts` registers before the
 * application module graph is evaluated, and removes once `startup.ts` installs
 * the full-featured pair above.
 *
 * Lives here rather than inline in `index.ts` so the capture decision is driven
 * by a test without booting Electron — `index.ts` supplies the electron dialog,
 * `app.exit`, and the telemetry bridge.
 *
 * It captures but cannot deliver: there is no runtime and no transport yet, and
 * `deps.exit` is `app.exit`, which terminates immediately. The queued record
 * reaches the wire only if the process SURVIVES to
 * `startDesktopOtelRuntimeForBoot` — true for the non-exiting non-Error
 * rejection branch below and for anything raised during the bind→start window,
 * not for this fatal path. Exporting a crash that kills the process needs a
 * durable sink, which ISS-6330 scopes to its death-path sibling.
 */
export function handleBootstrapUncaughtException(
  error: unknown,
  deps: BootstrapErrorHandlerDeps
): void {
  emitExceptionSafely(deps, error);
  deps.showDialog(error instanceof Error ? error.message : String(error));
  deps.exit(1);
}

/**
 * The bootstrap `unhandledRejection` handler, paired with
 * {@link handleBootstrapUncaughtException}.
 */
export function handleBootstrapUnhandledRejection(
  reason: unknown,
  deps: BootstrapErrorHandlerDeps
): void {
  // Captured BEFORE the Error narrowing below, deliberately. A non-Error
  // rejection leaves the process alive, which makes it the one pre-init failure
  // whose queued record is still in memory when the runtime later starts — the
  // narrowing decides whether to show a dialog and exit, not whether the crash
  // is worth reporting.
  emitExceptionSafely(deps, reason);
  if (!(reason instanceof Error)) {
    return;
  }
  deps.showDialog(reason.message);
  deps.exit(1);
}

const BOOTSTRAP_UNCAUGHT_EXCEPTION_EVENT = "uncaughtException";
const BOOTSTRAP_UNHANDLED_REJECTION_EVENT = "unhandledRejection";

/**
 * The subset of `process` this registration needs. Narrow on purpose, so a test
 * can supply a double instead of mutating the real process listener table.
 */
export type BootstrapProcessEventTarget = {
  on: (event: string, listener: (value: unknown) => void) => unknown;
  removeListener: (
    event: string,
    listener: (value: unknown) => void
  ) => unknown;
};

export type BootstrapErrorHandlerRegistration = {
  /** Detach both listeners, once `startup.ts` has installed the real pair. */
  dispose: () => void;
};

/**
 * Install the bootstrap crash handlers on `target` and hand back their removal.
 *
 * This is the production handoff `index.ts` performs before the application
 * module graph is evaluated (ISS-6330), and it lives here — not inline at the
 * call site — so a test can drive the REGISTERED callbacks through a double
 * rather than recreating equivalent ones by hand. A test that rebuilds the
 * callback itself stays green when the registration is deleted or miswired,
 * which is exactly the failure this pair exists to prevent: a silent
 * dialog-and-exit with no telemetry.
 *
 * Registering and removing in one function is also what keeps the two event
 * names from drifting apart — a removal that names a different event than the
 * registration leaks the handler past startup.
 */
export function registerBootstrapErrorHandlers(
  target: BootstrapProcessEventTarget,
  deps: BootstrapErrorHandlerDeps
): BootstrapErrorHandlerRegistration {
  const onUncaughtException = (error: unknown): void =>
    handleBootstrapUncaughtException(error, deps);
  const onUnhandledRejection = (reason: unknown): void =>
    handleBootstrapUnhandledRejection(reason, deps);

  target.on(BOOTSTRAP_UNCAUGHT_EXCEPTION_EVENT, onUncaughtException);
  target.on(BOOTSTRAP_UNHANDLED_REJECTION_EVENT, onUnhandledRejection);

  return {
    dispose() {
      target.removeListener(
        BOOTSTRAP_UNCAUGHT_EXCEPTION_EVENT,
        onUncaughtException
      );
      target.removeListener(
        BOOTSTRAP_UNHANDLED_REJECTION_EVENT,
        onUnhandledRejection
      );
    },
  };
}
