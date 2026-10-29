/**
 * The agent-session lane's durable-outbox operations, as one delegate slice of
 * `AgentSessionSyncSource` — so the queue semantics read in one place and a new
 * operation does not grow the source adapter.
 */
import type {
  AgentSessionOutboxAdoption,
  AgentSessionOutboxEntry,
  SessionOutboxEngineState,
} from "../agent-sync/agent-session-sync-source.js";
import type { OutboxClearResult } from "../agent-sync/outbox-clear-result.js";
import type { PriorityUploadClaim } from "../agent-sync/priority-upload-claims.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { SignedInUserIdentity } from "../util/user-identity.js";
import {
  recordActivityTilingDebt,
  requeueOwedActivityTilings,
  settleActivityTilingDebt,
} from "./activity-tiling-repair-store.js";
import { sqliteMaintainOutboxEnvironmentPartition } from "./outbox-environment-partition.js";
import { settlePriorityUploads } from "./priority-upload-marker.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  sqliteClearOutboxEntries,
  sqliteClearOutboxLaneStall,
  sqliteEnqueueOutboxEntries,
  sqliteLoadPendingOutboxIds,
  sqliteLoadPendingSessionOutboxEngineState,
  sqliteMarkOutboxDeadLettered,
  sqliteMarkOutboxWithheld,
  sqliteRecordOutboxRetry,
  sqliteReEnqueueRecoveredDeadLetter,
  sqliteRePendWithheldOutbox,
} from "./sync-outbox-store.js";

export function createAgentSessionOutboxDelegates(prisma: DesktopPrisma) {
  return {
    enqueueOutboxEntries(
      sourceKey: string,
      entries: AgentSessionOutboxEntry[]
    ): Promise<void> {
      return sqliteEnqueueOutboxEntries(prisma, sourceKey, entries);
    },
    // ISS-7957: forwards `deleteMany`'s real count. In the FEA-2038 db-host
    // build this return value is structured-cloned back to main, where
    // `readClearedRowCount` re-validates it rather than trusting the cast.
    clearOutboxEntries(
      sourceKey: string,
      ids: string[]
    ): Promise<OutboxClearResult> {
      return sqliteClearOutboxEntries(prisma, sourceKey, ids);
    },
    recordOutboxRetry(
      sourceKey: string,
      id: string,
      attemptCount: number,
      nextAttemptAt: string,
      reason: string,
      laneStalledSince: string | null,
      permanentAttemptCount?: number | null
    ): Promise<void> {
      return sqliteRecordOutboxRetry(
        prisma,
        sourceKey,
        id,
        attemptCount,
        nextAttemptAt,
        reason,
        laneStalledSince,
        permanentAttemptCount
      );
    },
    markOutboxDeadLettered(
      sourceKey: string,
      id: string,
      reason: string,
      attemptCount = 0,
      permanentAttemptCount: number | null = null,
      deadLetterRecoveryCount: number | null = null
    ): Promise<void> {
      return sqliteMarkOutboxDeadLettered(
        prisma,
        sourceKey,
        id,
        reason,
        attemptCount,
        permanentAttemptCount,
        deadLetterRecoveryCount
      );
    },
    reEnqueueRecoveredDeadLetter(
      sourceKey: string,
      id: string
    ): Promise<boolean> {
      return sqliteReEnqueueRecoveredDeadLetter(prisma, sourceKey, id);
    },
    markOutboxWithheld(sourceKey: string, ids: string[]): Promise<void> {
      return sqliteMarkOutboxWithheld(prisma, sourceKey, ids);
    },
    rePendWithheldOutbox(sourceKey: string, ids: string[]): Promise<void> {
      return sqliteRePendWithheldOutbox(prisma, sourceKey, ids);
    },
    loadPendingOutboxIds(sourceKey: string): Promise<string[]> {
      return sqliteLoadPendingOutboxIds(prisma, sourceKey);
    },
    adoptOutboxRowsFromRetiredComputeTargets(
      sourceKey: string,
      identity: SignedInUserIdentity,
      environmentKey: string | null
    ): Promise<AgentSessionOutboxAdoption> {
      return sqliteMaintainOutboxEnvironmentPartition(
        prisma,
        sourceKey,
        identity,
        environmentKey
      );
    },
    clearOutboxLaneStall(sourceKey: string, ids: string[]): Promise<void> {
      return sqliteClearOutboxLaneStall(prisma, sourceKey, ids);
    },
    loadPendingSessionOutboxEngineState(
      sourceKey: string
    ): Promise<SessionOutboxEngineState[]> {
      return sqliteLoadPendingSessionOutboxEngineState(prisma, sourceKey);
    },
    loadPendingOutboxRetryState(
      sourceKey: string
    ): Promise<SessionOutboxEngineState[]> {
      return sqliteLoadPendingSessionOutboxEngineState(prisma, sourceKey);
    },
    // ISS-7265 AC3: session-scoped, not `sourceKey`-scoped — a tiling this
    // device owes the cloud is owed whichever account is signed in.
    recordActivityTilingDebt(sessionIds: string[]): Promise<void> {
      return recordActivityTilingDebt(
        prisma,
        sessionIds,
        new Date().toISOString()
      );
    },
    settleActivityTilingDebt(sessionIds: string[]): Promise<void> {
      return settleActivityTilingDebt(prisma, sessionIds);
    },
    // ISS-10332: rides the same accepted ack as the outbox clear.
    settlePriorityUploads(claims: PriorityUploadClaim[]): Promise<void> {
      return settlePriorityUploads(prisma, claims);
    },
    requeueOwedActivityTilings(): Promise<number> {
      return requeueOwedActivityTilings(prisma, (message) =>
        gatewayLog.warn(OUTBOX_TAG, message)
      ).then((result) => result.requeued);
    },
  };
}

/** Log scope shared with the sync lane's own writers (`agent-session-sync`). */
const OUTBOX_TAG = "agent-session-sync";
