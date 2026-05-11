import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY,
} from "@repo/api/src/types/compute-target";

/**
 * Returns true only when Desktop advertises both browser command-signing
 * verification support and explicit local enforcement opt-in.
 */
export function hasDesktopCommandSigningEnforcement(
  capabilities: Record<string, unknown> | null | undefined
): boolean {
  return (
    capabilities?.[COMMAND_SIGNING_CAPABILITY_KEY] === true &&
    capabilities?.[COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY] === true
  );
}
