/**
 * Constraint and idempotency integration tests: TS-I.16
 *
 * Covers:
 *   TS-I.16  Idempotency — running seed twice produces same counts (AC-001, AC-002)
 *
 * This suite runs the seed twice against the same ephemeral database and
 * asserts that row counts are identical after the second run. This validates
 * that all domain seed functions use upsert semantics and do not insert
 * duplicate rows.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../../index";
import { BASELINE_ORG_ID, baselineContext } from "../fixtures/baseline-org";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../fixtures/ephemeral-db";

const DATABASE_URL_SET = Boolean(process.env.DATABASE_URL);

describe.skipIf(!DATABASE_URL_SET)(
  "Seed idempotency integration tests (TS-I.16)",
  () => {
    let ctx: EphemeralDbContext;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
      await runSeed(ctx.prisma, baselineContext);
    }, 120_000);

    afterAll(async () => {
      await teardownEphemeralDb(ctx);
    });

    async function collectCounts(prisma: EphemeralDbContext["prisma"]) {
      const orgId = BASELINE_ORG_ID;
      const [
        teamCount,
        teamMemberCount,
        projectCount,
        artifactCount,
        documentVersionCount,
        slugCounterCount,
        loopCount,
        gitHubInstallationCount,
        gitHubRepositoryCount,
        gitHubUserConnectionCount,
        pullRequestDetailCount,
        gitHubPRReviewCount,
        linearIntegrationCount,
        slackIntegrationCount,
        artifactEvaluationCount,
        judgeScoreCount,
        judgeHumanScoreCount,
        customFieldCount,
        customFieldEnumOptionCount,
        customFieldSettingCount,
        customFieldValueCount,
        commentThreadCount,
        commentCount,
        commentReactionCount,
        commentAttachmentCount,
        artifactLinkCount,
        artifactRatingCount,
        fileAttachmentCount,
        loopEventCount,
        promptCount,
      ] = await Promise.all([
        prisma.team.count({ where: { organizationId: orgId } }),
        prisma.teamMember.count({
          where: { team: { organizationId: orgId } },
        }),
        prisma.project.count({ where: { organizationId: orgId } }),
        prisma.artifact.count({ where: { organizationId: orgId } }),
        prisma.documentVersion.count({
          where: { documentDetail: { artifact: { organizationId: orgId } } },
        }),
        prisma.slugCounter.count({ where: { organizationId: orgId } }),
        prisma.loop.count({ where: { organizationId: orgId } }),
        prisma.gitHubInstallation.count({ where: { organizationId: orgId } }),
        prisma.gitHubInstallationRepository.count({
          where: { installation: { organizationId: orgId } },
        }),
        prisma.gitHubUserConnection.count({ where: { organizationId: orgId } }),
        prisma.pullRequestDetail.count({
          where: { branchArtifact: { organizationId: orgId } },
        }),
        prisma.gitHubPRReview.count({
          where: {
            pullRequestDetail: {
              branchArtifact: { organizationId: orgId },
            },
          },
        }),
        prisma.linearIntegration.count({ where: { organizationId: orgId } }),
        prisma.slackIntegration.count({ where: { organizationId: orgId } }),
        prisma.artifactEvaluation.count({ where: { organizationId: orgId } }),
        prisma.judgeScore.count({
          where: { evaluation: { organizationId: orgId } },
        }),
        prisma.judgeHumanScore.count({ where: { organizationId: orgId } }),
        prisma.customField.count({ where: { organizationId: orgId } }),
        prisma.customFieldEnumOption.count({
          where: { customField: { organizationId: orgId } },
        }),
        prisma.customFieldSetting.count({ where: { organizationId: orgId } }),
        prisma.customFieldValue.count({ where: { organizationId: orgId } }),
        prisma.commentThread.count({ where: { organizationId: orgId } }),
        prisma.comment.count({ where: { thread: { organizationId: orgId } } }),
        prisma.commentReaction.count({
          where: { comment: { thread: { organizationId: orgId } } },
        }),
        prisma.commentAttachment.count({
          where: { comment: { thread: { organizationId: orgId } } },
        }),
        prisma.artifactLink.count({ where: { organizationId: orgId } }),
        prisma.artifactRating.count({ where: { organizationId: orgId } }),
        prisma.fileAttachment.count({
          where: { artifact: { organizationId: orgId } },
        }),
        prisma.loopEvent.count({
          where: { loop: { organizationId: orgId } },
        }),
        prisma.prompt.count({ where: { organizationId: orgId } }),
      ]);

      return {
        teamCount,
        teamMemberCount,
        projectCount,
        artifactCount,
        documentVersionCount,
        slugCounterCount,
        loopCount,
        gitHubInstallationCount,
        gitHubRepositoryCount,
        gitHubUserConnectionCount,
        pullRequestDetailCount,
        gitHubPRReviewCount,
        linearIntegrationCount,
        slackIntegrationCount,
        artifactEvaluationCount,
        judgeScoreCount,
        judgeHumanScoreCount,
        customFieldCount,
        customFieldEnumOptionCount,
        customFieldSettingCount,
        customFieldValueCount,
        commentThreadCount,
        commentCount,
        commentReactionCount,
        commentAttachmentCount,
        artifactLinkCount,
        artifactRatingCount,
        fileAttachmentCount,
        loopEventCount,
        promptCount,
      };
    }

    describe("TS-I.16 — Running seed twice produces the same row counts (AC-001, AC-002)", () => {
      it("produces identical row counts after a second seed run", async () => {
        const countsBefore = await collectCounts(ctx.prisma);

        // Sanity floor: catches a silently empty first seed run that would
        // otherwise make every `0 === 0` assertion below trivially pass.
        expect(countsBefore.teamCount).toBeGreaterThan(0);
        expect(countsBefore.projectCount).toBeGreaterThan(0);
        expect(countsBefore.artifactCount).toBeGreaterThan(0);
        expect(countsBefore.loopCount).toBeGreaterThan(0);
        expect(countsBefore.documentVersionCount).toBeGreaterThan(0);
        expect(countsBefore.customFieldCount).toBeGreaterThan(0);
        expect(countsBefore.commentThreadCount).toBeGreaterThan(0);

        await runSeed(ctx.prisma, baselineContext);

        const countsAfter = await collectCounts(ctx.prisma);

        for (const key of Object.keys(countsBefore) as Array<
          keyof typeof countsBefore
        >) {
          expect(countsAfter[key], `count for ${key}`).toBe(countsBefore[key]);
        }
      }, 240_000);
    });
  }
);
