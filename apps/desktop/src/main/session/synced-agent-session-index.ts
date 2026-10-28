import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";

/** Index hydrated sessions by their external id for order-preserving reads. */
export function indexSessionsById(
  sessions: readonly SyncedAgentSession[]
): Map<string, SyncedAgentSession> {
  return new Map(
    sessions.map((session) => [session.externalSessionId, session])
  );
}
