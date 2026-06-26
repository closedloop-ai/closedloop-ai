// Schema-drift detector: this seed exercises every Prisma model shape at runtime.
// If a migration changes the schema in ways not reflected here, the seed will fail,
// catching drift before it reaches production.
import type { PrismaClient } from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import { seedCoreEntities } from "./core";
import { seedCustomizationEntities } from "./customization";
import { seedEvaluationEntities } from "./evaluation";
import { seedExecutionEntities } from "./execution";
import { seedExtendedEntities } from "./extended";
import { seedError, seedLog } from "./helpers";
import { seedIntegrationEntities } from "./integrations";
import {
  resolveSeedRunPlan,
  SeedAuditMode,
  type SeedProfileTargets,
  type SeedRunPlan,
  SeedTransactionMode,
} from "./profiles";

type ModelCount = { name: string; count: number };

/**
 * Organization and user context required by the seed runner.
 * Resolved from the database before `runSeed()` is called.
 */
export type SeedContext = {
  /** The organization ID to scope all seeded rows to. */
  organizationId: string;
  /** The user ID of the authenticated seed runner (owner / admin). */
  userId: string;
};

/**
 * Orchestrates all domain seed modules in FK-dependency order, wrapped in a
 * single interactive transaction for atomicity.
 *
 * All domain modules are invoked sequentially within a single
 * `prisma.$transaction()` call so the entire seed either succeeds or rolls
 * back. The transaction timeout is set to 5 minutes to accommodate the volume
 * of upserts produced by all modules.
 *
 * After all modules complete, a final summary queries the live row-counts for
 * every seeded model and logs them so operators can confirm the expected data
 * is present.
 *
 * @param prisma - A fully-initialized PrismaClient connected to the target DB.
 * @param context - Resolved organization and user identifiers.
 */
export async function runSeed(
  prisma: PrismaClient,
  context: SeedContext,
  plan: SeedRunPlan = resolveSeedRunPlan()
): Promise<void> {
  const { organizationId, userId } = context;

  if (!organizationId) {
    throw new Error("runSeed: organizationId is required in SeedContext");
  }
  if (!userId) {
    throw new Error("runSeed: userId is required in SeedContext");
  }

  console.log(
    `[seed] Starting seed for organizationId=${organizationId} userId=${userId}`
  );
  seedLog(
    `Profile=${plan.profile} multiplier=${plan.multiplier} rng=${plan.rngMode} targets=${formatTargets(plan.targets)} audit=${plan.auditMode}`
  );

  if (plan.transaction.mode === SeedTransactionMode.SingleTransaction) {
    await prisma.$transaction(
      async (tx) => {
        await runSeedModules(tx, context, plan);
      },
      {
        timeout: plan.transaction.timeoutMs,
        maxWait: plan.transaction.maxWaitMs,
      }
    );
  } else {
    seedLog(
      `Using batched transaction strategy for perf profile (batchSize=${plan.transaction.batchSize}).`
    );
    await runSeedModulesInBatches(prisma, context, plan);
  }

  // ---------------------------------------------------------------------------
  // Final summary — query live row counts for every seeded model so operators
  // can confirm the expected data landed in the database.
  // ---------------------------------------------------------------------------

  const modelQueries: Array<{ name: string; query: Promise<number> }> = [
    { name: "Team", query: prisma.team.count({ where: { organizationId } }) },
    {
      name: "TeamMember",
      query: prisma.teamMember.count({
        where: { team: { organizationId } },
      }),
    },
    {
      name: "Project",
      query: prisma.project.count({ where: { organizationId } }),
    },
    {
      name: "Artifact",
      query: prisma.artifact.count({ where: { organizationId } }),
    },
    {
      name: "DocumentVersion",
      query: prisma.documentVersion.count({
        where: { documentDetail: { artifact: { organizationId } } },
      }),
    },
    {
      name: "SlugCounter",
      query: prisma.slugCounter.count({ where: { organizationId } }),
    },
    { name: "Loop", query: prisma.loop.count({ where: { organizationId } }) },
    {
      name: "GitHubInstallation",
      query: prisma.gitHubInstallation.count({ where: { organizationId } }),
    },
    {
      name: "GitHubInstallationRepository",
      query: prisma.gitHubInstallationRepository.count({
        where: { installation: { organizationId } },
      }),
    },
    {
      name: "GitHubUserConnection",
      query: prisma.gitHubUserConnection.count({ where: { organizationId } }),
    },
    {
      name: "PullRequestDetail",
      query: prisma.pullRequestDetail.count({
        where: { branchArtifact: { organizationId } },
      }),
    },
    {
      name: "GitHubPRReview",
      query: prisma.gitHubPRReview.count({
        where: {
          pullRequestDetail: { branchArtifact: { organizationId } },
        },
      }),
    },
    // The legacy inline PR-review-comment model was removed in main commit
    // 7ba6cf2dc; inline review comments now live in the unified
    // CommentThread/Comment projection (source=GITHUB), which is verified
    // separately below.
    {
      name: "SlackIntegration",
      query: prisma.slackIntegration.count({ where: { organizationId } }),
    },
    {
      name: "ArtifactEvaluation",
      query: prisma.artifactEvaluation.count({ where: { organizationId } }),
    },
    {
      name: "JudgeScore",
      query: prisma.judgeScore.count({
        where: { evaluation: { organizationId } },
      }),
    },
    {
      name: "JudgeHumanScore",
      query: prisma.judgeHumanScore.count({ where: { organizationId } }),
    },
    {
      name: "CustomField",
      query: prisma.customField.count({ where: { organizationId } }),
    },
    {
      name: "CustomFieldEnumOption",
      query: prisma.customFieldEnumOption.count({
        where: { customField: { organizationId } },
      }),
    },
    {
      name: "CustomFieldSetting",
      query: prisma.customFieldSetting.count({ where: { organizationId } }),
    },
    {
      name: "CustomFieldValue",
      query: prisma.customFieldValue.count({ where: { organizationId } }),
    },
    {
      name: "CommentThread",
      query: prisma.commentThread.count({ where: { organizationId } }),
    },
    {
      name: "Comment",
      query: prisma.comment.count({
        where: { thread: { organizationId } },
      }),
    },
    {
      name: "CommentReaction",
      query: prisma.commentReaction.count({
        where: { comment: { thread: { organizationId } } },
      }),
    },
    {
      name: "CommentAttachment",
      query: prisma.commentAttachment.count({
        where: { comment: { thread: { organizationId } } },
      }),
    },
    {
      name: "ArtifactLink",
      query: prisma.artifactLink.count({ where: { organizationId } }),
    },
    // Extended models.
    {
      name: "ArtifactRating",
      query: prisma.artifactRating.count({ where: { organizationId } }),
    },
    {
      name: "FileAttachment",
      query: prisma.fileAttachment.count({
        where: { artifact: { organizationId } },
      }),
    },
    {
      name: "LoopEvent",
      query: prisma.loopEvent.count({
        where: { loop: { organizationId } },
      }),
    },
    {
      name: "Prompt",
      query: prisma.prompt.count({ where: { organizationId } }),
    },
  ];

  const counts = await Promise.all(modelQueries.map((m) => m.query));

  const modelCounts: ModelCount[] = modelQueries.map((m, i) => ({
    name: m.name,
    count: counts[i],
  }));

  seedLog("Total rows seeded per model:");
  for (const { name, count } of modelCounts) {
    seedLog(`  ${name.padEnd(30)} ${count}`);
  }

  // ---------------------------------------------------------------------------
  // Non-zero population verification — confirm every target model has at least
  // one row.  Models with a zero count are collected and reported together so
  // operators see the full picture in one pass.
  // ---------------------------------------------------------------------------
  const unpopulatedModels: string[] = [];
  for (const { name, count } of modelCounts) {
    if (count === 0) {
      seedError(`Model "${name}" has zero rows — seed may be incomplete`);
      unpopulatedModels.push(name);
    }
  }

  if (unpopulatedModels.length > 0) {
    throw new Error(
      `Seed verification failed: the following models were not populated: ${unpopulatedModels.join(", ")}`
    );
  }

  seedLog("All target models verified: non-zero population confirmed");
  auditProfileTargets(modelCounts, plan);

  console.log("[seed] Seed complete");
}

