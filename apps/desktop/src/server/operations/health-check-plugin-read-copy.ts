/**
 * The user-facing copy for a plugin whose enabled state could not be read
 * (ISS-5810).
 *
 * A leaf on purpose: BOTH paths that can end up unable to read the state need
 * it — the detection path in `health-check-plugin-inventory.ts`, and the
 * post-enable verification path in `health-check-plugin-enable.ts`. Two copies
 * of this map is how the two paths would drift into telling the operator
 * different things about the same machine state, so there is one.
 */

import {
  PLUGIN_LIST_COMMAND_FAILED_ERROR,
  PLUGIN_LIST_UNREADABLE_ERROR,
  PLUGIN_STATE_UNVERIFIED_ERROR,
} from "./health-check-types.js";
import {
  PluginEnabledUnverifiedReason,
  type PluginInstallStatus,
} from "./plugin-cache.js";

export type UnverifiedEnabledStateCopy = {
  error: string;
  remediation: string;
};

/**
 * The error and remediation for each reason an enabled state could not be read
 * (ISS-5810), as an EXHAUSTIVE map.
 *
 * Exhaustive on purpose: a fourth `PluginEnabledUnverifiedReason` must fail
 * `tsc` here rather than silently fall through to the generic message. Every
 * remediation must be an action whose success condition does not already hold
 * — that is the whole point of splitting these apart. None of them may
 * prescribe `claude plugin enable`, which errors out once the plugin is already
 * enabled and is what left the operator with no exit.
 */
const UNVERIFIED_ENABLED_STATE_COPY: Record<
  PluginEnabledUnverifiedReason,
  (pluginRef: string) => UnverifiedEnabledStateCopy
> = {
  [PluginEnabledUnverifiedReason.CommandFailed]: () => ({
    error: PLUGIN_LIST_COMMAND_FAILED_ERROR,
    remediation:
      "System Check could not run `claude plugin list`. Run it yourself on this machine to see why, then rerun System Check",
  }),
  [PluginEnabledUnverifiedReason.Unreadable]: () => ({
    error: PLUGIN_LIST_UNREADABLE_ERROR,
    remediation:
      "System Check ran `claude plugin list` but could not read its output. Update the Claude CLI and Closedloop, then rerun System Check",
  }),
  [PluginEnabledUnverifiedReason.EnabledStateMissing]: (pluginRef) => ({
    error: PLUGIN_STATE_UNVERIFIED_ERROR,
    remediation: `Run: claude plugin list, confirm ${pluginRef} is listed as enabled at user scope, then rerun System Check`,
  }),
};

/** The copy for one reason, for callers that hold the reason directly. */
export function describeUnverifiedReason(
  reason: PluginEnabledUnverifiedReason,
  pluginRef: string
): UnverifiedEnabledStateCopy {
  return UNVERIFIED_ENABLED_STATE_COPY[reason](pluginRef);
}

/** The copy for a classified install status. */
export function describeUnverifiedEnabledState(
  status: PluginInstallStatus
): UnverifiedEnabledStateCopy {
  const reason =
    status.enabledStateUnverifiedReason ??
    PluginEnabledUnverifiedReason.EnabledStateMissing;
  return describeUnverifiedReason(reason, status.pluginRef);
}
