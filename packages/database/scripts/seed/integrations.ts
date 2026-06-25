import { GitHubPRState, ReviewDecision } from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import type { CoreSeedResult } from "./core";
import {
  createUpsertCounts,
  deterministicUuid,
  logUpsertSummary,
  seedLog,
  upsertRow,
} from "./helpers";
import type { SeedContext } from "./index";
import { resolveSeedRunPlan, type SeedRunPlan } from "./profiles";

/**
 * Seeds GitHub integration entities:
 * - GitHubInstallation (reuses the one created by seedCoreEntities)
 * - GitHubInstallationRepository (reuses the one created by seedCoreEntities)
 * - GitHubUserConnection
 * - PullRequestDetail (linked to the seeded BRANCH artifact)
 * - GitHubPRReview (inline review comments now live in the unified
 *   CommentThread/Comment projections, seeded in customization.ts)
 *
 * All external IDs use syntactically valid numeric-string placeholders that
 * look like real GitHub API responses (8-digit integers).
 *
 * All operations are idempotent — re-running the seed updates in place.
 *
 * @param prisma - Initialized PrismaClient connected to the target database.
 * @param context - Resolved organization and user identifiers.
 * @param coreResult - IDs for seeded core entities (artifacts, projects, etc.).
 */
export async function seedIntegrationEntities(
  prisma: TransactionClient,
  context: SeedContext,
  coreResult: CoreSeedResult,
  _plan: SeedRunPlan = resolveSeedRunPlan()
): Promise<void> {
  const { organizationId, userId } = context;
  const { githubRepositoryId, branchArtifactId } = coreResult;
  const counts = createUpsertCounts();

  seedLog("Seeding integration entities (GitHub)…");

  // GitHubInstallation and GitHubInstallationRepository are owned exclusively
  // by seedCoreEntities (because BranchDetail's FK chain requires them to
  // exist before any branch artifact). Their IDs flow in via `coreResult` —
  // this module no longer recomputes the deterministicUuid keys or holds a
  // parallel `create` block that could drift. Per PR review comment #8.

  // External-ID placeholders. Every column with a global UNIQUE constraint
  // (PullRequestDetail.githubId, GitHubPRReview.githubReviewId,
  // LinearIssue.linearId, LinearSubtask.linearId) must include
  // `organizationId` so seeding a second organization into the same database
  // doesn't collide with the first. Per PR review comment #10.
  const githubUserPlaceholder = `seed-gh-user-${organizationId}`;
  const githubPrPlaceholder = `seed-gh-pr-${organizationId}-1`;
  const githubReviewPlaceholder = `seed-gh-review-${organizationId}-1`;

  // ---------------------------------------------------------------------------
  // GitHubUserConnection — one per org/user, scoped to the seed user.
  // githubUserId uses a syntactically valid numeric-string placeholder.
  // accessTokenEncrypted stores a placeholder ciphertext (not a real secret).
  // ---------------------------------------------------------------------------

  const userConnectionId = deterministicUuid(
    `github-user-connection:${organizationId}:${userId}`
  );

  await upsertRow({
    model: "GitHubUserConnection",
    id: userConnectionId,
    upsert: () =>
      prisma.gitHubUserConnection.upsert({
        where: {
          organizationId_userId: {
            organizationId,
            userId,
          },
        },
        create: {
          id: userConnectionId,
          organizationId,
          userId,
          githubUserId: githubUserPlaceholder,
          githubNodeId: `U_kgDO_seed_${organizationId}`,
          login: "seed-user",
          normalizedLogin: "seed-user",
          avatarUrl: "https://avatars.githubusercontent.com/u/55443322",
          profileUrl: "https://github.com/seed-user",
          accessTokenEncrypted: "seed-placeholder-encrypted-token",
          scopes: ["repo", "read:org"],
        },
        update: {
          login: "seed-user",
          normalizedLogin: "seed-user",
        },
      }),
    counts,
  });

  // ---------------------------------------------------------------------------
  // PullRequestDetail — linked to the seeded BRANCH artifact.
  // githubId uses a syntactically valid numeric-string placeholder.
  // ---------------------------------------------------------------------------

  const pullRequestDetailId = deterministicUuid(
    `pull-request-detail:${organizationId}:seed-pr-1`
  );

  await upsertRow({
    model: "PullRequestDetail",
    id: pullRequestDetailId,
    upsert: () =>
      prisma.pullRequestDetail.upsert({
        where: { id: pullRequestDetailId },
        create: {
          id: pullRequestDetailId,
          branchArtifactId,
          repositoryId: githubRepositoryId,
          githubId: githubPrPlaceholder,
          number: 1,
          title: "Seed pull request: add feature branch",
          htmlUrl: "https://github.com/seed-org/seed-repo/pull/1",
          body: "This is a seed pull request created for development and testing purposes.",
          prState: GitHubPRState.OPEN,
          isDraft: false,
          isCurrent: true,
        },
        update: {
          title: "Seed pull request: add feature branch",
          isCurrent: true,
        },
      }),
    counts,
  });

  // ---------------------------------------------------------------------------
  // GitHubPRReview — one review on the seeded PR.
  // githubReviewId uses a syntactically valid numeric-string placeholder.
  // ---------------------------------------------------------------------------

  const prReviewId = deterministicUuid(
    `github-pr-review:${organizationId}:seed-review-1`
  );

  await upsertRow({
    model: "GitHubPRReview",
    id: prReviewId,
    upsert: () =>
      prisma.gitHubPRReview.upsert({
        where: { id: prReviewId },
        create: {
          id: prReviewId,
          pullRequestId: pullRequestDetailId,
          githubReviewId: githubReviewPlaceholder,
          authorLogin: "seed-reviewer",
          state: ReviewDecision.APPROVED,
          body: "Looks good! Seed review comment.",
          htmlUrl:
            "https://github.com/seed-org/seed-repo/pull/1#pullrequestreview-33221100",
          submittedAt: new Date("2024-01-15T10:00:00Z"),
        },
        update: {
          state: ReviewDecision.APPROVED,
        },
      }),
    counts,
  });

  // NOTE: the legacy inline PR-review-comment model and its state enum were
  // removed from the schema by main commit `7ba6cf2dc Remove legacy PR review
  // comment table`. Inline review comments are now persisted via the unified
  // comment projections (CommentThread/Comment, source=GITHUB) seeded in
  // customization.ts — no separate seed step needed here.

  logUpsertSummary(counts);

  await seedSlackEntities(prisma, context);
}

