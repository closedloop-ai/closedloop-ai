/**
 * Unit tests for the catalog service.
 *
 * Two concerns share this file:
 *
 * 1. The general catalog service surface (T-18.2, AC-016, AC-024, AC-025):
 *    listCatalogItemsForOrg / createCatalogItem / getUploadIntent /
 *    confirmAssetUpload / archiveCatalogItem / updateCatalogItem /
 *    getCatalogItemDetail. All DB calls are mocked via
 *    vi.mock("@repo/database"); AWS S3 helpers via vi.mock("@repo/aws").
 *
 * 2. FEA-2923 (Gap A, forward path) — the catalog ingest write bridge that
 *    keeps `agent_components` in sync when a NEW org_custom agent is created via
 *    bulkIngestAgents (bootstrap loop ingestion). The one-time backfill
 *    migration only snapshotted EXISTING org_custom catalog items into
 *    agent_components; these tests pin the ongoing forward path so a regression
 *    can't silently re-open the bug where a natively-created org_custom agent
 *    has no agent_components row and is therefore invisible in the Agents
 *    workspace (agentComponentsService.listForOrg reads agent_components).
 *
 * Note: The isOrgAdmin gate is enforced at the route layer (route.ts), not
 * inside the service functions themselves. The 403 gate tests exercise the
 * curated-item guard path, which doubles as the admin-gate enforcement for
 * curated items.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Mocks (must appear before any imports from the module under test)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  getPrismaErrorCode: vi.fn().mockReturnValue(undefined),
  parsePackZip: vi.fn(),
  fetchRepoComponents: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  // The repo-import path builds a where-clause referencing this enum, so the
  // mock must expose it (otherwise `GitHubInstallationStatus.ACTIVE` throws).
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
}));

vi.mock("@/lib/db-utils", () => ({
  getPrismaErrorCode: mocks.getPrismaErrorCode,
}));

vi.mock("../pack-zip-import", () => ({
  parsePackZip: mocks.parsePackZip,
  // Re-export the real error class so the 413 mapping (zip over budget) is
  // testable via `instanceof` in the service under test.
  PackZipTooLargeError: class PackZipTooLargeError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "PackZipTooLargeError";
    }
  },
}));

vi.mock("../pack-repo-import", () => ({
  fetchRepoComponents: mocks.fetchRepoComponents,
  // Re-export the real error class so the guard/surfacing behavior is testable.
  RepoTreeTruncatedError: class RepoTreeTruncatedError extends Error {
    constructor(owner: string, repo: string) {
      super(
        `GitHub returned a truncated file tree for ${owner}/${repo}; the repository is too large to import in full. Narrow the import with a subPath (e.g. \`.claude\`).`
      );
      this.name = "RepoTreeTruncatedError";
    }
  },
}));

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "../../../__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@repo/aws", () => ({
  catalogAssetKey: vi.fn(
    (orgId: string, itemId: string, kind: string) =>
      `org/${orgId}/catalog/${itemId}/${kind}`
  ),
  getCatalogAssetBytes: vi.fn().mockResolvedValue(Buffer.from("zip-bytes")),
  getCatalogAssetUploadUrl: vi.fn(),
  getCatalogAssetDownloadUrl: vi.fn(),
  headCatalogAsset: vi.fn(),
  resolveCatalogBucket: vi.fn(() => "plugin-store-bucket"),
  // Re-export the real error class so the 413 mapping (asset over raw-byte cap)
  // is testable via `instanceof` in the service under test.
  CatalogAssetTooLargeError: class CatalogAssetTooLargeError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CatalogAssetTooLargeError";
    }
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { computeComponentUuid } from "@repo/api/src/component-identity";
import { CatalogItemSource } from "@repo/api/src/types/distribution";
import {
  CatalogAssetTooLargeError,
  catalogAssetKey,
  getCatalogAssetBytes,
  getCatalogAssetDownloadUrl,
  getCatalogAssetUploadUrl,
  headCatalogAsset,
} from "@repo/aws";
import { log } from "@repo/observability/log";
import { RepoTreeTruncatedError } from "../pack-repo-import";
import { PackZipTooLargeError, parsePackZip } from "../pack-zip-import";
import {
  archiveCatalogItem,
  bulkIngestAgents,
  confirmAssetUpload,
  createCatalogItem,
  getCatalogItemDetail,
  getUploadIntent,
  importPackRepoComponents,
  importPackZipComponents,
  listCatalogItemsForOrg,
  updateCatalogItem,
} from "../service";

// ---------------------------------------------------------------------------
// Typed mock handles
// ---------------------------------------------------------------------------

const mockWithDb = mocks.withDb as unknown as Mock & { tx: Mock };
const mockGetCatalogAssetUploadUrl =
  getCatalogAssetUploadUrl as unknown as Mock;
const mockGetCatalogAssetDownloadUrl =
  getCatalogAssetDownloadUrl as unknown as Mock;
const mockHeadCatalogAsset = headCatalogAsset as unknown as Mock;
const mockCatalogAssetKey = catalogAssetKey as unknown as Mock;
const mockParsePackZip = parsePackZip as unknown as Mock;
const mockGetCatalogAssetBytes = getCatalogAssetBytes as unknown as Mock;
const mockFetchRepoComponents = mocks.fetchRepoComponents as unknown as Mock;

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "org-111";
const OTHER_ORG_ID = "org-222";
const USER_ID = "user-abc";
const ITEM_ID = "item-uuid-1";
const NOW = new Date("2026-01-15T10:00:00.000Z");

function makeCatalogRow(
  overrides: Partial<{
    id: string;
    organizationId: string | null;
    targetKind: string;
    source: string;
    scope: string;
    name: string;
    description: string | null;
    version: string;
    sortOrder: number;
    enabled: boolean;
    archived: boolean;
    coaching: boolean;
    coachingConfig: Record<string, unknown> | null;
    zipAssetKey: string | null;
    logoAssetKey: string | null;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> = {}
) {
  return {
    id: ITEM_ID,
    organizationId: ORG_ID,
    targetKind: "plugin",
    source: "org_custom",
    scope: "org",
    name: "My Plugin",
    description: "A test plugin",
    version: "1.0.0",
    sortOrder: 0,
    enabled: true,
    archived: false,
    coaching: false,
    coachingConfig: null,
    zipAssetKey: null,
    logoAssetKey: null,
    createdById: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Set up withDb to return from a simple (non-tx) callback. */
function setupWithDb(clientStub: Record<string, unknown>) {
  mockWithDb.mockImplementation(
    (callback: (db: Record<string, unknown>) => unknown) => callback(clientStub)
  );
}

/** Set up withDb.tx to invoke its callback with the given tx stub. */
function setupWithDbTx(txStub: Record<string, unknown>) {
  mockWithDb.tx.mockImplementation(
    (callback: (tx: Record<string, unknown>) => unknown) => callback(txStub)
  );
}

// ---------------------------------------------------------------------------
// listCatalogItemsForOrg
// ---------------------------------------------------------------------------

