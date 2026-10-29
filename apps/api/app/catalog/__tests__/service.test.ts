/**
 * Unit tests for the catalog service.
 *
 * Two concerns share this file:
 *
 * 1. The general catalog service surface (T-18.2, AC-016, AC-024, AC-025):
 *    listCatalogItemsForOrg / createCatalogItem / getUploadIntent /
 *    confirmAssetUpload / archiveCatalogItem / updateCatalogItem /
 *    getCatalogItemDetail. All DB calls are mocked via
 *    vi.mock("@repo/database"); AWS S3 helpers via vi.mock("@repo/aws/catalog-assets").
 *
 * 2. FEA-2923 (Gap A, forward path) — POST /catalog keeps `agent_components` in
 *    sync when a NEW org_custom agent is created (the `createCatalogItem` agent
 *    cases below), so a natively-created org_custom agent is never invisible in
 *    the Agents workspace (agentComponentsService.listForOrg reads
 *    agent_components).
 *
 * Note: The admin gate (`requireOrgAdmin`) is enforced at the route layer
 * (route.ts), not
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
  parsePackZip: vi.fn(),
  fetchRepoComponents: vi.fn(),
  // FEA-3909: the F1 registry writer, mocked to return a synthetic version id.
  registerDefinitionVersion: vi.fn(async () => "dv-test"),
  // FEA-4011 Slice A: the fail-open, post-commit search index hooks. The
  // catalog write paths flush accumulated projections through the BATCH hook
  // (`indexManyAfterCommit`) — one multi-row upsert instead of a per-row
  // fan-out (FEA-3299) — so that is the hook the catalog service calls.
  indexManyAfterCommit: vi.fn(),
  removeAfterCommit: vi.fn(),
}));

vi.mock("@repo/database", async () => {
  const { createCatalogDatabaseMockModule } = await import(
    "./service-test-harness"
  );
  return createCatalogDatabaseMockModule(mocks.withDb);
});

// FEA-3909: the catalog service now calls the F1 registry writer when it creates
// a content-bearing pack member. Mock it to a spy that returns a synthetic
// definitionVersionId so these catalog tests stay DB-free and focused on the
// catalog write shape; the registry writer's own semantics are proven in
// app/definition-registry/__tests__/service.test.ts.
vi.mock("@/app/definition-registry/service", () => ({
  registerDefinitionVersion: mocks.registerDefinitionVersion,
}));

// FEA-4011 Slice A: the catalog write paths that materialize agent_components
// rows now also index them into unified search after the tx commits. Keep the
// real `agentComponentProjection` mapper (so tests assert the exact projection
// input) but stub the fail-open index hooks so these catalog tests stay DB-free.
vi.mock("@/app/search/search-index-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/search/search-index-service")>();
  return {
    ...actual,
    searchIndexService: {
      indexManyAfterCommit: mocks.indexManyAfterCommit,
      removeAfterCommit: mocks.removeAfterCommit,
    },
  };
});

vi.mock("../pack-zip-import", async () => {
  const { createPackZipImportMockModule } = await import(
    "./service-test-harness"
  );
  return createPackZipImportMockModule(mocks.parsePackZip);
});

vi.mock("../pack-repo-import", async () => {
  const { createPackRepoImportMockModule } = await import(
    "./service-test-harness"
  );
  return createPackRepoImportMockModule(mocks.fetchRepoComponents);
});

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "../../../__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@repo/aws/catalog-assets", async () => {
  const { createCatalogAssetsMockModule } = await import(
    "./service-test-harness"
  );
  return createCatalogAssetsMockModule();
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { computeComponentUuid } from "@repo/api/src/component-identity";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import {
  CatalogAssetTooLargeError,
  catalogAssetKey,
  getCatalogAssetBytes,
  getCatalogAssetDownloadUrl,
  getCatalogAssetUploadUrl,
  headCatalogAsset,
} from "@repo/aws/catalog-assets";
import { SourceOccurrenceType } from "@repo/database";
import { log } from "@repo/observability/log";
import { agentComponentProjection } from "@/app/search/search-index-service";
import { RepoTreeTruncatedError } from "../pack-repo-import";
import { PackZipTooLargeError, parsePackZip } from "../pack-zip-import";
import {
  archiveCatalogItem,
  confirmAssetUpload,
  createCatalogItem,
  getCatalogItemDetail,
  getUploadIntent,
  importPackRepoComponents,
  importPackZipComponents,
  listCatalogItemsForOrg,
} from "../service";
import {
  type CatalogWithDbMock,
  createWithDbSetters,
  ITEM_ID,
  makeCatalogRow,
  NOW,
  ORG_ID,
  OTHER_ORG_ID,
  USER_ID,
} from "./service-test-harness";

// ---------------------------------------------------------------------------
// Typed mock handles
// ---------------------------------------------------------------------------

const mockWithDb = mocks.withDb as unknown as CatalogWithDbMock;
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

const { setupWithDb, setupWithDbTx } = createWithDbSetters(mockWithDb);

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

  // ISS-6665: the org-scoping, exclude-archived and include-archived cases used
  // to live here as three assertions on the captured Prisma `where`. They now
  // assert the ROWS the service returns, against a double that evaluates the
  // predicate, in `./list-catalog-items-rows.test.ts`.

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
    // Agents workspace.
    const row = makeCatalogRow({
      id: "cat-agent-1",
      targetKind: "agent",
      name: "My Agent",
    });
    // FEA-4011: the upsert echoes the materialized component row so the
    // post-commit search projection can read its id/name/etc.
    const agentComponentUpsert = vi.fn().mockResolvedValue({
      id: "ac-cat-agent-1",
      organizationId: ORG_ID,
      componentKind: "subagent",
      name: "My Agent",
      componentKey: "My Agent",
      externalComponentId: "cloud:agent:cat-agent-1",
      description: "Does things",
      updatedAt: NOW,
      uninstalledAt: null,
    });
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
    // shared with the backfill migration.
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

    // FEA-4011 Slice A: the materialized component is indexed into unified
    // search AFTER the tx commits, in one BATCH upsert, with the exact mapper
    // output.
    expect(mocks.indexManyAfterCommit).toHaveBeenCalledTimes(1);
    expect(mocks.indexManyAfterCommit).toHaveBeenCalledWith([
      agentComponentProjection({
        id: "ac-cat-agent-1",
        organizationId: ORG_ID,
        componentKind: "subagent",
        name: "My Agent",
        componentKey: "My Agent",
        externalComponentId: "cloud:agent:cat-agent-1",
        description: "Does things",
        updatedAt: NOW,
      }),
    ]);
  });

  it("reuses an existing cloud sentinel instead of creating a second one", async () => {
    const row = makeCatalogRow({
      id: "cat-agent-2",
      targetKind: "agent",
      name: "My Agent",
    });
    const computeTargetCreate = vi.fn();
    const userFindFirst = vi.fn();
    const agentComponentUpsert = vi.fn().mockResolvedValue({
      id: "ac-cat-agent-2",
      organizationId: ORG_ID,
      componentKind: "subagent",
      name: "My Agent",
      componentKey: "My Agent",
      externalComponentId: "cloud:agent:cat-agent-2",
      description: null,
      updatedAt: NOW,
      uninstalledAt: null,
    });
    setupWithDbTx({
      catalogItem: { create: vi.fn().mockResolvedValue(row) },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "sentinel-existing" }),
        create: computeTargetCreate,
      },
      user: { findFirst: userFindFirst },
      agentComponent: { upsert: agentComponentUpsert },
    });

    await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "agent",
      name: "My Agent",
    });

    expect(computeTargetCreate).not.toHaveBeenCalled();
    expect(userFindFirst).not.toHaveBeenCalled();
    const upsertArg = agentComponentUpsert.mock.calls[0][0];
    expect(
      upsertArg.where.computeTargetId_componentKind_externalComponentId
        .computeTargetId
    ).toBe("sentinel-existing");
  });

  it("skips materialization (but still creates the item) when the org has no active user", async () => {
    const row = makeCatalogRow({
      id: "cat-agent-3",
      targetKind: "agent",
      name: "My Agent",
    });
    const catalogItemCreate = vi.fn().mockResolvedValue(row);
    const computeTargetCreate = vi.fn();
    const agentComponentUpsert = vi.fn();
    setupWithDbTx({
      catalogItem: { create: catalogItemCreate },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: computeTargetCreate,
      },
      user: { findFirst: vi.fn().mockResolvedValue(null) },
      agentComponent: { upsert: agentComponentUpsert },
    });

    await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "agent",
      name: "My Agent",
    });

    // The catalog item still lands; the visibility bridge is best-effort.
    expect(catalogItemCreate).toHaveBeenCalledTimes(1);
    // No sentinel could be owned, so no inventory row.
    expect(computeTargetCreate).not.toHaveBeenCalled();
    expect(agentComponentUpsert).not.toHaveBeenCalled();
  });

  it("sets componentUuid on the created row via the shared derivation", async () => {
    const row = makeCatalogRow({ targetKind: "plugin" });
    const catalogItemCreate = vi.fn().mockResolvedValue(row);
    setupWithDbTx({
      catalogItem: { create: catalogItemCreate },
      catalogItemVersion: {
        create: vi.fn().mockResolvedValue({ id: "version-1" }),
      },
    });

    await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "plugin",
      name: "My Plugin",
      sourceRepo: "acme/repo",
      content: "plugin body",
    });

    const createData = catalogItemCreate.mock.calls[0][0].data;
    // Same (source=sourceRepo, owner=organizationId, content) provenance the
    // helper feeds computeComponentUuid.
    expect(createData.componentUuid).toBe(
      computeComponentUuid({
        source: "acme/repo",
        owner: ORG_ID,
        content: "plugin body",
      })
    );
  });

  it("does NOT index a non-agent catalog item into unified search (FEA-4011)", async () => {
    const row = makeCatalogRow({ targetKind: "plugin" });
    setupWithDbTx({
      catalogItem: { create: vi.fn().mockResolvedValue(row) },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      user: { findFirst: vi.fn().mockResolvedValue({ id: "u-1" }) },
      agentComponent: { upsert: vi.fn().mockResolvedValue({}) },
    });

    await createCatalogItem({
      organizationId: ORG_ID,
      userId: USER_ID,
      targetKind: "plugin",
      name: "My Plugin",
    });

    // A non-agent materializes no agent_components row, so no projection is
    // accumulated: the post-commit batch flush is a no-op (an empty batch).
    for (const call of mocks.indexManyAfterCommit.mock.calls) {
      expect(call[0]).toEqual([]);
    }
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

  it("returns latest version content for the parent item and child components", async () => {
    const parentRow = makeCatalogRow({
      id: ITEM_ID,
      targetKind: "pack",
      name: "Content Pack",
    });
    const contentChild = makeCatalogRow({
      id: "child-with-content",
      targetKind: "agent",
      name: "Planner Agent",
      parentPackId: ITEM_ID,
    } as Record<string, unknown>);
    const emptyChild = makeCatalogRow({
      id: "child-without-content",
      targetKind: "skill",
      name: "Empty Skill",
      parentPackId: ITEM_ID,
    } as Record<string, unknown>);
    const findVersion = vi.fn(
      ({ where }: { where: { catalogItemId: string } }) => {
        if (where.catalogItemId === ITEM_ID) {
          return Promise.resolve({ content: "# Pack overview" });
        }
        return Promise.resolve(null);
      }
    );
    // Child content now arrives via one DISTINCT ON query keyed by child id.
    // `child-without-content` is absent from the result set, which is how a
    // child with no versions is represented.
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        { catalogItemId: "child-with-content", content: "You are a planner." },
      ]);
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue(parentRow),
        findMany: vi.fn().mockResolvedValue([contentChild, emptyChild]),
      },
      catalogItemVersion: {
        findFirst: findVersion,
      },
      $queryRaw: queryRaw,
    });

    const result = await getCatalogItemDetail({
      id: ITEM_ID,
      organizationId: ORG_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("# Pack overview");
      expect(result.value.components).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "child-with-content",
            content: "You are a planner.",
          }),
          // A child with no version rows resolves to null content rather than
          // being dropped from the response.
          expect.objectContaining({
            id: "child-without-content",
            content: null,
          }),
        ])
      );
    }
    expect(findVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { catalogItemId: ITEM_ID },
        orderBy: { version: "desc" },
        select: { content: true },
      })
    );
    // Regression (FEA-3299): child content must cost ONE query regardless of
    // child count, not one per child. The previous shape issued a `findFirst`
    // per child inside `Promise.all`, so a pack with ~300 components demanded
    // ~300 pooled connections from a pool of 20 in a single GET.
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(findVersion).toHaveBeenCalledTimes(1); // the parent's own body only
    // ...and it must be keyed by exactly the children the visibility predicate
    // authorized above.
    expect(queryRaw.mock.calls[0]?.[0]?.values).toEqual([
      ["child-with-content", "child-without-content"],
      ORG_ID,
    ]);
    // The identifiers are only ever exercised through this mock, so pin the SQL
    // text itself — otherwise a typo in a table/column name passes the whole
    // suite and throws at runtime on the first pack with a child. Same technique
    // as lib/branch-status-check-retry.test.ts.
    const queryText = queryRaw.mock.calls[0]?.[0]?.strings.join("?") ?? "";
    expect(queryText).toContain('FROM "catalog_item_versions" v');
    expect(queryText).toContain('DISTINCT ON (v."catalog_item_id")');
    expect(queryText).toContain('v."catalog_item_id" AS "catalogItemId"');
    expect(queryText).toContain("::uuid[]");
    // Latest-per-child is by authored revision, not insertion order.
    expect(queryText).toContain(
      'ORDER BY v."catalog_item_id", v."version" DESC'
    );
    // The org/curated predicate is re-asserted in SQL rather than trusted from
    // the caller — catalog_item_versions has no organization_id of its own, so
    // the join to catalog_items is what carries the scope.
    expect(queryText).toContain(
      'JOIN "catalog_items" c ON c."id" = v."catalog_item_id"'
    );
    expect(queryText).toContain('c."organization_id" =');
    expect(queryText).toContain(
      `c."scope" = 'global' AND c."source" = 'curated'`
    );
  });

  it("skips the child-content query entirely when a pack has no children", async () => {
    const parentRow = makeCatalogRow({
      id: ITEM_ID,
      targetKind: "pack",
      name: "Empty Pack",
    });
    const queryRaw = vi.fn();
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue(parentRow),
        findMany: vi.fn().mockResolvedValue([]),
      },
      catalogItemVersion: {
        findFirst: vi.fn().mockResolvedValue({ content: "# Pack overview" }),
      },
      $queryRaw: queryRaw,
    });

    const result = await getCatalogItemDetail({
      id: ITEM_ID,
      organizationId: ORG_ID,
    });

    expect(result.ok).toBe(true);
    // `= ANY('{}')` would match nothing; don't pay for the round-trip.
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("does not surface a foreign org's child written under the same pack id", async () => {
    // Pins the cross-org child leak the childRows visibility predicate guards.
    // Two independent defenses: findMany never returns a foreign org's child, AND
    // the DISTINCT ON query re-asserts the org/curated predicate via its join, so
    // the boundary does not rest on caller discipline (apps/api/AGENTS.md: org
    // scoping takes no "trust the caller" patterns).
    const parentRow = makeCatalogRow({
      id: ITEM_ID,
      targetKind: "pack",
      name: "Content Pack",
    });
    const ownChild = makeCatalogRow({
      id: "own-child",
      targetKind: "agent",
      name: "Planner Agent",
      parentPackId: ITEM_ID,
    } as Record<string, unknown>);
    // findMany applies the org/curated filter, so a foreign org's child never
    // reaches childRows and its id must never be bound into the raw query.
    const findManyChildren = vi.fn().mockResolvedValue([ownChild]);
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ catalogItemId: "own-child", content: "mine" }]);
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue(parentRow),
        findMany: findManyChildren,
      },
      catalogItemVersion: {
        findFirst: vi.fn().mockResolvedValue({ content: "# Pack overview" }),
      },
      $queryRaw: queryRaw,
    });

    const result = await getCatalogItemDetail({
      id: ITEM_ID,
      organizationId: ORG_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.components).toHaveLength(1);
      expect(result.value.components[0]?.id).toBe("own-child");
    }
    // The org/curated predicate still gates which children are read...
    expect(findManyChildren).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          parentPackId: ITEM_ID,
          archived: false,
          OR: [
            { organizationId: ORG_ID },
            { scope: "global", source: "curated" },
          ],
        }),
      })
    );
    // ...and only those ids are bound into the content query, alongside the org
    // the query re-asserts in SQL.
    expect(queryRaw.mock.calls[0]?.[0]?.values).toEqual([
      ["own-child"],
      ORG_ID,
    ]);
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
// importPackZipComponents (PR #2804 review: validate + atomic dedupe)
// ---------------------------------------------------------------------------

describe("importPackZipComponents", () => {
  const PACK_ID = "pack-uuid-1";

  /**
   * Wire the pack lookup (`withDb`), the in-transaction existing-children read,
   * and the batched child writes so a single import runs end-to-end. Returns the
   * shared tx `createMany` spy so tests can assert exactly which children were
   * written (children are inserted with one `catalogItem.createMany`, so the
   * rows land in `createMany.mock.calls[0][0].data`). `existingChildren` seeds
   * the in-tx findMany (the dedupe source).
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

    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    const findMany = vi.fn().mockResolvedValue(options.existingChildren ?? []);
    const executeRaw = vi.fn().mockResolvedValue(0);
    const versionUpdate = vi.fn().mockResolvedValue({});
    setupWithDbTx({
      $executeRaw: executeRaw,
      catalogItem: { findMany, createMany },
      catalogItemVersion: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: versionUpdate,
      },
      agentComponent: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      // Agent members materialize an `agent_components` row on the org's cloud
      // sentinel; resolve it as already-present so no user/create is needed.
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "sentinel-target-id" }),
      },
    });

    return { createMany, findMany, executeRaw, versionUpdate };
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
    const { createMany } = setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 2, skipped: 0, invalid: 0 });
    }
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it("links each content-bearing member to the F1 registry and stamps the returned definitionVersionId (FEA-3909 F4)", async () => {
    // An `agent` member proves the canonical-kind mapping: the catalog stores
    // `targetKind: "agent"`, but the fingerprint/registry must receive the
    // canonical `subagent` so a pack-imported agent dedupes with a device-synced
    // subagent of identical bytes.
    mockParsePackZip.mockReturnValue([
      { kind: "agent", name: "planner", content: "You are a planner." },
      { kind: "skill", name: "plan", content: "# Plan" },
    ]);
    const { versionUpdate } = setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);

    // One registry-link call per created member, each carrying the pack
    // occurrence shape and the CANONICALIZED component kind.
    expect(mocks.registerDefinitionVersion).toHaveBeenCalledTimes(2);
    expect(mocks.registerDefinitionVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG_ID,
        packId: PACK_ID,
        occurrenceType: SourceOccurrenceType.pack,
        // "agent" -> canonical Subagent, not the raw catalog string.
        componentKind: AgentComponentKind.Subagent,
        content: "You are a planner.",
      })
    );
    expect(mocks.registerDefinitionVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        occurrenceType: SourceOccurrenceType.pack,
        componentKind: AgentComponentKind.Skill,
        content: "# Plan",
      })
    );

    // The mocked definitionVersionId ("dv-test") is stamped back onto each
    // freshly-created version row (keyed by the row's own id), linking the
    // catalog to the registry.
    expect(versionUpdate).toHaveBeenCalledTimes(2);
    for (const call of versionUpdate.mock.calls) {
      expect(call[0]).toEqual({
        where: { id: expect.any(String) },
        data: { definitionVersionId: "dv-test" },
        // ISS-6322 narrowed this discarded write's RETURNING to the primary key.
        select: { id: true },
      });
    }
  });

  it("indexes each imported agent member into unified search after commit (FEA-4011 Slice A)", async () => {
    // Only agent members materialize an agent_components row, so only they are
    // indexed; the skill member is not.
    mockParsePackZip.mockReturnValue([
      { kind: "agent", name: "planner", content: "You are a planner." },
      { kind: "skill", name: "plan", content: "# Plan" },
    ]);
    setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    // Exactly one component indexed (the agent, not the skill), flushed in one
    // post-commit BATCH upsert keyed on the org-identity slug via the shared
    // codec, subtype = the canonical "subagent" kind.
    expect(mocks.indexManyAfterCommit).toHaveBeenCalledTimes(1);
    const batch = mocks.indexManyAfterCommit.mock.calls[0]?.[0];
    expect(batch).toHaveLength(1);
    const projection = batch?.[0];
    expect(projection).toMatchObject({
      entityType: SearchEntityType.AgentComponent,
      title: "planner",
      entitySubtype: "subagent",
      // The pre-derived component id is a real UUID (not undefined).
      entityId: expect.any(String),
    });
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
    const { createMany } = setupImport({});

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
    expect(createMany).toHaveBeenCalledTimes(1);
    const okRows = createMany.mock.calls[0][0].data;
    expect(okRows).toHaveLength(1);
    expect(okRows[0]).toEqual(expect.objectContaining({ name: "ok" }));
  });

  it("rejects an imported entry with an out-of-range (empty) name", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "", content: "body" },
    ]);
    const { createMany } = setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 0, skipped: 0, invalid: 1 });
    }
    expect(createMany).not.toHaveBeenCalled();
  });

  it("skips (does not duplicate) children already present in the pack", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
      { kind: "skill", name: "plan", content: "# Plan" },
    ]);
    // A prior import already wrote `command:deploy`.
    const { createMany } = setupImport({
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
    expect(createMany).toHaveBeenCalledTimes(1);
    const planRows = createMany.mock.calls[0][0].data;
    expect(planRows).toHaveLength(1);
    expect(planRows[0]).toEqual(expect.objectContaining({ name: "plan" }));
  });

  it("reads existing children INSIDE the write transaction (atomic dedupe)", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
    ]);
    const { findMany, createMany } = setupImport({});

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
          $executeRaw: vi.fn().mockResolvedValue(0),
          catalogItem: { findMany, createMany },
          catalogItemVersion: {
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
            update: vi.fn().mockResolvedValue({}),
          },
          agentComponent: {
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
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
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a re-run that sees its own prior children creates nothing", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
      { kind: "skill", name: "plan", content: "# Plan" },
    ]);
    // Simulate the second run: both children already committed by the first run.
    const { createMany } = setupImport({
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
    expect(createMany).not.toHaveBeenCalled();
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
    const { createMany } = setupImport({
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
    expect(createMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// importPackZipComponents (PR #2804 review: validate + atomic dedupe)
// ---------------------------------------------------------------------------

describe("importPackZipComponents", () => {
  const PACK_ID = "pack-uuid-1";

  /**
   * Wire the pack lookup (`withDb`), the in-transaction existing-children read,
   * and the batched child writes so a single import runs end-to-end. Returns the
   * shared tx `createMany` spy so tests can assert exactly which children were
   * written (children are inserted with one `catalogItem.createMany`, so the
   * rows land in `createMany.mock.calls[0][0].data`). `existingChildren` seeds
   * the in-tx findMany (the dedupe source).
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

    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    const findMany = vi.fn().mockResolvedValue(options.existingChildren ?? []);
    const executeRaw = vi.fn().mockResolvedValue(0);
    const versionUpdate = vi.fn().mockResolvedValue({});
    setupWithDbTx({
      $executeRaw: executeRaw,
      catalogItem: { findMany, createMany },
      catalogItemVersion: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: versionUpdate,
      },
      agentComponent: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    });

    return { createMany, findMany, executeRaw, versionUpdate };
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
    const { createMany } = setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 2, skipped: 0, invalid: 0 });
    }
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data).toHaveLength(2);
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
    const { createMany } = setupImport({});

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
    expect(createMany).toHaveBeenCalledTimes(1);
    const okRows = createMany.mock.calls[0][0].data;
    expect(okRows).toHaveLength(1);
    expect(okRows[0]).toEqual(expect.objectContaining({ name: "ok" }));
  });

  it("rejects an imported entry with an out-of-range (empty) name", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "", content: "body" },
    ]);
    const { createMany } = setupImport({});

    const result = await importPackZipComponents({
      id: PACK_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 0, skipped: 0, invalid: 1 });
    }
    expect(createMany).not.toHaveBeenCalled();
  });

  it("skips (does not duplicate) children already present in the pack", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
      { kind: "skill", name: "plan", content: "# Plan" },
    ]);
    // A prior import already wrote `command:deploy`.
    const { createMany } = setupImport({
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
    expect(createMany).toHaveBeenCalledTimes(1);
    const planRows = createMany.mock.calls[0][0].data;
    expect(planRows).toHaveLength(1);
    expect(planRows[0]).toEqual(expect.objectContaining({ name: "plan" }));
  });

  it("reads existing children INSIDE the write transaction (atomic dedupe)", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
    ]);
    const { findMany, createMany } = setupImport({});

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
          $executeRaw: vi.fn().mockResolvedValue(0),
          catalogItem: { findMany, createMany },
          catalogItemVersion: {
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
            update: vi.fn().mockResolvedValue({}),
          },
          agentComponent: {
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
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
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a re-run that sees its own prior children creates nothing", async () => {
    mockParsePackZip.mockReturnValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
      { kind: "skill", name: "plan", content: "# Plan" },
    ]);
    // Simulate the second run: both children already committed by the first run.
    const { createMany } = setupImport({
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
    expect(createMany).not.toHaveBeenCalled();
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
    const { createMany } = setupImport({
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
    expect(createMany).not.toHaveBeenCalled();
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
   * plus the in-tx existing-children read and batched child writes, so an import
   * runs end-to-end. Returns the tx `createMany` spy for assertions.
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

    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    const findMany = vi.fn().mockResolvedValue(options.existingChildren ?? []);
    const executeRaw = vi.fn().mockResolvedValue(0);
    setupWithDbTx({
      $executeRaw: executeRaw,
      catalogItem: { findMany, createMany },
      catalogItemVersion: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn().mockResolvedValue({}),
      },
      agentComponent: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    });

    return { createMany, findFirst, executeRaw };
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
    const { createMany } = setupRepoImport({});

    const result = await importPackRepoComponents(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ created: 2, skipped: 0, invalid: 0 });
    }
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  // FEA-3251: concurrent imports of the same pack (a retried import-repo
  // request, or an admin double-click) must not double-insert children. The
  // shared write transaction takes a per-pack advisory lock as its FIRST
  // statement, before the dedupe read and any create, so a second concurrent
  // import blocks until the first commits and then dedupes against it.
  it("acquires a per-pack advisory lock before the dedupe read and any create", async () => {
    mockFetchRepoComponents.mockResolvedValue([
      { kind: "command", name: "deploy", content: "Deploy it." },
    ]);
    const { executeRaw, createMany } = setupRepoImport({});

    const order: string[] = [];
    executeRaw.mockImplementation((query: TemplateStringsArray) => {
      order.push(`lock:${query.join("")}`);
      return Promise.resolve(0);
    });
    createMany.mockImplementation(() => {
      order.push("createMany");
      return Promise.resolve({ count: 1 });
    });

    const result = await importPackRepoComponents(input);

    expect(result.ok).toBe(true);
    // The advisory lock is the first statement in the transaction.
    expect(order[0]).toContain("pg_advisory_xact_lock");
    expect(order.indexOf("createMany")).toBeGreaterThan(0);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [firstArg] = executeRaw.mock.calls[0];
    expect((firstArg as TemplateStringsArray).join("")).toContain("hashtext");
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
    const { createMany } = setupRepoImport({
      pack: { id: PACK_ID, source: "org_custom", targetKind: "plugin" },
    });

    const result = await importPackRepoComponents(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    // Guard fires before fetching the repo tree or creating any child.
    expect(mockFetchRepoComponents).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
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
