import {
  BranchFileCacheStatus,
  BranchHeadShaSource,
  type BranchPushSource,
} from "@repo/api/src/types/artifact";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import {
  branchCostEvidenceByteBudget,
  branchCostEvidenceFixedRowBytes,
  branchCostEvidenceRowBudget,
} from "@repo/api/src/types/branch-usage";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  type ArtifactSubtype,
  type ArtifactType,
  GitHubInstallationStatus,
} from "@repo/database";
import { type Mock, vi } from "vitest";
import { resolveMockPullRequestDetails } from "@/__tests__/fixtures/branch-pull-request-details";
import {
  EMPTY_BRANCH_FILE_CHANGE_TOTALS_FIXTURE,
  seededFileChangeGroups,
  seedRowFileChanges,
} from "@/__tests__/support/branches/branch-file-change-totals.test-helpers";
import { branchServerPageMockRows } from "@/__tests__/support/branches/branch-server-page.test-mocks";
import { mockPullRequestCommentProofRows } from "@/__tests__/support/branches/pull-request-comment-proof.test-mocks";
import type { PersistedBranchActivityAtom } from "@/app/branches/branch-activity-evidence";
import type { BranchDetailArtifactRow } from "@/app/branches/branch-read-service/persisted-row-read";
import {
  makePushSessionLink as buildPushSessionLink,
  makeSessionLink as buildSessionLink,
  makeSuccessfulReviewSessionLink as buildSuccessfulReviewSessionLink,
} from "./branch-evidence-link.test-fixtures";

// Shared canned fixtures + mock-DB builder for the branchReadService test suites.
// Extracted from `branch-read-service.test.ts` (FEA-4270) so the focused
// `branch-read-service.date-window.test.ts` sibling reuses the exact same
// fixture wiring without duplicating it — and so the grandfathered main test
// file shrinks back toward its ceiling. Pure fixtures only; no `vi.mock`/hoisted
// module mocks (those stay per-suite because they are file-scoped and hoisted).

export const branchId = "11111111-1111-4111-8111-111111111111";
// FEA-4331 — a SECOND page branch for the multi-branch even-split cost tests: one
// session links to both `branchId` and `branchIdB`, so its cost must split across
// them (branch-read-service.cost.test.ts).
export const branchIdB = "33333333-3333-4333-8333-333333333333";
export const contributorUserId = "22222222-2222-7222-8222-222222222222";
export const organizationId = "org-1";
export const branchProjectId = "project-1";
export const now = new Date("2026-07-03T05:00:00.000Z");

export type MockReview = {
  githubReviewId: string;
  authorLogin: string;
  authorAvatarUrl: string | null;
  state: ReviewDecision;
  htmlUrl: string | null;
  submittedAt: Date;
};

export type MockPrDetail = {
  id: string;
  branchArtifactId: string;
  repositoryId: string | null;
  repositoryFullName: string | null;
  repository: { fullName: string; githubRepoId: string } | null;
  isCurrent: boolean;
  number: number;
  // Nullable, like the column: a PR row nobody fetched carries no title, and
  // ISS-8422 reads that absence as evidence the row observed nothing.
  title: string | null;
  htmlUrl: string;
  body: string;
  prState: GitHubPRState;
  isDraft: boolean;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  fetchMechanism: string | null;
  githubId: string | null;
  reviewDecision: ReviewDecision | null;
  reviews: MockReview[];
  githubCreatedAt: Date | null;
  closedAt: Date | null;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
  headRefName: string | null;
  headRefOid: string | null;
  headRepositoryFullName: string | null;
  /** ISS-11752: PR authorship is branch-owner evidence on every branch read. */
  authorLogin: string | null;
  lastVerifiedAt: Date | null;
  lastRefreshAttemptAt: Date | null;
};

