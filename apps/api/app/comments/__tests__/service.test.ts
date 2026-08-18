/**
 * Unit tests for commentsService.findThreadsByDocument.
 *
 * All database calls are mocked via vi.mock("@repo/database").
 * Tests verify:
 *   - findThreadsByDocument returns threads scoped to artifact and organization
 *   - findThreadsByDocument excludes soft-deleted comments via query argument
 *   - findThreadsByDocument returns empty array for a different organization
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const {
  mockCreateArtifactLevelThread,
  mockCreateArtifactThread,
  mockDeleteArtifactThread,
} = vi.hoisted(() => ({
  mockCreateArtifactLevelThread: vi.fn(),
  mockCreateArtifactThread: vi.fn(),
  mockDeleteArtifactThread: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const withDbFn = vi.fn();
  return {
    Prisma: { JsonNull: null },
    withDb: Object.assign(withDbFn, { tx: vi.fn() }),
  };
});

vi.mock("@repo/collaboration/server/room-management", () => ({
  createArtifactLevelThread: mockCreateArtifactLevelThread,
  createArtifactThread: mockCreateArtifactThread,
  deleteArtifactThread: mockDeleteArtifactThread,
}));

import { GitHubCommentThreadKind } from "@repo/api/src/types/branch-view";
import {
  DocumentThreadAnchorStatus,
  ThreadSource,
  ThreadStatus,
  TRACE_COMMENT_METADATA_KIND,
} from "@repo/api/src/types/comment";
import { withDb } from "@repo/database";
import { commentsService } from "../service";

const mockWithDb = withDb as unknown as Mock;
const mockWithDbTx = (withDb as unknown as { tx: Mock }).tx;
let activeTransactionClient: unknown;

function mockFindThreadsDb(
  commentThreadFindMany: Mock,
  userFindMany: Mock = vi.fn().mockResolvedValue([makeUserFixture()])
) {
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({
      commentThread: { findMany: commentThreadFindMany },
      user: { findMany: userFindMany },
    })
  );
  return userFindMany;
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/**
 * Returns a raw Prisma CommentThread row (with `artifactId`, not `entityId`) —
 * the service's `toCommentThreadWithComments` mapper translates this to the
 * legacy `entityId`/`entityType` wire shape.
 */
