import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it, vi } from "vitest";
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

/**
 * ISS-7813: the whole-session cost write onto `SessionDetail.estimatedCost`.
 *
 * Three separate rules meet on one `if`, and nothing covered any of them: the
 * freshness gate, the "omission never clears" rule for version-skewed desktops,
 * and null-preservation. Each is asserted here against the shape it protects, so
 * the branch cannot be widened or dropped silently.
 */
function txWithSpies() {
  const sessionDetailUpdate = vi.fn().mockResolvedValue({ artifactId: "a-1" });
  const tx = {
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([
        { toolUseCount: 0n, errorCount: 0n, maxEventCreatedAt: null },
      ]),
    $executeRawUnsafe: vi.fn(),
    artifact: { findFirst: vi.fn() },
    agentSessionEvent: { deleteMany: vi.fn() },
    agentSessionTokenUsage: { deleteMany: vi.fn(), createMany: vi.fn() },
    agentSessionTokenEvent: { createMany: vi.fn() },
    agentSessionActivitySegment: {
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    agentSessionUsageRollup: { upsert: vi.fn() },
    sessionDetail: { update: sessionDetailUpdate },
  };
  return { sessionDetailUpdate, tx };
}

async function persistWithCost(
  estimatedCostUsd: number | null | undefined,
  shouldUpdateTokenEventCosts: boolean
) {
  const { sessionDetailUpdate, tx } = txWithSpies();
  const session = buildSyncedSession({ events: [] }) as Record<string, unknown>;
  session.sessionAnalytics = {
    agentTurns: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    errorEvents: 0,
    eventCount: 1,
    harness: "claude",
    humanTurns: 1,
    inputTokens: 10,
    isHuman: true,
    outputTokens: 5,
    startedAt: "2026-08-01T00:00:00.000Z",
    startedDay: "2026-08-01",
    status: "inactive",
    toolInvocations: 0,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  };
  await persistSessionChildren(
    tx as unknown as Parameters<typeof persistSessionChildren>[0],
    "a-1",
    "org-1",
    session as never,
    [],
    {
      // Non-terminal, so the rollup's terminal-wins guard never fires and these
      // cost cases read exactly as they did before it was threaded through.
      guardedStatus: SESSION_STATUS.ACTIVE,
      shouldReplace: false,
      shouldUpdateTokenEventCosts,
    }
  );
  return sessionDetailUpdate;
}

describe("ISS-7813: whole-session cost write", () => {
  it("writes a numeric cost, rounded", async () => {
    const update = await persistWithCost(12.345_678_9, true);
    expect(update).toHaveBeenCalledTimes(1);
    // `roundCost` is `toFixed(6)`; the column is Decimal(14,6), so an unrounded
    // value would be truncated by the driver instead of by us.
    expect(update.mock.calls[0][0].data).toEqual({ estimatedCost: 12.345_679 });
  });

  it("writes NULL when the cost is unknown, rather than 0", async () => {
    const update = await persistWithCost(null, true);
    expect(update).toHaveBeenCalledTimes(1);
    // The distinction the nullable column exists for. A 0 here would be
    // indistinguishable from a subscription session that really cost $0.00.
    expect(update.mock.calls[0][0].data).toEqual({ estimatedCost: null });
  });

  it("does NOT write when the field is absent — omission never clears", async () => {
    // A desktop build predating this sends no cost at all. Writing null for it
    // would blank a value a newer client had already synced.
    const update = await persistWithCost(undefined, true);
    expect(update).not.toHaveBeenCalled();
  });

  it("does NOT write when the freshness gate is closed", async () => {
    // Desktop sync is at-least-once and can reorder. Without the gate a delayed
    // OLDER batch overwrites a newer cost — and this column is now the displayed
    // authority, so that is a user-visible regression, not a stale rollup.
    const update = await persistWithCost(9.99, false);
    expect(update).not.toHaveBeenCalled();
  });

  it("narrows the RETURNING to the primary key", async () => {
    // `no-discarded-wide-prisma-write`: the row is discarded, so the write must
    // not pull every column back. Single-row semantics (and the P2025 throw on a
    // missing session) are kept by staying on `update` rather than `updateMany`.
    const update = await persistWithCost(1, true);
    expect(update.mock.calls[0][0].select).toEqual({ artifactId: true });
    expect(update.mock.calls[0][0].where).toEqual({ artifactId: "a-1" });
  });
});

describe("per-model token usage estimatedCost default", () => {
  it("rounds an omitted per-model estimatedCostUsd to 0 rather than leaving it undefined", async () => {
    const { tx } = txWithSpies();
    const createMany = tx.agentSessionTokenUsage.createMany;
    const session = buildSyncedSession({ events: [] });

    await persistSessionChildren(
      tx as unknown as Parameters<typeof persistSessionChildren>[0],
      "a-1",
      "org-1",
      session as never,
      [
        {
          model: "claude-sonnet-4",
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          // estimatedCostUsd omitted entirely — an older/partial per-model row.
        },
      ],
      {
        guardedStatus: SESSION_STATUS.ACTIVE,
        shouldReplace: false,
        shouldUpdateTokenEventCosts: true,
      }
    );

    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          agentSessionId: "a-1",
          model: "claude-sonnet-4",
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite5mTokens: null,
          cacheWrite1hTokens: null,
          estimatedCost: 0,
        },
      ],
    });
  });
});
