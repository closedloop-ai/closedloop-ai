/**
 * ISS-6665 — `listCatalogItemsForOrg` visibility, asserted on the ROWS THE
 * SERVICE RETURNS.
 *
 * The three tests this file replaces (`service.test.ts`, formerly lines
 * 333/359/382) captured the Prisma `where` object and asserted on it:
 *
 *   expect(capturedWhere.archived).toBe(false);
 *
 * That asserts the query the code BUILT, never the rows it RETURNED, and stays
 * green when the correctly-built `where` is handed to the wrong delegate,
 * dropped, or overridden downstream — a filter can be perfectly constructed and
 * never applied. Asserting a *bigger* `where` object only deepens that trap, so
 * the replacement asserts returned data instead.
 *
 * The double therefore has to actually EVALUATE the predicate, which is what
 * `createFakeDelegate` does (`__tests__/support/prisma-write-semantics.test-fixtures`).
 * The seeded corpus deliberately contains rows each assertion must EXCLUDE —
 * another org's row, a global row that is not curated, a pack child — so
 * "the right rows came back" cannot be satisfied by a single-row corpus or by
 * an empty result.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  SourceOccurrenceType: {
    local: "local",
    repository: "repository",
    pack: "pack",
  },
  SourceAccessState: { accessible: "accessible", inaccessible: "inaccessible" },
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

vi.mock("@repo/aws/catalog-assets", () => ({
  catalogAssetKey: vi.fn(),
  getCatalogAssetBytes: vi.fn(),
  getCatalogAssetDownloadUrl: vi.fn(),
  getCatalogAssetUploadUrl: vi.fn(),
  headCatalogAsset: vi.fn(),
  CatalogAssetTooLargeError: class CatalogAssetTooLargeError extends Error {},
}));

vi.mock("@/lib/db-utils", () => ({ getPrismaErrorCode: vi.fn() }));
vi.mock("../pack-zip-import", () => ({
  parsePackZip: vi.fn(),
  PackZipTooLargeError: class PackZipTooLargeError extends Error {},
}));
vi.mock("../pack-repo-import", () => ({
  fetchRepoComponents: vi.fn(),
  RepoTreeTruncatedError: class RepoTreeTruncatedError extends Error {},
}));

import { createFakeDelegate } from "@/__tests__/support/prisma-write-semantics.test-fixtures";
import { listCatalogItemsForOrg } from "../service";

const ORG_ID = "org-111";
const OTHER_ORG_ID = "org-222";
const THIRD_ORG_ID = "org-333";
const NOW = new Date("2026-01-15T10:00:00.000Z");

type CorpusOverrides = {
  organizationId?: string | null;
  source?: string;
  scope?: string;
  archived?: boolean;
  parentPackId?: string | null;
};

function makeRow(id: string, overrides: CorpusOverrides = {}) {
  return {
    id,
    organizationId: ORG_ID,
    targetKind: "plugin",
    source: "org_custom",
    scope: "org",
    name: `name-${id}`,
    description: null,
    version: "1.0.0",
    sortOrder: 0,
    enabled: true,
    archived: false,
    coaching: false,
    coachingConfig: null,
    agentSlug: null,
    parentPackId: null,
    componentUuid: null,
    zipAssetKey: null,
    // `logoAssetKey: null` keeps `populateLogoUrl` off the S3 path entirely, so
    // these assertions describe visibility and nothing else.
    logoAssetKey: null,
    createdById: "user-abc",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * Seven rows spanning every branch of the visibility predicate. Four are
 * visible-or-archived rows the org may see; three (`other-org`,
 * `global-not-curated`, `pack-child`) must NEVER come back, on any input, so a
 * predicate that silently degrades to "return everything" fails here.
 */
function seedCorpus() {
  const rows = [
    makeRow("org-visible"),
    makeRow("org-archived", { archived: true }),
    makeRow("curated-global", {
      organizationId: null,
      scope: "global",
      source: "curated",
    }),
    makeRow("curated-global-archived", {
      organizationId: null,
      scope: "global",
      source: "curated",
      archived: true,
    }),
    makeRow("other-org", { organizationId: OTHER_ORG_ID }),
    // A third org, so this row is outside BOTH queries below: it is admitted by
    // neither `organizationId` branch, and `scope: "global"` alone must not let
    // it through the curated branch.
    makeRow("global-not-curated", {
      organizationId: THIRD_ORG_ID,
      scope: "global",
      source: "org_custom",
    }),
    makeRow("pack-child", { parentPackId: "pack-1" }),
  ];
  const catalogItem = createFakeDelegate(rows);
  mocks.withDb.mockImplementation(
    (callback: (db: Record<string, unknown>) => unknown) =>
      callback({ catalogItem })
  );
  return catalogItem;
}

async function visibleIds(input: {
  organizationId: string;
  includeArchived?: boolean;
}) {
  const items = await listCatalogItemsForOrg(input);
  return items.map((item) => item.id).sort();
}

describe("listCatalogItemsForOrg row visibility (ISS-6665)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedCorpus();
  });

  // Replaces the org-scoping assertion (was `expect(capturedWhere).toEqual({ OR: … })`).
  it("returns the caller's own rows plus curated global rows, and nothing else", async () => {
    const forOrg = await visibleIds({ organizationId: ORG_ID });
    const forOther = await visibleIds({ organizationId: OTHER_ORG_ID });

    expect(forOrg).toEqual(["curated-global", "org-visible"]);
    // The mirrored call is what makes this an org-scoping assertion rather than
    // a corpus coincidence: the same curated row crosses, the org-owned rows
    // swap, and `global-not-curated` (a third org, scope=global) crosses
    // neither — so `scope: "global"` alone cannot admit a row.
    expect(forOther).toEqual(["curated-global", "other-org"]);
  });

  // Replaces `expect(capturedWhere.archived).toBe(false)`.
  it("excludes archived rows by default", async () => {
    const ids = await visibleIds({ organizationId: ORG_ID });

    expect(ids).not.toContain("org-archived");
    expect(ids).not.toContain("curated-global-archived");
    // Named live twins of both archived rows, so an empty or errored result
    // cannot satisfy the two exclusions above.
    expect(ids).toContain("org-visible");
    expect(ids).toContain("curated-global");
  });

  // Replaces `expect(capturedWhere.archived).toBeUndefined()`.
  it("returns archived rows when includeArchived=true, still org-scoped", async () => {
    const ids = await visibleIds({
      organizationId: ORG_ID,
      includeArchived: true,
    });

    // Exactly the default result plus the two archived rows: dropping the
    // `archived` constraint must widen along that one axis and no other, so
    // `other-org`, `global-not-curated` and `pack-child` still stay out.
    expect(ids).toEqual([
      "curated-global",
      "curated-global-archived",
      "org-archived",
      "org-visible",
    ]);
  });
});
