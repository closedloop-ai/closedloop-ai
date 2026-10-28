import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";

const SESSION_TIMESTAMP = "2026-05-20T17:00:00.000Z";

export function buildSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "ext-0",
    status: SESSION_STATUS.ACTIVE,
    startedAt: SESSION_TIMESTAMP,
    updatedAt: SESSION_TIMESTAMP,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

export function buildBatch(
  sessions: SyncedAgentSession[] = [],
  overrides: Partial<DesktopAgentSessionsPayload> = {}
): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "batch-1",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
    ...overrides,
  };
}

/** A batch from a client that never opted into the row-level echo. */
export function legacyPayload(
  ids: readonly string[]
): DesktopAgentSessionsPayload {
  return buildBatch(
    ids.map((externalSessionId) => buildSession({ externalSessionId }))
  );
}

/** A batch on the row-level-ack path, where a partial result is expressible. */
export function rowLevelAckPayload(
  ids: readonly string[]
): DesktopAgentSessionsPayload {
  return { ...legacyPayload(ids), wantsAcceptedSessionIds: true };
}

/** `sessionCount` sessions with ids `ext-0` .. `ext-<sessionCount - 1>`. */
export function buildPayload(
  sessionCount: number
): DesktopAgentSessionsPayload {
  return legacyPayload(
    Array.from({ length: sessionCount }, (_, index) => `ext-${index}`)
  );
}

export function buildRowLevelAckPayload(
  sessionCount: number
): DesktopAgentSessionsPayload {
  return { ...buildPayload(sessionCount), wantsAcceptedSessionIds: true };
}
