import { ChecksStatus } from "./types/branch-checks.ts";
import type { StatusCheckRollupState } from "./types/github.ts";

/**
 * Map GitHub's aggregate statusCheckRollup state into the shared branch checks
 * status contract. Unknown values must fail typecheck until intentionally
 * mapped, while null provider data stays an explicit UNKNOWN state.
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
      return assertUnhandledRollupState(rollupState);
  }
}

export function mapNullableRollupStateToChecksStatus(
  rollupState: StatusCheckRollupState | null
): ChecksStatus {
  return rollupState
    ? mapRollupStateToChecksStatus(rollupState)
    : ChecksStatus.Unknown;
}

function assertUnhandledRollupState(rollupState: never): ChecksStatus {
  throw new Error(`Unhandled GitHub status check rollup state: ${rollupState}`);
}
