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
    // FEA-4138: gzip decompression on the sync ingest route ships with this
    // server build, so advertise it whenever the sync lane itself is supported.
    // It is a server-version capability, not a per-org feature gate — the
    // desktop only compresses when it sees this flag, so an older server that
    // never emits it keeps receiving uncompressed bodies (skew-safe).
    ...(input.agentSessionSyncSupported
      ? { agentSessionSyncCompression: true }
      : {}),
    // ISS-4541: this server build merges a paginated multi-part activity-segment
    // tiling additively (delete-replace on chunk 0, append-idempotent on later
    // chunks — see persistSessionActivitySegments), so it advertises support
    // whenever the sync lane is up. Like the flags above it is a server-version
    // capability, not a per-org gate: the desktop only paginates the tiling
    // across chunks when it sees this flag, so an older server that never emits
    // it keeps receiving the full tiling replicated in the base payload
    // (skew-safe — the old REPLACE-ALL-per-chunk path stays correct).
    ...(input.agentSessionSyncSupported
      ? { agentSessionSyncActivityChunking: true }
      : {}),
    ...(input.agentSessionSyncSupported
      ? { agentSessionSyncMonitoredActivity: true }
      : {}),
  };
}
