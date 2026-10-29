/**
 * ISS-11212 (PLN-2121 Step 6, production wiring): every legacy trace-comment
 * method is an adapter that calls one comment-service command or read with the
 * legacy request mapped onto an artifact target, and maps the command's code
 * back to the answer the legacy route gives.
 */
import {
  CommentSurface,
  CommentTargetType,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  commentsService: {
    createThread: vi.fn(),
    reply: vi.fn(),
    editComment: vi.fn(),
    deleteComment: vi.fn(),
    markSyncAbandoned: vi.fn(),
    retrySync: vi.fn(),
    listAllTraceComments: vi.fn(),
  },
  resolveTraceCommentTarget: vi.fn(),
}));

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@/app/comments/service", () => ({
  commentsService: mocks.commentsService,
}));

vi.mock(
  "@/app/comments/service/trace-comment-target-lookup",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/comments/service/trace-comment-target-lookup")
    >()),
    resolveTraceCommentTarget: mocks.resolveTraceCommentTarget,
  })
);

import { CommentArtifactType } from "@/app/comments/service/comment-target";
import { traceCommentsService } from "./service";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ARTIFACT_ID = "branch-artifact-1";
const COMMENT_ID = "comment-1";
const branchTarget = {
  type: CommentTargetType.Branch,
  id: "repo::branch",
};
const record = {
  artifactId: ARTIFACT_ID,
  target: branchTarget,
  surface: CommentSurface.BranchTimeline,
};
const legacyInput = {
  organizationId: ORG_ID,
  userId: USER_ID,
  target: branchTarget,
  surface: CommentSurface.BranchTimeline,
};
const viewer = { organizationId: ORG_ID, userId: USER_ID };
const commentTarget = {
  organizationId: ORG_ID,
  artifactId: ARTIFACT_ID,
  artifactType: CommentArtifactType.Branch,
  surface: CommentSurface.BranchTimeline,
};
const anchor = {
  traceId: "trace-1",
  turnId: "turn-1",
  row: 0,
  selectedText: "quote",
  sourceText: "a quote",
  startOffset: 2,
  endOffset: 7,
};
const mapped = { id: COMMENT_ID };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTraceCommentTarget.mockResolvedValue(record);
});

describe("traceCommentsService adapter wiring", () => {
  it("creates through createThread with the draft mapped onto the artifact", async () => {
    mocks.commentsService.createThread.mockResolvedValue({
      ok: true,
      value: mapped,
    });

    const created = await traceCommentsService.create({
      ...legacyInput,
      draft: {
        anchor,
        body: "hello",
        mentions: ["user-2"],
        kind: TraceCommentKind.Comment,
        clientId: "client-1",
      },
    });

    expect(created).toBe(mapped);
    expect(mocks.commentsService.createThread).toHaveBeenCalledWith(
      {
        viewer,
        target: commentTarget,
        surface: CommentSurface.BranchTimeline,
        anchor: { ...anchor, kind: CommentAnchorKind.Trace },
        body: "hello",
        mentions: ["user-2"],
        kind: TraceCommentKind.Comment,
        clientId: "client-1",
        present: expect.any(Function),
      },
      undefined
    );
  });

  it("replies through reply, addressed by the root comment", async () => {
    mocks.commentsService.reply.mockResolvedValue({ ok: true, value: mapped });

    await traceCommentsService.reply({
      ...legacyInput,
      commentId: COMMENT_ID,
      draft: { body: "reply", clientId: "client-2" },
    });

    expect(mocks.commentsService.reply).toHaveBeenCalledWith(
      {
        viewer,
        target: commentTarget,
        thread: { rootCommentId: COMMENT_ID },
        body: "reply",
        mentions: undefined,
        clientId: "client-2",
        present: expect.any(Function),
      },
      undefined
    );
  });

  it("edits through editComment with no expected revision, last-writer-wins", async () => {
    mocks.commentsService.editComment.mockResolvedValue({
      ok: true,
      value: mapped,
    });

    await traceCommentsService.update({
      ...legacyInput,
      commentId: COMMENT_ID,
      update: { body: "edited", mentions: [] },
    });

    expect(mocks.commentsService.editComment).toHaveBeenCalledWith(
      {
        viewer,
        target: commentTarget,
        commentId: COMMENT_ID,
        body: "edited",
        mentions: [],
        present: expect.any(Function),
      },
      undefined
    );
  });

  it("deletes, marks and retries through their commands", async () => {
    mocks.commentsService.deleteComment.mockResolvedValue({
      ok: true,
      value: { deleted: true },
    });
    mocks.commentsService.markSyncAbandoned.mockResolvedValue({
      ok: true,
      value: [],
    });
    mocks.commentsService.retrySync.mockResolvedValue({ ok: true, value: [] });
    const input = { ...legacyInput, commentId: COMMENT_ID };

    await traceCommentsService.delete(input);
    await traceCommentsService.markSyncAbandoned(input);
    await traceCommentsService.retrySync(input);

    expect(mocks.commentsService.deleteComment).toHaveBeenCalledWith(
      {
        viewer,
        target: commentTarget,
        commentId: COMMENT_ID,
      },
      undefined
    );
    for (const command of [
      mocks.commentsService.markSyncAbandoned,
      mocks.commentsService.retrySync,
    ]) {
      expect(command).toHaveBeenCalledWith(
        {
          viewer,
          target: commentTarget,
          comment: { commentId: COMMENT_ID },
          present: expect.any(Function),
        },
        undefined
      );
    }
  });

  it("pages the org aggregate through the read module unchanged", async () => {
    const page = { items: [], total: 0, nextCursor: null };
    mocks.commentsService.listAllTraceComments.mockResolvedValue(page);
    const input = {
      organizationId: ORG_ID,
      userId: USER_ID,
      filters: { resolved: false, limit: 5, cursor: 10 },
    };

    await expect(traceCommentsService.listAll(input)).resolves.toBe(page);
    expect(mocks.commentsService.listAllTraceComments).toHaveBeenCalledWith(
      input
    );
  });

  it("maps each code to the legacy answer, and never calls a command for an unresolved target", async () => {
    mocks.commentsService.reply.mockResolvedValue({
      ok: false,
      error: CommentErrorCode.ClientIdConflict,
    });
    mocks.commentsService.editComment.mockResolvedValue({
      ok: false,
      error: CommentErrorCode.CapabilityDenied,
    });
    mocks.commentsService.createThread.mockResolvedValue({
      ok: false,
      error: CommentErrorCode.NotFound,
    });
    const input = { ...legacyInput, commentId: COMMENT_ID };

    await expect(
      traceCommentsService.reply({ ...input, draft: { body: "reply" } })
    ).resolves.toEqual({
      ok: false,
      reason: "conflict",
      code: CommentErrorCode.ClientIdConflict,
    });
    await expect(
      traceCommentsService.update({ ...input, update: { body: "edit" } })
    ).resolves.toEqual({ ok: false, reason: "forbidden" });
    await expect(
      traceCommentsService.create({
        ...legacyInput,
        draft: { anchor, body: "hello" },
      })
    ).resolves.toBeNull();

    mocks.resolveTraceCommentTarget.mockResolvedValue(null);
    await expect(traceCommentsService.delete(input)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(mocks.commentsService.deleteComment).not.toHaveBeenCalled();
  });
});
