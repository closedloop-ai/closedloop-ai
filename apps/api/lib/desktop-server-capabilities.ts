import type { ComputeTargetServerCapabilities } from "@repo/api/src/types/compute-target";

/** Builds the additive Desktop server-capability payload shared by hello acks. */
export function buildDesktopServerCapabilities(input: {
  agentSessionSyncSupported: boolean;
  commandSigningSupported: boolean;
}): ComputeTargetServerCapabilities | undefined {
  if (!(input.commandSigningSupported || input.agentSessionSyncSupported)) {
    return undefined;
  }
  return {
    ...(input.commandSigningSupported ? { computeTargetSigning: true } : {}),
    ...(input.agentSessionSyncSupported ? { agentSessionSync: true } : {}),
  };
}
