import { BranchHeadShaSource } from "@repo/api/src/types/artifact";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import {
  branchCostEvidenceByteBudget,
  branchCostEvidenceFixedRowBytes,
  branchCostEvidenceRowBudget,
} from "@repo/api/src/types/branch-usage";
import { GitHubPRState } from "@repo/api/src/types/github";
import { type ArtifactType, GitHubInstallationStatus } from "@repo/database";
import { type Mock, vi } from "vitest";
import { resolveMockPullRequestDetails } from "@/__tests__/fixtures/branch-pull-request-details";
import type { PersistedBranchActivityAtom } from "@/app/branches/branch-activity-evidence";

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
  repositoryId: string;
  repositoryFullName?: string | null;
  repository?: { fullName: string } | null;
  isCurrent: boolean;
  number: number;
  title: string;
  htmlUrl: string;
  body: string;
  prState: GitHubPRState;
  isDraft: boolean;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  reviewDecision: ReviewDecision | null;
  reviews: MockReview[];
  githubCreatedAt: Date | null;
  closedAt: Date | null;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
  headRefOid: string | null;
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
  branchDetail: { updateMany: Mock };
  branchStatusCheck: { deleteMany: Mock };
  commentThread: { findMany: Mock };
  gitHubCommentProjection: { findMany: Mock };
  gitHubCommentThreadProjection: { findMany: Mock };
  gitHubUserConnection: { findMany: Mock };
  commitDetail: { findMany: Mock };
  oAuthRateLimit: { findUnique: Mock; create: Mock; updateMany: Mock };
  pullRequestDetail: { findFirst: Mock; findUnique: Mock; updateMany: Mock };
  repositoryDefaultObservationReceipt: { createMany: Mock };
  user: { findMany: Mock };
  agentSessionActivitySegment: { findMany: Mock };
  agentSessionTokenEvent: { findMany: Mock; groupBy: Mock };
};

