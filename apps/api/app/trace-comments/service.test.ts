import {
  CommentSurface,
  CommentTargetType,
  ThreadSource,
  ThreadStatus,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import { STAFF_EMAIL_DOMAIN } from "@repo/api/src/types/staff-email";
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

import {
  sessionTraceAnchor as anchor,
  sessionTraceMetadata as metadata,
  storedSessionTraceThreadColumns as storedThreadColumns,
} from "@/__tests__/support/trace-comments/trace-comment-thread.test-fixtures";
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

describe("traceCommentsService", () => {
  it("resolves desktop comments through compute target and external session id before user fallback", async () => {
    const sessionFindFirst = vi.fn((args) => {
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
      ...storedThreadColumns,
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
      target: { type: CommentTargetType.Session, id: "desktop-session-1" },
      computeTargetId: "compute-target-1",
      draft: { anchor, body: "Desktop note" },
    });

    expect(created).toMatchObject({
      id: "comment-1",
      artifactId: "session-artifact-1",
      body: "Desktop note",
    });
    // ISS-11190: a non-UUID target never probes the `@db.Uuid` artifact id.
    expect(sessionFindFirst).toHaveBeenCalledTimes(1);
    expect(sessionFindFirst).toHaveBeenNthCalledWith(
      1,
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
      target: { type: CommentTargetType.Session, id: "desktop-session-1" },
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
    expect(sessionFindFirst).not.toHaveBeenCalled();
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("creates a native thread/comment after resolving a desktop external session id to a cloud artifact", async () => {
    const sessionFindFirst = vi.fn((args) => {
      if (
        args.where.externalSessionId === "desktop-session-1" &&
        args.where.artifact?.is?.createdById === "user-1"
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
      ...storedThreadColumns,
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
      target: { type: CommentTargetType.Session, id: "desktop-session-1" },
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
          artifact: { is: expect.objectContaining({ createdById: "user-1" }) },
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
            targetType: CommentTargetType.Session,
          }),
        }),
      })
    );
  });

  it("persists a parsing-bug classification in metadata and maps it back on the created comment (FEA-4171)", async () => {
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ artifactId: "session-artifact-1" }),
        },
        // ISS-11212 (PLN-2121 decision 5): the kind is staff-only on the server.
        user: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ email: `triage${STAFF_EMAIL_DOMAIN}` }),
        },
      })
    );

    const threadCreate = vi.fn().mockResolvedValue({
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      // The mapper reads the classification from the persisted metadata.
      ...storedThreadColumns,
      metadata: { ...metadata, commentKind: TraceCommentKind.ParsingBug },
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      comments: [
        {
          id: "comment-1",
          authorId: "user-1",
          plainText: "Collector emitted raw text; expected parsed JSON.",
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
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      draft: {
        anchor,
        body: "Collector emitted raw text; expected parsed JSON.",
        kind: TraceCommentKind.ParsingBug,
      },
    });

    expect(created).toHaveProperty("kind", TraceCommentKind.ParsingBug);
    expect(threadCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            kind: "trace_comment",
            commentKind: TraceCommentKind.ParsingBug,
          }),
        }),
      })
    );
  });

  it("omits commentKind from metadata for a plain comment (FEA-4171)", async () => {
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ artifactId: "session-artifact-1" }),
        },
      })
    );

    const threadCreate = vi.fn().mockResolvedValue({
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      ...storedThreadColumns,
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      comments: [
        {
          id: "comment-1",
          authorId: "user-1",
          plainText: "Plain note",
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
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      draft: { anchor, body: "Plain note" },
    });

    expect(created).toHaveProperty("kind", TraceCommentKind.Comment);
    const persistedMetadata = threadCreate.mock.calls[0]?.[0]?.data?.metadata;
    expect(persistedMetadata).not.toHaveProperty("commentKind");
  });

  it("stamps the client-supplied idempotency id on the created thread's externalId (FEA-3598)", async () => {
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ artifactId: "session-artifact-1" }),
        },
      })
    );

    const threadFindUnique = vi.fn().mockResolvedValue(null);
    const threadCreate = vi.fn().mockResolvedValue({
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      ...storedThreadColumns,
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
        commentThread: { findUnique: threadFindUnique, create: threadCreate },
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
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      draft: { anchor, body: "Persisted note", clientId: "local-comment-1" },
    });

    expect(created).toMatchObject({ id: "comment-1", threadId: "thread-1" });
    expect(threadFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_externalId: {
            organizationId: "org-1",
            externalId: "local-comment-1",
          },
        },
      })
    );
    expect(threadCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ externalId: "local-comment-1" }),
      })
    );
  });

  it("dedups a retried create onto the existing thread by clientId without re-creating or re-notifying (FEA-3598)", async () => {
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ artifactId: "session-artifact-1" }),
        },
      })
    );

    const existingThread = {
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      ...storedThreadColumns,
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      comments: [
        {
          id: "comment-1",
          authorId: "user-1",
          plainText: "Persisted note",
          // Body carries a mention so a replay that re-notified would be caught.
          body: { mentions: ["user-2"] },
          createdAt: new Date("2026-06-17T10:00:00.000Z"),
          updatedAt: new Date("2026-06-17T10:00:00.000Z"),
        },
      ],
    };
    const threadFindUnique = vi.fn().mockResolvedValue(existingThread);
    const threadCreate = vi.fn();
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: { findUnique: threadFindUnique, create: threadCreate },
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
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      draft: { anchor, body: "Persisted note", clientId: "local-comment-1" },
    });

    expect(created).toMatchObject({ id: "comment-1", threadId: "thread-1" });
    expect(threadCreate).not.toHaveBeenCalled();
    expect(dispatchMentionNotifications).not.toHaveBeenCalled();
  });

  it("recovers a concurrent-retry create P2002 by re-running the tx onto the committed thread (FEA-3598)", async () => {
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ artifactId: "session-artifact-1" }),
        },
      })
    );

    const existingThread = {
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      ...storedThreadColumns,
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      comments: [
        {
          id: "comment-1",
          authorId: "user-1",
          plainText: "Persisted note",
          // A recovered replay must not re-notify the mentioned recipient.
          body: { mentions: ["user-2"] },
          createdAt: new Date("2026-06-17T10:00:00.000Z"),
          updatedAt: new Date("2026-06-17T10:00:00.000Z"),
        },
      ],
    };
    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    });
    const userFindMany = vi.fn().mockResolvedValue([
      {
        id: "user-1",
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        avatarUrl: null,
      },
    ]);
    const firstFindUnique = vi.fn().mockResolvedValue(null);
    const firstCreate = vi.fn().mockRejectedValue(p2002);
    const retryFindUnique = vi.fn().mockResolvedValue(existingThread);
    const retryCreate = vi.fn();
    mockWithDb.tx
      .mockImplementationOnce((callback) =>
        callback({
          commentThread: { findUnique: firstFindUnique, create: firstCreate },
          user: { findMany: userFindMany },
        })
      )
      .mockImplementationOnce((callback) =>
        callback({
          commentThread: { findUnique: retryFindUnique, create: retryCreate },
          user: { findMany: userFindMany },
        })
      );

    const created = await traceCommentsService.create({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      draft: { anchor, body: "Persisted note", clientId: "local-comment-1" },
    });

    expect(created).toMatchObject({ id: "comment-1", threadId: "thread-1" });
    expect(firstCreate).toHaveBeenCalledTimes(1);
    expect(retryCreate).not.toHaveBeenCalled();
    expect(mockWithDb.tx).toHaveBeenCalledTimes(2);
    expect(dispatchMentionNotifications).not.toHaveBeenCalled();
  });

  it("persists only org-scoped @-mentions on the created comment body (FEA-3490)", async () => {
    const sessionFindFirst = vi
      .fn()
      .mockResolvedValue({ artifactId: "session-artifact-1" });
    mockWithDb.mockImplementation((callback) =>
      callback({ sessionDetail: { findFirst: sessionFindFirst } })
    );

    let createdBody: unknown;
    const threadCreate = vi.fn((args) => {
      createdBody = args.data.comments.create.body;
      return Promise.resolve({
        id: "thread-1",
        artifactId: "session-artifact-1",
        status: ThreadStatus.Open,
        ...storedThreadColumns,
        createdAt: new Date("2026-06-17T10:00:00.000Z"),
        updatedAt: new Date("2026-06-17T10:00:00.000Z"),
        comments: [
          {
            id: "comment-1",
            authorId: "user-1",
            plainText: "cc the team",
            body: createdBody,
            createdAt: new Date("2026-06-17T10:00:00.000Z"),
            updatedAt: new Date("2026-06-17T10:00:00.000Z"),
          },
        ],
      });
    });
    // First call scopes mentions to org members (active, in the org): only
    // "user-2" is returned, so the cross-org "user-999" is dropped. Second call
    // resolves comment authors.
    const userFindMany = vi
      .fn()
      .mockResolvedValueOnce([{ id: "user-2" }])
      .mockResolvedValueOnce([
        {
          id: "user-1",
          firstName: "Test",
          lastName: "User",
          email: "test@example.com",
          avatarUrl: null,
        },
      ]);
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: { create: threadCreate },
        user: { findMany: userFindMany },
      })
    );

    const created = await traceCommentsService.create({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      draft: { anchor, body: "cc the team", mentions: ["user-2", "user-999"] },
    });

    expect(userFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          active: true,
          id: { in: ["user-2", "user-999"] },
        }),
      })
    );
    expect(createdBody).toMatchObject({ mentions: ["user-2"] });
    expect(created).toMatchObject({
      id: "comment-1",
      body: "cc the team",
      mentions: ["user-2"],
    });
    expect(dispatchMentionNotifications).toHaveBeenCalledTimes(1);
    expect(dispatchMentionNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserIds: ["user-2"],
        actorUserId: "user-1",
        organizationId: "org-1",
        entityType: "session",
        artifactId: "session-artifact-1",
        commentId: "comment-1",
        commentBody: "cc the team",
      })
    );
  });

  it("dispatches a branch-surface mention with entityType 'branch' (FEA-3490)", async () => {
    const branchFindFirst = vi
      .fn()
      .mockResolvedValue({ artifactId: "branch-artifact-1" });
    mockWithDb.mockImplementation((callback) =>
      callback({ branchDetail: { findFirst: branchFindFirst } })
    );

    let createdBody: unknown;
    const threadCreate = vi.fn((args) => {
      createdBody = args.data.comments.create.body;
      return Promise.resolve({
        id: "thread-b1",
        artifactId: "branch-artifact-1",
        status: ThreadStatus.Open,
        ...storedThreadColumns,
        metadata: args.data.metadata,
        createdAt: new Date("2026-06-17T10:00:00.000Z"),
        updatedAt: new Date("2026-06-17T10:00:00.000Z"),
        comments: [
          {
            id: "comment-b1",
            authorId: "user-1",
            plainText: "cc on branch",
            body: createdBody,
            createdAt: new Date("2026-06-17T10:00:00.000Z"),
            updatedAt: new Date("2026-06-17T10:00:00.000Z"),
          },
        ],
      });
    });
    const userFindMany = vi
      .fn()
      .mockResolvedValueOnce([{ id: "user-2" }])
      .mockResolvedValueOnce([
        {
          id: "user-1",
          firstName: "Test",
          lastName: "User",
          email: "test@example.com",
          avatarUrl: null,
        },
      ]);
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: { create: threadCreate },
        user: { findMany: userFindMany },
      })
    );

    const created = await traceCommentsService.create({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Branch,
        id: "branch-artifact-1",
      },
      surface: CommentSurface.BranchTimeline,
      draft: { anchor, body: "cc on branch", mentions: ["user-2"] },
    });

    expect(created).toMatchObject({
      id: "comment-b1",
      mentions: ["user-2"],
      surface: CommentSurface.BranchTimeline,
    });
    expect(dispatchMentionNotifications).toHaveBeenCalledTimes(1);
    expect(dispatchMentionNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserIds: ["user-2"],
        actorUserId: "user-1",
        organizationId: "org-1",
        entityType: "branch",
        artifactId: "branch-artifact-1",
        commentId: "comment-b1",
        commentBody: "cc on branch",
      })
    );
  });

  it("pings only the newly-added @-mention on an edit, not the pre-existing one (FEA-3490)", async () => {
    const sessionFindFirst = vi
      .fn()
      .mockResolvedValue({ artifactId: "session-artifact-1" });
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: { findFirst: sessionFindFirst },
        artifact: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ name: "Fix the flaky login test" }),
        },
      })
    );

    const commentFindUnique = vi.fn().mockResolvedValue({
      body: { type: "doc", content: [], mentions: ["user-2"] },
    });
    const userFindMany = vi
      .fn()
      // scopeMentionsToOrg: both requested ids are active org members.
      .mockResolvedValueOnce([{ id: "user-2" }, { id: "user-3" }])
      // author resolution for the mapped thread.
      .mockResolvedValueOnce([
        {
          id: "user-1",
          firstName: "Test",
          lastName: "User",
          email: "test@example.com",
          avatarUrl: null,
        },
      ]);
    const editableThread = {
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      ...storedThreadColumns,
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:05:00.000Z"),
      comments: [
        {
          id: "comment-1",
          authorId: "user-1",
          plainText: "cc the team",
          createdAt: new Date("2026-06-17T10:00:00.000Z"),
          updatedAt: new Date("2026-06-17T10:05:00.000Z"),
        },
      ],
    };
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: {
          update: vi.fn().mockResolvedValue({ revision: 1 }),
          findFirst: vi.fn().mockResolvedValue(editableThread),
        },
        comment: {
          findUnique: commentFindUnique,
          update: vi.fn().mockResolvedValue({ id: "comment-1" }),
        },
        user: { findMany: userFindMany },
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
      update: { body: "cc the team again", mentions: ["user-2", "user-3"] },
    });

    expect(result.ok).toBe(true);
    expect(dispatchMentionNotifications).toHaveBeenCalledTimes(1);
    expect(dispatchMentionNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserIds: ["user-3"],
        actorUserId: "user-1",
        entityType: "session",
        entityTitle: "Fix the flaky login test",
        artifactId: "session-artifact-1",
        commentId: "comment-1",
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
      target: { type: CommentTargetType.Session, id: "desktop-session-1" },
      draft: { anchor, body: "Should not attach" },
    });

    expect(created).toBeNull();
    expect(sessionFindFirst).toHaveBeenCalledTimes(1);
    expect(sessionFindFirst.mock.calls[0][0].where).toMatchObject({
      externalSessionId: "desktop-session-1",
      artifact: { is: { createdById: "user-1" } },
    });
    expect(sessionFindMany).not.toHaveBeenCalled();
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("lists only native trace-comment threads for the resolved artifact", async () => {
    const commentThreadFindMany = vi.fn().mockResolvedValue([
      {
        id: "thread-1",
        artifactId: "session-artifact-1",
        status: ThreadStatus.Resolved,
        resolvedAt: new Date("2026-06-17T10:07:00.000Z"),
        resolvedById: "resolver-1",
        ...storedThreadColumns,
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
        resolvedAt: null,
        resolvedById: null,
        ...storedThreadColumns,
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
            {
              id: "resolver-1",
              firstName: "Resolve",
              lastName: "User",
              email: "resolver@example.com",
              avatarUrl: "https://example.com/resolver.png",
            },
          ]),
        },
      })
    );

    const comments = await traceCommentsService.list({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
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
      status: ThreadStatus.Resolved,
      resolvedAt: "2026-06-17T10:07:00.000Z",
      resolvedById: "resolver-1",
      resolvedByName: "Resolve User",
      resolvedByAvatarUrl: "https://example.com/resolver.png",
    });
    expect(commentThreadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          artifactId: "session-artifact-1",
          source: ThreadSource.Native,
          metadata: {
            path: ["surface"],
            equals: CommentSurface.SessionDetail,
          },
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
        commentThread: {
          findFirst: commentThreadFindFirst,
          update: vi.fn().mockResolvedValue({ revision: 1 }),
        },
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
        type: CommentTargetType.Session,
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

  it("dedups a retried reply by clientId without appending a duplicate or re-notifying (FEA-3598)", async () => {
    const createdAt = new Date("2026-06-17T10:00:00.000Z");
    const repliedAt = new Date("2026-06-17T10:05:00.000Z");
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ artifactId: "session-artifact-1" }),
        },
      })
    );

    const parentThread = {
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
    };
    // The reply already landed on the first (lost-response) attempt.
    const threadWithReply = {
      ...parentThread,
      updatedAt: repliedAt,
      comments: [
        ...parentThread.comments,
        {
          id: "reply-1",
          authorId: "user-1",
          plainText: "Reply from viewer",
          body: { mentions: ["user-2"] },
          editedAt: null,
          createdAt: repliedAt,
          updatedAt: repliedAt,
        },
      ],
    };
    const commentCreate = vi.fn();
    const commentFindUnique = vi
      .fn()
      .mockResolvedValue({ id: "reply-1", threadId: "thread-1" });
    const commentThreadFindFirst = vi
      .fn()
      .mockResolvedValueOnce(parentThread)
      .mockResolvedValueOnce(threadWithReply);
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: { findFirst: commentThreadFindFirst },
        comment: { create: commentCreate, findUnique: commentFindUnique },
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
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
      draft: { body: "Reply from viewer", clientId: "local-reply-1" },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { replies: [{ id: "reply-1" }] },
    });
    expect(commentFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { externalId: "local-reply-1" } })
    );
    expect(commentCreate).not.toHaveBeenCalled();
    expect(dispatchMentionNotifications).not.toHaveBeenCalled();
  });

  it("recovers a concurrent-retry reply P2002 by re-running the tx as a replay (FEA-3598)", async () => {
    const createdAt = new Date("2026-06-17T10:00:00.000Z");
    const repliedAt = new Date("2026-06-17T10:05:00.000Z");
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ artifactId: "session-artifact-1" }),
        },
      })
    );

    const parentThread = {
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
    };
    const threadWithReply = {
      ...parentThread,
      updatedAt: repliedAt,
      comments: [
        ...parentThread.comments,
        {
          id: "reply-1",
          authorId: "user-1",
          plainText: "Reply from viewer",
          body: { mentions: ["user-2"] },
          editedAt: null,
          createdAt: repliedAt,
          updatedAt: repliedAt,
        },
      ],
    };
    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    });
    const userFindMany = vi.fn().mockResolvedValue([
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
    ]);
    // First attempt loses the race: no existing reply, then create throws P2002.
    const firstCreate = vi.fn().mockRejectedValue(p2002);
    const firstFindUnique = vi.fn().mockResolvedValue(null);
    const firstFindFirst = vi.fn().mockResolvedValue(parentThread);
    // The single retry now sees the committed reply and treats it as a replay.
    const retryCreate = vi.fn();
    const retryFindUnique = vi
      .fn()
      .mockResolvedValue({ id: "reply-1", threadId: "thread-1" });
    const retryFindFirst = vi
      .fn()
      .mockResolvedValueOnce(parentThread)
      .mockResolvedValueOnce(threadWithReply);
    mockWithDb.tx
      .mockImplementationOnce((callback) =>
        callback({
          commentThread: { findFirst: firstFindFirst },
          comment: { create: firstCreate, findUnique: firstFindUnique },
          user: { findMany: userFindMany },
        })
      )
      .mockImplementationOnce((callback) =>
        callback({
          commentThread: { findFirst: retryFindFirst },
          comment: { create: retryCreate, findUnique: retryFindUnique },
          user: { findMany: userFindMany },
        })
      );

    const result = await traceCommentsService.reply({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
      draft: { body: "Reply from viewer", clientId: "local-reply-1" },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { replies: [{ id: "reply-1" }] },
    });
    expect(firstCreate).toHaveBeenCalledTimes(1);
    expect(retryCreate).not.toHaveBeenCalled();
    expect(mockWithDb.tx).toHaveBeenCalledTimes(2);
    expect(dispatchMentionNotifications).not.toHaveBeenCalled();
  });

  it("stamps the client-supplied idempotency id on a newly-created reply's externalId (FEA-3598)", async () => {
    const createdAt = new Date("2026-06-17T10:00:00.000Z");
    const repliedAt = new Date("2026-06-17T10:05:00.000Z");
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ artifactId: "session-artifact-1" }),
        },
      })
    );

    const parentThread = {
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
    const commentFindUnique = vi.fn().mockResolvedValue(null);
    const commentThreadFindFirst = vi
      .fn()
      .mockResolvedValueOnce(parentThread)
      .mockResolvedValueOnce(updatedThread);
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: {
          findFirst: commentThreadFindFirst,
          update: vi.fn().mockResolvedValue({ revision: 1 }),
        },
        comment: { create: commentCreate, findUnique: commentFindUnique },
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
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
      draft: { body: "Reply from viewer", clientId: "local-reply-1" },
    });

    expect(result).toMatchObject({ ok: true });
    expect(commentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ externalId: "local-reply-1" }),
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
        comment: { create: commentCreate },
      })
    );

    const result = await traceCommentsService.reply({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "reply-1",
      draft: { body: "Nested reply should fail" },
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(commentCreate).not.toHaveBeenCalled();
  });
});