// The mock Prisma surface the branch reads touch. An explicit shape (rather than
// an inferred one) keeps `ReturnType<typeof createMockDb>` portable across the
// module boundary — the inferred `@vitest/spy` Mock type is not nameable in a
// consuming file (TS2742).
export type MockDb = {
  $queryRaw: Mock;
  artifact: { count: Mock; findMany: Mock; findFirst: Mock; updateMany: Mock };
  artifactLink: { findMany: Mock };
  comment: { findMany: Mock };
  branchDetail: { updateMany: Mock; findMany: Mock };
  branchPushContribution: { findMany: Mock };
  externalCommentAuthor: { findMany: Mock };
  branchStatusCheck: { deleteMany: Mock };
  commentThread: { findMany: Mock };
  gitHubCommentProjection: { findMany: Mock };
  gitHubCommentThreadProjection: { findMany: Mock };
  gitHubUserConnection: { findMany: Mock };
  commitDetail: { findMany: Mock };
  oAuthRateLimit: { findUnique: Mock; create: Mock; updateMany: Mock };
  pullRequestDetail: {
    findFirst: Mock;
    findUnique: Mock;
    findMany: Mock;
    updateMany: Mock;
  };
  repositoryDefaultObservationReceipt: { createMany: Mock };
  user: { findMany: Mock };
  agentSessionActivitySegment: { findMany: Mock };
  agentSessionTokenEvent: { findMany: Mock; groupBy: Mock };
  branchFileChange: { groupBy: Mock };
  branchActivityAtom: { findMany: Mock };
  customFieldValue: { findMany: Mock };
};

const branchCandidateRawResponses = new WeakMap<MockDb, unknown[][]>();

