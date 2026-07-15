import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  type BranchAnalytics,
  BranchDataState,
  type BranchKpi,
  BranchKpiState,
  type BranchListResponse,
  type BranchPageDetail,
  BranchRefreshReason,
  type BranchRefreshResponse,
  BranchRefreshStatus,
  BranchStatus,
  type BranchTraceResponse,
  type BranchUsageSummary,
  BranchViewerScope,
  type MergedTraceItem,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import {
  BranchMergedState,
  deriveBranchMergedState,
} from "@repo/api/src/types/branch-merged-state";
import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubFetchTrigger } from "@repo/api/src/types/github-read-model";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { median } from "@repo/api/src/utils/math";
import {
  ArtifactType,
  GitHubInstallationStatus,
  Prisma,
  type PrismaClient,
  withDb,
} from "@repo/database";
import {
  GitHubProviderResultStatus,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import {
  buildMergedTrace,
  type MergedTraceSessionInput,
} from "@repo/lib/branches/merged-trace";
import { log } from "@repo/observability/log";
import pLimit from "p-limit";
import { z } from "zod";
import { agentSessionsService } from "@/app/agent-sessions/service";
import {
  GitHubServerSyncReason,
  GitHubServerSyncStatus,
  githubServerSyncService,
} from "@/app/integrations/github/sync-service";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { isOrgScopeOwned, resolveOrgScope } from "@/lib/org-scope";
import {
  BRANCH_CURRENT_PULL_REQUEST_DETAIL_CANDIDATE_LIMIT,
  getOwnedCurrentPullRequestDetail,
} from "./branch-remote-evidence";
import { pullRequestLocData } from "./pull-request-loc-data";

export const BRANCH_LIST_DEFAULT_LIMIT = 50;
export const BRANCH_LIST_MAX_LIMIT = 100;
const BRANCH_LIST_MAX_OFFSET = 10_000;
const BRANCH_FILTER_MAX_VALUES = 25;
const BRANCH_TRACE_DEFAULT_LIMIT = 50;
const BRANCH_TRACE_MAX_LIMIT = 100;
// The merged trace hydrates every linked session, so bound the fan-out. Branches
// with more linked sessions than this trace their most recently linked ones
// (logged, not silently dropped); tuned well above a typical branch's count.
const BRANCH_TRACE_MAX_SESSIONS = 30;
// Concurrent findSessionDetail hydrations — bounded so a wide branch never
// exhausts the connection pool.
const BRANCH_TRACE_SESSION_CONCURRENCY = 4;
const BRANCH_REFRESH_WINDOW_MS = 30_000;
const BRANCH_REFRESH_ORG_BUCKET_LIMIT = 20;
const BRANCH_REFRESH_ACTOR_BUCKET_LIMIT = 5;
const BRANCH_REFRESH_BUCKET_PREFIX = "branch_refresh";
const SQL_LIKE_ESCAPE_PATTERN = /[%_\\]/g;
const UUID_SCHEMA = z.uuid();
const branchFilterStatusValues = [
  BranchStatus.Open,
  BranchStatus.Merged,
  BranchStatus.Closed,
  BranchStatus.Draft,
] as const;

const branchPullRequestDetailSelect = {
  id: true,
  branchArtifactId: true,
  repositoryId: true,
  isCurrent: true,
  number: true,
  title: true,
  htmlUrl: true,
  body: true,
  prState: true,
  isDraft: true,
  additions: true,
  deletions: true,
  changedFiles: true,
  reviewDecision: true,
  closedAt: true,
  mergedAt: true,
  mergeCommitSha: true,
  lastVerifiedAt: true,
  lastRefreshAttemptAt: true,
} satisfies Prisma.PullRequestDetailSelect;

export const branchListQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(BRANCH_LIST_MAX_LIMIT)
      .default(BRANCH_LIST_DEFAULT_LIMIT),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(BRANCH_LIST_MAX_OFFSET)
      .default(0),
    repo: repeatedStringSchema(BRANCH_FILTER_MAX_VALUES).optional(),
    repository: repeatedStringSchema(BRANCH_FILTER_MAX_VALUES).optional(),
    status: repeatedEnumSchema(
      branchFilterStatusValues,
      BRANCH_FILTER_MAX_VALUES
    ).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    projectId: repeatedStringSchema(BRANCH_FILTER_MAX_VALUES).optional(),
  })
  .strict();

export const branchTraceQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(BRANCH_TRACE_MAX_LIMIT)
    .default(BRANCH_TRACE_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(BRANCH_LIST_MAX_OFFSET).default(0),
});

export type BranchListQuery = z.infer<typeof branchListQuerySchema>;
export type BranchTraceQuery = z.infer<typeof branchTraceQuerySchema>;

type BranchReadClient = Pick<
  PrismaClient,
  | "$queryRaw"
  | "artifact"
  | "artifactLink"
  | "commentThread"
  | "oAuthRateLimit"
  | "pullRequestDetail"
>;

type RefreshActor = {
  userId: string;
  authMethod: string;
};

const branchArtifactSelect = {
  id: true,
  // Top-level Artifact.organizationId — the org SSOT (PRD-510 FR13). Selected so
  // the by-id branch reads can run resolveOrgScope() against the SSOT itself, not
  // just the denormalized BranchDetail copy.
  organizationId: true,
  name: true,
  status: true,
  externalUrl: true,
  createdAt: true,
  pullRequestDetails: {
    where: { isCurrent: true },
    orderBy: [{ repositoryId: "asc" }, { number: "desc" }, { id: "asc" }],
    select: branchPullRequestDetailSelect,
    take: BRANCH_CURRENT_PULL_REQUEST_DETAIL_CANDIDATE_LIMIT,
  },
  branch: {
    select: {
      artifactId: true,
      repositoryId: true,
      // D2 branch identity (PRD-510): the producer-independent normalized
      // `owner/name`, populated for every branch incl. non-App ones with no
      // installation-repo row. Surfaced as `repoFullName` when `repository` is
      // absent so non-App rows keep a repo identity in the list/detail DTO.
      repositoryFullName: true,
      branchName: true,
      baseBranch: true,
      headSha: true,
      // Explicit set-once push state (PRD-510 FR2) — the FR12 visibility SSOT.
      // Replaces the old headShaSource-derived "remote evidence" gate.
      firstPushedAt: true,
      lastActivityAt: true,
      syncStatus: true,
      lastSyncStartedAt: true,
      lastSyncCompletedAt: true,
      lastSyncErrorCode: true,
      checksStatus: true,
      checksDetailTotalCount: true,
      currentPullRequestDetailId: true,
      repository: {
        select: {
          id: true,
          fullName: true,
          name: true,
          owner: true,
          removedAt: true,
          installation: {
            select: {
              organizationId: true,
              installationId: true,
              status: true,
            },
          },
        },
      },
      currentPullRequestDetail: {
        select: branchPullRequestDetailSelect,
      },
      fileChanges: {
        select: {
          additions: true,
          deletions: true,
          path: true,
        },
        take: 500,
      },
    },
  },
} satisfies Prisma.ArtifactSelect;

type SelectedBranchArtifact = Prisma.ArtifactGetPayload<{
  select: typeof branchArtifactSelect;
}>;

type BranchArtifactRow = SelectedBranchArtifact & {
  branch: NonNullable<SelectedBranchArtifact["branch"]>;
};

