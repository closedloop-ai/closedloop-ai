import {
  ThreadStatus,
  TraceCommentSurface,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ArtifactType: { SESSION: "SESSION", BRANCH: "BRANCH" },
    Prisma: { JsonNull: null },
  });
});

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findOwnedById: vi.fn() },
}));

vi.mock("@/lib/mention-notifications", () => ({
  dispatchMentionNotifications: vi.fn(),
}));

import { getMockWithDb, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import {
  TRACE_COMMENT_TARGET_THREAD_LIMIT,
  traceCommentsService,
} from "./service";

const mockWithDb = getMockWithDb();
const branchFindFirst = vi.fn();
const commentThreadFindMany = vi.fn();
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
      traceCommentRowForSurface(TraceCommentSurface.BranchDetail),
      traceCommentRowForSurface(TraceCommentSurface.BranchTimeline),
    ]);
    mockWithDb.mockImplementation((callback) =>
      callback({
        branchDetail: { findFirst: branchFindFirst },
        commentThread: {
          findMany: commentThreadFindMany,
        },
        user: { findMany: vi.fn().mockResolvedValue([]) },
      })
    );
  });

  it("separates detail and timeline collections with detail as default", async () => {
    const target = {
      type: TraceCommentTargetType.Branch,
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
      surface: TraceCommentSurface.BranchTimeline,
    });

    expect(detail?.map(({ surface }) => surface)).toEqual([
      TraceCommentSurface.BranchDetail,
    ]);
    expect(timeline?.map(({ surface }) => surface)).toEqual([
      TraceCommentSurface.BranchTimeline,
    ]);
    expect(commentThreadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: TRACE_COMMENT_TARGET_THREAD_LIMIT,
        where: expect.objectContaining({
          metadata: {
            path: ["surface"],
            equals: TraceCommentSurface.BranchTimeline,
          },
        }),
      })
    );
  });

  it("rejects reply, update, and delete when persisted metadata is on another surface", async () => {
    const wrongSurfaceThread = traceCommentRowForSurface(
      TraceCommentSurface.BranchDetail
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
        type: TraceCommentTargetType.Branch,
        id: "branch-artifact-1",
      },
      surface: TraceCommentSurface.BranchTimeline,
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

function traceCommentRowForSurface(surface: TraceCommentSurface) {
  return {
    id: `thread-${surface}`,
    artifactId: "branch-artifact-1",
    status: ThreadStatus.Open,
    resolvedAt: null,
    resolvedById: null,
    metadata: {
      kind: "trace_comment",
      schemaVersion: 1,
      targetType: TraceCommentTargetType.Branch,
      surface,
      anchor,
    },
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
