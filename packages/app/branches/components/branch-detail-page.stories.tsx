import {
  BranchCommentsFailureReason,
  BranchCommentsState,
  type BranchPageDetail,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
  BranchStatus,
  type MergedTraceItem,
} from "@repo/api/src/types/branch";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { AppCoreStoryProviders } from "../../shared/storybook/decorators";
import type { BranchesDataSource } from "../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../data-source/provider";
import { BranchDetailPage } from "./branch-detail-page";

// PLN-1148 Phase 2: the Sessions & timeline tab lazily fetches the merged trace
// through the data-source port (`useBranchTrace` → `useBranchesDataSource` →
// `useApiClient`). Mirror the unit test's wrapper so opening that tab in
// Storybook resolves a stub trace instead of crashing on the missing
// auth/API/query ports.
const storyBranchesSource: BranchesDataSource = {
  scope: "story",
  list: () => Promise.reject(new Error("list unused")),
  detail: () => Promise.reject(new Error("detail unused")),
  comments: (id) => Promise.resolve(makeStoryCommentsResponse(id)),
  trace: () => Promise.resolve(storyTraceItems),
  usage: () => Promise.reject(new Error("usage unused")),
  analytics: () => Promise.reject(new Error("analytics unused")),
};

const storyTraceItems = makeScrollableTraceItems();

function makeStoryCommentsResponse(branchId: string): BranchPrCommentsResponse {
  const state = storyCommentsStateByBranchId(branchId);
  if (state !== BranchCommentsState.Populated) {
    const baseResponse = makeBaseStoryCommentsResponse(branchId);
    const comments = stateHasStoryComment(state)
      ? baseResponse.comments.map((comment) => ({
          ...comment,
          stale: state === BranchCommentsState.StaleMixed,
        }))
      : [];
    return {
      ...baseResponse,
      state,
      comments,
      failureReason:
        state === BranchCommentsState.ProviderError
          ? BranchCommentsFailureReason.ProviderUnavailable
          : undefined,
      budget: {
        ...baseResponse.budget,
        providerTruncated: state === BranchCommentsState.OverLimitTruncated,
        omittedComments:
          state === BranchCommentsState.OverLimitTruncated ? 5 : 0,
      },
      providerProofedAt:
        state === BranchCommentsState.SyncedEmpty
          ? "2026-06-17T12:30:00.000Z"
          : null,
      stale: state === BranchCommentsState.StaleMixed,
      mixedProjection: state === BranchCommentsState.StaleMixed,
    };
  }
  return makeBaseStoryCommentsResponse(branchId);
}

function makeBaseStoryCommentsResponse(
  branchId: string
): BranchPrCommentsResponse {
  return {
    branchId,
    state: BranchCommentsState.Populated,
    comments: [
      {
        id: "comment-1",
        providerNodeId: "IC_1",
        providerCommentId: "101",
        kind: BranchPrCommentKind.Issue,
        threadId: null,
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
        body: "Can we include the desktop parity case in the validation?",
        createdAt: "2026-06-17T12:30:00.000Z",
        updatedAt: null,
        providerUrl: "https://github.com/owner/repo/pull/1270#issuecomment-101",
        stale: false,
        bodyTruncated: false,
      },
    ],
    budget: {
      maxComments: 100,
      pageSize: 50,
      maxBodyBytes: 16_384,
      maxResponseBytes: 524_288,
      providerTruncated: false,
      responseTruncated: false,
      omittedComments: 0,
      bodyTruncatedCount: 0,
    },
    providerProofedAt: "2026-06-17T12:30:00.000Z",
    stale: false,
    mixedProjection: false,
    prNumber: 1270,
    prUrl: "https://github.com/owner/repo/pull/1270",
  };
}

const populatedDetail: BranchPageDetail = {
  id: "owner%2Frepo::feature%2Fx",
  branchName: "feature/branches-detail",
  baseBranch: "main",
  repoFullName: "owner/repo",
  owner: "alice",
  status: BranchStatus.Open,
  prNumber: 1270,
  prTitle: "Add Branch Detail page",
  prState: "OPEN",
  prUrl: "https://github.com/owner/repo/pull/1270",
  multiPrWarning: false,
  checksStatus: null,
  checksPassed: null,
  checksTotal: null,
  reviewDecision: null,
  ahead: null,
  behind: null,
  additions: null,
  deletions: null,
  filesChanged: null,
  estimatedCostUsd: 4.2,
  lastActivityAt: "2026-06-17T12:00:00.000Z",
  sessionIds: ["s1", "s2"],
  prBody: "Implements the Branch Detail shell.",
  prBodyHtmlUrl: "https://github.com/owner/repo/pull/1270",
  headSha: null,
  mergeCommitSha: null,
  mergedAt: null,
  closedAt: null,
  openedAt: null,
  commits: [],
  sessions: [
    {
      sessionId: "s1",
      slug: "sess-one",
      name: "Scaffold the shell",
      harness: "claude",
      startedAt: "2026-06-17T09:00:00.000Z",
      endedAt: "2026-06-17T10:00:00.000Z",
      isPrimary: true,
      estimatedCostUsd: 2.1,
      inputTokens: 1000,
      outputTokens: 2000,
      cacheReadTokens: 500,
      cacheWriteTokens: 300,
    },
  ],
  mergedTrace: [{ type: "end", sessionId: "s1", text: "Session ended" }],
  leadTime: { firstActivityT: null, lastActivityT: null, idleSpans: [] },
  linkedPrNumbers: [1270],
  linkedArtifacts: [{ slug: "FEA-1952" }, { slug: "PLN-988" }],
};

