/**
 * Shared integration-test fixtures for the chunked agent-session sync suites
 * (`__tests__/integration/chunked-sync-repair.integration.test.ts` and
 * `chunked-sync-atomic-apply.integration.test.ts`). Both drive the REAL cloud
 * ingress contract (`parseDesktopAgentSessionsPayload` +
 * `agentSessionsService.upsertSessions`) against Postgres and read the persisted
 * `agent_session_events` + revision/marker columns back directly, so atomicity
 * and repair are proven by the STORE, not by logs.
 *
 * Parameterized by external session id / display name / batch id so each suite
 * keeps its own identity while sharing the chunk builder, ingress helper,
 * compute-target factory, and persisted-state reader.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { parseDesktopAgentSessionsPayload } from "@/lib/desktop-agent-sessions-schema";

export type ChunkMeta = { index: number; total: number };

export type ChunkSyncContext = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
};

export type PersistedChunkState = {
  eventIds: string[];
  dataRevision: number | null;
  pendingChunkRevision: number | null;
  pendingChunkTotal: number | null;
  pendingChunkReceived: number | null;
};

/** Build `evt-0 … evt-(count-1)` external event ids. */
export function buildEventIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `evt-${i}`);
}

/**
 * Build one chunk of an oversized session. Every chunk replicates the session
 * metadata + revision (as the desktop chunker does) and carries a disjoint slice
 * of the event ids plus its `{ index, total }` marker.
 */
export function buildSessionChunk(params: {
  externalSessionId: string;
  name: string;
  eventIds: string[];
  chunk: ChunkMeta;
  dataRevision: number;
}): Record<string, unknown> {
  return {
    externalSessionId: params.externalSessionId,
    name: params.name,
    status: "active",
    harness: "claude",
    cwd: "/tmp/wt",
    model: "claude-opus-4",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    dataRevision: params.dataRevision,
    chunk: params.chunk,
    agents: [],
    events: params.eventIds.map((externalEventId) => ({
      externalEventId,
      eventType: "ToolUse",
      toolName: "Read",
      createdAt: "2026-06-10T10:30:00.000Z",
    })),
    tokenUsageByModel: [],
  };
}

/**
 * Push one built chunk through the real cloud ingress contract and apply it. A
 * fixture build error (payload rejected by the parser) is a thrown Error, not a
 * product assertion, so this helper does no `expect` — the suites own the
 * behavioural assertions.
 *
 * Resolves to the batch's `persistedSessionIds` — the SERVER-TRUTH ack echo the
 * desktop outbox clears its row on. A chunk the gate skipped as foreign reports
 * `persisted: false` and is withheld from that list, so a suite can assert the
 * outbox actually drains rather than inferring it from the stored rows.
 */
export async function ingestChunk(
  context: ChunkSyncContext,
  batchId: string,
  chunk: Record<string, unknown>
): Promise<string[]> {
  const parsed = parseDesktopAgentSessionsPayload({
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId,
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [chunk],
  });
  if (!parsed.ok) {
    throw new Error(
      `payload failed the cloud ingress contract: ${parsed.reason}`
    );
  }
  const { persistedSessionIds } = await agentSessionsService.upsertSessions(
    context,
    parsed.payload
  );
  return persistedSessionIds;
}

/** Create a compute target for the org/user under test. */
export async function createComputeTarget(
  organizationId: string,
  userId: string,
  machineName: string
): Promise<string> {
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName,
        platform: "darwin",
      },
      select: { id: true },
    })
  );
  return target.id;
}

/**
 * Read the persisted event ids + committed revision + staged chunk-sequence
 * marker for a session. Returns `null` when no SessionDetail row exists (e.g. a
 * foreign lone chunk that was skipped before any row was created).
 */
export async function readPersistedChunkState(
  computeTargetId: string,
  externalSessionId: string
): Promise<PersistedChunkState | null> {
  const detail = await withDb((db) =>
    db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: {
        artifactId: true,
        dataRevision: true,
        pendingChunkRevision: true,
        pendingChunkTotal: true,
        pendingChunkReceived: true,
      },
    })
  );
  if (!detail) {
    return null;
  }
  const events = await withDb((db) =>
    db.agentSessionEvent.findMany({
      where: { agentSessionId: detail.artifactId },
      select: { externalEventId: true },
    })
  );
  return {
    eventIds: events.map((e) => e.externalEventId).sort(),
    dataRevision: detail.dataRevision,
    pendingChunkRevision: detail.pendingChunkRevision,
    pendingChunkTotal: detail.pendingChunkTotal,
    pendingChunkReceived: detail.pendingChunkReceived,
  };
}
