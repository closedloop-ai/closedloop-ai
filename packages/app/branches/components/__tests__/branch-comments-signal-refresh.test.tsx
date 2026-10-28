import {
  BranchCommentsState,
  type BranchPageDetail,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { ApproverRole, type User } from "@repo/api/src/types/user";
import { createFakeTraceCommentsSource } from "@repo/app/agents/data-source/__tests__/fake-trace-comments-source";
import { TraceCommentsDataSourceProvider } from "@repo/app/agents/data-source/trace-comments-provider";
import { applyResyncRule } from "@repo/realtime-client/port";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import {
  BranchSignalType,
  CommentSignalType,
} from "@repo/realtime-contract/signals";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRealtimePort } from "../../../shared/realtime/__tests__/fake-realtime-port";
import { RealtimeProvider } from "../../../shared/realtime/realtime-provider";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { userKeys } from "../../../users/hooks/use-users";
import type { BranchesDataSource } from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { useBranchDetail } from "../../hooks/use-branches";
import { BranchDetailPage } from "../branch-detail-page";
import { BranchDetailSignalRefresh } from "../detail/branch-detail-signal-refresh";
import {
  baseProps,
  makeCommentsResponse,
  makeDetail,
  makeTraceComment,
} from "./branch-detail-page.fixtures";

