import {
  ThreadStatus,
  type TraceComment,
  TraceCommentKind,
  TraceCommentSurface,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../types/desktop-api";
import { createDesktopTraceCommentsDataSource } from "../desktop-trace-comments-data-source";

const target = { type: TraceCommentTargetType.Branch, id: "branch-1" };
const timelineQuery = { surface: TraceCommentSurface.BranchTimeline } as const;
const UNSAFE_WRITE_ERROR = /cannot safely write/i;

describe("Desktop trace-comment surface version skew", () => {
  it("suppresses an old main list response from the default Branch surface", async () => {
    const traceCommentsApi = traceCommentsApiMock({
      list: vi
        .fn()
        .mockResolvedValue([comment(TraceCommentSurface.BranchDetail)]),
    });
    const dataSource = createDesktopTraceCommentsDataSource({
      traceCommentsApi,
    });

    expect(dataSource.capabilities).toBeUndefined();
    await expect(dataSource.list(target, timelineQuery)).resolves.toEqual([]);
  });

  it("fails closed before a timeline create reaches an old main", async () => {
    const traceCommentsApi = traceCommentsApiMock();
    const dataSource = createDesktopTraceCommentsDataSource({
      traceCommentsApi,
    });

    expect(dataSource.capabilities).toBeUndefined();
    await expect(
      dataSource.create(
        target,
        {
          anchor: comment(TraceCommentSurface.BranchTimeline).anchor,
          body: "Note",
        },
        timelineQuery
      )
    ).rejects.toThrow(UNSAFE_WRITE_ERROR);
    expect(traceCommentsApi.create).not.toHaveBeenCalled();
  });

  it("allows timeline writes only when main advertises surface support", async () => {
    const timelineComment = comment(TraceCommentSurface.BranchTimeline);
    const traceCommentsApi = traceCommentsApiMock({
      supportsBranchTraceCommentSurfaces: true,
      create: vi.fn().mockResolvedValue(timelineComment),
    });
    const dataSource = createDesktopTraceCommentsDataSource({
      traceCommentsApi,
    });

    expect(dataSource.capabilities).toEqual({ branchTimelineWrites: true });
    await expect(
      dataSource.create(
        target,
        { anchor: timelineComment.anchor, body: "Note" },
        timelineQuery
      )
    ).resolves.toEqual(timelineComment);
  });
});

function traceCommentsApiMock(
  overrides: Partial<DesktopApi["traceCommentsApi"]> = {}
): DesktopApi["traceCommentsApi"] {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    reply: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

function comment(surface: TraceCommentSurface): TraceComment {
  const createdAt = "2026-08-07T12:00:00.000Z";
  return {
    id: "comment-1",
    threadId: "thread-1",
    target,
    artifactId: target.id,
    surface,
    status: ThreadStatus.Open,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    resolvedByAvatarUrl: null,
    kind: TraceCommentKind.Comment,
    anchor: {
      traceId: "trace-1",
      turnId: "turn-1",
      row: 1,
      selectedText: "selected",
      sourceText: "selected text",
      startOffset: 0,
      endOffset: 8,
    },
    body: "Timeline comment",
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    authorId: "user-1",
    authorName: "User",
    authorAvatarUrl: null,
    canEdit: true,
    canDelete: true,
    replies: [],
  };
}
