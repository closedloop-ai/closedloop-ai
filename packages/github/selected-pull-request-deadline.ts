const SELECTED_PULL_REQUEST_EVIDENCE_TIMEOUT_MS = 120_000;

/**
 * Bound one selected-PR evidence operation while preserving caller-abort
 * precedence and cleaning the deadline plus caller listener on every outcome.
 */
export function withSelectedPullRequestDeadline<T>(
  operation: Promise<T>,
  controller: AbortController,
  callerSignal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };
    const resolveOnce = (value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onCallerAbort = () => {
      rejectOnce(callerSignal?.reason);
    };
    const timeout = setTimeout(() => {
      const error = new Error("Selected pull-request evidence timed out");
      error.name = "AbortError";
      controller.abort(error);
      rejectOnce(error);
    }, SELECTED_PULL_REQUEST_EVIDENCE_TIMEOUT_MS);

    operation.then(resolveOnce, rejectOnce);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted) {
      onCallerAbort();
    }
  });
}
