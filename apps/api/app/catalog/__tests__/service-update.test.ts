/**
 * Unit tests for `updateCatalogItem`.
 *
 * Split out of `service.test.ts` (which is grandfathered over the 1,000-line
 * ceiling) because the update path is its own responsibility: it is the only
 * catalog write whose refusal has TWO meanings — a decision no org role could
 * overturn, and a decision nobody could make because the role would not
 * resolve. `../service/update-authorization` owns that split in production;
 * this file owns its coverage.
 *
 * All DB calls are mocked via `vi.mock("@repo/database")` and the AWS S3
 * helpers via `vi.mock("@repo/aws/catalog-assets")`. The shared preamble and
 * fixtures live in `./service-test-harness` so this suite and `service.test.ts`
 * cannot drift.
 *
 * Note: the admin gate (`requireOrgAdmin`) is enforced at the route layer
 * (route.ts), not inside the service functions themselves. What reaches the
 * service is the gate's VERDICT, as `adminDenialReason`.
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (must appear before any imports from the module under test)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  getPrismaErrorCode: vi.fn(() => undefined),
  parsePackZip: vi.fn(),
  fetchRepoComponents: vi.fn(),
  // FEA-3909: the F1 registry writer, mocked to return a synthetic version id.
  registerDefinitionVersion: vi.fn(async () => "dv-test"),
  // FEA-4011 Slice A: the fail-open, post-commit search index hooks.
  indexManyAfterCommit: vi.fn(),
  removeAfterCommit: vi.fn(),
}));

vi.mock("@repo/database", async () => {
  const { createCatalogDatabaseMockModule } = await import(
    "./service-test-harness"
  );
  return createCatalogDatabaseMockModule(mocks.withDb);
});

vi.mock("@/app/definition-registry/service", () => ({
  registerDefinitionVersion: mocks.registerDefinitionVersion,
}));

// Keep the real `agentComponentProjection` mapper but stub the fail-open index
// hooks so these catalog tests stay DB-free.
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

vi.mock("@/lib/db-utils", () => ({
  getPrismaErrorCode: mocks.getPrismaErrorCode,
}));

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
import { CatalogItemSource } from "@repo/api/src/types/distribution";
import { Status } from "@repo/api/src/types/result";
import { getCatalogAssetDownloadUrl } from "@repo/aws/catalog-assets";
import { SourceOccurrenceType } from "@repo/database";
import { OrgAdminDenialReason } from "@/lib/auth/org-admin-denial";
import { updateCatalogItem } from "../service";
import {
  type CatalogWithDbMock,
  createWithDbSetters,
  ITEM_ID,
  makeCatalogRow,
  ORG_ID,
  USER_ID,
} from "./service-test-harness";

const mockWithDb = mocks.withDb as unknown as CatalogWithDbMock;
const mockGetCatalogAssetDownloadUrl =
  getCatalogAssetDownloadUrl as unknown as Mock;
const { setupWithDb, setupWithDbTx } = createWithDbSetters(mockWithDb);

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
          sourceRepo: "closedloop-ai/closedloop-ai",
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
        source: "closedloop-ai/closedloop-ai",
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
      // The version id is selected so a pack-member edit can link the new version.
      select: { id: true },
    });
  });

  it("links a content edit on a PACK MEMBER to the F1 registry and stamps the new version (FEA-3909 F4)", async () => {
    const PACK_ID = "pack-uuid-9";
    const versionUpdate = vi.fn().mockResolvedValue({});
    const updatedRow = makeCatalogRow({ name: "Member" });
    // The owning item is a pack MEMBER: `parentPackId` is set on the ownership row.
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: ITEM_ID,
          source: CatalogItemSource.OrgCustom,
          archived: false,
          targetKind: "skill",
          organizationId: ORG_ID,
          createdById: USER_ID,
          sourceRepo: null,
          parentPackId: PACK_ID,
        }),
      },
    });
    setupWithDbTx({
      catalogItem: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(updatedRow),
      },
      catalogItemVersion: {
        findFirst: vi.fn().mockResolvedValue({ version: 4 }),
        create: vi.fn().mockResolvedValue({ id: "civ-new" }),
        update: versionUpdate,
      },
    });

    const result = await updateCatalogItem({
      id: ITEM_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      content: "# Edited member body",
    });

    expect(result.ok).toBe(true);
    // The registry link is written with the pack occurrence shape, keyed to the
    // owning pack, for the edited member's exact new body.
    expect(mocks.registerDefinitionVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG_ID,
        packId: PACK_ID,
        occurrenceType: SourceOccurrenceType.pack,
        componentKind: AgentComponentKind.Skill,
        content: "# Edited member body",
      })
    );
    // ...and the returned definitionVersionId is stamped onto the NEW version
    // row. `select` is asserted alongside `where`/`data` because ISS-6322
    // narrowed this discarded write's RETURNING to the primary key; the row
    // written and the P2025 throw are unchanged.
    expect(versionUpdate).toHaveBeenCalledWith({
      where: { id: "civ-new" },
      data: { definitionVersionId: "dv-test" },
      select: { id: true },
    });
  });

  it("does NOT link an empty-content edit on a pack member (conservative PD5 — parity with the backfill)", async () => {
    const PACK_ID = "pack-uuid-9";
    const versionUpdate = vi.fn().mockResolvedValue({});
    const updatedRow = makeCatalogRow({ name: "Member" });
    setupWithDb({
      catalogItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: ITEM_ID,
          source: CatalogItemSource.OrgCustom,
          archived: false,
          targetKind: "skill",
          organizationId: ORG_ID,
          createdById: USER_ID,
          sourceRepo: null,
          parentPackId: PACK_ID,
        }),
      },
    });
    setupWithDbTx({
      catalogItem: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(updatedRow),
      },
      catalogItemVersion: {
        findFirst: vi.fn().mockResolvedValue({ version: 4 }),
        create: vi.fn().mockResolvedValue({ id: "civ-empty" }),
        update: versionUpdate,
      },
    });

    const result = await updateCatalogItem({
      id: ITEM_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      content: "",
    });

    expect(result.ok).toBe(true);
    // Empty body ⇒ no version minted, no link stamped (the shared conservative
    // guard leaves it NULL, exactly as the backfill leaves an empty member).
    expect(mocks.registerDefinitionVersion).not.toHaveBeenCalled();
    expect(versionUpdate).not.toHaveBeenCalled();
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

  it("returns 403 when an owner tries to update the coaching field", async () => {
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
      coaching: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(403);
    }
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("returns 403 when an owner tries to update the coachingConfig field", async () => {
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
      coachingConfig: { key: "value" },
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

  /**
   * ISS-8661. An unreadable org role makes SOME refusals undecided and leaves
   * others exactly as decided as they were. The split is the point: an
   * immutable item refuses an admin too, so no role lookup could have changed
   * its answer and it must not be re-reported as a retryable 503.
   *
   * Each 503 case below is paired with the same setup under a RESOLVED
   * non-admin, so neither status can quietly drift into the other's meaning.
   */
  describe("unresolved org role", () => {
    function stubExistingItem(overrides: Record<string, unknown> = {}): void {
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
            ...overrides,
          }),
        },
      });
    }

    it("keeps 403 for a curated item when the role could not be read", async () => {
      stubExistingItem({ source: CatalogItemSource.Curated });

      const result = await updateCatalogItem({
        id: ITEM_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
        adminDenialReason: OrgAdminDenialReason.ProviderError,
        name: "Attempted Mutation",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // An admin gets 403 here too, so the role is not an input to this
        // answer and a 503 would promise a retry that can never succeed.
        expect(result.error).toBe(Status.Forbidden);
        expect(result.error).not.toBe(Status.ServiceUnavailable);
      }
      expect(mockWithDb.tx).not.toHaveBeenCalled();
    });

    it("keeps 403 for an archived item when the role could not be read", async () => {
      stubExistingItem({ archived: true });

      const result = await updateCatalogItem({
        id: ITEM_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
        adminDenialReason: OrgAdminDenialReason.ProviderError,
        name: "Attempted Mutation",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(Status.Forbidden);
        expect(result.error).not.toBe(Status.ServiceUnavailable);
      }
      expect(mockWithDb.tx).not.toHaveBeenCalled();
    });

    it("keeps 403 for a body edit on a content-less target kind when the role could not be read", async () => {
      stubExistingItem({ targetKind: "pack" });

      const result = await updateCatalogItem({
        id: ITEM_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
        adminDenialReason: OrgAdminDenialReason.ProviderError,
        content: "pack content should not be accepted",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Checked before the role even matters: an admin cannot put a body on
        // a pack either.
        expect(result.error).toBe(Status.Forbidden);
        expect(result.error).not.toBe(Status.ServiceUnavailable);
      }
      expect(mockWithDb.tx).not.toHaveBeenCalled();
    });

    it("answers 503 when an unreadable role would have decided a foreign-owner refusal", async () => {
      stubExistingItem({ createdById: "different-user" });

      const result = await updateCatalogItem({
        id: ITEM_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
        adminDenialReason: OrgAdminDenialReason.ProviderError,
        name: "Attempted Mutation",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // An admin WOULD have been allowed, and nobody could check.
        expect(result.error).toBe(Status.ServiceUnavailable);
      }
      expect(mockWithDb.tx).not.toHaveBeenCalled();
    });

    it("answers 403 for the same foreign-owner refusal once the role resolves", async () => {
      stubExistingItem({ createdById: "different-user" });

      const result = await updateCatalogItem({
        id: ITEM_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
        adminDenialReason: OrgAdminDenialReason.NotAdmin,
        name: "Attempted Mutation",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(Status.Forbidden);
      }
    });

    it("answers 503 when an unreadable role would have decided an admin-only field", async () => {
      stubExistingItem();

      const result = await updateCatalogItem({
        id: ITEM_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
        adminDenialReason: OrgAdminDenialReason.ProviderError,
        sortOrder: 3,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(Status.ServiceUnavailable);
      }
    });

    it("still lets the creator edit their own item while the role is unreadable", async () => {
      stubExistingItem();
      setupWithDbTx({
        catalogItem: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue(makeCatalogRow()),
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
        adminDenialReason: OrgAdminDenialReason.ProviderError,
        name: "Owner Rename",
      });

      // The own-item path never consulted the role, so an outage must not
      // withdraw an edit that worked before ISS-8661.
      expect(result.ok).toBe(true);
    });
  });
});