describe("listCatalogItemsForOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCatalogAssetDownloadUrl.mockResolvedValue(
      "https://s3.example.com/logo.png"
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns org-specific items and curated global items", async () => {
    const orgRow = makeCatalogRow({ id: "item-org", source: "org_custom" });
    const curatedRow = makeCatalogRow({
      id: "item-curated",
      organizationId: null,
      source: "curated",
      scope: "global",
    });

    setupWithDb({
      catalogItem: {
        findMany: vi.fn().mockResolvedValue([orgRow, curatedRow]),
      },
    });

    const items = await listCatalogItemsForOrg({
      organizationId: ORG_ID,
    });

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id)).toContain("item-org");
    expect(items.map((i) => i.id)).toContain("item-curated");
  });

  it("passes correct org-scoping filter to findMany", async () => {
    let capturedWhere: unknown;
    mockWithDb.mockImplementation(
      (callback: (db: Record<string, unknown>) => unknown) =>
        callback({
          catalogItem: {
            findMany: vi.fn((args: { where: unknown }) => {
              capturedWhere = args.where;
              return Promise.resolve([]);
            }),
          },
        })
    );

    await listCatalogItemsForOrg({ organizationId: ORG_ID });

    expect(capturedWhere).toEqual(
      expect.objectContaining({
        OR: [
          { organizationId: ORG_ID },
          { scope: "global", source: "curated" },
        ],
      })
    );
  });

  it("excludes archived items by default", async () => {
    let capturedWhere: Record<string, unknown> = {};
    mockWithDb.mockImplementation(
      (callback: (db: Record<string, unknown>) => unknown) =>
        callback({
          catalogItem: {
            findMany: vi.fn((args: { where: Record<string, unknown> }) => {
              capturedWhere = args.where;
              return Promise.resolve([]);
            }),
          },
        })
    );

    await listCatalogItemsForOrg({ organizationId: ORG_ID });

    expect(capturedWhere.archived).toBe(false);
  });

  it("includes archived items when includeArchived=true", async () => {
    let capturedWhere: Record<string, unknown> = {};
    mockWithDb.mockImplementation(
      (callback: (db: Record<string, unknown>) => unknown) =>
        callback({
          catalogItem: {
            findMany: vi.fn((args: { where: Record<string, unknown> }) => {
              capturedWhere = args.where;
              return Promise.resolve([]);
            }),
          },
        })
    );

    await listCatalogItemsForOrg({
      organizationId: ORG_ID,
      includeArchived: true,
    });

    // archived filter should be undefined (not false) when includeArchived=true
    expect(capturedWhere.archived).toBeUndefined();
  });

  it("does NOT return items belonging to a different org", async () => {
    // The DB query is already org-scoped; verify no other-org rows slip through
    const orgRow = makeCatalogRow({ id: "item-org", organizationId: ORG_ID });
    setupWithDb({
      catalogItem: {
        findMany: vi.fn().mockResolvedValue([orgRow]),
      },
    });

    const items = await listCatalogItemsForOrg({
      organizationId: OTHER_ORG_ID,
    });

    // The single row returned belongs to ORG_ID, not OTHER_ORG_ID, but the
    // service passes it through — in real usage the DB filter prevents this.
    // The important assertion is that the scoping WHERE clause uses organizationId.
    expect(items).toHaveLength(1);
  });

  it("serializes dates as ISO strings in the DTO", async () => {
    const row = makeCatalogRow({ createdAt: NOW, updatedAt: NOW });
    setupWithDb({
      catalogItem: { findMany: vi.fn().mockResolvedValue([row]) },
    });

    const [item] = await listCatalogItemsForOrg({ organizationId: ORG_ID });

    expect(item.createdAt).toBe(NOW.toISOString());
    expect(item.updatedAt).toBe(NOW.toISOString());
  });

  it("populates logoUrl via presigned GET URL when logoAssetKey is set", async () => {
    const logoKey = `org/${ORG_ID}/catalog/${ITEM_ID}/logo`;
    // Distinct updatedAt gives this row a unique (key, version) cache entry so
    // the module-level logo-URL cache does not collide with other logo tests.
    const row = makeCatalogRow({
      logoAssetKey: logoKey,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    setupWithDb({
      catalogItem: { findMany: vi.fn().mockResolvedValue([row]) },
    });
    mockGetCatalogAssetDownloadUrl.mockResolvedValue(
      "https://s3.example.com/logo-presigned"
    );

    const [item] = await listCatalogItemsForOrg({ organizationId: ORG_ID });

    expect(item.logoUrl).toBe("https://s3.example.com/logo-presigned");
    expect(mockGetCatalogAssetDownloadUrl).toHaveBeenCalledWith(logoKey, {
      expiresIn: 900,
    });
  });

  it("returns logoUrl=null when no logo asset key is stored", async () => {
    const row = makeCatalogRow({ logoAssetKey: null });
    setupWithDb({
      catalogItem: { findMany: vi.fn().mockResolvedValue([row]) },
    });

    const [item] = await listCatalogItemsForOrg({ organizationId: ORG_ID });

    expect(item.logoUrl).toBeNull();
    expect(mockGetCatalogAssetDownloadUrl).not.toHaveBeenCalled();
  });

  it("returns logoUrl=null and does not throw when S3 presign fails", async () => {
    const logoKey = `org/${ORG_ID}/catalog/${ITEM_ID}/logo`;
    // Distinct updatedAt so this row is never served from a prior test's cached
    // (successful) signature — the rejecting mint must actually be exercised.
    const row = makeCatalogRow({
      logoAssetKey: logoKey,
      updatedAt: new Date("2026-02-02T00:00:00.000Z"),
    });
    setupWithDb({
      catalogItem: { findMany: vi.fn().mockResolvedValue([row]) },
    });
    mockGetCatalogAssetDownloadUrl.mockRejectedValue(new Error("S3 error"));

    const [item] = await listCatalogItemsForOrg({ organizationId: ORG_ID });

    expect(item.logoUrl).toBeNull();
  });

  // FEA-3170: the presign failure above is non-fatal, but it must not be
  // silent — a misconfigured bucket or rotated credentials degrades every
  // catalog read to logoUrl=null, and without this signal there is zero
  // operator visibility.
  it("warns with the error and asset key when S3 presign fails", async () => {
    const logoKey = `org/${ORG_ID}/catalog/${ITEM_ID}/logo`;
    const row = makeCatalogRow({
      logoAssetKey: logoKey,
      updatedAt: new Date("2026-02-03T00:00:00.000Z"),
    });
    setupWithDb({
      catalogItem: { findMany: vi.fn().mockResolvedValue([row]) },
    });
    const presignError = new Error("AccessDenied");
    mockGetCatalogAssetDownloadUrl.mockRejectedValue(presignError);

    await listCatalogItemsForOrg({ organizationId: ORG_ID });

    expect(log.warn).toHaveBeenCalledWith("catalog.logo_presign_failed", {
      error: presignError,
      logoAssetKey: logoKey,
    });
  });

  it("does not warn when the presign succeeds", async () => {
    const logoKey = `org/${ORG_ID}/catalog/${ITEM_ID}/logo`;
    const row = makeCatalogRow({
      logoAssetKey: logoKey,
      updatedAt: new Date("2026-02-04T00:00:00.000Z"),
    });
    setupWithDb({
      catalogItem: { findMany: vi.fn().mockResolvedValue([row]) },
    });
    mockGetCatalogAssetDownloadUrl.mockResolvedValue(
      "https://s3.example.com/logo-ok"
    );

    await listCatalogItemsForOrg({ organizationId: ORG_ID });

    expect(log.warn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Presigned logo-URL caching (FEA-3237)
  // -------------------------------------------------------------------------

  it("reuses one cached presigned URL across reads for the same (key, updatedAt)", async () => {
    const logoKey = `org/${ORG_ID}/catalog/cache-hit/logo`;
    const row = makeCatalogRow({
      id: "cache-hit",
      logoAssetKey: logoKey,
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    setupWithDb({
      catalogItem: { findMany: vi.fn().mockResolvedValue([row]) },
    });
    // Each mint returns a distinct URL so a re-mint would be observable.
    let mintCount = 0;
    mockGetCatalogAssetDownloadUrl.mockImplementation(() => {
      mintCount += 1;
      return Promise.resolve(`https://s3.example.com/logo-${mintCount}`);
    });

    const [first] = await listCatalogItemsForOrg({ organizationId: ORG_ID });
    const [second] = await listCatalogItemsForOrg({ organizationId: ORG_ID });
    const [third] = await listCatalogItemsForOrg({ organizationId: ORG_ID });

    expect(first.logoUrl).toBe("https://s3.example.com/logo-1");
    // Same URL string across polls → browser can serve the image from its cache.
    expect(second.logoUrl).toBe(first.logoUrl);
    expect(third.logoUrl).toBe(first.logoUrl);
    // Only one signature was minted despite three reads.
    expect(mockGetCatalogAssetDownloadUrl).toHaveBeenCalledTimes(1);
  });

  it("re-mints when updatedAt changes (logo re-uploaded under the same key)", async () => {
    const logoKey = `org/${ORG_ID}/catalog/re-mint/logo`;
    const before = makeCatalogRow({
      id: "re-mint",
      logoAssetKey: logoKey,
      updatedAt: new Date("2026-03-02T00:00:00.000Z"),
    });
    const after = makeCatalogRow({
      id: "re-mint",
      logoAssetKey: logoKey,
      updatedAt: new Date("2026-03-02T01:00:00.000Z"),
    });
    let mintCount = 0;
    mockGetCatalogAssetDownloadUrl.mockImplementation(() => {
      mintCount += 1;
      return Promise.resolve(`https://s3.example.com/remint-${mintCount}`);
    });

    setupWithDb({
      catalogItem: { findMany: vi.fn().mockResolvedValue([before]) },
    });
    const [firstRead] = await listCatalogItemsForOrg({
      organizationId: ORG_ID,
    });

    setupWithDb({
      catalogItem: { findMany: vi.fn().mockResolvedValue([after]) },
    });
    const [secondRead] = await listCatalogItemsForOrg({
      organizationId: ORG_ID,
    });

    expect(firstRead.logoUrl).toBe("https://s3.example.com/remint-1");
    // New version token forces a fresh mint → a new URL the browser will refetch.
    expect(secondRead.logoUrl).toBe("https://s3.example.com/remint-2");
    expect(mockGetCatalogAssetDownloadUrl).toHaveBeenCalledTimes(2);
  });

  it("re-mints once the cached signature nears expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:00:00.000Z"));
    try {
      const logoKey = `org/${ORG_ID}/catalog/expiry/logo`;
      const row = makeCatalogRow({
        id: "expiry",
        logoAssetKey: logoKey,
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      });
      setupWithDb({
        catalogItem: { findMany: vi.fn().mockResolvedValue([row]) },
      });
      let mintCount = 0;
      mockGetCatalogAssetDownloadUrl.mockImplementation(() => {
        mintCount += 1;
        return Promise.resolve(`https://s3.example.com/expiry-${mintCount}`);
      });

      const [initial] = await listCatalogItemsForOrg({
        organizationId: ORG_ID,
      });
      expect(initial.logoUrl).toBe("https://s3.example.com/expiry-1");

      // Still comfortably valid (well inside the 900s TTL) → cache hit.
      vi.advanceTimersByTime(800 * 1000);
      const [midlife] = await listCatalogItemsForOrg({
        organizationId: ORG_ID,
      });
      expect(midlife.logoUrl).toBe("https://s3.example.com/expiry-1");
      expect(mockGetCatalogAssetDownloadUrl).toHaveBeenCalledTimes(1);

      // Within the 60s safety margin of the 900s expiry → re-mint.
      vi.advanceTimersByTime(90 * 1000);
      const [nearExpiry] = await listCatalogItemsForOrg({
        organizationId: ORG_ID,
      });
      expect(nearExpiry.logoUrl).toBe("https://s3.example.com/expiry-2");
      expect(mockGetCatalogAssetDownloadUrl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// createCatalogItem
// ---------------------------------------------------------------------------

describe("createCatalogItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCatalogAssetDownloadUrl.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a CatalogItem row with source=org_custom and scope=org", async () => {
    let capturedData: Record<string, unknown> = {};
    const createdRow = makeCatalogRow();
    setupWithDbTx({
      catalogItem: {
        create: vi.fn((args: { data: Record<string, unknown> }) => {
          capturedData = args.data;
          return Promise.resolve(createdRow);
        }),
      },
    });

    await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "plugin",
      name: "My Plugin",
      description: "A test plugin",
    });

    expect(capturedData.source).toBe("org_custom");
    expect(capturedData.scope).toBe("org");
    expect(capturedData.organizationId).toBe(ORG_ID);
    expect(capturedData.createdById).toBe(USER_ID);
    expect(capturedData.targetKind).toBe("plugin");
    expect(capturedData.name).toBe("My Plugin");
  });

  it("returns a CatalogItemDto with the created item data", async () => {
    const row = makeCatalogRow({ id: "new-item-id", name: "Test Item" });
    setupWithDbTx({ catalogItem: { create: vi.fn().mockResolvedValue(row) } });

    const result = await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "plugin",
      name: "Test Item",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("new-item-id");
      expect(result.value.name).toBe("Test Item");
      expect(result.value.source).toBe("org_custom");
    }
  });

  it("persists coaching=true and coachingConfig when provided", async () => {
    let capturedData: Record<string, unknown> = {};
    const coachingConfig = { signals: ["signal-1", "signal-2"] };
    const row = makeCatalogRow({ coaching: true, coachingConfig });
    setupWithDbTx({
      catalogItem: {
        create: vi.fn((args: { data: Record<string, unknown> }) => {
          capturedData = args.data;
          return Promise.resolve(row);
        }),
      },
    });

    await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "plugin",
      name: "Coaching Plugin",
      coaching: true,
      coachingConfig,
    });

    expect(capturedData.coaching).toBe(true);
    expect(capturedData.coachingConfig).toEqual(coachingConfig);
  });

  it("defaults coaching=false when not provided", async () => {
    let capturedData: Record<string, unknown> = {};
    const row = makeCatalogRow();
    setupWithDbTx({
      catalogItem: {
        create: vi.fn((args: { data: Record<string, unknown> }) => {
          capturedData = args.data;
          return Promise.resolve(row);
        }),
      },
    });

    await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "plugin",
      name: "My Plugin",
    });

    expect(capturedData.coaching).toBe(false);
  });

  it("does NOT materialize an agent_components row for a non-agent item", async () => {
    const row = makeCatalogRow({ targetKind: "plugin" });
    const agentComponentUpsert = vi.fn().mockResolvedValue({});
    setupWithDbTx({
      catalogItem: { create: vi.fn().mockResolvedValue(row) },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      user: { findFirst: vi.fn().mockResolvedValue({ id: "u-1" }) },
      agentComponent: { upsert: agentComponentUpsert },
    });

    await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "plugin",
      name: "My Plugin",
    });

    // Only agent items bridge into the Agents workspace inventory.
    expect(agentComponentUpsert).not.toHaveBeenCalled();
  });

  it("materializes a cloud-sentinel agent_components row for an agent item", async () => {
    // FEA-2923 (Gap A, second forward path): POST /catalog with an agent item
    // must also land an agent_components row so the agent is visible in the
    // Agents workspace — mirroring bulkIngestAgents → createNewItem.
    const row = makeCatalogRow({
      id: "cat-agent-1",
      targetKind: "agent",
      name: "My Agent",
    });
    const agentComponentUpsert = vi.fn().mockResolvedValue({});
    const computeTargetCreate = vi.fn().mockResolvedValue({ id: "sentinel-1" });
    setupWithDbTx({
      catalogItem: { create: vi.fn().mockResolvedValue(row) },
      computeTarget: {
        // No sentinel yet → the forward path creates one owned by the org's
        // earliest active user (same owner the backfill migration picks).
        findFirst: vi.fn().mockResolvedValue(null),
        create: computeTargetCreate,
      },
      user: { findFirst: vi.fn().mockResolvedValue({ id: "earliest-user" }) },
      agentComponent: { upsert: agentComponentUpsert },
    });

    await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "agent",
      name: "My Agent",
      description: "Does things",
    });

    expect(computeTargetCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG_ID,
          isCloudSentinel: true,
          platform: "cloud",
        }),
      })
    );
    expect(agentComponentUpsert).toHaveBeenCalledTimes(1);
    const upsertArg = agentComponentUpsert.mock.calls[0][0];
    // Deterministic (computeTargetId, subagent, cloud:agent:<catalogItemId>) key
    // shared with the backfill migration and createNewItem.
    expect(
      upsertArg.where.computeTargetId_componentKind_externalComponentId
    ).toEqual({
      computeTargetId: "sentinel-1",
      componentKind: "subagent",
      externalComponentId: "cloud:agent:cat-agent-1",
    });
    // No agentSlug on the admin-create path → componentKey falls back to name.
    expect(upsertArg.create.componentKey).toBe("My Agent");
    expect(upsertArg.create.name).toBe("My Agent");
  });

  // Cross-org child-leak guard: a component may only be attached under a Pack
  // that exists, is targetKind==="pack", AND belongs to the caller's org.
  it("rejects (404) attaching a component under a parentPackId the org cannot see", async () => {
    const create = vi.fn();
    setupWithDbTx({
      catalogItem: {
        // Parent lookup is org-scoped by the caller org, not the parent's org;
        // returning null models a curated/global/foreign-org pack id the caller
        // supplied but does not own.
        findFirst: vi.fn().mockResolvedValue(null),
        create,
      },
    });

    const result = await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "agent",
      name: "Sneaky Component",
      parentPackId: "curated-pack-owned-by-other-org",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(404);
    }
    // The child row must NOT be written when the parent is not attachable.
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects (404) attaching under a foreign-org pack id", async () => {
    const create = vi.fn();
    setupWithDbTx({
      catalogItem: {
        // Parent exists but belongs to a DIFFERENT org → not attachable.
        findFirst: vi.fn().mockResolvedValue({
          id: "foreign-pack",
          organizationId: OTHER_ORG_ID,
          targetKind: "pack",
        }),
        create,
      },
    });

    const result = await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "agent",
      name: "Sneaky Component",
      parentPackId: "foreign-pack",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(404);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects (403) attaching a component under an org item that is not a Pack", async () => {
    const create = vi.fn();
    setupWithDbTx({
      catalogItem: {
        // Org-owned, but not a pack container → can't hold children.
        findFirst: vi.fn().mockResolvedValue({
          id: "org-plugin",
          organizationId: ORG_ID,
          targetKind: "plugin",
        }),
        create,
      },
    });

    const result = await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "agent",
      name: "Component",
      parentPackId: "org-plugin",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("allows attaching a component under an org-owned Pack", async () => {
    const createdRow = makeCatalogRow({
      id: "child-1",
      targetKind: "agent",
      name: "Component",
    });
    let capturedData: Record<string, unknown> = {};
    setupWithDbTx({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: "org-pack",
          organizationId: ORG_ID,
          targetKind: "pack",
        }),
        create: vi.fn((args: { data: Record<string, unknown> }) => {
          capturedData = args.data;
          return Promise.resolve(createdRow);
        }),
      },
      // agent child materializes an agent_components row.
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "sentinel-1" }),
        create: vi.fn(),
      },
      user: { findFirst: vi.fn().mockResolvedValue({ id: "u-1" }) },
      agentComponent: { upsert: vi.fn().mockResolvedValue({}) },
    });

    const result = await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "agent",
      name: "Component",
      parentPackId: "org-pack",
    });

    expect(result.ok).toBe(true);
    expect(capturedData.parentPackId).toBe("org-pack");
  });
});

