import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { AutonomyBand } from "@repo/api/src/types/session-activity-metrics";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  persistedSessionDetail,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

/**
 * ISS-10721: the ingest WIRING, not the writer.
 *
 * `activity-metrics-persistence.test.ts` proves the writer maps a rollup
 * correctly against a mock transaction; nothing there would notice if the call
 * were removed from `persistSessionChildren`. This drives the real route entry
 * point so deleting that line turns a suite red instead of silently dropping
 * every rollup on the floor.
 */
describe("session ingest wiring: activity-metrics rollup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists a rollup the payload carried, through the real upsert path", async () => {
    const activityMetricsUpsert = vi.fn().mockResolvedValue({});
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({
        upsert: vi
          .fn()
          .mockResolvedValue(persistedSessionDetail("persisted-session-1")),
      }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      agentSessionActivityMetrics: {
        upsert: activityMetricsUpsert,
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba004",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            activityMetrics: {
              autonomyBand: AutonomyBand.Mixed,
              coverage: 0.5,
              segmentCount: 4,
              coveredSegmentCount: 2,
            },
          }),
        ],
      }
    );

    expect(activityMetricsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentSessionId: "persisted-session-1" },
        update: expect.objectContaining({
          autonomyBand: AutonomyBand.Mixed,
          coverage: 0.5,
          segmentCount: 4,
          coveredSegmentCount: 2,
        }),
      })
    );
  });

  it("touches the rollup table not at all when the payload carries none", async () => {
    const activityMetricsUpsert = vi.fn().mockResolvedValue({});
    const activityMetricsUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({
        upsert: vi
          .fn()
          .mockResolvedValue(persistedSessionDetail("persisted-session-1")),
      }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      agentSessionActivityMetrics: {
        upsert: activityMetricsUpsert,
        updateMany: activityMetricsUpdateMany,
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba005",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [buildSyncedSession({})],
      }
    );

    // A desktop build that predates the field, or a later chunk of a paginated
    // session: the stored rollup must be left exactly as it is.
    expect(activityMetricsUpsert).not.toHaveBeenCalled();
    expect(activityMetricsUpdateMany).not.toHaveBeenCalled();
  });
});
