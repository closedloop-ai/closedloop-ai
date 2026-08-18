/**
 * FEA-4190: focused unit tests for `distributionsService.getAssignedForTarget`.
 *
 * Split out of `service.test.ts` so that file stays on the shrink-only
 * grandfather ratchet (biome.jsonc). Covers the desktop assigned-target read:
 * the bounded list-shaped select (no per-device `targetStatuses`), the
 * presigned auto_install download URL, the coaching passthrough, and the
 * `toDistributionDto` compatibility fallback when the `targetStatuses` relation
 * is absent from the row (the actual list-select shape).
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

  it("FEA-4190: maps a row whose targetStatuses relation is absent (the list-select shape) to an empty targetStatuses DTO via the compatibility fallback", async () => {
    // getAssignedForTarget selects with `distributionListSelect`, which omits the
    // `targetStatuses` relation entirely — so the row that reaches
    // `toDistributionDto` has NO targetStatuses (undefined, not `[]`). Every other
    // fixture here injects `targetStatuses: []`, which never exercises the
    // `row.targetStatuses ?? []` fallback in the mapper. Build a NON-EMPTY row
    // with the relation absent and assert the fallback yields a valid DTO with an
    // empty `targetStatuses`, so dropping the `?? []` (a `.map` of undefined
    // throw) would fail this test.
    const rowWithoutTargetStatuses = {
      ...buildDistributionRow({
        targetingType: DistributionTargetingType.All,
        catalogItem: {
          ...buildCatalogItemRow(),
          zipAssetBucket: null,
          zipAssetKey: null,
        },
      }),
      targetStatuses: undefined,
    };

    installDb({
      distribution: {
        findMany: vi.fn().mockResolvedValue([rowWithoutTargetStatuses]),
      },
    });

    const results = await distributionsService.getAssignedForTarget(
      "org-1",
      "ct-1",
      "user-1"
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("dist-1");
    expect(results[0]?.targetStatuses).toEqual([]);
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

  it("FEA-4190: does not select the unbounded per-device targetStatuses relation (payload is O(devices) otherwise)", async () => {
    // The desktop assignment poll parses targetStatuses as z.array(z.unknown())
    // and discards it, so the query must not fetch every org device's
    // install-status rows. It still needs the catalogItem zip fields for the
    // presigned download URL. Guard the select shape so a regression back to
    // `...distributionSelect` (which spreads targetStatuses) is caught.
    const findMany = vi.fn().mockResolvedValue([]);
    installDb({ distribution: { findMany } });

    await distributionsService.getAssignedForTarget("org-1", "ct-1", "user-1");

    const { select } = findMany.mock.calls[0]?.[0] ?? {};
    expect(select).toBeDefined();
    expect(select.targetStatuses).toBeUndefined();
    // Own-target status, if ever needed, must be scoped — never the full relation.
    expect(select.catalogItem?.select?.zipAssetBucket).toBe(true);
    expect(select.catalogItem?.select?.zipAssetKey).toBe(true);
  });
});
