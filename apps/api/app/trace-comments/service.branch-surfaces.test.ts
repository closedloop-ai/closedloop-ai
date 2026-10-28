import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
} from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ArtifactType: { SESSION: "SESSION", BRANCH: "BRANCH" },
  });
});

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findOwnedById: vi.fn() },
}));

vi.mock("@/lib/mention-notifications", () => ({
  dispatchMentionNotifications: vi.fn(),
}));

import { TRACE_COMMENT_TARGET_THREAD_LIMIT } from "@/app/comments/service/trace-comment-thread-limit";
import { mockWithDbAll, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { traceCommentsService } from "./service";

const branchFindFirst = vi.fn();
const commentThreadFindMany = vi.fn();
const eligibilityQueryRaw = vi.fn();
const anchor = {
  traceId: "trace:branch-1:0",
  turnId: "turn:branch-1:0",
  row: 0,
  selectedText: "quote target",
  sourceText: "A trace quote target row",
  startOffset: 8,
  endOffset: 20,
  sessionId: "session-1",
  actor: { name: "codex", human: null },
};

describe("traceCommentsService Branch surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    branchFindFirst.mockResolvedValue({ artifactId: "branch-artifact-1" });
    commentThreadFindMany.mockResolvedValue([
      traceCommentRowForSurface(CommentSurface.BranchDetail),
      traceCommentRowForSurface(CommentSurface.BranchTimeline),
    ]);
    eligibilityQueryRaw.mockResolvedValue([{ id: "branch-artifact-1" }]);
    mockWithDbAll({
      $queryRaw: eligibilityQueryRaw,
      branchDetail: { findFirst: branchFindFirst },
      commentThread: {
        findMany: commentThreadFindMany,
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    });
  });

  it("returns null when Product eligibility is revoked after comment projection", async () => {
    eligibilityQueryRaw
      .mockResolvedValueOnce([{ id: "branch-artifact-1" }])
      .mockResolvedValueOnce([]);

    const comments = await traceCommentsService.list({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Branch,
        id: "branch-artifact-1",
      },
    });

    expect(comments).toBeNull();
    expect(commentThreadFindMany).toHaveBeenCalledOnce();
    expect(eligibilityQueryRaw).toHaveBeenCalledTimes(2);
  });

  it("applies a final Product gate to hydrated aggregate Branch rows", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: "thread-branch_detail", count: 1n }])
      .mockResolvedValueOnce([]);
    mockWithDbTx({
      $queryRaw: queryRaw,
      commentThread: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            traceCommentRowForSurface(CommentSurface.BranchDetail),
          ]),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const response = await traceCommentsService.listAll({
      organizationId: "org-1",
      userId: "user-1",
      filters: { targetType: CommentTargetType.Branch },
    });

    expect(response).toEqual({ items: [], total: 1, nextCursor: null });
  });

  it("separates detail and timeline collections with detail as default", async () => {
    const target = {
      type: CommentTargetType.Branch,
      id: "branch-artifact-1",
    } as const;
    const detail = await traceCommentsService.list({
      organizationId: "org-1",
      userId: "user-1",
      target,
    });
    const timeline = await traceCommentsService.list({
      organizationId: "org-1",
      userId: "user-1",
      target,
      surface: CommentSurface.BranchTimeline,
    });

    expect(detail?.map(({ surface }) => surface)).toEqual([
      CommentSurface.BranchDetail,
    ]);
    expect(timeline?.map(({ surface }) => surface)).toEqual([
      CommentSurface.BranchTimeline,
    ]);
    expect(commentThreadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: TRACE_COMMENT_TARGET_THREAD_LIMIT,
        where: expect.objectContaining({
          metadata: {
            path: ["surface"],
            equals: CommentSurface.BranchTimeline,
          },
        }),
      })
    );
  });

  it("rejects reply, update, and delete when persisted metadata is on another surface", async () => {
    const wrongSurfaceThread = traceCommentRowForSurface(
      CommentSurface.BranchDetail
    );
    const commentCreate = vi.fn();
    const commentUpdate = vi.fn();
    mockWithDbTx({
      commentThread: {
        findFirst: vi.fn().mockResolvedValue(wrongSurfaceThread),
      },
      comment: {
        create: commentCreate,
        update: commentUpdate,
      },
    });
    const common = {
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Branch,
        id: "branch-artifact-1",
      },
      surface: CommentSurface.BranchTimeline,
      commentId: "comment-branch_detail",
    } as const;

    const reply = await traceCommentsService.reply({
      ...common,
      draft: { body: "reply" },
    });
    const update = await traceCommentsService.update({
      ...common,
      update: { body: "edit" },
    });
    const deleted = await traceCommentsService.delete(common);

    expect([reply, update, deleted]).toEqual([
      { ok: false, reason: "not_found" },
      { ok: false, reason: "not_found" },
      { ok: false, reason: "not_found" },
    ]);
    expect(commentCreate).not.toHaveBeenCalled();
    expect(commentUpdate).not.toHaveBeenCalled();
  });
});

function traceCommentRowForSurface(surface: CommentSurface) {
  return {
    id: `thread-${surface}`,
    artifactId: "branch-artifact-1",
    status: ThreadStatus.Open,
    resolvedAt: null,
    resolvedById: null,
    metadata: {
      kind: "trace_comment",
      schemaVersion: 1,
      targetType: CommentTargetType.Branch,
      surface,
    },
    anchor: { v: 1, kind: "trace", ...anchor },
    syncStates: [],
    createdAt: new Date("2026-06-17T10:00:00.000Z"),
    updatedAt: new Date("2026-06-17T10:00:00.000Z"),
    comments: [
      {
        id: `comment-${surface}`,
        authorId: "user-1",
        plainText: surface,
        body: { type: "doc", content: [] },
        editedAt: null,
        createdAt: new Date("2026-06-17T10:00:00.000Z"),
        updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      },
    ],
  };
}