function makeCommentThreadFixture(
  overrides: Partial<{
    id: string;
    organizationId: string;
    artifactId: string | null;
    metadata: unknown;
    status: ThreadStatus;
    comments: unknown[];
  }> = {}
) {
  return {
    id: "thread-1",
    organizationId: "org-1",
    source: ThreadSource.Liveblocks,
    externalId: "ext-1",
    roomId: "room-1",
    artifactId: "art-1",
    status: ThreadStatus.Open,
    metadata: null,
    resolvedAt: null,
    resolvedById: null,
    createdById: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    comments: [
      {
        id: "c-1",
        threadId: "thread-1",
        authorId: "u-1",
        body: {},
        plainText: "hello",
        externalId: null,
        editedAt: null,
        deletedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        reactions: [],
        attachments: [],
        author: makeUserFixture(),
      },
    ],
    githubProjection: {
      pullRequestDetailId: "pr-detail-1",
      threadKind: GitHubCommentThreadKind.ReviewThread,
      rootCommentId: "root-comment-1",
      reviewThreadId: "review-thread-1",
      deletedAt: new Date("2026-01-02T00:00:00.000Z"),
      lastSyncedAt: new Date("2026-01-03T00:00:00.000Z"),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// findThreadsByDocument
// ---------------------------------------------------------------------------

describe("commentsService.findThreadsByDocument", () => {
  it("returns threads scoped to artifact and organization", async () => {
    const thread = makeCommentThreadFixture({
      organizationId: "org-1",
      artifactId: "art-1",
      status: ThreadStatus.Open,
    });

    const mockFindMany = vi.fn().mockResolvedValue([thread]);

    mockFindThreadsDb(mockFindMany);

    const result = await commentsService.findThreadsByDocument(
      "org-1",
      "art-1"
    );

    expect(result).toHaveLength(1);
    expect(result[0].artifactId).toBe("art-1");

    const callArgs = mockFindMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(callArgs.where).toMatchObject({
      organizationId: "org-1",
      artifactId: "art-1",
    });
  });

  it("excludes soft-deleted comments", async () => {
    const thread = makeCommentThreadFixture({
      comments: [
        {
          id: "c-deleted",
          threadId: "thread-1",
          authorId: "u-1",
          body: {},
          plainText: "gone",
          externalId: null,
          editedAt: null,
          deletedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
          reactions: [],
          attachments: [],
          author: makeUserFixture(),
        },
      ],
    });

    const mockFindMany = vi.fn().mockResolvedValue([thread]);

    mockFindThreadsDb(mockFindMany);

    await commentsService.findThreadsByDocument("org-1", "art-1");

    const callArgs = mockFindMany.mock.calls[0][0] as {
      select: { comments: { where: { deletedAt: unknown } } };
    };
    expect(callArgs.select.comments.where.deletedAt).toBeNull();
  });

  it("excludes trace comment threads from generic document thread responses", async () => {
    const documentThread = makeCommentThreadFixture({ id: "thread-document" });
    const traceThread = makeCommentThreadFixture({
      id: "thread-trace",
      metadata: {
        kind: TRACE_COMMENT_METADATA_KIND,
        schemaVersion: 1,
      },
    });
    const mockFindMany = vi
      .fn()
      .mockResolvedValue([documentThread, traceThread]);

    mockFindThreadsDb(mockFindMany);

    const result = await commentsService.findThreadsByDocument(
      "org-1",
      "art-1"
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("thread-document");
  });

  it("hydrates resolvedBy from the resolver id on a resolved thread", async () => {
    const thread = makeCommentThreadFixture({
      status: ThreadStatus.Resolved,
    });
    // The resolver differs from the comment author so the test proves the
    // resolver id (not just comment authors) is fetched and mapped.
    (thread as { resolvedById: string | null }).resolvedById = "u-resolver";

    const mockFindMany = vi.fn().mockResolvedValue([thread]);
    const resolver = {
      id: "u-resolver",
      email: "marcus@example.com",
      firstName: "Marcus",
      lastName: "Lee",
      avatarUrl: null,
    };
    const userFindMany = vi
      .fn()
      .mockResolvedValue([makeUserFixture(), resolver]);
    mockFindThreadsDb(mockFindMany, userFindMany);

    const result = await commentsService.findThreadsByDocument(
      "org-1",
      "art-1"
    );

    // The resolver id is included in the org-scoped user lookup...
    const userWhere = userFindMany.mock.calls[0][0] as {
      where: { id: { in: string[] } };
    };
    expect(userWhere.where.id.in).toContain("u-resolver");
    // ...and hydrated onto the returned thread's resolvedBy.
    expect(result[0].resolvedById).toBe("u-resolver");
    expect(result[0].resolvedBy).toMatchObject({
      id: "u-resolver",
      firstName: "Marcus",
      lastName: "Lee",
    });
  });

  it("leaves resolvedBy null when the thread has no resolver", async () => {
    const thread = makeCommentThreadFixture({ status: ThreadStatus.Open });
    const mockFindMany = vi.fn().mockResolvedValue([thread]);
    mockFindThreadsDb(mockFindMany);

    const result = await commentsService.findThreadsByDocument(
      "org-1",
      "art-1"
    );

    expect(result[0].resolvedById).toBeNull();
    expect(result[0].resolvedBy).toBeNull();
  });

  it("does not return threads from a different organization", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([]);

    mockFindThreadsDb(mockFindMany);

    const result = await commentsService.findThreadsByDocument(
      "different-org",
      "art-1"
    );

    expect(result).toEqual([]);

    const callArgs = mockFindMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(callArgs.where).toMatchObject({
      organizationId: "different-org",
      artifactId: "art-1",
    });
  });

  it("filters threads by source and status when requested", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([]);

    mockFindThreadsDb(mockFindMany);

    await commentsService.findThreadsByDocument("org-1", "art-1", {
      source: ThreadSource.Native,
      status: ThreadStatus.Open,
    });

    const callArgs = mockFindMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(callArgs.where).toMatchObject({
      organizationId: "org-1",
      artifactId: "art-1",
      source: ThreadSource.Native,
      status: ThreadStatus.Open,
    });
  });

  it("excludes GitHub-only projection fields from document thread responses", async () => {
    const thread = makeCommentThreadFixture({
      comments: [
        {
          id: "c-1",
          threadId: "thread-1",
          authorId: "u-1",
          body: {},
          plainText: "hello",
          externalId: null,
          editedAt: null,
          deletedAt: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          author: makeUserFixture(),
          reactions: [],
          attachments: [],
          githubProjection: {
            githubCommentId: "github-comment-1",
            githubInReplyToCommentId: "github-parent-1",
            githubDeletedAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        },
      ],
    });

    const mockFindMany = vi.fn().mockResolvedValue([thread]);

    mockFindThreadsDb(mockFindMany);

    const [result] = await commentsService.findThreadsByDocument(
      "org-1",
      "art-1"
    );

    expect(result).toEqual({
      id: "thread-1",
      organizationId: "org-1",
      source: ThreadSource.Liveblocks,
      externalId: "ext-1",
      roomId: "room-1",
      artifactId: "art-1",
      status: ThreadStatus.Open,
      metadata: null,
      resolvedAt: null,
      resolvedById: null,
      createdById: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      resolvedBy: null,
      createdBy: null,
      comments: [
        {
          id: "c-1",
          threadId: "thread-1",
          authorId: "u-1",
          body: {},
          plainText: "hello",
          externalId: null,
          editedAt: null,
          deletedAt: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          author: makeUserFixture(),
          reactions: [],
          attachments: [],
        },
      ],
    });
    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain("githubProjection");
    expect(serializedResult).not.toContain("pullRequestDetailId");
    expect(serializedResult).not.toContain("threadKind");
    expect(serializedResult).not.toContain("rootCommentId");
    expect(serializedResult).not.toContain("reviewThreadId");
    expect(serializedResult).not.toContain("githubCommentId");
    expect(serializedResult).not.toContain("githubInReplyToCommentId");
    expect(serializedResult).not.toContain("githubDeletedAt");

    const callArgs = mockFindMany.mock.calls[0][0] as {
      select: Record<string, unknown> & {
        comments: { select: Record<string, unknown> };
      };
    };
    expect(callArgs.select).not.toHaveProperty("githubProjection");
    expect(callArgs.select.comments.select).not.toHaveProperty(
      "githubProjection"
    );
  });

  it("selects and returns comment authors for document thread responses", async () => {
    const thread = makeCommentThreadFixture({
      comments: [
        {
          id: "c-1",
          threadId: "thread-1",
          authorId: "u-1",
          body: {},
          plainText: "hello",
          externalId: null,
          editedAt: null,
          deletedAt: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          author: makeUserFixture(),
          reactions: [],
          attachments: [],
        },
      ],
    });
    const mockFindMany = vi.fn().mockResolvedValue([thread]);
    const userFindMany = vi.fn().mockResolvedValue([makeUserFixture()]);

    mockFindThreadsDb(mockFindMany, userFindMany);

    const [result] = await commentsService.findThreadsByDocument(
      "org-1",
      "art-1"
    );

    expect(result.comments[0].author).toEqual(makeUserFixture());

    expect(userFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        id: { in: ["u-1"] },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
      },
    });
    const callArgs = mockFindMany.mock.calls[0][0] as {
      select: { comments: { select: Record<string, unknown> } };
    };
    expect(callArgs.select.comments.select).not.toHaveProperty("author");
  });
});

describe("commentsService.createArtifactLevelDocumentThread", () => {
  beforeEach(() => {
    mockWithDb.mockReset();
    mockWithDbTx.mockReset();
    mockCreateArtifactLevelThread.mockReset();
    mockCreateArtifactThread.mockReset();
    mockDeleteArtifactThread.mockReset();
    mockDeleteArtifactThread.mockResolvedValue(undefined);
    activeTransactionClient = undefined;
  });

  it("creates a Liveblocks artifact-level thread and immediately syncs the DB projection", async () => {
    const liveblocksThread = makeArtifactLevelLiveblocksThread();
    const db = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "artifact-uuid",
          document: { latestVersion: 7 },
        }),
      },
      commentThread: {
        findUnique: vi.fn().mockResolvedValue({ id: "local-thread" }),
        upsert: vi.fn().mockResolvedValue({ id: "local-thread" }),
      },
    };
    const tx = {
      comment: {
        upsert: vi.fn().mockResolvedValue({ id: "local-comment" }),
      },
      commentAttachment: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      commentReaction: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
    };

    mockWithDb.mockImplementation((fn: (database: unknown) => unknown) =>
      fn(db)
    );
    mockWithDbTx.mockImplementation((fn: (database: unknown) => unknown) =>
      fn(tx)
    );
    mockCreateArtifactLevelThread.mockResolvedValue(liveblocksThread);

    const result = await commentsService.createArtifactLevelDocumentThread(
      "org-1",
      "PRD-7",
      "user-1",
      "Hello from MCP"
    );

    expect(mockCreateArtifactLevelThread).toHaveBeenCalledWith({
      roomId: "org-1:artifact:PRD-7",
      userId: "user-1",
      bodyText: "Hello from MCP",
      version: 7,
    });
    expect(mockCreateArtifactThread).not.toHaveBeenCalled();
    expect(mockDeleteArtifactThread).not.toHaveBeenCalled();
    expect(db.commentThread.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          artifactId: "artifact-uuid",
          createdAtVersion: 7,
          externalId: "lb-thread-1",
          metadata: {
            resolved: false,
            anchorStatus: DocumentThreadAnchorStatus.ArtifactLevel,
            version: 7,
          },
          roomId: "org-1:artifact:PRD-7",
          source: ThreadSource.Liveblocks,
          status: ThreadStatus.Open,
        }),
      })
    );
    expect(tx.comment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          authorId: "user-1",
          externalId: "lb-comment-1",
          plainText: "Hello from MCP",
          threadId: "local-thread",
        }),
      })
    );
    expect(result).toEqual({
      threadId: "lb-thread-1",
      commentId: "lb-comment-1",
    });
  });

  it("rejects when the required DB projection sync fails after Liveblocks creation", async () => {
    const liveblocksThread = makeArtifactLevelLiveblocksThread();
    const db = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "artifact-uuid",
          document: { latestVersion: 7 },
        }),
      },
      commentThread: {
        upsert: vi.fn().mockRejectedValue(new Error("projection failed")),
      },
    };
    const tx = {
      comment: {
        upsert: vi.fn(),
      },
      commentAttachment: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      commentReaction: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
    };

    mockWithDb.mockImplementation((fn: (database: unknown) => unknown) =>
      fn(db)
    );
    mockWithDbTx.mockImplementation((fn: (database: unknown) => unknown) =>
      fn(tx)
    );
    mockCreateArtifactLevelThread.mockResolvedValue(liveblocksThread);

    await expect(
      commentsService.createArtifactLevelDocumentThread(
        "org-1",
        "PRD-7",
        "user-1",
        "Hello from MCP"
      )
    ).rejects.toThrow("projection failed");

    expect(mockCreateArtifactLevelThread).toHaveBeenCalledWith({
      roomId: "org-1:artifact:PRD-7",
      userId: "user-1",
      bodyText: "Hello from MCP",
      version: 7,
    });
    expect(mockDeleteArtifactThread).toHaveBeenCalledWith({
      roomId: "org-1:artifact:PRD-7",
      threadId: "lb-thread-1",
    });
    expect(tx.comment.upsert).not.toHaveBeenCalled();
  });

  it("deletes the Liveblocks thread when comment projection sync fails", async () => {
    const liveblocksThread = makeArtifactLevelLiveblocksThread();
    const db = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "artifact-uuid",
          document: { latestVersion: 7 },
        }),
      },
      commentThread: {
        findUnique: vi
          .fn()
          .mockRejectedValue(new Error("thread lookup escaped transaction")),
        upsert: vi
          .fn()
          .mockRejectedValue(new Error("thread upsert escaped transaction")),
      },
    };
    const tx = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "artifact-uuid",
          document: { latestVersion: 7 },
        }),
      },
      commentThread: {
        findUnique: vi.fn().mockResolvedValue({ id: "local-thread" }),
        upsert: vi.fn().mockResolvedValue({ id: "local-thread" }),
      },
      comment: {
        upsert: vi.fn().mockRejectedValue(new Error("comment sync failed")),
      },
      commentAttachment: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      commentReaction: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
    };

    mockProjectionDatabase(db, tx);
    mockCreateArtifactLevelThread.mockResolvedValue(liveblocksThread);

    await expect(
      commentsService.createArtifactLevelDocumentThread(
        "org-1",
        "PRD-7",
        "user-1",
        "Hello from MCP"
      )
    ).rejects.toThrow("comment sync failed");

    expect(db.commentThread.upsert).not.toHaveBeenCalled();
    expect(tx.commentThread.upsert).toHaveBeenCalled();
    expect(mockDeleteArtifactThread).toHaveBeenCalledWith({
      roomId: "org-1:artifact:PRD-7",
      threadId: "lb-thread-1",
    });
  });

  it("deletes the Liveblocks thread when the created thread has no first comment", async () => {
    const liveblocksThread = {
      ...makeArtifactLevelLiveblocksThread(),
      comments: [],
    };
    const db = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "artifact-uuid",
          document: { latestVersion: 7 },
        }),
      },
      commentThread: {
        upsert: vi.fn(),
      },
    };
    const tx = {
      comment: {
        upsert: vi.fn(),
      },
      commentAttachment: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      commentReaction: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
    };

    mockWithDb.mockImplementation((fn: (database: unknown) => unknown) =>
      fn(db)
    );
    mockWithDbTx.mockImplementation((fn: (database: unknown) => unknown) =>
      fn(tx)
    );
    mockCreateArtifactLevelThread.mockResolvedValue(liveblocksThread);

    await expect(
      commentsService.createArtifactLevelDocumentThread(
        "org-1",
        "PRD-7",
        "user-1",
        "Hello from MCP"
      )
    ).rejects.toThrow("Thread created but returned no comment");

    expect(db.commentThread.upsert).not.toHaveBeenCalled();
    expect(tx.comment.upsert).not.toHaveBeenCalled();
    expect(mockDeleteArtifactThread).toHaveBeenCalledWith({
      roomId: "org-1:artifact:PRD-7",
      threadId: "lb-thread-1",
    });
  });

  it("preserves the projection failure when compensating Liveblocks cleanup fails", async () => {
    const liveblocksThread = makeArtifactLevelLiveblocksThread();
    const db = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "artifact-uuid",
          document: { latestVersion: 7 },
        }),
      },
      commentThread: {
        upsert: vi.fn().mockRejectedValue(new Error("projection failed")),
      },
    };
    const tx = {
      comment: {
        upsert: vi.fn(),
      },
      commentAttachment: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      commentReaction: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
    };

    mockWithDb.mockImplementation((fn: (database: unknown) => unknown) =>
      fn(db)
    );
    mockWithDbTx.mockImplementation((fn: (database: unknown) => unknown) =>
      fn(tx)
    );
    mockCreateArtifactLevelThread.mockResolvedValue(liveblocksThread);
    mockDeleteArtifactThread.mockRejectedValue(new Error("cleanup failed"));

    await expect(
      commentsService.createArtifactLevelDocumentThread(
        "org-1",
        "PRD-7",
        "user-1",
        "Hello from MCP"
      )
    ).rejects.toThrow("projection failed");

    expect(mockDeleteArtifactThread).toHaveBeenCalledWith({
      roomId: "org-1:artifact:PRD-7",
      threadId: "lb-thread-1",
    });
    expect(tx.comment.upsert).not.toHaveBeenCalled();
  });
});

