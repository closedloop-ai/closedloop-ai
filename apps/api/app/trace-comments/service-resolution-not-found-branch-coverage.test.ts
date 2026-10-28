import { CommentTargetType, ThreadStatus } from "@repo/api/src/types/comment";
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

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findOwnedById: vi.fn(),
  },
}));

vi.mock("@/lib/mention-notifications", () => ({
  dispatchMentionNotifications: vi.fn(),
}));

import { computeTargetsService } from "@/app/compute-targets/service";
import { mockWithDbAll } from "../../__tests__/utils/db-helpers";
import { traceCommentsService } from "./service";

const anchor = {
  traceId: "trace:session-1:0",
  turnId: "turn:session-1:0",
  row: 0,
  selectedText: "quote target",
  sourceText: "A trace quote target row",
  startOffset: 8,
  endOffset: 20,
  sessionId: "session-1",
  actor: { name: "codex", human: null },
};

const storedAnchor = { v: 1, kind: "trace", ...anchor };

const metadata = {
  kind: "trace_comment",
  schemaVersion: 1,
  targetType: CommentTargetType.Session,
  surface: "session_detail",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("traceCommentsService — target resolution exhausts every fallback", () => {
  it("returns null from list() when the compute-target-scoped and user-scoped session lookups both miss", async () => {
    const sessionFindFirst = vi.fn().mockResolvedValue(null);
    mockWithDbAll({
      sessionDetail: { findFirst: sessionFindFirst },
    });
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue({
      id: "compute-target-1",
    } as Awaited<ReturnType<typeof computeTargetsService.findOwnedById>>);

    const comments = await traceCommentsService.list({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "desktop-session-1",
      },
      computeTargetId: "compute-target-1",
    });

    expect(comments).toBeNull();
    // Two lookups in order: the compute-target-scoped external id, then the
    // user-scoped fallback. A non-UUID id never probes the `@db.Uuid` artifact
    // id (ISS-11190).
    expect(sessionFindFirst).toHaveBeenCalledTimes(2);
  });

  it("returns not_found from reply() when the target cannot be resolved at all", async () => {
    mockWithDbAll({
      sessionDetail: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    const result = await traceCommentsService.reply({
      organizationId: "org-1",
      userId: "user-1",
      target: { type: CommentTargetType.Session, id: "session-1" },
      commentId: "comment-1",
      draft: { body: "reply body" },
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found from update() when the target cannot be resolved at all", async () => {
    mockWithDbAll({
      sessionDetail: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    const result = await traceCommentsService.update({
      organizationId: "org-1",
      userId: "user-1",
      target: { type: CommentTargetType.Session, id: "session-1" },
      commentId: "comment-1",
      update: { body: "updated body" },
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found from delete() when the target cannot be resolved at all", async () => {
    mockWithDbAll({
      sessionDetail: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    const result = await traceCommentsService.delete({
      organizationId: "org-1",
      userId: "user-1",
      target: { type: CommentTargetType.Session, id: "session-1" },
      commentId: "comment-1",
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns null from list() for a Branch target when the artifact cannot be resolved, without checking cloud eligibility", async () => {
    const eligibilityQueryRaw = vi.fn();
    const branchFindFirst = vi.fn().mockResolvedValue(null);
    mockWithDbAll({
      $queryRaw: eligibilityQueryRaw,
      branchDetail: { findFirst: branchFindFirst },
    });

    const comments = await traceCommentsService.list({
      organizationId: "org-1",
      userId: "user-1",
      target: { type: CommentTargetType.Branch, id: "branch-1" },
    });

    expect(comments).toBeNull();
    expect(eligibilityQueryRaw).not.toHaveBeenCalled();
  });

  it("returns null from create() for a Branch target with no explicit surface when the artifact cannot be resolved", async () => {
    mockWithDbAll({
      branchDetail: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    const comment = await traceCommentsService.create({
      organizationId: "org-1",
      userId: "user-1",
      target: { type: CommentTargetType.Branch, id: "branch-1" },
      draft: { body: "new comment", anchor },
    });

    expect(comment).toBeNull();
  });
});

describe("traceCommentsService — post-mutation refetch failures", () => {
  const resolvedSession = {
    sessionDetail: {
      findFirst: vi.fn(async () => ({
        artifactId: "session-artifact-1",
      })),
    },
  };

  it("returns not_found from reply() when the thread cannot be refetched after the reply is written", async () => {
    const parentThread = {
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      metadata,
      anchor: storedAnchor,
      syncStates: [],
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      comments: [
        {
          id: "comment-1",
          authorId: "user-1",
          plainText: "root",
          editedAt: null,
          createdAt: new Date("2026-06-17T10:00:00.000Z"),
          updatedAt: new Date("2026-06-17T10:00:00.000Z"),
        },
      ],
    };
    const commentThreadFindFirst = vi
      .fn()
      .mockResolvedValueOnce(parentThread)
      .mockResolvedValueOnce(null);
    mockWithDbAll({
      ...resolvedSession,
      commentThread: {
        findFirst: commentThreadFindFirst,
        update: vi.fn().mockResolvedValue({ revision: 1 }),
      },
      comment: { create: vi.fn().mockResolvedValue({ id: "reply-1" }) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await traceCommentsService.reply({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
      draft: { body: "a reply" },
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(commentThreadFindFirst).toHaveBeenCalledTimes(2);
  });

  it("returns not_found from reply() when the refetched thread maps to no comment", async () => {
    const parentThread = {
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      metadata,
      anchor: storedAnchor,
      syncStates: [],
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      comments: [
        {
          id: "comment-1",
          authorId: "user-1",
          plainText: "root",
          editedAt: null,
          createdAt: new Date("2026-06-17T10:00:00.000Z"),
          updatedAt: new Date("2026-06-17T10:00:00.000Z"),
        },
      ],
    };
    const malformedUpdatedThread = { ...parentThread, comments: [] };
    const commentThreadFindFirst = vi
      .fn()
      .mockResolvedValueOnce(parentThread)
      .mockResolvedValueOnce(malformedUpdatedThread);
    mockWithDbAll({
      ...resolvedSession,
      commentThread: {
        findFirst: commentThreadFindFirst,
        update: vi.fn().mockResolvedValue({ revision: 1 }),
      },
      comment: { create: vi.fn().mockResolvedValue({ id: "reply-1" }) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await traceCommentsService.reply({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
      draft: { body: "a reply" },
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found from update() when the thread cannot be refetched after the edit is written", async () => {
    const editableThread = {
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      metadata,
      anchor: storedAnchor,
      syncStates: [],
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      comments: [
        {
          id: "comment-1",
          authorId: "user-1",
          plainText: "root",
          editedAt: null,
          createdAt: new Date("2026-06-17T10:00:00.000Z"),
          updatedAt: new Date("2026-06-17T10:00:00.000Z"),
        },
      ],
    };
    const commentThreadFindFirst = vi
      .fn()
      .mockResolvedValueOnce(editableThread)
      .mockResolvedValueOnce(null);
    mockWithDbAll({
      ...resolvedSession,
      commentThread: {
        findFirst: commentThreadFindFirst,
        update: vi.fn().mockResolvedValue({ revision: 1 }),
      },
      comment: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({ id: "comment-1" }),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await traceCommentsService.update({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
      update: { body: "updated body" },
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found from update() when the refetched thread maps to no comment", async () => {
    const editableThread = {
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      metadata,
      anchor: storedAnchor,
      syncStates: [],
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      comments: [
        {
          id: "comment-1",
          authorId: "user-1",
          plainText: "root",
          editedAt: null,
          createdAt: new Date("2026-06-17T10:00:00.000Z"),
          updatedAt: new Date("2026-06-17T10:00:00.000Z"),
        },
      ],
    };
    const malformedThread = { ...editableThread, comments: [] };
    const commentThreadFindFirst = vi
      .fn()
      .mockResolvedValueOnce(editableThread)
      .mockResolvedValueOnce(malformedThread);
    mockWithDbAll({
      ...resolvedSession,
      commentThread: {
        findFirst: commentThreadFindFirst,
        update: vi.fn().mockResolvedValue({ revision: 1 }),
      },
      comment: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({ id: "comment-1" }),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await traceCommentsService.update({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
      update: { body: "updated body" },
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found from delete() when the editable thread's comment set does not contain the target comment", async () => {
    const threadMissingTargetComment = {
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      metadata,
      anchor: storedAnchor,
      syncStates: [],
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      comments: [
        {
          id: "some-other-comment",
          authorId: "user-1",
          plainText: "root",
          editedAt: null,
          createdAt: new Date("2026-06-17T10:00:00.000Z"),
          updatedAt: new Date("2026-06-17T10:00:00.000Z"),
        },
      ],
    };
    mockWithDbAll({
      ...resolvedSession,
      commentThread: {
        findFirst: vi.fn().mockResolvedValue(threadMissingTargetComment),
      },
    });

    const result = await traceCommentsService.delete({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-1",
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns null from create() when an idempotently-matched existing thread cannot be mapped back to a comment", async () => {
    const malformedExistingThread = {
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Open,
      metadata,
      anchor: storedAnchor,
      syncStates: [],
      createdAt: new Date("2026-06-17T10:00:00.000Z"),
      updatedAt: new Date("2026-06-17T10:00:00.000Z"),
      comments: [],
    };
    mockWithDbAll({
      ...resolvedSession,
      commentThread: {
        findUnique: vi.fn().mockResolvedValue(malformedExistingThread),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const comment = await traceCommentsService.create({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
      draft: {
        body: "new comment",
        anchor,
        clientId: "client-idempotency-1",
      },
    });

    expect(comment).toBeNull();
  });
});
