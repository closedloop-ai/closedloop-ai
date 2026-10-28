import { type Mock, vi } from "vitest";

/**
 * Shared scaffolding for the catalog-service unit suites.
 *
 * `service.test.ts` and `service-update.test.ts` both import `../service`, so
 * both need the same module graph stubbed — the mock preamble is driven by that
 * graph, not by what either suite asserts. Keeping it here is what lets the
 * update path live in its own file without a second, drifting copy.
 *
 * The `vi.hoisted` handles themselves must stay in each suite: that callback is
 * hoisted above every import, so it cannot reference anything from this module.
 * Each `vi.mock` factory is lazy, and passes its handles back in.
 */

export type CatalogWithDbMock = Mock & { tx: Mock };

export const ORG_ID = "org-111";
export const OTHER_ORG_ID = "org-222";
export const USER_ID = "user-abc";
export const ITEM_ID = "item-uuid-1";
export const NOW = new Date("2026-01-15T10:00:00.000Z");

export function createCatalogDatabaseMockModule(
  withDb: CatalogWithDbMock
): Record<string, unknown> {
  return {
    withDb,
    // The repo-import path builds a where-clause referencing this enum, so the
    // mock must expose it (otherwise `GitHubInstallationStatus.ACTIVE` throws).
    GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
    // FEA-3909: the pack-member F4 link path references these registry enums.
    SourceOccurrenceType: {
      local: "local",
      repository: "repository",
      pack: "pack",
    },
    SourceAccessState: {
      accessible: "accessible",
      inaccessible: "inaccessible",
    },
    // `getCatalogItemDetail` resolves child content with a raw DISTINCT ON query
    // (FEA-3299), so the tagged-template helper must exist. Capture the
    // interpolated values so tests can assert what was bound.
    Prisma: {
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
        strings,
        values,
      }),
    },
  };
}

export function createCatalogAssetsMockModule(): Record<string, unknown> {
  return {
    catalogAssetKey: vi.fn(
      (orgId: string, itemId: string, kind: string) =>
        `org/${orgId}/catalog/${itemId}/${kind}`
    ),
    getCatalogAssetBytes: vi.fn().mockResolvedValue(Buffer.from("zip-bytes")),
    getCatalogAssetUploadUrl: vi.fn(),
    getCatalogAssetDownloadUrl: vi.fn(),
    headCatalogAsset: vi.fn(),
    resolveCatalogBucket: vi.fn(() => "plugin-store-bucket"),
    // Re-export the real error class so the 413 mapping (asset over raw-byte
    // cap) is testable via `instanceof` in the service under test.
    CatalogAssetTooLargeError: class CatalogAssetTooLargeError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CatalogAssetTooLargeError";
      }
    },
  };
}

export function createPackZipImportMockModule(
  parsePackZip: Mock
): Record<string, unknown> {
  return {
    parsePackZip,
    // Re-export the real error class so the 413 mapping (zip over budget) is
    // testable via `instanceof` in the service under test.
    PackZipTooLargeError: class PackZipTooLargeError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "PackZipTooLargeError";
      }
    },
  };
}

export function createPackRepoImportMockModule(
  fetchRepoComponents: Mock
): Record<string, unknown> {
  return {
    fetchRepoComponents,
    // Re-export the real error class so the guard/surfacing behavior is
    // testable.
    RepoTreeTruncatedError: class RepoTreeTruncatedError extends Error {
      constructor(owner: string, repo: string) {
        super(
          `GitHub returned a truncated file tree for ${owner}/${repo}; the repository is too large to import in full. Narrow the import with a subPath (e.g. \`.claude\`).`
        );
        this.name = "RepoTreeTruncatedError";
      }
    },
  };
}

export function makeCatalogRow(
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

/**
 * Bind the `withDb` / `withDb.tx` stub installers to one suite's mock handle,
 * so call sites keep reading `setupWithDb(stub)` rather than threading the
 * handle through every one of them.
 */
export function createWithDbSetters(mockWithDb: CatalogWithDbMock) {
  /** Set up withDb to return from a simple (non-tx) callback. */
  function setupWithDb(clientStub: Record<string, unknown>) {
    mockWithDb.mockImplementation(
      (callback: (db: Record<string, unknown>) => unknown) =>
        callback(clientStub)
    );
  }

  /** Set up withDb.tx to invoke its callback with the given tx stub. */
  function setupWithDbTx(txStub: Record<string, unknown>) {
    mockWithDb.tx.mockImplementation(
      (callback: (tx: Record<string, unknown>) => unknown) => callback(txStub)
    );
  }

  return { setupWithDb, setupWithDbTx };
}
