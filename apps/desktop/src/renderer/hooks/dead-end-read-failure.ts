import { DeadEndFlowReason } from "../../shared/dead-end-telemetry-contract";

/**
 * ISS-9725 — the failed-read half of the dead-end vocabulary, shared by every
 * surface that classifies one. It was file-private to the Sessions classifier
 * while Sessions was the only caller; Branches is the second, and a copy is how
 * the SAME Cloud 401/403 starts meaning two different things depending on which
 * list the user was looking at — the exact split the whitlockk review of ISS-7249
 * removed from the Sessions list and detail.
 */

/**
 * Why a read that got an answer failed. Shared so the SAME Cloud 401/403 cannot
 * be `permission_denied` on one surface and `fetch_failed` on another — a split
 * that made "how many dead ends are permission problems" unanswerable.
 */
export function resolveFailedReadReason(
  httpStatus: number | null
): DeadEndFlowReason {
  return isPermissionStatus(httpStatus)
    ? DeadEndFlowReason.PermissionDenied
    : DeadEndFlowReason.FetchFailed;
}

/** Omit the status entirely when none arrived — never serialize a stand-in. */
export function httpStatusFields(httpStatus: number | null): {
  httpStatus?: number;
} {
  return httpStatus === null ? {} : { httpStatus };
}

function isPermissionStatus(httpStatus: number | null): boolean {
  return httpStatus === 401 || httpStatus === 403;
}
