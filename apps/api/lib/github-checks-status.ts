import { ChecksStatus } from "@repo/api/src/types/document";
import type { StatusCheckRollupState } from "@repo/api/src/types/github";
import { log } from "@repo/observability/log";

/**
 * Map GitHub's aggregate statusCheckRollup state into the branch-view checks
 * status contract.
 */
export function mapRollupStateToChecksStatus(
  rollupState: StatusCheckRollupState
): ChecksStatus {
  switch (rollupState) {
    case "SUCCESS":
      return ChecksStatus.Passing;
    case "FAILURE":
    case "ERROR":
      return ChecksStatus.Failing;
    case "PENDING":
    case "EXPECTED":
      return ChecksStatus.Pending;
    default:
      return mapUnhandledRollupState(rollupState);
  }
}

function mapUnhandledRollupState(rollupState: never): ChecksStatus {
  log.warn("[github-checks-status] Unknown status check rollup state", {
    rollupState,
  });
  return ChecksStatus.Pending;
}

export function mapNullableRollupStateToChecksStatus(
  rollupState: StatusCheckRollupState | null
): ChecksStatus {
  return rollupState
    ? mapRollupStateToChecksStatus(rollupState)
    : ChecksStatus.Unknown;
}