async function runSeedModules(
  prisma: PrismaClient | TransactionClient,
  context: SeedContext,
  plan: SeedRunPlan
): Promise<void> {
  const coreResult = await seedCoreEntities(prisma, context, plan);

  await seedExecutionEntities(prisma, context, coreResult, plan);

  await seedIntegrationEntities(prisma, context, coreResult, plan);

  await seedEvaluationEntities(prisma, context, coreResult, plan);

  await seedCustomizationEntities(prisma, context, coreResult, plan);

  await seedExtendedEntities(prisma, context, coreResult, plan);
}

async function runSeedModulesInBatches(
  prisma: PrismaClient,
  context: SeedContext,
  plan: SeedRunPlan
): Promise<void> {
  seedLog(
    `Starting perf seed modules with bounded entity batches (batchSize=${plan.transaction.batchSize}).`
  );
  const core = await seedCoreEntities(prisma, context, plan);

  await seedExecutionEntities(prisma, context, core, plan);

  await seedIntegrationEntities(prisma, context, core, plan);

  await seedEvaluationEntities(prisma, context, core, plan);

  await seedCustomizationEntities(prisma, context, core, plan);

  await seedExtendedEntities(prisma, context, core, plan);
}

function formatTargets(targets: SeedProfileTargets): string {
  return `projects=${targets.projects},artifacts=${targets.artifacts},comments=${targets.comments},loops=${targets.loops}`;
}

function auditProfileTargets(
  modelCounts: readonly ModelCount[],
  plan: SeedRunPlan
): void {
  const counts = new Map(modelCounts.map(({ name, count }) => [name, count]));
  const audited = [
    { model: "Project", key: "projects" },
    { model: "Artifact", key: "artifacts" },
    { model: "Comment", key: "comments" },
    { model: "Loop", key: "loops" },
  ] as const;

  seedLog("Profile target audit:");
  for (const { model, key } of audited) {
    const count = counts.get(model) ?? 0;
    const range = plan.targetRanges[key];
    seedLog(
      `  ${model}: observed=${count} target=${plan.targets[key]} range=${range.min}-${range.max}`
    );
    if (
      shouldEnforceProfileTargetAudit(plan) &&
      (count < range.min || count > range.max)
    ) {
      throw new Error(
        `Profile target audit failed for ${model}: observed ${count}, expected ${range.min}-${range.max}`
      );
    }
  }
  if (!shouldEnforceProfileTargetAudit(plan)) {
    seedLog(
      `Profile target audit is informational for ${plan.auditMode} mode.`
    );
  }
}

function shouldEnforceProfileTargetAudit(plan: SeedRunPlan): boolean {
  // Idempotent reruns on a deterministic seed-owned org are allowed to drift
  // out of the current profile's target range (e.g., rerunning a smaller
  // profile against rows produced by a larger one) — surface the counts but
  // do not throw. Force-overwrite onto a non-empty real org is also informational
  // because real rows mixed with seed rows cannot satisfy a single profile range.
  return (
    plan.auditMode !== SeedAuditMode.ForceOverwriteNonEmpty &&
    plan.auditMode !== SeedAuditMode.IdempotentSeedOrg
  );
}
