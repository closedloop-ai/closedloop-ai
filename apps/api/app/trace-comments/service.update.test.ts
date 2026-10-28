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

vi.mock("@/lib/mention-notifications", () => ({
  dispatchMentionNotifications: vi.fn(),
}));

import { storedSessionTraceThreadColumns as storedThreadColumns } from "@/__tests__/support/trace-comments/trace-comment-thread.test-fixtures";
import { computeTargetsService } from "@/app/compute-targets/service";
import { dispatchMentionNotifications } from "@/lib/mention-notifications";
import { getMockWithDb } from "../../__tests__/utils/db-helpers";
import { traceCommentsService } from "./service";

const mockWithDb = getMockWithDb();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue({
    id: "compute-target-1",
  } as Awaited<ReturnType<typeof computeTargetsService.findOwnedById>>);
});

describe("traceCommentsService edits", () => {
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
      })
      // ISS-11216 (#8875): `findThreadOrigin` reads the thread's opening comment.
      .mockResolvedValueOnce({
        createdById: "user-1",
        comments: [{ id: "comment-1", authorId: "user-1" }],
      })
      .mockResolvedValueOnce({
        id: "thread-1",
        artifactId: "session-artifact-1",
        status: ThreadStatus.Open,
        ...storedThreadColumns,
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
    const commentFindUnique = vi.fn().mockResolvedValue({
      body: { type: "doc", content: [], mentions: ["user-2"] },
    });
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: {
          update: vi.fn().mockResolvedValue({ revision: 1 }),
          findFirst: commentThreadFindFirst,
        },
        comment: { update: commentUpdate, findUnique: commentFindUnique },
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
        type: CommentTargetType.Session,
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
          body: {
            type: "doc",
            content: expect.any(Array),
            mentions: ["user-2"],
          },
          plainText: "Edited persisted note",
          editedAt: expect.any(Date),
        }),
        where: { id: "comment-1" },
      })
    );
  });

  it("replaces mentions on an edit that passes an explicit empty list (FEA-3490)", async () => {
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

    let editedBody: unknown;
    const commentUpdate = vi.fn((args) => {
      editedBody = args.data.body;
      return Promise.resolve({
        id: "comment-1",
        authorId: "user-1",
        plainText: "Edited persisted note",
        editedAt,
        createdAt,
        updatedAt: editedAt,
      });
    });
    const commentThreadFindFirst = vi
      .fn()
      .mockResolvedValueOnce({
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
      })
      // ISS-11216 (#8875): `findThreadOrigin` reads the thread's opening comment.
      .mockResolvedValueOnce({
        createdById: "user-1",
        comments: [{ id: "comment-1", authorId: "user-1" }],
      })
      .mockResolvedValueOnce({
        id: "thread-1",
        artifactId: "session-artifact-1",
        status: ThreadStatus.Open,
        ...storedThreadColumns,
        createdAt,
        updatedAt: editedAt,
        comments: [
          {
            id: "comment-1",
            authorId: "user-1",
            plainText: "Edited persisted note",
            body: editedBody,
            editedAt,
            createdAt,
            updatedAt: editedAt,
          },
        ],
      });
    // findUnique IS consulted on every edit now (FEA-3490): the prior mentions
    // are the baseline for the notification delta. Here the comment previously
    // mentioned user-2, and the edit clears mentions to [].
    const commentFindUnique = vi.fn().mockResolvedValue({
      body: { type: "doc", content: [], mentions: ["user-2"] },
    });
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: {
          findFirst: commentThreadFindFirst,
          update: vi.fn().mockResolvedValue({ revision: 1 }),
        },
        comment: { update: commentUpdate, findUnique: commentFindUnique },
        user: {
          findMany: vi
            .fn()
            // scopeMentionsToOrg: explicit [] short-circuits, so this is the
            // author-resolution query only.
            .mockResolvedValue([
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
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
      update: { body: "Edited persisted note", mentions: [] },
    });

    expect(result).toMatchObject({ ok: true });
    // The delta baseline is read, but scopeMentionsToOrg still short-circuits on
    // the explicit [] (no member-scoping query), and the cleared body carries no
    // mentions.
    expect(commentFindUnique).toHaveBeenCalled();
    expect(editedBody).toMatchObject({ type: "doc" });
    expect(editedBody).not.toHaveProperty("mentions");
    // Clearing mentions removes user-2 (nothing is newly added), so nobody is
    // pinged.
    expect(dispatchMentionNotifications).not.toHaveBeenCalled();
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
            ...storedThreadColumns,
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
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
      update: { body: "Edited persisted note" },
    });
    const deleteResult = await traceCommentsService.delete({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
    });

    expect(updateResult).toEqual({ ok: false, reason: "forbidden" });
    expect(deleteResult).toEqual({ ok: false, reason: "forbidden" });
    expect(commentUpdate).not.toHaveBeenCalled();
  });
});
