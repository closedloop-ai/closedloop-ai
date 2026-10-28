// @vitest-environment jsdom
import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
  type TraceComment,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import { createWrapper } from "@repo/app/shared/test-utils";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalBranchDetailResponseFixture } from "../../../test-fixtures/canonical-branch-projection";
import type { BranchCommentThread } from "../branch-comments-model";
import { BranchCommentsTab } from "../branch-comments-model";

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  comments: [] as BranchCommentThread[],
  onJump: undefined as
    | ((anchor: { trace: TraceComment["anchor"] }) => void)
    | undefined,
}));
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mocks.api,
}));
vi.mock("../branch-comments-workspace", () => ({
  BranchCommentsWorkspace: (props: {
    comments: BranchCommentThread[];
    onJump: typeof mocks.onJump;
  }) => {
    mocks.comments = props.comments;
    mocks.onJump = props.onJump;
    return null;
  },
}));

import { BranchCommentsController } from "../branch-comments-controller";

const branchId = "branch-1";
const sessionIds = [
  "session-1",
  "session-2",
  "session-3",
  "session-4",
  "session-5",
];
const comments = sessionIds.map(comment);

describe("ISS-12282 mounted controller and real HTTP source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.comments = [];
    mocks.api.get.mockResolvedValue(comments);
  });
  afterEach(cleanup);

  it("fetches once before trace load and retains that result as N sessions render", async () => {
    const onJump = vi.fn();
    const props = {
      activeTab: BranchCommentsTab.Sessions,
      detail: {
        ...canonicalBranchDetailResponseFixture,
        id: branchId,
        sessionIds,
      },
      onClose: vi.fn(),
      onJump,
      open: true,
      returnFocusRef: { current: null },
    };
    const view = render(
      <BranchCommentsController {...props} renderedSessionIds={[]} />,
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(mocks.comments).toHaveLength(sessionIds.length));
    view.rerender(
      <BranchCommentsController {...props} renderedSessionIds={sessionIds} />
    );
    await act(async () => Promise.resolve());
    expect(mocks.api.get).toHaveBeenCalledExactlyOnceWith(
      "/branches/branch-1/trace-comments?surface=branch_timeline&includeSessions=true",
      expect.objectContaining({ timeoutMs: 5000 })
    );
    expect(mocks.comments.map((thread) => thread.target.id)).toEqual(
      sessionIds
    );
    expect(mocks.comments.map((thread) => thread.anchor?.trace)).toEqual(
      comments.map((entry) => entry.anchor)
    );
    const selected = mocks.comments[4]?.anchor;
    expect(selected).toBeDefined();
    if (selected) {
      mocks.onJump?.(selected);
    }
    expect(onJump).toHaveBeenCalledWith(comments[4]?.anchor);
  });

  it.each(["detail", "trace"])(
    "refreshes comments when %s discovers a newly linked session after the batch resolves",
    async (source) => {
      mocks.api.get.mockResolvedValueOnce(comments.slice(0, 1));
      const props = {
        activeTab: BranchCommentsTab.Sessions,
        detail: {
          ...canonicalBranchDetailResponseFixture,
          id: branchId,
          sessionIds: sessionIds.slice(0, 1),
        },
        onClose: vi.fn(),
        onJump: vi.fn(),
        open: true,
        returnFocusRef: { current: null },
      };
      const view = render(
        <BranchCommentsController
          {...props}
          renderedSessionIds={sessionIds.slice(0, 1)}
        />,
        { wrapper: createWrapper() }
      );
      await waitFor(() => expect(mocks.comments).toHaveLength(1));
      view.rerender(
        <BranchCommentsController
          {...props}
          detail={
            source === "detail" ? { ...props.detail, sessionIds } : props.detail
          }
          renderedSessionIds={
            source === "trace" ? sessionIds : sessionIds.slice(0, 1)
          }
        />
      );
      await waitFor(() =>
        expect(mocks.comments).toHaveLength(sessionIds.length)
      );
      expect(mocks.api.get).toHaveBeenCalledTimes(2);
    }
  );

  it("refreshes a membership change received while the initial batch is in flight", async () => {
    let complete: (value: TraceComment[]) => void = () => undefined;
    mocks.api.get.mockReturnValueOnce(
      new Promise<TraceComment[]>((resolve) => {
        complete = resolve;
      })
    );
    const props = {
      activeTab: BranchCommentsTab.Sessions,
      detail: {
        ...canonicalBranchDetailResponseFixture,
        id: branchId,
        sessionIds: sessionIds.slice(0, 1),
      },
      onClose: vi.fn(),
      onJump: vi.fn(),
      open: true,
      returnFocusRef: { current: null },
    };
    const view = render(
      <BranchCommentsController
        {...props}
        renderedSessionIds={sessionIds.slice(0, 1)}
      />,
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(mocks.api.get).toHaveBeenCalledTimes(1));
    view.rerender(
      <BranchCommentsController {...props} renderedSessionIds={sessionIds} />
    );
    expect(mocks.api.get).toHaveBeenCalledTimes(1);
    await act(async () => complete(comments.slice(0, 1)));
    await waitFor(() => expect(mocks.comments).toHaveLength(sessionIds.length));
    expect(mocks.api.get).toHaveBeenCalledTimes(2);
    view.rerender(
      <BranchCommentsController
        {...props}
        renderedSessionIds={[...sessionIds].reverse()}
      />
    );
    await act(async () => Promise.resolve());
    expect(mocks.api.get).toHaveBeenCalledTimes(2);
  });

  it("uses legacy reads on an older API and still loads sessions that render later", async () => {
    mocks.api.get.mockImplementation((path: string) => {
      if (path.includes("includeSessions")) {
        return Promise.reject({ status: 400 });
      }
      return Promise.resolve(
        comments.filter((entry) => path.includes(entry.target.id))
      );
    });
    const props = {
      activeTab: BranchCommentsTab.Sessions,
      detail: {
        ...canonicalBranchDetailResponseFixture,
        id: branchId,
        sessionIds,
      },
      onClose: vi.fn(),
      onJump: vi.fn(),
      open: true,
      returnFocusRef: { current: null },
    };
    const view = render(
      <BranchCommentsController {...props} renderedSessionIds={[]} />,
      { wrapper: createWrapper() }
    );
    await waitFor(() =>
      expect(mocks.api.get).toHaveBeenCalledWith(
        expect.not.stringContaining("includeSessions"),
        expect.any(Object)
      )
    );
    view.rerender(
      <BranchCommentsController {...props} renderedSessionIds={sessionIds} />
    );
    await waitFor(() => expect(mocks.comments).toHaveLength(sessionIds.length));
    expect(
      mocks.api.get.mock.calls.filter(([path]) =>
        path.includes("includeSessions")
      )
    ).toHaveLength(1);
  });

  it("does not request comments while the rail is closed", async () => {
    render(
      <BranchCommentsController
        activeTab={BranchCommentsTab.Sessions}
        detail={{ ...canonicalBranchDetailResponseFixture, id: branchId }}
        onClose={vi.fn()}
        onJump={vi.fn()}
        open={false}
        renderedSessionIds={sessionIds}
        returnFocusRef={{ current: null }}
      />,
      { wrapper: createWrapper() }
    );
    await act(async () => Promise.resolve());
    expect(mocks.api.get).not.toHaveBeenCalled();
  });
});

function comment(id: string): TraceComment {
  return {
    id,
    threadId: `thread-${id}`,
    artifactId: id,
    target: { type: CommentTargetType.Session, id },
    surface: CommentSurface.SessionDetail,
    kind: TraceCommentKind.Comment,
    status: ThreadStatus.Open,
    anchor: {
      traceId: id,
      turnId: `turn-${id}`,
      sessionId: id,
      row: 0,
      selectedText: "text",
      sourceText: "text",
      startOffset: 0,
      endOffset: 4,
    },
    body: id,
    authorId: "user-1",
    authorName: "User",
    authorAvatarUrl: null,
    canEdit: true,
    canDelete: true,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    editedAt: null,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    resolvedByAvatarUrl: null,
    replies: [],
  };
}