const StoryFrame = ({ children }: { children: ReactNode }) => (
  <div className="flex h-[600px] w-full">{children}</div>
);

const meta = {
  title: "App Core/Branches/Branch Detail Page",
  component: BranchDetailPage,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={storyBranchesSource}>
          <StoryFrame>{<Story />}</StoryFrame>
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    ),
  ],
  args: {
    branchId: "b-1",
    backHref: "/branches",
    isLoading: false,
    isError: false,
  },
} satisfies Meta<typeof BranchDetailPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: { isLoading: true },
};

export const ErrorState: Story = {
  args: { isError: true },
};

export const EmptyNoSessions: Story = {
  args: { detail: { ...populatedDetail, sessions: [] } },
};

export const Populated: Story = {
  args: { detail: populatedDetail },
};

export const CommentsUnsynced: Story = {
  args: {
    branchId: "comments-unsynced",
    detail: { ...populatedDetail, id: "comments-unsynced" },
  },
};

export const CommentsProviderError: Story = {
  args: {
    branchId: "comments-provider-error",
    detail: { ...populatedDetail, id: "comments-provider-error" },
  },
};

export const CommentsSyncedEmpty: Story = {
  args: {
    branchId: "comments-synced-empty",
    detail: { ...populatedDetail, id: "comments-synced-empty" },
  },
};

export const CommentsStaleMixed: Story = {
  args: {
    branchId: "comments-stale-mixed",
    detail: { ...populatedDetail, id: "comments-stale-mixed" },
  },
};

export const CommentsOverLimit: Story = {
  args: {
    branchId: "comments-over-limit",
    detail: { ...populatedDetail, id: "comments-over-limit" },
  },
};

export const CommentsForbiddenMismatch: Story = {
  args: {
    branchId: "comments-forbidden-mismatch",
    detail: { ...populatedDetail, id: "comments-forbidden-mismatch" },
  },
};

function storyCommentsStateByBranchId(branchId: string): BranchCommentsState {
  if (branchId === "comments-unsynced") {
    return BranchCommentsState.UnsyncedUnknown;
  }
  if (branchId === "comments-provider-error") {
    return BranchCommentsState.ProviderError;
  }
  if (branchId === "comments-synced-empty") {
    return BranchCommentsState.SyncedEmpty;
  }
  if (branchId === "comments-stale-mixed") {
    return BranchCommentsState.StaleMixed;
  }
  if (branchId === "comments-over-limit") {
    return BranchCommentsState.OverLimitTruncated;
  }
  if (branchId === "comments-forbidden-mismatch") {
    return BranchCommentsState.ForbiddenMismatch;
  }
  return BranchCommentsState.Populated;
}

function stateHasStoryComment(state: BranchCommentsState): boolean {
  return (
    state === BranchCommentsState.StaleMixed ||
    state === BranchCommentsState.OverLimitTruncated
  );
}

function makeScrollableTraceItems(): MergedTraceItem[] {
  const items: MergedTraceItem[] = [
    {
      type: "sessionstart",
      sessionId: "s1",
      t: "2026-06-17T09:00:00.000Z",
      actor: { name: "alice", harness: "claude" },
    },
  ];

  for (let index = 0; index < 48; index += 1) {
    const promptT = new Date(
      Date.UTC(2026, 5, 17, 9, index * 2, 0)
    ).toISOString();
    const responseT = new Date(
      Date.UTC(2026, 5, 17, 9, index * 2 + 1, 0)
    ).toISOString();
    items.push(
      {
        type: "prompt",
        sessionId: "s1",
        t: promptT,
        tMs: index * 120_000,
        cumCostUsd: index / 100,
        actorName: "alice",
        text: `Investigate branch detail scroll behavior, step ${index + 1}.`,
      },
      {
        type: "say",
        sessionId: "s1",
        t: responseT,
        tMs: index * 120_000 + 60_000,
        cumCostUsd: index / 100 + 0.01,
        actorName: "codex",
        text: `Applied the session-detail layout reference to trace row ${index + 1}.`,
      }
    );
  }

  items.push({ type: "end", sessionId: "s1", text: "Session ended" });
  return items;
}