function makeArtifactLevelLiveblocksThread() {
  const createdAt = new Date("2026-07-22T20:00:00.000Z");
  return {
    type: "thread",
    id: "lb-thread-1",
    roomId: "org-1:artifact:PRD-7",
    resolved: false,
    createdAt,
    updatedAt: createdAt,
    comments: [
      {
        id: "lb-comment-1",
        userId: "user-1",
        body: {
          version: 1,
          content: [
            {
              type: "paragraph",
              children: [{ text: "Hello from MCP" }],
            },
          ],
        },
        attachments: [],
        reactions: [],
        createdAt,
        editedAt: null,
        deletedAt: null,
      },
    ],
    metadata: {
      resolved: false,
      anchorStatus: DocumentThreadAnchorStatus.ArtifactLevel,
      version: 7,
    },
  };
}

function makeUserFixture() {
  return {
    id: "u-1",
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    avatarUrl: null,
  };
}

function mockProjectionDatabase(database: unknown, transactionClient: unknown) {
  mockWithDb.mockImplementation((fn: (database: unknown) => unknown) =>
    fn(activeTransactionClient ?? database)
  );
  mockWithDbTx.mockImplementation(
    async (fn: (database: unknown) => unknown) => {
      if (activeTransactionClient !== undefined) {
        return fn(activeTransactionClient);
      }

      activeTransactionClient = transactionClient;
      try {
        return await fn(transactionClient);
      } finally {
        activeTransactionClient = undefined;
      }
    }
  );
}
