/**
 * T-18.3: Distribution unit tests.
 *
 * Tests:
 * - create: all-targeting inserts no DistributionTargetingEntry rows; specific-targeting
 *   inserts entries for each target.
 * - update: mode and targeting updated correctly.
 * - promote: POST /agent-components/promote creates CatalogItem + Distribution targeting
 *   all in one transaction; assert 403 for non-admin.
 * - getAssigned: returns distributions for compute target (all-targeting matches all;
 *   specific-targeting matches only targeted target).
 * - upsertStatusReport: upserts DistributionTargetStatus rows; second call updates not
 *   duplicates.
 *
 * AC-016, AC-017, AC-025
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that trigger the modules.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  isOrgAdmin: vi.fn(),
  computeTargetsService: {
    findOwnedById: vi.fn(),
  },
  getCatalogAssetDownloadUrl: vi.fn(),
  awsKeys: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  // Minimal tagged-template stand-in for Prisma.sql so the raw
  // INSERT ... ON CONFLICT upsert builds without a live client. Captures the
  // literal SQL chunks and interpolated values so tests can assert on both.
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: Array.from(strings),
      values,
    }),
  },
}));

vi.mock("@repo/aws", () => ({
  getCatalogAssetDownloadUrl: mocks.getCatalogAssetDownloadUrl,
}));

vi.mock("@repo/aws/keys", () => ({
  keys: mocks.awsKeys,
}));

vi.mock("@/lib/auth/org-admin", () => ({
  isOrgAdmin: mocks.isOrgAdmin,
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: mocks.computeTargetsService,
}));

import {
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { distributionsService } from "../service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function installDb(db: Record<string, unknown>) {
  const dbWithDefaults = {
    distribution: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(null),
    },
    distributionTargetingEntry: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    distributionTargetStatus: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue(null),
    },
    catalogItem: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    // Advisory-lock acquisition in the status-report upsert transaction.
    $executeRaw: vi.fn().mockResolvedValue(1),
    ...db,
  };

  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );

  return dbWithDefaults;
}

const NOW = new Date("2026-07-01T00:00:00.000Z");

function buildCatalogItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    name: "My Plugin",
    targetKind: "plugin",
    source: "org_custom",
    coaching: false,
    ...overrides,
  };
}

function buildDistributionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dist-1",
    organizationId: "org-1",
    catalogItemId: "item-1",
    mode: DistributionMode.AutoInstall,
    targetingType: DistributionTargetingType.All,
    desiredEnabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    catalogItem: buildCatalogItemRow(),
    targetingEntries: [],
    targetStatuses: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// distributionsService.create
// ---------------------------------------------------------------------------

describe("distributionsService.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.awsKeys.mockReturnValue({ PLUGIN_STORE_BUCKET: "test-bucket" });
  });

  it("returns 403 when caller is not an org admin", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);
    installDb({});

    const result = await distributionsService.create(
      "org-1",
      "user-1",
      "clerk-org-1",
      "clerk-user-1",
      {
        catalogItemId: "item-1",
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
      }
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(403);
  });

  it("returns 400 when catalogItemId does not belong to the org", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    installDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await distributionsService.create(
      "org-1",
      "user-1",
      "clerk-org-1",
      "clerk-user-1",
      {
        catalogItemId: "nonexistent-item",
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
      }
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(400);
  });

  it("creates distribution with no targeting entries for all-targeting", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    const distributionRow = buildDistributionRow({
      targetingType: DistributionTargetingType.All,
      targetingEntries: [],
    });
    const distributionCreate = vi.fn().mockResolvedValue(distributionRow);

    installDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({ id: "item-1" }),
      },
      distribution: {
        create: distributionCreate,
      },
    });

    const result = await distributionsService.create(
      "org-1",
      "user-1",
      "clerk-org-1",
      "clerk-user-1",
      {
        catalogItemId: "item-1",
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
      }
    );

    expect(result.ok).toBe(true);
    // all-targeting: no targetingEntries key in data (or empty create array)
    const callData = distributionCreate.mock.calls[0][0].data;
    expect(callData.targetingEntries).toBeUndefined();
    expect(result.ok && result.value.targetingEntries).toHaveLength(0);
  });

  it("creates DistributionTargetingEntry rows for specific-targeting with compute targets", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    const distributionRow = buildDistributionRow({
      targetingType: DistributionTargetingType.Specific,
      targetingEntries: [
        { computeTargetId: "ct-1", userId: null },
        { computeTargetId: "ct-2", userId: null },
      ],
    });
    const distributionCreate = vi.fn().mockResolvedValue(distributionRow);

    installDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({ id: "item-1" }),
      },
      distribution: {
        create: distributionCreate,
      },
    });

    const result = await distributionsService.create(
      "org-1",
      "user-1",
      "clerk-org-1",
      "clerk-user-1",
      {
        catalogItemId: "item-1",
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.Specific,
        targetComputeTargetIds: ["ct-1", "ct-2"],
      }
    );

    expect(result.ok).toBe(true);
    const callData = distributionCreate.mock.calls[0][0].data;
    expect(callData.targetingEntries.create).toHaveLength(2);
    expect(callData.targetingEntries.create).toContainEqual({
      computeTargetId: "ct-1",
      userId: null,
    });
    expect(callData.targetingEntries.create).toContainEqual({
      computeTargetId: "ct-2",
      userId: null,
    });
  });

  it("creates DistributionTargetingEntry rows for specific-targeting with user IDs", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    const distributionRow = buildDistributionRow({
      targetingType: DistributionTargetingType.Specific,
      targetingEntries: [
        { computeTargetId: null, userId: "user-a" },
        { computeTargetId: null, userId: "user-b" },
      ],
    });
    const distributionCreate = vi.fn().mockResolvedValue(distributionRow);

    installDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({ id: "item-1" }),
      },
      distribution: {
        create: distributionCreate,
      },
    });

    const result = await distributionsService.create(
      "org-1",
      "user-1",
      "clerk-org-1",
      "clerk-user-1",
      {
        catalogItemId: "item-1",
        mode: DistributionMode.OptIn,
        targetingType: DistributionTargetingType.Specific,
        targetUserIds: ["user-a", "user-b"],
      }
    );

    expect(result.ok).toBe(true);
    const callData = distributionCreate.mock.calls[0][0].data;
    expect(callData.targetingEntries.create).toHaveLength(2);
    expect(callData.targetingEntries.create).toContainEqual({
      computeTargetId: null,
      userId: "user-a",
    });
  });

  it("mixes compute target and user targeting entries in one create call", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    const distributionRow = buildDistributionRow({
      targetingType: DistributionTargetingType.Specific,
      targetingEntries: [
        { computeTargetId: "ct-1", userId: null },
        { computeTargetId: null, userId: "user-a" },
      ],
    });
    const distributionCreate = vi.fn().mockResolvedValue(distributionRow);

    installDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({ id: "item-1" }),
      },
      distribution: {
        create: distributionCreate,
      },
    });

    const result = await distributionsService.create(
      "org-1",
      "user-1",
      "clerk-org-1",
      "clerk-user-1",
      {
        catalogItemId: "item-1",
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.Specific,
        targetComputeTargetIds: ["ct-1"],
        targetUserIds: ["user-a"],
      }
    );

    expect(result.ok).toBe(true);
    const callData = distributionCreate.mock.calls[0][0].data;
    expect(callData.targetingEntries.create).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// distributionsService.update
// ---------------------------------------------------------------------------

describe("distributionsService.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.awsKeys.mockReturnValue({ PLUGIN_STORE_BUCKET: "test-bucket" });
  });

  it("returns 403 when caller is not an org admin", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);
    installDb({});

    const result = await distributionsService.update(
      "org-1",
      "dist-1",
      "clerk-org-1",
      "clerk-user-1",
      { mode: DistributionMode.OptIn }
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(403);
  });

  it("returns 404 when distribution does not belong to the org", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    installDb({
      distribution: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await distributionsService.update(
      "org-1",
      "nonexistent-dist",
      "clerk-org-1",
      "clerk-user-1",
      { mode: DistributionMode.OptIn }
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(404);
  });

  it("updates mode without rebuilding targeting entries when only mode changes", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    const updatedRow = buildDistributionRow({ mode: DistributionMode.OptIn });
    const distributionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const distributionFindFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: "dist-1",
        targetingType: DistributionTargetingType.All,
      })
      .mockResolvedValueOnce(updatedRow);
    const entryDeleteMany = vi.fn().mockResolvedValue({ count: 0 });

    installDb({
      distribution: {
        findFirst: distributionFindFirst,
        updateMany: distributionUpdateMany,
      },
      distributionTargetingEntry: {
        deleteMany: entryDeleteMany,
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    const result = await distributionsService.update(
      "org-1",
      "dist-1",
      "clerk-org-1",
      "clerk-user-1",
      { mode: DistributionMode.OptIn }
    );

    expect(result.ok).toBe(true);
    // Simple update: no tx, no entry rebuild
    expect(entryDeleteMany).not.toHaveBeenCalled();
    // ISS-5123: the live predicate rides on the WRITE, not on a prior read.
    expect(distributionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mode: DistributionMode.OptIn }),
        where: { id: "dist-1", organizationId: "org-1", withdrawnAt: null },
      })
    );
  });

  it("rebuilds targeting entries when targetingType changes to specific", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    const updatedRow = buildDistributionRow({
      targetingType: DistributionTargetingType.Specific,
      targetingEntries: [{ computeTargetId: "ct-3", userId: null }],
    });
    const entryDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const entryCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const txDb = {
      distribution: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(updatedRow),
      },
      distributionTargetingEntry: {
        deleteMany: entryDeleteMany,
        createMany: entryCreateMany,
      },
    };

    const outerFindFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: "dist-1",
        targetingType: DistributionTargetingType.All,
      })
      .mockResolvedValueOnce(updatedRow);

    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        ...txDb,
        distribution: {
          findFirst: outerFindFirst,
          updateMany: txDb.distribution.updateMany,
        },
      })
    );
    mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(txDb)
    );

    const result = await distributionsService.update(
      "org-1",
      "dist-1",
      "clerk-org-1",
      "clerk-user-1",
      {
        targetingType: DistributionTargetingType.Specific,
        targetComputeTargetIds: ["ct-3"],
      }
    );

    expect(result.ok).toBe(true);
    expect(entryDeleteMany).toHaveBeenCalledWith({
      where: { distributionId: "dist-1" },
    });
    expect(entryCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ computeTargetId: "ct-3" }),
        ]),
      })
    );
  });

  it("deletes targeting entries when switching from specific to all", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    const updatedRow = buildDistributionRow({
      targetingType: DistributionTargetingType.All,
      targetingEntries: [],
    });
    const entryDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const entryCreateMany = vi.fn();
    const txDb = {
      distribution: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(updatedRow),
      },
      distributionTargetingEntry: {
        deleteMany: entryDeleteMany,
        createMany: entryCreateMany,
      },
    };

    const outerFindFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: "dist-1",
        targetingType: DistributionTargetingType.Specific,
      })
      .mockResolvedValueOnce(updatedRow);

    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ distribution: { findFirst: outerFindFirst } })
    );
    mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(txDb)
    );

    const result = await distributionsService.update(
      "org-1",
      "dist-1",
      "clerk-org-1",
      "clerk-user-1",
      { targetingType: DistributionTargetingType.All }
    );

    expect(result.ok).toBe(true);
    // Old specific entries removed, no new entries created
    expect(entryDeleteMany).toHaveBeenCalledWith({
      where: { distributionId: "dist-1" },
    });
    expect(entryCreateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------
// The promote endpoint lives in apps/api/app/agent-components/promote/route.ts
// and uses `withDb.tx` directly (not distributionsService). Its behaviour — the
// admin gate, the 404 for an unknown component, and the atomic
// CatalogItem+Distribution create — is exercised end-to-end against the real
// route handler in apps/api/__tests__/api/promote.test.ts (not simulated here).
//
// NOTE: the focused suites for this service live in sibling files to keep
// this grandfathered file on its shrink-only ratchet (biome.jsonc):
//   - `distributionsService.getAssignedForTarget` -> `get-assigned-for-target.test.ts` (FEA-4190)
//   - `distributionsService.upsertStatusReports`   -> `upsert-status-reports.test.ts` (FEA-4193)
