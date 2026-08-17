import type {
  SubmitJudgeRatingResponse,
  UserJudgeRating,
  UserJudgeRatingsResponse,
} from "@repo/api/src/types/judges-analytics";
import { withDb } from "@repo/database";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { normalizeJudgeName } from "@/lib/judge-name-utils";

/**
 * Submit or update a human rating for a specific judge score.
 * Upserts on (judgeScoreId, userId, organizationId).
 */
export async function submitJudgeRating(
  organizationId: string,
  userId: string,
  documentId: string,
  judgeScoreId: string,
  rating: number
): Promise<SubmitJudgeRatingResponse | null> {
  const judgeScore = await withDb((db) =>
    db.judgeScore.findFirst({
      where: {
        id: judgeScoreId,
        evaluation: {
          artifactId: documentId,
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
    })
  );

  if (!judgeScore) {
    return null;
  }

  const isUpdate = await writeJudgeHumanScore({
    evaluationId: judgeScore.evaluationId,
    judgeScoreId,
    organizationId,
    rating,
    userId,
  });

  const promptName = judgeScore.prompt
    ? normalizeJudgeName(judgeScore.prompt.name)
    : null;
  const reportType = judgeScore.evaluation.reportType;
  const metricName = normalizeJudgeName(judgeScore.metricName);

  return { rating, isUpdate, promptName, reportType, metricName };
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
          artifactId: documentId,
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

type WriteJudgeHumanScoreInput = {
  evaluationId: string;
  judgeScoreId: string;
  organizationId: string;
  rating: number;
  userId: string;
};

/**
 * Writes the one `(judgeScoreId, userId, organizationId)` rating row, resolving
 * a lost insert race into an update. Returns true when the row already existed.
 *
 * The two writes MUST NOT share an interactive transaction: PostgreSQL aborts
 * the whole transaction on the unique violation, so an update issued after the
 * failed create is rejected with `25P02` rather than applied. Each `withDb` call
 * here is its own implicit transaction, which lets the create roll back on its
 * own before the update starts (root AGENTS.md, Prisma-transaction rule) — but
 * only while no caller wraps `submitJudgeRating` in `withDb.tx`, since `withDb`
 * joins an ambient transaction when one is in scope. Keeping this path off
 * `withDb.tx` is therefore the caller's obligation, not a guarantee this module
 * can enforce.
 */
async function writeJudgeHumanScore(
  input: WriteJudgeHumanScoreInput
): Promise<boolean> {
  try {
    await withDb((db) =>
      db.judgeHumanScore.create({
        data: {
          evaluationId: input.evaluationId,
          judgeScoreId: input.judgeScoreId,
          userId: input.userId,
          organizationId: input.organizationId,
          score: input.rating,
        },
        select: { id: true },
      })
    );
    return false;
  } catch (error) {
    if (getPrismaErrorCode(error) !== "P2002") {
      throw error;
    }

    await withDb((db) =>
      db.judgeHumanScore.update({
        where: {
          judgeScoreId_userId_organizationId: {
            judgeScoreId: input.judgeScoreId,
            userId: input.userId,
            organizationId: input.organizationId,
          },
        },
        data: {
          score: input.rating,
        },
        select: { id: true },
      })
    );
    return true;
  }
}
