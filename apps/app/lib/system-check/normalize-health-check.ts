import type { CheckResult } from "@repo/api/src/types/compute-target";
import { CheckSeverity } from "@repo/api/src/types/compute-target";
import {
  APP_VERSION_CHECK_ID,
  APP_VERSION_CHECK_LABEL,
} from "@closedloop-ai/loops-api/compute-target";

/**
 * Client-side normalization of gateway check rows (ISS-5369).
 *
 * Extracted from `lib/engineer/queries/health-check.ts` so the version policy
 * below is testable on its own and lives next to the rest of the system-check
 * client code.
 */

export const PLUGIN_VERSIONS_CHECK_ID = "plugin-versions";
export const PLUGIN_VERSIONS_CHECK_LABEL = "Plugin Updates";

export function normalizeHealthCheck(check: CheckResult): CheckResult {
  if (check.id === APP_VERSION_CHECK_ID) {
    return normalizeAppVersionCheck(check);
  }

  if (check.id === PLUGIN_VERSIONS_CHECK_ID) {
    return { ...check, label: PLUGIN_VERSIONS_CHECK_LABEL };
  }

  return check;
}

/**
 * A version finding informs; it never blocks the command.
 *
 * Applied client-side rather than only on the gateway so the already-installed
 * desktop fleet — which still sends `required: true, passed: false` for "a
 * newer release exists" — stops blocking the moment this ships. `passed` is
 * forced true because it is the blocking signal `HealthCheckDialog` reads;
 * `severity` (sent by a gateway that has the fix) or the derived legacy value
 * carries the real state through to the renderer.
 */
function normalizeAppVersionCheck(check: CheckResult): CheckResult {
  return {
    ...check,
    label: APP_VERSION_CHECK_LABEL,
    passed: true,
    required: false,
    severity: check.severity ?? deriveLegacyAppVersionSeverity(check),
  };
}

/**
 * Severity for a version row from a gateway that predates the `severity` field.
 * Such a gateway only ever reported a version finding by failing the row, so a
 * failure here means "there is something to say", never "the gateway is
 * broken" — a warning, not an error.
 */
function deriveLegacyAppVersionSeverity(check: CheckResult): CheckSeverity {
  if (check.passed && !check.error) {
    return CheckSeverity.Passed;
  }
  return CheckSeverity.Warning;
}
