import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import {
  EvalStatus,
  EvaluationReportType,
} from "@repo/api/src/types/evaluation";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  readReceipts,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";

vi.mock("@/lib/attribution-evidence-policy-feature", async (importOriginal) =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteFlagMock(await importOriginal())
);
vi.mock("@/lib/auth/with-any-auth", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteAuthMock()
);
vi.mock("@vercel/functions", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteWaitUntilMock()
);
vi.mock(
  "@/lib/operation-receipts/operation-receipt-writer",
  async (importOriginal) =>
    (
      await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
    ).failingReceiptWriterMock(await importOriginal())
);

import { POST as rateJudgeScore } from "@/app/documents/[id]/judge-ratings/route";
import { PUT as rateDocument } from "@/app/documents/[id]/rating/route";

const harness = createReceiptRouteHarness();
const RATING_ROUTE = "/documents/[id]/rating";
const JUDGE_RATINGS_ROUTE = "/documents/[id]/judge-ratings";
const FIRST_JUDGE_RATING = 0.4;
const SECOND_JUDGE_RATING = 0.9;

/**
 * ISS-12552: an API-key rating of a document, or of one of its
 * judge scores, records a receipt in the rating's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 document rating receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("PUT rating rolls the rating back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Rated");
      failReceiptInserts();

      const response = await putRating(documentId, 4);

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countDocumentRatings(documentId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PUT rating records a rate naming the document, and a repeat as a no-op", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Rated");

      const statuses = [
        (await putRating(documentId, 4)).status,
        (await putRating(documentId, 4)).status,
      ];

      expect(statuses).toEqual([200, 200]);
      expect(await readReceipts(world.organizationId)).toEqual(
        [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
          (outcome) => rateReceipt(documentId, outcome, RATING_ROUTE)
        )
      );
    });

    it("POST judge-ratings rolls a first rating back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Judged");
      const judgeScoreId = await seedJudgeScore(world, documentId);
      failReceiptInserts();

      const response = await postJudgeRating(
        documentId,
        judgeScoreId,
        FIRST_JUDGE_RATING
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readJudgeRating(judgeScoreId)).toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST judge-ratings keeps the earlier score when a re-rate's receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Judged");
      const judgeScoreId = await seedJudgeScore(world, documentId);
      expect(
        (await postJudgeRating(documentId, judgeScoreId, FIRST_JUDGE_RATING))
          .status
      ).toBe(200);
      failReceiptInserts();

      const response = await postJudgeRating(
        documentId,
        judgeScoreId,
        SECOND_JUDGE_RATING
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await readJudgeRating(judgeScoreId)).toBe(FIRST_JUDGE_RATING);
      expect(await countReceipts(world.organizationId)).toBe(1);
    });

    it("POST judge-ratings records a rate per change and a same-score repeat as a no-op", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Judged");
      const judgeScoreId = await seedJudgeScore(world, documentId);

      const statuses: number[] = [];
      for (const rating of [
        FIRST_JUDGE_RATING,
        SECOND_JUDGE_RATING,
        SECOND_JUDGE_RATING,
      ]) {
        statuses.push(
          (await postJudgeRating(documentId, judgeScoreId, rating)).status
        );
      }

      expect(statuses).toEqual([200, 200, 200]);
      expect(await readJudgeRating(judgeScoreId)).toBe(SECOND_JUDGE_RATING);
      expect(await readReceipts(world.organizationId)).toEqual(
        [
          OperationReceiptOutcome.Committed,
          OperationReceiptOutcome.Committed,
          OperationReceiptOutcome.NoOp,
        ].map((outcome) =>
          rateReceipt(documentId, outcome, JUDGE_RATINGS_ROUTE)
        )
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Rated");
      turnAttributionFlagOff();

      const response = await putRating(documentId, 3);

      expect(response.status).toBe(200);
      expect(await countDocumentRatings(documentId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function putRating(documentId: string, score: number) {
  return rateDocument(
    apiKeyRouteRequest("PUT", `/documents/${documentId}/rating`, { score }),
    receiptRouteParams({ id: documentId })
  );
}

function postJudgeRating(
  documentId: string,
  judgeScoreId: string,
  rating: number
) {
  return rateJudgeScore(
    apiKeyRouteRequest("POST", `/documents/${documentId}/judge-ratings`, {
      judgeScoreId,
      rating,
    }),
    receiptRouteParams({ id: documentId })
  );
}

function rateReceipt(
  documentId: string,
  outcome: OperationReceiptOutcome,
  route: string
) {
  return {
    operationKind: OperationKind.Rate,
    outcome,
    source: OperationSource.Api,
    targetArtifactId: documentId,
    createdArtifactId: null,
    changedFields: [],
    route,
  };
}

function countDocumentRatings(documentId: string): Promise<number> {
  return withDb((db) =>
    db.artifactRating.count({ where: { artifactId: documentId } })
  );
}

async function readJudgeRating(judgeScoreId: string): Promise<number | null> {
  const row = await withDb((db) =>
    db.judgeHumanScore.findFirst({
      where: { judgeScoreId },
      select: { score: true },
    })
  );
  return row?.score ?? null;
}

async function seedJudgeScore(
  world: { organizationId: string },
  documentId: string
): Promise<string> {
  return await withDb.tx(async (tx) => {
    const evaluation = await tx.artifactEvaluation.create({
      data: {
        organizationId: world.organizationId,
        artifactId: documentId,
        reportType: EvaluationReportType.Plan,
        reportId: `report-${documentId}`,
      },
      select: { id: true },
    });
    const judgeScore = await tx.judgeScore.create({
      data: {
        evaluationId: evaluation.id,
        caseId: "case-1",
        metricName: "clarity_score",
        threshold: 0.5,
        score: 0.7,
        justification: "ISS-12552 fixture",
        finalStatus: EvalStatus.Passed,
      },
      select: { id: true },
    });
    return judgeScore.id;
  });
}
