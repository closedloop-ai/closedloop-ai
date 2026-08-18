import {
  CheckSeverity,
  CLAUDE_CLI_CHECK_ID as SHARED_CLAUDE_CLI_CHECK_ID,
} from "@closedloop-ai/loops-api/compute-target";
import type { GatewayCheckResult as CheckResult } from "./health-check-types.js";

/**
 * Blocked-check derivation (ISS-5369 Part 1).
 *
 * The plugin inventory is read by shelling out to `claude plugin list --json`.
 * When the Claude binary cannot be resolved — a stale binary-path override, for
 * instance — that command cannot run, so every Closedloop plugin fell through
 * to a generic "Could not verify enabled state" failure telling the user to run
 * five `claude plugin enable` commands. Those commands cannot fix anything
 * while the binary path is broken, and if the user's shell resolves `claude`
 * from PATH they may even succeed in the terminal while System Check keeps
 * failing, because the checker uses the override. One fault was reported as
 * six, five of them with a remediation that could not work.
 *
 * A check that could not run has not failed — it is not determinable. These
 * helpers mark such rows `blocked` and point them at the single check that
 * actually needs fixing, instead of asserting a fault the data does not
 * support.
 */

/**
 * Re-exported from the shared contract (ISS-5687) so the gateway that PRODUCES
 * this row and the cloud code that derives harness availability from it resolve
 * one symbol. The import path stays here because every desktop consumer already
 * reads it from this module.
 */
export const CLAUDE_CLI_CHECK_ID = SHARED_CLAUDE_CLI_CHECK_ID;

/**
 * `error` on a row this module rewrote because the Claude CLI was unresolvable.
 * Exported for the same reason `CLAUDE_CLI_CHECK_ID` is: the modules that read a
 * blocked row back should match on the symbol, not on a copy of the literal.
 */
export const BLOCKED_ERROR_MESSAGE = "Not checked, Claude CLI unavailable";

/**
 * Rewrite rows that could not be determined because the Claude CLI is
 * unresolvable.
 *
 * Only rows the checker already marked `severity: "unknown"` are touched: a
 * plugin proven absent or proven disabled is a real, independently actionable
 * finding and keeps its own error and remediation.
 */
export function applyClaudeCliBlockedChecks(
  checks: CheckResult[],
  claudeCliCheck: Pick<CheckResult, "passed" | "remediation"> | undefined
): CheckResult[] {
  if (!claudeCliCheck || claudeCliCheck.passed) {
    return checks;
  }

  const remediation = buildBlockedRemediation(claudeCliCheck.remediation);
  return checks.map((check) => {
    if (check.severity !== CheckSeverity.Unknown) {
      return check;
    }
    return {
      ...check,
      severity: CheckSeverity.Blocked,
      blockedBy: CLAUDE_CLI_CHECK_ID,
      error: BLOCKED_ERROR_MESSAGE,
      remediation,
    };
  });
}

/**
 * Point a blocked row at the blocking check's own remediation rather than
 * duplicating the fix text, so the two can never drift apart.
 */
export function buildBlockedRemediation(
  claudeCliRemediation: string | undefined
): string {
  const prefix = "Fix the Claude CLI check first";
  return claudeCliRemediation ? `${prefix}: ${claudeCliRemediation}` : prefix;
}
