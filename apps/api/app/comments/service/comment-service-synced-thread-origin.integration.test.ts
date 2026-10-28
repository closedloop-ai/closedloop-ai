/**
 * A Liveblocks-synced thread on a Document keeps its replies when the sync
 * deletes its first comment. The thread's author stays its stored creator and
 * its root stays that deleted comment, so the first surviving replier is
 * neither (#8875 review).
 */
import { randomUUID } from "node:crypto";
import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@repo/aws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/aws")>()),
  deleteObjects: vi.fn(() => Promise.resolve()),
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
  type CommentTestOrg,
  seedCommentTestOrg,
} from "@/__tests__/support/comments/comment-service.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { unifiedCommentRequests as requests } from "./unified-comment-requests";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const tracker = createCommittedTestOrganizationTracker();

type SyncedThread = {
  threadId: string;
  otherReplyId: string;
  authorReplyId: string;
  authorAttachmentId: string;
};

/**
 * The author opened the thread and the sync has since deleted their first
 * comment; `other` replied first, then the author replied with an attachment.
 */
async function seedThreadWithDeletedRoot(
  org: CommentTestOrg,
  documentId: string,
  status: ThreadStatus
): Promise<SyncedThread> {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes));
  const comment = (authorId: string, minutes: number, deleted = false) => ({
    authorId,
    body: { version: 1, content: [] },
    bodyFormat: CommentBodyFormat.LiveblocksV1,
    plainText: "synced",
    externalId: `cm_${randomUUID()}`,
    createdAt: at(minutes),
    ...(deleted ? { deletedAt: at(30) } : {}),
  });
  const thread = await withDb((db) =>
    db.commentThread.create({
      data: {
        organizationId: org.organizationId,
        artifactId: documentId,
        source: ThreadSource.Liveblocks,
        externalId: `th_${randomUUID()}`,
        roomId: `room-${randomUUID()}`,
        status,
        metadata: { version: 1 },
        createdById: org.author.userId,
        comments: {
          create: [
            comment(org.author.userId, 0, true),
            comment(org.other.userId, 1),
            {
              ...comment(org.author.userId, 2),
              attachments: {
                create: {
                  externalId: `at_${randomUUID()}`,
                  name: "kept.png",
                  url: "https://files.example/kept.png",
                },
              },
            },
          ],
        },
      },
      select: {
        id: true,
        comments: {
          select: { id: true, attachments: { select: { id: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    })
  );
  const [, otherReply, authorReply] = thread.comments;
  return {
    threadId: thread.id,
    otherReplyId: otherReply?.id as string,
    authorReplyId: authorReply?.id as string,
    authorAttachmentId: authorReply?.attachments[0]?.id as string,
  };
}

describeIfDb("a synced Document thread whose first comment was deleted", () => {
  let org: CommentTestOrg;
  let documentId: string;

  beforeAll(async () => {
    org = await seedCommentTestOrg(tracker);
    documentId = await withDb(async (db) => {
      await db.organization.update({
        where: { id: org.organizationId },
        data: { documentCommentsSwitchedAt: new Date() },
        select: { id: true },
      });
      const document = await db.artifact.create({
        data: {
          organizationId: org.organizationId,
          type: ArtifactType.DOCUMENT,
          name: `document-${randomUUID().slice(0, 8)}`,
          status: DocumentStatus.Draft,
          createdById: org.author.userId,
        },
        select: { id: true },
      });
      return document.id;
    });
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  it("lets its creator reopen it, and not the first surviving replier", async () => {
    const { threadId } = await seedThreadWithDeletedRoot(
      org,
      documentId,
      ThreadStatus.Resolved
    );

    const byReplier = await requests.reopenCommentThreadById({
      viewer: org.other,
      threadId,
    });
    const byCreator = await requests.reopenCommentThreadById({
      viewer: org.author,
      threadId,
    });

    expect(byReplier).toEqual({
      ok: false,
      error: CommentErrorCode.CapabilityDenied,
    });
    expect(byCreator.ok && byCreator.value.status).toBe(ThreadStatus.Open);
  });

  it("deletes only the reply a replier deletes, keeping another author's reply and its attachment", async () => {
    const synced = await seedThreadWithDeletedRoot(
      org,
      documentId,
      ThreadStatus.Open
    );

    const deleted = await requests.deleteCommentById({
      viewer: org.other,
      commentId: synced.otherReplyId,
    });

    expect(deleted).toEqual({ ok: true, value: { deleted: true } });
    const [comments, attachment] = await withDb((db) =>
      Promise.all([
        db.comment.findMany({
          where: { threadId: synced.threadId, deletedAt: null },
          select: { id: true },
        }),
        db.commentAttachment.findUnique({
          where: { id: synced.authorAttachmentId },
          select: { id: true },
        }),
      ])
    );
    expect(comments.map((comment) => comment.id)).toEqual([
      synced.authorReplyId,
    ]);
    expect(attachment).not.toBeNull();
  });
});
