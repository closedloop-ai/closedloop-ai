/**
 * Real-Postgres proof that `submitJudgeRating` survives its own create→update
 * fallback (ISS-6320, wongk review of the judge-ratings service).
 *
 * The mocked unit suite cannot see this: it resolves the P2002 rejection and
 * the follow-up update against the same plain object, so a statement sequence
 * PostgreSQL rejects outright reads as green. Only a real connection can prove
 * the difference, so this suite covers both halves:
 *
 *   1. The BOUNDARY itself — inside one interactive transaction, a caught
 *      unique violation aborts the transaction and every later statement on it
 *      is refused with "current transaction is aborted". That is exactly the
 *      structure the service used before this change, so this case is the
 *      counterfactual: it fails here, against a real database, by design.
 *   2. The SERVICE — a second `submitJudgeRating` for the same
 *      (judgeScoreId, userId, organizationId) resolves to an update, returns
 *      `isUpdate: true`, and actually persists the new score.
 *
 * Self-skips when DATABASE_URL is unset (matches the other integration suites).
 * Everything is namespaced under a freshly-created org and removed in afterAll
 * (org delete cascades to artifacts, evaluations, and both score tables).
 */
import {
  EvalStatus,
  EvaluationReportType,
} from "@repo/api/src/types/evaluation";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getUserJudgeRatings,
  submitJudgeRating,
} from "@/app/documents/[id]/judge-ratings/service";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { createTestOrganization, createTestUser } from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

/**
 * PostgreSQL's refusal of any statement issued on an already-aborted
 * transaction (SQLSTATE 25P02). Prisma surfaces it as a bare
 * `DriverAdapterError` carrying this text, with no `code` and no `meta`, so the
 * message is the only contract available to assert on.
 */
const TRANSACTION_ABORTED_PATTERN = /current transaction is aborted/i;
const PRISMA_UNIQUE_VIOLATION = "P2002";
const FIRST_RATING = 0.4;
const SECOND_RATING = 0.9;

describe.skipIf(!hasDatabase)("judge ratings — unique-race write path", () => {
  let organizationId: string;
  let userId: string;
  let artifactId: string;
  let evaluationId: string;
  let judgeScoreId: string;

  beforeAll(async () => {
    organizationId = await createTestOrganization();
    const user = await createTestUser(organizationId);
    userId = user.id;

    await withDb(async (db) => {
      const artifact = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.DOCUMENT,
          name: "Judge ratings race fixture",
          slug: `judge-ratings-race-${organizationId.slice(0, 8)}`,
          status: "active",
        },
        select: { id: true },
      });
      artifactId = artifact.id;

      const evaluation = await db.artifactEvaluation.create({
        data: {
          organizationId,
          artifactId,
          reportType: EvaluationReportType.Plan,
          reportId: `report-${organizationId.slice(0, 8)}`,
        },
        select: { id: true },
      });
      evaluationId = evaluation.id;

      const judgeScore = await db.judgeScore.create({
        data: {
          evaluationId,
          caseId: "case-1",
          metricName: "clarity_score",
          threshold: 0.5,
          score: 0.7,
          justification: "fixture",
          finalStatus: EvalStatus.Passed,
        },
        select: { id: true },
      });
      judgeScoreId = judgeScore.id;
    });
  });

  afterEach(async () => {
    if (!(hasDatabase && organizationId)) {
      return;
    }
    await withDb((db) =>
      db.judgeHumanScore.deleteMany({ where: { organizationId } })
    );
  });

  afterAll(async () => {
    if (!(hasDatabase && organizationId)) {
      return;
    }
    // `users` and `artifacts` hold RESTRICT FKs to `organizations`, so the
    // fixture has to come down in dependency order rather than by one cascade.
    await withDb(async (db) => {
      await db.judgeHumanScore.deleteMany({ where: { organizationId } });
      await db.artifact.deleteMany({ where: { organizationId } });
      await db.user.deleteMany({ where: { organizationId } });
      await db.organization.delete({ where: { id: organizationId } });
    });
  });

  it("refuses an update issued after a caught unique violation in the SAME transaction", async () => {
    await withDb((db) =>
      db.judgeHumanScore.create({
        data: {
          evaluationId,
          judgeScoreId,
          userId,
          organizationId,
          score: FIRST_RATING,
        },
        select: { id: true },
      })
    );

    let createErrorCode: string | undefined;

    await expect(
      withDb.tx(async (tx) => {
        try {
          await tx.judgeHumanScore.create({
            data: {
              evaluationId,
              judgeScoreId,
              userId,
              organizationId,
              score: SECOND_RATING,
            },
            select: { id: true },
          });
        } catch (error) {
          createErrorCode = getPrismaErrorCode(error);
        }

        await tx.judgeHumanScore.update({
          where: {
            judgeScoreId_userId_organizationId: {
              judgeScoreId,
              userId,
              organizationId,
            },
          },
          data: { score: SECOND_RATING },
          select: { id: true },
        });
      })
    ).rejects.toThrow(TRANSACTION_ABORTED_PATTERN);

    expect(createErrorCode).toBe(PRISMA_UNIQUE_VIOLATION);

    const persisted = await withDb((db) =>
      db.judgeHumanScore.findUnique({
        where: {
          judgeScoreId_userId_organizationId: {
            judgeScoreId,
            userId,
            organizationId,
          },
        },
        select: { score: true },
      })
    );
    expect(persisted?.score).toBe(FIRST_RATING);
  });

  it("creates then updates the same rating row across two submitJudgeRating calls", async () => {
    const created = await submitJudgeRating(
      organizationId,
      userId,
      artifactId,
      judgeScoreId,
      FIRST_RATING
    );

    expect(created).toEqual({
      rating: FIRST_RATING,
      isUpdate: false,
      promptName: null,
      reportType: EvaluationReportType.Plan,
      metricName: "clarity",
    });

    const updated = await submitJudgeRating(
      organizationId,
      userId,
      artifactId,
      judgeScoreId,
      SECOND_RATING
    );

    expect(updated).toEqual({
      rating: SECOND_RATING,
      isUpdate: true,
      promptName: null,
      reportType: EvaluationReportType.Plan,
      metricName: "clarity",
    });

    const readBack = await getUserJudgeRatings(
      organizationId,
      userId,
      artifactId
    );
    expect(readBack.ratings).toEqual([{ judgeScoreId, rating: SECOND_RATING }]);

    const rowCount = await withDb((db) =>
      db.judgeHumanScore.count({ where: { organizationId } })
    );
    expect(rowCount).toBe(1);
  });
});
