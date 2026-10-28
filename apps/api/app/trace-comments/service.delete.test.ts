/**
 * The legacy adapter's deletes, split out of `service.test.ts` (ISS-11212):
 * a root delete soft-deletes the whole thread, a reply delete only itself.
 */
import { CommentTargetType, ThreadStatus } from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/app/comments/service/comment-thread-signal",
  async (importOriginal) => {
    const { createCommentThreadSignalMockModule } = await import(
      "../../__tests__/fixtures/mock-modules"
    );
    return createCommentThreadSignalMockModule(importOriginal);
  }
);

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ArtifactType: {
      SESSION: "SESSION",
      BRANCH: "BRANCH",
    },
  });
});

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findOwnedById: vi.fn(),
  },
}));

import { storedSessionTraceThreadColumns as storedThreadColumns } from "@/__tests__/support/trace-comments/trace-comment-thread.test-fixtures";
import { getMockWithDb } from "../../__tests__/utils/db-helpers";
import { traceCommentsService } from "./service";

const mockWithDb = getMockWithDb();

/** PLN-2187 T-2.4: a delete also removes the comments' attachment rows. */
function noAttachments() {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("traceCommentsService.delete", () => {
  it("deletes an existing trace comment only when the viewer authored it", async () => {
    const createdAt = new Date("2026-06-17T10:00:00.000Z");
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue({
            artifactId: "session-artifact-1",
          }),
        },
      })
    );

    const commentUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: {
          update: vi.fn().mockResolvedValue({ revision: 1 }),
          findFirst: vi.fn().mockResolvedValue({
            id: "thread-1",
            artifactId: "session-artifact-1",
            status: ThreadStatus.Open,
            ...storedThreadColumns,
            createdAt,
            updatedAt: createdAt,
            comments: [
              {
                id: "comment-1",
                authorId: "user-1",
                plainText: "Persisted note",
                editedAt: null,
                createdAt,
                updatedAt: createdAt,
              },
            ],
          }),
        },
        comment: {
          // FEA-3930: a root delete first reads the affected ids to remove their
          // search-projection rows, then soft-deletes the thread.
          findMany: vi.fn().mockResolvedValue([{ id: "comment-1" }]),
          updateMany: commentUpdateMany,
        },
        commentAttachment: noAttachments(),
      })
    );

    const result = await traceCommentsService.delete({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
    });

    expect(result).toEqual({ ok: true, value: { deleted: true } });
    expect(commentUpdateMany).toHaveBeenCalledWith({
      // ISS-11212 (PLN-2121 decision 7): a delete bumps each comment's revision.
      data: { deletedAt: expect.any(Date), revision: { increment: 1 } },
      where: { threadId: "thread-1", deletedAt: null },
    });
  });

  it("deletes the whole trace comment thread when the root has replies", async () => {
    const createdAt = new Date("2026-06-17T10:00:00.000Z");
    const repliedAt = new Date("2026-06-17T10:05:00.000Z");
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue({
            artifactId: "session-artifact-1",
          }),
        },
      })
    );

    const commentUpdate = vi.fn();
    const commentUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: {
          update: vi.fn().mockResolvedValue({ revision: 1 }),
          findFirst: vi.fn().mockResolvedValue({
            id: "thread-1",
            artifactId: "session-artifact-1",
            status: ThreadStatus.Open,
            ...storedThreadColumns,
            createdAt,
            updatedAt: repliedAt,
            comments: [
              {
                id: "comment-1",
                authorId: "user-1",
                plainText: "Persisted note",
                editedAt: null,
                createdAt,
                updatedAt: createdAt,
              },
              {
                id: "reply-1",
                authorId: "another-user",
                plainText: "Reply that must not become root",
                editedAt: null,
                createdAt: repliedAt,
                updatedAt: repliedAt,
              },
            ],
          }),
        },
        comment: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: "comment-1" }, { id: "reply-1" }]),
          update: commentUpdate,
          updateMany: commentUpdateMany,
        },
        commentAttachment: noAttachments(),
      })
    );

    const result = await traceCommentsService.delete({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
    });

    expect(result).toEqual({ ok: true, value: { deleted: true } });
    expect(commentUpdateMany).toHaveBeenCalledWith({
      // ISS-11212 (PLN-2121 decision 7): a delete bumps each comment's revision.
      data: { deletedAt: expect.any(Date), revision: { increment: 1 } },
      where: { threadId: "thread-1", deletedAt: null },
    });
    expect(commentUpdate).not.toHaveBeenCalled();
  });

  it("deletes only the selected reply when the viewer authored that reply", async () => {
    const createdAt = new Date("2026-06-17T10:00:00.000Z");
    const repliedAt = new Date("2026-06-17T10:05:00.000Z");
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue({
            artifactId: "session-artifact-1",
          }),
        },
      })
    );

    const commentUpdate = vi.fn().mockResolvedValue({ id: "reply-1" });
    const commentUpdateMany = vi.fn();
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: {
          update: vi.fn().mockResolvedValue({ revision: 1 }),
          findFirst: vi.fn().mockResolvedValue({
            id: "thread-1",
            artifactId: "session-artifact-1",
            status: ThreadStatus.Open,
            ...storedThreadColumns,
            createdAt,
            updatedAt: repliedAt,
            comments: [
              {
                id: "comment-1",
                authorId: "another-user",
                plainText: "Persisted note",
                editedAt: null,
                createdAt,
                updatedAt: createdAt,
              },
              {
                id: "reply-1",
                authorId: "user-1",
                plainText: "Reply from viewer",
                editedAt: null,
                createdAt: repliedAt,
                updatedAt: repliedAt,
              },
            ],
          }),
        },
        comment: { update: commentUpdate, updateMany: commentUpdateMany },
        commentAttachment: noAttachments(),
      })
    );

    const result = await traceCommentsService.delete({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "reply-1",
    });

    expect(result).toEqual({ ok: true, value: { deleted: true } });
    expect(commentUpdate).toHaveBeenCalledWith({
      // ISS-11212 (PLN-2121 decision 7): a delete bumps the comment's revision.
      data: { deletedAt: expect.any(Date), revision: { increment: 1 } },
      select: { id: true },
      where: { id: "reply-1" },
    });
    expect(commentUpdateMany).not.toHaveBeenCalled();
  });
});
