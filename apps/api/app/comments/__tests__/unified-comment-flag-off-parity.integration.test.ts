import { randomUUID } from "node:crypto";
import { ThreadStatus } from "@repo/api/src/types/comment";
import {
  CommentReactionEmoji,
  CommentSyncDirection,
  CommentSyncProvider,
  CommentSyncStatus,
} from "@repo/api/src/types/comment-thread-dto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { receiptRouteState } from "@/__tests__/support/lib/operation-receipt-route.test-mocks";
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";

const { BUCKET } = vi.hoisted(() => ({
  BUCKET: "comment-flag-off-parity-test-bucket",
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
  seedReceiptSession,
  seedReceiptThread,
  switchDocumentComments,
} from "@/__tests__/support/comments/comment-receipt-route.test-fixtures";
import { commentTraceAnchor } from "@/__tests__/support/comments/comment-service.test-fixtures";
import { POST as createThread } from "@/app/artifacts/[id]/comments/threads/route";
import { POST as startUpload } from "@/app/comments/[commentId]/attachments/route";
import {
  PUT as react,
  DELETE as unreact,
} from "@/app/comments/[commentId]/reactions/[emoji]/route";
import {
  DELETE as deleteComment,
  PATCH as editComment,
} from "@/app/comments/[commentId]/route";
import { POST as completeUpload } from "@/app/comments/attachments/[attachmentId]/complete/route";
import { commentsService } from "@/app/comments/service";
import { POST as reopenThread } from "@/app/comments/threads/[threadId]/reopen/route";
import { POST as replyToThread } from "@/app/comments/threads/[threadId]/replies/route";
import { POST as resolveThread } from "@/app/comments/threads/[threadId]/resolve/route";
import { POST as retryThreadSync } from "@/app/comments/threads/[threadId]/retry-sync/route";
import { searchIndexService } from "@/app/search/search-index-service";
import type { AuthContext } from "@/lib/auth/with-auth";

const harness = createReceiptRouteHarness();
const EMOJI = CommentReactionEmoji.ThumbsUp;
const UPLOAD = { name: "notes.txt", mimeType: "text/plain", size: 12 };

/**
 * ISS-12552: flag-off behavior equals main for unified comment writes. With
 * `attribution-evidence-policy` off, or for a session caller, the service is
 * handed no record, the answer is main's body with no receipt, the write
 * persists in main's one command transaction, and nothing is recorded.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 unified comment writes match main with attribution evidence off",
  () => {
    beforeEach(() => {
      vi.mocked(searchIndexService.indexAfterCommit).mockClear();
      vi.mocked(searchIndexService.removeAfterCommit).mockClear();
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("POST threads", async () => {
      const { world, sessionId } = await seedSession();
      turnAttributionFlagOff();
      const service = vi.spyOn(commentsService, "createArtifactCommentThread");
      const transactions = countTransactions();

      const response = await createThread(
        apiKeyRouteRequest("POST", `/artifacts/${sessionId}/comments/threads`, {
          anchor: commentTraceAnchor(1),
          body: "root",
          clientId: randomUUID(),
        }),
        receiptRouteParams({ id: sessionId })
      );

      expect(await observedAnswer(response, service.mock.calls)).toStrictEqual(
        mainAnswer(servedValue(await service.mock.results[0]?.value))
      );
      expect(transactions.opened).toBe(1);
      expect(await countThreads(sessionId)).toBe(1);
      expect(searchIndexService.indexAfterCommit).toHaveBeenCalledTimes(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
      expect(receiptRouteState.attributionFlagEvaluations).toBe(1);
    });

    it("POST replies", async () => {
      const { world, threadId } = await seedSessionThread();
      turnAttributionFlagOff();
      const service = vi.spyOn(commentsService, "replyToCommentThread");
      const transactions = countTransactions();

      const response = await replyToThread(
        apiKeyRouteRequest("POST", `/comments/threads/${threadId}/replies`, {
          body: "reply",
          clientId: randomUUID(),
        }),
        receiptRouteParams({ threadId })
      );

      expect(await observedAnswer(response, service.mock.calls)).toStrictEqual(
        mainAnswer(servedValue(await service.mock.results[0]?.value))
      );
      expect(transactions.opened).toBe(1);
      expect(await countComments(threadId)).toBe(2);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST resolve, then reopen", async () => {
      const { world, threadId } = await seedSessionThread();
      turnAttributionFlagOff();
      const resolve = vi.spyOn(commentsService, "resolveCommentThreadById");
      const reopen = vi.spyOn(commentsService, "reopenCommentThreadById");

      const resolved = await resolveThread(
        apiKeyRouteRequest("POST", `/comments/threads/${threadId}/resolve`),
        receiptRouteParams({ threadId })
      );
      expect(await observedAnswer(resolved, resolve.mock.calls)).toStrictEqual(
        mainAnswer(servedValue(await resolve.mock.results[0]?.value))
      );
      expect(await threadStatus(threadId)).toBe(ThreadStatus.Resolved);

      const transactions = countTransactions();
      const reopened = await reopenThread(
        apiKeyRouteRequest("POST", `/comments/threads/${threadId}/reopen`),
        receiptRouteParams({ threadId })
      );
      expect(await observedAnswer(reopened, reopen.mock.calls)).toStrictEqual(
        mainAnswer(servedValue(await reopen.mock.results[0]?.value))
      );
      expect(transactions.opened).toBe(1);
      expect(await threadStatus(threadId)).toBe(ThreadStatus.Open);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST retry-sync", async () => {
      const { world, threadId } = await seedSessionThread();
      await seedDeadLetter(world.organizationId, threadId);
      turnAttributionFlagOff();
      const service = vi.spyOn(commentsService, "retryCommentThreadSync");
      const transactions = countTransactions();

      const response = await retryThreadSync(
        apiKeyRouteRequest("POST", `/comments/threads/${threadId}/retry-sync`),
        receiptRouteParams({ threadId })
      );

      expect(await observedAnswer(response, service.mock.calls)).toStrictEqual(
        mainAnswer(servedValue(await service.mock.results[0]?.value))
      );
      expect(transactions.opened).toBe(1);
      expect(await deliveryState(threadId)).toBe(CommentSyncStatus.Pending);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PATCH a comment", async () => {
      const { world, commentId } = await seedDocumentComment();
      turnAttributionFlagOff();
      const service = vi.spyOn(commentsService, "editCommentById");
      const transactions = countTransactions();

      const response = await editComment(
        apiKeyRouteRequest("PATCH", `/comments/${commentId}`, {
          body: "edited",
          expectedRevision: 0,
        }),
        receiptRouteParams({ commentId })
      );

      expect(await observedAnswer(response, service.mock.calls)).toStrictEqual(
        mainAnswer(servedValue(await service.mock.results[0]?.value))
      );
      expect(transactions.opened).toBe(1);
      expect((await readComment(commentId)).plainText).toBe("edited");
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE a comment", async () => {
      const { world, commentId } = await seedDocumentComment();
      turnAttributionFlagOff();
      const service = vi.spyOn(commentsService, "deleteCommentById");
      const transactions = countTransactions();

      const response = await deleteComment(
        apiKeyRouteRequest("DELETE", `/comments/${commentId}`),
        receiptRouteParams({ commentId })
      );

      expect(await observedAnswer(response, service.mock.calls)).toStrictEqual(
        mainAnswer(servedValue(await service.mock.results[0]?.value))
      );
      expect(transactions.opened).toBe(1);
      expect((await readComment(commentId)).deletedAt).not.toBeNull();
      expect(searchIndexService.removeAfterCommit).toHaveBeenCalledTimes(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PUT and DELETE a reaction", async () => {
      const { world, commentId } = await seedDocumentComment();
      turnAttributionFlagOff();
      const add = vi.spyOn(commentsService, "addReactionByCommentId");
      const remove = vi.spyOn(commentsService, "removeReactionByCommentId");
      const reactionPath = `/comments/${commentId}/reactions/${encodeURIComponent(EMOJI)}`;

      const added = await react(
        apiKeyRouteRequest("PUT", reactionPath),
        receiptRouteParams({ commentId, emoji: EMOJI })
      );
      expect(await observedAnswer(added, add.mock.calls)).toStrictEqual(
        mainAnswer(servedValue(await add.mock.results[0]?.value))
      );
      expect(await countReactions(commentId)).toBe(1);

      const removed = await unreact(
        apiKeyRouteRequest("DELETE", reactionPath),
        receiptRouteParams({ commentId, emoji: EMOJI })
      );
      expect(await observedAnswer(removed, remove.mock.calls)).toStrictEqual(
        mainAnswer(servedValue(await remove.mock.results[0]?.value))
      );
      expect(await countReactions(commentId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST attachments, then complete", async () => {
      const { world, commentId } = await seedDocumentComment();
      turnAttributionFlagOff();
      const start = vi.spyOn(
        commentsService,
        "createCommentAttachmentUploadById"
      );
      const complete = vi.spyOn(
        commentsService,
        "completeCommentAttachmentUploadById"
      );

      const started = await startUpload(
        apiKeyRouteRequest(
          "POST",
          `/comments/${commentId}/attachments`,
          UPLOAD
        ),
        receiptRouteParams({ commentId })
      );
      expect(await observedAnswer(started, start.mock.calls)).toStrictEqual(
        mainAnswer(servedValue(await start.mock.results[0]?.value))
      );
      const attachmentId = await onlyAttachmentId(commentId);

      const transactions = countTransactions();
      const completed = await completeUpload(
        apiKeyRouteRequest(
          "POST",
          `/comments/attachments/${attachmentId}/complete`
        ),
        receiptRouteParams({ attachmentId })
      );
      expect(
        await observedAnswer(completed, complete.mock.calls)
      ).toStrictEqual(
        mainAnswer(servedValue(await complete.mock.results[0]?.value))
      );
      expect(transactions.opened).toBe(1);
      expect(await uploadedAt(attachmentId)).not.toBeNull();
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("a session caller never evaluates the flag and hands no record", async () => {
      const { world, threadId } = await seedSessionThread();
      const apiKeyContext = receiptRouteState.context as AuthContext;
      receiptRouteState.context = createTestAuthContext({
        user: apiKeyContext.user,
        authMethod: "session",
      });
      const service = vi.spyOn(commentsService, "replyToCommentThread");

      const response = await replyToThread(
        apiKeyRouteRequest("POST", `/comments/threads/${threadId}/replies`, {
          body: "reply",
          clientId: randomUUID(),
        }),
        receiptRouteParams({ threadId })
      );

      expect(await observedAnswer(response, service.mock.calls)).toStrictEqual(
        mainAnswer(servedValue(await service.mock.results[0]?.value))
      );
      expect(receiptRouteState.attributionFlagEvaluations).toBe(0);
      expect(await countComments(threadId)).toBe(2);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

/** What the caller got back and what the comment service was handed. */
async function observedAnswer(
  response: Response,
  calls: readonly (readonly unknown[])[]
) {
  return {
    serviceCalls: calls.length,
    record: calls[0]?.[1],
    status: response.status,
    body: await response.json(),
  };
}

/**
 * Main's answer to a comment write the service served as `data`: the service
 * called once with no record (main passed none), 200, and exactly
 * `successResponse(data)`, so no `operationReceipt` rides along.
 */
function mainAnswer(data: unknown) {
  return {
    serviceCalls: 1,
    record: undefined,
    status: 200,
    body: { success: true, data: JSON.parse(JSON.stringify(data)) },
  };
}

function servedValue(
  result: { ok: true; value: unknown } | { ok: false } | undefined
): unknown {
  if (!result?.ok) {
    throw new Error("the comment service did not succeed");
  }
  return result.value;
}

async function seedSession() {
  const world = await harness.seedWorld();
  const sessionId = await seedReceiptSession(world);
  return { world, sessionId };
}

async function seedSessionThread() {
  const { world, sessionId } = await seedSession();
  const { threadId } = await seedReceiptThread(world, sessionId);
  return { world, threadId };
}

async function seedDocumentComment() {
  const world = await harness.seedWorld();
  await switchDocumentComments(world.organizationId);
  const documentId = await harness.seedDocument(world, "Commented");
  const { rootCommentId } = await seedReceiptThread(
    world,
    documentId,
    DOCUMENT_THREAD_ANCHOR
  );
  return { world, commentId: rootCommentId };
}

async function seedDeadLetter(
  organizationId: string,
  threadId: string
): Promise<void> {
  await withDb((db) =>
    db.commentSyncState.create({
      data: {
        organizationId,
        threadId,
        provider: CommentSyncProvider.Desktop,
        direction: CommentSyncDirection.Inbound,
        state: CommentSyncStatus.Abandoned,
      },
      select: { id: true },
    })
  );
}

async function deliveryState(threadId: string): Promise<string | null> {
  const row = await withDb((db) =>
    db.commentSyncState.findFirst({
      where: {
        threadId,
        provider: CommentSyncProvider.Desktop,
        direction: CommentSyncDirection.Inbound,
      },
      select: { state: true },
    })
  );
  return row?.state ?? null;
}

function countThreads(artifactId: string): Promise<number> {
  return withDb((db) => db.commentThread.count({ where: { artifactId } }));
}

function countComments(threadId: string): Promise<number> {
  return withDb((db) =>
    db.comment.count({ where: { threadId, deletedAt: null } })
  );
}

async function threadStatus(threadId: string): Promise<string> {
  const thread = await withDb((db) =>
    db.commentThread.findUniqueOrThrow({
      where: { id: threadId },
      select: { status: true },
    })
  );
  return thread.status;
}

function readComment(commentId: string) {
  return withDb((db) =>
    db.comment.findUniqueOrThrow({
      where: { id: commentId },
      select: { plainText: true, deletedAt: true },
    })
  );
}

function countReactions(commentId: string): Promise<number> {
  return withDb((db) => db.commentReaction.count({ where: { commentId } }));
}

async function onlyAttachmentId(commentId: string): Promise<string> {
  const row = await withDb((db) =>
    db.commentAttachment.findFirstOrThrow({
      where: { commentId },
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
