import type {
  SubmitJudgeRatingResponse,
  UserJudgeRating,
  UserJudgeRatingsResponse,
} from "@repo/api/src/types/judges-analytics";
import { withDb } from "@repo/database";
import { normalizeJudgeName } from "@/lib/judge-name-utils";

/**
 * Submit or update a human rating for a specific judge score.
 * Upserts on (judgeScoreId, userId, organizationId).
 */
export function submitJudgeRating(
  organizationId: string,
  userId: string,
  artifactId: string,
  judgeScoreId: string,
  rating: number
): Promise<SubmitJudgeRatingResponse | null> {
  return withDb.tx(async (tx) => {
    const judgeScore = await tx.judgeScore.findFirst({
      where: {
        id: judgeScoreId,
        evaluation: {
          artifactId,
          artifact: { organizationId },
        },
      },
      select: {
        id: true,
        evaluationId: true,
        evaluation: { select: { reportType: true } },
        prompt: { select: { name: true } },
      },
    });

    if (!judgeScore) {
      return null;
    }

    const existing = await tx.judgeHumanScore.findUnique({
      where: {
        judgeScoreId_userId_organizationId: {
          judgeScoreId,
          userId,
          organizationId,
        },
      },
      select: { id: true },
    });

    const isUpdate = existing !== null;

    await tx.judgeHumanScore.upsert({
      where: {
        judgeScoreId_userId_organizationId: {
          judgeScoreId,
          userId,
          organizationId,
        },
      },
      create: {
        evaluationId: judgeScore.evaluationId,
        judgeScoreId,
        userId,
        organizationId,
        score: rating,
      },
      update: {
        score: rating,
      },
    });

    const promptName = judgeScore.prompt
      ? normalizeJudgeName(judgeScore.prompt.name)
      : null;
    const reportType = judgeScore.evaluation.reportType;

    return { rating, isUpdate, promptName, reportType };
  });
}

/**
 * Get all of the current user's judge ratings for a specific artifact.
 * Returns ratings keyed by judgeScoreId for pre-population in the UI.
 */
export async function getUserJudgeRatings(
  organizationId: string,
  userId: string,
  artifactId: string
): Promise<UserJudgeRatingsResponse> {
  const humanScores = await withDb((db) =>
    db.judgeHumanScore.findMany({
      where: {
        organizationId,
        userId,
        evaluation: {
          artifactId,
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
