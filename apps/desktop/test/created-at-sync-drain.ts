/**
 * @file created-at-sync-drain.ts
 * @description ISS-12251: run the real session sync lane over a store's sync
 * source with a capturing fake transport, for the `createdAt` delivery suites.
 */
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { settleSelfContinuedDrain } from "./agent-session-sync-service-fixtures.js";

/** Start the lane, drain it to caught-up, and return every session it sent. */
export async function drainSentSessions(
  source: AgentSessionSyncSource,
  computeTargetId: string
): Promise<SyncedAgentSession[]> {
  const sent: SyncedAgentSession[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => computeTargetId,
    sendBatch: (batch) => {
      sent.push(...batch.sessions);
      return Promise.resolve({ accepted: true as const });
    },
  });
  service.start();
  try {
    await settleSelfContinuedDrain(service);
  } finally {
    service.stop();
  }
  return sent;
}
