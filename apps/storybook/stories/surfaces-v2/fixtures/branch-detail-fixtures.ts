import {
  BranchCommentsFailureReason,
  BranchCommentsState,
  type BranchPageDetail,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  type BranchSelectedPullRequestFile,
  BranchSelectedPullRequestFileCompleteness,
  type BranchSelectedPullRequestFilesResponse,
  BranchSelectedPullRequestGrossTotalAvailability,
  BranchSelectedPullRequestReadAvailability,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import {
  BranchTraceCompletenessState,
  type BranchTraceResponse,
  BranchTraceSessionHydrationState,
  type MergedTraceItem,
} from "@repo/api/src/types/branch-trace";
import { SelectedPullRequestFileStatus } from "@repo/api/src/types/selected-pull-request-evidence";
import {
  completeSelectedPullRequest,
  populatedDetail,
} from "@repo/app/branches/components/branch-story-metric-fixtures";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { liveAppShellRoutes } from "./live-app-fixtures";

// The live Branch Detail (`apps/app/.../branches/[branchId]/page.tsx`) reads
// the branch (`GET /branches/:id`), its PR comments, the selected pull
// request's files, its trace comments and, on the Sessions timeline tab, the
// merged trace. The branch is the shared populated detail fixture
// (`populatedDetail()`, the one Branch Detail Page's own stories use).

export const branchDetailFixture: BranchPageDetail = populatedDetail();

export const BRANCH_DETAIL_ID = branchDetailFixture.id;

const selectedPullRequest = completeSelectedPullRequest();
const prUrl =
  selectedPullRequest.url ??
  `https://github.com/${selectedPullRequest.repositoryFullName}/pull/${selectedPullRequest.number}`;

export function branchCommentsFixture(
  state: BranchCommentsState = BranchCommentsState.Populated
): BranchPrCommentsResponse {
  const hasComments =
    state === BranchCommentsState.Populated ||
    state === BranchCommentsState.StaleMixed ||
    state === BranchCommentsState.OverLimitTruncated;
  const stale = state === BranchCommentsState.StaleMixed;
  return {
    branchId: BRANCH_DETAIL_ID,
    budget: {
      bodyTruncatedCount: 0,
      maxBodyBytes: 16_384,
      maxComments: 100,
      maxResponseBytes: 524_288,
      omittedComments: state === BranchCommentsState.OverLimitTruncated ? 5 : 0,
      pageSize: 50,
      providerTruncated: state === BranchCommentsState.OverLimitTruncated,
      responseTruncated: false,
    },
    comments: hasComments
      ? [
          {
            author: {
              avatarUrl: null,
              displayName: "Priya Shah",
              login: "priya-shah",
              profileUrl: null,
            },
            body: "Can we include the desktop parity case in the validation?",
            bodyTruncated: false,
            createdAt: "2026-06-17T12:30:00.000Z",
            id: "comment-1",
            inReplyToId: null,
            kind: BranchPrCommentKind.Issue,
            line: null,
            path: null,
            providerCommentId: "101",
            providerNodeId: "IC_1",
            providerUrl: `${prUrl}#issuecomment-101`,
            resolved: null,
            stale,
            threadId: null,
            updatedAt: null,
          },
        ]
      : [],
    failureReason:
      state === BranchCommentsState.ProviderError
        ? BranchCommentsFailureReason.ProviderUnavailable
        : undefined,
    mixedProjection: stale,
    prNumber: selectedPullRequest.number,
    prUrl,
    providerProofedAt:
      state === BranchCommentsState.UnsyncedUnknown
        ? null
        : "2026-06-17T12:30:00.000Z",
    repositoryFullName: selectedPullRequest.repositoryFullName,
    stale,
    state,
  };
}

function file(
  path: string,
  additions: number,
  deletions: number
): BranchSelectedPullRequestFile {
  return {
    additions,
    changes: additions + deletions,
    deletions,
    path,
    providerStatus: "modified",
    status: SelectedPullRequestFileStatus.Modified,
  };
}

const files = [
  file("packages/app/branches/branch-detail.tsx", 100, 10),
  file("packages/app/branches/branch-detail.css", 60, 8),
  file("e2e/branch-details.spec.ts", 20, 6),
];

export const branchFilesFixture: BranchSelectedPullRequestFilesResponse = {
  status: BranchSelectedPullRequestReadAvailability.Available,
  value: {
    counts: {
      expected: files.length,
      loaded: files.length,
      providerExpected: files.length,
      providerReturned: files.length,
    },
    coverage: {
      completeness: BranchSelectedPullRequestFileCompleteness.Complete,
      reasons: [],
    },
    files,
    grossTotals: {
      additions: {
        availability: BranchSelectedPullRequestGrossTotalAvailability.Available,
        completeness: BranchSelectedPullRequestFileCompleteness.Complete,
        value: 180,
      },
      deletions: {
        availability: BranchSelectedPullRequestGrossTotalAvailability.Available,
        completeness: BranchSelectedPullRequestFileCompleteness.Complete,
        value: 24,
      },
    },
    identity: {
      githubId: "PR_kwDO_story_1270",
      number: selectedPullRequest.number,
      repositoryFullName: selectedPullRequest.repositoryFullName,
      url: prUrl,
    },
    pagination: {
      pageSize: 100,
      pagesFetched: 1,
      providerMaximum: 500,
      reachedProviderMaximum: false,
    },
    revision: {
      baseSha: "a".repeat(40),
      headSha: selectedPullRequest.headRefOid ?? "b".repeat(40),
    },
  },
};

function traceItems(): MergedTraceItem[] {
  const items: MergedTraceItem[] = [
    {
      actor: { harness: "claude", name: "alice" },
      sessionId: "s1",
      t: "2026-06-17T09:00:00.000Z",
      type: "sessionstart",
    },
  ];
  const steps = [
    [
      "Lay out the branch detail header and properties.",
      "Added the header, properties panel and PR selector.",
    ],
    [
      "Wire the files changed panel to the selected PR.",
      "The files panel now reads the selected pull request's files.",
    ],
    [
      "Add the desktop parity case to the e2e spec.",
      "Extended the branch details spec with the desktop parity case.",
    ],
  ] as const;
  steps.forEach(([prompt, reply], index) => {
    items.push(
      {
        actorName: "alice",
        cumCostUsd: index * 0.6,
        sessionId: "s1",
        t: new Date(Date.UTC(2026, 5, 17, 9, index * 10)).toISOString(),
        text: prompt,
        tMs: index * 600_000,
        type: "prompt",
      },
      {
        actorName: "claude",
        cumCostUsd: index * 0.6 + 0.4,
        sessionId: "s1",
        t: new Date(Date.UTC(2026, 5, 17, 9, index * 10 + 6)).toISOString(),
        text: reply,
        tMs: index * 600_000 + 360_000,
        type: "say",
      }
    );
  });
  items.push({ sessionId: "s1", text: "Session ended", type: "end" });
  return items;
}

export const branchTraceFixture: BranchTraceResponse = {
  branchId: BRANCH_DETAIL_ID,
  hasMore: false,
  items: traceItems(),
  traceState: {
    aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
    completeness: { state: BranchTraceCompletenessState.Complete },
    qualifyingSessionCount: 1,
    sessions: [
      {
        identity: {
          artifactId: "s1",
          name: "Scaffold the shell",
          navigableRef: "sess-one",
          slug: "sess-one",
        },
        state: BranchTraceSessionHydrationState.Loaded,
      },
    ],
  },
  viewerScope: BranchViewerScope.Organization,
};

/** The reads the live Branch Detail makes, answered for `detail`. */
export function branchDetailRoutes(
  detail: BranchPageDetail = branchDetailFixture,
  comments: BranchPrCommentsResponse = branchCommentsFixture()
): FixtureRoute[] {
  const base = `/branches/${detail.id}`;
  return [
    ...liveAppShellRoutes,
    { method: "GET", path: `${base}/comments`, respond: () => comments },
    {
      method: "GET",
      path: `${base}/selected-pull-request/files`,
      respond: () => branchFilesFixture,
    },
    { method: "GET", path: `${base}/trace-comments`, respond: () => [] },
    // The timeline's comments rail also reads each session's own comments.
    {
      method: "GET",
      path: "/agent-sessions/*",
      respond: ({ pathname }) =>
        pathname.endsWith("/trace-comments") ? [] : {},
    },
    {
      method: "GET",
      path: `${base}/trace`,
      respond: () => ({ ...branchTraceFixture, branchId: detail.id }),
    },
    { method: "GET", path: base, respond: () => detail },
  ];
}

export const branchDetailApiRoutes = branchDetailRoutes();