// Analytics KPIs only consume branch status, the owned current PR's state/size,
// and per-branch LOC — not the repository/installation/checks/full-PR-detail
// tree in branchArtifactSelect. Reading the whole tree for the entire filtered
// corpus (getBranchAnalytics materializes every branch to feed aggregates) is
// the over-broad select flagged in FEA-2741, so the analytics path uses this
// narrowed select instead. Fields are the exact inputs to the shared status
// (getOwnedCurrentPullRequestDetail/deriveBranchMergedState/toBranchStatus),
// LOC (sumFileChanges), and visibility (owned current PR OR firstPushedAt — the
// FR12 push-state gate), so KPI values stay identical to the full-select path.
const branchAnalyticsPullRequestDetailSelect = {
  branchArtifactId: true,
  repositoryId: true,
  isCurrent: true,
  prState: true,
  isDraft: true,
  mergedAt: true,
  additions: true,
  deletions: true,
} satisfies Prisma.PullRequestDetailSelect;

const branchAnalyticsSelect = {
  id: true,
  status: true,
  pullRequestDetails: {
    where: { isCurrent: true },
    orderBy: [{ repositoryId: "asc" }, { number: "desc" }, { id: "asc" }],
    select: branchAnalyticsPullRequestDetailSelect,
    take: BRANCH_CURRENT_PULL_REQUEST_DETAIL_CANDIDATE_LIMIT,
  },
  branch: {
    select: {
      repositoryId: true,
      firstPushedAt: true,
      currentPullRequestDetail: {
        select: branchAnalyticsPullRequestDetailSelect,
      },
      fileChanges: {
        // Only additions/deletions feed totalLoc; `path` (the list view's
        // filesChanged count) is not needed here, so it is left out of the
        // per-branch, up-to-500-row fetch for the whole corpus (FEA-2741).
        select: {
          additions: true,
          deletions: true,
        },
        take: 500,
      },
    },
  },
} satisfies Prisma.ArtifactSelect;

type SelectedBranchAnalyticsArtifact = Prisma.ArtifactGetPayload<{
  select: typeof branchAnalyticsSelect;
}>;

type BranchAnalyticsArtifactRow = SelectedBranchAnalyticsArtifact & {
  branch: NonNullable<SelectedBranchAnalyticsArtifact["branch"]>;
};

type BranchCandidateRow = {
  id: string;
};

type BranchCountRow = {
  count: bigint | number | string;
};

