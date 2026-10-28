import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  groupBy: vi.fn(),
  queryRaw: vi.fn(),
  scope: vi.fn(),
  tx: vi.fn(),
}));
vi.mock("@repo/database", () => ({
  Prisma: {
    TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" },
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
  withDb: { tx: mocks.tx },
}));
vi.mock("./component-session-scope", () => ({
  buildComponentUsageScope: mocks.scope,
}));

import { readComponentFrequency } from "./component-frequency";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({
    componentKind: AgentComponentKind.Subagent,
    session: { artifact: { organizationId: "org" } },
  });
  mocks.tx.mockImplementation((read) =>
    read({
      agentComponentSessionUsage: { groupBy: mocks.groupBy },
      $queryRaw: mocks.queryRaw,
    })
  );
  mocks.groupBy.mockResolvedValue([]);
  mocks.queryRaw.mockResolvedValue([]);
});

function sessionSums(sum: number, min = 1) {
  return [
    {
      agentSessionId: "session-1",
      _sum: { invocationCount: sum },
      _min: { invocationCount: min },
    },
  ];
}

describe("component daily frequency", () => {
  it("buckets over exact UTC session-start-day boundaries across a leap day", async () => {
    mocks.groupBy.mockResolvedValueOnce(sessionSums(12));
    mocks.queryRaw.mockResolvedValueOnce([
      { day: "2024-02-28", invocations: 12n },
    ]);
    const result = await readComponentFrequency(
      "org",
      "subagent::design-critic",
      3,
      new Date("2024-03-01T23:30:00Z")
    );
    expect(result).toEqual({
      windowDays: 3,
      points: [
        { day: "2024-02-28", invocations: 12 },
        { day: "2024-02-29", invocations: 0 },
        { day: "2024-03-01", invocations: 0 },
      ],
    });
    expect(mocks.scope).toHaveBeenCalledWith("org", "subagent::design-critic");
    expect(mocks.groupBy).toHaveBeenCalledTimes(1);
    expect(mocks.groupBy.mock.calls[0][0]).toEqual({
      by: ["agentSessionId"],
      where: {
        AND: [
          {
            componentKind: AgentComponentKind.Subagent,
            session: { artifact: { organizationId: "org" } },
          },
          {
            session: {
              sessionStartedAt: {
                gte: new Date("2024-02-28T00:00:00Z"),
                lt: new Date("2024-03-02T00:00:00Z"),
              },
            },
          },
        ],
      },
      _sum: { invocationCount: true },
      _min: { invocationCount: true },
    });
    expect(mocks.queryRaw.mock.calls[0][0].values).toEqual([
      ["session-1"],
      [12],
    ]);
    expect(mocks.tx.mock.calls[0][1]).toMatchObject({
      isolationLevel: "RepeatableRead",
    });
  });

  it("issues the same two statements for a 365-day window as for one day", async () => {
    mocks.groupBy.mockResolvedValue(sessionSums(4));
    mocks.queryRaw.mockResolvedValue([{ day: "2026-10-20", invocations: 4n }]);
    const result = await readComponentFrequency(
      "org",
      "subagent::design-critic",
      365,
      new Date("2026-10-20T12:00:00Z")
    );
    expect(mocks.groupBy).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(result.points).toHaveLength(365);
    expect(result.points[0]?.day).toBe("2025-10-21");
    expect(result.points.at(-1)).toEqual({ day: "2026-10-20", invocations: 4 });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses malformed persisted sums instead of plotting them: %s",
    async (value) => {
      mocks.groupBy.mockResolvedValue(sessionSums(value));
      await expect(
        readComponentFrequency("org", "subagent::design-critic", 1)
      ).rejects.toThrow();
    }
  );

  it("detects a negative persisted operand even when positive rows cancel it", async () => {
    mocks.groupBy.mockResolvedValue(sessionSums(4, -1));
    await expect(
      readComponentFrequency("org", "subagent::design-critic", 1)
    ).rejects.toThrow();
  });

  it("does not convert a failed attribution read to zero buckets", async () => {
    mocks.scope.mockRejectedValue(new Error("unavailable"));
    await expect(
      readComponentFrequency("org", "subagent::design-critic", 1)
    ).rejects.toThrow("unavailable");
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });

  it.each([0, 366, 1.5, Number.NaN])(
    "bounds the aggregate query work before any read: %s",
    async (windowDays) => {
      await expect(
        readComponentFrequency("org", "subagent::design-critic", windowDays)
      ).rejects.toThrow();
      expect(mocks.scope).not.toHaveBeenCalled();
      expect(mocks.groupBy).not.toHaveBeenCalled();
    }
  );
});