/**
 * Seeds Slack integration entities:
 * - SlackIntegration (one per org, placeholder accessToken / botUserId / teamId / teamName)
 *
 * All external IDs use placeholder strings that are syntactically valid but not
 * tied to a real Slack workspace.
 *
 * All operations are idempotent — re-running the seed updates in place.
 *
 * @param prisma - Initialized PrismaClient connected to the target database.
 * @param context - Resolved organization and user identifiers.
 */
async function seedSlackEntities(
  prisma: TransactionClient,
  context: SeedContext
): Promise<void> {
  const { organizationId } = context;
  const counts = createUpsertCounts();

  seedLog("Seeding Slack integration entities…");

  // ---------------------------------------------------------------------------
  // SlackIntegration — one per organization, scoped by the unique organizationId.
  // accessToken, botUserId, teamId, and teamName use placeholder values (not real secrets).
  // ---------------------------------------------------------------------------

  const slackIntegrationId = deterministicUuid(
    `slack-integration:${organizationId}:seed`
  );

  await upsertRow({
    model: "SlackIntegration",
    id: slackIntegrationId,
    upsert: () =>
      prisma.slackIntegration.upsert({
        where: { organizationId },
        create: {
          id: slackIntegrationId,
          organizationId,
          accessToken: "xoxb-seed-placeholder-token",
          botUserId: "U_SEED_BOT",
          teamId: "T_SEED_TEAM",
          teamName: "Seed Workspace",
        },
        update: {
          teamName: "Seed Workspace",
        },
      }),
    counts,
  });

  logUpsertSummary(counts);
}
