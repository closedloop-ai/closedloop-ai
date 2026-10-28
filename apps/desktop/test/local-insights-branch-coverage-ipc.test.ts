import {
  type DeliveryInsightsResponse,
  InsightsTileAvailabilityState,
} from "@closedloop-ai/loops-api/insights";
import { BranchCoverageBucketKey } from "@closedloop-ai/loops-api/insights-branch-coverage";
import { InsightsPeriod, InsightsSection } from "@repo/api/src/types/insights";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import { registerLocalDashboardReadIpcHandlers } from "../src/main/dashboard/agent-dashboard-local-read-ipc.js";
import {
  type BranchListSnapshotRequest,
  readBranchListSnapshot,
} from "../src/main/database/branch-list-snapshot-read.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { AgentDashboardDbIpcChannel } from "../src/shared/agent-dashboard-db-ipc-channel.js";
import { type AcDb, seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  return { ...stub, default: stub.default };
});

/**
 * ISS-12256 — the production Local-mode Dashboard read: the registered
 * `GetInsights` handler fills the Delivery Branch coverage chart through the
 * Local Branches page's own read, which reaches the db-host's
 * `branches.listSnapshot` store op, and leaves every other section as the
 * db-host built it.
 */

const EVENT = { sender: {} };
const LIST_SNAPSHOT_OP = "branches.listSnapshot";

afterEach(() => {
  resetElectronModuleStub();
});

describe("Local Dashboard GetInsights handler (ISS-12256)", () => {
  it("fills Branch coverage on the Delivery section through the list snapshot", () =>
    withAcDb(async (db) => {
      await seedBranch(db);
      const invokeStoreOp = snapshotStoreOp(db);
      register(
        db,
        vi.fn(async () => emptyDelivery()),
        invokeStoreOp
      );

      const result = (await invokeInsights(
        InsightsSection.Delivery
      )) as DeliveryInsightsResponse;

      expect(invokeStoreOp).toHaveBeenCalledWith(
        LIST_SNAPSHOT_OP,
        expect.any(Array)
      );
      expect(result.charts.branchesWithoutPr).toEqual([
        expect.objectContaining({
          key: BranchCoverageBucketKey.HasPullRequest,
          value: 0,
        }),
        expect.objectContaining({
          key: BranchCoverageBucketKey.NoPullRequest,
          value: 1,
        }),
      ]);
      expect(result.tileAvailability?.["chart:branchesWithoutPr"]).toBe(
        InsightsTileAvailabilityState.Available
      );
    }));

  it("returns another section exactly as the db-host built it", () =>
    withAcDb(async (db) => {
      const agents = { kpis: [], charts: {} };
      const invokeStoreOp = snapshotStoreOp(db);
      register(
        db,
        vi.fn(async () => agents),
        invokeStoreOp
      );

      expect(await invokeInsights(InsightsSection.Agents)).toBe(agents);
      expect(invokeStoreOp).not.toHaveBeenCalled();
    }));
});

async function seedBranch(db: AcDb): Promise<void> {
  const seed = seeder(db);
  await seed.session("s1");
  const artifactId = await seed.branch({
    branch: "feature/x",
    firstPushedAt: "2026-06-18T10:00:00.000Z",
  });
  await seed.link({ session: "s1", artifactId, method: "git_push" });
}

function snapshotStoreOp(db: AcDb) {
  return vi.fn(async (_name: string, args?: unknown[]) =>
    readBranchListSnapshot(db.prisma, args?.[0] as BranchListSnapshotRequest)
  );
}

function register(
  db: AcDb,
  getInsights: (...args: unknown[]) => Promise<unknown>,
  invokeStoreOp: (name: string, args?: unknown[]) => Promise<unknown>
) {
  const agentDatabase = {
    prisma: db.prisma,
    readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
    readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
    syncSource: db.syncSource,
    dashboard: { getInsights },
  } as unknown as DbHostAgentDatabase;
  const withDb: WithDb =
    (handler) =>
    (_event, ...args) =>
      Promise.resolve(handler(agentDatabase, ...args));
  registerLocalDashboardReadIpcHandlers({ withDb, invokeStoreOp });
}

function invokeInsights(section: InsightsSection): Promise<unknown> {
  return Promise.resolve(
    registeredInvokeHandler(AgentDashboardDbIpcChannel.GetInsights)(
      EVENT,
      section,
      InsightsPeriod.All,
      undefined
    )
  );
}

function emptyDelivery(): DeliveryInsightsResponse {
  const unavailable = InsightsTileAvailabilityState.Unavailable;
  return {
    kpis: [],
    tileAvailability: { "chart:branchesWithoutPr": unavailable },
    charts: {
      prTrend: { series: [], points: [] },
      prByRepo: [],
      meanTimeToMerge: [],
      prByState: [],
      branchLifespan: [],
      branchesWithoutPr: [],
    },
  };
}
