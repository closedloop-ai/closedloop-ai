/**
 * ISS-11212 (PLN-2120 Step 3): trace anchors are written to and read from the
 * `CommentThread.anchor` column, and every native write stamps `bodyFormat`.
 */
import { CommentTargetType, ThreadStatus } from "@repo/api/src/types/comment";
import { CommentAnchorState } from "@repo/api/src/types/comment-anchor";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
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
    ArtifactType: { SESSION: "SESSION", BRANCH: "BRANCH" },
  });
});

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/app/comments/service/trace-comment-search-index", () => ({
  indexTraceCommentAfterCommit: vi.fn(),
  removeTraceCommentAfterCommit: vi.fn(),
}));

import { log } from "@repo/observability/log";
import {
  sessionTraceAnchor,
  storedSessionTraceAnchor,
  storedSessionTraceThreadColumns,
} from "@/__tests__/support/trace-comments/trace-comment-thread.test-fixtures";
import {
  COMMENTS_DATA_INVALID_EVENT,
  CommentDataInvalidReason,
} from "@/app/comments/comment-data-invalid";
import { resetReportedTraceAnchorFailures } from "@/app/comments/service/trace-comment-anchor-json";
import { mockWithDbAll } from "../../__tests__/utils/db-helpers";
import { traceCommentsService } from "./service";

const ARTIFACT_ID = "session-artifact-1";
const AUTHOR_ID = "user-1";
const createdAt = new Date("2026-09-29T10:00:00.000Z");

const target = { type: CommentTargetType.Session, id: ARTIFACT_ID };

function threadRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    organizationId: "org-1",
    artifactId: ARTIFACT_ID,
    status: ThreadStatus.Open,
    resolvedAt: null,
    resolvedById: null,
    ...storedSessionTraceThreadColumns,
    createdAt,
    updatedAt: createdAt,
    comments: [
      {
        id: `${id}-root`,
        authorId: AUTHOR_ID,
        plainText: "Root note",
        body: null,
        editedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    ...overrides,
  };
}

function mockDb(threads: ReturnType<typeof threadRow>[]) {
  const threadCreate = vi.fn().mockResolvedValue(threads[0]);
  const commentCreate = vi.fn().mockResolvedValue({ id: "reply-1" });
  const commentUpdate = vi.fn().mockResolvedValue({ id: "thread-1-root" });
  mockWithDbAll({
    sessionDetail: {
      findFirst: vi.fn().mockResolvedValue({ artifactId: ARTIFACT_ID }),
    },
    commentThread: {
      create: threadCreate,
      findFirst: vi.fn().mockResolvedValue(threads[0]),
      findMany: vi.fn().mockResolvedValue(threads),
      update: vi.fn().mockResolvedValue({ id: "thread-1" }),
    },
    comment: {
      create: commentCreate,
      findUnique: vi.fn().mockResolvedValue({ body: null }),
      update: commentUpdate,
    },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  });
  return { threadCreate, commentCreate, commentUpdate };
}

const input = { organizationId: "org-1", userId: AUTHOR_ID, target };

beforeEach(() => {
  vi.clearAllMocks();
  resetReportedTraceAnchorFailures();
});

describe("trace comment writes", () => {
  it("creates the thread with the anchor in its column and none in metadata", async () => {
    const { threadCreate } = mockDb([threadRow("thread-1")]);

    await traceCommentsService.create({
      ...input,
      draft: { anchor: sessionTraceAnchor, body: "Root note" },
    });

    const data = threadCreate.mock.calls[0]?.[0]?.data;
    expect(data.anchor).toEqual(storedSessionTraceAnchor);
    expect(data.anchorState).toBe(CommentAnchorState.Anchored);
    expect(data.metadata).not.toHaveProperty("anchor");
    expect(data.comments.create.bodyFormat).toBe(CommentBodyFormat.RichV1);
  });

  it("stamps bodyFormat on a reply and on an edit", async () => {
    const { commentCreate, commentUpdate } = mockDb([threadRow("thread-1")]);

    await traceCommentsService.reply({
      ...input,
      commentId: "thread-1-root",
      draft: { body: "A reply" },
    });
    await traceCommentsService.update({
      ...input,
      commentId: "thread-1-root",
      update: { body: "Edited" },
    });

    expect(commentCreate.mock.calls[0]?.[0]?.data?.bodyFormat).toBe(
      CommentBodyFormat.RichV1
    );
    expect(commentUpdate.mock.calls[0]?.[0]?.data?.bodyFormat).toBe(
      CommentBodyFormat.RichV1
    );
  });
});

describe("trace comment reads", () => {
  it("serves the column's anchor in the legacy shape and key order", async () => {
    mockDb([threadRow("thread-1")]);

    const comments = await traceCommentsService.list(input);

    // Byte-compatible with the anchor the legacy routes served from metadata.
    expect(JSON.stringify(comments?.[0]?.anchor)).toBe(
      JSON.stringify(sessionTraceAnchor)
    );
  });

  it("reports and omits a thread whose anchor is missing or unreadable", async () => {
    mockDb([
      threadRow("thread-missing", { anchor: null }),
      threadRow("thread-future", {
        anchor: { ...storedSessionTraceAnchor, v: 2 },
      }),
      threadRow("thread-corrupt", {
        anchor: { ...storedSessionTraceAnchor, endOffset: 1 },
      }),
      threadRow("thread-1"),
    ]);

    const comments = await traceCommentsService.list(input);

    expect(comments?.map((comment) => comment.threadId)).toEqual(["thread-1"]);
    for (const [threadId, reason] of [
      ["thread-missing", CommentDataInvalidReason.AnchorMissing],
      ["thread-future", CommentDataInvalidReason.AnchorUnparseable],
      ["thread-corrupt", CommentDataInvalidReason.AnchorUnparseable],
    ] as const) {
      expect(log.error).toHaveBeenCalledWith(COMMENTS_DATA_INVALID_EVENT, {
        event: COMMENTS_DATA_INVALID_EVENT,
        reason,
        organizationId: "org-1",
        threadId,
      });
    }
  });

  it("reports a bad thread once however often the list is polled", async () => {
    mockDb([threadRow("thread-missing", { anchor: null })]);

    await traceCommentsService.list(input);
    await traceCommentsService.list(input);

    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
