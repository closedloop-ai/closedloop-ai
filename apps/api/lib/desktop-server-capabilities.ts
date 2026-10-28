import type { ComputeTargetServerCapabilities } from "@repo/api/src/types/compute-target";

/**
 * Builds the additive Desktop server-capability payload shared by hello acks.
 *
 * Every `agentSessionSync*` flag is a SERVER-VERSION capability, not a per-org
 * gate: this build ships gzip ingest decompression (FEA-4138), paginated
 * multi-part activity-segment tiling (ISS-4541), monitored activity, and a
 * `sessionSpanSchema` that declares `startMs`/`endMs` so a span carrying them is
 * persisted rather than stripped by the non-strict object schema (ISS-5850), and
 * a persist boundary that preserves `metadata.humanTurnTimestamps` (ISS-7896)
 * and `metadata.agentTurnTimestamps` (ISS-9864) whole rather than capping them
 * at the generic 100-item array bound, so it advertises all of them
 * unconditionally. The desktop only uses each one when it sees the flag, so an
 * older server that never emits it keeps receiving the uncompressed / unchunked
 * shape (skew-safe in both directions). For the span extent and the two
 * turn-timestamp keys specifically, that absence is load-bearing: a desktop
 * talking to an older server withholds the cursor stamp that would claim the
 * field was delivered, so the replay stays owed until a build like this one
 * answers.
 *
 * ISS-8022 retired the `desktop-agent-session-sync` PostHog flag that used to
 * gate this group. It was fail-closed, so an environment with no PostHog client
 * advertised no sync capability at all and rejected every ingest batch.
 */
export function buildDesktopServerCapabilities(input: {
  commandSigningSupported: boolean;
}): ComputeTargetServerCapabilities {
  return {
    ...(input.commandSigningSupported ? { computeTargetSigning: true } : {}),
    agentSessionSync: true,
    agentSessionSyncCompression: true,
    agentSessionSyncActivityChunking: true,
    // ISS-9859: this build MERGES a session part marked `prRefsPaginated: true`
    // into the stored PR links AND appends its `prs` page to the stored
    // `pullRequests` blob, instead of replacing either with that part's slice,
    // and admits page 0 (`false`) at a freshness tie as a whole-set replace.
    // So a desktop may split an oversized session's `prRefs` and `prs` across
    // parts. Absence is what keeps an older desktop replicating them whole —
    // skew-safe both ways.
    agentSessionSyncPrRefChunking: true,
    agentSessionSyncMonitoredActivity: true,
    agentSessionSyncSpanExtent: true,
    agentSessionSyncHumanTurnTimestamps: true,
    agentSessionSyncAgentTurnTimestamps: true,
    // ISS-12552: this build accepts and corrects a token event's owner, so a
    // desktop may send `agentExternalId`. Absence keeps it omitted for an
    // older server, which rejects an owner that differs from the stored one.
    // Advertised whatever attribution-evidence-policy says for the
    // organization: while it is off, ingest stores a new event's owner and
    // keeps a stored one rather than correcting it (PRD-800), and never
    // rejects a changed one.
    agentSessionSyncTokenEventOwner: true,
  };
}
