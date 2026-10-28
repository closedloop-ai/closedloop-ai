import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { SESSION_LIST_PARITY_CONFORM_SCENARIO } from "@repo/lib/sessions/__tests__/session-list-parity-conform";
import { SESSION_LIST_PARITY_EVIDENCE_SCENARIO } from "@repo/lib/sessions/__tests__/session-list-parity-evidence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPersistedAgent } from "@/__tests__/support/agent-sessions/service.test-harness";
import {
  type ParityCloudHost,
  readParityResponse,
  seedParityHost,
} from "@/__tests__/support/agent-sessions/session-list-parity.test-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "../service";
import { agentSessionUsageQuerySchema } from "../validators";
import { buildAgentSessionStatusCounts } from "./status-counts";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;
const organizations = createCommittedTestOrganizationTracker();
let host: ParityCloudHost;
let durationHost: ParityCloudHost;

const window = {
  startDate: "2026-06-12T02:00:00.000Z",
  endDate: "2026-06-12T04:00:00.000Z",
};
const excludedCosts = new Map<string, number>([
  ["e2", 7],
  ["e4", 8],
]);
const metricRows = SESSION_LIST_PARITY_EVIDENCE_SCENARIO.rows.map((row) => ({
  ...row,
  costUsd: excludedCosts.get(row.key) ?? row.costUsd,
}));

