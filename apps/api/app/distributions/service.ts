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
    // Omitted on the list path (see `distributionListSelect`); populated only on
    // detail / assigned-target reads. Defaults to `[]` on the DTO when absent.
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
 * List-path select: same as `distributionSelect` but WITHOUT the potentially
 * unbounded per-device `targetStatuses` relation. The `GET /distributions` list
 * contract (and `DistributionDto` docs) omit `targetStatuses` — it is populated
 * only on the detail / assigned-target reads. Pushing the omission into the
 * query keeps the list payload bounded regardless of how many devices have
 * reported status for a distribution.
 */
const distributionListSelect = {
  id: true,
  organizationId: true,
  catalogItemId: true,
  mode: true,
  targetingType: true,
  desiredEnabled: true,
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
 * First-seen `installedAt`/`enabledAt` milestones are preserved via
 * `COALESCE(existing, EXCLUDED)`: the incoming report only supplies a timestamp
 * when the milestone is newly reached (see `resolveStatusTimestamps`), and any
 * already-recorded value on the existing row is kept untouched. The `id` PK is
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
      status = EXCLUDED.status,
      installed_version = EXCLUDED.installed_version,
      install_run_id = EXCLUDED.install_run_id,
      failure_reason = EXCLUDED.failure_reason,
      reported_at = EXCLUDED.reported_at,
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
   * List all non-archived distributions for an org (org-visible, no admin gate).
   * Does not populate per-device `targetStatuses` (list view only).
   */
  async listForOrg(organizationId: string): Promise<DistributionDto[]> {
    const rows = await withDb((db) =>
      db.distribution.findMany({
        where: { organizationId },
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

    const existing = await withDb((db) =>
      db.distribution.findFirst({
        where: { id: distributionId, organizationId },
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

    if (needsEntryRebuild) {
      await withDb.tx(async (tx) => {
        await tx.distribution.update({
          where: { id: distributionId },
          data: {
            ...(body.mode !== undefined && { mode: body.mode }),
            ...(body.targetingType !== undefined && {
              targetingType: body.targetingType,
            }),
            ...(body.desiredEnabled !== undefined && {
              desiredEnabled: body.desiredEnabled,
            }),
          },
        });
        if (newTargetingType === DistributionTargetingType.Specific) {
          await tx.distributionTargetingEntry.deleteMany({
            where: { distributionId },
          });
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
        } else {
          // Switched to "all" — remove old specific entries
          await tx.distributionTargetingEntry.deleteMany({
            where: { distributionId },
          });
        }
      });
    } else {
      await withDb((db) =>
        db.distribution.update({
          where: { id: distributionId },
          data: {
            ...(body.mode !== undefined && { mode: body.mode }),
            ...(body.desiredEnabled !== undefined && {
              desiredEnabled: body.desiredEnabled,
            }),
          },
        })
      );
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
          ...distributionSelect,
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
    await withDb.tx(async (tx) => {
      for (const report of orderedReports) {
        await upsertOneStatusReport(tx, report, computeTargetId, userId, now);
      }
    });

    return Result.ok(validReports.length);
  },
};