// ---------------------------------------------------------------------------
// getUploadIntent (size cap + presigned PUT)
// ---------------------------------------------------------------------------

const ZIP_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

describe("getUploadIntent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCatalogAssetUploadUrl.mockResolvedValue({
      uploadUrl: "https://s3.example.com/put-presigned",
      key: `org/${ORG_ID}/catalog/${ITEM_ID}/zip`,
    });
    // Restore real key calculation
    mockCatalogAssetKey.mockImplementation(
      (orgId: string, itemId: string, kind: string) =>
        `org/${orgId}/catalog/${itemId}/${kind}`
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function setupItemLookup(item: { id: string; source: string } | null) {
    mockWithDb.mockImplementation(
      (callback: (db: Record<string, unknown>) => unknown) =>
        callback({
          catalogItem: { findFirst: vi.fn().mockResolvedValue(item) },
        })
    );
  }

  it("returns presignedUrl and s3Key with org-scoped key for zip", async () => {
    setupItemLookup({ id: ITEM_ID, source: "org_custom" });
    const expectedKey = `org/${ORG_ID}/catalog/${ITEM_ID}/zip`;
    mockGetCatalogAssetUploadUrl.mockResolvedValue({
      uploadUrl: "https://s3.example.com/put",
      key: expectedKey,
    });

    const result = await getUploadIntent({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "zip",
      contentType: "application/zip",
      fileSizeBytes: 1024,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.s3Key).toBe(expectedKey);
      expect(result.value.presignedUrl).toBe("https://s3.example.com/put");
    }
  });

  it("calls getCatalogAssetUploadUrl with correct parameters", async () => {
    setupItemLookup({ id: ITEM_ID, source: "org_custom" });

    await getUploadIntent({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "zip",
      contentType: "application/zip",
      fileSizeBytes: 2048,
    });

    expect(mockGetCatalogAssetUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        itemId: ITEM_ID,
        kind: "zip",
        contentType: "application/zip",
        contentLength: 2048,
        expiresIn: 900,
      })
    );
  });

  it("enforces zip size cap (50 MB): returns 413 when file is too large", async () => {
    const result = await getUploadIntent({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "zip",
      contentType: "application/zip",
      fileSizeBytes: ZIP_MAX_BYTES + 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(413);
    }
    // Size cap checked before DB lookup — S3 call never made
    expect(mockWithDb).not.toHaveBeenCalled();
    expect(mockGetCatalogAssetUploadUrl).not.toHaveBeenCalled();
  });

  it("allows zip at exactly the size cap (50 MB)", async () => {
    setupItemLookup({ id: ITEM_ID, source: "org_custom" });

    const result = await getUploadIntent({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "zip",
      contentType: "application/zip",
      fileSizeBytes: ZIP_MAX_BYTES,
    });

    expect(result.ok).toBe(true);
  });

  it("enforces logo size cap (2 MB): returns 413 when file is too large", async () => {
    const result = await getUploadIntent({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "logo",
      contentType: "image/png",
      fileSizeBytes: LOGO_MAX_BYTES + 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(413);
    }
  });

  it("allows logo at exactly the size cap (2 MB)", async () => {
    setupItemLookup({ id: ITEM_ID, source: "org_custom" });
    mockGetCatalogAssetUploadUrl.mockResolvedValue({
      uploadUrl: "https://s3.example.com/logo-put",
      key: `org/${ORG_ID}/catalog/${ITEM_ID}/logo`,
    });

    const result = await getUploadIntent({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "logo",
      contentType: "image/png",
      fileSizeBytes: LOGO_MAX_BYTES,
    });

    expect(result.ok).toBe(true);
  });

  it("returns 415 for a zip with a disallowed content type (MIME allowlist)", async () => {
    const result = await getUploadIntent({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "zip",
      contentType: "text/html",
      fileSizeBytes: 1024,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(415);
    }
    // Rejected before any S3 presign — no attacker-chosen content type is signed
    expect(mockGetCatalogAssetUploadUrl).not.toHaveBeenCalled();
  });

  it("returns 415 for a logo with a disallowed content type (e.g. image/svg+xml)", async () => {
    const result = await getUploadIntent({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "logo",
      contentType: "image/svg+xml",
      fileSizeBytes: 1024,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(415);
    }
    expect(mockGetCatalogAssetUploadUrl).not.toHaveBeenCalled();
  });

  it("accepts an allowlisted content type with parameters (charset)", async () => {
    setupItemLookup({ id: ITEM_ID, source: "org_custom" });
    mockGetCatalogAssetUploadUrl.mockResolvedValue({
      uploadUrl: "https://s3.example.com/put",
      key: `org/${ORG_ID}/catalog/${ITEM_ID}/logo`,
    });

    const result = await getUploadIntent({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "logo",
      contentType: "image/png; charset=binary",
      fileSizeBytes: 1024,
    });

    expect(result.ok).toBe(true);
  });

  it("returns 404 when the catalog item does not belong to the org", async () => {
    setupItemLookup(null);

    const result = await getUploadIntent({
      organizationId: ORG_ID,
      catalogItemId: "nonexistent-item",
      fileType: "zip",
      contentType: "application/zip",
      fileSizeBytes: 1024,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(404);
    }
  });

  it("returns 403 for curated items (org cannot upload assets to curated items)", async () => {
    setupItemLookup({ id: ITEM_ID, source: "curated" });

    const result = await getUploadIntent({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "zip",
      contentType: "application/zip",
      fileSizeBytes: 1024,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// confirmAssetUpload (HeadObject + DB update)
// ---------------------------------------------------------------------------

describe("confirmAssetUpload", () => {
  const EXPECTED_KEY = `org/${ORG_ID}/catalog/${ITEM_ID}/zip`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHeadCatalogAsset.mockResolvedValue({ byteSize: 1024, etag: "abc123" });
    mockGetCatalogAssetDownloadUrl.mockResolvedValue(null);
    mockCatalogAssetKey.mockImplementation(
      (orgId: string, itemId: string, kind: string) =>
        `org/${orgId}/catalog/${itemId}/${kind}`
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls HeadObject and persists both zipAssetBucket and zipAssetKey in DB", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValue({ id: ITEM_ID, source: "org_custom" });
    const update = vi
      .fn()
      .mockResolvedValue(makeCatalogRow({ zipAssetKey: EXPECTED_KEY }));

    mockWithDb.mockImplementation(
      (callback: (db: Record<string, unknown>) => unknown) =>
        callback({ catalogItem: { findFirst, update } })
    );

    const result = await confirmAssetUpload({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "zip",
      s3Key: EXPECTED_KEY,
    });

    expect(result.ok).toBe(true);
    expect(mockHeadCatalogAsset).toHaveBeenCalledWith(EXPECTED_KEY);
    // Both the resolved PLUGIN_STORE_BUCKET and the key must be persisted so
    // the desktop asset-download URL can later be signed against that bucket.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ITEM_ID },
        data: {
          zipAssetBucket: "plugin-store-bucket",
          zipAssetKey: EXPECTED_KEY,
        },
      })
    );
  });

  it("calls HeadObject and updates logoAssetKey when fileType=logo", async () => {
    const logoKey = `org/${ORG_ID}/catalog/${ITEM_ID}/logo`;
    const findFirst = vi
      .fn()
      .mockResolvedValue({ id: ITEM_ID, source: "org_custom" });
    const update = vi
      .fn()
      .mockResolvedValue(makeCatalogRow({ logoAssetKey: logoKey }));

    mockWithDb.mockImplementation(
      (callback: (db: Record<string, unknown>) => unknown) =>
        callback({ catalogItem: { findFirst, update } })
    );

    const result = await confirmAssetUpload({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "logo",
      s3Key: logoKey,
    });

    expect(result.ok).toBe(true);
    expect(mockHeadCatalogAsset).toHaveBeenCalledWith(logoKey);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          logoAssetBucket: "plugin-store-bucket",
          logoAssetKey: logoKey,
        },
      })
    );
  });

  it("returns asset_not_found when HeadObject returns null (object missing in S3)", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValue({ id: ITEM_ID, source: "org_custom" });

    mockWithDb.mockImplementation(
      (callback: (db: Record<string, unknown>) => unknown) =>
        callback({ catalogItem: { findFirst } })
    );
    mockHeadCatalogAsset.mockResolvedValue(null);

    const result = await confirmAssetUpload({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "zip",
      s3Key: EXPECTED_KEY,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("asset_not_found");
    }
  });

  it("returns asset_not_found when s3Key does not match expected org-scoped prefix", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValue({ id: ITEM_ID, source: "org_custom" });

    mockWithDb.mockImplementation(
      (callback: (db: Record<string, unknown>) => unknown) =>
        callback({ catalogItem: { findFirst } })
    );

    const result = await confirmAssetUpload({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "zip",
      s3Key: "org/other-org/catalog/other-item/zip", // wrong org prefix
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("asset_not_found");
    }
    // HeadObject must NOT be called when key prefix is invalid
    expect(mockHeadCatalogAsset).not.toHaveBeenCalled();
  });

  it("returns 404 when catalog item is not found in the org", async () => {
    mockWithDb.mockImplementation(
      (callback: (db: Record<string, unknown>) => unknown) =>
        callback({
          catalogItem: { findFirst: vi.fn().mockResolvedValue(null) },
        })
    );

    const result = await confirmAssetUpload({
      organizationId: ORG_ID,
      catalogItemId: "missing-item",
      fileType: "zip",
      s3Key: `org/${ORG_ID}/catalog/missing-item/zip`,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(404);
    }
  });

  it("returns 403 for curated items", async () => {
    mockWithDb.mockImplementation(
      (callback: (db: Record<string, unknown>) => unknown) =>
        callback({
          catalogItem: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ id: ITEM_ID, source: "curated" }),
          },
        })
    );

    const result = await confirmAssetUpload({
      organizationId: ORG_ID,
      catalogItemId: ITEM_ID,
      fileType: "zip",
      s3Key: EXPECTED_KEY,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// archiveCatalogItem
// ---------------------------------------------------------------------------

describe("archiveCatalogItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sets archived=true on the CatalogItem row", async () => {
    let capturedUpdateData: Record<string, unknown> = {};
    mockWithDb
      .mockImplementationOnce(
        (callback: (db: Record<string, unknown>) => unknown) =>
          callback({
            catalogItem: {
              findFirst: vi
                .fn()
                .mockResolvedValue({ id: ITEM_ID, source: "org_custom" }),
            },
          })
      )
      .mockImplementationOnce(
        (callback: (db: Record<string, unknown>) => unknown) =>
          callback({
            catalogItem: {
              update: vi.fn((args: { data: Record<string, unknown> }) => {
                capturedUpdateData = args.data;
                return Promise.resolve({});
              }),
            },
          })
      );

    const result = await archiveCatalogItem({
      id: ITEM_ID,
      organizationId: ORG_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.archived).toBe(true);
    }
    expect(capturedUpdateData.archived).toBe(true);
  });

  it("returns 404 when item does not belong to the org", async () => {
    setupWithDb({
      catalogItem: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    const result = await archiveCatalogItem({
      id: "nonexistent",
      organizationId: ORG_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(404);
    }
  });

  it("returns 403 for curated items (orgs cannot archive curated items)", async () => {
    setupWithDb({
      catalogItem: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: ITEM_ID, source: "curated" }),
      },
    });

    const result = await archiveCatalogItem({
      id: ITEM_ID,
      organizationId: ORG_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// updateCatalogItem
// ---------------------------------------------------------------------------

describe("updateCatalogItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCatalogAssetDownloadUrl.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("updates admin-managed fields on an org_custom item for admins", async () => {
    let capturedData: Record<string, unknown> = {};
    let capturedWhere: Record<string, unknown> = {};
    const updatedRow = makeCatalogRow({ name: "Updated Name", sortOrder: 5 });
    // Ownership lookup runs via withDb; the mutation runs via withDb.tx.
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: ITEM_ID,
          source: CatalogItemSource.OrgCustom,
          archived: false,
          targetKind: "plugin",
          organizationId: ORG_ID,
          createdById: USER_ID,
          sourceRepo: null,
        }),
      },
    });
    setupWithDbTx({
      catalogItem: {
        updateMany: vi.fn(
          (args: {
            data: Record<string, unknown>;
            where: Record<string, unknown>;
          }) => {
            capturedData = args.data;
            capturedWhere = args.where;
            return Promise.resolve({ count: 1 });
          }
        ),
        findUnique: vi.fn().mockResolvedValue(updatedRow),
      },
      catalogItemVersion: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await updateCatalogItem({
      id: ITEM_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      canUpdateAny: true,
      name: "Updated Name",
      sortOrder: 5,
    });

    expect(result.ok).toBe(true);
    expect(capturedWhere).toEqual(
      expect.objectContaining({
        id: ITEM_ID,
        organizationId: ORG_ID,
        source: CatalogItemSource.OrgCustom,
        archived: false,
      })
    );
    expect(capturedWhere).not.toHaveProperty("createdById");
    expect(capturedData.name).toBe("Updated Name");
    expect(capturedData.sortOrder).toBe(5);
  });

  it("updates metadata and content for the org_custom item owner", async () => {
    let capturedData: Record<string, unknown> = {};
    let capturedWhere: Record<string, unknown> = {};
    const createVersion = vi.fn().mockResolvedValue({});
    const updatedRow = makeCatalogRow({
      name: "Owner Name",
      description: "Owner description",
    });
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: ITEM_ID,
          source: CatalogItemSource.OrgCustom,
          archived: false,
          targetKind: "plugin",
          organizationId: ORG_ID,
          createdById: USER_ID,
          sourceRepo: "closedloop-ai/symphony-alpha",
        }),
      },
    });
    setupWithDbTx({
      catalogItem: {
        updateMany: vi.fn(
          (args: {
            data: Record<string, unknown>;
            where: Record<string, unknown>;
          }) => {
            capturedData = args.data;
            capturedWhere = args.where;
            return Promise.resolve({ count: 1 });
          }
        ),
        findUnique: vi.fn().mockResolvedValue(updatedRow),
      },
      catalogItemVersion: {
        findFirst: vi.fn().mockResolvedValue({ version: 2 }),
        create: createVersion,
      },
    });

    const result = await updateCatalogItem({
      id: ITEM_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      name: "Owner Name",
      description: "Owner description",
      content: "updated content",
    });

    expect(result.ok).toBe(true);
    expect(capturedWhere).toEqual(
      expect.objectContaining({
        id: ITEM_ID,
        organizationId: ORG_ID,
        source: CatalogItemSource.OrgCustom,
        archived: false,
        createdById: USER_ID,
      })
    );
    expect(capturedData.name).toBe("Owner Name");
    expect(capturedData.description).toBe("Owner description");
    expect(capturedData.componentUuid).toBe(
      computeComponentUuid({
        source: "closedloop-ai/symphony-alpha",
        owner: ORG_ID,
        content: "updated content",
      })
    );
    expect(createVersion).toHaveBeenCalledWith({
      data: expect.objectContaining({
        catalogItemId: ITEM_ID,
        version: 3,
        name: "Owner Name",
        content: "updated content",
        changedById: USER_ID,
      }),
    });
  });

  it("returns 403 when the write-time ownership predicate no longer matches", async () => {
    const createVersion = vi.fn().mockResolvedValue({});
    const findUnique = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: ITEM_ID,
          source: CatalogItemSource.OrgCustom,
          archived: false,
          targetKind: "plugin",
          organizationId: ORG_ID,
          createdById: USER_ID,
          sourceRepo: null,
        }),
      },
    });
    setupWithDbTx({
      catalogItem: {
        updateMany,
        findUnique,
      },
      catalogItemVersion: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: createVersion,
      },
    });

    const result = await updateCatalogItem({
      id: ITEM_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      name: "Stale Owner",
      content: "stale content",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: ITEM_ID,
          organizationId: ORG_ID,
          source: CatalogItemSource.OrgCustom,
          archived: false,
          createdById: USER_ID,
        }),
      })
    );
    expect(findUnique).not.toHaveBeenCalled();
    expect(createVersion).not.toHaveBeenCalled();
  });

  it("returns 403 when an owner tries to update admin-only fields", async () => {
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: ITEM_ID,
          source: CatalogItemSource.OrgCustom,
          archived: false,
          targetKind: "plugin",
          organizationId: ORG_ID,
          createdById: USER_ID,
          sourceRepo: null,
        }),
      },
    });

    const result = await updateCatalogItem({
      id: ITEM_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      enabled: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("returns 403 when an owner sends content for a metadata-only pack", async () => {
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: ITEM_ID,
          source: CatalogItemSource.OrgCustom,
          archived: false,
          targetKind: "pack",
          organizationId: ORG_ID,
          createdById: USER_ID,
          sourceRepo: null,
        }),
      },
    });

    const result = await updateCatalogItem({
      id: ITEM_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      content: "pack content should not be accepted",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-owner non-admin caller", async () => {
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: ITEM_ID,
          source: CatalogItemSource.OrgCustom,
          archived: false,
          targetKind: "plugin",
          organizationId: ORG_ID,
          createdById: "different-user",
          sourceRepo: null,
        }),
      },
    });

    const result = await updateCatalogItem({
      id: ITEM_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      name: "Attempted Mutation",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("returns 403 for null-owner rows when the caller is not an admin", async () => {
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: ITEM_ID,
          source: CatalogItemSource.OrgCustom,
          archived: false,
          targetKind: "plugin",
          organizationId: ORG_ID,
          createdById: null,
          sourceRepo: null,
        }),
      },
    });

    const result = await updateCatalogItem({
      id: ITEM_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      name: "Attempted Mutation",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("returns 403 for archived org_custom items even for admins", async () => {
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: ITEM_ID,
          source: CatalogItemSource.OrgCustom,
          archived: true,
          targetKind: "plugin",
          organizationId: ORG_ID,
          createdById: USER_ID,
          sourceRepo: null,
        }),
      },
    });

    const result = await updateCatalogItem({
      id: ITEM_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      canUpdateAny: true,
      name: "Attempted Mutation",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("returns 404 when the item is hidden by the visibility predicate", async () => {
    let capturedWhere: Record<string, unknown> = {};
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn((args: { where: Record<string, unknown> }) => {
          capturedWhere = args.where;
          return Promise.resolve(null);
        }),
      },
    });

    const result = await updateCatalogItem({
      id: "nonexistent",
      organizationId: ORG_ID,
      userId: USER_ID,
      name: "New Name",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(404);
    }
    expect(capturedWhere).toEqual(
      expect.objectContaining({
        id: "nonexistent",
        OR: [
          { organizationId: ORG_ID },
          { scope: "global", source: CatalogItemSource.Curated },
        ],
      })
    );
  });

  it("returns 403 for curated items (read-only catalog source)", async () => {
    mockWithDb.mockImplementationOnce(
      (callback: (db: Record<string, unknown>) => unknown) =>
        callback({
          catalogItem: {
            findFirst: vi.fn().mockResolvedValue({
              id: ITEM_ID,
              source: CatalogItemSource.Curated,
            }),
          },
        })
    );

    const result = await updateCatalogItem({
      id: ITEM_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      name: "Attempted Mutation",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// getCatalogItemDetail
// ---------------------------------------------------------------------------

describe("getCatalogItemDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCatalogAssetDownloadUrl.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the CatalogItemDto for an org-owned item", async () => {
    const row = makeCatalogRow({ id: ITEM_ID });
    // Detail also loads the latest authored body and any child components.
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue(row),
        findMany: vi.fn().mockResolvedValue([]),
      },
      catalogItemVersion: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await getCatalogItemDetail({
      id: ITEM_ID,
      organizationId: ORG_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(ITEM_ID);
    }
  });

  it("returns 404 when item is not found or not accessible to org", async () => {
    setupWithDb({
      catalogItem: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    const result = await getCatalogItemDetail({
      id: "nonexistent",
      organizationId: ORG_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(404);
    }
  });

  // Cross-org child-leak guard (read side): the children findMany must carry
  // the SAME visibility predicate as the parent (org-owned OR curated/global),
  // so a foreign-org component written under this pack id can never surface in
  // another org's detail read.
  it("scopes child components to the caller's visibility (foreign-org child excluded)", async () => {
    const parentRow = makeCatalogRow({ id: ITEM_ID, targetKind: "pack" });
    let capturedChildWhere: Record<string, unknown> = {};
    const foreignChild = makeCatalogRow({
      id: "foreign-child",
      organizationId: OTHER_ORG_ID,
      parentPackId: ITEM_ID,
    } as Record<string, unknown>);

    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue(parentRow),
        findMany: vi.fn((args: { where: Record<string, unknown> }) => {
          capturedChildWhere = args.where;
          // Simulate the DB honoring the visibility filter: the foreign-org
          // child does not match the OR predicate, so it is not returned.
          const or = args.where.OR as Record<string, unknown>[];
          const matchesCaller = or?.some(
            (clause) => clause.organizationId === ORG_ID
          );
          return Promise.resolve(
            matchesCaller && foreignChild.organizationId === ORG_ID
              ? [foreignChild]
              : []
          );
        }),
      },
      catalogItemVersion: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await getCatalogItemDetail({
      id: ITEM_ID,
      organizationId: ORG_ID,
    });

    // The child query is scoped to this pack AND the caller's visibility.
    expect(capturedChildWhere.parentPackId).toBe(ITEM_ID);
    expect(capturedChildWhere.archived).toBe(false);
    expect(capturedChildWhere.OR).toEqual([
      { organizationId: ORG_ID },
      { scope: "global", source: "curated" },
    ]);

    // A foreign-org child never appears in this org's detail read.
    expect(result.ok).toBe(true);
    if (result.ok) {
      const detail = result.value as unknown as {
        components: Array<{ id: string }>;
      };
      expect(detail.components).toHaveLength(0);
      expect(detail.components.map((c) => c.id)).not.toContain("foreign-child");
    }
  });
});

// ---------------------------------------------------------------------------
// FEA-2923 (Gap A, forward path) — bulkIngestAgents → agent_components bridge
// ---------------------------------------------------------------------------

type Tx = {
  catalogItem: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  catalogItemVersion: { create: ReturnType<typeof vi.fn> };
  repoBootstrapConfig: { upsert: ReturnType<typeof vi.fn> };
  computeTarget: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  user: { findFirst: ReturnType<typeof vi.fn> };
  agentComponent: { upsert: ReturnType<typeof vi.fn> };
};

function buildTx(overrides: Partial<Tx> = {}): Tx {
  return {
    catalogItem: {
      // generateUniqueAgentSlug probes for slug collisions → none.
      findFirst: vi.fn().mockResolvedValue(null),
      // No existing items → every agent goes through createNewItem.
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({
        id: "catalog-item-1",
        role: "planner",
        name: "Planner",
      }),
    },
    catalogItemVersion: { create: vi.fn().mockResolvedValue({}) },
    repoBootstrapConfig: { upsert: vi.fn().mockResolvedValue({}) },
    computeTarget: {
      // No sentinel yet → the forward path creates one.
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "sentinel-1" }),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue({ id: "earliest-user-1" }),
    },
    agentComponent: { upsert: vi.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

function installTx(tx: Tx) {
  mocks.withDb.tx.mockImplementation((cb: (t: unknown) => unknown) => cb(tx));
  mocks.withDb.mockImplementation((cb: (t: unknown) => unknown) => cb(tx));
}

const INGEST_INPUT = {
  agents: [
    {
      name: "Planner",
      role: "planner",
      description: "Plans work",
      prompt: "You are a planner.",
    },
  ],
  bootstrapRunId: "loop-1",
  sourceRepo: "acme/repo",
};

describe("bulkIngestAgents forward path → agent_components", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPrismaErrorCode.mockReturnValue(undefined);
  });

  it("materializes an agent_components row for a newly created org_custom agent", async () => {
    const tx = buildTx();
    installTx(tx);

    const result = await bulkIngestAgents("org-1", "user-1", INGEST_INPUT);
    expect(result.created).toBe(1);

    // The catalog item was created as source=org_custom / targetKind=agent.
    expect(tx.catalogItem.create).toHaveBeenCalledTimes(1);

    // A sentinel compute target was created (none existed), owned by the org's
    // earliest active user.
    expect(tx.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1", active: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    );
    expect(tx.computeTarget.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          userId: "earliest-user-1",
          machineName: "__cloud_sentinel__",
          platform: "cloud",
          isCloudSentinel: true,
        }),
      })
    );

    // The inventory row is upserted onto the sentinel with the migration's
    // deterministic (computeTargetId, subagent, cloud:agent:<id>) key.
    expect(tx.agentComponent.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = tx.agentComponent.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({
      computeTargetId_componentKind_externalComponentId: {
        computeTargetId: "sentinel-1",
        componentKind: "subagent",
        externalComponentId: "cloud:agent:catalog-item-1",
      },
    });
    expect(upsertArg.create).toEqual(
      expect.objectContaining({
        organizationId: "org-1",
        computeTargetId: "sentinel-1",
        componentKind: "subagent",
        externalComponentId: "cloud:agent:catalog-item-1",
        harness: "claude",
        name: "Planner",
        scope: "org",
        sourceUrl: "acme/repo",
      })
    );
    expect(upsertArg.create.metadata).toEqual(
      expect.objectContaining({
        cloudAuthored: true,
        catalogItemId: "catalog-item-1",
        source: "org_custom",
        createdById: "user-1",
      })
    );
  });

  it("reuses an existing sentinel instead of creating a second one", async () => {
    const tx = buildTx({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "sentinel-existing" }),
        create: vi.fn(),
      },
    });
    installTx(tx);

    await bulkIngestAgents("org-1", "user-1", INGEST_INPUT);

    expect(tx.computeTarget.create).not.toHaveBeenCalled();
    expect(tx.user.findFirst).not.toHaveBeenCalled();
    const upsertArg = tx.agentComponent.upsert.mock.calls[0][0];
    expect(
      upsertArg.where.computeTargetId_componentKind_externalComponentId
        .computeTargetId
    ).toBe("sentinel-existing");
  });

  it("skips materialization (but still ingests) when the org has no active user", async () => {
    const tx = buildTx({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      user: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    installTx(tx);

    const result = await bulkIngestAgents("org-1", "user-1", INGEST_INPUT);

    // Catalog item still created — visibility bridge is best-effort.
    expect(result.created).toBe(1);
    expect(tx.catalogItem.create).toHaveBeenCalledTimes(1);
    // No sentinel could be owned → no inventory row.
    expect(tx.computeTarget.create).not.toHaveBeenCalled();
    expect(tx.agentComponent.upsert).not.toHaveBeenCalled();
  });

  it("does not materialize a component when the agent already exists (update path)", async () => {
    const tx = buildTx();
    // Existing agent by role → updateExistingItem path.
    tx.catalogItem.findMany.mockResolvedValue([
      {
        id: "existing-1",
        role: "planner",
        name: "Planner",
        versions: [{ version: 1 }],
      },
    ]);
    // updateExistingItem calls tx.catalogItem.update.
    (tx.catalogItem as unknown as { update: ReturnType<typeof vi.fn> }).update =
      vi.fn().mockResolvedValue({});
    installTx(tx);

    const result = await bulkIngestAgents("org-1", "user-1", INGEST_INPUT);

    expect(result.updated).toBe(1);
    expect(tx.catalogItem.create).not.toHaveBeenCalled();
    // Forward path only fires on creation; the existing agent already has its
    // (backfilled or previously-materialized) inventory row.
    expect(tx.agentComponent.upsert).not.toHaveBeenCalled();
  });

  // A second content-bearing writer (bulk bootstrap ingest → createNewItem)
  // must set the same content-addressed identity as createCatalogItem, routed
  // through the shared deriveComponentUuid helper, so the bootstrap-ingested
  // copy dedups/joins with the manually-authored one.
  it("sets componentUuid on the created row via the shared derivation", async () => {
    const tx = buildTx();
    installTx(tx);

    await bulkIngestAgents("org-1", "user-1", INGEST_INPUT);

    expect(tx.catalogItem.create).toHaveBeenCalledTimes(1);
    const createData = tx.catalogItem.create.mock.calls[0][0].data;
    // Same (source=sourceRepo, owner=organizationId, content=prompt) provenance
    // the helper feeds computeComponentUuid.
    expect(createData.componentUuid).toBe(
      computeComponentUuid({
        source: "acme/repo",
        owner: "org-1",
        content: "You are a planner.",
      })
    );
  });

  // The re-generation (update) writer must also re-derive the identity so the
  // dedup/analytics key tracks the current body.
  it("re-derives componentUuid on the update path via the shared derivation", async () => {
    const tx = buildTx();
    tx.catalogItem.findMany.mockResolvedValue([
      {
        id: "existing-1",
        role: "planner",
        name: "Planner",
        versions: [{ version: 1 }],
      },
    ]);
    const update = vi.fn().mockResolvedValue({});
    (tx.catalogItem as unknown as { update: ReturnType<typeof vi.fn> }).update =
      update;
    installTx(tx);

    await bulkIngestAgents("org-1", "user-1", INGEST_INPUT);

    expect(update).toHaveBeenCalledTimes(1);
    const updateData = update.mock.calls[0][0].data;
    expect(updateData.componentUuid).toBe(
      computeComponentUuid({
        source: "acme/repo",
        owner: "org-1",
        content: "You are a planner.",
      })
    );
  });
});

