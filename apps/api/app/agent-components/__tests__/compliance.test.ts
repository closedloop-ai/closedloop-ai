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
  // Minimal stub of the enum the service reads for its case-insensitive
  // component-identity match; the mocked `findMany` ignores the `where`.
  Prisma: { QueryMode: { insensitive: "insensitive" } },
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

// A usage fixture describes one installed component that has real invocations.
// The batched read now runs as a GROUP BY over usage (returning distinct
// `{ agentComponentId, componentKind }` rows) followed by one keyed fetch of
// the owning components (`{ id, componentKey, name, computeTargetId }`). Each
// fixture yields both the group row and its component row, correlated by a
// synthetic `agentComponentId`. Defaults line up with the default
// `makeDistribution` catalog item ("Test Plugin", kind "plugin"), whose
// normalized identity is `test plugin`.
type UsageFixture = {
  computeTargetId: string;
  componentKind: string;
  componentKey: string | null;
  name: string | null;
  agentComponentId: string;
};

function makeUsageRow(
  computeTargetId: string,
  overrides: {
    componentKind?: string;
    componentKey?: string | null;
    name?: string | null;
    agentComponentId?: string;
  } = {}
): UsageFixture {
  const componentKind = overrides.componentKind ?? "plugin";
  const name = overrides.name === undefined ? "Test Plugin" : overrides.name;
  const componentKey =
    overrides.componentKey === undefined ? null : overrides.componentKey;
  return {
    computeTargetId,
    componentKind,
    componentKey,
    name,
    agentComponentId:
      overrides.agentComponentId ??
      `acid-${componentKind}-${componentKey ?? name ?? ""}-${computeTargetId}`,
  };
}

type UsageGroupRow = { agentComponentId: string; componentKind: string };
type ComponentRow = {
  id: string;
  componentKey: string | null;
  name: string | null;
  computeTargetId: string;
};

type MockDb = {
  distribution: { findMany: ReturnType<typeof vi.fn> };
  computeTarget: { findMany: ReturnType<typeof vi.fn> };
  agentComponentSessionUsage: { groupBy: ReturnType<typeof vi.fn> };
  agentComponent: { findMany: ReturnType<typeof vi.fn> };
};

function splitUsageFixtures(usageRows: UsageFixture[]): {
  groups: UsageGroupRow[];
  components: ComponentRow[];
} {
  const groups = new Map<string, UsageGroupRow>();
  const components = new Map<string, ComponentRow>();
  for (const row of usageRows) {
    groups.set(`${row.agentComponentId}\u0000${row.componentKind}`, {
      agentComponentId: row.agentComponentId,
      componentKind: row.componentKind,
    });
    components.set(row.agentComponentId, {
      id: row.agentComponentId,
      componentKey: row.componentKey,
      name: row.name,
      computeTargetId: row.computeTargetId,
    });
  }
  return {
    groups: Array.from(groups.values()),
    components: Array.from(components.values()),
  };
}

function makeUsageDb(usageRows: UsageFixture[]): {
  groupBy: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
} {
  const { groups, components } = splitUsageFixtures(usageRows);
  return {
    groupBy: vi.fn().mockResolvedValue(groups),
    findMany: vi.fn().mockResolvedValue(components),
  };
}

