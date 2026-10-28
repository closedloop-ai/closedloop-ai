/**
 * Classifiers for git child-process failures. A leaf on purpose, so every
 * owner of these helpers can import it without adding an edge back into its
 * own graph.
 */

export function isPushAuthFailure(stderr: string): boolean {
  const output = stderr.toLowerCase();
  return (
    output.includes("authentication failed") ||
    output.includes("permission denied") ||
    output.includes("could not read username") ||
    output.includes("repository not found") ||
    output.includes("access denied") ||
    output.includes("403") ||
    output.includes("401")
  );
}

export function isProcessTimeout(error: unknown): boolean {
  if (!(error && typeof error === "object")) {
    return false;
  }
  const record = error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  return (
    record.code === "ETIMEDOUT" ||
    record.killed === true ||
    record.signal === "SIGTERM"
  );
}
