import {
  BranchCommentsFailureReason,
  BranchCommentsState,
  type BranchPageDetail,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import { resolveAttributedBranchCost } from "@repo/api/src/types/branch-cost";
import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import {
  type BranchSelectedPullRequestFile,
  BranchSelectedPullRequestFileCompleteness,
  type BranchSelectedPullRequestFilesResponse,
  BranchSelectedPullRequestGrossTotalAvailability,
  BranchSelectedPullRequestReadAvailability,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  type MergedTraceItem,
} from "@repo/api/src/types/branch-trace";
import { SelectedPullRequestFileStatus } from "@repo/api/src/types/selected-pull-request-evidence";
import { phaseAttributionSegment } from "@repo/lib/branches/__tests__/branch-phase-attribution-fixture";
import { calculateBranchDetailMetrics } from "@repo/lib/branches/branch-detail-outcomes";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import type { FixtureRoute } from "../../shared/storybook/fixture-fetch";
import type { BranchesDataSource } from "../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../data-source/provider";
import { BranchDetailPage } from "./branch-detail-page";
import {
  populatedDetail as buildPopulatedDetail,
  completeSelectedPullRequest,
} from "./branch-story-metric-fixtures";

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
  trace: () => Promise.resolve(storyTraceResult),
  usage: () => Promise.reject(new Error("usage unused")),
  analytics: () => Promise.reject(new Error("analytics unused")),
  pageData: () => Promise.reject(new Error("pageData unused")),
};

const storyTraceItems = makeScrollableTraceItems();
const storyTraceResult = {
  items: storyTraceItems,
  sessions: [
    {
      identity: {
        artifactId: "s1",
        name: "Scaffold the shell",
        slug: "sess-one",
        navigableRef: "sess-one",
      },
      state: BranchTraceSessionHydrationState.Loaded,
    },
  ],
  qualifyingSessionCount: 1,
  completeness: { state: BranchTraceCompletenessState.Complete },
  aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
};

const storyApiRoutes: FixtureRoute[] = [
  {
    method: "GET",
    path: "/branches/*",
    respond: ({ pathname }) =>
      pathname.endsWith("/selected-pull-request/files")
        ? storyFilesResponse
        : {},
  },
];

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
    repositoryFullName: "owner/repo",
    prNumber: 1270,
    prUrl: "https://github.com/owner/repo/pull/1270",
  };
}

const storySelectedPullRequest = completeSelectedPullRequest();
const storyFilesResponse: BranchSelectedPullRequestFilesResponse = {
  status: BranchSelectedPullRequestReadAvailability.Available,
  value: {
    identity: {
      githubId: "PR_kwDO_story_1270",
      repositoryFullName: storySelectedPullRequest.repositoryFullName,
      number: storySelectedPullRequest.number,
      url:
        storySelectedPullRequest.url ??
        "https://github.com/owner/repo/pull/1270",
    },
    revision: {
      baseSha: "a".repeat(40),
      headSha: storySelectedPullRequest.headRefOid ?? "b".repeat(40),
    },
    files: [
      storyFile("packages/app/branches/branch-detail.tsx", 100, 10),
      storyFile("packages/app/branches/branch-detail.css", 60, 8),
      storyFile("e2e/branch-details.spec.ts", 20, 6),
    ],
    counts: {
      expected: 3,
      loaded: 3,
      providerExpected: 3,
      providerReturned: 3,
    },
    coverage: {
      completeness: BranchSelectedPullRequestFileCompleteness.Complete,
      reasons: [],
    },
    grossTotals: {
      additions: {
        availability: BranchSelectedPullRequestGrossTotalAvailability.Available,
        value: 180,
        completeness: BranchSelectedPullRequestFileCompleteness.Complete,
      },
      deletions: {
        availability: BranchSelectedPullRequestGrossTotalAvailability.Available,
        value: 24,
        completeness: BranchSelectedPullRequestFileCompleteness.Complete,
      },
    },
    pagination: {
      pageSize: 100,
      pagesFetched: 1,
      providerMaximum: 500,
      reachedProviderMaximum: false,
    },
  },
};

// Shared with ISS-10963's design harness via the fixtures module. Not
// exported: every named export in a `.stories.tsx` file is indexed as a story.
const populatedDetail: BranchPageDetail = buildPopulatedDetail();

const RESIDUE_ATTRIBUTED_COST_USD = 174.04;
const RESIDUE_ROLLUP_COST_USD = 8;

function costAttributionResidueDetail(): BranchPageDetail {
  const phaseAttribution: BranchPhaseAttributionResult = {
    segments: [
      phaseAttributionSegment({
        sessionId: "s1",
        phase: BranchVisibleLifecyclePhase.Build,
        startMs: 0,
        endMs: 1,
        estimatedCostUsd: RESIDUE_ROLLUP_COST_USD,
      }),
    ],
    rollups: Object.values(BranchVisibleLifecyclePhase).map((phase) => ({
      phase,
      estimatedCostUsd:
        phase === BranchVisibleLifecyclePhase.Build
          ? RESIDUE_ROLLUP_COST_USD
          : 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 30 * 60 * 1000,
      sessionCount: 1,
    })),
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: RESIDUE_ROLLUP_COST_USD,
    },
  };
  const detail: BranchPageDetail = {
    ...populatedDetail,
    // The Sessions & timeline tab reads this figure; the Cost breakdown card
    // must land on the same one.
    estimatedCostUsd: RESIDUE_ATTRIBUTED_COST_USD,
    attributedCostUsd: RESIDUE_ATTRIBUTED_COST_USD,
    sessions: populatedDetail.sessions.map((session) => ({
      ...session,
      estimatedCostUsd: RESIDUE_ATTRIBUTED_COST_USD,
      evenSplitCostUsd: RESIDUE_ATTRIBUTED_COST_USD,
      branchCount: 1,
    })),
    phaseAttribution,
  };
  return {
    ...detail,
    canonicalMetrics: calculateBranchDetailMetrics({
      attributedCostUsd: resolveAttributedBranchCost(detail),
      phaseAttribution,
      selectedCycle: null,
      selectedPrAdditions: detail.additions,
      selectedPrDeletions: detail.deletions,
      selectedPrLocComplete: true,
    }),
  };
}

const StoryFrame = ({ children }: { children: ReactNode }) => (
  <div className="flex h-[600px] w-full">{children}</div>
);

const meta = {
  title: "Surfaces v1.0/Branches/Branch Detail Page",
  component: BranchDetailPage,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "fullscreen",
    appCore: { apiRoutes: storyApiRoutes },
  },
  decorators: [
    (Story) => (
      <BranchesDataSourceProvider dataSource={storyBranchesSource}>
        <StoryFrame>{<Story />}</StoryFrame>
      </BranchesDataSourceProvider>
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

/**
 * ISS-6949 — a Branch whose phase attribution prices only part of its real spend,
 * so the Cost breakdown header and the Sessions & timeline stat are derived from
 * quantities that disagree. `canonicalMetrics` is produced by the REAL kernel over
 * this fixture rather than hand-authored, so the story renders whatever the
 * shipped derivation decides.
 */
export const CostAttributionResidue: Story = {
  args: { detail: costAttributionResidueDetail() },
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

function storyFile(
  path: string,
  additions: number,
  deletions: number
): BranchSelectedPullRequestFile {
  return {
    path,
    providerStatus: "modified",
    status: SelectedPullRequestFileStatus.Modified,
    additions,
    deletions,
    changes: additions + deletions,
  };
}
