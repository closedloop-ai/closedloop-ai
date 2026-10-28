/**
 * The agent-session lane's durable CURSOR-STATE operations, as one delegate
 * slice of `AgentSessionSyncSource` — the twin of
 * `agent-session-outbox-delegates.ts`, and for the same reason: `sync-source.ts`
 * is about BUILDING sync payloads, so what has already been delivered (the
 * keyset watermark and this lane's durable lane run) reads in one place and a new
 * operation does not grow that grandfathered adapter. The port these implement
 * is `agent-sync/sync-cursor-state-source.ts`.
 *
 * ISS-5850 / ISS-7896: the trailing `contract` arg is what the connected server
 * proved it can STORE; it selects which payload revision the stamp records.
 */
import type {
  PersistedSyncState,
  SyncContractCapabilities,
} from "../agent-sync/agent-session-sync-source.js";
import type { PersistedLaneRun } from "../agent-sync/sync-cursor-state-source.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  sqliteAdvanceSyncState,
  sqliteLoadSyncState,
  syncStateContractStamps,
} from "./sync-cursor-state.js";
import {
  sqliteRecordLaneGiveUp,
  sqliteRecordLaneRun,
} from "./sync-lane-run-state.js";

export function createSyncCursorStateDelegates(prisma: DesktopPrisma) {
  return {
    loadSyncState(
      sourceKey: string,
      contract?: SyncContractCapabilities
    ): Promise<PersistedSyncState | null> {
      return sqliteLoadSyncState(prisma, sourceKey, contract);
    },
    advanceSyncState(
      sourceKey: string,
      state: PersistedSyncState,
      contract?: SyncContractCapabilities
    ): Promise<void> {
      return sqliteAdvanceSyncState(prisma, sourceKey, state, contract);
    },
    // ISS-9418: the durable lane give-up stamp, beside the cursor it deliberately
    // does not touch. PLN-2028: kept as the stamp-only compatibility alias of
    // `recordLaneRun` below, for a caller that predates the lane run.
    recordLaneGiveUp(
      sourceKey: string,
      gaveUpAt: string | null,
      contract?: SyncContractCapabilities
    ): Promise<void> {
      return sqliteRecordLaneGiveUp(
        prisma,
        sourceKey,
        gaveUpAt,
        syncStateContractStamps(contract)
      );
    },
    // PLN-2028 (ISS-10053): the whole durable lane run in one write.
    recordLaneRun(
      sourceKey: string,
      run: PersistedLaneRun,
      contract?: SyncContractCapabilities
    ): Promise<void> {
      return sqliteRecordLaneRun(
        prisma,
        sourceKey,
        run,
        syncStateContractStamps(contract)
      );
    },
  };
}
