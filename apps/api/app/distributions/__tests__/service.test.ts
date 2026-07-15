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
  DistributionTargetStatusValue,
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
    const updatedRow = buildDistributionRow({
      mode: DistributionMode.OptIn,
    });
    const distributionUpdate = vi.fn().mockResolvedValue(updatedRow);
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
        update: distributionUpdate,
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
    expect(distributionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "dist-1" },
        data: expect.objectContaining({ mode: DistributionMode.OptIn }),
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
        update: vi.fn().mockResolvedValue(updatedRow),
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
          update: txDb.distribution.update,
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
        update: vi.fn().mockResolvedValue(updatedRow),
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

// ---------------------------------------------------------------------------
// distributionsService.getAssignedForTarget
// ---------------------------------------------------------------------------

describe("distributionsService.getAssignedForTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.awsKeys.mockReturnValue({ PLUGIN_STORE_BUCKET: "test-bucket" });
    mocks.getCatalogAssetDownloadUrl.mockResolvedValue(
      "https://s3.example.com/asset.zip"
    );
  });

  it("returns distributions with all-targeting for any compute target", async () => {
    const allTargetingRow = buildDistributionRow({
      targetingType: DistributionTargetingType.All,
      catalogItem: {
        ...buildCatalogItemRow(),
        zipAssetBucket: null,
        zipAssetKey: null,
      },
    });

    installDb({
      distribution: {
        findMany: vi.fn().mockResolvedValue([allTargetingRow]),
      },
    });

    const results = await distributionsService.getAssignedForTarget(
      "org-1",
      "ct-any",
      "user-any"
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("dist-1");
    expect(results[0]?.targetingType).toBe(DistributionTargetingType.All);
  });

  it("returns distributions with specific-targeting when compute target matches", async () => {
    const specificRow = buildDistributionRow({
      targetingType: DistributionTargetingType.Specific,
      targetingEntries: [{ computeTargetId: "ct-target", userId: null }],
      catalogItem: {
        ...buildCatalogItemRow(),
        zipAssetBucket: null,
        zipAssetKey: null,
      },
    });

    installDb({
      distribution: {
        findMany: vi.fn().mockResolvedValue([specificRow]),
      },
    });

    const results = await distributionsService.getAssignedForTarget(
      "org-1",
      "ct-target",
      "user-1"
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.targetingType).toBe(DistributionTargetingType.Specific);
  });

  it("returns empty array when no distributions match the compute target", async () => {
    installDb({
      distribution: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const results = await distributionsService.getAssignedForTarget(
      "org-1",
      "ct-unmatched",
      "user-1"
    );

    expect(results).toHaveLength(0);
  });

  it("attaches presigned download URL signed against the persisted plugin-store bucket for auto_install distributions", async () => {
    // The persisted zipAssetBucket is the PLUGIN_STORE_BUCKET written by
    // confirmAssetUpload; the download URL must be signed against it (not the
    // FILE_ATTACHMENTS_BUCKET default of the generic getSignedDownloadUrl).
    const autoInstallRow = buildDistributionRow({
      mode: DistributionMode.AutoInstall,
      catalogItem: {
        ...buildCatalogItemRow(),
        zipAssetBucket: "plugin-store-bucket",
        zipAssetKey: "org/org-1/catalog/item-1/zip",
      },
    });

    installDb({
      distribution: {
        findMany: vi.fn().mockResolvedValue([autoInstallRow]),
      },
    });

    const results = await distributionsService.getAssignedForTarget(
      "org-1",
      "ct-1",
      "user-1"
    );

    expect(results).toHaveLength(1);
    // The URL is non-null: the persisted bucket + key make the guard pass.
    expect(results[0]?.assetDownloadUrl).toBe(
      "https://s3.example.com/asset.zip"
    );
    // Signed via the catalog helper (PLUGIN_STORE_BUCKET-aware), passing the
    // persisted bucket explicitly.
    expect(mocks.getCatalogAssetDownloadUrl).toHaveBeenCalledWith(
      "org/org-1/catalog/item-1/zip",
      expect.objectContaining({ bucket: "plugin-store-bucket" })
    );
  });

  it("returns null asset URL when the zip bucket was never persisted (unconfirmed upload)", async () => {
    // Regression guard: if confirmAssetUpload failed to persist zipAssetBucket,
    // the guard short-circuits and no URL is produced — this must NOT silently
    // fall back to a default bucket.
    const autoInstallRow = buildDistributionRow({
      mode: DistributionMode.AutoInstall,
      catalogItem: {
        ...buildCatalogItemRow(),
        zipAssetBucket: null,
        zipAssetKey: "org/org-1/catalog/item-1/zip",
      },
    });

    installDb({
      distribution: {
        findMany: vi.fn().mockResolvedValue([autoInstallRow]),
      },
    });

    const results = await distributionsService.getAssignedForTarget(
      "org-1",
      "ct-1",
      "user-1"
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.assetDownloadUrl).toBeNull();
    expect(mocks.getCatalogAssetDownloadUrl).not.toHaveBeenCalled();
  });

  it("emits catalogItem.coaching === true for a coaching CatalogItem (drives the desktop coaching-install path)", async () => {
    // Regression guard (FEA-2923 A1): the assigned-distributions response the
    // desktop consumes must surface the CatalogItem `coaching` column so the
    // installer can route through installCoachingPackFromDistribution. Before
    // the fix the select omitted `coaching`, so the desktop always saw false
    // and the coaching-install path was dead.
    const coachingRow = buildDistributionRow({
      targetingType: DistributionTargetingType.All,
      catalogItem: {
        ...buildCatalogItemRow({ coaching: true }),
        zipAssetBucket: null,
        zipAssetKey: null,
      },
    });

    installDb({
      distribution: {
        findMany: vi.fn().mockResolvedValue([coachingRow]),
      },
    });

    const results = await distributionsService.getAssignedForTarget(
      "org-1",
      "ct-1",
      "user-1"
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.catalogItem.coaching).toBe(true);
  });

  it("emits catalogItem.coaching === false for a non-coaching CatalogItem", async () => {
    const nonCoachingRow = buildDistributionRow({
      targetingType: DistributionTargetingType.All,
      catalogItem: {
        ...buildCatalogItemRow({ coaching: false }),
        zipAssetBucket: null,
        zipAssetKey: null,
      },
    });

    installDb({
      distribution: {
        findMany: vi.fn().mockResolvedValue([nonCoachingRow]),
      },
    });

    const results = await distributionsService.getAssignedForTarget(
      "org-1",
      "ct-1",
      "user-1"
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.catalogItem.coaching).toBe(false);
  });

  it("does not attach download URL for opt_in distributions", async () => {
    const optInRow = buildDistributionRow({
      mode: DistributionMode.OptIn,
      catalogItem: {
        ...buildCatalogItemRow(),
        zipAssetBucket: "my-bucket",
        zipAssetKey: "org/org-1/catalog/item-1/zip",
      },
    });

    installDb({
      distribution: {
        findMany: vi.fn().mockResolvedValue([optInRow]),
      },
    });

    const results = await distributionsService.getAssignedForTarget(
      "org-1",
      "ct-1",
      "user-1"
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.assetDownloadUrl).toBeNull();
    expect(mocks.getCatalogAssetDownloadUrl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// distributionsService.upsertStatusReports
// ---------------------------------------------------------------------------

// Each report is applied with a single atomic raw
// `INSERT ... ON CONFLICT DO UPDATE` (see upsertOneStatusReport), so the tests
// assert on the captured `$executeRaw(Prisma.sql`...`)` fragment rather than on
// findFirst/create/updateMany call patterns.

// UUIDv7: the version nibble (13th hex digit) is `7` and the variant nibble is
// one of 8/9/a/b. Guards against a regression to gen_random_uuid()/UUIDv4.
const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type CapturedUpsert = {
  sql: string;
  id: unknown;
  distributionId: unknown;
  computeTargetId: unknown;
  userId: unknown;
  status: unknown;
  installedVersion: unknown;
  installRunId: unknown;
  failureReason: unknown;
  reportedAt: unknown;
  installedAt: unknown;
  enabledAt: unknown;
};

/**
 * Wire withDb (distribution ownership lookup) + withDb.tx with a capturing
 * `$executeRaw`, returning the mock so tests can assert per-report upsert calls.
 */
function installStatusReportDb(validDistributionIds: string[]) {
  const executeRaw = vi.fn().mockResolvedValue(1);
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      distribution: {
        findMany: vi
          .fn()
          .mockResolvedValue(validDistributionIds.map((id) => ({ id }))),
      },
    })
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({ $executeRaw: executeRaw })
  );
  return { executeRaw };
}

/**
 * The upsert calls on the capturing `$executeRaw` mock, in order. The service
 * calls `$executeRaw` twice per report: first the advisory lock (a plain tagged
 * template — `call[0]` is a `string[]`, the key is `call[1]`), then the atomic
 * upsert (`Prisma.sql` — `call[0]` is a `{ strings, values }` object). This
 * keeps only the upsert calls so tests can index them without counting locks.
 */
function upsertCalls(
  executeRaw: ReturnType<typeof vi.fn>
): { strings: string[]; values: unknown[] }[] {
  return executeRaw.mock.calls
    .map((call) => call[0])
    .filter(
      (arg): arg is { strings: string[]; values: unknown[] } =>
        !Array.isArray(arg) &&
        typeof arg === "object" &&
        arg !== null &&
        Array.isArray((arg as { values?: unknown }).values)
    );
}

/**
 * The advisory-lock keys taken on the capturing `$executeRaw` mock, in order.
 * The lock is a plain tagged template, so the key is the interpolated value at
 * `call[1]`; upsert calls (single `Prisma.sql` object arg) have no `call[1]`.
 */
function advisoryLockKeys(executeRaw: ReturnType<typeof vi.fn>): unknown[] {
  return executeRaw.mock.calls
    .filter((call) => Array.isArray(call[0]))
    .map((call) => call[1]);
}

/** Decode the Nth captured Prisma.sql upsert fragment into named fields. */
function captureUpsert(
  executeRaw: ReturnType<typeof vi.fn>,
  callIndex = 0
): CapturedUpsert {
  const fragment = upsertCalls(executeRaw)[callIndex] as {
    strings: string[];
    values: unknown[];
  };
  const [
    id,
    distributionId,
    computeTargetId,
    userId,
    status,
    installedVersion,
    installRunId,
    failureReason,
    reportedAt,
    installedAt,
    enabledAt,
  ] = fragment.values;
  return {
    sql: fragment.strings.join(""),
    id,
    distributionId,
    computeTargetId,
    userId,
    status,
    installedVersion,
    installRunId,
    failureReason,
    reportedAt,
    installedAt,
    enabledAt,
  };
}

describe("distributionsService.upsertStatusReports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.awsKeys.mockReturnValue({ PLUGIN_STORE_BUCKET: "test-bucket" });
    mocks.computeTargetsService.findOwnedById.mockResolvedValue({
      id: "ct-1",
      organizationId: "org-1",
      userId: "user-1",
    });
  });

  it("returns forbidden when compute target is not owned by the caller", async () => {
    mocks.computeTargetsService.findOwnedById.mockResolvedValue(null);
    installDb({});

    const result = await distributionsService.upsertStatusReports(
      "org-1",
      "ct-1",
      "user-1",
      "clerk-user-1",
      [
        {
          distributionId: "dist-1",
          status: DistributionTargetStatusValue.Installed,
        },
      ]
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("forbidden");
  });

  it("returns 0 accepted when all distributionIds are invalid (cross-org)", async () => {
    installDb({
      distribution: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await distributionsService.upsertStatusReports(
      "org-1",
      "ct-1",
      "user-1",
      "clerk-user-1",
      [
        {
          distributionId: "dist-other-org",
          status: DistributionTargetStatusValue.Installed,
        },
      ]
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(0);
  });

  it("upserts one row per valid distribution ID", async () => {
    const { executeRaw } = installStatusReportDb(["dist-1", "dist-2"]);

    const result = await distributionsService.upsertStatusReports(
      "org-1",
      "ct-1",
      "user-1",
      "clerk-user-1",
      [
        {
          distributionId: "dist-1",
          status: DistributionTargetStatusValue.Installed,
        },
        {
          distributionId: "dist-2",
          status: DistributionTargetStatusValue.Enabled,
        },
      ]
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(2);
    // One atomic upsert per report; no read-then-write branching.
    expect(upsertCalls(executeRaw)).toHaveLength(2);
    expect(captureUpsert(executeRaw, 0).distributionId).toBe("dist-1");
    expect(captureUpsert(executeRaw, 1).distributionId).toBe("dist-2");
  });

  it("FEA-3049: applies each report as an atomic ON CONFLICT upsert targeting the partial unique index", async () => {
    // Two concurrent reports for the same (distributionId, computeTargetId)
    // must not race the partial unique index into a P2002/500. A read-then-write
    // (findFirst + create) can't be made safe inside the READ COMMITTED tx, so
    // the upsert is a single atomic INSERT ... ON CONFLICT DO UPDATE arbitrated
    // by the exact partial index predicate.
    const { executeRaw } = installStatusReportDb(["dist-1"]);

    await distributionsService.upsertStatusReports(
      "org-1",
      "ct-1",
      "user-1",
      "clerk-user-1",
      [
        {
          distributionId: "dist-1",
          status: DistributionTargetStatusValue.Installed,
        },
      ]
    );

    const { sql } = captureUpsert(executeRaw);
    expect(sql).toContain("INSERT INTO distribution_target_status");
    expect(sql).toContain(
      "ON CONFLICT (distribution_id, compute_target_id) WHERE compute_target_id IS NOT NULL"
    );
    expect(sql).toContain("DO UPDATE SET");
    // First-seen milestones are preserved in-SQL, not via a prior read.
    expect(sql).toContain(
      "installed_at = COALESCE(distribution_target_status.installed_at, EXCLUDED.installed_at)"
    );
    expect(sql).toContain(
      "enabled_at = COALESCE(distribution_target_status.enabled_at, EXCLUDED.enabled_at)"
    );
  });

  it("acquires a per-report advisory lock keyed on distributionId + computeTargetId in deterministic order", async () => {
    // Regression guard (FEA-2994): two concurrent status reports for the same
    // (distributionId, computeTargetId) must not race the partial unique index
    // into a P2002/500. Each report takes a pg_advisory_xact_lock keyed on
    // `${distributionId}:${computeTargetId}` — not the whole batch — before the
    // atomic upsert, so overlapping reports serialize on their own key while
    // unrelated distributions proceed in parallel. Reports lock in deterministic
    // distributionId order so concurrent batches can't deadlock on an
    // overlapping pair. (The upsert itself is already race-free; the lock adds
    // ordered serialization + deadlock-freedom on top.)
    const { executeRaw } = installStatusReportDb(["dist-2", "dist-1"]);

    await distributionsService.upsertStatusReports(
      "org-1",
      "ct-lock",
      "user-1",
      "clerk-user-1",
      [
        {
          distributionId: "dist-2",
          status: DistributionTargetStatusValue.Installed,
        },
        {
          distributionId: "dist-1",
          status: DistributionTargetStatusValue.Installed,
        },
      ]
    );

    // One lock per report, keyed on `${distributionId}:${computeTargetId}` and
    // acquired in ascending distributionId order (dist-1 before dist-2).
    expect(advisoryLockKeys(executeRaw)).toEqual([
      "dist-1:ct-lock",
      "dist-2:ct-lock",
    ]);
    // Each report is then applied with exactly one atomic upsert.
    expect(upsertCalls(executeRaw)).toHaveLength(2);
  });

  it("upserts with the report's identifiers and status", async () => {
    const { executeRaw } = installStatusReportDb(["dist-1"]);

    const result = await distributionsService.upsertStatusReports(
      "org-1",
      "ct-1",
      "user-1",
      "clerk-user-1",
      [
        {
          distributionId: "dist-1",
          status: DistributionTargetStatusValue.Installed,
        },
      ]
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(1);
    expect(upsertCalls(executeRaw)).toHaveLength(1);
    const captured = captureUpsert(executeRaw);
    expect(captured.distributionId).toBe("dist-1");
    expect(captured.computeTargetId).toBe("ct-1");
    expect(captured.userId).toBe("user-1");
    expect(captured.status).toBe(DistributionTargetStatusValue.Installed);
    // The PK is minted as a UUIDv7 (version nibble `7`) to preserve the
    // table's time-ordered ids — never a random gen_random_uuid()/UUIDv4.
    expect(captured.id).toMatch(UUID_V7_RE);
  });

  it("second report for the same target re-runs the idempotent upsert (dedup is enforced by the index)", async () => {
    // The DB partial unique index + ON CONFLICT guarantees at most one row per
    // (distributionId, computeTargetId); the app fires the same idempotent
    // upsert each time rather than branching on a prior read.
    const { executeRaw } = installStatusReportDb(["dist-1"]);

    await distributionsService.upsertStatusReports(
      "org-1",
      "ct-1",
      "user-1",
      "clerk-user-1",
      [
        {
          distributionId: "dist-1",
          status: DistributionTargetStatusValue.Installed,
        },
      ]
    );

    const result2 = await distributionsService.upsertStatusReports(
      "org-1",
      "ct-1",
      "user-1",
      "clerk-user-1",
      [
        {
          distributionId: "dist-1",
          status: DistributionTargetStatusValue.Enabled,
        },
      ]
    );

    expect(result2.ok).toBe(true);
    expect(upsertCalls(executeRaw)).toHaveLength(2);
    expect(captureUpsert(executeRaw, 0).status).toBe(
      DistributionTargetStatusValue.Installed
    );
    expect(captureUpsert(executeRaw, 1).status).toBe(
      DistributionTargetStatusValue.Enabled
    );
  });

  it("preserves the original installedAt on a later report via COALESCE (does not overwrite the first-seen milestone)", async () => {
    // Correctness regression guard: installedAt/enabledAt are first-seen
    // milestones, not last-seen. A heartbeat reporting 'enabled' after the row
    // was already 'installed' must NOT rewrite installedAt. The atomic upsert
    // keeps any already-recorded value with COALESCE(existing, EXCLUDED) so the
    // milestone is preserved without a prior read.
    const { executeRaw } = installStatusReportDb(["dist-1"]);

    await distributionsService.upsertStatusReports(
      "org-1",
      "ct-1",
      "user-1",
      "clerk-user-1",
      [
        {
          distributionId: "dist-1",
          status: DistributionTargetStatusValue.Enabled,
        },
      ]
    );

    const { sql } = captureUpsert(executeRaw);
    // An already-recorded installed_at/enabled_at is kept; only an unset one is
    // filled from the incoming (EXCLUDED) candidate.
    expect(sql).toContain(
      "installed_at = COALESCE(distribution_target_status.installed_at, EXCLUDED.installed_at)"
    );
    expect(sql).toContain(
      "enabled_at = COALESCE(distribution_target_status.enabled_at, EXCLUDED.enabled_at)"
    );
  });

  it("supplies installedAt when status is 'installed'", async () => {
    const { executeRaw } = installStatusReportDb(["dist-1"]);

    await distributionsService.upsertStatusReports(
      "org-1",
      "ct-1",
      "user-1",
      "clerk-user-1",
      [
        {
          distributionId: "dist-1",
          status: DistributionTargetStatusValue.Installed,
        },
      ]
    );

    const captured = captureUpsert(executeRaw);
    expect(captured.installedAt).toBeInstanceOf(Date);
    // 'installed' is not yet 'enabled' → no enable milestone candidate.
    expect(captured.enabledAt).toBeNull();
  });

  it("supplies both installedAt and enabledAt when status is 'enabled'", async () => {
    const { executeRaw } = installStatusReportDb(["dist-1"]);

    await distributionsService.upsertStatusReports(
      "org-1",
      "ct-1",
      "user-1",
      "clerk-user-1",
      [
        {
          distributionId: "dist-1",
          status: DistributionTargetStatusValue.Enabled,
        },
      ]
    );

    const captured = captureUpsert(executeRaw);
    expect(captured.installedAt).toBeInstanceOf(Date);
    expect(captured.enabledAt).toBeInstanceOf(Date);
  });

  it("supplies no installedAt or enabledAt when status is 'failed'", async () => {
    const { executeRaw } = installStatusReportDb(["dist-1"]);

    await distributionsService.upsertStatusReports(
      "org-1",
      "ct-1",
      "user-1",
      "clerk-user-1",
      [
        {
          distributionId: "dist-1",
          status: DistributionTargetStatusValue.Failed,
          failureReason: "install script exited 1",
        },
      ]
    );

    const captured = captureUpsert(executeRaw);
    expect(captured.installedAt).toBeNull();
    expect(captured.enabledAt).toBeNull();
    expect(captured.failureReason).toBe("install script exited 1");
  });
});
