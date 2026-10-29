import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
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

const { BUCKET } = vi.hoisted(() => ({
  BUCKET: "comment-attachment-receipts-test-bucket",
}));

vi.mock("@repo/aws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/aws")>()),
  getSignedUploadUrl: (key: string) =>
    Promise.resolve(`https://upload.test/${key}`),
  headAttachmentObject: () => Promise.resolve({ byteSize: 12 }),
}));
vi.mock("@repo/aws/keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/aws/keys")>();
  return {
    ...actual,
    keys: () => ({ ...actual.keys(), FILE_ATTACHMENTS_BUCKET: BUCKET }),
  };
});
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
vi.mock("@/lib/mention-notifications", () => ({
  dispatchMentionNotifications: vi.fn(),
}));
vi.mock("@/app/search/search-index-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/search/search-index-service")>();
  return {
    ...actual,
    searchIndexService: {
      ...actual.searchIndexService,
      indexAfterCommit: vi.fn(),
      removeAfterCommit: vi.fn(),
    },
  };
});

import {
  DOCUMENT_THREAD_ANCHOR,
  seedReceiptThread,
  switchDocumentComments,
} from "@/__tests__/support/comments/comment-receipt-route.test-fixtures";
import { POST as startUpload } from "@/app/comments/[commentId]/attachments/route";
import { POST as completeUpload } from "@/app/comments/attachments/[attachmentId]/complete/route";

const harness = createReceiptRouteHarness();
const UPLOAD = { name: "notes.txt", mimeType: "text/plain", size: 12 };
const COMPLETE_ROUTE = "/comments/attachments/[attachmentId]/complete";

/**
 * ISS-12552: an API-key comment attachment records an Attach
 * receipt in the attachment's own transaction; S3 is reached outside it.
 * These routes have no catch of their own, so a failed receipt rejects the
 * handler, which `withAnyAuth` answers with 500 in production.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 comment attachment receipts",
  () => {
    afterEach(() => harness.cleanup());

    async function seedDocumentComment() {
      const world = await harness.seedWorld();
      await switchDocumentComments(world.organizationId);
      const documentId = await harness.seedDocument(world, "Attached");
      const { rootCommentId } = await seedReceiptThread(
        world,
        documentId,
        DOCUMENT_THREAD_ANCHOR
      );
      return { world, documentId, commentId: rootCommentId };
    }

    it("POST attachments stores no upload when its receipt cannot be stored", async () => {
      const { world, commentId } = await seedDocumentComment();
      failReceiptInserts();

      await expect(
        startUpload(
          apiKeyRouteRequest(
            "POST",
            `/comments/${commentId}/attachments`,
            UPLOAD
          ),
          receiptRouteParams({ commentId })
        )
      ).rejects.toThrow();

      expect(forcedReceiptFailures()).toBe(1);
      expect(await countAttachments(commentId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST complete leaves the upload pending when its receipt cannot be stored", async () => {
      const { world, commentId } = await seedDocumentComment();
      const attachmentId = await seedPendingUpload(commentId);
      failReceiptInserts();

      await expect(
        completeUpload(
          apiKeyRouteRequest(
            "POST",
            `/comments/attachments/${attachmentId}/complete`
          ),
          receiptRouteParams({ attachmentId })
        )
      ).rejects.toThrow();

      expect(forcedReceiptFailures()).toBe(1);
      expect(await uploadedAt(attachmentId)).toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records an attach on the document for each step, and a repeated completion as a no-op", async () => {
      const { world, documentId, commentId } = await seedDocumentComment();

      const started = await startUpload(
        apiKeyRouteRequest(
          "POST",
          `/comments/${commentId}/attachments`,
          UPLOAD
        ),
        receiptRouteParams({ commentId })
      );
      const { data } = (await started.json()) as {
        data: { attachmentId: string; operationReceipt?: { outcome: string } };
      };
      const complete = () =>
        completeUpload(
          apiKeyRouteRequest(
            "POST",
            `/comments/attachments/${data.attachmentId}/complete`
          ),
          receiptRouteParams({ attachmentId: data.attachmentId })
        );
      const statuses = [
        started.status,
        (await complete()).status,
        (await complete()).status,
      ];

      expect(statuses).toEqual([200, 200, 200]);
      expect(data.operationReceipt?.outcome).toBe(
        OperationReceiptOutcome.Committed
      );
      const receipt = (outcome: OperationReceiptOutcome, route: string) => ({
        operationKind: OperationKind.Attach,
        outcome,
        source: OperationSource.Api,
        targetArtifactId: documentId,
        createdArtifactId: null,
        changedFields: [],
        route,
      });
      expect(await readReceipts(world.organizationId)).toEqual([
        receipt(
          OperationReceiptOutcome.Committed,
          "/comments/[commentId]/attachments"
        ),
        receipt(OperationReceiptOutcome.Committed, COMPLETE_ROUTE),
        receipt(OperationReceiptOutcome.NoOp, COMPLETE_ROUTE),
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const { world, commentId } = await seedDocumentComment();
      turnAttributionFlagOff();

      const response = await startUpload(
        apiKeyRouteRequest(
          "POST",
          `/comments/${commentId}/attachments`,
          UPLOAD
        ),
        receiptRouteParams({ commentId })
      );

      expect(response.status).toBe(200);
      expect(await countAttachments(commentId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function countAttachments(commentId: string): Promise<number> {
  return withDb((db) => db.commentAttachment.count({ where: { commentId } }));
}

async function seedPendingUpload(commentId: string): Promise<string> {
  const row = await withDb((db) =>
    db.commentAttachment.create({
      data: {
        commentId,
        name: UPLOAD.name,
        mimeType: UPLOAD.mimeType,
        size: UPLOAD.size,
        bucket: BUCKET,
        key: `comment-attachments/${commentId}/pending`,
      },
      select: { id: true },
    })
  );
  return row.id;
}

async function uploadedAt(attachmentId: string): Promise<Date | null> {
  const row = await withDb((db) =>
    db.commentAttachment.findUniqueOrThrow({
      where: { id: attachmentId },
      select: { uploadedAt: true },
    })
  );
  return row.uploadedAt;
}