export function createMockDb(): MockDb {
  const mockDb: MockDb = {
    // FEA-4225: the by-id detail read gates on `branchHasLinkedSession`, a
    // `$queryRaw` EXISTS that must return a row for a branch the test has already
    // mocked as present via `artifact.findFirst`. Default to one eligibility row so
    // every existing detail/trace/refresh test (which seeds a valid session link
    // through `artifactLink.findMany`) stays eligible. List/facet/analytics tests
    // override this per call with `mockResolvedValueOnce` (which takes precedence),
    // and the FEA-4225 eligibility test asserts the zero-session path explicitly.
    $queryRaw: vi.fn(),
    artifact: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    artifactLink: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // ISS-10298: the branch reads fold file-cache LOC in SQL instead of loading
    // per-file rows, so this answers from the branch rows the test already
    // seeded on the artifact mocks. Returning a fixed `[]` instead would blank
    // every fixture's LOC and quietly turn the LOC assertions across this suite
    // into assertions about an empty cache.
    branchFileChange: {
      groupBy: vi.fn((args: unknown) =>
        seededFileChangeGroups(mockDb.artifact, args)
      ),
    },
    // ISS-10009 part 2: the per-push LOC read. Defaults to NO captured pushes,
    // the pre-capture state every pre-existing fixture here describes; seeding a
    // push instead would silently move this suite's LOC assertions.
    branchActivityAtom: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    comment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    branchDetail: {
      updateMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    branchPushContribution: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    externalCommentAuthor: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    branchStatusCheck: {
      deleteMany: vi.fn(),
    },
    commentThread: {
      findMany: vi.fn(),
    },
    gitHubCommentProjection: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    gitHubCommentThreadProjection: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    gitHubUserConnection: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    commitDetail: {
      findMany: vi.fn(),
    },
    oAuthRateLimit: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    pullRequestDetail: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
    },
    repositoryDefaultObservationReceipt: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    // Owner attribution (FEA-3457): the batched, org-scoped display-name lookup.
    // Defaults to no users so owner resolves to null unless a test seeds it.
    user: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // FEA-2276: the activity-segment tiling + per-turn spend reads
    // attachBranchActivitySegments issues on every non-empty getBranchDetail.
    // Default to none so existing detail tests exercise the no-tiling path; the
    // rollup tests below seed rows per-case.
    agentSessionActivitySegment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentSessionTokenEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    // ISS-12663: the list's custom-field value read. Defaults to no values, so
    // every list row carries the successful-and-empty `customFields: []`.
    customFieldValue: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  branchCandidateRawResponses.set(mockDb, []);
  mockDb.$queryRaw.mockImplementation((query) =>
    defaultBranchReadQueryRaw(mockDb, query)
  );
  return mockDb;
}

export function mockBranchCandidatePage(
  mockDb: ReturnType<typeof createMockDb>,
  ids: string[],
  total = ids.length,
  activityById: ReadonlyMap<string, PersistedBranchActivityAtom> = new Map()
) {
  queueBranchCandidateRawResponse(
    mockDb,
    ids.length === 0
      ? [mockCandidateSnapshotRow(null, total)]
      : ids.map((id) =>
          mockCandidateSnapshotRow(id, total, activityById.get(id))
        )
  );
}

export function mockBranchCandidateIds(
  mockDb: ReturnType<typeof createMockDb>,
  ids: string[],
  activityById: ReadonlyMap<string, PersistedBranchActivityAtom> = new Map()
) {
  queueBranchCandidateRawResponse(
    mockDb,
    ids.map((id) => mockCandidateSnapshotRow(id, 0, activityById.get(id)))
  );
}

export function makeBaseCurrentPullRequestDetail(): MockPrDetail {
  return {
    id: "pr-detail-1",
    branchArtifactId: branchId,
    repositoryId: "repo-1",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    repository: {
      fullName: "closedloop-ai/closedloop-ai",
      githubRepoId: "gh-repo-1",
    },
    isCurrent: true,
    number: 7,
    title: "PR title",
    htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/7",
    body: "body",
    prState: GitHubPRState.Open,
    isDraft: false,
    additions: null,
    deletions: null,
    changedFiles: null,
    fetchMechanism: null,
    githubId: null,
    reviewDecision: null,
    reviews: [],
    // ISS-8422: the base fixture models an OBSERVED pull request. A row with no
    // lifecycle evidence at all reads `pr_state` off its `@default(OPEN)`, and
    // the read path now reports that as no observed state rather than as Open,
    // so a fixture left at null would silently exercise the unobserved path in
    // every suite that only wants an ordinary PR. Override it to null in the
    // cases that are about observation.
    githubCreatedAt: now,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    headRefName: "feature",
    headRefOid: "abc",
    headRepositoryFullName: "closedloop-ai/closedloop-ai",
    authorLogin: null,
    lastVerifiedAt: null,
    lastRefreshAttemptAt: null,
  };
}

export function makeCurrentPullRequestDetail(
  overrides: Partial<MockPrDetail> = {}
) {
  return { ...makeBaseCurrentPullRequestDetail(), ...overrides };
}

export function makeReview(overrides: Partial<MockReview> = {}): MockReview {
  return {
    githubReviewId: overrides.githubReviewId ?? "review-1",
    authorLogin: overrides.authorLogin ?? "reviewer",
    authorAvatarUrl: overrides.authorAvatarUrl ?? null,
    state: overrides.state ?? ReviewDecision.Approved,
    htmlUrl: overrides.htmlUrl ?? null,
    submittedAt: overrides.submittedAt ?? now,
  };
}

export function makePersistedBranchActivityAtom(
  overrides: Partial<PersistedBranchActivityAtom> = {}
): PersistedBranchActivityAtom {
  return {
    version: BranchActivityAtomVersion.V1,
    source: BranchActivitySource.GitHead,
    sourceEventId: "activity-1",
    occurredAt: now,
    attributionKind: BranchActivityAttributionKind.Branch,
    pullRequestDetailId: null,
    completeness: BranchActivityEvidenceCompleteness.Complete,
    ...overrides,
  };
}

export function makeBranchRow(
  overrides: {
    id?: string;
    branchName?: string;
    currentPullRequestDetail?: MockPrDetail | null;
    // `additions`/`deletions` are `Int?` (BranchFileChange) — nullable per-file
    // until that file's LOC enriches, so a partial cache is representable.
    fileChanges?: {
      additions: number | null;
      deletions: number | null;
      path: string;
    }[];
    // ISS-6127: the provider's completeness verdict, stored beside freshness.
    // Defaults false so existing fixtures read as complete, exactly as the
    // column's own default does for rows written before the migration.
    fileCacheCapped?: boolean;
    fileCacheFileCount?: number;
    fileCacheStatus?: BranchFileCacheStatus;
    firstPushedAt?: Date | null;
    activityAtoms?: PersistedBranchActivityAtom[];
    /** ISS-11915: the candidate snapshot's linked-session Last-active fallback. */
    linkedSessionActivityAt?: Date | null;
    headSha?: string | null;
    // The head the file-cache LOC was last refreshed FOR (FEA-4268). Defaults to
    // the branch's own `headSha` so a populated `fileChanges` cache reads as
    // CURRENT — the normal enriched-branch case that feeds `currentFileTotals`.
    // A deliberately-STALE fixture sets this to an OLD sha (or null) so the cache
    // is gated out and display/analytics fall back, mirroring a failed/pending
    // refresh that `refreshBranchFileChangeCache` left on the prior sha.
    fileCacheHeadSha?: string | null;
    headShaSource?: BranchHeadShaSource | null;
    headShaObservedAt?: Date | null;
    // ISS-8241 Half A: the stored current-head checks projection. Defaults leave
    // it UNWRITTEN (`checksDetailHeadSha: null`), which is the honest state for
    // every fixture that never claimed to have measured a head's checks.
    checksStatus?: ChecksStatus;
    checksDetailTotalCount?: number;
    checksDetailHeadSha?: string | null;
    checksDetailProviderState?: string | null;
    checksDetailUpdatedAt?: Date | null;
    statusChecks?: {
      providerKey: string;
      headSha: string;
      kind: string;
      name: string;
      status: string | null;
      conclusion: string | null;
      targetUrl: string | null;
      position: number;
    }[];
    lastSyncCompletedAt?: Date | null;
    pullRequestDetails?: MockPrDetail[];
    pushSource?: BranchPushSource | null;
    // `null` models a non-App branch (PRD-510 D2/FR8): no installation-repo row,
    // identity carried solely by repositoryFullName.
    repositoryId?: string | null;
    repositoryFullName?: string;
    repositoryRemovedAt?: Date | null;
    organizationId?: string;
    projectId?: string | null;
    status?: string;
    syncStatus?: string;
    tagArtifacts?: {
      tag: {
        id: string;
        name: string;
        color: string;
        organizationId: string;
      };
    }[];
    targetLinks?: Array<{
      id: string;
      createdAt: Date;
      source: {
        id: string;
        type: ArtifactType;
        subtype: ArtifactSubtype | null;
        name: string;
        slug: string | null;
        externalUrl: string | null;
      };
    }>;
    // ISS-12197: the Artifact row's Details-tab fields; unset by default.
    slug?: string | null;
    updatedAt?: Date;
    dueDate?: Date | null;
    assignee?: BranchDetailArtifactRow["assignee"];
    createdBy?: BranchDetailArtifactRow["createdBy"];
    project?: BranchDetailArtifactRow["project"];
  } = {}
): BranchDetailArtifactRow {
  const id = overrides.id ?? branchId;
  const resolvedHeadSha =
    "headSha" in overrides ? (overrides.headSha ?? null) : "abc";
  const repositoryId =
    "repositoryId" in overrides ? (overrides.repositoryId ?? null) : "repo-1";
  const repositoryFullName =
    overrides.repositoryFullName ?? "closedloop-ai/closedloop-ai";
  const currentPullRequestDetail =
    "currentPullRequestDetail" in overrides
      ? (overrides.currentPullRequestDetail ?? null)
      : makeCurrentPullRequestDetail({
          branchArtifactId: id,
          repositoryId,
          repository: repositoryId
            ? {
                fullName: repositoryFullName,
                githubRepoId: "gh-repo-1",
              }
            : null,
          repositoryFullName,
        });
  const pullRequestDetails = resolveMockPullRequestDetails(
    overrides,
    currentPullRequestDetail
  );
  const row = {
    id,
    // Top-level Artifact.organizationId — the org SSOT the by-id branch reads
    // assert against (FEA-2734). Defaults to the owning org so resolver mocks
    // pass resolveOrgScope(); cross-org cases override it explicitly.
    organizationId: overrides.organizationId ?? organizationId,
    projectId:
      "projectId" in overrides
        ? (overrides.projectId ?? null)
        : branchProjectId,
    name: "feature",
    status: overrides.status ?? GitHubPRState.Open,
    priority: null,
    _count: { pullRequestDetails: pullRequestDetails.length },
    externalUrl: null,
    createdAt: now,
    tagArtifacts: overrides.tagArtifacts ?? [],
    targetLinks: overrides.targetLinks ?? [],
    slug: overrides.slug ?? null,
    updatedAt: overrides.updatedAt ?? now,
    dueDate: overrides.dueDate ?? null,
    assigneeId: overrides.assignee?.id ?? null,
    assignee: overrides.assignee ?? null,
    createdBy: overrides.createdBy ?? null,
    project: overrides.project ?? null,
    branch: {
      artifactId: id,
      repositoryId,
      repositoryFullName,
      branchName: overrides.branchName ?? "feature",
      baseBranch: "main",
      deletedAt: null,
      headSha: resolvedHeadSha,
      // Current-by-default: a populated `fileChanges` cache describes the branch's
      // current head unless a fixture opts into a stale/absent sha (FEA-4268).
      fileCacheHeadSha:
        "fileCacheHeadSha" in overrides
          ? (overrides.fileCacheHeadSha ?? null)
          : resolvedHeadSha,
      headShaSource:
        "headShaSource" in overrides
          ? (overrides.headShaSource ?? null)
          : BranchHeadShaSource.PushWebhook,
      headShaObservedAt:
        "headShaObservedAt" in overrides
          ? (overrides.headShaObservedAt ?? null)
          : now,
      // FR12 visibility SSOT — default null (unpushed); tests opt into push
      // visibility explicitly, mirroring the set-once producer stamp.
      firstPushedAt:
        "firstPushedAt" in overrides ? (overrides.firstPushedAt ?? null) : null,
      pushSource:
        "pushSource" in overrides ? (overrides.pushSource ?? null) : null,
      activityAtoms: overrides.activityAtoms ?? [],
      linkedSessionActivityAt: overrides.linkedSessionActivityAt ?? null,
      syncStatus: overrides.syncStatus ?? "idle",
      lastSyncStartedAt: null,
      lastSyncCompletedAt: overrides.lastSyncCompletedAt ?? null,
      lastSyncErrorCode: null,
      checksStatus: overrides.checksStatus ?? ChecksStatus.Unknown,
      checksDetailTotalCount: overrides.checksDetailTotalCount ?? 0,
      checksDetailHeadSha: overrides.checksDetailHeadSha ?? null,
      checksDetailTruncated: false,
      checksDetailProviderState: overrides.checksDetailProviderState ?? null,
      checksDetailUnavailableReason: null,
      checksDetailUpdatedAt: overrides.checksDetailUpdatedAt ?? null,
      statusChecks: overrides.statusChecks ?? [],
      repository: repositoryId
        ? {
            id: repositoryId,
            fullName: repositoryFullName,
            githubRepoId: "gh-repo-1",
            name: "closedloop-ai",
            owner: "closedloop-ai",
            removedAt: overrides.repositoryRemovedAt ?? null,
            installation: {
              organizationId,
              installationId: "installation-1",
              status: GitHubInstallationStatus.ACTIVE,
            },
          }
        : null,
      currentPullRequestDetail,
      fileCacheCapped: overrides.fileCacheCapped ?? false,
      fileCacheStatus:
        overrides.fileCacheStatus ?? BranchFileCacheStatus.Absent,
      fileCacheFileCount: overrides.fileCacheFileCount ?? 0,
      // ISS-10298: deliberately the UNKNOWN value, never the fixture's own
      // totals. `applyBranchFileChangeTotals` is the only production source, so
      // a fixture that answered here would keep every LOC assertion in the suite
      // green after that attach was deleted. The files go to the mocked
      // `branchFileChange.groupBy` instead, via `seedRowFileChanges` below.
      fileChangeTotals: EMPTY_BRANCH_FILE_CHANGE_TOTALS_FIXTURE,
    },
    pullRequestDetails,
  };
  seedRowFileChanges(row, overrides.fileChanges ?? []);
  return row;
}
/** Compatibility entrypoint for the shared link fixture. */
export function makeSessionLink(...args: Parameters<typeof buildSessionLink>) {
  return buildSessionLink(...args);
}

// A session→branch link whose source SESSION has NO `SessionDetail` row
// (`source.session === null`): an orphaned/half-synced link that is not a valid
// session. `accumulateSessionLink` skips it up front, so it contributes neither a
// sessionId nor cost/tokens — windowed or not (FEA-4263 / FEA-4270).
export function makeOrphanSessionLink(targetId: string) {
  return {
    targetId,
    sourceId: `${targetId}-orphan`,
    branchParticipation: null,
    metadata: null,
    source: { session: null },
  };
}

/**
 * FEA-4270: one `AgentSessionTokenEvent` row as `resolveWindowedSpendBySession`
 * selects it — the per-EVENT token/cost the windowed branch-spend read sums.
 * `eventCreatedAt` is the per-turn instant the window keys on. A `null` timestamp
 * models an event that cannot be placed in a bounded window (excluded).
 */
export function makeTokenEvent(
  agentSessionId: string,
  eventCreatedAt: Date | null,
  overrides: {
    inputTokens?: number | bigint;
    outputTokens?: number | bigint;
    cacheReadTokens?: number | bigint;
    cacheWriteTokens?: number | bigint;
    estimatedCost?: string | number;
    sourceIdentity?: unknown;
  } = {}
) {
  return {
    agentSessionId,
    eventCreatedAt,
    inputTokens: overrides.inputTokens ?? 0n,
    outputTokens: overrides.outputTokens ?? 0n,
    cacheReadTokens: overrides.cacheReadTokens ?? 0n,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 0n,
    estimatedCost: {
      toString: () => String(overrides.estimatedCost ?? "0"),
    },
    sourceIdentity: overrides.sourceIdentity ?? null,
    costCompleteness: null,
    costCompletenessReason: null,
    subscriptionEquivalentCost: null,
    apiEstimatedCost: null,
  };
}

/**
 * Make both token-event query shapes return the given per-event rows, scoped to
 * the requested session ids and optional event timestamp window. The aggregate
 * mock mirrors Prisma's per-session sums; the row mock supplies bounded cost
 * evidence samples for completeness classification.
 */
export function mockTokenEvents(
  mockDb: ReturnType<typeof createMockDb>,
  events: ReturnType<typeof makeTokenEvent>[]
) {
  mockDb.$queryRaw.mockImplementation((query) => {
    const sql = renderSql(query);
    if (
      !(
        sql.includes("WITH requested_sessions AS MATERIALIZED") ||
        sql.includes("WITH evidence_size AS MATERIALIZED")
      )
    ) {
      return Promise.resolve([mockCandidateSnapshotRow(branchId)]);
    }
    const values = collectSqlValues(query);
    const wanted = values.filter(
      (value): value is string =>
        typeof value === "string" &&
        events.some((event) => event.agentSessionId === value)
    );
    const dates = values.filter(
      (value): value is Date => value instanceof Date
    );
    const eventCreatedAt = {
      ...(sql.includes("event.event_created_at >=") ? { gte: dates[0] } : {}),
      ...(sql.includes("event.event_created_at <=")
        ? { lte: dates.at(-1) }
        : {}),
    };
    const filtered = filterMockTokenEvents(events, {
      where: {
        agentSessionId: { in: wanted },
        ...(dates.length === 0 ? {} : { eventCreatedAt }),
      },
    });
    if (sql.includes("WITH requested_sessions AS MATERIALIZED")) {
      return Promise.resolve(aggregateMockTokenEventRows(filtered));
    }
    const retainedBytes = filtered.reduce(
      (total, event) =>
        total +
        Buffer.byteLength(JSON.stringify(event.sourceIdentity ?? null)) +
        branchCostEvidenceFixedRowBytes,
      0
    );
    if (
      filtered.length > branchCostEvidenceRowBudget ||
      retainedBytes > branchCostEvidenceByteBudget
    ) {
      return Promise.resolve([
        mockCloudEvidenceMetadataRow(filtered.length, retainedBytes),
      ]);
    }
    if (filtered.length === 0) {
      return Promise.resolve([mockCloudEvidenceMetadataRow(0, 0)]);
    }
    return Promise.resolve(
      filtered.map((event, index) => ({
        id: `mock-event-${index}`,
        ...event,
        evidenceBytes: branchCostEvidenceFixedRowBytes,
        evidenceCount: filtered.length,
        retainedBytes,
      }))
    );
  });
  mockDb.agentSessionTokenEvent.groupBy.mockImplementation((args) => {
    const filtered = filterMockTokenEvents(events, args);
    return Promise.resolve(aggregateMockTokenEventRows(filtered));
  });
}

function aggregateMockTokenEventRows(
  filtered: ReturnType<typeof makeTokenEvent>[]
) {
  const bySession = new Map<string, typeof filtered>();
  for (const event of filtered) {
    const rows = bySession.get(event.agentSessionId) ?? [];
    rows.push(event);
    bySession.set(event.agentSessionId, rows);
  }
  return [...bySession].map(([agentSessionId, rows]) => ({
    agentSessionId,
    _count: { _all: rows.length, estimatedCost: rows.length },
    _sum: {
      inputTokens: sumMockTokens(rows, "inputTokens"),
      outputTokens: sumMockTokens(rows, "outputTokens"),
      cacheReadTokens: sumMockTokens(rows, "cacheReadTokens"),
      cacheWriteTokens: sumMockTokens(rows, "cacheWriteTokens"),
      estimatedCost: rows.reduce(
        (total, row) => total + Number(row.estimatedCost.toString()),
        0
      ),
    },
    _min: {
      inputTokens: minMockTokens(rows, "inputTokens"),
      outputTokens: minMockTokens(rows, "outputTokens"),
      cacheReadTokens: minMockTokens(rows, "cacheReadTokens"),
      cacheWriteTokens: minMockTokens(rows, "cacheWriteTokens"),
      estimatedCost: Math.min(
        ...rows.map((row) => Number(row.estimatedCost.toString()))
      ),
    },
    sumInputTokens: sumMockTokens(rows, "inputTokens"),
    sumOutputTokens: sumMockTokens(rows, "outputTokens"),
    sumCacheReadTokens: sumMockTokens(rows, "cacheReadTokens"),
    sumCacheWriteTokens: sumMockTokens(rows, "cacheWriteTokens"),
    sumEstimatedCost: rows.reduce(
      (total, row) => total + Number(row.estimatedCost.toString()),
      0
    ),
    minInputTokens: minMockTokens(rows, "inputTokens"),
    minOutputTokens: minMockTokens(rows, "outputTokens"),
    minCacheReadTokens: minMockTokens(rows, "cacheReadTokens"),
    minCacheWriteTokens: minMockTokens(rows, "cacheWriteTokens"),
    minEstimatedCost: Math.min(
      ...rows.map((row) => Number(row.estimatedCost.toString()))
    ),
    estimatedCostCount: rows.length,
    eventCount: rows.length,
  }));
}

function queueBranchCandidateRawResponse(
  mockDb: ReturnType<typeof createMockDb>,
  rows: unknown[]
) {
  branchCandidateRawResponses.get(mockDb)?.push(rows);
}

function defaultBranchReadQueryRaw(
  mockDb: ReturnType<typeof createMockDb>,
  query: unknown
) {
  const sql = renderSql(query);
  if (sql.includes("WITH requested_sessions AS MATERIALIZED")) {
    return Promise.resolve([]);
  }
  if (sql.includes("WITH evidence_size AS MATERIALIZED")) {
    return Promise.resolve([mockCloudEvidenceMetadataRow(0, 0)]);
  }
  if (sql.includes("facet_values AS (")) {
    return Promise.resolve(
      branchServerPageMockRows(branchCandidateRawResponses.get(mockDb)?.[0])
    );
  }
  const proofRows = mockPullRequestCommentProofRows(
    sql,
    collectSqlValues(query)
  );
  if (proofRows) {
    return Promise.resolve(proofRows);
  }
  // ISS-9404: the direct-participation read also joins `branch_detail b`, so it
  // must be answered before the candidate queue or it consumes a queued page.
  if (sql.includes("direct_comments AS (")) {
    return Promise.resolve([]);
  }
  if (isBranchCandidateRawQuery(sql)) {
    const queued = branchCandidateRawResponses.get(mockDb)?.shift();
    return Promise.resolve(queued ?? [mockCandidateSnapshotRow(branchId)]);
  }
  return Promise.resolve([mockCandidateSnapshotRow(branchId)]);
}

function isBranchCandidateRawQuery(sql: string): boolean {
  return sql.includes("branch_detail b");
}

function mockCloudEvidenceMetadataRow(
  evidenceCount: number,
  retainedBytes: number
) {
  return {
    id: null,
    agentSessionId: null,
    eventCreatedAt: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    estimatedCost: null,
    sourceIdentity: null,
    costCompleteness: null,
    costCompletenessReason: null,
    subscriptionEquivalentCost: null,
    apiEstimatedCost: null,
    evidenceBytes: null,
    evidenceCount,
    retainedBytes,
  };
}

function filterMockTokenEvents(
  events: ReturnType<typeof makeTokenEvent>[],
  args?: {
    where?: {
      agentSessionId?: { in?: string[] };
      eventCreatedAt?: { gte?: Date; lte?: Date };
    };
  }
) {
  const wanted = args?.where?.agentSessionId?.in;
  const window = args?.where?.eventCreatedAt;
  return events.filter((event) => {
    if (wanted && !wanted.includes(event.agentSessionId)) {
      return false;
    }
    if (!event.eventCreatedAt) {
      return window === undefined;
    }
    if (window?.gte && event.eventCreatedAt < window.gte) {
      return false;
    }
    return !(window?.lte && event.eventCreatedAt > window.lte);
  });
}

function sumMockTokens(
  rows: ReturnType<typeof makeTokenEvent>[],
  field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
): bigint {
  return rows.reduce((total, row) => total + BigInt(row[field]), 0n);
}

function minMockTokens(
  rows: ReturnType<typeof makeTokenEvent>[],
  field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
): bigint {
  return (
    rows.reduce<bigint | undefined>((minimum, row) => {
      const value = BigInt(row[field]);
      return minimum === undefined || value < minimum ? value : minimum;
    }, undefined) ?? 0n
  );
}

// A minimal structural view of a Prisma.sql fragment as the DB mock records it:
// the interleaved `strings`/`values`, or a joined fragment's `separator`/`values`.
type MockSql = {
  separator?: string;
  strings: readonly string[];
  values?: readonly unknown[];
};

// Flattens every `$queryRaw` fragment the mock captured into one rendered string
// so candidate-SQL suites can assert on the emitted predicate/ordering shape
// (the sanctioned SQL-shape assertion, not a TS source-text guard). Shared so the
// main branchReadService suite and its focused visibility sibling render SQL the
// exact same way without duplicating the walker.
export function branchCandidateSql(
  mockDb: ReturnType<typeof createMockDb>
): string {
  return mockDb.$queryRaw.mock.calls
    .map((call) => renderSql(call[0]))
    .join("\n");
}

export function renderSql(value: unknown): string {
  if (!isMockSql(value)) {
    return String(value);
  }
  if (value.separator !== undefined) {
    return (value.values ?? [])
      .map((item) => renderSql(item))
      .join(value.separator);
  }
  return value.strings
    .map((sqlPart, index) => {
      const nested = value.values?.[index];
      return nested === undefined ? sqlPart : `${sqlPart}${renderSql(nested)}`;
    })
    .join("");
}

/**
 * Collapse a rendered statement's whitespace so a suite can assert an ORDER BY
 * or a join as one literal without re-encoding the source's line breaks.
 * It lives beside `renderSql` because every SQL-shape suite needs both, and
 * four of them had each grown a slightly different collapse of their own.
 */
export function normalizeRenderedSql(value: unknown): string {
  return renderSql(value).replaceAll(SQL_WHITESPACE_RUN, " ").trim();
}

export function collectSqlValues(value: unknown): unknown[] {
  if (!isMockSql(value)) {
    return [value];
  }
  return (value.values ?? []).flatMap((item) => collectSqlValues(item));
}

function isMockSql(value: unknown): value is MockSql {
  return (
    typeof value === "object" &&
    value !== null &&
    "strings" in value &&
    Array.isArray((value as { strings?: unknown }).strings)
  );
}

export function mockCandidateSnapshotRow(
  id: string | null,
  total = 0,
  activity?: PersistedBranchActivityAtom,
  // ISS-8016: the collapsed cohort read selects the publication test as a
  // column and partitions on it, so a row that stands for a Product branch has
  // to carry it. Pass false for a denominator-only (never-published) branch.
  productEligible = true
) {
  return {
    id,
    productEligible,
    repositorySortKey: id === null ? null : "closedloop-ai/closedloop-ai",
    branchSortKey: id === null ? null : "feature",
    atomVersion: activity?.version ?? null,
    atomSource: activity?.source ?? null,
    atomSourceEventId: activity?.sourceEventId ?? null,
    atomOccurredAt: activity?.occurredAt ?? null,
    atomActivityKind: null,
    atomAttributionKind: activity?.attributionKind ?? null,
    atomPullRequestDetailId: activity?.pullRequestDetailId ?? null,
    atomCompleteness: activity?.completeness ?? null,
    atomCreatedAt: activity?.occurredAt ?? null,
    count: BigInt(total),
    retainedUnavailableCount: 0n,
  };
}

/**
 * The candidate reads one Branch DETAIL response issues: the branch's own
 * snapshot, the same snapshot CONFIRMED after `findBranchArtifact`'s org-scope
 * check, the Product gate, then the global even-split divisor cohort.
 */
export function mockDetailCandidateSnapshots(
  mockDb: ReturnType<typeof createMockDb>,
  globalEligibleBranchIds: string[]
) {
  // Queued in the order getBranchDetail reads them: the two candidate reads
  // inside findBranchArtifact, then the Product gate (resolved alongside the
  // detail's parallel identity/commit/PR reads, before any projection work),
  // then the global even-split divisor pager.
  //
  // Every slot has to be queued even though a short queue still looks green: an
  // exhausted queue falls back to a default single-row candidate, so dropping
  // the gate's slot silently hands the divisor the gate's page.
  mockBranchCandidateIds(mockDb, [branchId]);
  mockBranchCandidateIds(mockDb, [branchId]);
  mockBranchCandidateIds(mockDb, [branchId]);
  mockBranchCandidateIds(mockDb, globalEligibleBranchIds);
}
/** Compatibility entrypoint for the shared link fixture. */
export function makeSuccessfulReviewSessionLink(
  ...args: Parameters<typeof buildSuccessfulReviewSessionLink>
) {
  return buildSuccessfulReviewSessionLink(...args);
}

/** Compatibility entrypoint for the shared link fixture. */
export function makePushSessionLink(
  ...args: Parameters<typeof buildPushSessionLink>
) {
  return buildPushSessionLink(...args);
}

const SQL_WHITESPACE_RUN = /\s+/g;