const ORGANIZATION_ID = "0190c6c8-0000-7000-8000-0000000000a1";
const BRANCH_ID = "0190c6c8-0000-7000-8000-0000000000b1";
const THREAD_ID = "0190c6c8-0000-7000-8000-0000000000c1";
const REPOSITORY = "owner/repo";
const PR_NUMBER = 42;
const GITHUB_COMMENT_BODY = "Reviewer note stored by the reconcile";
const SHOW_COMMENTS_RAIL = "Show comments rail";
// The selected pull request's files panel reads through the API; it is not
// under test, so it gets the failure it already handles.
const UNAVAILABLE_SELECTED_PULL_REQUEST_READS = {
  method: "GET",
  path: `/branches/${BRANCH_ID}/selected-pull-request/*`,
  status: 503,
  respond: () => null,
};
const THREAD_SIGNAL = {
  type: CommentSignalType.ThreadCreated,
  data: { threadId: THREAD_ID, threadRevision: 1 },
};

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: false,
    status: 404,
    json: () => Promise.resolve({}),
  } as Response);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Branch comments refresh on realtime signals (ISS-11212)", () => {
  it("joins the branch's comments channel and reloads the comments on a signal", async () => {
    const comments = vi.fn((id: string) =>
      Promise.resolve(makeCommentsResponse(id))
    );
    const realtime = createFakeRealtimePort();

    renderPage(comments, realtime.port);

    await waitFor(() => expect(comments).toHaveBeenCalledTimes(1));
    expect(realtime.joins.map(({ channel }) => channel)).toEqual(
      expect.arrayContaining([
        formatChannelAddress(ChannelKind.Comments, ORGANIZATION_ID, [
          BRANCH_ID,
        ]),
      ])
    );

    act(() => commentsListener(realtime).onSignal(THREAD_SIGNAL));

    await waitFor(() => expect(comments).toHaveBeenCalledTimes(2));
  });

  it("shows the comments a reconcile stored after the first read returned UnsyncedUnknown", async () => {
    const user = userEvent.setup();
    const comments = vi
      .fn<(id: string) => Promise<BranchPrCommentsResponse>>()
      .mockResolvedValueOnce(unsyncedResponse())
      .mockResolvedValue(populatedResponse());
    const realtime = createFakeRealtimePort();

    renderPage(comments, realtime.port);
    await user.click(
      await screen.findByRole("button", { name: SHOW_COMMENTS_RAIL })
    );
    await waitFor(() => expect(comments).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(GITHUB_COMMENT_BODY)).not.toBeInTheDocument();

    act(() => commentsListener(realtime).onSignal(THREAD_SIGNAL));

    expect(await screen.findByText(GITHUB_COMMENT_BODY)).toBeInTheDocument();
  });

  it("runs one reload for a burst of signals, and one more for those that arrived during it", async () => {
    let finishReload: () => void = () => undefined;
    const comments = vi
      .fn<(id: string) => Promise<BranchPrCommentsResponse>>()
      .mockResolvedValueOnce(unsyncedResponse())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishReload = () => resolve(unsyncedResponse());
          })
      )
      .mockResolvedValue(populatedResponse());
    const realtime = createFakeRealtimePort();

    renderPage(comments, realtime.port);
    await waitFor(() => expect(comments).toHaveBeenCalledTimes(1));
    const listener = commentsListener(realtime);

    act(() => {
      for (let index = 0; index < 5; index += 1) {
        listener.onSignal(THREAD_SIGNAL);
      }
    });
    await waitFor(() => expect(comments).toHaveBeenCalledTimes(2));
    act(() => finishReload());

    await waitFor(() => expect(comments).toHaveBeenCalledTimes(3));
  });

  it("refreshes the active detail through the page-level branch signal subscription", async () => {
    const comments = vi.fn((id: string) =>
      Promise.resolve(makeCommentsResponse(id))
    );
    const readDetail = vi.fn().mockResolvedValue(detail());
    const realtime = createFakeRealtimePort();
    renderPage(comments, realtime.port, readDetail);
    await waitFor(() => expect(comments).toHaveBeenCalledTimes(1));
    const joined = realtime.joins.find(
      ({ channel }) =>
        channel ===
        formatChannelAddress(ChannelKind.Branches, ORGANIZATION_ID, [BRANCH_ID])
    );
    expect(joined).toBeDefined();
    expect(readDetail).toHaveBeenCalledTimes(1);
    act(() =>
      joined?.listener.onSignal({
        type: BranchSignalType.Updated,
        data: { branchId: BRANCH_ID },
      })
    );
    await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(2));
    expect(comments).toHaveBeenCalledTimes(1);
  });

  it("skips a comments resync newer than the join cursor and reloads after a later reconnect", async () => {
    const comments = vi.fn((id: string) =>
      Promise.resolve(makeCommentsResponse(id))
    );
    const realtime = createFakeRealtimePort();
    renderPage(comments, realtime.port);
    await waitFor(() => expect(comments).toHaveBeenCalledTimes(1));
    const listener = commentsListener(realtime);
    await waitFor(() => expect(listener.dataLoadedAt?.()).toBeGreaterThan(0));
    const loadedAt = listener.dataLoadedAt?.() ?? 0;
    await act(async () => applyResyncRule(listener, loadedAt - 1));
    expect(comments).toHaveBeenCalledTimes(1);
    act(() => applyResyncRule(listener, loadedAt + 1));
    await waitFor(() => expect(comments).toHaveBeenCalledTimes(2));
  });

  it("reads the comments once and joins nothing without a realtime provider", async () => {
    const comments = vi.fn((id: string) =>
      Promise.resolve(makeCommentsResponse(id))
    );

    renderPage(comments, null);

    await waitFor(() => expect(comments).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("button", { name: SHOW_COMMENTS_RAIL })
    ).toBeInTheDocument();
  });
});

