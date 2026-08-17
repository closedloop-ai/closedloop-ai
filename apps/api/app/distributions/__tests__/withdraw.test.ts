/**
 * ISS-5123 — withdrawing a pack from org distribution.
 *
 * Promotion to the organization used to be one-way. These tests pin the whole
 * withdrawal contract:
 *
 *  - the happy path stamps `withdrawnAt` and the pack stops being offered, on
 *    both the admin list and the desktop assignment poll;
 *  - **what happens to existing installs** — nothing. Per-device install rows are
 *    never touched, and a device that had already fetched the assignment can
 *    still report the outcome of its in-flight install instead of erroring;
 *  - withdrawing twice is an idempotent no-op, not a corruption or an error, and
 *    does not rewrite who withdrew it or when;
 *  - a non-admin is refused, and editing a withdrawn distribution is refused.
 *
 * The reads under test are exercised through mocks that ACTUALLY APPLY the
 * `withdrawnAt` predicate to a mixed fixture, so dropping the filter from the
 * query makes the withdrawn row reappear and fails the test — rather than the
 * test merely asserting the shape of a `where` object.
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
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import { Status } from "@repo/api/src/types/result";
import { distributionsService } from "../service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "org-1";
const CLERK_ORG_ID = "clerk-org-1";
const CLERK_USER_ID = "clerk-user-1";
const ADMIN_USER_ID = "user-admin";
const LIVE_ID = "dist-live";
const WITHDRAWN_ID = "dist-withdrawn";
const TARGET_ID = "target-1";
const MEMBER_USER_ID = "user-member";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const WITHDRAWN_AT = new Date("2026-08-08T00:00:00.000Z");

function buildCatalogItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    name: "My Plugin",
    targetKind: "plugin",
    source: "org_custom",
    coaching: false,
    zipAssetBucket: null,
    zipAssetKey: null,
    ...overrides,
  };
}

/** An install already reported by a member's machine — the history at risk. */
function buildTargetStatusRow(distributionId: string) {
  return {
    id: "status-1",
    distributionId,
    computeTargetId: TARGET_ID,
    userId: MEMBER_USER_ID,
    status: DistributionTargetStatusValue.Installed,
    installedVersion: "1.2.3",
    installRunId: "run-1",
    overriddenLocally: false,
    failureReason: null,
    installedAt: NOW,
    enabledAt: null,
    reportedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/**
 * The withdrawal fields are typed as the nullable columns they are, so the
 * fixture stays honest once `withdraw` mutates them in place and the assertions
 * below need no casts to read them back.
 */
type DistributionRow = {
  id: string;
  withdrawnAt: Date | null;
  withdrawnById: string | null;
  [key: string]: unknown;
};

function buildDistributionRow(
  overrides: Record<string, unknown> = {}
): DistributionRow {
  return {
    id: LIVE_ID,
    organizationId: ORG_ID,
    catalogItemId: "item-1",
    mode: DistributionMode.AutoInstall,
    targetingType: DistributionTargetingType.All,
    desiredEnabled: true,
    withdrawnAt: null,
    withdrawnById: null,
    createdAt: NOW,
    updatedAt: NOW,
    catalogItem: buildCatalogItemRow(),
    targetingEntries: [],
    targetStatuses: [],
    ...overrides,
  };
}

type WhereClause = {
  withdrawnAt?: unknown;
  id?: unknown;
  organizationId?: unknown;
};

/**
 * Does a `where` clause demand a live (non-withdrawn) row?
 *
 * The production predicate is the literal `withdrawnAt: null`, so this asks the
 * question the database would: if the query says nothing about `withdrawnAt`,
 * withdrawn rows match — which is precisely the regression these tests exist to
 * catch.
 */
function requiresLive(where: WhereClause | undefined): boolean {
  return where?.withdrawnAt === null;
}

/**
 * Prisma accepts either a scalar id or an `{ in: [...] }` filter (the batch
 * status-report read uses the latter); both must be honoured or a query gets
 * silently matched against nothing.
 */
function matchesId(idFilter: unknown, id: string): boolean {
  if (idFilter === undefined) {
    return true;
  }
  if (typeof idFilter === "object" && idFilter !== null && "in" in idFilter) {
    const { in: ids } = idFilter as { in: string[] };
    return ids.includes(id);
  }
  return idFilter === id;
}

function matchesRow(
  where: WhereClause | undefined,
  row: { id: string; withdrawnAt: Date | null }
): boolean {
  if (!matchesId(where?.id, row.id)) {
    return false;
  }
  return !(requiresLive(where) && row.withdrawnAt !== null);
}

/**
 * A `db` double whose distribution reads genuinely honour `withdrawnAt`, over a
 * fixture holding one live and one withdrawn distribution.
 */
function installFilteringDb(
  rows: DistributionRow[],
  overrides: Record<string, unknown> = {}
) {
  const updateMany = vi.fn(({ where, data }: Record<string, WhereClause>) => {
    let count = 0;
    for (const row of rows) {
      if (matchesRow(where, row)) {
        Object.assign(row, data);
        count += 1;
      }
    }
    return Promise.resolve({ count });
  });

  const db = {
    distribution: {
      findMany: vi.fn(({ where }: { where?: WhereClause }) =>
        Promise.resolve(rows.filter((row) => matchesRow(where, row)))
      ),
      findFirst: vi.fn(({ where }: { where?: WhereClause }) =>
        Promise.resolve(rows.find((row) => matchesRow(where, row)) ?? null)
      ),
      updateMany,
      update: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(null),
    },
    distributionTargetStatus: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    distributionTargetingEntry: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    catalogItem: { findFirst: vi.fn().mockResolvedValue(null) },
    $executeRaw: vi.fn().mockResolvedValue(1),
    ...overrides,
  };

  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  return db;
}

function liveAndWithdrawnRows() {
  return [
    buildDistributionRow({
      id: LIVE_ID,
      targetStatuses: [buildTargetStatusRow(LIVE_ID)],
    }),
    buildDistributionRow({
      id: WITHDRAWN_ID,
      withdrawnAt: WITHDRAWN_AT,
      targetStatuses: [buildTargetStatusRow(WITHDRAWN_ID)],
    }),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.awsKeys.mockReturnValue({ PLUGIN_STORE_BUCKET: "test-bucket" });
  mocks.getCatalogAssetDownloadUrl.mockResolvedValue("https://example/asset");
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("distributionsService.withdraw — authorization", () => {
  it("refuses a non-admin and leaves the distribution distributed", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);
    const rows = liveAndWithdrawnRows();
    const db = installFilteringDb(rows);

    const result = await distributionsService.withdraw(
      ORG_ID,
      LIVE_ID,
      "user-member",
      CLERK_ORG_ID,
      CLERK_USER_ID
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(Status.Forbidden);
    // The refusal must be a refusal, not a 403 returned after the write landed.
    expect(db.distribution.updateMany).not.toHaveBeenCalled();
    expect(rows[0]?.withdrawnAt).toBeNull();
  });

  it("returns 404 for a distribution in another org", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    installFilteringDb([]);

    const result = await distributionsService.withdraw(
      ORG_ID,
      "dist-elsewhere",
      ADMIN_USER_ID,
      CLERK_ORG_ID,
      CLERK_USER_ID
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(Status.NotFound);
  });
});

// ---------------------------------------------------------------------------
// Happy path + existing installs
// ---------------------------------------------------------------------------

describe("distributionsService.withdraw — happy path", () => {
  beforeEach(() => {
    mocks.isOrgAdmin.mockResolvedValue(true);
  });

  it("stamps withdrawnAt and records who withdrew it", async () => {
    const rows = liveAndWithdrawnRows();
    installFilteringDb(rows);

    const result = await distributionsService.withdraw(
      ORG_ID,
      LIVE_ID,
      ADMIN_USER_ID,
      CLERK_ORG_ID,
      CLERK_USER_ID
    );

    expect(result.ok).toBe(true);
    expect(rows[0]?.withdrawnAt).toBeInstanceOf(Date);
    expect(rows[0]?.withdrawnById).toBe(ADMIN_USER_ID);
    expect(result.ok && result.value.withdrawnAt).toEqual(
      rows[0]?.withdrawnAt?.toISOString()
    );
  });

  it("leaves already-installed copies alone — no per-device rows are touched", async () => {
    const rows = liveAndWithdrawnRows();
    const db = installFilteringDb(rows);

    const result = await distributionsService.withdraw(
      ORG_ID,
      LIVE_ID,
      ADMIN_USER_ID,
      CLERK_ORG_ID,
      CLERK_USER_ID
    );

    expect(result.ok).toBe(true);
    // Withdrawing removes the OFFER, never the installs. Nothing may delete or
    // rewrite the per-device install history, and the returned record still
    // carries it so an admin can see where the pack had already landed.
    expect(db.distributionTargetStatus.deleteMany).not.toHaveBeenCalled();
    expect(db.distributionTargetStatus.updateMany).not.toHaveBeenCalled();
    expect(result.ok && result.value.targetStatuses).toHaveLength(1);
    expect(result.ok && result.value.targetStatuses[0]?.status).toBe(
      DistributionTargetStatusValue.Installed
    );
    expect(result.ok && result.value.targetStatuses[0]?.installedVersion).toBe(
      "1.2.3"
    );
  });

  it("is an idempotent no-op the second time and does not re-stamp the record", async () => {
    const rows = liveAndWithdrawnRows();
    installFilteringDb(rows);

    const first = await distributionsService.withdraw(
      ORG_ID,
      LIVE_ID,
      ADMIN_USER_ID,
      CLERK_ORG_ID,
      CLERK_USER_ID
    );
    const stampedAt = rows[0]?.withdrawnAt;

    const second = await distributionsService.withdraw(
      ORG_ID,
      LIVE_ID,
      "user-other-admin",
      CLERK_ORG_ID,
      CLERK_USER_ID
    );

    // Success both times — "no longer offered" is exactly what the caller asked
    // for, so a repeat is not an error...
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // ...and the second call must not overwrite the original withdrawal's
    // timestamp or attribute it to whoever clicked last.
    expect(stampedAt).toBeInstanceOf(Date);
    expect(rows[0]?.withdrawnAt).toBe(stampedAt);
    expect(rows[0]?.withdrawnById).toBe(ADMIN_USER_ID);
    expect(second.ok && second.value.withdrawnAt).toEqual(
      stampedAt?.toISOString()
    );
  });
});

// ---------------------------------------------------------------------------
// "No longer offered" — the reads
// ---------------------------------------------------------------------------

describe("withdrawn distributions are no longer offered", () => {
  it("drops out of the org distribution list", async () => {
    installFilteringDb(liveAndWithdrawnRows());

    const list = await distributionsService.listForOrg(ORG_ID);

    expect(list.map((row) => row.id)).toEqual([LIVE_ID]);
  });

  it("drops out of the desktop assigned-distributions poll", async () => {
    installFilteringDb(liveAndWithdrawnRows());

    const assigned = await distributionsService.getAssignedForTarget(
      ORG_ID,
      TARGET_ID,
      MEMBER_USER_ID
    );

    // This is the whole feature from a member machine's point of view: the pack
    // is no longer offered, so nothing auto-installs or prompts for it again.
    expect(assigned.map((row) => row.id)).toEqual([LIVE_ID]);
  });

  it("is still readable by id, so the record and its history survive", async () => {
    installFilteringDb(liveAndWithdrawnRows());

    const detail = await distributionsService.getDetailForOrg(
      ORG_ID,
      WITHDRAWN_ID
    );

    expect(detail?.id).toBe(WITHDRAWN_ID);
    expect(detail?.withdrawnAt).toBe(WITHDRAWN_AT.toISOString());
    expect(detail?.targetStatuses).toHaveLength(1);
  });

  it("cannot be edited — a racing PATCH is refused rather than silently ignored", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    installFilteringDb(liveAndWithdrawnRows());

    const result = await distributionsService.update(
      ORG_ID,
      WITHDRAWN_ID,
      CLERK_ORG_ID,
      CLERK_USER_ID,
      { mode: DistributionMode.OptIn }
    );

    // Editing a row that every live read filters out would report success for a
    // change no member can ever receive.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(Status.NotFound);
  });

  /**
   * The genuinely concurrent case, which a check performed before the write
   * cannot answer: the PATCH reads the row while it is still live, and the
   * withdrawal commits in the window before the update runs. Only a
   * `withdrawnAt: null` predicate carried ON the write itself — and read back
   * as the affected-row count — can refuse this. `findFirst` is made to stamp
   * the withdrawal as it hands back the live row, which is exactly that window.
   */
  it("refuses a targeting PATCH withdrawn between the read and the write, without rebuilding entries", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    const rows = [buildDistributionRow({ id: LIVE_ID })];
    const db = installFilteringDb(rows);
    const raced = rows[0];
    db.distribution.findFirst.mockImplementationOnce(
      ({ where }: { where?: WhereClause }) => {
        const row = rows.find((candidate) => matchesRow(where, candidate));
        // …the other admin's DELETE commits right here.
        raced.withdrawnAt = WITHDRAWN_AT;
        raced.withdrawnById = ADMIN_USER_ID;
        return Promise.resolve(row ?? null);
      }
    );

    const result = await distributionsService.update(
      ORG_ID,
      LIVE_ID,
      CLERK_ORG_ID,
      CLERK_USER_ID,
      {
        targetingType: DistributionTargetingType.Specific,
        targetComputeTargetIds: [TARGET_ID],
      }
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(Status.NotFound);
    // The rebuild must not have run: a withdrawn distribution left carrying
    // targeting entries rewritten by a PATCH that answered 404 is the corrupt
    // state this predicate exists to prevent.
    expect(db.distributionTargetingEntry.deleteMany).not.toHaveBeenCalled();
    expect(db.distributionTargetingEntry.createMany).not.toHaveBeenCalled();
    // And the withdrawal itself stands — untouched by the losing edit.
    expect(raced.withdrawnAt).toBe(WITHDRAWN_AT);
    expect(raced.targetingType).toBe(DistributionTargetingType.All);
  });

  it("refuses a scalar-only PATCH withdrawn between the read and the write", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    const rows = [buildDistributionRow({ id: LIVE_ID })];
    const db = installFilteringDb(rows);
    const raced = rows[0];
    db.distribution.findFirst.mockImplementationOnce(
      ({ where }: { where?: WhereClause }) => {
        const row = rows.find((candidate) => matchesRow(where, candidate));
        raced.withdrawnAt = WITHDRAWN_AT;
        return Promise.resolve(row ?? null);
      }
    );

    const result = await distributionsService.update(
      ORG_ID,
      LIVE_ID,
      CLERK_ORG_ID,
      CLERK_USER_ID,
      { desiredEnabled: false }
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(Status.NotFound);
    // The scalar write is predicated too, so it matched nothing and the
    // withdrawn row kept its value rather than being edited post-withdrawal.
    expect(raced.desiredEnabled).toBe(true);
    expect(db.distribution.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// In-flight installs
// ---------------------------------------------------------------------------

describe("withdrawal does not break an install already in flight", () => {
  it("still accepts a status report for a withdrawn distribution", async () => {
    mocks.computeTargetsService.findOwnedById.mockResolvedValue({
      id: TARGET_ID,
    });
    const rows = liveAndWithdrawnRows();
    installFilteringDb(rows);

    const result = await distributionsService.upsertStatusReports(
      ORG_ID,
      TARGET_ID,
      MEMBER_USER_ID,
      CLERK_USER_ID,
      [
        {
          distributionId: WITHDRAWN_ID,
          status: DistributionTargetStatusValue.Installed,
          installedVersion: "1.2.3",
        },
      ]
    );

    // A device that fetched the assignment moments before withdrawal must be
    // able to record what actually happened. Rejecting here would surface as an
    // error on the member's machine for an install the org itself authorised —
    // the ticket asks for a non-breaking degrade, not an error.
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(1);
  });
});
