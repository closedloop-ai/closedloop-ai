import type { CheckResult } from "@repo/api/src/types/compute-target";

/**
 * One voice per failing row (ISS-5435 review).
 *
 * A row the gateway says Repair can fix used to print its manual remediation
 * anyway — "Install a user/global MCP server pointing to https://… Project-local
 * MCP installs are not supported." sat in a warning box under the row while a
 * button in the same header offered to do exactly that. Two instructions for one
 * failure, and the one asking for a terminal is the louder of the two.
 *
 * The manual copy is not wrong, it is just not what the user should do FIRST —
 * so it is replaced by a line that defers to the control, rather than dropped.
 * Applied by the surface rather than inside `SystemCheckResults` because only
 * the surface knows whether a Repair button is actually painting: with the flag
 * off, on a target somebody else owns, or against a gateway too old to know the
 * operation, `repairable` is still true but there is no button — and deferring
 * to a control that is not there would be the same defect in the mirror.
 */
export const REPAIR_DEFERRAL_REMEDIATION = "Repair can fix this from here.";

export function deferRepairableRemediation(
  checks: CheckResult[] | undefined,
  isRepairOffered: boolean
): CheckResult[] | undefined {
  if (!(checks && isRepairOffered)) {
    return checks;
  }

  let changed = false;
  const next = checks.map((check) => {
    if (check.passed || check.repair?.repairable !== true) {
      return check;
    }
    changed = true;
    return { ...check, remediation: REPAIR_DEFERRAL_REMEDIATION };
  });

  // Identity-preserving when nothing deferred, so a surface that memoizes on
  // this array does not re-render (and, in the dialog, restart its staggered
  // reveal) on every pass.
  return changed ? next : checks;
}
