/**
 * The error's identifying code for a log: the Postgres SQLSTATE or Node
 * system code when it has one, else its class name. Never the message, which
 * for a failed statement can quote the values it was given.
 */
export function errorCode(error: unknown): string {
  if (error instanceof Error) {
    return "code" in error && typeof error.code === "string"
      ? error.code
      : error.name;
  }
  return UNKNOWN_ERROR_CODE;
}

const UNKNOWN_ERROR_CODE = "unknown";

/**
 * The error's stack frames, one per line, without the message lines above
 * them: where the fault happened, and none of the values it quoted.
 */
export function stackFrames(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") {
    return;
  }
  const frames = error.stack
    .split("\n")
    .filter((line) => STACK_FRAME_LINE.test(line));
  return frames.length === 0 ? undefined : frames.join("\n");
}

const STACK_FRAME_LINE = /^\s+at /;