export const branchReadService = {
  listBranches(
    organizationId: string,
    query: BranchListQuery
  ): Promise<BranchListResponse> {
    const limit = clamp(query.limit, 1, BRANCH_LIST_MAX_LIMIT);
    const offset = Math.max(0, query.offset);
    return withDb(async (db) => {
      const page = await getBranchCandidatePage(
        db,
        organizationId,
        query,
        limit,
        offset
      );
      const pageRows = await getBranchRowsById(db, organizationId, page.ids);
      const sessionUsageByBranch = await getSessionUsageByBranch(
        db,
        organizationId,
        pageRows.map((row) => row.id)
      );
      return {
        items: pageRows.map((row) =>
          toBranchRow(row, sessionUsageByBranch.get(row.id))
        ),
        total: page.total,
        viewerScope: BranchViewerScope.Organization,
        hasMore: page.hasMore,
      };
    });
  },

  getBranchDetail(
    organizationId: string,
    branchId: string
  ): Promise<BranchPageDetail | null> {
    if (!isValidCloudBranchId(branchId)) {
      return Promise.resolve(null);
    }
    return withDb(async (db) => {
      const row = await findBranchArtifact(db, organizationId, branchId);
      if (!row) {
        return null;
      }
      const sessionUsageByBranch = await getSessionUsageByBranch(
        db,
        organizationId,
        [branchId]
      );
      return toBranchPageDetail(row, sessionUsageByBranch.get(branchId));
    });
  },

  async getBranchTrace(
    organizationId: string,
    branchId: string,
    query: BranchTraceQuery
  ): Promise<BranchTraceResponse | null> {
    if (!isValidCloudBranchId(branchId)) {
      return null;
    }
    const limit = clamp(query.limit, 1, BRANCH_TRACE_MAX_LIMIT);
    const offset = Math.max(0, query.offset);
    // Resolve the branch and its linked session ids under one connection, then
    // release it before hydrating each session: findSessionDetail opens its own
    // connection, so a fan-out must not contend with a held outer connection.
    const sessionIds = await withDb(async (db) => {
      const row = await findBranchArtifact(db, organizationId, branchId);
      if (!row) {
        return null;
      }
      return getBranchTraceSessionIds(db, organizationId, branchId);
    });
    if (sessionIds === null) {
      return null;
    }
    // The cross-session merge interleaves every linked session chronologically,
    // so build the full trace and page the resulting items — not the sessions.
    const items = await buildBranchMergedTrace(organizationId, sessionIds);
    return {
      branchId,
      viewerScope: BranchViewerScope.Organization,
      items: items.slice(offset, offset + limit),
      hasMore: offset + limit < items.length,
    };
  },

  getBranchUsage(
    organizationId: string,
    query: BranchListQuery
  ): Promise<BranchUsageSummary> {
    return withDb(async (db) => {
      // A usage summary aggregates over the entire filtered branch set, not a
      // single list page: applying skip/take here would undercount the token
      // and cost totals (and totalBranches) for orgs with more than one page
      // of branches. Use the same full-corpus candidate path as
      // getBranchAnalytics so the filter predicates stay consistent.
      const branchIds = await getBranchCandidateIds(db, organizationId, query);
      const rows = await getBranchRowsById(db, organizationId, branchIds);
      const usageByBranch = await getSessionUsageByBranch(
        db,
        organizationId,
        rows.map((row) => row.id)
      );
      const totals = sumUsage([...usageByBranch.values()]);
      return {
        viewerScope: BranchViewerScope.Organization,
        totalBranches: rows.length,
        totalInputTokens: totals.inputTokens,
        totalOutputTokens: totals.outputTokens,
        totalCacheReadTokens: totals.cacheReadTokens,
        totalCacheWriteTokens: totals.cacheWriteTokens,
        totalEstimatedCost: totals.estimatedCostUsd,
        subscriptionEstimatedCost: 0,
        apiEstimatedCost: totals.estimatedCostUsd,
        hourBuckets: [],
        phaseStacks: [],
        byActor: [
          {
            owner: null,
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadTokens,
            cacheWriteTokens: totals.cacheWriteTokens,
            estimatedCostUsd: totals.estimatedCostUsd,
          },
        ],
      };
    });
  },

  getBranchAnalytics(
    organizationId: string,
    query: BranchListQuery
  ): Promise<BranchAnalytics> {
    return withDb(async (db) => {
      // Aggregate KPIs cover the whole filtered corpus, so read every matching
      // branch id via the shared candidate-id helper (no skip/take) rather than
      // a single list page. getBranchCandidateIds is shared with getBranchUsage
      // and listBranches, so the keyset loop is not duplicated here.
      const branchIds = await getBranchCandidateIds(db, organizationId, query);
      // The full corpus must still be read for medianPrSize (a median needs the
      // per-branch population, not a DB aggregate), but only via the narrowed
      // analytics select — not the heavy branchArtifactSelect tree (FEA-2741).
      // The count/sum KPIs are then folded over those already-materialized rows
      // in JS: the population read is unavoidable for the median, so separate
      // count()/aggregate() queries would only add round-trips without removing
      // it, and the JS branch-status classification (deriveBranchMergedState)
      // has no faithful SQL-aggregate equivalent yet.
      const rows = await getBranchAnalyticsRows(db, organizationId, branchIds);
      const usageByBranch = await getSessionUsageByBranch(
        db,
        organizationId,
        rows.map((row) => row.id)
      );
      const metrics = rows.map(toBranchAnalyticsMetrics);
      const branchCount = metrics.length;
      // Merge-RATE numerator: branches whose derived STATUS is Merged, over the
      // whole corpus. This feeds the rate only (denominator = all branches) and
      // keeps its existing definition — distinct from the "Merged PRs" count below.
      const mergedStatusCount = metrics.filter(
        (metric) => metric.status === BranchStatus.Merged
      ).length;
      // "Merged PRs" COUNT KPI: branches whose latest PR STATE is MERGED. This is
      // the cross-surface-parity definition shared with the desktop producer
      // (apps/desktop/src/main/branch-analytics-projection.ts `mergedCount`), which
      // counts `prState === "MERGED" && !multiPrWarning` (FEA-2997). multiPrWarning
      // is structurally false on this cloud producer (one owned/current PR per
      // branch — see toBranchRow), so the predicates coincide. FEA-3089 restores
      // FEA-2950's contract that the shared BranchAnalytics card's "Merged PRs"
      // number matches on web and desktop: previously web counted
      // `status === Merged` (an orthogonal field over a different population), so a
      // branch merged without a MERGED latest PR state — e.g. merged via commit-sha
      // evidence, or a local-status merge with no connected PR (prState null) — was
      // counted on web but dropped on desktop.
      const mergedPrCount = metrics.filter(
        (metric) => metric.prState === GitHubPRState.Merged
      ).length;
      const medianPrSizes = metrics
        .map((metric) => metric.prSize)
        .filter((value): value is number => value !== null);
      const totalSpend = sumUsage([...usageByBranch.values()]).estimatedCostUsd;
      const totalLoc = metrics.reduce(
        (sum, metric) =>
          sum + (metric.additions ?? 0) + (metric.deletions ?? 0),
        0
      );
      return {
        viewerScope: BranchViewerScope.Organization,
        medianPrSize: kpi(median(medianPrSizes)),
        mergeRate: kpi(
          branchCount === 0 ? null : (mergedStatusCount / branchCount) * 100
        ),
        medianTimeToMergeMs: kpi(null, BranchKpiState.Gated),
        activePrCount: kpi(
          metrics.filter((metric) => metric.prState === GitHubPRState.Open)
            .length
        ),
        mergedCount: kpi(mergedPrCount),
        leadTimeForChangeMs: kpi(null, BranchKpiState.Gated),
        locPerDollar: kpi(totalSpend > 0 ? totalLoc / totalSpend : null),
        totalSpendUsd: kpi(totalSpend > 0 ? totalSpend : null),
        activeBranchCount: kpi(
          metrics.filter(
            (metric) =>
              metric.status !== BranchStatus.Merged &&
              metric.status !== BranchStatus.Closed
          ).length
        ),
        buildVsReworkSplit: {
          buildPct: null,
          reworkPct: null,
          state: BranchKpiState.Unavailable,
        },
      };
    });
  },

  async refreshBranch(
    organizationId: string,
    branchId: string,
    actor: RefreshActor
  ): Promise<BranchRefreshResponse> {
    if (!isValidCloudBranchId(branchId)) {
      return {
        branch: null,
        status: BranchRefreshStatus.Failed,
        reason: BranchRefreshReason.InvalidBranchId,
      };
    }
    const now = new Date();
    const target = await withDb((db) =>
      findBranchArtifact(db, organizationId, branchId)
    );
    if (!target) {
      return {
        branch: null,
        status: BranchRefreshStatus.Failed,
        reason: BranchRefreshReason.NotFound,
      };
    }
    const currentPr = getOwnedCurrentPullRequestDetail(target);
    if (!currentPr?.number) {
      return {
        branch: toBranchPageDetail(target, null),
        status: BranchRefreshStatus.NotApplicable,
        reason: BranchRefreshReason.NoCurrentPullRequest,
      };
    }

    const budget = await consumeRefreshBudget(organizationId, actor, now);
    if (!budget.ok) {
      return {
        branch: toBranchPageDetail(target, null),
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.BudgetExhausted,
        retryAfterSeconds: budget.retryAfterSeconds,
      };
    }

    if (!hasActiveRepository(target)) {
      const tombstonedRefresh = await refreshTombstonedBranchPullRequest(
        organizationId,
        branchId,
        actor,
        target
      );
      return tombstonedRefresh;
    }

    const claimed = await claimPullRequestRefresh(
      organizationId,
      target,
      currentPr.id,
      now
    );
    if (!claimed) {
      return {
        branch: toBranchPageDetail(target, null),
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.AlreadyRefreshing,
        retryAfterSeconds: Math.ceil(BRANCH_REFRESH_WINDOW_MS / 1000),
      };
    }

    const providerResult = await getSinglePullRequestWithProviderResult(
      target.branch.repository.installation.installationId,
      target.branch.repository.owner,
      target.branch.repository.name,
      currentPr.number
    );
    if (
      providerResult.status === GitHubProviderResultStatus.ProviderRateLimit
    ) {
      return {
        branch: toBranchPageDetail(target, null),
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.ProviderRateLimited,
        retryAfterSeconds: providerResult.retryAfterSeconds ?? undefined,
      };
    }
    if (providerResult.status !== GitHubProviderResultStatus.Success) {
      return {
        branch: toBranchPageDetail(target, null),
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.ProviderUnavailable,
      };
    }

    const settled = await settlePullRequestRefresh(
      organizationId,
      target,
      currentPr.id,
      providerResult.value,
      now
    );
    if (!settled) {
      return {
        branch: toBranchPageDetail(target, null),
        status: BranchRefreshStatus.Failed,
        reason: BranchRefreshReason.GuardedWriteFailed,
      };
    }
    const branch = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );
    return {
      branch,
      status: BranchRefreshStatus.Refreshed,
    };
  },
};

