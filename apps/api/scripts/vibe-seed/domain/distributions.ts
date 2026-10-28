import {
  DistributionMode,
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import type { VibeSeedContext } from "../stage";

/**
 * ISS-12017: distributions of the seeded Packs and the per-device install
 * status the Packs and Compliance screens read.
 *
 * RAW WRITES, deliberately. `distributionsService` cannot be loaded in a
 * script: its admin gate imports the Clerk server SDK, which fails to load
 * outside Next under either export condition (the same boundary
 * `core/local-trusted-identity.ts` documents). The writes mirror
 * `distributionsService.create` (the row plus nested targeting entries) and
 * `upsertOneStatusReport` (status, `reportedAt`, and the first-seen
 * `installedAt`/`enabledAt` milestones for the reported status). A live
 * distribution for the same item, or a status row for the same target, is left
 * alone, so a re-run writes nothing.
 */

const MS_PER_HOUR = 3_600_000;
/** How long before `now` the devices last reported; inside every recent window. */
const REPORTED_HOURS_AGO = 3;

type DistributionPlan = {
  readonly mode: DistributionMode;
  readonly targetingType: DistributionTargetingType;
  /** Status each compute target reports, by the target's position. */
  readonly statuses: readonly DistributionTargetStatusValue[];
};

/** One plan per seeded Pack, in `SEED_PACKS` order. */
const DISTRIBUTION_PLANS: readonly DistributionPlan[] = [
  {
    mode: DistributionMode.AutoInstall,
    targetingType: DistributionTargetingType.All,
    statuses: [
      DistributionTargetStatusValue.Enabled,
      DistributionTargetStatusValue.Installed,
    ],
  },
  {
    mode: DistributionMode.OptIn,
    targetingType: DistributionTargetingType.Specific,
    statuses: [DistributionTargetStatusValue.OptedIn],
  },
];

type ComputeTargetRow = { id: string; userId: string };

export async function seedDistributions(
  context: VibeSeedContext,
  packIds: readonly string[]
): Promise<void> {
  const targets = await context.prisma.computeTarget.findMany({
    where: { organizationId: context.organizationId, isCloudSentinel: false },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, userId: true },
  });
  if (targets.length === 0) {
    throw new Error(
      "the org has no compute target to distribute to; the golden ingest should have registered one"
    );
  }
  let statuses = 0;
  for (const [index, packId] of packIds.entries()) {
    const plan = DISTRIBUTION_PLANS[index % DISTRIBUTION_PLANS.length];
    const distributionId = await ensureDistribution(
      context,
      packId,
      plan,
      targets
    );
    statuses += await ensureTargetStatuses(
      context,
      distributionId,
      plan,
      targets
    );
  }
  context.log(
    `distributions: ${packIds.length} distribution(s), ${statuses} new status row(s)`
  );
}

async function ensureDistribution(
  context: VibeSeedContext,
  catalogItemId: string,
  plan: DistributionPlan,
  targets: readonly ComputeTargetRow[]
): Promise<string> {
  const existing = await context.prisma.distribution.findFirst({
    where: {
      organizationId: context.organizationId,
      catalogItemId,
      withdrawnAt: null,
    },
    select: { id: true },
  });
  if (existing) {
    return existing.id;
  }
  const specific =
    plan.targetingType === DistributionTargetingType.Specific
      ? {
          targetingEntries: {
            create: [
              { computeTargetId: targets[0].id, userId: null },
              { computeTargetId: null, userId: context.userId },
            ],
          },
        }
      : {};
  const created = await context.prisma.distribution.create({
    data: {
      organizationId: context.organizationId,
      catalogItemId,
      mode: plan.mode,
      targetingType: plan.targetingType,
      desiredEnabled: true,
      createdById: context.userId,
      ...specific,
    },
    select: { id: true },
  });
  return created.id;
}

async function ensureTargetStatuses(
  context: VibeSeedContext,
  distributionId: string,
  plan: DistributionPlan,
  targets: readonly ComputeTargetRow[]
): Promise<number> {
  const reportedAt = new Date(
    context.now.getTime() - REPORTED_HOURS_AGO * MS_PER_HOUR
  );
  let written = 0;
  for (const [index, status] of plan.statuses.entries()) {
    const target = targets[index % targets.length];
    const existing = await context.prisma.distributionTargetStatus.findFirst({
      where: { distributionId, computeTargetId: target.id },
      select: { id: true },
    });
    if (existing) {
      continue;
    }
    await context.prisma.distributionTargetStatus.create({
      data: {
        distributionId,
        computeTargetId: target.id,
        userId: target.userId,
        status,
        reportedAt,
        ...statusMilestones(status, reportedAt),
      },
      select: { id: true },
    });
    written += 1;
  }
  return written;
}

/** The milestones `resolveStatusTimestamps` stamps for a first report of `status`. */
function statusMilestones(
  status: DistributionTargetStatusValue,
  reportedAt: Date
): { installedAt: Date | null; enabledAt: Date | null } {
  const enabled = status === DistributionTargetStatusValue.Enabled;
  const installed =
    enabled || status === DistributionTargetStatusValue.Installed;
  return {
    installedAt: installed ? reportedAt : null,
    enabledAt: enabled ? reportedAt : null,
  };
}
