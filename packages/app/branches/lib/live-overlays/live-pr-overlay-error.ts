/**
 * Error type + degrade-reason mapping shared by every Branches live overlay
 * (Epic F / FEA-1952). All gateway reads (`/pr/files`, `/pr/reviews`,
 * `repo-path`) throw `LivePrOverlayError` on a non-OK response so consumers can
 * map the failure to a distinct, user-meaningful degraded state instead of a
 * raw thrown error.
 */

/**
 * Why a live overlay is unavailable, so panels render a DISTINCT state per
 * cause:
 * - `not-connected`  — gateway 403 (proxy guard / `directory not allowed` /
 *   `gh` unauthenticated): show the connect-GitHub affordance.
 * - `no-repo-identity` — no `repoFullName`/`prNumber` or the slug resolves to no
 *   local worktree (repo-identity capture, FEA-1899, not yet populated).
 * - `error` — any other failure.
 */
export const OverlayUnavailableReason = {
  NotConnected: "not-connected",
  NoRepoIdentity: "no-repo-identity",
  Error: "error",
} as const;
export type OverlayUnavailableReason =
  (typeof OverlayUnavailableReason)[keyof typeof OverlayUnavailableReason];

export class LivePrOverlayError extends Error {
  /** Sanitized `body.error` from the gateway (or a synthetic code). */
  readonly code: string;
  /** HTTP status of the failed gateway response. */
  readonly status: number;

  constructor(message: string, options: { code: string; status: number }) {
    super(message);
    this.name = "LivePrOverlayError";
    this.code = options.code;
    this.status = options.status;
  }
}

/**
 * Map a query error (or a `null` sentinel meaning "no identity") to a degrade
 * reason. A 403 from the gateway means the proxy guard rejected the request or
 * `gh` is unauthenticated — both surface as `not-connected`. `null` (the caller
 * never had an identity to query) maps to `no-repo-identity`.
 */
export function resolveOverlayUnavailableReason(
  error: unknown
): OverlayUnavailableReason {
  if (error == null) {
    return OverlayUnavailableReason.NoRepoIdentity;
  }
  if (error instanceof LivePrOverlayError && error.status === 403) {
    return OverlayUnavailableReason.NotConnected;
  }
  return OverlayUnavailableReason.Error;
}