async function getBranchCandidatePage(
  db: BranchReadClient,
  organizationId: string,
  query: BranchListQuery,
  limit: number,
  offset: number
): Promise<{ ids: string[]; total: number; hasMore: boolean }> {
  const whereClause = branchCandidateWhereClause(organizationId, query);
  const [countRows, idRows] = await Promise.all([
    db.$queryRaw<BranchCountRow[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      ${branchCandidateFromClause()}
      ${whereClause}
    `),
    db.$queryRaw<BranchCandidateRow[]>(Prisma.sql`
      SELECT a.id
      ${branchCandidateFromClause()}
      ${whereClause}
      ORDER BY b.last_activity_at DESC, a.created_at DESC, a.id ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `),
  ]);
  const ids = idRows.map((row) => row.id);
  const total = Number(countRows[0]?.count ?? 0);
  return {
    ids,
    total,
    hasMore: offset + ids.length < total,
  };
}

async function getBranchCandidateIds(
  db: BranchReadClient,
  organizationId: string,
  query: BranchListQuery
): Promise<string[]> {
  const whereClause = branchCandidateWhereClause(organizationId, query);
  const rows = await db.$queryRaw<BranchCandidateRow[]>(Prisma.sql`
    SELECT a.id
    ${branchCandidateFromClause()}
    ${whereClause}
    ORDER BY b.last_activity_at DESC, a.created_at DESC, a.id ASC
  `);
  return rows.map((row) => row.id);
}

async function getBranchRowsById(
  db: BranchReadClient,
  organizationId: string,
  branchIds: string[]
): Promise<BranchArtifactRow[]> {
  if (branchIds.length === 0) {
    return [];
  }
  const rows = await db.artifact.findMany({
    where: {
      id: { in: branchIds },
      organizationId,
      type: ArtifactType.BRANCH,
      branch: { deletedAt: null },
    },
    select: branchArtifactSelect,
  });
  const rowsById = new Map(
    rows
      .filter(hasBranchArtifactRow)
      .filter(hasVisibleBranchArtifactRow)
      .map((row) => [row.id, row])
  );
  const orderedRows: BranchArtifactRow[] = [];
  for (const branchId of branchIds) {
    const row = rowsById.get(branchId);
    if (row) {
      orderedRows.push(row);
    }
  }
  return orderedRows;
}

async function getBranchAnalyticsRows(
  db: BranchReadClient,
  organizationId: string,
  branchIds: string[]
): Promise<BranchAnalyticsArtifactRow[]> {
  if (branchIds.length === 0) {
    return [];
  }
  // Same corpus and visibility predicates as getBranchRowsById, but with the
  // narrowed analytics select (FEA-2741). Ordering is intentionally omitted:
  // analytics folds counts/sums and a median over the rows, none of which
  // depend on row order.
  const rows = await db.artifact.findMany({
    where: {
      id: { in: branchIds },
      organizationId,
      type: ArtifactType.BRANCH,
      branch: { deletedAt: null },
    },
    select: branchAnalyticsSelect,
  });
  return rows.filter(hasVisibleBranchAnalyticsRow);
}

async function findBranchArtifact(
  db: BranchReadClient,
  organizationId: string,
  branchId: string
): Promise<BranchArtifactRow | null> {
  const row = await db.artifact.findFirst({
    where: branchWhere(organizationId, branchId),
    select: branchArtifactSelect,
  });
  if (!(hasBranchArtifactRow(row) && hasVisibleBranchArtifactRow(row))) {
    return null;
  }
  // Org-scope enforcement (FEA-2734 / PRD-510 FR3 D4): the single, test-enforced
  // seam for every by-id branch read (detail, trace, refresh all resolve here).
  // `branchWhere` already pins `organizationId`, so this is defense-in-depth — it
  // fails loud if a future edit widens the resolver. Adoption is proven
  // behaviorally in org-isolation.integration.test.ts (cross-org id → null).
  // Cross-org / not-found both collapse to null → the route returns 404 without
  // revealing the branch exists elsewhere.
  const scoped = resolveOrgScope(organizationId, row);
  if (!isOrgScopeOwned(scoped)) {
    return null;
  }
  return scoped.value;
}

async function refreshTombstonedBranchPullRequest(
  organizationId: string,
  branchId: string,
  actor: RefreshActor,
  target: BranchArtifactRow
): Promise<BranchRefreshResponse> {
  const syncResult =
    await githubServerSyncService.refreshTombstonedBranchPullRequest({
      actorUserId: actor.userId,
      branchArtifactId: branchId,
      organizationId,
      trigger: toGitHubFetchTrigger(actor.authMethod),
    });
  if (syncResult.status === GitHubServerSyncStatus.Refreshed) {
    return {
      branch: await branchReadService.getBranchDetail(organizationId, branchId),
      status: BranchRefreshStatus.Refreshed,
    };
  }
  if (syncResult.status === GitHubServerSyncStatus.Retryable) {
    return {
      branch: toBranchPageDetail(target, null),
      status: BranchRefreshStatus.Retryable,
      reason: toBranchRefreshReason(syncResult.reason),
      ...(syncResult.retryAfterSeconds
        ? { retryAfterSeconds: syncResult.retryAfterSeconds }
        : {}),
    };
  }
  const status =
    syncResult.status === GitHubServerSyncStatus.NotApplicable
      ? BranchRefreshStatus.NotApplicable
      : BranchRefreshStatus.Failed;
  return {
    branch: toBranchPageDetail(target, null),
    status,
    reason: toBranchRefreshReason(syncResult.reason),
  };
}

function toBranchRefreshReason(
  reason: GitHubServerSyncReason
): BranchRefreshReason {
  switch (reason) {
    case GitHubServerSyncReason.AlreadyRefreshing:
      return BranchRefreshReason.AlreadyRefreshing;
    case GitHubServerSyncReason.GuardedWriteFailed:
      return BranchRefreshReason.GuardedWriteFailed;
    case GitHubServerSyncReason.NoCurrentPullRequest:
      return BranchRefreshReason.NoCurrentPullRequest;
    case GitHubServerSyncReason.NoCredential:
      return BranchRefreshReason.GitHubIdentityRequired;
    case GitHubServerSyncReason.CredentialExpired:
    case GitHubServerSyncReason.CredentialRevoked:
    case GitHubServerSyncReason.CredentialDecryptionFailed:
      return BranchRefreshReason.GitHubIdentityExpired;
    case GitHubServerSyncReason.CredentialInsufficientScope:
      return BranchRefreshReason.GitHubIdentityInsufficientScope;
    case GitHubServerSyncReason.ProviderRateLimited:
      return BranchRefreshReason.ProviderRateLimited;
    case GitHubServerSyncReason.ProviderUnavailable:
      return BranchRefreshReason.ProviderUnavailable;
    case GitHubServerSyncReason.CrossUserDenied:
    case GitHubServerSyncReason.InvalidRepositoryFullName:
    case GitHubServerSyncReason.NoActiveRepository:
    case GitHubServerSyncReason.NoEligibleSessionReference:
    case GitHubServerSyncReason.NoTombstonedRepository:
    case GitHubServerSyncReason.Unsupported:
    case GitHubServerSyncReason.Unknown:
      return BranchRefreshReason.NotFound;
    case GitHubServerSyncReason.Success:
      return BranchRefreshReason.ProviderUnavailable;
    default:
      return BranchRefreshReason.ProviderUnavailable;
  }
}

function branchWhere(
  organizationId: string,
  branchId?: string
): Prisma.ArtifactWhereInput {
  return {
    ...(branchId ? { id: branchId } : {}),
    organizationId,
    type: ArtifactType.BRANCH,
    branch: {
      deletedAt: null,
    },
    AND: [branchRemoteEvidenceWhere()],
  };
}

// PRD-510 FR12 display predicate: a branch surfaces when it has explicit push
// evidence (firstPushedAt, the set-once push-state SSOT) OR a current PR. This
// deliberately no longer keys on the volatile headShaSource (the stale_push
// trap) or on row existence, so desktop-pushed branches in non-App repos surface
// while merely-observed (synced-but-unpushed) branches stay hidden.
function branchRemoteEvidenceWhere(): Prisma.ArtifactWhereInput {
  return {
    OR: [
      { pullRequestDetails: { some: { isCurrent: true } } },
      { branch: { firstPushedAt: { not: null } } },
    ],
  };
}

function branchCandidateFromClause(): Prisma.Sql {
  // No join to github_installation_repositories: branch identity and the repo
  // filter key on branch_detail.repository_full_name (PRD-510 D2), so an INNER
  // join here would drop non-App branches (repository_id NULL) that Phase 2 made
  // first-class. Repo filter/search read repository_full_name directly below.
  return Prisma.sql`
    FROM artifacts a
    INNER JOIN branch_detail b
      ON b.artifact_id = a.id
  `;
}

function branchCandidateWhereClause(
  organizationId: string,
  query: BranchListQuery
): Prisma.Sql {
  const repositories = [...(query.repository ?? []), ...(query.repo ?? [])];
  const predicates: Prisma.Sql[] = [
    Prisma.sql`a.organization_id = ${organizationId}::uuid`,
    Prisma.sql`a.type = ${ArtifactType.BRANCH}::"ArtifactType"`,
    Prisma.sql`b.deleted_at IS NULL`,
    branchCandidateRemoteEvidenceClause(),
  ];
  appendBranchCandidateProjectPredicates(predicates, query.projectId ?? []);
  appendBranchCandidateRepositoryPredicates(predicates, repositories);
  appendBranchCandidateActivityPredicates(predicates, query);
  appendBranchCandidateSearchPredicate(predicates, query.search);
  appendBranchCandidateStatusPredicate(predicates, query.status ?? []);
  return Prisma.sql`WHERE ${Prisma.join(predicates, " AND ")}`;
}

function appendBranchCandidateProjectPredicates(
  predicates: Prisma.Sql[],
  projectIds: string[]
) {
  if (projectIds.length === 0) {
    return;
  }
  predicates.push(
    Prisma.sql`a.project_id IN (${Prisma.join(
      projectIds.map((projectId) => Prisma.sql`${projectId}::uuid`)
    )})`
  );
}

function appendBranchCandidateRepositoryPredicates(
  predicates: Prisma.Sql[],
  repositories: string[]
) {
  if (repositories.length === 0) {
    return;
  }
  // Match the D2 normalized identity so the filter round-trips regardless of the
  // casing/`.git` suffix the client sends, and so non-App branches (no
  // installation-repo row) are still filterable by repo.
  const normalized = repositories.map((repo) => normalizeRepoFullName(repo));
  predicates.push(
    Prisma.sql`b.repository_full_name IN (${Prisma.join(normalized)})`
  );
}

function appendBranchCandidateActivityPredicates(
  predicates: Prisma.Sql[],
  query: BranchListQuery
) {
  if (query.startDate) {
    predicates.push(Prisma.sql`b.last_activity_at >= ${query.startDate}`);
  }
  if (query.endDate) {
    predicates.push(Prisma.sql`b.last_activity_at <= ${query.endDate}`);
  }
}

function appendBranchCandidateSearchPredicate(
  predicates: Prisma.Sql[],
  rawSearch: string | undefined
) {
  const search = rawSearch?.trim();
  if (!search) {
    return;
  }
  const pattern = toSqlContainsPattern(search);
  predicates.push(Prisma.sql`(
    a.name ILIKE ${pattern} ESCAPE '\\'
    OR b.branch_name ILIKE ${pattern} ESCAPE '\\'
    OR b.repository_full_name ILIKE ${pattern} ESCAPE '\\'
    OR ${ownedCurrentPullRequestExists([
      Prisma.sql`pr.title ILIKE ${pattern} ESCAPE '\\'`,
    ])}
  )`);
}

function appendBranchCandidateStatusPredicate(
  predicates: Prisma.Sql[],
  statuses: BranchStatus[]
) {
  if (statuses.length === 0) {
    return;
  }
  predicates.push(
    Prisma.sql`(${Prisma.join(
      statuses.map((status) => branchCandidateStatusClause(status)),
      " OR "
    )})`
  );
}

function branchCandidateRemoteEvidenceClause(): Prisma.Sql {
  // FR12 display predicate (SQL twin of branchRemoteEvidenceWhere / the in-memory
  // hasRemoteBranchEvidence): owned current PR OR explicit set-once push state.
  return Prisma.sql`(
    ${ownedCurrentPullRequestExists()}
    OR b.first_pushed_at IS NOT NULL
  )`;
}

function branchCandidateStatusClause(status: BranchStatus): Prisma.Sql {
  switch (status) {
    case BranchStatus.Draft:
      return ownedCurrentPullRequestExists([Prisma.sql`pr.is_draft = TRUE`]);
    case BranchStatus.Merged:
      return ownedCurrentPullRequestExists([
        Prisma.sql`pr.is_draft = FALSE`,
        Prisma.sql`(
          pr.pr_state = ${GitHubPRState.Merged}::"GitHubPRState"
          OR pr.merged_at IS NOT NULL
        )`,
      ]);
    case BranchStatus.Closed:
      return Prisma.sql`(
        ${ownedCurrentPullRequestExists([
          Prisma.sql`pr.is_draft = FALSE`,
          Prisma.sql`pr.pr_state = ${GitHubPRState.Closed}::"GitHubPRState"`,
          Prisma.sql`pr.merged_at IS NULL`,
        ])}
        OR (
          a.status = ${GitHubPRState.Closed}
          AND (
            NOT ${ownedCurrentPullRequestExists()}
            OR ${ownedCurrentPullRequestExists([
              Prisma.sql`pr.is_draft = FALSE`,
              Prisma.sql`pr.pr_state <> ${GitHubPRState.Merged}::"GitHubPRState"`,
              Prisma.sql`pr.merged_at IS NULL`,
            ])}
          )
        )
      )`;
    case BranchStatus.Open:
      return Prisma.sql`(
        a.status <> ${GitHubPRState.Closed}
        AND (
          ${ownedCurrentPullRequestExists([
            Prisma.sql`pr.is_draft = FALSE`,
            Prisma.sql`pr.pr_state NOT IN (
              ${GitHubPRState.Merged}::"GitHubPRState",
              ${GitHubPRState.Closed}::"GitHubPRState"
            )`,
            Prisma.sql`pr.merged_at IS NULL`,
          ])}
          OR (
            a.status <> ${GitHubPRState.Merged}
            AND NOT ${ownedCurrentPullRequestExists()}
          )
        )
      )`;
    default:
      return Prisma.sql`FALSE`;
  }
}

function ownedCurrentPullRequestExists(
  extraPredicates: Prisma.Sql[] = []
): Prisma.Sql {
  // Null-safe repo match (IS NOT DISTINCT FROM): repo-less (non-App, FEA-2732)
  // branches carry a NULL repository_id on both sides, and equality is never
  // TRUE for NULLs, so a plain "=" would drop their current PR from status
  // derivation while preserving the App-repo semantics.
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM pull_request_detail pr
    WHERE pr.branch_artifact_id = a.id
      AND pr.repository_id IS NOT DISTINCT FROM b.repository_id
      AND pr.is_current = TRUE
      ${extraPredicates.length > 0 ? Prisma.sql`AND ${Prisma.join(extraPredicates, " AND ")}` : Prisma.empty}
  )`;
}

function toSqlContainsPattern(value: string): string {
  return `%${value.replace(SQL_LIKE_ESCAPE_PATTERN, "\\$&")}%`;
}

function sessionLinkWhere(
  organizationId: string,
  branchIds: string[]
): Prisma.ArtifactLinkWhereInput {
  return {
    organizationId,
    targetId: { in: branchIds },
    linkType: LinkType.RelatesTo,
    metadata: { path: ["linkKind"], equals: SessionArtifactLinkKind.SessionPr },
    source: {
      organizationId,
      type: ArtifactType.SESSION,
    },
    target: {
      organizationId,
      type: ArtifactType.BRANCH,
    },
  };
}

/**
 * Resolve the branch's linked SESSION artifact ids (deduped), bounded by
 * BRANCH_TRACE_MAX_SESSIONS. Ordered by most-recent link first so a branch with
 * more linked sessions than the cap traces its recent activity rather than
 * freezing on its oldest sessions; the cap is logged so the truncation is never
 * silent (the `+ 1` take detects it). buildMergedTrace re-sorts the kept sessions
 * chronologically, so this order only selects which sessions survive the cap.
 */
async function getBranchTraceSessionIds(
  db: BranchReadClient,
  organizationId: string,
  branchId: string
): Promise<string[]> {
  const links = await db.artifactLink.findMany({
    where: sessionLinkWhere(organizationId, [branchId]),
    orderBy: { createdAt: "desc" },
    take: BRANCH_TRACE_MAX_SESSIONS + 1,
    select: {
      sourceId: true,
      source: { select: { session: { select: { artifactId: true } } } },
    },
  });
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const id = link.source.session?.artifactId ?? link.sourceId;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length > BRANCH_TRACE_MAX_SESSIONS) {
    log.warn("[getBranchTrace] Capping linked sessions for the merged trace", {
      branchId,
      linkedSessions: ids.length,
      cap: BRANCH_TRACE_MAX_SESSIONS,
    });
    return ids.slice(0, BRANCH_TRACE_MAX_SESSIONS);
  }
  return ids;
}

/**
 * Hydrate each linked session through the same detail projection the Sessions
 * page uses (findSessionDetail → turnItems), then hand the surface-agnostic
 * inputs to the shared @repo/lib builder. Reusing findSessionDetail keeps the
 * branch trace's per-session projection identical to the session-detail trace
 * (no drift). A session that fails to resolve is skipped rather than failing the
 * whole trace.
 */
async function buildBranchMergedTrace(
  organizationId: string,
  sessionIds: string[]
): Promise<MergedTraceItem[]> {
  if (sessionIds.length === 0) {
    return [];
  }
  const limit = pLimit(BRANCH_TRACE_SESSION_CONCURRENCY);
  const details = await Promise.all(
    sessionIds.map((id) =>
      limit(() =>
        agentSessionsService
          .findSessionDetail({ id, organizationId })
          .catch((error: unknown) => {
            // One session failing to hydrate must not sink the whole trace —
            // skip it and keep the rest of the branch's activity.
            log.warn(
              "[getBranchTrace] Skipping a session that failed to hydrate",
              { sessionId: id, error: String(error) }
            );
            return null;
          })
      )
    )
  );
  const inputs = details
    .filter((detail): detail is AgentSessionDetail => detail !== null)
    .map(toMergedTraceSessionInput);
  return buildMergedTrace(inputs);
}

function toMergedTraceSessionInput(
  detail: AgentSessionDetail
): MergedTraceSessionInput {
  return {
    sessionId: detail.id,
    startedAt: detail.startedAt.toISOString(),
    actorName: detail.name ?? detail.primaryModel ?? detail.model ?? null,
    harness: detail.harness,
    turnItems: detail.turnItems ?? [],
  };
}

// Bound the `targetId IN (...)` list of the session-link lookup. The full-set
// usage/analytics reads pass every filtered branch id at once (FEA-2538), which
// for large orgs would blow past Postgres bind limits and the serverless
// request's memory/time budget in one unbounded query. Chunking keeps full-set
// semantics: branch ids partition cleanly across chunks (each targetId lives in
// exactly one chunk), so accumulation into one map needs no cross-chunk merge.
const SESSION_USAGE_BRANCH_ID_CHUNK_SIZE = 1000;

async function getSessionUsageByBranch(
  db: BranchReadClient,
  organizationId: string,
  branchIds: string[]
): Promise<Map<string, SessionUsage>> {
  const usageByBranch = new Map<string, SessionUsage>();
  // Track seen session ids per branch with a Set for O(1) dedup, avoiding an
  // O(S²) linear scan of usage.sessionIds on every link (perf-pete FEA-2544).
  // The Set map lives outside the chunk loop so dedup stays correct even if a
  // branch's session links were to span chunk boundaries.
  const seenSessionIdsByBranch = new Map<string, Set<string>>();
  for (
    let start = 0;
    start < branchIds.length;
    start += SESSION_USAGE_BRANCH_ID_CHUNK_SIZE
  ) {
    const idChunk = branchIds.slice(
      start,
      start + SESSION_USAGE_BRANCH_ID_CHUNK_SIZE
    );
    const links = await db.artifactLink.findMany({
      where: sessionLinkWhere(organizationId, idChunk),
      select: {
        targetId: true,
        sourceId: true,
        source: {
          select: {
            session: {
              select: {
                artifactId: true,
                externalSessionId: true,
                harness: true,
                sessionStartedAt: true,
                sessionEndedAt: true,
                estimatedCost: true,
                inputTokens: true,
                outputTokens: true,
                cacheReadTokens: true,
                cacheWriteTokens: true,
              },
            },
          },
        },
      },
    });
    for (const link of links) {
      const usage = usageByBranch.get(link.targetId) ?? emptyUsage();
      const session = link.source.session;
      let seenSessionIds = seenSessionIdsByBranch.get(link.targetId);
      if (!seenSessionIds) {
        seenSessionIds = new Set<string>();
        seenSessionIdsByBranch.set(link.targetId, seenSessionIds);
      }
      if (!seenSessionIds.has(link.sourceId)) {
        seenSessionIds.add(link.sourceId);
        usage.sessionIds.push(link.sourceId);
      }
      if (session) {
        usage.sessions.push({
          sessionId: session.artifactId,
          slug: null,
          name: session.externalSessionId,
          harness: session.harness,
          startedAt: toIso(session.sessionStartedAt),
          endedAt: session.sessionEndedAt
            ? toIso(session.sessionEndedAt)
            : null,
          isPrimary: false,
          estimatedCostUsd: numberFromDecimal(session.estimatedCost),
          inputTokens: Number(session.inputTokens),
          outputTokens: Number(session.outputTokens),
          cacheReadTokens: Number(session.cacheReadTokens),
          cacheWriteTokens: Number(session.cacheWriteTokens),
        });
        usage.inputTokens += Number(session.inputTokens);
        usage.outputTokens += Number(session.outputTokens);
        usage.cacheReadTokens += Number(session.cacheReadTokens);
        usage.cacheWriteTokens += Number(session.cacheWriteTokens);
        usage.estimatedCostUsd += numberFromDecimal(session.estimatedCost);
      }
      usageByBranch.set(link.targetId, usage);
    }
  }
  return usageByBranch;
}

async function consumeRefreshBudget(
  organizationId: string,
  actor: RefreshActor,
  now: Date
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const actorBudget = await consumeBucket(
    `${BRANCH_REFRESH_BUCKET_PREFIX}:actor`,
    `${organizationId}:${actor.authMethod}:${actor.userId}`,
    BRANCH_REFRESH_ACTOR_BUCKET_LIMIT,
    now
  );
  if (!actorBudget.ok) {
    return actorBudget;
  }
  return consumeBucket(
    `${BRANCH_REFRESH_BUCKET_PREFIX}:org`,
    organizationId,
    BRANCH_REFRESH_ORG_BUCKET_LIMIT,
    now
  );
}

function toGitHubFetchTrigger(authMethod: string): GitHubFetchTrigger {
  return authMethod === "session"
    ? GitHubFetchTrigger.UserAction
    : GitHubFetchTrigger.Unknown;
}

async function consumeBucket(
  bucket: string,
  subject: string,
  maxRequests: number,
  now: Date
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const windowExpiresAt = new Date(now.getTime() + BRANCH_REFRESH_WINDOW_MS);
  try {
    return await withDb.tx((db) =>
      consumeBucketInTransaction(
        db,
        bucket,
        subject,
        maxRequests,
        now,
        windowExpiresAt
      )
    );
  } catch (error) {
    if (getPrismaErrorCode(error) !== "P2002") {
      throw error;
    }
    return withDb.tx((db) =>
      consumeBucketInTransaction(
        db,
        bucket,
        subject,
        maxRequests,
        now,
        windowExpiresAt
      )
    );
  }
}

async function consumeBucketInTransaction(
  db: Pick<BranchReadClient, "oAuthRateLimit">,
  bucket: string,
  subject: string,
  maxRequests: number,
  now: Date,
  windowExpiresAt: Date
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const existing = await db.oAuthRateLimit.findUnique({
    where: { bucket_subject: { bucket, subject } },
  });
  if (!existing) {
    await db.oAuthRateLimit.create({
      data: {
        bucket,
        subject,
        requestCount: 1,
        windowStartedAt: now,
        windowExpiresAt,
      },
    });
    return { ok: true };
  }
  if (existing.windowExpiresAt <= now) {
    const reset = await db.oAuthRateLimit.updateMany({
      where: { id: existing.id, windowExpiresAt: { lte: now } },
      data: { requestCount: 1, windowStartedAt: now, windowExpiresAt },
    });
    if (reset.count === 1) {
      return { ok: true };
    }
  }
  const consumed = await db.oAuthRateLimit.updateMany({
    where: {
      id: existing.id,
      requestCount: { lt: maxRequests },
      windowExpiresAt: { gt: now },
    },
    data: { requestCount: { increment: 1 } },
  });
  if (consumed.count === 1) {
    return { ok: true };
  }
  return {
    ok: false,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((existing.windowExpiresAt.getTime() - now.getTime()) / 1000)
    ),
  };
}

async function claimPullRequestRefresh(
  organizationId: string,
  target: BranchArtifactRow,
  pullRequestDetailId: string,
  now: Date
): Promise<boolean> {
  // Non-App branches (PRD-510 D2/FR8) have no installation-repo-keyed
  // PullRequestDetail to claim; App-branch refresh is the only claimable path.
  const repositoryId = target.branch.repositoryId;
  if (!repositoryId) {
    return false;
  }
  const staleBefore = new Date(now.getTime() - BRANCH_REFRESH_WINDOW_MS);
  const result = await withDb((db) =>
    db.pullRequestDetail.updateMany({
      where: {
        id: pullRequestDetailId,
        branchArtifactId: target.id,
        repositoryId,
        branchArtifact: { organizationId },
        repository: {
          removedAt: null,
          installation: {
            organizationId,
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        currentForBranches: {
          some: {
            artifactId: target.id,
            currentPullRequestDetailId: pullRequestDetailId,
            artifact: { organizationId },
            repository: {
              removedAt: null,
              installation: {
                organizationId,
                status: GitHubInstallationStatus.ACTIVE,
              },
            },
          },
        },
        OR: [
          { lastRefreshAttemptAt: null },
          { lastRefreshAttemptAt: { lt: staleBefore } },
        ],
      },
      data: { lastRefreshAttemptAt: now },
    })
  );
  return result.count === 1;
}

async function settlePullRequestRefresh(
  organizationId: string,
  target: BranchArtifactRow,
  pullRequestDetailId: string,
  freshPr: {
    state: GitHubPRState;
    mergedAt: string | null;
    closedAt: string | null;
    isDraft: boolean;
    additions?: number | null;
    deletions?: number | null;
    changedFiles?: number | null;
  },
  now: Date
): Promise<boolean> {
  // Non-App branches (PRD-510 D2/FR8) have no installation-repo-keyed
  // PullRequestDetail to settle; only App-branch refresh reaches this write.
  const repositoryId = target.branch.repositoryId;
  if (!repositoryId) {
    return false;
  }
  const result = await withDb((db) =>
    db.pullRequestDetail.updateMany({
      where: {
        id: pullRequestDetailId,
        branchArtifactId: target.id,
        repositoryId,
        branchArtifact: { organizationId },
        repository: {
          removedAt: null,
          installation: {
            organizationId,
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        currentForBranches: {
          some: {
            artifactId: target.id,
            currentPullRequestDetailId: pullRequestDetailId,
            artifact: { organizationId },
            repository: {
              removedAt: null,
              installation: {
                organizationId,
                status: GitHubInstallationStatus.ACTIVE,
              },
            },
          },
        },
      },
      data: {
        prState: freshPr.state,
        mergedAt: freshPr.mergedAt ? new Date(freshPr.mergedAt) : null,
        closedAt: freshPr.closedAt ? new Date(freshPr.closedAt) : null,
        isDraft: freshPr.isDraft,
        ...pullRequestLocData(freshPr),
        lastVerifiedAt: now,
      },
    })
  );
  return result.count === 1;
}

// Fields any branch row (full or narrowed analytics select) exposes for status
// derivation. Keeping the derivation in one generic helper guarantees the list
// view and the analytics KPIs classify the same branch identically (FEA-2741).
type StatusDerivationDetail = {
  branchArtifactId: string;
  isCurrent: boolean;
  // Nullable for desktop-produced PRs in non-App repos (FEA-2732).
  repositoryId: string | null;
  prState: GitHubPRState | null;
  isDraft: boolean;
  mergedAt: Date | null;
};

type StatusDerivationRow<Detail extends StatusDerivationDetail> = {
  id: string;
  status: string;
  branch: {
    repositoryId: string | null;
    currentPullRequestDetail: Detail | null;
  };
  pullRequestDetails: readonly Detail[];
};

function deriveBranchRowStatus<Detail extends StatusDerivationDetail>(
  row: StatusDerivationRow<Detail>
): { pr: Detail | null; status: BranchStatus } {
  const pr = getOwnedCurrentPullRequestDetail(row);
  const mergedState = deriveBranchMergedState({
    connectedPrState: pr?.prState ?? null,
    connectedMergedAt: pr?.mergedAt ?? null,
    hasConnectedPrEvidence: Boolean(pr),
    localArtifactStatus: row.status,
  });
  return {
    pr,
    status: toBranchStatus(
      row.status,
      pr?.prState ?? null,
      pr?.isDraft ?? false,
      mergedState
    ),
  };
}

function toBranchRow(row: BranchArtifactRow, usage = emptyUsage()) {
  const { pr, status } = deriveBranchRowStatus(row);
  const fileTotals = sumFileChanges(row.branch.fileChanges);
  return {
    id: row.id,
    branchName: row.branch.branchName,
    baseBranch: row.branch.baseBranch,
    // App branches surface the installation repo's display-cased full name;
    // non-App branches (PRD-510 D2/FR8) have no installation-repo row, so fall
    // back to the D2 normalized repository_full_name they were keyed on. Only
    // truly repo-less rows stay null (decoded to the "local" sentinel client-side).
    repoFullName:
      row.branch.repository?.fullName ?? row.branch.repositoryFullName ?? null,
    owner: null,
    status,
    prNumber: pr?.number ?? null,
    prTitle: pr?.title ?? null,
    prState: pr?.prState ?? null,
    prUrl: pr?.htmlUrl ?? null,
    multiPrWarning: false,
    checksStatus: row.branch.checksStatus,
    checksPassed: null,
    checksTotal: row.branch.checksDetailTotalCount,
    reviewDecision: pr?.reviewDecision ?? null,
    ahead: null,
    behind: null,
    additions: fileTotals.additions,
    deletions: fileTotals.deletions,
    filesChanged: fileTotals.filesChanged,
    estimatedCostUsd:
      usage.estimatedCostUsd > 0 ? usage.estimatedCostUsd : null,
    lastActivityAt: toIso(row.branch.lastActivityAt ?? row.createdAt),
    sessionIds: usage.sessionIds,
    dataState: deriveDataState(row, usage),
  };
}

type BranchAnalyticsMetrics = {
  status: BranchStatus;
  prState: GitHubPRState | null;
  additions: number | null;
  deletions: number | null;
  prSize: number | null;
};

// Derives the analytics KPI inputs for one branch using the exact same status,
// LOC, and PR-size logic as toBranchRow/pullRequestSize, so narrowing the select
// (FEA-2741) leaves KPI values unchanged. Status derivation is shared via
// deriveBranchRowStatus so it cannot drift from the branch list view.
function toBranchAnalyticsMetrics(
  row: BranchAnalyticsArtifactRow
): BranchAnalyticsMetrics {
  const { pr, status } = deriveBranchRowStatus(row);
  const fileTotals = sumFileChanges(row.branch.fileChanges);
  return {
    status,
    prState: pr?.prState ?? null,
    additions: fileTotals.additions,
    deletions: fileTotals.deletions,
    prSize: analyticsPullRequestSize(status, pr, fileTotals),
  };
}

function analyticsPullRequestSize(
  status: BranchStatus,
  pr: { additions: number | null; deletions: number | null } | null,
  fileTotals: { additions: number | null; deletions: number | null }
): number | null {
  if (status !== BranchStatus.Merged) {
    return null;
  }
  if (pr && pr.additions !== null && pr.deletions !== null) {
    return pr.additions + pr.deletions;
  }
  return (fileTotals.additions ?? 0) + (fileTotals.deletions ?? 0);
}

function toBranchPageDetail(
  row: BranchArtifactRow,
  usage: SessionUsage | null = null
): BranchPageDetail {
  const pr = getOwnedCurrentPullRequestDetail(row);
  return {
    ...toBranchRow(row, usage ?? emptyUsage()),
    prBody: pr?.body ?? null,
    prBodyHtmlUrl: pr?.htmlUrl ?? null,
    headSha: row.branch.headSha,
    mergeCommitSha: pr?.mergeCommitSha ?? null,
    mergedAt: pr?.mergedAt ? toIso(pr.mergedAt) : null,
    closedAt: pr?.closedAt ? toIso(pr.closedAt) : null,
    openedAt: null,
    commits: [],
    sessions: usage?.sessions ?? [],
    mergedTrace: [],
    leadTime: {
      firstActivityT: row.branch.lastActivityAt
        ? toIso(row.branch.lastActivityAt)
        : null,
      lastActivityT: row.branch.lastActivityAt
        ? toIso(row.branch.lastActivityAt)
        : null,
      idleSpans: [],
    },
    linkedPrNumbers: pr?.number ? [pr.number] : [],
    linkedArtifacts: [],
  };
}

function deriveDataState(
  row: BranchArtifactRow,
  usage: SessionUsage
): BranchDataState {
  if (row.branch.syncStatus !== "idle" && !row.branch.lastSyncCompletedAt) {
    return BranchDataState.AwaitingSync;
  }
  if (usage.sessionIds.length === 0) {
    return BranchDataState.NoSessions;
  }
  return BranchDataState.Ready;
}

function hasRemoteBranchEvidence(row: BranchArtifactRow): boolean {
  return Boolean(
    getOwnedCurrentPullRequestDetail(row) || row.branch.firstPushedAt !== null
  );
}

function hasVisibleBranchArtifactRow(row: BranchArtifactRow): boolean {
  return hasRemoteBranchEvidence(row);
}

// Analytics equivalent of hasBranchArtifactRow + hasVisibleBranchArtifactRow for
// the narrowed analytics row shape: same "has branch relation and push evidence"
// FR12 gate, evaluated with the fields present in branchAnalyticsSelect.
function hasVisibleBranchAnalyticsRow(
  row: SelectedBranchAnalyticsArtifact | null
): row is BranchAnalyticsArtifactRow {
  if (!row?.branch) {
    return false;
  }
  return Boolean(
    getOwnedCurrentPullRequestDetail(row) || row.branch.firstPushedAt !== null
  );
}

function toBranchStatus(
  artifactStatus: string,
  prState: GitHubPRState | null,
  isDraft: boolean,
  mergedState: BranchMergedState
): BranchStatus {
  if (isDraft) {
    return BranchStatus.Draft;
  }
  if (mergedState === BranchMergedState.Merged) {
    return BranchStatus.Merged;
  }
  if (
    artifactStatus === GitHubPRState.Closed ||
    prState === GitHubPRState.Closed
  ) {
    return BranchStatus.Closed;
  }
  return BranchStatus.Open;
}

function repeatedStringSchema(maxValues: number) {
  return z
    .union([z.string().min(1).max(200), z.array(z.string().min(1).max(200))])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .refine((value) => value.length <= maxValues, {
      message: `Expected at most ${maxValues} values`,
    });
}

function repeatedEnumSchema<
  const Values extends readonly [string, ...string[]],
>(values: Values, maxValues: number) {
  const itemSchema = z.enum(values);
  return z
    .union([itemSchema, z.array(itemSchema)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .refine((value) => value.length <= maxValues, {
      message: `Expected at most ${maxValues} values`,
    });
}

function hasBranchArtifactRow(
  row: SelectedBranchArtifact | null
): row is BranchArtifactRow {
  return Boolean(row?.branch);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isValidCloudBranchId(value: string): boolean {
  return UUID_SCHEMA.safeParse(value).success;
}

function sumFileChanges(
  changes: readonly {
    additions: number | null;
    deletions: number | null;
  }[]
) {
  if (changes.length === 0) {
    return { additions: null, deletions: null, filesChanged: null };
  }
  return {
    additions: changes.reduce(
      (sum, change) => sum + (change.additions ?? 0),
      0
    ),
    deletions: changes.reduce(
      (sum, change) => sum + (change.deletions ?? 0),
      0
    ),
    filesChanged: changes.length,
  };
}

function emptyUsage(): SessionUsage {
  return {
    sessionIds: [],
    sessions: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
  };
}

function sumUsage(usages: SessionUsage[]): UsageTotals {
  return usages.reduce<UsageTotals>(
    (sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + usage.cacheWriteTokens,
      estimatedCostUsd: sum.estimatedCostUsd + usage.estimatedCostUsd,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
    }
  );
}

function kpi(
  value: number | null,
  state: BranchKpiState = value === null
    ? BranchKpiState.Unavailable
    : BranchKpiState.Available
): BranchKpi {
  return {
    value,
    state,
    baseline30d: null,
    deltaPct: null,
  };
}

function numberFromDecimal(value: { toString(): string } | number): number {
  return typeof value === "number" ? value : Number(value.toString());
}

// Narrowed row for App branches whose installation-repo relation is present.
// Non-App branches (PRD-510 D2/FR8) have a null `repository` and are excluded.
type BranchArtifactRowWithRepository = BranchArtifactRow & {
  branch: BranchArtifactRow["branch"] & {
    repository: NonNullable<BranchArtifactRow["branch"]["repository"]>;
  };
};

function hasActiveRepository(
  row: BranchArtifactRow
): row is BranchArtifactRowWithRepository {
  const repository = row.branch.repository;
  if (!repository) {
    return false;
  }
  return (
    repository.removedAt === null &&
    repository.installation.status === GitHubInstallationStatus.ACTIVE
  );
}

function toIso(value: Date): string {
  return value.toISOString();
}

type SessionUsage = UsageTotals & {
  sessionIds: string[];
  sessions: BranchPageDetail["sessions"];
};

type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
};
