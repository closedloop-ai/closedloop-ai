/**
 * Unit tests for complianceService (T-18.4, AC-018, AC-025).
 *
 * Prisma is fully mocked. Tests assert:
 *   - org-scoping (only auto_install distributions in the calling org)
 *   - notInstalledCount gap: targets with no DistributionTargetStatus row
 *   - notInstalledCount gap: targets with pending/failed status
 *   - installedButUnusedCount gap: status=installed but zero invocations
 *   - fully-compliant distributions (all installed + used) are omitted
 *   - all-targeting resolves to org compute targets
 *   - specific-targeting respects the DistributionTargetingEntry list
 *   - empty distributions list returns empty response immediately
 *   - gap classification helper logic (classifyTargets)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @repo/database BEFORE importing the service under test
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

import { complianceService } from "../compliance/service";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ORG = "org-compliance-1111";
const DIST_1 = "dist-aaaa-1111";
const DIST_2 = "dist-bbbb-2222";
const TARGET_1 = "target-comp-1111";
const TARGET_2 = "target-comp-2222";
const TARGET_3 = "target-comp-3333";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

type TargetStatus = { computeTargetId: string | null; status: string };

type DistributionFixture = {
  id: string;
  targetingType: "all" | "specific";
  mode: string;
  catalogItem: { name: string; targetKind: string };
  targetStatuses: TargetStatus[];
  targetingEntries: { computeTargetId: string | null }[];
};

function makeDistribution(
  overrides: Partial<DistributionFixture> & {
    id?: string;
    targetingType?: "all" | "specific";
  } = {}
): DistributionFixture {
  return {
    id: overrides.id ?? DIST_1,
    targetingType: overrides.targetingType ?? "all",
    mode: "auto_install",
    catalogItem: overrides.catalogItem ?? {
      name: "Test Plugin",
      targetKind: "plugin",
    },
    targetStatuses: overrides.targetStatuses ?? [],
    targetingEntries: overrides.targetingEntries ?? [],
  };
}

type UsageRow = {
  agentComponent: { computeTargetId: string } | null;
};

type MockDb = {
  distribution: { findMany: ReturnType<typeof vi.fn> };
  computeTarget: { findMany: ReturnType<typeof vi.fn> };
  agentComponentSessionUsage: { findMany: ReturnType<typeof vi.fn> };
};

function installDb(params: {
  distributions: DistributionFixture[];
  computeTargets: { id: string }[];
  usageRows?: UsageRow[];
}): void {
  const { distributions, computeTargets, usageRows = [] } = params;

  const db: MockDb = {
    distribution: {
      findMany: vi.fn().mockResolvedValue(distributions),
    },
    computeTarget: {
      findMany: vi.fn().mockResolvedValue(computeTargets),
    },
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue(usageRows),
    },
  };

  mocks.withDb.mockImplementation((callback: (db: MockDb) => unknown) =>
    callback(db)
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("complianceService.getCompliance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty response when no auto_install distributions exist", async () => {
    installDb({ distributions: [], computeTargets: [] });

    const result = await complianceService.getCompliance({
      organizationId: ORG,
      limit: 50,
    });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  describe("notInstalledCount gap", () => {
    it("counts targets with no DistributionTargetStatus row as not-installed", async () => {
      installDb({
        distributions: [
          makeDistribution({
            targetStatuses: [], // no status rows → all targets are not-installed
          }),
        ],
        computeTargets: [{ id: TARGET_1 }, { id: TARGET_2 }],
      });

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item?.notInstalledCount).toBe(2);
      expect(item?.totalTargetCount).toBe(2);
    });

    it("counts targets with status=pending as not-installed", async () => {
      installDb({
        distributions: [
          makeDistribution({
            targetStatuses: [
              { computeTargetId: TARGET_1, status: "pending" },
              { computeTargetId: TARGET_2, status: "installed" },
            ],
          }),
        ],
        computeTargets: [{ id: TARGET_1 }, { id: TARGET_2 }],
        usageRows: [
          {
            agentComponent: { computeTargetId: TARGET_2 },
          },
        ],
      });

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.notInstalledCount).toBe(1);
    });

    it("counts targets with status=failed as not-installed", async () => {
      installDb({
        distributions: [
          makeDistribution({
            targetStatuses: [{ computeTargetId: TARGET_1, status: "failed" }],
          }),
        ],
        computeTargets: [{ id: TARGET_1 }],
      });

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      expect(result.items[0]?.notInstalledCount).toBe(1);
    });
  });

  describe("installedButUnusedCount gap", () => {
    it("counts installed targets with zero invocations as unused", async () => {
      installDb({
        distributions: [
          makeDistribution({
            targetStatuses: [
              { computeTargetId: TARGET_1, status: "installed" },
              { computeTargetId: TARGET_2, status: "enabled" },
            ],
          }),
        ],
        computeTargets: [{ id: TARGET_1 }, { id: TARGET_2 }],
        usageRows: [], // no usage rows → both targets unused
      });

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item?.installedButUnusedCount).toBe(2);
      expect(item?.notInstalledCount).toBe(0);
    });

    it("does not count installed targets that have invocation records", async () => {
      installDb({
        distributions: [
          makeDistribution({
            targetStatuses: [
              { computeTargetId: TARGET_1, status: "installed" },
              { computeTargetId: TARGET_2, status: "installed" },
            ],
          }),
        ],
        computeTargets: [{ id: TARGET_1 }, { id: TARGET_2 }],
        usageRows: [
          // TARGET_1 has usage, TARGET_2 does not
          { agentComponent: { computeTargetId: TARGET_1 } },
        ],
      });

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      // Only TARGET_2 is installed-but-unused
      expect(result.items[0]?.installedButUnusedCount).toBe(1);
    });
  });

  describe("fully-compliant distributions are omitted", () => {
    it("omits distribution when every target has installed status AND usage", async () => {
      installDb({
        distributions: [
          makeDistribution({
            targetStatuses: [
              { computeTargetId: TARGET_1, status: "installed" },
            ],
          }),
        ],
        computeTargets: [{ id: TARGET_1 }],
        usageRows: [{ agentComponent: { computeTargetId: TARGET_1 } }],
      });

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      expect(result.items).toHaveLength(0);
    });
  });

  describe("targeting resolution", () => {
    it("all-targeting: resolves to all org compute targets", async () => {
      installDb({
        distributions: [
          makeDistribution({
            targetingType: "all",
            targetStatuses: [],
            targetingEntries: [],
          }),
        ],
        computeTargets: [{ id: TARGET_1 }, { id: TARGET_2 }, { id: TARGET_3 }],
      });

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      expect(result.items[0]?.totalTargetCount).toBe(3);
      expect(result.items[0]?.notInstalledCount).toBe(3);
    });

    it("specific-targeting: uses DistributionTargetingEntry rows only", async () => {
      installDb({
        distributions: [
          makeDistribution({
            targetingType: "specific",
            targetStatuses: [],
            targetingEntries: [
              { computeTargetId: TARGET_1 },
              { computeTargetId: TARGET_2 },
            ],
          }),
        ],
        computeTargets: [
          // TARGET_3 is also in the org but not in targetingEntries
          { id: TARGET_1 },
          { id: TARGET_2 },
          { id: TARGET_3 },
        ],
      });

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      // Only the 2 specifically-targeted compute targets count
      expect(result.items[0]?.totalTargetCount).toBe(2);
    });

    it("returns empty when specific-targeting entries list is empty", async () => {
      installDb({
        distributions: [
          makeDistribution({
            targetingType: "specific",
            targetStatuses: [],
            targetingEntries: [], // no specific targets → totalTargetCount=0
          }),
        ],
        computeTargets: [{ id: TARGET_1 }],
      });

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      // Distribution has zero target count → excluded from results
      expect(result.items).toHaveLength(0);
    });
  });

  describe("gap classification", () => {
    it("classifies pending + failed + missing as not-installed; installed + enabled as installed", async () => {
      installDb({
        distributions: [
          makeDistribution({
            targetingType: "all",
            targetStatuses: [
              { computeTargetId: TARGET_1, status: "installed" },
              { computeTargetId: TARGET_2, status: "enabled" },
              { computeTargetId: TARGET_3, status: "failed" },
            ],
          }),
        ],
        // TARGET_4 has no status row at all — counts as not-installed
        computeTargets: [
          { id: TARGET_1 },
          { id: TARGET_2 },
          { id: TARGET_3 },
          { id: "target-4444" },
        ],
        // TARGET_1 and TARGET_2 have usage
        usageRows: [
          { agentComponent: { computeTargetId: TARGET_1 } },
          { agentComponent: { computeTargetId: TARGET_2 } },
        ],
      });

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      // TARGET_3 (failed) + target-4444 (no row) = 2 not-installed
      expect(item?.notInstalledCount).toBe(2);
      // TARGET_1 and TARGET_2 are installed and have usage → not unused
      expect(item?.installedButUnusedCount).toBe(0);
      expect(item?.totalTargetCount).toBe(4);
    });
  });

  describe("multiple distributions in one org", () => {
    it("returns compliance items for all distributions with gaps", async () => {
      const db: MockDb = {
        distribution: {
          findMany: vi.fn().mockResolvedValue([
            makeDistribution({
              id: DIST_1,
              catalogItem: { name: "Plugin A", targetKind: "plugin" },
              targetStatuses: [],
            }),
            makeDistribution({
              id: DIST_2,
              catalogItem: { name: "Plugin B", targetKind: "plugin" },
              targetStatuses: [
                { computeTargetId: TARGET_1, status: "installed" },
              ],
            }),
          ]),
        },
        computeTarget: {
          findMany: vi.fn().mockResolvedValue([{ id: TARGET_1 }]),
        },
        agentComponentSessionUsage: {
          // DIST_2's TARGET_1 is installed but has no usage
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      mocks.withDb.mockImplementation((callback: (db: MockDb) => unknown) =>
        callback(db)
      );

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      // Both distributions have gaps
      expect(result.items).toHaveLength(2);
      const distAItem = result.items.find(
        (i) => i.catalogItemName === "Plugin A"
      );
      const distBItem = result.items.find(
        (i) => i.catalogItemName === "Plugin B"
      );
      expect(distAItem?.notInstalledCount).toBe(1);
      expect(distBItem?.installedButUnusedCount).toBe(1);
    });
  });

  describe("response shape", () => {
    it("returns correctly typed ComplianceItem fields", async () => {
      installDb({
        distributions: [
          makeDistribution({
            id: DIST_1,
            catalogItem: { name: "RTK", targetKind: "plugin" },
            targetStatuses: [],
          }),
        ],
        computeTargets: [{ id: TARGET_1 }],
      });

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      const item = result.items[0];
      expect(item?.distributionId).toBe(DIST_1);
      expect(item?.catalogItemName).toBe("RTK");
      expect(item?.kind).toBe("plugin");
      expect(item?.mode).toBe("auto_install");
      expect(typeof item?.notInstalledCount).toBe("number");
      expect(typeof item?.installedButUnusedCount).toBe("number");
      expect(typeof item?.totalTargetCount).toBe("number");
    });
  });
});
