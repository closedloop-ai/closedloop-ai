/**
 * @file broken-pipe.ts
 * @description "The stream we were writing to is gone" detection (ISS-5089).
 *
 * A zero-import leaf so both the gateway logger and the process error handlers
 * can share one definition. `error-handlers.ts` is deliberately Electron-free so
 * it stays testable under plain `tsx --test`, and the logger pulls in the
 * persistent-log transport — neither can import the other.
 */

/**
 * Error codes that mean the output stream has closed. None are recoverable and
 * none indicate an application fault: they are what a terminal going away, a
 * `| head` consumer exiting, or a supervisor closing its pipe looks like.
 */
const BROKEN_PIPE_CODES = new Set([
  "EPIPE",
  "EBADF",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

/**
 * True when `error` is a closed-output-stream failure rather than a real fault.
 *
 * Safe to use ONLY where the stream is known by construction — a listener
 * attached to `process.stdout`/`process.stderr`, or a `catch` around a
 * `console.*` write. Nothing about the code alone proves which stream it came
 * from: `EBADF` and `ERR_STREAM_DESTROYED` are equally what an unrelated file
 * descriptor or socket looks like. At a process-wide boundary, where the origin
 * is unknown, use {@link isOutputStreamBrokenPipeError} instead.
 */
export function isBrokenPipeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && BROKEN_PIPE_CODES.has(code);
}

/**
 * The subset of a writable stream that says whether it can still accept a write.
 * A structural type, so the process streams satisfy it directly and a test can
 * drive the closed case without tearing down the real `process.stdout`.
 */
export type OutputStreamState = {
  destroyed?: boolean;
  writable?: boolean;
  writableEnded?: boolean;
};

/** True once `stream` can no longer accept a write. */
export function isOutputStreamClosed(
  stream: OutputStreamState | null | undefined
): boolean {
  if (!stream) {
    // No stream to attribute anything to — absence is not evidence of a
    // broken pipe, so callers must not treat it as one.
    return false;
  }
  return (
    stream.destroyed === true ||
    stream.writableEnded === true ||
    stream.writable === false
  );
}

/**
 * True when `error` is a closed-output-stream failure that is ATTRIBUTABLE to
 * one of `streams` — i.e. at least one of the process's own output streams has
 * actually gone away.
 *
 * The code check alone is not enough at a process-wide boundary. `EBADF` from
 * an unrelated file descriptor, or `ERR_STREAM_DESTROYED` from a destroyed
 * socket or child stdin, carries the same code as a dead stdout while stdout is
 * perfectly healthy — and suppressing those would skip the fatal path and leave
 * the process alive after a genuine uncaught exception. Requiring a dead output
 * stream keeps the ISS-5089 shutdown case suppressed (the pipe is gone by the
 * time the error surfaces) while every unrelated fault still crashes normally.
 */
export function isOutputStreamBrokenPipeError(
  error: unknown,
  streams: readonly (OutputStreamState | null | undefined)[]
): boolean {
  return isBrokenPipeError(error) && streams.some(isOutputStreamClosed);
}
