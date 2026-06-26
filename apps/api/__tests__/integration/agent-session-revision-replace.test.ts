/**
 * Integration tests for FEA-1787: revision-gated replace-on-resync.
 *
 * The service's shouldReplace predicate fires when the incoming payload carries
 * a non-null dataRevision that differs from the stored value. When triggered it
 * deletes the session's existing events before upserting the incoming set, and
 * replaces the agents array entirely instead of merging. Tests below exercise
 * the four branches of that predicate plus the chunked-convergence and
 * count-recomputation consequences.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
  type SyncedAgentSessionAgent,
  type SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { agentSessionsService } from "@/app/agent-sessions/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;
const describeIfDb = hasDatabase ? describe : describe.skip;

const SESSION_STARTED_AT = new Date("2026-06-10T10:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-06-10T11:00:00.000Z");

function createComputeTarget(organizationId: string, userId: string) {
  return withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: "revision-test",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
}

function buildSyncedSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "ext-session-rev",
    name: "Revision test session",
    status: "active",
    harness: "claude",
    cwd: "/tmp/worktree",
    model: "claude-opus",
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

function buildPayload(
  sessions: SyncedAgentSession[]
): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "revision-test-batch-id",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

function makeEvent(
  externalEventId: string,
  eventType = "assistant"
): SyncedAgentSessionEvent {
  return {
    externalEventId,
    eventType,
    createdAt: SESSION_STARTED_AT.toISOString(),
  };
}

function makeAgent(
  externalAgentId: string,
  overrides: Partial<SyncedAgentSessionAgent> = {}
): SyncedAgentSessionAgent {
  return {
    externalAgentId,
    name: `Agent ${externalAgentId}`,
    type: "main",
    status: "completed",
    ...overrides,
  };
}

function findSessionDetail(computeTargetId: string, externalSessionId: string) {
  return withDb((db) =>
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
        toolUseCount: true,
        errorCount: true,
        agents: true,
      },
    })
  );
}

function findEvents(agentSessionId: string) {
  return withDb((db) =>
    db.agentSessionEvent.findMany({
      where: { agentSessionId },
      orderBy: { eventCreatedAt: "asc" },
      select: { externalEventId: true, eventType: true },
    })
  );
}

describeIfDb("revision-gated replace-on-resync (FEA-1787)", () => {
  it("replaces events and agents when resync carries a different dataRevision", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const ctx = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };

      // First sync: no dataRevision, two old events, one agent.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSyncedSession({
            agents: [makeAgent("agent-a")],
            events: [makeEvent("old-evt-1"), makeEvent("old-evt-2")],
          }),
        ])
      );

      const afterFirst = await findSessionDetail(
        computeTarget.id,
        "ext-session-rev"
      );
      expect(afterFirst?.dataRevision).toBeNull();

      // Second sync: dataRevision=2 differs from stored null → replace.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSyncedSession({
            dataRevision: 2,
            agents: [makeAgent("agent-b"), makeAgent("agent-c")],
            events: [makeEvent("new-evt-1"), makeEvent("new-evt-2")],
          }),
        ])
      );

      const detail = await findSessionDetail(
        computeTarget.id,
        "ext-session-rev"
      );
      expect(detail?.dataRevision).toBe(2);

      const events = await findEvents(detail?.artifactId ?? "");
      const eventIds = events.map((e) => e.externalEventId);
      // Old events must be gone.
      expect(eventIds).not.toContain("old-evt-1");
      expect(eventIds).not.toContain("old-evt-2");
      // New events must be present.
      expect(eventIds).toContain("new-evt-1");
      expect(eventIds).toContain("new-evt-2");
      expect(events).toHaveLength(2);

      // Agents come from the incoming payload only (not merged with previous).
      const agents = detail?.agents as SyncedAgentSessionAgent[];
      const agentIds = agents.map((a) => a.externalAgentId);
      expect(agentIds).not.toContain("agent-a");
      expect(agentIds).toContain("agent-b");
      expect(agentIds).toContain("agent-c");
    });
  });

  it("appends events when resync carries the same dataRevision (no delete)", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const ctx = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };

      // First sync: dataRevision=2, two events.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSyncedSession({
            dataRevision: 2,
            events: [makeEvent("old-evt-1"), makeEvent("old-evt-2")],
          }),
        ])
      );

      // Second sync: same dataRevision=2 → no replacement, events upserted.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSyncedSession({
            dataRevision: 2,
            events: [makeEvent("new-evt-1"), makeEvent("new-evt-2")],
          }),
        ])
      );

      const detail = await findSessionDetail(
        computeTarget.id,
        "ext-session-rev"
      );
      const events = await findEvents(detail?.artifactId ?? "");
      const eventIds = events.map((e) => e.externalEventId);

      // All four events must be present — no deletion happened.
      expect(eventIds).toContain("old-evt-1");
      expect(eventIds).toContain("old-evt-2");
      expect(eventIds).toContain("new-evt-1");
      expect(eventIds).toContain("new-evt-2");
      expect(events).toHaveLength(4);
    });
  });

  it("appends events on both syncs when neither carries a dataRevision (backward-compatible)", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const ctx = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };

      // First sync: no dataRevision.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSyncedSession({
            events: [makeEvent("old-evt-1"), makeEvent("old-evt-2")],
          }),
        ])
      );

      // Second sync: still no dataRevision → shouldReplace stays false.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSyncedSession({
            events: [makeEvent("new-evt-1"), makeEvent("new-evt-2")],
          }),
        ])
      );

      const detail = await findSessionDetail(
        computeTarget.id,
        "ext-session-rev"
      );
      const events = await findEvents(detail?.artifactId ?? "");
      const eventIds = events.map((e) => e.externalEventId);

      expect(eventIds).toContain("old-evt-1");
      expect(eventIds).toContain("old-evt-2");
      expect(eventIds).toContain("new-evt-1");
      expect(eventIds).toContain("new-evt-2");
      expect(events).toHaveLength(4);
    });
  });

  it("triggers replacement when stored dataRevision is NULL and resync brings a non-null revision", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const ctx = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };

      // First sync without dataRevision → stored NULL.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSyncedSession({
            events: [makeEvent("old-evt-1"), makeEvent("old-evt-2")],
          }),
        ])
      );

      const afterFirst = await findSessionDetail(
        computeTarget.id,
        "ext-session-rev"
      );
      expect(afterFirst?.dataRevision).toBeNull();

      // Second sync with dataRevision=2: NULL !== 2 → replace fires.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSyncedSession({
            dataRevision: 2,
            events: [makeEvent("new-evt-1"), makeEvent("new-evt-2")],
          }),
        ])
      );

      const detail = await findSessionDetail(
        computeTarget.id,
        "ext-session-rev"
      );
      expect(detail?.dataRevision).toBe(2);

      const events = await findEvents(detail?.artifactId ?? "");
      const eventIds = events.map((e) => e.externalEventId);

      // Old events deleted; new events present.
      expect(eventIds).not.toContain("old-evt-1");
      expect(eventIds).not.toContain("old-evt-2");
      expect(eventIds).toContain("new-evt-1");
      expect(eventIds).toContain("new-evt-2");
      expect(events).toHaveLength(2);
    });
  });

  it("converges correctly across chunks: first chunk replaces, subsequent same-revision chunks append", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const ctx = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };

      // Pre-populate with a legacy revision-less sync.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSyncedSession({
            events: [makeEvent("legacy-evt")],
          }),
        ])
      );

      // First chunk of revision=2: differs from stored NULL → replace.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSyncedSession({
            dataRevision: 2,
            events: [makeEvent("e1"), makeEvent("e2"), makeEvent("e3")],
          }),
        ])
      );

      // Second chunk of revision=2: same revision → append.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSyncedSession({
            dataRevision: 2,
            events: [makeEvent("e4"), makeEvent("e5")],
          }),
        ])
      );

      const detail = await findSessionDetail(
        computeTarget.id,
        "ext-session-rev"
      );
      const events = await findEvents(detail?.artifactId ?? "");
      const eventIds = events.map((e) => e.externalEventId);

      // Legacy event replaced in the first chunk; not re-added by second chunk.
      expect(eventIds).not.toContain("legacy-evt");
      // All five events from the two revision=2 chunks present.
      expect(eventIds).toContain("e1");
      expect(eventIds).toContain("e2");
      expect(eventIds).toContain("e3");
      expect(eventIds).toContain("e4");
      expect(eventIds).toContain("e5");
      expect(events).toHaveLength(5);
    });
  });

  it("recomputes toolUseCount and errorCount from the new event set after replacement", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const ctx = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };

      // First sync (no revision): 2 tool_use events + 1 error event.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSyncedSession({
            events: [
              makeEvent("old-tool-1", "tool_use"),
              makeEvent("old-tool-2", "tool_use"),
              makeEvent("old-err-1", "error"),
            ],
          }),
        ])
      );

      const afterFirst = await findSessionDetail(
        computeTarget.id,
        "ext-session-rev"
      );
      expect(afterFirst?.toolUseCount).toBe(2);
      expect(afterFirst?.errorCount).toBe(1);

      // Second sync with revision=2: only 1 tool_use event, no errors → replace.
      await agentSessionsService.upsertSessions(
        ctx,
        buildPayload([
          buildSyncedSession({
            dataRevision: 2,
            events: [makeEvent("new-tool-1", "tool_use")],
          }),
        ])
      );

      const detail = await findSessionDetail(
        computeTarget.id,
        "ext-session-rev"
      );
      // Counts must reflect the new event set, not the old one.
      expect(detail?.toolUseCount).toBe(1);
      expect(detail?.errorCount).toBe(0);
    });
  });
});
