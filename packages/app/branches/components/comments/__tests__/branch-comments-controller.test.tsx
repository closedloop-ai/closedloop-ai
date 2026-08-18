// @vitest-environment jsdom

import {
  BranchCommentsState,
  type BranchPageDetail,
  type BranchPrComment,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_COMMENTS_ERROR_REFETCH_INTERVAL_MS,
  BRANCH_COMMENTS_READ_TIMEOUT_MS,
} from "../branch-comments-collection-reader";
import { BranchCommentsTab } from "../branch-comments-model";

type CapturedQueryOptions = {
  queryFn?: (context: { signal: AbortSignal }) => Promise<unknown>;
  refetchInterval?: (query: {
    state: { status: string };
  }) => number | false | undefined;
  refetchOnReconnect?: boolean;
  refetchOnWindowFocus?: boolean;
  staleTime?: number;
};

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  isError: false,
  list: vi.fn(),
  queryOptions: undefined as CapturedQueryOptions | undefined,
  workspaceProps: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@repo/app/shared/trace-comments/trace-comments-provider", () => ({
  useTraceCommentsDataSource: () => ({ scope: "test", list: mocks.list }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: CapturedQueryOptions) => {
    mocks.queryOptions = options;
    return { data: [], isError: mocks.isError, isLoading: false };
  },
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("../branch-comments-workspace", () => ({
  BranchCommentsWorkspace: (props: Record<string, unknown>) => {
    mocks.workspaceProps = props;
    return null;
  },
}));

import { BranchCommentsController } from "../branch-comments-controller";

describe("BranchCommentsController provider production wiring", () => {
  beforeEach(() => {
    mocks.isError = false;
    mocks.list.mockReset();
  });

  it("passes the selected response's root, reply, and availability evidence to the workspace", () => {
    render(
      <BranchCommentsController
        activeTab={BranchCommentsTab.Details}
        detail={{ id: "branch-1" } as BranchPageDetail}
        onClose={vi.fn()}
        onJump={vi.fn()}
        open
        providerComments={providerResponse()}
        renderedSessionIds={[]}
        returnFocusRef={{ current: null }}
        selectedPullRequestKey="closedloop-ai/symphony-alpha#42"
      />
    );

    expect(mocks.workspaceProps?.providerAvailability).toMatchObject({
      bodyTruncatedCount: 2,
      mixedProjection: true,
      omittedComments: 3,
      providerTruncated: true,
      responseTruncated: true,
      stale: true,
    });
    expect(mocks.workspaceProps?.comments).toEqual([
      expect.objectContaining({
        provider: expect.objectContaining({
          kind: BranchPrCommentKind.Review,
          login: "root-reviewer",
          stale: true,
        }),
        replies: [
          expect.objectContaining({
            provider: expect.objectContaining({
              kind: BranchPrCommentKind.ReviewReply,
              providerUrl: expect.stringContaining("discussion_r2"),
            }),
          }),
        ],
      }),
    ]);
  });

  it("does not pass provider evidence into Sessions", () => {
    render(
      <BranchCommentsController
        activeTab={BranchCommentsTab.Sessions}
        detail={{ id: "branch-1" } as BranchPageDetail}
        onClose={vi.fn()}
        onJump={vi.fn()}
        open
        providerComments={providerResponse()}
        renderedSessionIds={[]}
        returnFocusRef={{ current: null }}
        selectedPullRequestKey="closedloop-ai/symphony-alpha#42"
      />
    );

    expect(mocks.workspaceProps?.providerAvailability).toBeUndefined();
    expect(mocks.workspaceProps?.comments).toEqual([]);
  });

  it("issues its native reads with the query's signal and the read deadline (ISS-5110)", async () => {
    mocks.list.mockResolvedValue([]);
    render(
      <BranchCommentsController
        activeTab={BranchCommentsTab.Sessions}
        detail={{ id: "branch-1" } as BranchPageDetail}
        onClose={vi.fn()}
        onJump={vi.fn()}
        open
        renderedSessionIds={["session-1"]}
        returnFocusRef={{ current: null }}
      />
    );
    const controller = new AbortController();

    await mocks.queryOptions?.queryFn?.({ signal: controller.signal });

    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1" }),
      undefined,
      { signal: controller.signal, timeoutMs: BRANCH_COMMENTS_READ_TIMEOUT_MS }
    );
  });

  it("fails the query when no native collection could be read (ISS-5110)", async () => {
    mocks.list.mockRejectedValue(new Error("comments unavailable"));
    renderSessionsWorkspace();

    await expect(
      mocks.queryOptions?.queryFn?.({ signal: new AbortController().signal })
    ).rejects.toThrow("comments unavailable");
  });

  it("keeps a partly-failed read successful so peers survive", async () => {
    mocks.list.mockImplementation((target: { id: string }) => {
      if (target.id === "session-1") {
        return Promise.reject(new Error("comments unavailable"));
      }
      return Promise.resolve([]);
    });
    renderSessionsWorkspace();

    const results = await mocks.queryOptions?.queryFn?.({
      signal: new AbortController().signal,
    });

    expect(results).toHaveLength(2);
  });

  it("re-attempts only while the read is errored", () => {
    renderSessionsWorkspace();

    expect(
      mocks.queryOptions?.refetchInterval?.({ state: { status: "error" } })
    ).toBe(BRANCH_COMMENTS_ERROR_REFETCH_INTERVAL_MS);
    expect(
      mocks.queryOptions?.refetchInterval?.({ state: { status: "success" } })
    ).toBe(false);
  });

  it("opts out of the shared client's focus and reconnect refetch defaults (ISS-5976)", () => {
    // This read is `staleTime: 0`, so it is ALWAYS stale and the shared client's
    // `staleTime` bound cannot apply to it: inheriting the ON defaults would
    // re-run the whole per-collection fan-out on every focus and every reconnect,
    // not once a minute. The opt-out is declared at this construction site, which
    // is where that policy requires an exception to be argued.
    renderSessionsWorkspace();

    expect(mocks.queryOptions?.staleTime).toBe(0);
    expect(mocks.queryOptions?.refetchOnWindowFocus).toBe(false);
    expect(mocks.queryOptions?.refetchOnReconnect).toBe(false);
  });

  it("states that comments are unavailable rather than rendering a failed read as empty", () => {
    mocks.isError = true;
    renderSessionsWorkspace();

    expect(mocks.workspaceProps?.hasError).toBe(true);
    expect(mocks.workspaceProps?.coverageNote).toContain("aren't available");
  });
});