describeIfDb("ISS-9609/ISS-9525 cloud list and metrics population", () => {
  beforeAll(async () => {
    host = await seedParityHost(organizations, metricRows);
    durationHost = await seedParityHost(
      organizations,
      SESSION_LIST_PARITY_CONFORM_SCENARIO.rows
    );
    for (const [key, status] of [
      ["p02", "completed"],
      ["p04", "failed"],
    ] as const) {
      const artifactId = durationHost.artifactIds.get(key);
      const row = SESSION_LIST_PARITY_CONFORM_SCENARIO.rows.find(
        (candidate) => candidate.key === key
      );
      if (!(artifactId && row)) {
        throw new Error(`missing analytics parity row ${key}`);
      }
      await withDb((db) =>
        db.sessionDetail.update({
          where: { artifactId },
          data: {
            agents: [
              buildPersistedAgent({
                externalAgentId: `${key}-agent`,
                type: "assistant",
                status,
                startedAt: row.startedAt,
                endedAt: row.endedAt,
              }),
            ],
          },
          select: { artifactId: true },
        })
      );
    }
    const excludedArtifactId = host.artifactIds.get("e4");
    if (!excludedArtifactId) {
      throw new Error("missing out-of-window parity row");
    }
    await withDb((db) =>
      db.sessionDetail.update({
        where: { artifactId: excludedArtifactId },
        data: { inputTokens: 43 },
        select: { artifactId: true },
      })
    );
  });

  afterAll(() => organizations.cleanup());

  it("DT-01/02: the filtered list and usage count, cost, tokens, and status count share one windowed cohort", async () => {
    const filters = {
      ...window,
      statuses: [SESSION_STATUS.INACTIVE],
      quality: "substantive",
    } as const;
    const list = await readParityResponse(host.organizationId, {
      ...filters,
      limit: 25,
    });
    const usage = await agentSessionsService.getUsageSummary({
      organizationId: host.organizationId,
      filters: agentSessionUsageQuerySchema.parse(filters),
    });
    const status = await buildAgentSessionStatusCounts({
      organizationId: host.organizationId,
      filters: agentSessionUsageQuerySchema.parse({
        ...window,
        quality: "substantive",
      }),
    });

    expect(list.items.map((item) => item.externalSessionId).sort()).toEqual([
      "e1",
      "e3",
    ]);
    expect(list.total).toBe(2);
    expect(usage.totalSessions).toBe(2);
    expect(usage.totalEstimatedCost).toBe(3.5);
    expect(usage.totalInputTokens).toBe(0);
    expect(usage.totalOutputTokens).toBe(0);
    expect(status.total).toBe(2);
    expect(status.countsByStatus[SESSION_STATUS.INACTIVE]).toBe(2);
  });

  it("DT-01/02: an unfiltered or idle query cannot reuse the substantive denominator", async () => {
    const unfiltered = await agentSessionsService.getUsageSummary({
      organizationId: host.organizationId,
      filters: agentSessionUsageQuerySchema.parse({ quality: "all" }),
    });
    const idleFilters = { ...window, quality: "idle" } as const;
    const idleList = await readParityResponse(host.organizationId, {
      ...idleFilters,
      limit: 25,
    });
    const idleUsage = await agentSessionsService.getUsageSummary({
      organizationId: host.organizationId,
      filters: agentSessionUsageQuerySchema.parse(idleFilters),
    });

    expect(unfiltered.totalSessions).toBe(4);
    expect(unfiltered.totalEstimatedCost).toBe(18.5);
    expect(unfiltered.totalInputTokens).toBe(43);
    expect(idleList.items.map((item) => item.externalSessionId)).toEqual([
      "e2",
    ]);
    expect(idleList.total).toBe(1);
    expect(idleUsage.totalSessions).toBe(1);
    expect(idleUsage.totalEstimatedCost).toBe(7);
  });

  it("DT-02: a windowed terminal row retains its status, cost, and two-hour duration basis", async () => {
    const filters = {
      startDate: "2026-06-12T09:00:00.000Z",
      endDate: "2026-06-12T11:00:00.000Z",
      statuses: [SESSION_STATUS.INACTIVE],
      quality: "all",
    } as const;
    const list = await readParityResponse(durationHost.organizationId, {
      ...filters,
      limit: 25,
    });
    const usage = await agentSessionsService.getUsageSummary({
      organizationId: durationHost.organizationId,
      filters: agentSessionUsageQuerySchema.parse(filters),
    });

    expect(list.items.map((item) => item.externalSessionId)).toEqual(["p02"]);
    expect(list.total).toBe(1);
    const terminal = list.items[0];
    expect(terminal?.status).toBe(SESSION_STATUS.INACTIVE);
    if (!(terminal?.startedAt && terminal.endedAt)) {
      throw new Error("expected a terminal row with both duration endpoints");
    }
    expect(terminal.endedAt.getTime() - terminal.startedAt.getTime()).toBe(
      7_200_000
    );
    expect(usage.totalSessions).toBe(1);
    expect(usage.totalEstimatedCost).toBe(0.75);
  });

  it("DT-02: competing terminal statuses leave the filtered analytics duration on the list cohort", async () => {
    const filters = {
      startDate: "2026-06-12T00:00:00.000Z",
      endDate: "2026-06-13T07:00:00.000Z",
      statuses: [SESSION_STATUS.INACTIVE],
      quality: "all",
    } as const;
    const list = await readParityResponse(durationHost.organizationId, {
      ...filters,
      limit: 25,
    });
    const analytics = await agentSessionsService.getAnalytics({
      organizationId: durationHost.organizationId,
      filters: agentSessionUsageQuerySchema.parse(filters),
    });
    const competing = await agentSessionsService.getAnalytics({
      organizationId: durationHost.organizationId,
      filters: agentSessionUsageQuerySchema.parse({ ...filters, statuses: [] }),
    });
    expect(list.items.map((item) => item.externalSessionId)).toEqual(["p02"]);
    expect(list.total).toBe(1);
    expect(analytics.byAgentType).toEqual([
      expect.objectContaining({
        agentType: "assistant",
        count: 1,
        avgDurationMs: 7_200_000,
      }),
    ]);
    expect(competing.byAgentType).toEqual([
      expect.objectContaining({
        agentType: "assistant",
        count: 2,
        avgDurationMs: 4_500_000,
      }),
    ]);
  });

  it("DT-22: status option counts relax only status while list and usage retain the selected cohort", async () => {
    const filters = {
      startDate: "2026-06-12T00:00:00.000Z",
      endDate: "2026-06-13T07:00:00.000Z",
      statuses: [SESSION_STATUS.INACTIVE],
      quality: "all",
    } as const;
    const list = await readParityResponse(durationHost.organizationId, {
      ...filters,
      limit: 25,
    });
    const usage = await agentSessionsService.getUsageSummary({
      organizationId: durationHost.organizationId,
      filters: agentSessionUsageQuerySchema.parse(filters),
    });
    const status = await buildAgentSessionStatusCounts({
      organizationId: durationHost.organizationId,
      filters: agentSessionUsageQuerySchema.parse(filters),
    });
    expect(list.items.map((item) => item.externalSessionId)).toEqual(["p02"]);
    expect(list.total).toBe(1);
    expect(usage.totalSessions).toBe(1);
    expect(usage.totalEstimatedCost).toBe(0.75);
    expect(usage.totalInputTokens).toBe(0);
    expect(status.total).toBe(2);
    expect(status.countsByStatus[SESSION_STATUS.INACTIVE]).toBe(1);
    expect(status.countsByStatus[SESSION_STATUS.ERROR]).toBe(1);
  });

  it("DT-12: analytics follows activity rather than start time in both counterfactual directions", async () => {
    const activityWindow = {
      startDate: "2026-06-12T10:30:00.000Z",
      endDate: "2026-06-12T11:30:00.000Z",
      statuses: [SESSION_STATUS.INACTIVE],
      quality: "all",
    } as const;
    const list = await readParityResponse(durationHost.organizationId, {
      ...activityWindow,
      limit: 25,
    });
    const analytics = await agentSessionsService.getAnalytics({
      organizationId: durationHost.organizationId,
      filters: agentSessionUsageQuerySchema.parse(activityWindow),
    });
    const relaxedStatus = await buildAgentSessionStatusCounts({
      organizationId: durationHost.organizationId,
      filters: agentSessionUsageQuerySchema.parse(activityWindow),
    });
    expect(list.items.map((item) => item.externalSessionId)).toEqual(["p02"]);
    expect(analytics.byAgentType).toEqual([
      expect.objectContaining({ count: 1, avgDurationMs: 7_200_000 }),
    ]);
    expect(relaxedStatus.total).toBe(1);
    expect(relaxedStatus.countsByStatus[SESSION_STATUS.INACTIVE]).toBe(1);

    const startOnlyWindow = {
      ...activityWindow,
      endDate: "2026-06-12T10:00:00.000Z",
      startDate: "2026-06-12T09:00:00.000Z",
    };
    expect(
      (
        await readParityResponse(durationHost.organizationId, {
          ...startOnlyWindow,
          limit: 25,
        })
      ).total
    ).toBe(0);
    expect(
      (
        await agentSessionsService.getAnalytics({
          organizationId: durationHost.organizationId,
          filters: agentSessionUsageQuerySchema.parse(startOnlyWindow),
        })
      ).byAgentType
    ).toEqual([]);
  });

  it("DT-03: a committed second-connection mutation stays outside a pinned Postgres snapshot", async () => {
    const snapshotHost = await seedParityHost(organizations, metricRows);
    const artifactId = snapshotHost.artifactIds.get("e2");
    if (!artifactId) {
      throw new Error("missing mutation-barrier row");
    }
    let releaseWriter: () => void = () => {
      throw new Error("writer barrier was not initialized");
    };
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    // Register this continuation outside the transaction's AsyncLocalStorage
    // scope so it acquires another committed connection while the reader holds
    // its RepeatableRead transaction open.
    const writer = writerGate.then(() =>
      withDb(async (db) => {
        const [connection] = await db.$queryRawUnsafe<{ pid: number }[]>(
          "SELECT pg_backend_pid() AS pid"
        );
        await db.sessionDetail.update({
          where: { artifactId },
          data: { turns: 1, inputTokens: 17 },
          select: { artifactId: true },
        });
        return connection?.pid;
      })
    );
    const where = {
      artifact: { is: { organizationId: snapshotHost.organizationId } },
      turns: { gt: 0 },
    };
    const observed = await withDb.tx(
      async (db) => {
        const [connection] = await db.$queryRawUnsafe<{ pid: number }[]>(
          "SELECT pg_backend_pid() AS pid"
        );
        const before = await db.sessionDetail.count({ where });
        releaseWriter();
        const writerPid = await writer;
        const after = await db.sessionDetail.count({ where });
        return { before, after, readerPid: connection?.pid, writerPid };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 15_000,
      }
    );
    const committed = await withDb((db) => db.sessionDetail.count({ where }));

    expect(observed.readerPid).not.toBe(observed.writerPid);
    expect(observed.before).toBe(3);
    expect(observed.after).toBe(3);
    expect(committed).toBe(4);
  }, 20_000);
});
