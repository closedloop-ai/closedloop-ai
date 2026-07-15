import {
  ThreadSource,
  ThreadStatus,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ArtifactType: {
      SESSION: "SESSION",
      BRANCH: "BRANCH",
    },
    Prisma: {
      JsonNull: null,
    },
  });
});

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findOwnedById: vi.fn(),
  },
}));

import { computeTargetsService } from "@/app/compute-targets/service";
import { getMockWithDb } from "../../__tests__/utils/db-helpers";
import { traceCommentsService } from "./service";

const mockWithDb = getMockWithDb();

const anchor = {
  traceId: "trace:session-1:0",
  turnId: "turn:session-1:0",
  row: 0,
  selectedText: "quote target",
  sourceText: "A trace quote target row",
  startOffset: 8,
  endOffset: 20,
  sessionId: "session-1",
  actor: { name: "codex", human: null },
};

const metadata = {
  kind: "trace_comment",
  schemaVersion: 1,
  targetType: TraceCommentTargetType.Session,
  surface: "session_detail",
  anchor,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue({
    id: "compute-target-1",
  } as Awaited<ReturnType<typeof computeTargetsService.findOwnedById>>);
});

describe("traceCommentsService", () => {
  it("resolves desktop comments through compute target and external session id before user fallback", async () => {
    const sessionFindFirst = vi.fn((args) => {
      if (args.where.artifactId === "desktop-session-1") {
        return Promise.resolve(null);
      }
      if (
        args.where.computeTargetId === "compute-target-1" &&
        args.where.externalSessionId === "desktop-session-1"
      ) {
        return Promise.resolve({ artifactId: "session-artifact-1" });
      }
      return Promise.resolve(null);
    });
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: { findFirst: sessionFindFirst },
      })
    );

    const threadCreate = vi.fn().mockResolvedValue({
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      metadata,
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      comments: [
        {
          id: "comment-1",
          authorId: "api-key-user",
          plainText: "Desktop note",
          createdAt: new Date("2026-06-17T10:00:00.000Z"),
          updatedAt: new Date("2026-06-17T10:00:00.000Z"),
        },
      ],
    });
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: { create: threadCreate },
        user: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "api-key-user",
              firstName: "API",
              lastName: "User",
              email: "api@example.com",
              avatarUrl: null,
            },
          ]),
        },
      })
    );

    const created = await traceCommentsService.create({
      organizationId: "org-1",
      userId: "api-key-user",
      target: { type: TraceCommentTargetType.Session, id: "desktop-session-1" },
      computeTargetId: "compute-target-1",
      draft: { anchor, body: "Desktop note" },
    });

    expect(created).toMatchObject({
      id: "comment-1",
      artifactId: "session-artifact-1",
      body: "Desktop note",
    });
    expect(sessionFindFirst).toHaveBeenCalledTimes(2);
    expect(sessionFindFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          computeTargetId: "compute-target-1",
          externalSessionId: "desktop-session-1",
        }),
      })
    );
    expect(threadCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactId: "session-artifact-1",
          createdById: "api-key-user",
        }),
      })
    );
    expect(computeTargetsService.findOwnedById).toHaveBeenCalledWith(
      "compute-target-1",
      "org-1",
      "api-key-user",
      null
    );
  });

  it("rejects desktop external session comments for unowned compute targets", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValueOnce(null);
    const sessionFindFirst = vi.fn().mockResolvedValue(null);
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: { findFirst: sessionFindFirst },
      })
    );

    const created = await traceCommentsService.create({
      organizationId: "org-1",
      userId: "api-key-user",
      clerkUserId: "clerk-user-1",
      target: { type: TraceCommentTargetType.Session, id: "desktop-session-1" },
      computeTargetId: "compute-target-1",
      draft: { anchor, body: "Should not attach" },
    });

    expect(created).toBeNull();
    expect(computeTargetsService.findOwnedById).toHaveBeenCalledWith(
      "compute-target-1",
      "org-1",
      "api-key-user",
      "clerk-user-1"
    );
    expect(sessionFindFirst).toHaveBeenCalledTimes(1);
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("creates a native thread/comment after resolving a desktop external session id to a cloud artifact", async () => {
    const sessionFindFirst = vi.fn((args) => {
      if (args.where.artifactId === "desktop-session-1") {
        return Promise.resolve(null);
      }
      if (
        args.where.externalSessionId === "desktop-session-1" &&
        args.where.userId === "user-1"
      ) {
        return Promise.resolve({ artifactId: "session-artifact-1" });
      }
      return Promise.resolve(null);
    });
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: { findFirst: sessionFindFirst },
      })
    );

    const threadCreate = vi.fn().mockResolvedValue({
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      metadata,
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      comments: [
        {
          id: "comment-1",
          authorId: "user-1",
          plainText: "Persisted note",
          createdAt: new Date("2026-06-17T10:00:00.000Z"),
          updatedAt: new Date("2026-06-17T10:00:00.000Z"),
        },
      ],
    });
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: { create: threadCreate },
        user: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "user-1",
              firstName: "Test",
              lastName: "User",
              email: "test@example.com",
              avatarUrl: null,
            },
          ]),
        },
      })
    );

    const created = await traceCommentsService.create({
      organizationId: "org-1",
      userId: "user-1",
      target: { type: TraceCommentTargetType.Session, id: "desktop-session-1" },
      draft: { anchor, body: "Persisted note" },
    });

    expect(created).toMatchObject({
      id: "comment-1",
      threadId: "thread-1",
      artifactId: "session-artifact-1",
      body: "Persisted note",
      authorName: "Test User",
      anchor,
    });
    expect(sessionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          externalSessionId: "desktop-session-1",
          userId: "user-1",
        }),
      })
    );
    expect(threadCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          artifactId: "session-artifact-1",
          source: ThreadSource.Native,
          status: ThreadStatus.Open,
          createdById: "user-1",
          comments: {
            create: expect.objectContaining({
              authorId: "user-1",
              plainText: "Persisted note",
            }),
          },
          metadata: expect.objectContaining({
            kind: "trace_comment",
            targetType: TraceCommentTargetType.Session,
            anchor,
          }),
        }),
      })
    );
  });

  it("does not resolve another user's session through an unowned org-wide external id fallback", async () => {
    const sessionFindFirst = vi.fn().mockResolvedValue(null);
    const sessionFindMany = vi
      .fn()
      .mockResolvedValue([{ artifactId: "other-user-session-artifact" }]);
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: sessionFindFirst,
          findMany: sessionFindMany,
        },
      })
    );

    const created = await traceCommentsService.create({
      organizationId: "org-1",
      userId: "user-1",
      target: { type: TraceCommentTargetType.Session, id: "desktop-session-1" },
      draft: { anchor, body: "Should not attach" },
    });

    expect(created).toBeNull();
    expect(sessionFindFirst).toHaveBeenCalledTimes(2);
    expect(sessionFindMany).not.toHaveBeenCalled();
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("lists only native trace-comment threads for the resolved artifact", async () => {
    const commentThreadFindMany = vi.fn().mockResolvedValue([
      {
        id: "thread-1",
        artifactId: "session-artifact-1",
        status: ThreadStatus.Open,
        metadata,
        createdAt: new Date("2026-06-17T10:00:00.000Z"),
        updatedAt: new Date("2026-06-17T10:00:00.000Z"),
        comments: [
          {
            id: "comment-1",
            authorId: "user-1",
            plainText: "Persisted note",
            createdAt: new Date("2026-06-17T10:00:00.000Z"),
            updatedAt: new Date("2026-06-17T10:00:00.000Z"),
          },
        ],
      },
      {
        id: "thread-2",
        artifactId: "session-artifact-1",
        status: ThreadStatus.Open,
        metadata: { kind: "document_comment" },
        createdAt: new Date("2026-06-17T10:01:00.000Z"),
        updatedAt: new Date("2026-06-17T10:01:00.000Z"),
        comments: [
          {
            id: "comment-2",
            authorId: "user-1",
            plainText: "Should not be returned",
            createdAt: new Date("2026-06-17T10:01:00.000Z"),
            updatedAt: new Date("2026-06-17T10:01:00.000Z"),
          },
        ],
      },
    ]);
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue({
            artifactId: "session-artifact-1",
          }),
        },
        commentThread: { findMany: commentThreadFindMany },
        user: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "user-1",
              firstName: "Test",
              lastName: "User",
              email: "test@example.com",
              avatarUrl: null,
            },
          ]),
        },
      })
    );

    const comments = await traceCommentsService.list({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
    });

    expect(comments).toHaveLength(1);
    expect(comments?.[0]).toMatchObject({
      id: "comment-1",
      threadId: "thread-1",
      body: "Persisted note",
      artifactId: "session-artifact-1",
      authorName: "Test User",
    });
    expect(commentThreadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          artifactId: "session-artifact-1",
          source: ThreadSource.Native,
        },
      })
    );
  });

  it("adds replies to an existing trace comment thread and returns the updated thread", async () => {
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

    const parentThread = {
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      metadata,
      createdAt,
      updatedAt: createdAt,
      comments: [
        {
          id: "comment-1",
          authorId: "another-user",
          plainText: "Persisted note",
          editedAt: null,
          createdAt,
          updatedAt: createdAt,
        },
      ],
    };
    const updatedThread = {
      ...parentThread,
      updatedAt: repliedAt,
      comments: [
        ...parentThread.comments,
        {
          id: "reply-1",
          authorId: "user-1",
          plainText: "Reply from viewer",
          editedAt: null,
          createdAt: repliedAt,
          updatedAt: repliedAt,
        },
      ],
    };
    const commentCreate = vi.fn().mockResolvedValue({ id: "reply-1" });
    const commentThreadFindFirst = vi
      .fn()
      .mockResolvedValueOnce(parentThread)
      .mockResolvedValueOnce(updatedThread);
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: { findFirst: commentThreadFindFirst },
        comment: { create: commentCreate },
        user: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "another-user",
              firstName: "Other",
              lastName: "User",
              email: "other@example.com",
              avatarUrl: null,
            },
            {
              id: "user-1",
              firstName: "Test",
              lastName: "User",
              email: "test@example.com",
              avatarUrl: null,
            },
          ]),
        },
      })
    );

    const result = await traceCommentsService.reply({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
      draft: { body: "Reply from viewer" },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        id: "comment-1",
        body: "Persisted note",
        canEdit: false,
        canDelete: false,
        replies: [
          {
            id: "reply-1",
            body: "Reply from viewer",
            authorName: "Test User",
            canEdit: true,
            canDelete: true,
          },
        ],
      },
    });
    expect(commentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authorId: "user-1",
          plainText: "Reply from viewer",
          threadId: "thread-1",
        }),
      })
    );
  });

  it("rejects nested replies so replies never become reply parents", async () => {
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

    const commentCreate = vi.fn();
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: {
          findFirst: vi.fn().mockResolvedValue({
            id: "thread-1",
            artifactId: "session-artifact-1",
            status: ThreadStatus.Open,
            metadata,
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
        comment: { create: commentCreate },
      })
    );

    const result = await traceCommentsService.reply({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "reply-1",
      draft: { body: "Nested reply should fail" },
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(commentCreate).not.toHaveBeenCalled();
  });

  it("updates an existing trace comment only when the viewer authored it", async () => {
    const createdAt = new Date("2026-06-17T10:00:00.000Z");
    const editedAt = new Date("2026-06-17T10:05:00.000Z");
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue({
            artifactId: "session-artifact-1",
          }),
        },
      })
    );

    const commentUpdate = vi.fn().mockResolvedValue({
      id: "comment-1",
      authorId: "user-1",
      plainText: "Edited persisted note",
      editedAt,
      createdAt,
      updatedAt: editedAt,
    });
    const commentThreadFindFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: "thread-1",
        artifactId: "session-artifact-1",
        status: ThreadStatus.Open,
        metadata,
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
      })
      .mockResolvedValueOnce({
        id: "thread-1",
        artifactId: "session-artifact-1",
        status: ThreadStatus.Open,
        metadata,
        createdAt,
        updatedAt: editedAt,
        comments: [
          {
            id: "comment-1",
            authorId: "user-1",
            plainText: "Edited persisted note",
            editedAt,
            createdAt,
            updatedAt: editedAt,
          },
        ],
      });
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: {
          findFirst: commentThreadFindFirst,
        },
        comment: { update: commentUpdate },
        user: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "user-1",
              firstName: "Test",
              lastName: "User",
              email: "test@example.com",
              avatarUrl: null,
            },
          ]),
        },
      })
    );

    const result = await traceCommentsService.update({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
      update: { body: "Edited persisted note" },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        id: "comment-1",
        body: "Edited persisted note",
        canEdit: true,
        canDelete: true,
        editedAt: editedAt.toISOString(),
      },
    });
    expect(commentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          plainText: "Edited persisted note",
          editedAt: expect.any(Date),
        }),
        where: { id: "comment-1" },
      })
    );
  });

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
          findFirst: vi.fn().mockResolvedValue({
            id: "thread-1",
            artifactId: "session-artifact-1",
            status: ThreadStatus.Open,
            metadata,
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
        comment: { updateMany: commentUpdateMany },
      })
    );

    const result = await traceCommentsService.delete({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
    });

    expect(result).toEqual({ ok: true, value: { deleted: true } });
    expect(commentUpdateMany).toHaveBeenCalledWith({
      data: { deletedAt: expect.any(Date) },
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
          findFirst: vi.fn().mockResolvedValue({
            id: "thread-1",
            artifactId: "session-artifact-1",
            status: ThreadStatus.Open,
            metadata,
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
        comment: { update: commentUpdate, updateMany: commentUpdateMany },
      })
    );

    const result = await traceCommentsService.delete({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
    });

    expect(result).toEqual({ ok: true, value: { deleted: true } });
    expect(commentUpdateMany).toHaveBeenCalledWith({
      data: { deletedAt: expect.any(Date) },
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
          findFirst: vi.fn().mockResolvedValue({
            id: "thread-1",
            artifactId: "session-artifact-1",
            status: ThreadStatus.Open,
            metadata,
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
      })
    );

    const result = await traceCommentsService.delete({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "reply-1",
    });

    expect(result).toEqual({ ok: true, value: { deleted: true } });
    expect(commentUpdate).toHaveBeenCalledWith({
      data: { deletedAt: expect.any(Date) },
      select: { id: true },
      where: { id: "reply-1" },
    });
    expect(commentUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects trace comment edit and delete for non-authors", async () => {
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

    const commentUpdate = vi.fn();
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: {
          findFirst: vi.fn().mockResolvedValue({
            id: "thread-1",
            artifactId: "session-artifact-1",
            status: ThreadStatus.Open,
            metadata,
            createdAt,
            updatedAt: createdAt,
            comments: [
              {
                id: "comment-1",
                authorId: "another-user",
                plainText: "Persisted note",
                editedAt: null,
                createdAt,
                updatedAt: createdAt,
              },
            ],
          }),
        },
        comment: { update: commentUpdate },
      })
    );

    const updateResult = await traceCommentsService.update({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
      update: { body: "Edited persisted note" },
    });
    const deleteResult = await traceCommentsService.delete({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
    });

    expect(updateResult).toEqual({ ok: false, reason: "forbidden" });
    expect(deleteResult).toEqual({ ok: false, reason: "forbidden" });
    expect(commentUpdate).not.toHaveBeenCalled();
  });
});
