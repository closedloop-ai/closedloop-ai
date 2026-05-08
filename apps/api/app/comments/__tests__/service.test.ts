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
  return { withDb: withDbFn };
});

import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
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
    organizationId: string;
    artifactId: string | null;
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
        author: { id: "u-1" },
      },
    ],
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
      include: { comments: { where: { deletedAt: unknown } } };
    };
    expect(callArgs.include.comments.where.deletedAt).toBeNull();
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
});