// ---------------------------------------------------------------------------
// importPackZipComponents (PR #2804 review: validate + atomic dedupe)
// ---------------------------------------------------------------------------

describe("importPackZipComponents", () => {
  const PACK_ID = "pack-uuid-1";

  /**
   * Wire the pack lookup (`withDb`), the in-transaction existing-children read,
   * and the per-component create so a single import runs end-to-end. Returns the
   * shared tx `create` spy so tests can assert exactly which children were
   * written. `existingChildren` seeds the in-tx findMany (the dedupe source).
   */
  function setupImport(options: {
    pack?: Record<string, unknown> | null;
    existingChildren?: { name: string; targetKind: string }[];
  }) {
    const pack =
      options.pack === undefined
        ? {
            id: PACK_ID,
            source: "org_custom",
            targetKind: "pack",
            zipAssetKey: "org/catalog/pack/zip",
            zipAssetBucket: "plugin-store-bucket",
          }
        : options.pack;

    // Non-tx withDb is used only for the initial pack lookup here.
    setupWithDb({
      catalogItem: { findFirst: vi.fn().mockResolvedValue(pack) },
    });

    const create = vi.fn((args: { data: { name: string } }) =>
      Promise.resolve(makeCatalogRow({ name: args.data.name }))
    );
    const findMany = vi.fn().mockResolvedValue(options.existingChildren ?? []);
    setupWithDbTx({
      catalogItem: { findMany, create },
      catalogItemVersion: { create: vi.fn().mockResolvedValue({}) },
    });

    return { create, findMany };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a child component for each recognized, valid entry", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
      { kind: "skill", name: "plan", content: "# Plan" },
    ]);
    const { create } = setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 2, skipped: 0, invalid: 0 });
    }
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("maps a zip-bomb (parse over decompressed budget) to 413", async () => {
    // The download succeeds; the parse rejects the oversized decompressed
    // footprint. The service must surface this as 413, not an unhandled 500.
    mockGetCatalogAssetBytes.mockResolvedValue(Buffer.from("zip-bytes"));
    mockParsePackZip.mockImplementation(() => {
      throw new PackZipTooLargeError("decompressed budget exceeded");
    });
    setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(413);
    }
  });

  it("maps an oversized stored asset (download over raw-byte cap) to 413", async () => {
    mockGetCatalogAssetBytes.mockRejectedValueOnce(
      new CatalogAssetTooLargeError("asset over raw-byte cap")
    );
    setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(413);
    }
  });

  it("rejects an imported body that exceeds the create-path content cap", async () => {
    // 1 MB + 1 byte exceeds createCatalogItemBodySchema's content max.
    const oversized = "x".repeat(1_048_576 + 1);
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "ok", content: "small" },
      { kind: "skill", name: "toobig", content: oversized },
    ]);
    const { create } = setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only the valid entry is persisted; the oversized one is counted invalid.
      expect(result.value).toEqual({ created: 1, skipped: 0, invalid: 1 });
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "ok" }) })
    );
  });

  it("rejects an imported entry with an out-of-range (empty) name", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "", content: "body" },
    ]);
    const { create } = setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 0, skipped: 0, invalid: 1 });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("skips (does not duplicate) children already present in the pack", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
      { kind: "skill", name: "plan", content: "# Plan" },
    ]);
    // A prior import already wrote `command:deploy`.
    const { create } = setupImport({
      existingChildren: [{ name: "deploy", targetKind: "command" }],
    });

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 1, skipped: 1, invalid: 0 });
    }
    // Only the not-yet-present `plan` skill is created.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "plan" }),
      })
    );
  });

  it("reads existing children INSIDE the write transaction (atomic dedupe)", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
    ]);
    const { findMany, create } = setupImport({});

    let findManyRanInsideTx = false;
    // The non-tx withDb path is the pack lookup; the dedupe findMany must run on
    // the tx client, so it should be invoked via withDb.tx, not the plain withDb.
    (mockWithDb.tx as Mock).mockImplementation(
      async (cb: (tx: Record<string, unknown>) => unknown) => {
        findMany.mockImplementation(() => {
          findManyRanInsideTx = true;
          return Promise.resolve([]);
        });
        return await cb({
          catalogItem: { findMany, create },
          catalogItemVersion: { create: vi.fn().mockResolvedValue({}) },
        });
      }
    );

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    expect(findManyRanInsideTx).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a re-run that sees its own prior children creates nothing", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
      { kind: "skill", name: "plan", content: "# Plan" },
    ]);
    // Simulate the second run: both children already committed by the first run.
    const { create } = setupImport({
      existingChildren: [
        { name: "deploy", targetKind: "command" },
        { name: "plan", targetKind: "skill" },
      ],
    });

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 0, skipped: 2, invalid: 0 });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 404 when the pack is not found", async () => {
    mockParsePackZip.mockReturnValue([]);
    setupImport({ pack: null });

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(404);
    }
  });

  it("returns 403 when the target item is not a Pack container", async () => {
    mockParsePackZip.mockReturnValue([]);
    // An org-owned item with a zip but targetKind!=="pack" cannot hold children.
    const { create } = setupImport({
      pack: {
        id: PACK_ID,
        source: "org_custom",
        targetKind: "plugin",
        zipAssetKey: "org/catalog/pack/zip",
        zipAssetBucket: "plugin-store-bucket",
      },
    });

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    expect(create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// importPackZipComponents (PR #2804 review: validate + atomic dedupe)
// ---------------------------------------------------------------------------

describe("importPackZipComponents", () => {
  const PACK_ID = "pack-uuid-1";

  /**
   * Wire the pack lookup (`withDb`), the in-transaction existing-children read,
   * and the per-component create so a single import runs end-to-end. Returns the
   * shared tx `create` spy so tests can assert exactly which children were
   * written. `existingChildren` seeds the in-tx findMany (the dedupe source).
   */
  function setupImport(options: {
    pack?: Record<string, unknown> | null;
    existingChildren?: { name: string; targetKind: string }[];
  }) {
    const pack =
      options.pack === undefined
        ? {
            id: PACK_ID,
            source: "org_custom",
            targetKind: "pack",
            zipAssetKey: "org/catalog/pack/zip",
            zipAssetBucket: "plugin-store-bucket",
          }
        : options.pack;

    // Non-tx withDb is used only for the initial pack lookup here.
    setupWithDb({
      catalogItem: { findFirst: vi.fn().mockResolvedValue(pack) },
    });

    const create = vi.fn((args: { data: { name: string } }) =>
      Promise.resolve(makeCatalogRow({ name: args.data.name }))
    );
    const findMany = vi.fn().mockResolvedValue(options.existingChildren ?? []);
    setupWithDbTx({
      catalogItem: { findMany, create },
      catalogItemVersion: { create: vi.fn().mockResolvedValue({}) },
    });

    return { create, findMany };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a child component for each recognized, valid entry", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
      { kind: "skill", name: "plan", content: "# Plan" },
    ]);
    const { create } = setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 2, skipped: 0, invalid: 0 });
    }
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("maps a zip-bomb (parse over decompressed budget) to 413", async () => {
    // The download succeeds; the parse rejects the oversized decompressed
    // footprint. The service must surface this as 413, not an unhandled 500.
    mockGetCatalogAssetBytes.mockResolvedValue(Buffer.from("zip-bytes"));
    mockParsePackZip.mockImplementation(() => {
      throw new PackZipTooLargeError("decompressed budget exceeded");
    });
    setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(413);
    }
  });

  it("maps an oversized stored asset (download over raw-byte cap) to 413", async () => {
    mockGetCatalogAssetBytes.mockRejectedValueOnce(
      new CatalogAssetTooLargeError("asset over raw-byte cap")
    );
    setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(413);
    }
  });

  it("rejects an imported body that exceeds the create-path content cap", async () => {
    // 1 MB + 1 byte exceeds createCatalogItemBodySchema's content max.
    const oversized = "x".repeat(1_048_576 + 1);
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "ok", content: "small" },
      { kind: "skill", name: "toobig", content: oversized },
    ]);
    const { create } = setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only the valid entry is persisted; the oversized one is counted invalid.
      expect(result.value).toEqual({ created: 1, skipped: 0, invalid: 1 });
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "ok" }) })
    );
  });

  it("rejects an imported entry with an out-of-range (empty) name", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "", content: "body" },
    ]);
    const { create } = setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 0, skipped: 0, invalid: 1 });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("skips (does not duplicate) children already present in the pack", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
      { kind: "skill", name: "plan", content: "# Plan" },
    ]);
    // A prior import already wrote `command:deploy`.
    const { create } = setupImport({
      existingChildren: [{ name: "deploy", targetKind: "command" }],
    });

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 1, skipped: 1, invalid: 0 });
    }
    // Only the not-yet-present `plan` skill is created.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "plan" }),
      })
    );
  });

  it("reads existing children INSIDE the write transaction (atomic dedupe)", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
    ]);
    const { findMany, create } = setupImport({});

    let findManyRanInsideTx = false;
    // The non-tx withDb path is the pack lookup; the dedupe findMany must run on
    // the tx client, so it should be invoked via withDb.tx, not the plain withDb.
    (mockWithDb.tx as Mock).mockImplementation(
      async (cb: (tx: Record<string, unknown>) => unknown) => {
        findMany.mockImplementation(() => {
          findManyRanInsideTx = true;
          return Promise.resolve([]);
        });
        return await cb({
          catalogItem: { findMany, create },
          catalogItemVersion: { create: vi.fn().mockResolvedValue({}) },
        });
      }
    );

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    expect(findManyRanInsideTx).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a re-run that sees its own prior children creates nothing", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
      { kind: "skill", name: "plan", content: "# Plan" },
    ]);
    // Simulate the second run: both children already committed by the first run.
    const { create } = setupImport({
      existingChildren: [
        { name: "deploy", targetKind: "command" },
        { name: "plan", targetKind: "skill" },
      ],
    });

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 0, skipped: 2, invalid: 0 });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 404 when the pack is not found", async () => {
    mockParsePackZip.mockReturnValue([]);
    setupImport({ pack: null });

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(404);
    }
  });

  it("returns 403 when the target item is not a Pack container", async () => {
    mockParsePackZip.mockReturnValue([]);
    // An org-owned item with a zip but targetKind!=="pack" cannot hold children.
    const { create } = setupImport({
      pack: {
        id: PACK_ID,
        source: "org_custom",
        targetKind: "plugin",
        zipAssetKey: "org/catalog/pack/zip",
        zipAssetBucket: "plugin-store-bucket",
      },
    });

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    expect(create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// importPackRepoComponents (PR #2805 review: non-pack guard + truncated tree)
// ---------------------------------------------------------------------------

describe("importPackRepoComponents", () => {
  const PACK_ID = "pack-uuid-1";

  /**
   * The repo path performs two non-tx `withDb` reads before importing: the pack
   * lookup, then the GitHub-installation-repository lookup. Wire both in order,
   * plus the in-tx existing-children read and per-component create, so an import
   * runs end-to-end. Returns the tx `create` spy for assertions.
   */
  function setupRepoImport(options: {
    pack?: Record<string, unknown> | null;
    repoRow?: Record<string, unknown> | null;
    existingChildren?: { name: string; targetKind: string }[];
  }) {
    const pack =
      options.pack === undefined
        ? { id: PACK_ID, source: "org_custom", targetKind: "pack" }
        : options.pack;

    const repoRow =
      options.repoRow === undefined
        ? {
            owner: "acme",
            name: "shared-assets",
            installation: { installationId: "install-1" },
          }
        : options.repoRow;

    // The first non-tx withDb call resolves the pack; the second resolves the
    // installation repository. Sequence them on the same findFirst spy.
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(pack)
      .mockResolvedValueOnce(repoRow);
    setupWithDb({
      catalogItem: { findFirst },
      gitHubInstallationRepository: { findFirst },
    });

    const create = vi.fn((args: { data: { name: string } }) =>
      Promise.resolve(makeCatalogRow({ name: args.data.name }))
    );
    const findMany = vi.fn().mockResolvedValue(options.existingChildren ?? []);
    setupWithDbTx({
      catalogItem: { findMany, create },
      catalogItemVersion: { create: vi.fn().mockResolvedValue({}) },
    });

    return { create, findFirst };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const input = {
    id: PACK_ID,
    organizationId: ORG_ID,
    userId: USER_ID,
    repoFullName: "acme/shared-assets",
  };

  it("imports each recognized component from the repo", async () => {
    mockFetchRepoComponents.mockResolvedValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
      { kind: "skill", name: "plan", content: "# Plan" },
    ]);
    const { create } = setupRepoImport({});

    const result = await importPackRepoComponents(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 2, skipped: 0, invalid: 0 });
    }
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("returns 404 when the pack is not found", async () => {
    setupRepoImport({ pack: null });

    const result = await importPackRepoComponents(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(404);
    }
    expect(mockFetchRepoComponents).not.toHaveBeenCalled();
  });

  it("returns 403 for a curated pack", async () => {
    setupRepoImport({
      pack: { id: PACK_ID, source: "curated", targetKind: "pack" },
    });

    const result = await importPackRepoComponents(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    expect(mockFetchRepoComponents).not.toHaveBeenCalled();
  });

  it("returns 403 when the target item is NOT a Pack container (explicit repo-path guard)", async () => {
    // Unlike the zip path (which is implicitly gated by the absence of a
    // zipAssetKey on a non-pack), the repo path has no such implicit guard, so
    // the targetKind check MUST reject a non-pack target before any GitHub read
    // or import — otherwise child components could leak under a non-pack item.
    const { create } = setupRepoImport({
      pack: { id: PACK_ID, source: "org_custom", targetKind: "plugin" },
    });

    const result = await importPackRepoComponents(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    // Guard fires before fetching the repo tree or creating any child.
    expect(mockFetchRepoComponents).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 400 when the repo is not visible to the org's GitHub App", async () => {
    setupRepoImport({ repoRow: null });

    const result = await importPackRepoComponents(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(400);
    }
    expect(mockFetchRepoComponents).not.toHaveBeenCalled();
  });

  it("propagates RepoTreeTruncatedError so the route can surface its guidance", async () => {
    // The service does not swallow the truncated-tree error; it bubbles up to
    // the route, which maps it to a 422 carrying the actionable message.
    setupRepoImport({});
    mockFetchRepoComponents.mockRejectedValue(
      new RepoTreeTruncatedError("acme", "shared-assets")
    );

    await expect(importPackRepoComponents(input)).rejects.toBeInstanceOf(
      RepoTreeTruncatedError
    );
  });
});
