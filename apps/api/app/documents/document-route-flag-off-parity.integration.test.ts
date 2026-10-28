import { randomUUID } from "node:crypto";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import {
  EvalStatus,
  EvaluationReportType,
} from "@repo/api/src/types/evaluation";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentCustomFieldTracker,
  readStoredDocument,
} from "@/__tests__/support/documents/document-parity.test-fixtures";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  receiptRouteParams,
  turnAttributionFlagOff,
  turnAttributionFlagOn,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { receiptRouteState } from "@/__tests__/support/lib/operation-receipt-route.test-mocks";
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

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
vi.mock("@/app/documents/attachment-upload-feature", () => ({
  isMcpAttachmentUploadEnabled: () => Promise.resolve(true),
}));
vi.mock("@repo/aws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/aws")>()),
  getSignedUploadUrl: (key: string) =>
    Promise.resolve(`https://upload.test/${key}`),
  putAttachmentObject: () => Promise.resolve(),
  deleteArtifact: () => Promise.resolve(),
}));
vi.mock("@repo/aws/keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/aws/keys")>();
  return {
    ...actual,
    keys: () => ({
      ...actual.keys(),
      FILE_ATTACHMENTS_BUCKET: "flag-off-parity-bucket",
    }),
  };
});

import { customFieldValuesService } from "@/app/custom-fields/values-service";
import { POST as createInlineImage } from "@/app/documents/[id]/attachments/images/route";
import { POST as requestAttachmentUpload } from "@/app/documents/[id]/attachments/route";
import { POST as createContextAttachment } from "@/app/documents/[id]/context-attachments/route";
import { POST as rateJudgeScore } from "@/app/documents/[id]/judge-ratings/route";
import { PUT as rateDocument } from "@/app/documents/[id]/rating/route";
import { PUT as updateDocument } from "@/app/documents/[id]/route";
import { POST as createVersion } from "@/app/documents/[id]/versions/route";
import { documentVersionService } from "@/app/documents/document-version-service";
import { documentEvaluationService } from "@/app/documents/evaluation-service";

