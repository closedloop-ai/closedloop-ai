/**
 * Unit tests for commentsService.findThreadsByDocument.
 *
 * All database calls are mocked via vi.mock("@repo/database").
 * Tests verify:
 *   - findThreadsByDocument returns threads scoped to artifact and organization
 *   - findThreadsByDocument excludes soft-deleted comments via query argument
 *   - findThreadsByDocument returns empty array for a different organization
 */
import { describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => {
  const withDbFn = vi.fn();
  return { Prisma: { JsonNull: null }, withDb: withDbFn };
});

import { GitHubCommentThreadKind } from "@repo/api/src/types/branch-view";
import {
  ThreadSource,
  ThreadStatus,
  TRACE_COMMENT_METADATA_KIND,
} from "@repo/api/src/types/comment";
import { withDb } from "@repo/database";
import { commentsService } from "../service";

const mockWithDb = withDb as unknown as Mock;

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
        author: { id: "u-1" },
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

    mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ commentThread: { findMany: mockFindMany } })
    );

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
          author: { id: "u-1" },
        },
      ],
    });

    const mockFindMany = vi.fn().mockResolvedValue([thread]);

    mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ commentThread: { findMany: mockFindMany } })
    );

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

    mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ commentThread: { findMany: mockFindMany } })
    );

    const result = await commentsService.findThreadsByDocument(
      "org-1",
      "art-1"
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("thread-document");
  });

  it("does not return threads from a different organization", async () => {
    const mockFindMany = vi.fn().mockResolvedValue([]);

    mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ commentThread: { findMany: mockFindMany } })
    );

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

    mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ commentThread: { findMany: mockFindMany } })
    );

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
});