function installDb(params: {
  distributions: DistributionFixture[];
  computeTargets: { id: string }[];
  usageRows?: UsageFixture[];
}): void {
  const { distributions, computeTargets, usageRows = [] } = params;
  const usage = makeUsageDb(usageRows);

  const db: MockDb = {
    distribution: {
      findMany: vi.fn().mockResolvedValue(distributions),
    },
    computeTarget: {
      findMany: vi.fn().mockResolvedValue(computeTargets),
    },
    agentComponentSessionUsage: {
      groupBy: usage.groupBy,
    },
    agentComponent: {
      findMany: usage.findMany,
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
        usageRows: [makeUsageRow(TARGET_2)],
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
        // TARGET_1 has usage, TARGET_2 does not
        usageRows: [makeUsageRow(TARGET_1)],
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
        usageRows: [makeUsageRow(TARGET_1)],
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
        usageRows: [makeUsageRow(TARGET_1), makeUsageRow(TARGET_2)],
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
        // DIST_2's TARGET_1 is installed but has no usage
        agentComponentSessionUsage: {
          groupBy: vi.fn().mockResolvedValue([]),
        },
        agentComponent: { findMany: vi.fn().mockResolvedValue([]) },
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

  describe("limit caps display rows, not the scan (completeness)", () => {
    it("scans all distributions and reports total + truncated when gaps exceed limit", async () => {
      // Three distributions each with an all-targeting not-installed gap. A
      // limit of 2 must still SCAN all three (so nothing is silently dropped)
      // and report total=3, truncated=true — not an empty/short page that
      // reads as "compliant".
      const dists = ["dist-a", "dist-b", "dist-c"].map((id) =>
        makeDistribution({
          id,
          catalogItem: { name: id, targetKind: "plugin" },
          targetStatuses: [],
        })
      );
      installDb({
        distributions: dists,
        computeTargets: [{ id: TARGET_1 }],
      });

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 2,
      });

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.truncated).toBe(true);
    });

    it("does not set truncated when every gap fits in the page", async () => {
      installDb({
        distributions: [makeDistribution({ targetStatuses: [] })],
        computeTargets: [{ id: TARGET_1 }],
      });

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.truncated).toBe(false);
    });

    it("does not pass take:limit to the distribution query", async () => {
      const distributionFindMany = vi.fn().mockResolvedValue([]);
      const db: MockDb = {
        distribution: { findMany: distributionFindMany },
        computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
        agentComponentSessionUsage: {
          groupBy: vi.fn().mockResolvedValue([]),
        },
        agentComponent: { findMany: vi.fn().mockResolvedValue([]) },
      };
      mocks.withDb.mockImplementation((callback: (db: MockDb) => unknown) =>
        callback(db)
      );

      await complianceService.getCompliance({ organizationId: ORG, limit: 10 });

      const callArg = distributionFindMany.mock.calls[0]?.[0] as
        | { take?: number }
        | undefined;
      expect(callArg?.take).toBeUndefined();
    });
  });

  describe("batched usage read (FEA-4024, no N+1)", () => {
    it("resolves installed-but-unused for every distribution with ONE usage query", async () => {
      // Only Plugin A's TARGET_1 has a matching usage row; the single batched
      // GROUP BY returns the whole distinct set and the service attributes each
      // row to its (kind, normalized-name, target) identity in memory.
      const usage = makeUsageDb([makeUsageRow(TARGET_1, { name: "Plugin A" })]);
      const db: MockDb = {
        distribution: {
          findMany: vi.fn().mockResolvedValue([
            makeDistribution({
              id: DIST_1,
              catalogItem: { name: "Plugin A", targetKind: "plugin" },
              targetStatuses: [
                { computeTargetId: TARGET_1, status: "installed" },
                { computeTargetId: TARGET_2, status: "installed" },
              ],
            }),
            makeDistribution({
              id: DIST_2,
              catalogItem: { name: "Plugin B", targetKind: "plugin" },
              targetStatuses: [
                { computeTargetId: TARGET_1, status: "installed" },
                { computeTargetId: TARGET_2, status: "installed" },
              ],
            }),
          ]),
        },
        computeTarget: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: TARGET_1 }, { id: TARGET_2 }]),
        },
        agentComponentSessionUsage: { groupBy: usage.groupBy },
        agentComponent: { findMany: usage.findMany },
      };
      mocks.withDb.mockImplementation((callback: (db: MockDb) => unknown) =>
        callback(db)
      );

      const result = await complianceService.getCompliance({
        organizationId: ORG,
        limit: 50,
      });

      // Two distributions, but only ONE usage GROUP BY — the N+1 is gone.
      expect(usage.groupBy).toHaveBeenCalledTimes(1);

      const pluginA = result.items.find(
        (i) => i.catalogItemName === "Plugin A"
      );
      const pluginB = result.items.find(
        (i) => i.catalogItemName === "Plugin B"
      );
      // Plugin A: TARGET_1 used, TARGET_2 unused.
      expect(pluginA?.installedButUnusedCount).toBe(1);
      // Plugin B: no row matches its identity → both installed targets unused.
      expect(pluginB?.installedButUnusedCount).toBe(2);
    });

    it("skips the usage query entirely when no targets are installed", async () => {
      const usage = makeUsageDb([]);
      const db: MockDb = {
        distribution: {
          findMany: vi
            .fn()
            .mockResolvedValue([makeDistribution({ targetStatuses: [] })]),
        },
        computeTarget: {
          findMany: vi.fn().mockResolvedValue([{ id: TARGET_1 }]),
        },
        agentComponentSessionUsage: { groupBy: usage.groupBy },
        agentComponent: { findMany: usage.findMany },
      };
      mocks.withDb.mockImplementation((callback: (db: MockDb) => unknown) =>
        callback(db)
      );

      await complianceService.getCompliance({ organizationId: ORG, limit: 50 });

      expect(usage.groupBy).not.toHaveBeenCalled();
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
