import type {
  SubmitJudgeRatingResponse,
  UserJudgeRating,
  UserJudgeRatingsResponse,
} from "@repo/api/src/types/judges-analytics";
import { EntityType, withDb } from "@repo/database";
import { normalizeJudgeName } from "@/lib/judge-name-utils";

/**
 * Submit or update a human rating for a specific judge score.
 * Upserts on (judgeScoreId, userId, organizationId).
 */
export function submitJudgeRating(
  organizationId: string,
  userId: string,
  documentId: string,
  judgeScoreId: string,
  rating: number
): Promise<SubmitJudgeRatingResponse | null> {
  return withDb.tx(async (tx) => {
    const judgeScore = await tx.judgeScore.findFirst({
      where: {
        id: judgeScoreId,
        evaluation: {
          entityId: documentId,
          entityType: EntityType.DOCUMENT,
          organizationId,
        },
      },
      select: {
        id: true,
        evaluationId: true,
        metricName: true,
        evaluation: { select: { reportType: true } },
        prompt: { select: { name: true } },
      },
    });

    if (!judgeScore) {
      return null;
    }

    const where = {
      judgeScoreId_userId_organizationId: {
        judgeScoreId,
        userId,
        organizationId,
      },
    };

    let isUpdate = false;

    try {
      await tx.judgeHumanScore.create({
        data: {
          evaluationId: judgeScore.evaluationId,
          judgeScoreId,
          userId,
          organizationId,
          score: rating,
        },
      });
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error) ||
        error.code !== "P2002"
      ) {
        throw error;
      }

      isUpdate = true;
      await tx.judgeHumanScore.update({
        where,
        data: {
          score: rating,
        },
      });
    }

    const promptName = judgeScore.prompt
      ? normalizeJudgeName(judgeScore.prompt.name)
      : null;
    const reportType = judgeScore.evaluation.reportType;
    const metricName = normalizeJudgeName(judgeScore.metricName);

    return { rating, isUpdate, promptName, reportType, metricName };
  });
}

/**
 * Get all of the current user's judge ratings for a specific artifact.
 * Returns ratings keyed by judgeScoreId for pre-population in the UI.
 */
export async function getUserJudgeRatings(
  organizationId: string,
  userId: string,
  documentId: string
): Promise<UserJudgeRatingsResponse> {
  const humanScores = await withDb((db) =>
    db.judgeHumanScore.findMany({
      where: {
        organizationId,
        userId,
        evaluation: {
          entityId: documentId,
          entityType: EntityType.DOCUMENT,
        },
      },
      select: {
        judgeScoreId: true,
        score: true,
      },
    })
  );

  const ratings: UserJudgeRating[] = humanScores.map((hs) => ({
    judgeScoreId: hs.judgeScoreId,
    rating: hs.score,
  }));

  return { ratings };
}
