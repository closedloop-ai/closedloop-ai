import type {
  SubmitJudgeRatingResponse,
  UserJudgeRating,
  UserJudgeRatingsResponse,
} from "@repo/api/src/types/judges-analytics";
import { withDb } from "@repo/database";
import type { DocumentRatingWrite } from "@/app/documents/document-rating-receipt";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { normalizeJudgeName } from "@/lib/judge-name-utils";
import {
  type RecordWriteInTransaction,
  writeInShape,
} from "@/lib/record-write-in-transaction";

/**
 * Submit or update a human rating for a specific judge score.
 * Upserts on (judgeScoreId, userId, organizationId). `recordWrite` runs on the
 * rating's own transaction once it is stored (ISS-12552).
 */
export async function submitJudgeRating(
  organizationId: string,
  userId: string,
  documentId: string,
  judgeScoreId: string,
  rating: number,
  recordWrite?: RecordWriteInTransaction<DocumentRatingWrite>
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

  const isUpdate = await writeJudgeHumanScore(
    {
      evaluationId: judgeScore.evaluationId,
      judgeScoreId,
      organizationId,
      rating,
      userId,
    },
    recordWrite
  );

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
 * Writes the one `(judgeScoreId, userId, organizationId)` rating row and
 * returns true when the row already existed. Recorded (ISS-12552), the write
 * and `recordWrite` share one transaction; unrecorded, it is main's two
 * autocommit statements (flag-off parity).
 */
function writeJudgeHumanScore(
  input: WriteJudgeHumanScoreInput,
  recordWrite?: RecordWriteInTransaction<DocumentRatingWrite>
): Promise<boolean> {
  return writeInShape(recordWrite, {
    unrecorded: () => writeJudgeHumanScoreUnrecorded(input),
    recorded: (record) => writeJudgeHumanScoreRecorded(input, record),
  });
}

function judgeHumanScoreKey(input: WriteJudgeHumanScoreInput) {
  return {
    judgeScoreId_userId_organizationId: {
      judgeScoreId: input.judgeScoreId,
      userId: input.userId,
      organizationId: input.organizationId,
    },
  };
}

/**
 * Main's shape: a lost insert race resolves into an update. The two writes
 * MUST NOT share an interactive transaction: PostgreSQL aborts the whole
 * transaction on the unique violation, so an update issued after the failed
 * create is rejected with `25P02` rather than applied. Each `withDb` call here
 * is its own implicit transaction, which holds only while no caller wraps it
 * in `withDb.tx`.
 */
async function writeJudgeHumanScoreUnrecorded(
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
        where: judgeHumanScoreKey(input),
        data: {
          score: input.rating,
        },
        select: { id: true },
      })
    );
    return true;
  }
}

/**
 * The insert is `ON CONFLICT DO NOTHING` (`skipDuplicates`), so a lost insert
 * race never raises a unique violation. A caught violation would abort the
 * whole transaction and PostgreSQL would refuse the update after it with
 * `25P02` (ISS-6320, proven in `judge-ratings-unique-race.test.ts`).
 */
function writeJudgeHumanScoreRecorded(
  input: WriteJudgeHumanScoreInput,
  recordWrite: RecordWriteInTransaction<DocumentRatingWrite>
): Promise<boolean> {
  const key = judgeHumanScoreKey(input);
  return withDb.tx(async (tx) => {
    const inserted = await tx.judgeHumanScore.createMany({
      data: [
        {
          evaluationId: input.evaluationId,
          judgeScoreId: input.judgeScoreId,
          userId: input.userId,
          organizationId: input.organizationId,
          score: input.rating,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count > 0) {
      await recordWrite(tx, { changed: true });
      return false;
    }

    const previous = await tx.judgeHumanScore.findUnique({
      where: key,
      select: { score: true },
    });
    await tx.judgeHumanScore.update({
      where: key,
      data: { score: input.rating },
      select: { id: true },
    });
    await recordWrite(tx, { changed: previous?.score !== input.rating });
    return true;
  });
}