const harness = createReceiptRouteHarness();
const customFields = createDocumentCustomFieldTracker();
/** A 1x1 transparent PNG. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

type World = Awaited<ReturnType<typeof harness.seedWorld>>;

/**
 * ISS-12552: flag-off behavior equals main for document route writes. With
 * `attribution-evidence-policy` off, or for a session caller, each write runs
 * exactly as it does on main, with no receipt shape.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 document writes match main with attribution evidence off",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await customFields.cleanup();
      await harness.cleanup();
    });

    it("PUT half-applies a refused custom field like main, for an API-key caller", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();

      const stored = await putWithRefusedSecondField(world);

      expect(stored).toEqual({ status: 400, title: "Renamed", values: 1 });
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PUT half-applies a refused custom field like main, for a session caller", async () => {
      const world = await harness.seedWorld();
      const apiKeyContext = receiptRouteState.context as AuthContext;
      receiptRouteState.context = createTestAuthContext({
        user: apiKeyContext.user,
        authMethod: "session",
      });

      expect(await putWithRefusedSecondField(world)).toEqual({
        status: 400,
        title: "Renamed",
        values: 1,
      });
    });

    it("a version save is handed no record, so it skips the receipt's previous-version read", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Versioned");
      turnAttributionFlagOff();
      const createNewVersion = vi.spyOn(
        documentVersionService,
        "createNewVersion"
      );

      const response = await createVersion(
        apiKeyRouteRequest(
          "POST",
          `/documents/${documentId}/versions?reset-room=false`,
          { content: "Second version" }
        ),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(200);
      expect(createNewVersion).toHaveBeenCalledTimes(1);
      expect(createNewVersion.mock.calls[0]?.[4]).toBe(undefined);
    });

    it("a document rating is handed no record, so it skips the previous-rating read", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Rated");
      turnAttributionFlagOff();
      const upsertRating = vi.spyOn(documentEvaluationService, "upsertRating");

      const response = await rateDocument(
        apiKeyRouteRequest("PUT", `/documents/${documentId}/rating`, {
          score: 4,
        }),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(200);
      expect(upsertRating).toHaveBeenCalledTimes(1);
      const [call] = upsertRating.mock.calls;
      // The route passes the record slot on every call, so its absence here
      // is the flag-off answer and not a shorter argument list.
      expect(call).toHaveLength(6);
      expect(call?.[5]).toBeUndefined();
      expect(
        await withDb((db) =>
          db.artifactRating.findMany({
            where: { artifactId: documentId },
            select: { score: true },
          })
        )
      ).toEqual([{ score: 4 }]);
      expect(await countReceipts(world.organizationId)).toBe(0);

      // Control: with the flag on, the same slot carries the receipt write.
      turnAttributionFlagOn();
      await rateDocument(
        apiKeyRouteRequest("PUT", `/documents/${documentId}/rating`, {
          score: 2,
        }),
        receiptRouteParams({ id: documentId })
      );
      expect(upsertRating.mock.calls[1]?.[5]).toBeTypeOf("function");
    });

    it("a judge rating and its re-rate open no transaction, as on main", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Judged");
      const judgeScoreId = await seedJudgeScore(world, documentId);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const statuses = [
        (await postJudgeRating(documentId, judgeScoreId, 0.4)).status,
        (await postJudgeRating(documentId, judgeScoreId, 0.9)).status,
      ];

      expect(statuses).toEqual([200, 200]);
      expect(transactions.calls).toBe(0);
      expect(await readJudgeRating(judgeScoreId)).toBe(0.9);
    });

    it("an attachment upload opens only main's rate-limit transaction", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Attached");
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await requestAttachmentUpload(
        apiKeyRouteRequest("POST", `/documents/${documentId}/attachments`, {
          filename: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 128,
        }),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(200);
      // `consumeAttachmentUploadLimit` opens the only one; the row insert is
      // an autocommit statement.
      expect(transactions.opened).toBe(1);
      expect(await countAttachments(documentId)).toBe(1);
    });

    it("an inline image opens only main's rate-limit transaction", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Illustrated");
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await createInlineImage(
        apiKeyRouteRequest(
          "POST",
          `/documents/${documentId}/attachments/images`,
          {
            filename: "pixel.png",
            mimeType: "image/png",
            dataBase64: PNG_BASE64,
          }
        ),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(200);
      expect(transactions.opened).toBe(1);
      expect(await countAttachments(documentId)).toBe(1);
    });

    it("a direct context attachment opens no transaction", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await createContextAttachment(
        apiKeyRouteRequest(
          "POST",
          `/documents/${documentId}/context-attachments`,
          { filename: "notes.txt", mimeType: "text/plain", sizeBytes: 128 }
        ),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(200);
      expect(transactions.calls).toBe(0);
      expect(await countAttachments(documentId)).toBe(1);
    });
  }
);

/**
 * PUT a rename with two custom fields where the second is refused only at
 * write time (a value that turned invalid after the preflight), and read back
 * what stayed stored.
 */
async function putWithRefusedSecondField(world: World) {
  const documentId = await harness.seedDocument(world, "Original");
  const textFieldId = await customFields.seed(
    world.organizationId,
    CustomFieldType.Text
  );
  const enumFieldId = await customFields.seed(
    world.organizationId,
    CustomFieldType.Enum
  );
  vi.spyOn(
    customFieldValuesService,
    "validateValueForEntity"
  ).mockResolvedValue(undefined);

  const response = await updateDocument(
    apiKeyRouteRequest("PUT", `/documents/${documentId}`, {
      title: "Renamed",
      customFields: {
        [textFieldId]: "applied first",
        [enumFieldId]: randomUUID(),
      },
    }),
    receiptRouteParams({ id: documentId })
  );

  const { title, values } = await readStoredDocument(documentId);
  return { status: response.status, title, values };
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

async function readJudgeRating(judgeScoreId: string): Promise<number | null> {
  const row = await withDb((db) =>
    db.judgeHumanScore.findFirst({
      where: { judgeScoreId },
      select: { score: true },
    })
  );
  return row?.score ?? null;
}

function seedJudgeScore(world: World, documentId: string): Promise<string> {
  return withDb.tx(async (tx) => {
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
        justification: "ISS-12552 parity fixture",
        finalStatus: EvalStatus.Passed,
      },
      select: { id: true },
    });
    return judgeScore.id;
  });
}

function countAttachments(documentId: string): Promise<number> {
  return withDb((db) =>
    db.fileAttachment.count({ where: { artifactId: documentId } })
  );
}
