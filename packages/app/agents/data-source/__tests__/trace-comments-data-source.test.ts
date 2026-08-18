import {
  ThreadStatus,
  type TraceComment,
  TraceCommentKind,
  TraceCommentSurface,
  type TraceCommentTarget,
  type TraceTextAnchor,
} from "@repo/api/src/types/comment";
import { describe, expect, it, vi } from "vitest";
import { createHttpTraceCommentsDataSource } from "../trace-comments-data-source";

const TARGET: TraceCommentTarget = { type: "session", id: "session-1" };

function makeAnchor(): TraceTextAnchor {
  return {
    actor: { human: null, name: "Codex" },
    endOffset: 15,
    row: 1,
    selectedText: "selected text",
    sessionId: "session-1",
    sourceText: "selected text in a trace row",
    startOffset: 0,
    traceId: "trace-1",
    turnId: "turn-1",
  };
}

function makeComment(overrides: Partial<TraceComment> = {}): TraceComment {
  const createdAt = "2026-06-26T12:00:00.000Z";
  return {
    anchor: makeAnchor(),
    artifactId: "session-artifact-1",
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "Test User",
    body: "A note",
    canDelete: true,
    canEdit: true,
    createdAt,
    editedAt: null,
    id: "comment-1",
    kind: TraceCommentKind.Comment,
    mentions: [],
    replies: [],
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    resolvedByAvatarUrl: null,
    status: ThreadStatus.Open,
    surface: TraceCommentSurface.SessionDetail,
    target: TARGET,
    threadId: "thread-1",
    updatedAt: createdAt,
    ...overrides,
  };
}

/**
 * Build a comment payload as a version-skewed OLDER server returns it: the
 * `kind` classification field (FEA-4171) is absent from the JSON entirely. The
 * transport boundary must default it to `Comment` so consumers are not typed
 * against a value the response did not carry.
 */
function makeLegacyPayloadWithoutKind(
  overrides: Partial<TraceComment> = {}
): TraceComment {
  const comment = makeComment(overrides);
  Reflect.deleteProperty(comment, "kind");
  return comment;
}

function stubClient(response: unknown) {
  return {
    get: <T>() => Promise.resolve(response as T),
    post: <T>() => Promise.resolve(response as T),
    patch: <T>() => Promise.resolve(response as T),
    delete: <T>() => Promise.resolve(response as T),
  };
}

describe("createHttpTraceCommentsDataSource kind normalization (FEA-4171)", () => {
  it("separates Branch detail and timeline collection paths while preserving Session paths", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const post = vi.fn().mockResolvedValue(makeComment());
    const source = createHttpTraceCommentsDataSource({
      get,
      post,
      patch: vi.fn(),
      delete: vi.fn(),
    });
    const branchTarget: TraceCommentTarget = { type: "branch", id: "branch-1" };

    await source.list(branchTarget);
    await source.list(branchTarget, {
      surface: TraceCommentSurface.BranchTimeline,
    });
    await source.create(
      branchTarget,
      { anchor: makeAnchor(), body: "Note" },
      {
        surface: TraceCommentSurface.BranchTimeline,
      }
    );
    await source.list(TARGET);

    expect(get).toHaveBeenNthCalledWith(
      1,
      "/branches/branch-1/trace-comments?surface=branch_detail",
      { cache: "no-store" }
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      "/branches/branch-1/trace-comments?surface=branch_timeline",
      { cache: "no-store" }
    );
    expect(post).toHaveBeenCalledWith(
      "/branches/branch-1/trace-comments?surface=branch_timeline",
      expect.objectContaining({ body: "Note" })
    );
    expect(get).toHaveBeenNthCalledWith(
      3,
      "/agent-sessions/session-1/trace-comments",
      { cache: "no-store" }
    );
  });

  it("defaults a missing kind to Comment on list", async () => {
    const source = createHttpTraceCommentsDataSource(
      stubClient([makeLegacyPayloadWithoutKind()])
    );

    const [listed] = await source.list(TARGET);

    expect(listed.kind).toBe(TraceCommentKind.Comment);
  });

  it("preserves an explicit parsing_bug kind on list", async () => {
    const source = createHttpTraceCommentsDataSource(
      stubClient([makeComment({ kind: TraceCommentKind.ParsingBug })])
    );

    const [listed] = await source.list(TARGET);

    expect(listed.kind).toBe(TraceCommentKind.ParsingBug);
  });

  it("defaults a missing kind to Comment on create", async () => {
    const source = createHttpTraceCommentsDataSource(
      stubClient(makeLegacyPayloadWithoutKind())
    );

    const created = await source.create(TARGET, {
      anchor: makeAnchor(),
      body: "A note",
    });

    expect(created.kind).toBe(TraceCommentKind.Comment);
  });

  it("defaults a missing kind to Comment on reply and update", async () => {
    const source = createHttpTraceCommentsDataSource(
      stubClient(makeLegacyPayloadWithoutKind())
    );

    const replied = await source.reply(TARGET, "comment-1", { body: "reply" });
    const updated = await source.update(TARGET, "comment-1", { body: "edit" });

    expect(replied.kind).toBe(TraceCommentKind.Comment);
    expect(updated.kind).toBe(TraceCommentKind.Comment);
  });
});
