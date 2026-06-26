import {
  type ComputeTargetCapabilities,
  EMPTY_CAPABILITIES,
} from "./contracts.js";

/**
 * Builds the Desktop hello capability payload. `commandSigning` advertises
 * verifier support; `commandSigningRequired` advertises the user's local
 * enforcement opt-in and is omitted when enforcement is off.
 */
export function buildCommandSigningCapabilities(options: {
  commandSigningEnforcementEnabled: boolean;
}): ComputeTargetCapabilities {
  return {
    ...EMPTY_CAPABILITIES,
    ...(options.commandSigningEnforcementEnabled
      ? { commandSigningRequired: true }
      : {}),
  };
}

/** Returns true only when both the relay and local Desktop setting opt in. */
export function shouldEnforceCommandSigning(options: {
  serverCommandSigningSupported: boolean;
  commandSigningEnforcementEnabled: boolean;
}): boolean {
  return (
    options.serverCommandSigningSupported === true &&
    options.commandSigningEnforcementEnabled === true
  );
}
