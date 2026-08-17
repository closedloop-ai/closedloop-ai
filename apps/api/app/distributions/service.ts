import "server-only";

import type {
  CatalogItemDto,
  CreateDistributionRequest,
  DistributionDto,
  DistributionStatusReport,
  DistributionTargetingEntry,
  DistributionTargetStatusDto,
  UpdateDistributionRequest,
} from "@repo/api/src/types/distribution";
import {
  DistributionMode,
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { getCatalogAssetDownloadUrl } from "@repo/aws";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { v7 as uuidv7 } from "uuid";
import { computeTargetsService } from "@/app/compute-targets/service";
import { isOrgAdmin } from "@/lib/auth/org-admin";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Presigned URL TTL for desktop asset downloads (15 minutes). */
const ASSET_DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

/**
 * Interactive-transaction sizing for the status-report batch write.
 *
 * Each report takes a blocking `pg_advisory_xact_lock` on its (distributionId,
 * computeTargetId) key (FEA-2994) held until the whole batch commits, so under
 * concurrent batches contending on the same target the serialized wait can
 * exceed Prisma's 5s default interactive-transaction timeout and abort the whole
 * batch with a P2028. The timeout must therefore sit above that 5s default.
 *
 * It is NOT a proven worst-case bound (FEA-4193 review, wongk): the route caps a
 * batch at 100 reports (see the desktop status route's `.max(100)`), but total
 * concurrent batch depth is unbounded here, so no fixed number bounds the tail
 * under adversarial contention. Bounding concurrent depth needs admission
 * control (a semaphore / queue) and is out of scope for this write.
 *
 * What we CAN bound honestly is how long one batch holds its locks: the desktop
 * client aborts this request after 15s (`REQUEST_TIMEOUT_MS` in
 * `apps/desktop/src/main/packs/distributions-client.ts`), so a server tx that
 * runs past 15s only does wasted work and holds locks for a caller that is
 * already gone. We therefore align the tx timeout to that 15s client deadline —
 * 3x Prisma's 5s default (headroom for the capped batch's serialized lock
 * waits) yet never outliving the request that asked for it. `maxWait` (5s) is
 * the unrelated pool-acquire budget for starting the transaction.
 */
const STATUS_REPORT_TRANSACTION_MAX_WAIT_MS = 5000;
/**
 * Aligned to the desktop client's 15s request abort — see the block comment
 * above. Do not raise past the client deadline without a matching change to
 * `REQUEST_TIMEOUT_MS` in the desktop distributions client.
 */
const STATUS_REPORT_TRANSACTION_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Private mappers
// ---------------------------------------------------------------------------

function toCatalogItemSummary(item: {
  id: string;
  name: string;
  targetKind: string;
  source: string;
  coaching: boolean;
}): Pick<CatalogItemDto, "id" | "name" | "targetKind" | "source"> & {
  coaching: boolean;
} {
  return {
    id: item.id,
    name: item.name,
    targetKind: item.targetKind,
    source: item.source as CatalogItemDto["source"],
    coaching: item.coaching,
  };
}

function toTargetingEntries(
  rows: Array<{ computeTargetId: string | null; userId: string | null }>
): DistributionTargetingEntry[] {
  return rows.map((r) => ({
    computeTargetId: r.computeTargetId,
    userId: r.userId,
  }));
}

function toTargetStatusDto(row: {
  id: string;
  distributionId: string;
  computeTargetId: string | null;
  userId: string | null;
  status: string;
  installedVersion: string | null;
  installRunId: string | null;
  overriddenLocally: boolean;
  failureReason: string | null;
  installedAt: Date | null;
  enabledAt: Date | null;
  reportedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): DistributionTargetStatusDto {
  return {
    id: row.id,
    distributionId: row.distributionId,
    computeTargetId: row.computeTargetId,
    userId: row.userId,
    status: row.status as DistributionTargetStatusValue,
    installedVersion: row.installedVersion,
    installRunId: row.installRunId,
    overriddenLocally: row.overriddenLocally,
    failureReason: row.failureReason,
    installedAt: row.installedAt?.toISOString() ?? null,
    enabledAt: row.enabledAt?.toISOString() ?? null,
    reportedAt: row.reportedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDistributionDto(
  row: {
    id: string;
    organizationId: string;
    catalogItemId: string;
    mode: string;
    targetingType: string;
    desiredEnabled: boolean;
    // ISS-5123. Optional on the row type because the older selects that predate
    // the column are still valid inputs to this mapper in tests/fixtures; an
    // absent value maps to `null` (not withdrawn), never to a fabricated date.
    withdrawnAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    catalogItem: {
      id: string;
      name: string;
      targetKind: string;
      source: string;
      coaching: boolean;
    };
    targetingEntries: Array<{
      computeTargetId: string | null;
      userId: string | null;
    }>;
    // Omitted on the list AND assigned-target paths (both use
    // `distributionListSelect`, see FEA-4190); populated only on the
    // single-distribution detail read. Defaults to `[]` on the DTO when absent.
    targetStatuses?: Array<{
      id: string;
      distributionId: string;
      computeTargetId: string | null;
      userId: string | null;
      status: string;
      installedVersion: string | null;
      installRunId: string | null;
      overriddenLocally: boolean;
      failureReason: string | null;
      installedAt: Date | null;
      enabledAt: Date | null;
      reportedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
  },
  assetDownloadUrl: string | null = null
): DistributionDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    catalogItemId: row.catalogItemId,
    catalogItem: toCatalogItemSummary(row.catalogItem),
    mode: row.mode as DistributionMode,
    targetingType: row.targetingType as DistributionTargetingType,
    desiredEnabled: row.desiredEnabled,
    targetingEntries: toTargetingEntries(row.targetingEntries),
    targetStatuses: (row.targetStatuses ?? []).map(toTargetStatusDto),
    assetDownloadUrl,
    withdrawnAt: row.withdrawnAt ? row.withdrawnAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a presigned S3 download URL for a CatalogItem's zip asset.
 * Returns null if the key is absent.
 *
 * Uses `getCatalogAssetDownloadUrl` (the same helper the logo download path
 * uses) so the URL is signed against the persisted `zipAssetBucket`
 * (PLUGIN_STORE_BUCKET) rather than the FILE_ATTACHMENTS_BUCKET default of the
 * generic `getSignedDownloadUrl`. The persisted bucket is passed explicitly;
 * `resolveCatalogBucket` inside the helper falls back to PLUGIN_STORE_BUCKET
 * when the override is absent.
 */
async function buildAssetDownloadUrl(item: {
  zipAssetBucket: string | null;
  zipAssetKey: string | null;
}): Promise<string | null> {
  if (!(item.zipAssetBucket && item.zipAssetKey)) {
    return null;
  }
  try {
    return await getCatalogAssetDownloadUrl(item.zipAssetKey, {
      expiresIn: ASSET_DOWNLOAD_URL_TTL_SECONDS,
      bucket: item.zipAssetBucket,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Selects
// ---------------------------------------------------------------------------

const distributionSelect = {
  id: true,
  organizationId: true,
  catalogItemId: true,
  mode: true,
  targetingType: true,
  desiredEnabled: true,
  withdrawnAt: true,
  createdAt: true,
  updatedAt: true,
  catalogItem: {
    select: {
      id: true,
      name: true,
      targetKind: true,
      source: true,
      coaching: true,
    },
  },
  targetingEntries: {
    select: { computeTargetId: true, userId: true },
  },
  targetStatuses: {
    select: {
      id: true,
      distributionId: true,
      computeTargetId: true,
      userId: true,
      status: true,
      installedVersion: true,
      installRunId: true,
      overriddenLocally: true,
      failureReason: true,
      installedAt: true,
      enabledAt: true,
      reportedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} as const;

/**
 * List / assigned-target select: same as `distributionSelect` but WITHOUT the
 * potentially unbounded per-device `targetStatuses` relation. Both the
 * `GET /distributions` list and the desktop assigned-target read
 * (`getAssignedForTarget`) use this select, and the `DistributionDto` docs omit
 * `targetStatuses` — it is populated only on the single-distribution detail read
 * (`getDetailForOrg`, via `distributionSelect`). Pushing the omission into the
 * query keeps the payload bounded regardless of how many devices have reported
 * status for a distribution.
 */
const distributionListSelect = {
  id: true,
  organizationId: true,
  catalogItemId: true,
  mode: true,
  targetingType: true,
  desiredEnabled: true,
  withdrawnAt: true,
  createdAt: true,
  updatedAt: true,
  catalogItem: {
    select: {
      id: true,
      name: true,
      targetKind: true,
      source: true,
      coaching: true,
    },
  },
  targetingEntries: {
    select: { computeTargetId: true, userId: true },
  },
} as const;

// ---------------------------------------------------------------------------
// Private transaction helpers
// ---------------------------------------------------------------------------

/**
 * Compute the candidate install/enable milestone timestamps a status report
 * would record on a brand-new row.
 *
 * `installedAt`/`enabledAt` capture when the plugin was *first* observed
 * installed/enabled on this device — milestone timestamps, not last-seen. Each
 * is `now` when the incoming status warrants that milestone, else `null`.
 * Preserving an already-recorded milestone on an existing row is handled by the
 * `COALESCE(existing, EXCLUDED)` in `upsertOneStatusReport`'s upsert, so these
 * candidates are only ever applied when the row's value is still unset.
 */
function resolveStatusTimestamps(
  status: string,
  now: Date
): { installedAt: Date | null; enabledAt: Date | null } {
  const isInstalled =
    status === DistributionTargetStatusValue.Installed ||
    status === DistributionTargetStatusValue.Enabled;
  const isEnabled = status === DistributionTargetStatusValue.Enabled;

  return {
    installedAt: isInstalled ? now : null,
    enabledAt: isEnabled ? now : null,
  };
}

/**
 * Upsert a single DistributionTargetStatus row within a transaction.
 *
 * Uses an atomic `INSERT ... ON CONFLICT DO UPDATE` targeting the partial
 * unique index on `(distribution_id, compute_target_id) WHERE compute_target_id
 * IS NOT NULL`, so two concurrent reports for the same
 * `(distributionId, computeTargetId)` — e.g. an overlapping desktop retry —
 * can't both insert and race the index into a `P2002` (which would roll back
 * the whole batch transaction and return a 500). A read-then-write
 * (`findFirst` + `create`) can't be made safe here: once the losing `create`
 * raises the unique violation inside the READ COMMITTED transaction, Postgres
 * aborts the transaction and no in-transaction `updateMany` fallback can run.
 *
 * A transaction-scoped advisory lock keyed on this report's
 * `(distributionId, computeTargetId)` — the unique key — is taken first (FEA-2994,
 * mirroring the per-record lock in agent-sessions/service.ts). The atomic upsert
 * already makes the write race-free, but the lock serializes concurrent reports
 * for the *same* target so they observe each other's committed row in order, and
 * — paired with the deterministic report ordering in the caller — guarantees two
 * overlapping batches can never deadlock on a shared pair. It serializes only on
 * the shared key, so unrelated distributions proceed in parallel.
 *
 * The upsert is freshness-aware (FEA-4193): a batch captures `now` once and
 * writes it as `reported_at`, but advisory-lock contention can let an OLDER wide
 * batch resume and reach a shared key *after* a NEWER batch already committed it.
 * An unconditional `DO UPDATE` would then clobber the newer row's last-seen
 * fields (status, installed_version, install_run_id, failure_reason, reported_at)
 * with stale data. So each last-seen field is only taken from the incoming
 * (EXCLUDED) row when `EXCLUDED.reported_at >= existing.reported_at`; otherwise
 * the persisted value is kept. `reported_at` itself advances monotonically via
 * `GREATEST(existing, EXCLUDED)`. Ties (equal `reported_at` — e.g. two reports
 * minted in the same millisecond, or a duplicate id within a batch) resolve to
 * the incoming row (`>=`), which is deterministic and idempotent for identical
 * data. A stale batch that lost the race can no longer overwrite the newer
 * committed value.
 *
 * First-seen `installedAt`/`enabledAt` milestones are preserved via
 * `COALESCE(existing, EXCLUDED)` and kept OUTSIDE the freshness gate: the
 * incoming report only supplies a timestamp when the milestone is newly reached
 * (see `resolveStatusTimestamps`), and once recorded the earliest value always
 * wins regardless of arrival order, so a stale batch can still fill a milestone
 * the newer batch never observed without ever rewriting one. The `id` PK is
 * minted in app code with `uuidv7()` — Prisma's client-side `@default(uuid(7))`
 * does not apply to raw SQL and the column has no DB default, and a raw
 * `gen_random_uuid()` (UUIDv4) would break the table's time-ordered ids.
 */
async function upsertOneStatusReport(
  tx: TransactionClient,
  report: DistributionStatusReport,
  computeTargetId: string,
  userId: string,
  now: Date
): Promise<void> {
  // Serialize concurrent reports for the same (distributionId, computeTargetId)
  // on a transaction-scoped advisory lock (FEA-2994). The atomic upsert below is
  // already race-free, but this — combined with the caller's deterministic report
  // ordering — prevents overlapping batches from deadlocking on a shared pair.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${report.distributionId}:${computeTargetId}`}))`;

  // Candidate first-seen milestones for a brand-new row; the COALESCE in the
  // upsert keeps any already-recorded value on an existing row untouched.
  const { installedAt, enabledAt } = resolveStatusTimestamps(
    report.status,
    now
  );

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO distribution_target_status (
      id,
      distribution_id,
      compute_target_id,
      user_id,
      status,
      installed_version,
      install_run_id,
      failure_reason,
      reported_at,
      installed_at,
      enabled_at,
      created_at,
      updated_at
    )
    VALUES (
      ${uuidv7()}::uuid,
      ${report.distributionId}::uuid,
      ${computeTargetId}::uuid,
      ${userId}::uuid,
      ${report.status},
      ${report.installedVersion ?? null},
      ${report.installRunId ?? null},
      ${report.failureReason ?? null},
      ${now},
      ${installedAt},
      ${enabledAt},
      now(),
      now()
    )
    ON CONFLICT (distribution_id, compute_target_id) WHERE compute_target_id IS NOT NULL
    DO UPDATE SET
      -- Freshness guard (FEA-4193): a stale batch that lost the advisory-lock
      -- race must not clobber a newer committed row. Each last-seen field takes
      -- the incoming (EXCLUDED) value only when this report is at least as recent
      -- as the persisted row; on an exact reported_at tie the incoming row wins.
      -- A NULL persisted reported_at (rows written by other paths carry no
      -- freshness baseline) COALESCEs to the incoming value so the report is not
      -- dropped. EXCLUDED.reported_at is always the batch now value (never NULL).
      status = CASE WHEN EXCLUDED.reported_at >= COALESCE(distribution_target_status.reported_at, EXCLUDED.reported_at) THEN EXCLUDED.status ELSE distribution_target_status.status END,
      installed_version = CASE WHEN EXCLUDED.reported_at >= COALESCE(distribution_target_status.reported_at, EXCLUDED.reported_at) THEN EXCLUDED.installed_version ELSE distribution_target_status.installed_version END,
      install_run_id = CASE WHEN EXCLUDED.reported_at >= COALESCE(distribution_target_status.reported_at, EXCLUDED.reported_at) THEN EXCLUDED.install_run_id ELSE distribution_target_status.install_run_id END,
      failure_reason = CASE WHEN EXCLUDED.reported_at >= COALESCE(distribution_target_status.reported_at, EXCLUDED.reported_at) THEN EXCLUDED.failure_reason ELSE distribution_target_status.failure_reason END,
      reported_at = GREATEST(distribution_target_status.reported_at, EXCLUDED.reported_at),
      installed_at = COALESCE(distribution_target_status.installed_at, EXCLUDED.installed_at),
      enabled_at = COALESCE(distribution_target_status.enabled_at, EXCLUDED.enabled_at),
      updated_at = now()
  `);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const distributionsService = {
  /**
   * List the org's LIVE distributions (org-visible, no admin gate).
   * Does not populate per-device `targetStatuses` (list view only).
   *
   * ISS-5123: excludes withdrawn distributions. This is what makes the admin
   * Packs surface show a withdrawn pack as "Not distributed yet" again — and
   * therefore what makes withdrawal reversible, since re-distributing is just
   * creating a new distribution.
   */
  async listForOrg(organizationId: string): Promise<DistributionDto[]> {
    const rows = await withDb((db) =>
      db.distribution.findMany({
        where: { organizationId, withdrawnAt: null },
        orderBy: { createdAt: "desc" },
        select: distributionListSelect,
      })
    );
    return rows.map((row) => toDistributionDto(row));
  },

  /**
   * Get a single distribution with full `DistributionTargetStatus` rows.
   * Returns null when the distribution is not found or belongs to a different org.
   */
  async getDetailForOrg(
    organizationId: string,
    distributionId: string
  ): Promise<DistributionDto | null> {
    const row = await withDb((db) =>
      db.distribution.findFirst({
        where: { id: distributionId, organizationId },
        select: distributionSelect,
      })
    );
    if (!row) {
      return null;
    }
    return toDistributionDto(row);
  },

  /**
   * Create a new Distribution (admin-only).
   * Validates that the catalogItem belongs to the org (or is curated).
   * Creates DistributionTargetingEntry rows for specific-targeting.
   */
  async create(
    organizationId: string,
    userId: string,
    clerkOrgId: string,
    clerkUserId: string,
    body: CreateDistributionRequest
  ): Promise<Result<DistributionDto, StatusCode>> {
    const admin = await isOrgAdmin(clerkOrgId, clerkUserId);
    if (!admin) {
      return Result.err(Status.Forbidden);
    }

    const catalogItem = await withDb((db) =>
      db.catalogItem.findFirst({
        where: {
          id: body.catalogItemId,
          OR: [{ organizationId }, { scope: "global" }],
          archived: false,
        },
        select: { id: true },
      })
    );
    if (!catalogItem) {
      return Result.err(Status.BadRequest);
    }

    const distribution = await withDb((db) =>
      db.distribution.create({
        data: {
          organizationId,
          catalogItemId: body.catalogItemId,
          mode: body.mode,
          targetingType: body.targetingType,
          desiredEnabled: body.desiredEnabled ?? true,
          createdById: userId,
          ...(body.targetingType === DistributionTargetingType.Specific && {
            targetingEntries: {
              create: [
                ...(body.targetComputeTargetIds ?? []).map(
                  (computeTargetId) => ({
                    computeTargetId,
                    userId: null,
                  })
                ),
                ...(body.targetUserIds ?? []).map((targetUserId) => ({
                  computeTargetId: null,
                  userId: targetUserId,
                })),
              ],
            },
          }),
        },
        select: distributionSelect,
      })
    );

    return Result.ok(toDistributionDto(distribution));
  },

  /**
   * Update an existing Distribution's mode/targeting (admin-only).
   */
  async update(
    organizationId: string,
    distributionId: string,
    clerkOrgId: string,
    clerkUserId: string,
    body: UpdateDistributionRequest
  ): Promise<Result<DistributionDto, StatusCode>> {
    const admin = await isOrgAdmin(clerkOrgId, clerkUserId);
    if (!admin) {
      return Result.err(Status.Forbidden);
    }

    // ISS-5123: a withdrawn distribution is not editable. Two admins can race —
    // one withdraws while the other has the edit dialog open — and letting the
    // late PATCH land would report success for a change no member will ever
    // receive, because every live read filters the row out. Treating it as gone
    // (404) is the only answer that does not lie about the roll-out state.
    //
    // This read resolves the CURRENT targeting type (needed to decide what the
    // rebuild should write when the body omits it); it deliberately does NOT
    // stand in for the liveness check. A separate read leaves a window in which
    // a concurrent DELETE stamps `withdrawnAt` before the update lands, and a
    // write keyed on `id` alone would then edit — and report 200 for — a
    // distribution that is already gone. The `withdrawnAt: null` predicate
    // therefore rides on the write itself, below.
    const existing = await withDb((db) =>
      db.distribution.findFirst({
        where: { id: distributionId, organizationId, withdrawnAt: null },
        select: { id: true, targetingType: true },
      })
    );
    if (!existing) {
      return Result.err(Status.NotFound);
    }

    const newTargetingType = body.targetingType ?? existing.targetingType;
    const needsEntryRebuild =
      body.targetingType !== undefined ||
      body.targetComputeTargetIds !== undefined ||
      body.targetUserIds !== undefined;

    // `updateMany`, not `update`: it is the only form that carries the
    // `withdrawnAt: null` predicate into the same statement as the write, so the
    // affected-row count is an atomic answer to "was this still live when I
    // wrote?" rather than a stale echo of the read above.
    const liveDistribution = {
      id: distributionId,
      organizationId,
      withdrawnAt: null,
    };
    const scalarEdits = {
      ...(body.mode !== undefined && { mode: body.mode }),
      ...(body.targetingType !== undefined && {
        targetingType: body.targetingType,
      }),
      ...(body.desiredEnabled !== undefined && {
        desiredEnabled: body.desiredEnabled,
      }),
    };

    if (needsEntryRebuild) {
      const rebuilt = await withDb.tx(async (tx) => {
        const { count } = await tx.distribution.updateMany({
          where: liveDistribution,
          data: scalarEdits,
        });
        if (count === 0) {
          // Withdrawn between the read and this write. Nothing has been written
          // yet, and returning here keeps it that way: the targeting rebuild is
          // skipped inside the same transaction, so a withdrawn row can never be
          // left carrying entries rewritten by a PATCH that answers 404.
          return false;
        }
        // Every rebuild starts from a clean slate; "all" simply stops here,
        // which is what dropping its stale specific entries means.
        await tx.distributionTargetingEntry.deleteMany({
          where: { distributionId },
        });
        if (newTargetingType === DistributionTargetingType.Specific) {
          const entries = [
            ...(body.targetComputeTargetIds ?? []).map((computeTargetId) => ({
              distributionId,
              computeTargetId,
              userId: null as string | null,
            })),
            ...(body.targetUserIds ?? []).map((targetUserId) => ({
              distributionId,
              computeTargetId: null as string | null,
              userId: targetUserId,
            })),
          ];
          if (entries.length > 0) {
            await tx.distributionTargetingEntry.createMany({ data: entries });
          }
        }
        return true;
      });
      if (!rebuilt) {
        return Result.err(Status.NotFound);
      }
    } else {
      const { count } = await withDb((db) =>
        db.distribution.updateMany({
          where: liveDistribution,
          data: scalarEdits,
        })
      );
      if (count === 0) {
        return Result.err(Status.NotFound);
      }
    }

    const updated = await withDb((db) =>
      db.distribution.findFirst({
        where: { id: distributionId },
        select: distributionSelect,
      })
    );
    if (!updated) {
      return Result.err(Status.Error);
    }
    return Result.ok(toDistributionDto(updated));
  },

  /**
   * Withdraw a Distribution — stop offering this pack to the organization
   * (ISS-5123). Admin-only, under the existing `Distribute` capability: the
   * right to offer a pack org-wide and the right to stop offering it are the
   * same authority, so this deliberately adds no new capability and widens
   * nobody's permissions.
   *
   * ## What it does and does not do
   *
   * Withdrawal removes the OFFER. The distribution leaves `listForOrg` and the
   * desktop `getAssignedForTarget` poll, so no member is offered it and no
   * device auto-installs it again. Copies already installed on members' machines
   * are deliberately left alone and keep working: the desktop reconcile is
   * additive and never uninstalls a pack that disappears from its assignment
   * list, so no remote-cleanup path is triggered here. In-flight installs also
   * still settle — `upsertStatusReports` intentionally keeps accepting reports
   * for a withdrawn distribution, so a device that fetched the assignment a
   * moment before withdrawal records its real outcome instead of erroring.
   *
   * ## Idempotency
   *
   * The state change is a single conditional `updateMany` on `withdrawnAt: null`,
   * so two concurrent withdrawals cannot both stamp the row and there is no
   * read-then-write window. A second withdrawal — a double click, a retry, a
   * second admin — matches zero rows and returns the already-withdrawn record as
   * a success, because "the org no longer offers this pack" is exactly the state
   * the caller asked for. It is a no-op, never an error and never a re-stamp
   * that would rewrite who withdrew it and when.
   *
   * Returns `NotFound` only when no such distribution exists in this org at all.
   */
  async withdraw(
    organizationId: string,
    distributionId: string,
    userId: string,
    clerkOrgId: string,
    clerkUserId: string
  ): Promise<Result<DistributionDto, StatusCode>> {
    const admin = await isOrgAdmin(clerkOrgId, clerkUserId);
    if (!admin) {
      return Result.err(Status.Forbidden);
    }

    await withDb((db) =>
      db.distribution.updateMany({
        where: { id: distributionId, organizationId, withdrawnAt: null },
        data: { withdrawnAt: new Date(), withdrawnById: userId },
      })
    );

    // Re-read unconditionally rather than branching on the update count: the
    // already-withdrawn case and the just-withdrawn case must return the same
    // shape, and a zero count alone cannot tell "already withdrawn" from
    // "wrong org / no such id".
    const row = await withDb((db) =>
      db.distribution.findFirst({
        where: { id: distributionId, organizationId },
        select: distributionSelect,
      })
    );
    if (!row) {
      return Result.err(Status.NotFound);
    }
    return Result.ok(toDistributionDto(row));
  },

  // ---------------------------------------------------------------------------
  // Desktop distribution endpoints
  // ---------------------------------------------------------------------------

  /**
   * Get distributions assigned to a compute target.
   *
   * Returns distributions where:
   * - `targetingType = all` (org-wide), or
   * - `targetingType = specific` with a matching `computeTargetId` or `userId` entry.
   *
   * For `auto_install` distributions with a zip asset, attaches a 15-minute
   * presigned S3 download URL. ComputeTarget ownership must be verified by the
   * route before calling this method.
   *
   * Uses `distributionListSelect` (no per-device `targetStatuses`): the desktop
   * assignment poll discards that relation, so fetching every org device's
   * install-status rows for each assigned distribution grows the payload
   * O(devices) per distribution for no benefit. A future consumer that needs
   * own-target status should scope to `where: { computeTargetId }` rather than
   * re-adding the unbounded relation.
   */
  async getAssignedForTarget(
    organizationId: string,
    computeTargetId: string,
    userId: string
  ): Promise<DistributionDto[]> {
    const rows = await withDb((db) =>
      db.distribution.findMany({
        where: {
          organizationId,
          // ISS-5123: a withdrawn distribution is no longer offered to the org,
          // so it must leave this poll — this predicate IS "stop distributing".
          // It only stops the OFFER: packs already installed from it are left
          // alone (the desktop reconcile is additive and never uninstalls what
          // disappears from this list), which is the withdrawal semantic the
          // ticket asks for.
          withdrawnAt: null,
          catalogItem: { archived: false, enabled: true },
          OR: [
            { targetingType: DistributionTargetingType.All },
            {
              targetingType: DistributionTargetingType.Specific,
              targetingEntries: {
                some: {
                  OR: [{ computeTargetId }, { userId }],
                },
              },
            },
          ],
        },
        select: {
          ...distributionListSelect,
          catalogItem: {
            select: {
              id: true,
              name: true,
              targetKind: true,
              source: true,
              coaching: true,
              zipAssetBucket: true,
              zipAssetKey: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      })
    );

    const results: DistributionDto[] = [];
    for (const row of rows) {
      let assetDownloadUrl: string | null = null;
      if (row.mode === DistributionMode.AutoInstall) {
        assetDownloadUrl = await buildAssetDownloadUrl(row.catalogItem);
      }
      results.push(toDistributionDto(row, assetDownloadUrl));
    }
    return results;
  },

  /**
   * Upsert DistributionTargetStatus rows from desktop status reports.
   * ComputeTarget ownership must be verified by the route before calling this method.
   * Returns the count of accepted (upserted) reports.
   */
  async upsertStatusReports(
    organizationId: string,
    computeTargetId: string,
    userId: string,
    clerkUserId: string | null,
    reports: DistributionStatusReport[]
  ): Promise<Result<number, StatusCode | "forbidden">> {
    // Verify compute target ownership
    const target = await computeTargetsService.findOwnedById(
      computeTargetId,
      organizationId,
      userId,
      clerkUserId
    );
    if (!target) {
      return Result.err("forbidden");
    }

    // Validate that all distributionIds belong to this org
    const distributionIds = [...new Set(reports.map((r) => r.distributionId))];
    const validDistributions = await withDb((db) =>
      db.distribution.findMany({
        where: { id: { in: distributionIds }, organizationId },
        select: { id: true },
      })
    );
    const validIds = new Set(validDistributions.map((d) => d.id));
    const validReports = reports.filter((r) => validIds.has(r.distributionId));

    if (validReports.length === 0) {
      return Result.ok(0);
    }

    const now = new Date();
    // The distribution_target_status table has a partial unique index on
    // (distribution_id, compute_target_id WHERE compute_target_id IS NOT NULL)
    // maintained via raw migration. Prisma cannot express partial indexes, so
    // each report is applied with an atomic raw INSERT ... ON CONFLICT DO UPDATE
    // (see upsertOneStatusReport) — concurrent reports for the same target can't
    // race the index into a P2002 and roll back the whole batch.
    //
    // Process reports in a deterministic distributionId order (FEA-2994) so that
    // two concurrent batches for the same compute target acquire the per-report
    // advisory locks (taken inside upsertOneStatusReport) in the same sequence
    // and can never deadlock on an overlapping pair. Each report serializes only
    // on its own (distributionId, computeTargetId) key, so unrelated
    // distributions in different batches no longer block behind one another.
    const orderedReports = [...validReports].sort((a, b) =>
      a.distributionId.localeCompare(b.distributionId)
    );
    await withDb.tx(
      async (tx) => {
        for (const report of orderedReports) {
          await upsertOneStatusReport(tx, report, computeTargetId, userId, now);
        }
      },
      {
        maxWait: STATUS_REPORT_TRANSACTION_MAX_WAIT_MS,
        timeout: STATUS_REPORT_TRANSACTION_TIMEOUT_MS,
      }
    );

    return Result.ok(validReports.length);
  },
};
