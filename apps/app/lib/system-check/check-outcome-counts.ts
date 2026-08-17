import type { CheckResult } from "@repo/api/src/types/compute-target";
import {
  CheckSeverity,
  isFailingRequiredCheck,
  resolveCheckSeverity,
} from "@closedloop-ai/loops-api/compute-target";

/**
 * How many System Check rows BLOCK a command, and how many are merely findings.
 *
 * Before ISS-5687 the badge counted EVERY non-passing row. A machine whose only
 * findings were the two OPTIONAL, unconfigured MCP rows was reported as
 * "2 failures" — a number the gate contradicted, since it was never blocked by
 * them at all. Optional rows are still surfaced; they are just not blockers.
 *
 * `passed` alone cannot decide what a finding is. Since ISS-5369 a producer may
 * emit `passed: true` with `severity: "warning"` (Gateway Version does exactly
 * this for an available update) or `"unknown"`/`"blocked"` for a check it could
 * not determine — `passed: true` there means only "does not block", never "is
 * fine". Reading `passed` alone dropped every one of those and let the badge
 * claim "All checks passed" over a live advisory, so the non-blocking tally
 * goes through `resolveCheckSeverity`, the same resolver the panel renders from.
 */
export type CheckOutcomeCounts = {
  /** Failing REQUIRED rows. These block a command. */
  failureCount: number;
  /**
   * Non-blocking findings. Failing OPTIONAL rows chiefly; also any row the
   * gateway marked `passed: true` with a non-passing severity — a Gateway
   * Version update advisory — and, since ISS-5811, a REQUIRED row the gateway
   * could not determine (`severity: "unknown" | "blocked"`) or deliberately
   * downgraded (`severity: "warning"`). Not a blocker, but not nothing either:
   * such a required check is still surfaced here, it just no longer refuses to
   * start the command.
   */
  warningCount: number;
};

export function getCheckOutcomeCounts(
  checks: CheckResult[] | undefined
): CheckOutcomeCounts {
  let failureCount = 0;
  let warningCount = 0;
  for (const check of checks ?? []) {
    // Blocking is decided FIRST, and only by the shared predicate. A gateway
    // that sent a bogus `severity: "passed"` on a failing required row still
    // gets counted here, so the badge cannot undercount what the gate blocks on.
    if (isFailingRequiredCheck(check)) {
      failureCount += 1;
      continue;
    }
    if (resolveCheckSeverity(check) === CheckSeverity.Passed) {
      continue;
    }
    warningCount += 1;
  }
  return { failureCount, warningCount };
}
