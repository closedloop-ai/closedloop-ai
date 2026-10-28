import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSyncedSession } from "@/__tests__/support/agent-sessions/service.test-harness";
import { persistSessionChildren } from "./persist-session-children";

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

const ARTIFACT_ID = "a-1";
const ORGANIZATION_ID = "org-1";

/**
 * Every field the rollup upsert requires except the two nullable ones under
 * test (`startedDay`, `harness`), both left absent here so each case adds only
 * the one field it needs.
 */
const BASE_ANALYTICS: Record<string, unknown> = {
  agentTurns: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  errorEvents: 0,
  eventCount: 1,
  humanTurns: 1,
  inputTokens: 10,
  isHuman: true,
  outputTokens: 5,
  startedAt: "2026-08-01T00:00:00.000Z",
  status: null,
  toolInvocations: 0,
};

function txWithSpies() {
  const rollupUpsert = vi.fn().mockResolvedValue({ artifactId: ARTIFACT_ID });
  const tx = {
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([
        { toolUseCount: 0n, errorCount: 0n, maxEventCreatedAt: null },
      ]),
    agentSessionActivitySegment: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
    },
    agentSessionEvent: { deleteMany: vi.fn() },
    agentSessionTokenEvent: { createMany: vi.fn() },
    agentSessionTokenUsage: { createMany: vi.fn(), deleteMany: vi.fn() },
    agentSessionUsageRollup: { upsert: rollupUpsert },
    artifact: { findFirst: vi.fn() },
    sessionDetail: { update: vi.fn().mockResolvedValue({}) },
  };
  return { rollupUpsert, tx };
}

async function persistAnalytics(
  analyticsOverrides: Record<string, unknown>
): Promise<{
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}> {
  const { rollupUpsert, tx } = txWithSpies();
  const session = buildSyncedSession({ events: [] }) as Record<string, unknown>;
  session.sessionAnalytics = { ...BASE_ANALYTICS, ...analyticsOverrides };
  await persistSessionChildren(
    tx as unknown as Parameters<typeof persistSessionChildren>[0],
    ARTIFACT_ID,
    ORGANIZATION_ID,
    session as never,
    [],
    {
      guardedStatus: SESSION_STATUS.ACTIVE,
      shouldReplace: false,
      shouldUpdateTokenEventCosts: true,
    }
  );
  const [call] = rollupUpsert.mock.calls;
  if (!call) {
    // Not an assertion — a guard, so a slice that stopped writing the rollup at
    // all reports that instead of every case below reading `undefined.startedDay`.
    throw new Error("the usage-rollup upsert never ran");
  }
  return call[0];
}

describe("agent_session_usage_rollups nullable field defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes startedDay as null when the analytics payload omits it", async () => {
    const upsert = await persistAnalytics({ harness: "claude" });

    expect(upsert.create.startedDay).toBeNull();
    expect(upsert.update.startedDay).toBeNull();
  });

  it("writes harness as null when the analytics payload omits it", async () => {
    const upsert = await persistAnalytics({ startedDay: "2026-08-01" });

    expect(upsert.create.harness).toBeNull();
    expect(upsert.update.harness).toBeNull();
  });
});
