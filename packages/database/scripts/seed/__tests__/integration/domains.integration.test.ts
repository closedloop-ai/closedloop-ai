/**
 * Domain-specific integration tests: TS-I.8, TS-I.9, TS-I.10, TS-I.11, TS-I.12,
 * TS-I.13
 *
 * Covers:
 *   TS-I.8   ArtifactEvaluation per EvaluationReportType with JudgeScore/JudgeHumanScore (AC-010)
 *   TS-I.9   CustomField for all 6 CustomFieldType values with enum options (AC-011)
 *   TS-I.10  CustomFieldSetting/CustomFieldValue with type-specific columns (AC-014)
 *   TS-I.11  CommentThread sources (NATIVE, LIVEBLOCKS, GITHUB) with reactions/attachments (AC-015)
 *   TS-I.12  ArtifactLink covers all LinkType values (AC-016)
 *   TS-I.13  GitHub entities (Installation, Repo, UserConnection, PRReview, ActionRun) (AC-017)
 *
 * TS-I.14 (Linear entities) was removed in PLN-787 — seedLinearEntities depended
 * on workstreamId and was deleted alongside the workstream concept.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CustomFieldType,
  EvaluationReportType,
  LinkType,
  ThreadSource,
} from "../../../../generated/client";
import { runSeed } from "../../index";
import {
  BASELINE_ORG_ID,
  BASELINE_USER_ID,
  baselineContext,
} from "../fixtures/baseline-org";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../fixtures/ephemeral-db";

const DATABASE_URL_SET = Boolean(process.env.DATABASE_URL);

describe.skipIf(!DATABASE_URL_SET)(
  "Domain seed integration tests (TS-I.8 through TS-I.13)",
  () => {
    let ctx: EphemeralDbContext;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
      await runSeed(ctx.prisma, baselineContext);
    }, 120_000);

    afterAll(async () => {
      await teardownEphemeralDb(ctx);
    });

    // -------------------------------------------------------------------------
    // TS-I.8: ArtifactEvaluation per EvaluationReportType with JudgeScore/JudgeHumanScore (AC-010)
    // -------------------------------------------------------------------------

    describe("TS-I.8 — ArtifactEvaluation per EvaluationReportType with JudgeScore and JudgeHumanScore (AC-010)", () => {
      it("seeds one ArtifactEvaluation per EvaluationReportType value", async () => {
        const evaluations = await ctx.prisma.artifactEvaluation.findMany({
          where: { organizationId: BASELINE_ORG_ID },
          select: { reportType: true },
        });

        const seededTypes = new Set(evaluations.map((e) => e.reportType));
        for (const reportType of Object.values(EvaluationReportType)) {
          expect(
            seededTypes.has(reportType),
            `Expected ArtifactEvaluation with reportType=${reportType}`
          ).toBe(true);
        }
      });

      it("seeds at least one JudgeScore for each ArtifactEvaluation", async () => {
        const evaluations = await ctx.prisma.artifactEvaluation.findMany({
          where: { organizationId: BASELINE_ORG_ID },
          include: { judgeScores: true },
        });

        for (const evaluation of evaluations) {
          expect(
            evaluation.judgeScores.length,
            `ArtifactEvaluation ${evaluation.id} (${evaluation.reportType}) should have at least one JudgeScore`
          ).toBeGreaterThanOrEqual(1);
        }
      });

      it("seeds at least one JudgeHumanScore attributed to the seed user", async () => {
        const humanScores = await ctx.prisma.judgeHumanScore.findMany({
          where: {
            organizationId: BASELINE_ORG_ID,
            userId: BASELINE_USER_ID,
          },
        });
        expect(humanScores.length).toBeGreaterThanOrEqual(1);
      });

      it("seeds JudgeHumanScore rows linked to JudgeScore via judgeScoreId", async () => {
        const humanScores = await ctx.prisma.judgeHumanScore.findMany({
          where: { organizationId: BASELINE_ORG_ID },
          select: { judgeScoreId: true },
        });

        for (const hs of humanScores) {
          const judgeScore = await ctx.prisma.judgeScore.findUnique({
            where: { id: hs.judgeScoreId },
          });
          expect(judgeScore).not.toBeNull();
        }
      });
    });

    // -------------------------------------------------------------------------
    // TS-I.9: CustomField for all 6 CustomFieldType values with enum options (AC-011)
    // -------------------------------------------------------------------------

    describe("TS-I.9 — CustomField for all 6 CustomFieldType values with enum options (AC-011)", () => {
      it("seeds a CustomField for each CustomFieldType value", async () => {
        const fields = await ctx.prisma.customField.findMany({
          where: { organizationId: BASELINE_ORG_ID },
          select: { fieldType: true },
        });

        const seededTypes = new Set(fields.map((f) => f.fieldType));
        for (const fieldType of Object.values(CustomFieldType)) {
          expect(
            seededTypes.has(fieldType),
            `Expected a CustomField with fieldType=${fieldType}`
          ).toBe(true);
        }
      });

      it("seeds at least 3 CustomFieldEnumOption rows for the ENUM field", async () => {
        const enumField = await ctx.prisma.customField.findFirst({
          where: {
            organizationId: BASELINE_ORG_ID,
            fieldType: CustomFieldType.ENUM,
          },
          include: { enumOptions: true },
        });

        expect(enumField).not.toBeNull();
        expect(enumField?.enumOptions.length).toBeGreaterThanOrEqual(3);
      });

      it("seeds at least 3 CustomFieldEnumOption rows for the MULTI_ENUM field", async () => {
        const multiEnumField = await ctx.prisma.customField.findFirst({
          where: {
            organizationId: BASELINE_ORG_ID,
            fieldType: CustomFieldType.MULTI_ENUM,
          },
          include: { enumOptions: true },
        });

        expect(multiEnumField).not.toBeNull();
        expect(multiEnumField?.enumOptions.length).toBeGreaterThanOrEqual(3);
      });

      it("seeds no enum options for non-enum field types", async () => {
        for (const fieldType of [
          CustomFieldType.TEXT,
          CustomFieldType.NUMBER,
          CustomFieldType.DATE,
          CustomFieldType.PEOPLE,
        ]) {
          const field = await ctx.prisma.customField.findFirst({
            where: { organizationId: BASELINE_ORG_ID, fieldType },
            include: { enumOptions: true },
          });
          expect(field).not.toBeNull();
          expect(
            field?.enumOptions.length,
            `${fieldType} field should not have enum options`
          ).toBe(0);
        }
      });
    });

    // -------------------------------------------------------------------------
    // TS-I.10: CustomFieldSetting/CustomFieldValue with type-specific columns (AC-014)
    // -------------------------------------------------------------------------

    describe("TS-I.10 — CustomFieldSetting and CustomFieldValue with type-specific columns populated (AC-014)", () => {
      it("seeds at least one CustomFieldSetting scoped to the organization", async () => {
        const count = await ctx.prisma.customFieldSetting.count({
          where: { organizationId: BASELINE_ORG_ID },
        });
        expect(count).toBeGreaterThanOrEqual(1);
      });

      it("seeds at least one CustomFieldValue scoped to the organization", async () => {
        const count = await ctx.prisma.customFieldValue.count({
          where: { organizationId: BASELINE_ORG_ID },
        });
        expect(count).toBeGreaterThanOrEqual(1);
      });

      it("populates textValue on the TEXT CustomFieldValue rows", async () => {
        const textField = await ctx.prisma.customField.findFirst({
          where: {
            organizationId: BASELINE_ORG_ID,
            fieldType: CustomFieldType.TEXT,
          },
        });
        expect(textField).not.toBeNull();

        const textValues = await ctx.prisma.customFieldValue.findMany({
          where: {
            organizationId: BASELINE_ORG_ID,
            customFieldId: textField!.id,
          },
          select: { textValue: true },
        });

        expect(textValues.length).toBeGreaterThanOrEqual(1);
        for (const v of textValues) {
          expect(v.textValue).not.toBeNull();
        }
      });

      it("populates numberValue on the NUMBER CustomFieldValue rows", async () => {
        const numberField = await ctx.prisma.customField.findFirst({
          where: {
            organizationId: BASELINE_ORG_ID,
            fieldType: CustomFieldType.NUMBER,
          },
        });
        expect(numberField).not.toBeNull();

        const numberValues = await ctx.prisma.customFieldValue.findMany({
          where: {
            organizationId: BASELINE_ORG_ID,
            customFieldId: numberField!.id,
          },
          select: { numberValue: true },
        });

        expect(numberValues.length).toBeGreaterThanOrEqual(1);
        for (const v of numberValues) {
          expect(v.numberValue).not.toBeNull();
        }
      });

      it("populates enumValueId on the ENUM CustomFieldValue rows", async () => {
        const enumField = await ctx.prisma.customField.findFirst({
          where: {
            organizationId: BASELINE_ORG_ID,
            fieldType: CustomFieldType.ENUM,
          },
        });
        expect(enumField).not.toBeNull();

        const enumValues = await ctx.prisma.customFieldValue.findMany({
          where: {
            organizationId: BASELINE_ORG_ID,
            customFieldId: enumField!.id,
          },
          select: { enumValueId: true },
        });

        expect(enumValues.length).toBeGreaterThanOrEqual(1);
        for (const v of enumValues) {
          expect(v.enumValueId).not.toBeNull();
        }
      });

      it("populates multiEnumValueIds on the MULTI_ENUM CustomFieldValue rows", async () => {
        const multiEnumField = await ctx.prisma.customField.findFirst({
          where: {
            organizationId: BASELINE_ORG_ID,
            fieldType: CustomFieldType.MULTI_ENUM,
          },
        });
        expect(multiEnumField).not.toBeNull();

        const multiEnumValues = await ctx.prisma.customFieldValue.findMany({
          where: {
            organizationId: BASELINE_ORG_ID,
            customFieldId: multiEnumField!.id,
          },
          select: { multiEnumValueIds: true },
        });

        expect(multiEnumValues.length).toBeGreaterThanOrEqual(1);
        for (const v of multiEnumValues) {
          expect(Array.isArray(v.multiEnumValueIds)).toBe(true);
          expect(v.multiEnumValueIds.length).toBeGreaterThanOrEqual(1);
        }
      });

      it("populates dateValue on the DATE CustomFieldValue rows", async () => {
        const dateField = await ctx.prisma.customField.findFirst({
          where: {
            organizationId: BASELINE_ORG_ID,
            fieldType: CustomFieldType.DATE,
          },
        });
        expect(dateField).not.toBeNull();

        const dateValues = await ctx.prisma.customFieldValue.findMany({
          where: {
            organizationId: BASELINE_ORG_ID,
            customFieldId: dateField!.id,
          },
          select: { dateValue: true },
        });

        expect(dateValues.length).toBeGreaterThanOrEqual(1);
        for (const v of dateValues) {
          expect(v.dateValue).not.toBeNull();
          expect(v.dateValue).toBeInstanceOf(Date);
        }
      });

      it("populates peopleValueIds on the PEOPLE CustomFieldValue rows", async () => {
        const peopleField = await ctx.prisma.customField.findFirst({
          where: {
            organizationId: BASELINE_ORG_ID,
            fieldType: CustomFieldType.PEOPLE,
          },
        });
        expect(peopleField).not.toBeNull();

        const peopleValues = await ctx.prisma.customFieldValue.findMany({
          where: {
            organizationId: BASELINE_ORG_ID,
            customFieldId: peopleField!.id,
          },
          select: { peopleValueIds: true },
        });

        expect(peopleValues.length).toBeGreaterThanOrEqual(1);
        for (const v of peopleValues) {
          expect(Array.isArray(v.peopleValueIds)).toBe(true);
          expect(v.peopleValueIds.length).toBeGreaterThanOrEqual(1);
        }
      });
    });

    // -------------------------------------------------------------------------
    // TS-I.11: CommentThread sources (NATIVE, LIVEBLOCKS, GITHUB) with reactions/attachments (AC-015)
    // -------------------------------------------------------------------------

    describe("TS-I.11 — CommentThread sources with reactions and attachments (AC-015)", () => {
      it("seeds a CommentThread for each ThreadSource value", async () => {
        const threads = await ctx.prisma.commentThread.findMany({
          where: { organizationId: BASELINE_ORG_ID },
          select: { source: true },
        });

        const seededSources = new Set(threads.map((t) => t.source));
        for (const source of Object.values(ThreadSource)) {
          expect(
            seededSources.has(source),
            `Expected a CommentThread with source=${source}`
          ).toBe(true);
        }
      });

      it("seeds comments on every thread", async () => {
        const threads = await ctx.prisma.commentThread.findMany({
          where: { organizationId: BASELINE_ORG_ID },
          include: { comments: true },
        });

        for (const thread of threads) {
          expect(
            thread.comments.length,
            `Thread ${thread.id} (${thread.source}) should have at least one comment`
          ).toBeGreaterThanOrEqual(1);
        }
      });

      it("seeds at least one CommentReaction across all threads", async () => {
        const reactions = await ctx.prisma.commentReaction.findMany({
          where: { comment: { thread: { organizationId: BASELINE_ORG_ID } } },
        });
        expect(reactions.length).toBeGreaterThanOrEqual(1);
      });

      it("seeds at least one CommentAttachment across all threads", async () => {
        const attachments = await ctx.prisma.commentAttachment.findMany({
          where: { comment: { thread: { organizationId: BASELINE_ORG_ID } } },
        });
        expect(attachments.length).toBeGreaterThanOrEqual(1);
      });

      it("seeds the GITHUB thread with RESOLVED status", async () => {
        const githubThread = await ctx.prisma.commentThread.findFirst({
          where: {
            organizationId: BASELINE_ORG_ID,
            source: ThreadSource.GITHUB,
          },
          select: { status: true, resolvedById: true },
        });

        expect(githubThread).not.toBeNull();
        expect(githubThread?.status).toBe("RESOLVED");
        expect(githubThread?.resolvedById).toBe(BASELINE_USER_ID);
      });

      it("seeds the LIVEBLOCKS thread with a roomId", async () => {
        const liveblocksThread = await ctx.prisma.commentThread.findFirst({
          where: {
            organizationId: BASELINE_ORG_ID,
            source: ThreadSource.LIVEBLOCKS,
          },
          select: { roomId: true },
        });

        expect(liveblocksThread).not.toBeNull();
        expect(liveblocksThread?.roomId).not.toBeNull();
      });
    });

    // -------------------------------------------------------------------------
    // TS-I.12: ArtifactLink covers all LinkType values (AC-016)
    // -------------------------------------------------------------------------

    describe("TS-I.12 — ArtifactLink covers all LinkType values (AC-016)", () => {
      it("seeds at least one ArtifactLink per LinkType value", async () => {
        const links = await ctx.prisma.artifactLink.findMany({
          where: { organizationId: BASELINE_ORG_ID },
          select: { linkType: true },
        });

        const seededLinkTypes = new Set(links.map((l) => l.linkType));
        for (const linkType of Object.values(LinkType)) {
          expect(
            seededLinkTypes.has(linkType),
            `Expected an ArtifactLink with linkType=${linkType}`
          ).toBe(true);
        }
      });

      it("seeds ArtifactLink rows with valid sourceId and targetId references", async () => {
        const links = await ctx.prisma.artifactLink.findMany({
          where: { organizationId: BASELINE_ORG_ID },
          select: { sourceId: true, targetId: true, linkType: true },
        });

        for (const link of links) {
          const source = await ctx.prisma.artifact.findUnique({
            where: { id: link.sourceId },
          });
          const target = await ctx.prisma.artifact.findUnique({
            where: { id: link.targetId },
          });

          expect(
            source,
            `ArtifactLink (${link.linkType}) sourceId=${link.sourceId} must reference an existing Artifact`
          ).not.toBeNull();
          expect(
            target,
            `ArtifactLink (${link.linkType}) targetId=${link.targetId} must reference an existing Artifact`
          ).not.toBeNull();
        }
      });
    });

    // -------------------------------------------------------------------------
    // TS-I.13: GitHub entities (AC-017)
    // -------------------------------------------------------------------------

    describe("TS-I.13 — GitHub entities seeded (AC-017)", () => {
      it("seeds at least one GitHubInstallation for the organization", async () => {
        const count = await ctx.prisma.gitHubInstallation.count({
          where: { organizationId: BASELINE_ORG_ID },
        });
        expect(count).toBeGreaterThanOrEqual(1);
      });

      it("seeds at least one GitHubInstallationRepository linked to the installation", async () => {
        const installations = await ctx.prisma.gitHubInstallation.findMany({
          where: { organizationId: BASELINE_ORG_ID },
          include: { repositories: true },
        });

        const allRepos = installations.flatMap((i) => i.repositories);
        expect(allRepos.length).toBeGreaterThanOrEqual(1);
      });

      it("seeds a GitHubUserConnection for the seed user", async () => {
        const connection = await ctx.prisma.gitHubUserConnection.findUnique({
          where: {
            organizationId_userId: {
              organizationId: BASELINE_ORG_ID,
              userId: BASELINE_USER_ID,
            },
          },
        });

        expect(connection).not.toBeNull();
        expect(connection?.login).toBeDefined();
      });

      it("seeds at least one PullRequestDetail linked to a BRANCH artifact", async () => {
        const count = await ctx.prisma.pullRequestDetail.count({
          where: { branchArtifact: { organizationId: BASELINE_ORG_ID } },
        });
        expect(count).toBeGreaterThanOrEqual(1);
      });

      it("seeds at least one GitHubPRReview on the seeded pull request", async () => {
        const count = await ctx.prisma.gitHubPRReview.count({
          where: {
            pullRequestDetail: {
              branchArtifact: { organizationId: BASELINE_ORG_ID },
            },
          },
        });
        expect(count).toBeGreaterThanOrEqual(1);
      });
    });

    // TS-I.14 (Linear entities) was removed alongside the workstream concept
    // in PLN-787 — seedLinearEntities was deleted because LinearIssue depended
    // on workstreamId and LinearSubtask's coverage matrix was workstream-keyed.
  }
);
