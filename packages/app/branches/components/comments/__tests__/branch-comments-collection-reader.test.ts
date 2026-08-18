import {
  ThreadStatus,
  type TraceComment,
  TraceCommentKind,
  TraceCommentSurface,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
} from "@repo/app/shared/api/api-timeout";
import type { TraceCommentsDataSource } from "@repo/app/shared/trace-comments/trace-comments-data-source";
import { describe, expect, it, vi } from "vitest";
import {
  BRANCH_COMMENTS_READ_CONCURRENCY,
  readBranchCommentCollections,
} from "../branch-comments-collection-reader";

describe("readBranchCommentCollections", () => {
  it("bounds Session reads and retains successful peers when one target fails", async () => {
    let active = 0;
    let peak = 0;
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockImplementation(async (target) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        if (target.id === "session-3") {
          throw new Error("unavailable");
        }
        return [makeComment(target.id)];
      });
    const source = makeSource(list);
    const collections = Array.from({ length: 9 }, (_, index) => ({
      target: {
        id: `session-${index}`,
        type: TraceCommentTargetType.Session,
      },
    }));

    const results = await readBranchCommentCollections(source, collections);

    expect(peak).toBeLessThanOrEqual(BRANCH_COMMENTS_READ_CONCURRENCY);
    expect(results).toHaveLength(9);
    expect(results[3]?.error).toBeInstanceOf(Error);
    expect(
      results.flatMap((result) => result.read.comments).map((item) => item.id)
    ).toHaveLength(8);
  });

  it("launches no read when the caller has already aborted (ISS-5110)", async () => {
    const list = vi.fn<TraceCommentsDataSource["list"]>();
    const source = makeSource(list);
    const controller = new AbortController();
    controller.abort();

    await expect(
      readBranchCommentCollections(source, sessionCollections(9), {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(list).not.toHaveBeenCalled();
  });

  it("stops the fan-out at the collection where the caller aborted", async () => {
    const controller = new AbortController();
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockImplementation(() => {
        controller.abort();
        return Promise.resolve([]);
      });
    const source = makeSource(list);

    await expect(
      readBranchCommentCollections(source, sessionCollections(9), {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    // Only the read that aborted was issued: no chunk peer and no later chunk
    // got as far as the data source.
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("keeps a per-target deadline expiry local to that target", async () => {
    const timeout = new ApiError(
      API_TIMEOUT_ERROR_MESSAGE,
      API_NO_RESPONSE_STATUS,
      { code: API_TIMEOUT_ERROR_CODE }
    );
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockImplementation((target) => {
        if (target.id === "session-1") {
          return Promise.reject(timeout);
        }
        return Promise.resolve([makeComment(target.id)]);
      });
    const source = makeSource(list);

    const results = await readBranchCommentCollections(
      source,
      sessionCollections(3),
      { signal: new AbortController().signal }
    );

    expect(results[1]?.error).toBe(timeout);
    expect(results.filter((result) => result.error === null)).toHaveLength(2);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("reports mismatched rows without silently adding them", async () => {
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockResolvedValue([makeComment("session-other")]);
    const source = makeSource(list);

    const [result] = await readBranchCommentCollections(source, [
      {
        target: {
          id: "session-1",
          type: TraceCommentTargetType.Session,
        },
      },
    ]);

    expect(result?.read).toEqual({ comments: [], rejectedCount: 1 });
    expect(result?.error).toBeNull();
  });
});

function sessionCollections(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    target: {
      id: `session-${index}`,
      type: TraceCommentTargetType.Session,
    },
  }));
}

function makeSource(
  list: TraceCommentsDataSource["list"]
): TraceCommentsDataSource {
  return {
    scope: "test",
    list,
    create: vi.fn(),
    reply: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function makeComment(sessionId: string): TraceComment {
  const timestamp = "2026-08-07T12:00:00.000Z";
  return {
    anchor: {
      actor: null,
      endOffset: 4,
      row: 1,
      selectedText: "text",
      sourceText: "text",
      startOffset: 0,
      traceId: "trace-1",
      turnId: "turn-1",
    },
    artifactId: sessionId,
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "User",
    body: "Comment",
    canDelete: true,
    canEdit: true,
    createdAt: timestamp,
    editedAt: null,
    id: `comment-${sessionId}`,
    kind: TraceCommentKind.Comment,
    replies: [],
    resolvedAt: null,
    resolvedByAvatarUrl: null,
    resolvedById: null,
    resolvedByName: null,
    status: ThreadStatus.Open,
    surface: TraceCommentSurface.SessionDetail,
    target: { id: sessionId, type: TraceCommentTargetType.Session },
    threadId: `thread-${sessionId}`,
    updatedAt: timestamp,
  };
}
