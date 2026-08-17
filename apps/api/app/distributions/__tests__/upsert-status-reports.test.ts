/**
 * Unit tests for `distributionsService.upsertStatusReports`.
 *
 * Split out of `service.test.ts` (FEA-4193) so that grandfathered file stays on
 * the shrink-only list in biome.jsonc — this suite and its helpers live here.
 *
 * Each report is applied with a single atomic raw
 * `INSERT ... ON CONFLICT DO UPDATE` (see upsertOneStatusReport), so the tests
 * assert on the captured `$executeRaw(Prisma.sql`...`)` fragment rather than on
 * findFirst/create/updateMany call patterns.
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

import { DistributionTargetStatusValue } from "@repo/api/src/types/distribution";
import { distributionsService } from "../service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wire withDb + withDb.tx to a full default db object (with overrides). */
function installDb(db: Record<string, unknown>) {
  const dbWithDefaults = {
    distribution: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(null),
    },
    distributionTargetStatus: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue(null),
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

  it("FEA-4193: sizes the batch tx timeout to the 15s desktop client abort so advisory-lock contention can't abort the batch early", async () => {
    // Each report takes a blocking pg_advisory_xact_lock (FEA-2994); under
    // concurrent batches contending on the same target the serialized wait can
    // exceed the 5s default interactive-transaction timeout and roll back the
    // whole batch with a P2028. The write passes an explicit timeout override to
    // withDb.tx that (a) stays above Prisma's 5s default and (b) is aligned to
    // the desktop client's 15s request abort so the server never holds locks for
    // a caller that has already given up.
    installStatusReportDb(["dist-1"]);

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

    const txOptions = mocks.withDb.tx.mock.calls.at(-1)?.[1];
    expect(txOptions).toEqual({ maxWait: 5000, timeout: 15_000 });
  });

  it("FEA-4193: the ON CONFLICT upsert is freshness-aware so a stale batch can't clobber a newer committed row", async () => {
    // Regression guard for the stale-write race (shafty023 review): an older
    // wide batch can capture its batch timestamp, block on an earlier advisory
    // lock, let a NEWER batch commit a later shared key, then resume and reach
    // that key. The DO UPDATE must NOT unconditionally overwrite the newer row.
    // Each last-seen field is gated on `EXCLUDED.reported_at >=` the persisted
    // reported_at (COALESCEd so a null baseline still accepts the write), and
    // reported_at advances via GREATEST — so the newer value always survives.
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
    const guard =
      "EXCLUDED.reported_at >= COALESCE(distribution_target_status.reported_at, EXCLUDED.reported_at)";
    // Every mutable last-seen field is written through the freshness guard —
    // never an unconditional `= EXCLUDED.<field>`.
    for (const field of [
      "status",
      "installed_version",
      "install_run_id",
      "failure_reason",
    ]) {
      expect(sql).toContain(
        `${field} = CASE WHEN ${guard} THEN EXCLUDED.${field} ELSE distribution_target_status.${field} END`
      );
      // The pre-fix unconditional assignment must be gone.
      expect(sql).not.toContain(`${field} = EXCLUDED.${field},`);
    }
    // reported_at moves forward monotonically, never backward to a stale value.
    expect(sql).toContain(
      "reported_at = GREATEST(distribution_target_status.reported_at, EXCLUDED.reported_at)"
    );
    // First-seen milestones remain COALESCE-preserved, outside the freshness gate.
    expect(sql).toContain(
      "installed_at = COALESCE(distribution_target_status.installed_at, EXCLUDED.installed_at)"
    );
    expect(sql).toContain(
      "enabled_at = COALESCE(distribution_target_status.enabled_at, EXCLUDED.enabled_at)"
    );
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