function renderSessionsWorkspace() {
  render(
    <BranchCommentsController
      activeTab={BranchCommentsTab.Sessions}
      detail={{ id: "branch-1" } as BranchPageDetail}
      onClose={vi.fn()}
      onJump={vi.fn()}
      open
      renderedSessionIds={["session-1"]}
      returnFocusRef={{ current: null }}
    />
  );
}

function providerResponse(): BranchPrCommentsResponse {
  return {
    branchId: "branch-1",
    budget: {
      bodyTruncatedCount: 2,
      maxBodyBytes: 16_384,
      maxComments: 100,
      maxResponseBytes: 524_288,
      omittedComments: 3,
      pageSize: 50,
      providerTruncated: true,
      responseTruncated: true,
    },
    comments: [
      providerComment(),
      providerComment({
        author: {
          avatarUrl: null,
          displayName: null,
          login: "reply-reviewer",
          profileUrl: null,
        },
        id: "reply-1",
        inReplyToId: "root-1",
        kind: BranchPrCommentKind.ReviewReply,
        providerUrl:
          "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r2",
      }),
    ],
    mixedProjection: true,
    prNumber: 42,
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
    providerProofedAt: "2026-08-10T10:00:00.000Z",
    repositoryFullName: "closedloop-ai/symphony-alpha",
    stale: true,
    state: BranchCommentsState.StaleMixed,
  };
}

function providerComment(
  overrides: Partial<BranchPrComment> = {}
): BranchPrComment {
  return {
    author: {
      avatarUrl: "https://avatars.example/root.png",
      displayName: "Root Reviewer",
      login: "root-reviewer",
      profileUrl: null,
    },
    body: "Provider body",
    bodyTruncated: true,
    createdAt: "2026-08-10T09:00:00.000Z",
    id: "root-1",
    inReplyToId: null,
    kind: BranchPrCommentKind.Review,
    line: 42,
    path: "packages/app/root.tsx",
    providerCommentId: "1",
    providerNodeId: "node-1",
    providerUrl:
      "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r1",
    resolved: false,
    stale: true,
    threadId: "thread-1",
    updatedAt: null,
    ...overrides,
  };
}
