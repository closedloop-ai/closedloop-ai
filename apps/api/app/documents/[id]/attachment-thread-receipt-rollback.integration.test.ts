import { AttachmentPurpose } from "@repo/api/src/types/attachment";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  receiptRouteParams,
  receiptRouteRequest,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";

const liveblocks = vi.hoisted(() => {
  const at = new Date("2026-10-21T12:00:00.000Z");
  const body = {
    version: 1,
    content: [{ type: "paragraph", children: [{ text: "Receipt test" }] }],
  };
  const author = { userId: "" };
  function comment(roomId: string, threadId: string, id: string) {
    return {
      type: "comment",
      id,
      threadId,
      roomId,
      userId: author.userId,
      createdAt: at,
      body,
      reactions: [],
      attachments: [],
      metadata: {},
    };
  }
  return { at, author, comment };
});

// ISS-12552: receipts are recorded only while attribution-evidence-policy is on.
vi.mock(
  "@/lib/attribution-evidence-policy-feature",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attribution-evidence-policy-feature")
    >()),
    isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  })
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
      FILE_ATTACHMENTS_BUCKET: "receipt-rollback-bucket",
    }),
  };
});
vi.mock(
  "@repo/collaboration/server/room-management",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    createArtifactLevelThread: ({ roomId }: { roomId: string }) => {
      const threadId = `th_${crypto.randomUUID()}`;
      return Promise.resolve({
        type: "thread",
        id: threadId,
        roomId,
        createdAt: liveblocks.at,
        updatedAt: liveblocks.at,
        resolved: false,
        metadata: {},
        comments: [
          liveblocks.comment(roomId, threadId, `cm_${threadId}_first`),
        ],
      });
    },
    replyToArtifactThread: ({
      roomId,
      threadId,
    }: {
      roomId: string;
      threadId: string;
    }) =>
      Promise.resolve(
        liveblocks.comment(roomId, threadId, `cm_${crypto.randomUUID()}`)
      ),
    deleteArtifactThread: () => Promise.resolve(),
    deleteArtifactComment: () => Promise.resolve(),
  })
);

import { DELETE as deleteAttachment } from "@/app/documents/[id]/attachments/[attachmentId]/route";
import { POST as createInlineImage } from "@/app/documents/[id]/attachments/images/route";
import { POST as requestUpload } from "@/app/documents/[id]/attachments/route";
import { POST as replyToThread } from "@/app/documents/[id]/threads/[threadId]/replies/route";
import { POST as createThread } from "@/app/documents/[id]/threads/route";

/** A 1x1 transparent PNG. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const harness = createReceiptRouteHarness();
const organizationIds: string[] = [];

/**
 * ISS-12552: an attachment or comment write and its operation receipt share
 * one transaction, so a receipt that cannot be stored leaves no write behind.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 attachment and thread writes roll back with their receipt",
  () => {
    afterEach(async () => {
      const orgIds = organizationIds.splice(0);
      await withDb((db) =>
        db.commentThread.deleteMany({
          where: { organizationId: { in: orgIds } },
        })
      );
      await harness.cleanup();
    });

    it("POST /documents/[id]/attachments leaves no attachment", async () => {
      const { documentId, organizationId } = await seed();
      failReceiptInserts();

      const response = await requestUpload(
        receiptRouteRequest("POST", `/documents/${documentId}/attachments`, {
          filename: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 12,
          purpose: AttachmentPurpose.Context,
        }),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countAttachments(documentId)).toBe(0);
      expect(await countReceipts(organizationId)).toBe(0);
    });

    it("POST /documents/[id]/attachments/images leaves no attachment", async () => {
      const { documentId, organizationId } = await seed();
      failReceiptInserts();

      const response = await createInlineImage(
        receiptRouteRequest(
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

      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countAttachments(documentId)).toBe(0);
      expect(await countReceipts(organizationId)).toBe(0);
    });

    it("DELETE /documents/[id]/attachments/[attachmentId] keeps the attachment", async () => {
      const { documentId, organizationId, userId } = await seed();
      const attachment = await withDb((db) =>
        db.fileAttachment.create({
          data: {
            artifactId: documentId,
            bucket: "receipt-rollback-bucket",
            key: `attachments/${organizationId}/${documentId}/kept`,
            filename: "kept.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
            createdById: userId,
            purpose: AttachmentPurpose.Context,
          },
          select: { id: true },
        })
      );
      failReceiptInserts();

      const response = await deleteAttachment(
        receiptRouteRequest(
          "DELETE",
          `/documents/${documentId}/attachments/${attachment.id}`
        ),
        receiptRouteParams({ id: documentId, attachmentId: attachment.id })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countAttachments(documentId)).toBe(1);
      expect(await countReceipts(organizationId)).toBe(0);
    });

    it("POST /documents/[id]/threads leaves no thread", async () => {
      const { documentId, organizationId } = await seed();
      failReceiptInserts();

      const response = await createThread(
        receiptRouteRequest("POST", `/documents/${documentId}/threads`, {
          body: "Looks right.",
        }),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countComments(documentId)).toEqual({
        threads: 0,
        comments: 0,
      });
      expect(await countReceipts(organizationId)).toBe(0);
    });

    it("POST /documents/[id]/threads/[threadId]/replies leaves no reply", async () => {
      const { documentId, organizationId } = await seed();
      const created = await createThread(
        receiptRouteRequest("POST", `/documents/${documentId}/threads`, {
          body: "First.",
        }),
        receiptRouteParams({ id: documentId })
      );
      expect(created.status).toBe(200);
      const { data } = await created.json();
      failReceiptInserts();

      const response = await replyToThread(
        receiptRouteRequest(
          "POST",
          `/documents/${documentId}/threads/${data.threadId}/replies`,
          { body: "Agreed." }
        ),
        receiptRouteParams({ id: documentId, threadId: data.threadId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countComments(documentId)).toEqual({
        threads: 1,
        comments: 1,
      });
      expect(await countReceipts(organizationId)).toBe(1);
    });
  }
);

async function seed() {
  const world = await harness.seedWorld();
  organizationIds.push(world.organizationId);
  liveblocks.author.userId = world.userId;
  const documentId = await harness.seedDocument(world, "Receipt rollback");
  return { ...world, documentId };
}

function countAttachments(documentId: string): Promise<number> {
  return withDb((db) =>
    db.fileAttachment.count({ where: { artifactId: documentId } })
  );
}

async function countComments(documentId: string) {
  return await withDb(async (db) => ({
    threads: await db.commentThread.count({
      where: { artifactId: documentId },
    }),
    comments: await db.comment.count({
      where: { thread: { artifactId: documentId } },
    }),
  }));
}