function renderPage(
  comments: BranchesDataSource["comments"],
  realtimePort: ReturnType<typeof createFakeRealtimePort>["port"] | null,
  readDetail?: BranchesDataSource["detail"]
) {
  const branchesSource: BranchesDataSource = {
    scope: "test",
    list: () => Promise.reject(new Error("list unused")),
    detail: readDetail ?? (() => Promise.reject(new Error("detail unused"))),
    comments,
    trace: () => Promise.reject(new Error("trace unused")),
    usage: () => Promise.reject(new Error("usage unused")),
    analytics: () => Promise.reject(new Error("analytics unused")),
    pageData: () => Promise.reject(new Error("pageData unused")),
  };
  const traceCommentsSource = createFakeTraceCommentsSource({
    commentsByTarget: new Map(),
    makeTraceComment,
  });
  const withRealtime = (children: ReactNode) =>
    realtimePort === null ? (
      children
    ) : (
      <RealtimeProvider client={realtimePort}>{children}</RealtimeProvider>
    );
  return render(
    readDetail ? (
      <QueriedBranchPage />
    ) : (
      <BranchDetailPage
        {...baseProps({ branchId: BRANCH_ID, detail: detail() })}
      />
    ),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <AppCoreStoryProviders
          apiRoutes={[UNAVAILABLE_SELECTED_PULL_REQUEST_READS]}
          queryData={[[userKeys.currentUser(), currentUser()]]}
        >
          <TraceCommentsDataSourceProvider dataSource={traceCommentsSource}>
            <BranchesDataSourceProvider dataSource={branchesSource}>
              {withRealtime(children)}
            </BranchesDataSourceProvider>
          </TraceCommentsDataSourceProvider>
        </AppCoreStoryProviders>
      ),
    }
  );
}

function detail(): BranchPageDetail {
  const pullRequest = {
    id: `${REPOSITORY}#${PR_NUMBER}`,
    repositoryFullName: REPOSITORY,
    number: PR_NUMBER,
    title: "Add x",
    url: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}`,
    state: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: null,
    openedAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
  };
  return makeDetail({
    id: BRANCH_ID,
    selectedPullRequest: {
      ...pullRequest,
      body: "PR body",
      baseRefName: "main",
      authorLogin: "octocat",
      headRefOid: "a".repeat(40),
      mergeCommitSha: null,
      changedFiles: 1,
      additions: 1,
      deletions: 1,
    },
  });
}

function unsyncedResponse(): BranchPrCommentsResponse {
  return { ...makeCommentsResponse(BRANCH_ID), repositoryFullName: REPOSITORY };
}

function populatedResponse(): BranchPrCommentsResponse {
  return {
    ...unsyncedResponse(),
    state: BranchCommentsState.Populated,
    comments: [
      {
        id: THREAD_ID,
        providerNodeId: null,
        providerCommentId: "11",
        kind: BranchPrCommentKind.Issue,
        threadId: THREAD_ID,
        inReplyToId: null,
        path: null,
        line: null,
        resolved: null,
        author: {
          login: "reviewer",
          displayName: null,
          avatarUrl: null,
          profileUrl: null,
        },
        body: GITHUB_COMMENT_BODY,
        createdAt: "2026-10-05T10:00:00.000Z",
        updatedAt: "2026-10-05T10:00:00.000Z",
        providerUrl: null,
        stale: false,
        bodyTruncated: false,
      },
    ],
  };
}

function currentUser(): User {
  return {
    id: "0190c6c8-0000-7000-8000-0000000000d1",
    clerkId: "user_test",
    organizationId: ORGANIZATION_ID,
    email: "reader@example.com",
    firstName: null,
    lastName: null,
    avatarUrl: null,
    phoneNumber: null,
    role: ApproverRole.Engineer,
    linearId: null,
    slackId: null,
    githubUsername: null,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function commentsListener(realtime: ReturnType<typeof createFakeRealtimePort>) {
  const joined = realtime.joins.find(({ channel }) =>
    channel.startsWith(`${ChannelKind.Comments}:`)
  );
  if (!joined) {
    throw new Error("comments channel was not joined");
  }
  return joined.listener;
}

function QueriedBranchPage() {
  const query = useBranchDetail(BRANCH_ID);
  return (
    <>
      <BranchDetailSignalRefresh branchId={BRANCH_ID} />
      {query.data ? (
        <BranchDetailPage
          {...baseProps({ branchId: BRANCH_ID, detail: query.data })}
        />
      ) : null}
    </>
  );
}
