/**
 * Process-level error handlers for uncaught exceptions and unhandled rejections.
 *
 * No Electron imports -- this file is testable with plain tsx --test.
 */

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
};

/**
 * Handler for process 'uncaughtException' events.
 *
 * If the error is a spawn ENOENT (child process not found), it logs the error
 * and returns without calling exit -- this suppresses the Electron crash dialog
 * for missing executables. All other errors are logged then exit(1) is called.
 */
export function handleUncaughtException(
  error: Error,
  deps: ProcessErrorHandlerDeps
): void {
  if (isSpawnEnoent(error)) {
    deps.log(
      `[error-handler] suppressed spawn ENOENT: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
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
export function handleUnhandledRejection(
  reason: unknown,
  deps: ProcessErrorHandlerDeps
): void {
  if (!(reason instanceof Error)) {
    emitExceptionSafely(deps, reason);
    deps.log(
      `[error-handler] unhandled rejection (non-Error): ${String(reason)}`
    );
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
