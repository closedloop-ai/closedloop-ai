// gardener-support: test and story data, not shipped
import {
  type BranchPageDetail,
  BranchProvenance,
  type BranchSelectedPullRequestDetail,
  BranchStatus,
  classifyBranchProvenance,
} from "@repo/api/src/types/branch";
import {
  type BranchAssociatedPullRequest,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
} from "@repo/api/src/types/branch-check-projection";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionResult,
} from "@repo/api/src/types/branch-phase-attribution";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { GitHubPRState } from "@repo/api/src/types/github-status";
// Feature slice -> shared: the design harness feeds the shared preview's
// comments rail and Details sections, which read these generic shapes.
import type { GenericCommentRecord } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-rail";
import {
  type BranchDetailsTabInput,
  detailsAssociatedRecord,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-fixtures";
import {
  DetailsLinkEnd,
  DetailsLinkType,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import {
  formatCostPrecise,
  formatLocPerDollar,
} from "@repo/app/shared/lib/format-utils";
import {
  branchMetricCycleFromPullRequest,
  calculateBranchDetailMetrics,
} from "@repo/lib/branches/branch-detail-outcomes";
import type { BranchMetricLocContribution } from "@repo/lib/branches/branch-publication-loc";
import { createElement } from "react";
import { deriveLifecycleBadge } from "../../lib/merge-status-derivation";
import {
  completePhaseAttribution,
  completeSelectedPullRequest,
  completeSelectedPullRequestChecks,
  populatedDetail,
} from "../branch-story-metric-fixtures";
import {
  LifecycleBadgeChip,
  ReviewDecisionLabel,
} from "../detail/branch-pr-status-panel";

/**
 * ISS-10963 design-harness fixtures. A branch with TWO pull requests, so the
 * selector visibly re-scopes every PR-owned panel (whitlockk, #7833): each id maps
 * to a whole `BranchPageDetail`, the unit production's
 * `BranchSelectedPullRequestWorkspace` swaps on a selection change. The open
 * PR's metrics come from the real producer, so its cycle is not applicable
 * rather than a copied merged cycle.
 */

const MERGED_PR_ID = "owner/repo#1270";
const OPEN_PR_ID = "owner/repo#1284";
const HOUR_MS = 60 * 60 * 1000;
// The open PR's sessions ran the day after the merged PR's.
const OPEN_PR_SHIFT_MS = 23 * HOUR_MS;
const OPEN_PR_COST_SCALE = 0.5;

export const BRANCH_DESIGN_PULL_REQUEST_IDS = {
  Merged: MERGED_PR_ID,
  Open: OPEN_PR_ID,
} as const;

const mergedBase = populatedDetail();
const mergedPullRequest: BranchSelectedPullRequestDetail = {
  ...completeSelectedPullRequest(),
  title: "Fixture: add the Branch Detail page",
  body: "Fixture: implements the Branch Detail shell.",
};

const [mergedSession] = mergedBase.sessions;
/**
 * One branch-level session list for both details, so the Sessions tab, the
 * Properties count and each PR's attributed cost describe the same sessions:
 * s1 carries the merged PR's cycle, s2 the open PR's.
 */
const BRANCH_SESSIONS: BranchPageDetail["sessions"] = mergedSession
  ? [
      {
        ...mergedSession,
        name: "Fixture: scaffold the shell",
        ownerUserName: "Morgan Fixture",
      },
      {
        ...mergedSession,
        sessionId: "s2",
        slug: "sess-two",
        name: "Fixture: split the empty states",
        startedAt: "2026-06-18T10:00:00.000Z",
        endedAt: "2026-06-18T11:00:00.000Z",
        isPrimary: false,
        estimatedCostUsd: (mergedSession.estimatedCostUsd ?? 0) * 0.5,
        ownerUserName: "Alice Fixture",
      },
    ]
  : [];
const BRANCH_SESSION_COST_USD = BRANCH_SESSIONS.reduce(
  (sum, session) => sum + (session.estimatedCostUsd ?? 0),
  0
);
const branchLevel = {
  sessions: BRANCH_SESSIONS,
  sessionIds: BRANCH_SESSIONS.map((session) => session.sessionId),
  estimatedCostUsd: BRANCH_SESSION_COST_USD,
  linkedPrNumbers: [1270, 1284],
};

const openPullRequest: BranchSelectedPullRequestDetail = {
  ...mergedPullRequest,
  id: OPEN_PR_ID,
  number: 1284,
  title: "Fixture: tighten Branch detail empty states",
  url: "https://github.com/owner/repo/pull/1284",
  state: GitHubPRState.Open,
  reviewDecision: ReviewDecision.ChangesRequested,
  openedAt: "2026-06-18T09:00:00.000Z",
  closedAt: null,
  mergedAt: null,
  body: "Fixture: splits the awaiting-sync and not-present states.",
  headRefOid: "d".repeat(40),
  mergeCommitSha: null,
  changedFiles: 2,
  additions: 64,
  deletions: 12,
};

function associatedItem(
  pullRequest: BranchSelectedPullRequestDetail
): BranchAssociatedPullRequest {
  return {
    id: pullRequest.id,
    repositoryFullName: pullRequest.repositoryFullName,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    reviewDecision: pullRequest.reviewDecision,
    openedAt: pullRequest.openedAt,
    closedAt: pullRequest.closedAt,
    mergedAt: pullRequest.mergedAt,
  };
}

/** The producer picks the open PR (`Active`); any other pick is the user's. */
function collectionSelecting(selectedId: string) {
  return {
    items: [associatedItem(openPullRequest), associatedItem(mergedPullRequest)],
    selectedId,
    selectionReason:
      selectedId === OPEN_PR_ID
        ? BranchAssociatedPullRequestSelectionReason.Active
        : BranchAssociatedPullRequestSelectionReason.Explicit,
    completeness: {
      state: BranchAssociatedPullRequestCompletenessState.Complete,
      reasons: [],
      provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
    },
  };
}

function openPhaseAttribution(): BranchPhaseAttributionResult {
  const merged = completePhaseAttribution();
  const segments = merged.segments.map((segment) => ({
    ...segment,
    sessionId: "s2",
    startMs: segment.startMs + OPEN_PR_SHIFT_MS,
    endMs: segment.endMs + OPEN_PR_SHIFT_MS,
    estimatedCostUsd: segment.estimatedCostUsd * OPEN_PR_COST_SCALE,
  }));
  return {
    segments,
    rollups: merged.rollups.map((rollup) => ({
      ...rollup,
      estimatedCostUsd: rollup.estimatedCostUsd * OPEN_PR_COST_SCALE,
    })),
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: segments.reduce(
        (sum, segment) => sum + segment.estimatedCostUsd,
        0
      ),
    },
  };
}

const mergedDetail: BranchPageDetail = {
  ...mergedBase,
  ...branchLevel,
  prTitle: mergedPullRequest.title,
  prBody: mergedPullRequest.body,
  selectedPullRequest: mergedPullRequest,
  associatedPullRequests: collectionSelecting(MERGED_PR_ID),
};

const openAttribution = openPhaseAttribution();
const openCostUsd = openAttribution.segments.reduce(
  (sum, segment) => sum + segment.estimatedCostUsd,
  0
);
const openChecks = completeSelectedPullRequestChecks({
  headSha: openPullRequest.headRefOid ?? "d".repeat(40),
  number: openPullRequest.number,
  url: openPullRequest.url ?? "",
});

const openDetail: BranchPageDetail = {
  ...mergedBase,
  ...branchLevel,
  status: BranchStatus.Open,
  prNumber: openPullRequest.number,
  prTitle: openPullRequest.title,
  prState: openPullRequest.state,
  prUrl: openPullRequest.url,
  checksStatus: ChecksStatus.Passing,
  checksPassed: null,
  checksTotal: 3,
  selectedPullRequestChecksProjection: {
    headSha: openPullRequest.headRefOid ?? "d".repeat(40),
    providerState: BranchViewChecksProviderState.Available,
    unavailableReason: null,
    totalCount: 3,
    truncated: false,
    items: [
      {
        id: "build",
        kind: BranchViewCheckKind.CheckRun,
        name: "Build",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        targetUrl: null,
      },
    ],
  },
  selectedPullRequestChecks: openChecks,
  reviewDecision: openPullRequest.reviewDecision,
  additions: openPullRequest.additions ?? 0,
  deletions: openPullRequest.deletions ?? 0,
  filesChanged: openPullRequest.changedFiles ?? 0,
  prBody: openPullRequest.body,
  prBodyHtmlUrl: openPullRequest.url,
  headSha: openPullRequest.headRefOid,
  mergeCommitSha: null,
  mergedAt: null,
  closedAt: null,
  openedAt: openPullRequest.openedAt,
  linkedArtifacts: [{ slug: "FEA-1952" }],
  associatedPullRequests: collectionSelecting(OPEN_PR_ID),
  selectedPullRequest: openPullRequest,
  phaseAttribution: openAttribution,
  canonicalMetrics: calculateBranchDetailMetrics({
    attributedCostUsd: openCostUsd,
    phaseAttribution: openAttribution,
    selectedCycle: branchMetricCycleFromPullRequest(
      associatedItem(openPullRequest),
      openPullRequest.openedAt
    ),
    selectedPrAdditions: openPullRequest.additions ?? null,
    selectedPrDeletions: openPullRequest.deletions ?? null,
    selectedPrLocComplete: true,
  }),
};

const DETAIL_BY_PULL_REQUEST: Readonly<Record<string, BranchPageDetail>> = {
  [MERGED_PR_ID]: mergedDetail,
  [OPEN_PR_ID]: openDetail,
};

/**
 * The detail the producer returns before any user pick. Branch-level panels
 * (Properties) read this, not the selected PR, exactly as production does.
 */
export const BRANCH_DESIGN_BASE_DETAIL = openDetail;

/** The whole Branch detail as production reads it for one selected PR. */
export function branchDesignDetailFor(pullRequestId: string): BranchPageDetail {
  return DETAIL_BY_PULL_REQUEST[pullRequestId] ?? openDetail;
}

/** Per-file rows behind the Files changed stand-in; totals match the detail. */
export const BRANCH_DESIGN_FILES: Readonly<
  Record<
    string,
    readonly { additions: number; deletions: number; path: string }[]
  >
> = {
  [MERGED_PR_ID]: [
    {
      additions: 100,
      deletions: 10,
      path: "packages/app/branches/branch-detail.tsx",
    },
    {
      additions: 60,
      deletions: 8,
      path: "packages/app/branches/branch-detail.css",
    },
    { additions: 20, deletions: 6, path: "e2e/branch-details.spec.ts" },
  ],
  [OPEN_PR_ID]: [
    {
      additions: 48,
      deletions: 9,
      path: "packages/app/branches/components/branch-detail-states.tsx",
    },
    { additions: 16, deletions: 3, path: "e2e/branch-details.spec.ts" },
  ],
};

/**
 * The Branch as the shared Details tab and comments rail read it, derived
 * from the same detail. Fictional people only; the Details layout is
 * ISS-10792's.
 */
export const BRANCH_DESIGN_ARTIFACT: GenericArtifact = {
  id: `branch-design-${openDetail.id}`,
  // Branches carry no Closedloop slug; production identifies them by name.
  slug: openDetail.branchName,
  title: openDetail.branchName,
  summary: "Fixture: the Branch Detail shell work.",
  kind: ArtifactKind.Branch,
  status: ArtifactStatus.Active,
  statusRaw: openDetail.status,
  owner: "Alice Fixture",
  ownerInitials: "AF",
  collaborators: ["Morgan Fixture", "Pascoe Fixture", "Sam Fixture"],
  repository: openDetail.repoFullName,
  project: null,
  tags: [],
  commentCount: 2,
  currentVersion: "1",
  updated: "2h ago",
  updatedAgoMinutes: 120,
  createdAgoDays: 1,
  aiSpend: BRANCH_SESSION_COST_USD,
  timeToReadyMinutes: 60,
  outcomeScore: 80,
  activityCount: 4,
  relationshipCount: openDetail.linkedArtifacts.length,
};

/**
 * ISS-12252: the values the Details tab reads, from the same detail, so
 * the tab describes the branch the page header names.
 */
const FIRST_SESSION = BRANCH_SESSIONS[0];
const OPEN_CHANGES = {
  additions: openDetail.additions ?? 0,
  deletions: openDetail.deletions ?? 0,
};
/** One pull request's lines as branch-lifetime publication LOC evidence. */
function lifetimeLoc(
  pullRequest: BranchSelectedPullRequestDetail
): BranchMetricLocContribution {
  return {
    sourceEventId: `pull-request:${pullRequest.id}`,
    changeIdentity: pullRequest.id,
    branchId: openDetail.id,
    occurredAt: pullRequest.mergedAt ?? pullRequest.openedAt,
    additions: pullRequest.additions ?? null,
    deletions: pullRequest.deletions ?? null,
  };
}

/**
 * The branch's LOC/$ as the metric contract defines it: branch-lifetime
 * publication LOC (both pull requests, 204 + 76 lines) over the cost of every
 * session on the branch. The Changes row stays the selected PR's +/-.
 */
const BRANCH_LIFETIME_METRICS = calculateBranchDetailMetrics({
  attributedCostUsd: BRANCH_SESSION_COST_USD,
  lifetimeLocContributions: [
    lifetimeLoc(mergedPullRequest),
    lifetimeLoc(openPullRequest),
  ],
  lifetimeLocCoverageComplete: true,
  phaseAttribution: openAttribution,
  qualifyingSessionCount: BRANCH_SESSIONS.length,
  selectedCycle: null,
  selectedPrAdditions: null,
  selectedPrDeletions: null,
  selectedPrLocComplete: false,
});

/** The Branches list's origin chip: Agent or Bot, and nothing for a person's. */
const BRANCH_ORIGIN_LABELS: Readonly<
  Record<BranchProvenance, string | undefined>
> = {
  [BranchProvenance.Agent]: "Agent",
  [BranchProvenance.Bot]: "Bot",
  [BranchProvenance.Human]: undefined,
};

const sumSessions = (
  key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
) => BRANCH_SESSIONS.reduce((sum, session) => sum + session[key], 0);

export const BRANCH_DESIGN_DETAILS_INPUT: BranchDetailsTabInput = {
  name: openDetail.branchName,
  status: openDetail.status,
  owner: BRANCH_DESIGN_ARTIFACT.owner,
  // The people the tab row's avatars show.
  collaborators: BRANCH_DESIGN_ARTIFACT.collaborators,
  // Created with its first session; last touched when its last one ended.
  createdBy: FIRST_SESSION?.ownerUserName ?? BRANCH_DESIGN_ARTIFACT.owner,
  createdAt: FIRST_SESSION?.startedAt ?? "",
  updatedAt: BRANCH_SESSIONS.at(-1)?.endedAt ?? "",
  // As the page's artifact has them: no project, priority, due date or tags.
  project: BRANCH_DESIGN_ARTIFACT.project,
  priority: null,
  dueDate: null,
  tags: BRANCH_DESIGN_ARTIFACT.tags,
  // The page's linked artifacts, and the sessions that produced the branch.
  associated: [
    ...openDetail.linkedArtifacts.map((linked, index) =>
      detailsAssociatedRecord({
        end: DetailsLinkEnd.Target,
        href: null,
        // Fixture: the first is the issue the branch implements; the rest are
        // peers.
        linkType:
          index === 0 ? DetailsLinkType.Produces : DetailsLinkType.RelatesTo,
        name: "",
        slug: linked.slug,
      })
    ),
    ...BRANCH_SESSIONS.map((session) =>
      detailsAssociatedRecord({
        end: DetailsLinkEnd.Target,
        href: null,
        linkType: DetailsLinkType.Produces,
        name: session.name ?? "",
        slug: session.slug ?? session.sessionId,
        type: "SES",
      })
    ),
  ],
  repository: openDetail.repoFullName ?? "",
  // The PR status panel's own badge for the selected pull request.
  pullRequest: {
    state: createElement(LifecycleBadgeChip, {
      badge: deriveLifecycleBadge({
        persisted: {
          prState: openPullRequest.state,
          status: openDetail.status,
        },
      }),
    }),
    href: openPullRequest.url,
    number: openPullRequest.number,
    title: openPullRequest.title ?? "",
  },
  // The Branches grid's rollup ("N/N passing"); every check passed.
  checks: `${openDetail.checksTotal ?? 0}/${openDetail.checksTotal ?? 0} passing`,
  changes: OPEN_CHANGES,
  cost: formatCostPrecise(BRANCH_SESSION_COST_USD),
  locPerDollar: formatLocPerDollar(BRANCH_LIFETIME_METRICS.locPerDollar.value),
  sessions: BRANCH_SESSIONS.length,
  // What the page's detail has; it has no branch-ref head, reviewers, commits
  // or lead time, so those rows are left out.
  more: {
    baseBranch: openDetail.baseBranch ?? undefined,
    headSha: openDetail.branchHeadSha ?? undefined,
    origin:
      BRANCH_ORIGIN_LABELS[classifyBranchProvenance(openDetail.branchName)],
    filesChanged: openDetail.filesChanged ?? undefined,
    reviewDecision: openPullRequest.reviewDecision
      ? ReviewDecisionLabel[openPullRequest.reviewDecision]
      : undefined,
    prOpenedAt: openPullRequest.openedAt ?? undefined,
    tokens: {
      input: sumSessions("inputTokens"),
      output: sumSessions("outputTokens"),
      cacheRead: sumSessions("cacheReadTokens"),
      cacheWrite: sumSessions("cacheWriteTokens"),
    },
  },
};

/** Closedloop comments are branch-level: one list whatever PR is selected. */
export const BRANCH_DESIGN_NATIVE_COMMENTS: readonly GenericCommentRecord[] = [
  {
    id: "branch-design-comment-native",
    author: "Morgan Fixture",
    body: "Fixture: the cost breakdown reads well against the waterfall.",
    context: "Branch comment",
    time: "2h ago",
    anchor: { kind: CommentAnchorKind.Artifact },
    source: { provider: "native" },
    status: "open",
  },
];

/**
 * GitHub PR comments, keyed by PR: production loads provider comments for the
 * selected PR only, so they change with the selector.
 */
export const BRANCH_DESIGN_PROVIDER_COMMENTS: Readonly<
  Record<string, readonly GenericCommentRecord[]>
> = {
  [OPEN_PR_ID]: [
    {
      id: "branch-design-comment-github-1284",
      author: "octocat",
      body: "Fixture: please split the awaiting-sync state into its own file.",
      context: "GitHub PR #1284",
      time: "1h ago",
      anchor: { kind: CommentAnchorKind.Artifact },
      source: { provider: "github", readOnly: true },
      status: "open",
    },
  ],
  [MERGED_PR_ID]: [
    {
      id: "branch-design-comment-github-1270",
      author: "octocat",
      body: "Fixture: approved, the shell matches the handoff.",
      context: "GitHub PR #1270",
      time: "1d ago",
      anchor: { kind: CommentAnchorKind.Artifact },
      source: { provider: "github", readOnly: true },
      status: "resolved",
    },
  ],
};
