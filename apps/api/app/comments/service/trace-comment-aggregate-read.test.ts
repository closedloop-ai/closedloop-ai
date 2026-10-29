/**
 * FEA-3550: the org-scoped aggregate trace-comment read. ISS-11212 moved it
 * onto the comment service's read module, and these cases moved with it from
 * `apps/api/app/trace-comments/service.test.ts`.
 */
import {
  CommentTargetType,
  ThreadSource,
  ThreadStatus,
} from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

import {
  collectSqlValues,
  renderSql,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { storedSessionTraceThreadColumns as storedThreadColumns } from "@/__tests__/support/trace-comments/trace-comment-thread.test-fixtures";
import { mockWithDbTx } from "@/__tests__/utils/db-helpers";
import { listAllTraceComments } from "./trace-comment-aggregate-read";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listAllTraceComments", () => {
  it("aggregates unresolved trace comments org-scoped with a next cursor (FEA-3550)", async () => {
    const commentThreadFindMany = vi.fn().mockResolvedValue([
      {
        id: "thread-1",
        artifactId: "session-artifact-1",
        status: ThreadStatus.Open,
        ...storedThreadColumns,
        createdAt: new Date("2026-07-20T10:00:00.000Z"),
        updatedAt: new Date("2026-07-20T10:00:00.000Z"),
        comments: [
          {
            id: "comment-1",
            authorId: "user-1",
            plainText: "Open comment",
            createdAt: new Date("2026-07-20T10:00:00.000Z"),
            updatedAt: new Date("2026-07-20T10:00:00.000Z"),
          },
        ],
      },
    ]);
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: "thread-1", count: 4n }]);
    mockWithDbTx({
      $queryRaw: queryRaw,
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
    });

    const response = await listAllTraceComments({
      organizationId: "org-1",
      userId: "user-1",
      filters: { resolved: false },
    });

    expect(response.total).toBe(4);
    expect(response.nextCursor).toBe("1");
    expect(response.items[0]).toMatchObject({
      id: "comment-1",
      threadId: "thread-1",
      artifactId: "session-artifact-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      status: ThreadStatus.Open,
      authorName: "Test User",
    });

    expect(commentThreadFindMany).toHaveBeenCalledWith({
      select: expect.any(Object),
      where: {
        AND: [
          expect.objectContaining({
            organizationId: "org-1",
            source: ThreadSource.Native,
            status: ThreadStatus.Open,
          }),
          { id: { in: ["thread-1"] } },
        ],
      },
    });
    expect(renderSql(queryRaw.mock.calls[0]?.[0])).toContain(
      "FROM pull_request_detail published_pr"
    );
  });

  it("narrows by target type, author, session, and cursor offset (FEA-3550)", async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: null, count: 0n }]);
    mockWithDbTx({
      $queryRaw: queryRaw,
      commentThread: { findMany: vi.fn() },
      user: { findMany: vi.fn() },
    });

    await listAllTraceComments({
      organizationId: "org-1",
      userId: "user-1",
      filters: {
        resolved: true,
        targetType: CommentTargetType.Session,
        authorId: "author-9",
        sessionId: "session-artifact-9",
        limit: 10,
        cursor: 20,
      },
    });

    const candidateQuery = queryRaw.mock.calls[0]?.[0];
    const sql = renderSql(candidateQuery);
    const values = collectSqlValues(candidateQuery);
    expect(sql).toContain("thread.status");
    expect(sql).toContain("thread.metadata->>'targetType'");
    expect(sql).toContain("thread.created_by_id");
    expect(sql).toContain("thread.artifact_id");
    expect(values).toEqual(
      expect.arrayContaining([
        ThreadStatus.Resolved,
        CommentTargetType.Session,
        "author-9",
        "session-artifact-9",
        10,
        20,
      ])
    );
  });
});