export function createMockDb(): MockDb {
  return {
    // FEA-4225: the by-id detail read gates on `branchHasLinkedSession`, a
    // `$queryRaw` EXISTS that must return a row for a branch the test has already
    // mocked as present via `artifact.findFirst`. Default to one eligibility row so
    // every existing detail/trace/refresh test (which seeds a valid session link
    // through `artifactLink.findMany`) stays eligible. List/facet/analytics tests
    // override this per call with `mockResolvedValueOnce` (which takes precedence),
    // and the FEA-4225 eligibility test asserts the zero-session path explicitly.
    $queryRaw: vi.fn().mockResolvedValue([mockCandidateSnapshotRow(branchId)]),
    artifact: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    artifactLink: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    comment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    branchDetail: {
      updateMany: vi.fn(),
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
  };
}

export function mockBranchCandidatePage(
  mockDb: ReturnType<typeof createMockDb>,
  ids: string[],
  total = ids.length,
  activityById: ReadonlyMap<string, PersistedBranchActivityAtom> = new Map()
) {
  mockDb.$queryRaw.mockResolvedValueOnce(
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
  mockDb.$queryRaw.mockResolvedValueOnce(
    ids.map((id) => mockCandidateSnapshotRow(id, 0, activityById.get(id)))
  );
}

export function makeBaseCurrentPullRequestDetail(): MockPrDetail {
  return {
    id: "pr-detail-1",
    branchArtifactId: branchId,
    repositoryId: "repo-1",
    repositoryFullName: "closedloop-ai/symphony-alpha",
    repository: { fullName: "closedloop-ai/symphony-alpha" },
    isCurrent: true,
    number: 7,
    title: "PR title",
    htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/7",
    body: "body",
    prState: GitHubPRState.Open,
    isDraft: false,
    additions: null,
    deletions: null,
    changedFiles: null,
    reviewDecision: null,
    reviews: [],
    githubCreatedAt: null,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    headRefOid: "abc",
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
    firstPushedAt?: Date | null;
    activityAtoms?: PersistedBranchActivityAtom[];
    headSha?: string | null;
    // The head the file-cache LOC was last refreshed FOR (FEA-4268). Defaults to
    // the branch's own `headSha` so a populated `fileChanges` cache reads as
    // CURRENT — the normal enriched-branch case that feeds `currentFileTotals`.
    // A deliberately-STALE fixture sets this to an OLD sha (or null) so the cache
    // is gated out and display/analytics fall back, mirroring a failed/pending
    // refresh that `refreshBranchFileChangeCache` left on the prior sha.
    fileCacheHeadSha?: string | null;
    headShaSource?: BranchHeadShaSource | null;
    lastSyncCompletedAt?: Date | null;
    pullRequestDetails?: MockPrDetail[];
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
        subtype: string | null;
        name: string;
        slug: string | null;
        externalUrl: string | null;
      };
    }>;
  } = {}
) {
  const id = overrides.id ?? branchId;
  const resolvedHeadSha = "headSha" in overrides ? overrides.headSha : "abc";
  const repositoryId =
    "repositoryId" in overrides ? overrides.repositoryId : "repo-1";
  const repositoryFullName =
    overrides.repositoryFullName ?? "closedloop-ai/symphony-alpha";
  const currentPullRequestDetail =
    "currentPullRequestDetail" in overrides
      ? overrides.currentPullRequestDetail
      : makeCurrentPullRequestDetail({
          branchArtifactId: id,
          repositoryId: repositoryId ?? undefined,
        });
  const pullRequestDetails = resolveMockPullRequestDetails(
    overrides,
    currentPullRequestDetail
  );
  return {
    id,
    // Top-level Artifact.organizationId — the org SSOT the by-id branch reads
    // assert against (FEA-2734). Defaults to the owning org so resolver mocks
    // pass resolveOrgScope(); cross-org cases override it explicitly.
    organizationId: overrides.organizationId ?? organizationId,
    projectId: "projectId" in overrides ? overrides.projectId : branchProjectId,
    name: "feature",
    status: overrides.status ?? GitHubPRState.Open,
    externalUrl: null,
    createdAt: now,
    tagArtifacts: overrides.tagArtifacts ?? [],
    targetLinks: overrides.targetLinks,
    branch: {
      artifactId: id,
      repositoryId,
      repositoryFullName,
      branchName: overrides.branchName ?? "feature",
      baseBranch: "main",
      headSha: resolvedHeadSha,
      // Current-by-default: a populated `fileChanges` cache describes the branch's
      // current head unless a fixture opts into a stale/absent sha (FEA-4268).
      fileCacheHeadSha:
        "fileCacheHeadSha" in overrides
          ? overrides.fileCacheHeadSha
          : resolvedHeadSha,
      headShaSource:
        "headShaSource" in overrides
          ? overrides.headShaSource
          : BranchHeadShaSource.PushWebhook,
      // FR12 visibility SSOT — default null (unpushed); tests opt into push
      // visibility explicitly, mirroring the set-once producer stamp.
      firstPushedAt:
        "firstPushedAt" in overrides ? overrides.firstPushedAt : null,
      lastActivityAt: now,
      activityAtoms: overrides.activityAtoms ?? [],
      syncStatus: overrides.syncStatus ?? "idle",
      lastSyncStartedAt: null,
      lastSyncCompletedAt: overrides.lastSyncCompletedAt ?? null,
      lastSyncErrorCode: null,
      checksStatus: "UNKNOWN",
      checksDetailTotalCount: 0,
      currentPullRequestDetailId: currentPullRequestDetail
        ? "pr-detail-1"
        : null,
      repository: repositoryId
        ? {
            id: repositoryId,
            fullName: "closedloop-ai/symphony-alpha",
            name: "symphony-alpha",
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
      fileChanges: overrides.fileChanges ?? [],
    },
    pullRequestDetails,
  };
}

/**
 * A session→branch link row as `getSessionUsageByBranch` selects it. Carries the
 * same flat 10/20/30/40 token counts as this file's other session fixtures.
 */
export function makeSessionLink(
  targetId: string,
  sessionId: string,
  cost: string,
  // FEA-3457: the session's owner id (SessionDetail.userId), null when
  // uncaptured. Owner resolution tallies distinct sessions per owner.
  userId: string | null = null,
  metadata: Record<string, unknown> | null = null,
  branchParticipation: string | null = null,
  timing: { sessionStartedAt?: Date; sessionEndedAt?: Date | null } = {},
  // ISS-5445: the session's stored `billing_mode`, which drives the
  // subscription-vs-API ledger split in `getBranchUsage`. Defaults to null — no
  // captured mode ⇒ unknown ledger ⇒ counted in the total and in NEITHER
  // sub-bucket, preserving what every pre-existing caller already assumed.
  billingMode: string | null = null
) {
  return {
    targetId,
    sourceId: sessionId,
    branchParticipation,
    branchParticipationMethod: null,
    branchParticipationObservedAt: null,
    metadata,
    source: {
      name: `Session ${sessionId}`,
      slug: `session-${sessionId}`,
      session: {
        artifactId: sessionId,
        externalSessionId: sessionId,
        harness: "codex",
        sessionStartedAt: timing.sessionStartedAt ?? now,
        sessionEndedAt:
          "sessionEndedAt" in timing ? timing.sessionEndedAt : null,
        estimatedCost: { toString: () => cost },
        inputTokens: 10n,
        outputTokens: 20n,
        cacheReadTokens: 30n,
        cacheWriteTokens: 40n,
        billingMode,
        userId,
      },
    },
  };
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
    if (!sql.includes("agent_session_token_events event")) {
      return Promise.resolve([{ id: branchId }]);
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
    const bySession = new Map<string, typeof filtered>();
    for (const event of filtered) {
      const rows = bySession.get(event.agentSessionId) ?? [];
      rows.push(event);
      bySession.set(event.agentSessionId, rows);
    }
    return Promise.resolve(
      [...bySession].map(([agentSessionId, rows]) => ({
        agentSessionId,
        _count: { _all: rows.length },
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
          estimatedCost: Math.min(
            ...rows.map((row) => Number(row.estimatedCost.toString()))
          ),
        },
      }))
    );
  });
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

function mockCandidateSnapshotRow(
  id: string | null,
  total = 0,
  activity?: PersistedBranchActivityAtom
) {
  return {
    id,
    repositorySortKey: id === null ? null : "closedloop-ai/symphony-alpha",
    branchSortKey: id === null ? null : "feature",
    atomVersion: activity?.version ?? null,
    atomSource: activity?.source ?? null,
    atomSourceEventId: activity?.sourceEventId ?? null,
    atomOccurredAt: activity?.occurredAt ?? null,
    atomAttributionKind: activity?.attributionKind ?? null,
    atomPullRequestDetailId: activity?.pullRequestDetailId ?? null,
    atomCompleteness: activity?.completeness ?? null,
    count: BigInt(total),
  };
}
