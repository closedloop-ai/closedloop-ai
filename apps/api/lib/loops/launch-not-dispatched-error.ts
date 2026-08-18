/**
 * Typed outcome for the one `launchLoop` path that finishes without ever
 * handing the command to a provider: the pre-dispatch parent-state guard.
 *
 * The guard marks the loop FAILED and stops, which is correct — but it used to
 * `return loopId` (a plain resolve, and not even a containerId, which is what
 * the signature promises). `dispatchAndClassify` reads any resolve as
 * `{ ok: true }`, so an `execute` / `request_changes` launch whose parent state
 * was gone answered **200 with `{ loopId, status }`** and the browser navigated
 * to a loop that was already FAILED and had never been dispatched. That is the
 * exact "accepted but never delivered" failure ISS-5708 exists to remove,
 * reachable through a door the awaited-dispatch change alone did not close.
 *
 * Throwing a distinct type instead keeps the launch contract honest: `launchLoop`
 * either returns a real containerId or fails, and the failure carries enough
 * shape for the route layer to answer something other than the generic
 * desktop-disconnected 502.
 *
 * Thrown *before* `launchLoop`'s try block on purpose: the guard has already
 * driven the row to FAILED via `failLoopWithError`, so the catch block's
 * cleanup/cancel path must not run and try to re-terminalise it.
 */
export type LaunchNotDispatchedReason = "parent_state_unavailable";

export class LaunchNotDispatchedError extends Error {
  readonly reason: LaunchNotDispatchedReason;

  constructor(reason: LaunchNotDispatchedReason, message: string) {
    super(message);
    this.name = "LaunchNotDispatchedError";
    this.reason = reason;
  }
}

/** Narrows an unknown launch failure to the never-dispatched case. */
export function isLaunchNotDispatchedError(
  error: unknown
): error is LaunchNotDispatchedError {
  return error instanceof LaunchNotDispatchedError;
}
