import {
  BRANCH_CONTRIBUTOR_USER_ID_PARAM,
  BRANCH_LOC_MAX_PARAM,
  BRANCH_LOC_MIN_PARAM,
  BRANCH_SESSION_PRESENCE_PARAM,
  type BranchAnalytics,
  type BranchCommit,
  type BranchListResponse,
  type BranchPageDetail,
  BranchRefreshReason,
  type BranchRefreshResponse,
  BranchRefreshStatus,
  BranchSessionPresence,
  BranchStatus,
  type BranchTagPermissions,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  type BranchAnalyticsCohortRequest,
  type BranchAnalyticsCohortResponse,
  cloudBranchAnalyticsCohortRequestSchema,
} from "@repo/api/src/types/branch-analytics-cohort";
import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import type { BranchTraceResponse } from "@repo/api/src/types/branch-trace";
import type { BranchUsageSummary } from "@repo/api/src/types/branch-usage";
import {
  GitHubFetchCredentialType,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import { clamp } from "@repo/api/src/utils/math";
import {
  GitHubInstallationStatus,
  type PrismaClient,
  withDb,
} from "@repo/database";
import {
  GitHubProviderResultStatus,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import { z } from "zod";
import {
  collectDistinctSessionIds,
  evenSplitBranchCostByBranch,
} from "@/app/branches/branch-cost-attribution";
import {
  GitHubServerSyncReason,
  GitHubServerSyncStatus,
  githubServerSyncService,
} from "@/app/integrations/github/sync-service";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { readWithInstallationClient } from "@/lib/github/installation-client";
import {
  type BranchAnalyticsMetrics,
  buildBranchAnalytics,
} from "./branch-analytics-kpis";
import type { BranchAnalyticsArtifactRow } from "./branch-analytics-select";
import {
  projectCloudBranchAssociatedPullRequests,
  resolveCloudBranchAssociatedPullRequest,
  statusForSelectedCloudPullRequest,
} from "./branch-associated-pull-request-projection";
import {
  getBranchCandidateIds,
  getBranchCandidatePage,
  getBranchCandidateSnapshots,
} from "./branch-candidate-read";
import {
  attachCanonicalDetailMetrics,
  projectCloudCanonicalMetrics,
  selectedCyclePushAt,
} from "./branch-canonical-metric-projection";
import {
  isValidCloudBranchId,
  prepareCanonicalMetricUsage,
  resolveCanonicalMetricCohort,
  selectedPullRequestLoc,
} from "./branch-canonical-metric-usage";
import {
  buildBranchPhaseAttribution,
  lifecycleStacksFromPhaseAttribution,
} from "./branch-lifecycle-phase-rollup";
import { analyticsPullRequestSize, currentFileTotals } from "./branch-loc";
import { settleActiveBranchPullRequestRefresh } from "./branch-pull-request-authority-refresh";
import {
  BRANCH_REVIEWED_PARTICIPANTS_LIMIT as branchReviewedParticipantsLimit,
  selectedBranchPullRequestDetailSelect,
} from "./branch-read-selects";
import { attachBranchActivitySegments } from "./branch-read-service/activity-segments";
import {
  finalizeCanonicalCloudBranchDetail,
  projectCanonicalCloudBranchDetail,
  projectCanonicalCloudBranchRow,
  projectCloudBranchRefreshDetail,
} from "./branch-read-service/canonical-projection";
import {
  attachCanonicalCloudDetailCost,
  synchronizeCanonicalCloudDetailCost,
} from "./branch-read-service/detail-cost";
import {
  resolveBranchDetailIdentityData,
  resolveBranchListIdentityData,
} from "./branch-read-service/identity-attribution";
import {
  attachSessionOwnerNames,
  buildBranchByActor,
} from "./branch-read-service/owner-attribution";
import {
  type BranchArtifactRow,
  type BranchDetailArtifactRow,
  findBranchArtifact,
  getBranchAnalyticsRows,
  getBranchRowsById,
} from "./branch-read-service/persisted-row-read";
import {
  distinctSessionCostMap,
  getBranchLifetimeUsage,
  getSessionUsageWithCostCompleteness,
  sessionUsageDateWindow,
  sumDistinctSessionUsage,
  toIso,
} from "./branch-read-service/session-usage-window";
import { getOwnedCurrentPullRequestDetail } from "./branch-remote-evidence";
import { branchTraceService } from "./branch-trace-service";
import {
  createPullRequestRestAuthorityProvenance,
  persistPullRequestProviderFailure,
  toPullRequestRestAuthorityObservation,
} from "./pull-request-authority-producer";
import {
  getSessionBranchCounts,
  warnOnDivisorBelowInSetCount,
} from "./session-branch-divisor";

export const BRANCH_LIST_DEFAULT_LIMIT = 50;
export const BRANCH_LIST_MAX_LIMIT = 100;
const BRANCH_LIST_MAX_OFFSET = 10_000;
const BRANCH_FILTER_MAX_VALUES = 25;
// FEA-4003 — upper bound on an accepted LOC-range value. Ten million lines is
// well past any real branch's churn; it caps the query param so a hostile or
// nonsensical value cannot be echoed into the SQL predicate.
const BRANCH_LOC_MAX_VALUE = 10_000_000;
const BRANCH_TRACE_DEFAULT_LIMIT = 50;
const BRANCH_TRACE_MAX_LIMIT = 100;

// Inline review participants are a branch-detail summary, not a paginated review
// history. Keep the relation bounded so one noisy PR cannot make every detail
// read shape unbounded provider data.
export const BRANCH_REVIEWED_PARTICIPANTS_LIMIT =
  branchReviewedParticipantsLimit;

const BRANCH_REFRESH_WINDOW_MS = 30_000;
const BRANCH_REFRESH_ORG_BUCKET_LIMIT = 20;
const BRANCH_REFRESH_ACTOR_BUCKET_LIMIT = 5;
const BRANCH_REFRESH_BUCKET_PREFIX = "branch_refresh";
const branchFilterStatusValues = [
  BranchStatus.Open,
  BranchStatus.Merged,
  BranchStatus.Closed,
  BranchStatus.Draft,
] as const;

// Normalizes a blank/whitespace-only query value to `undefined` BEFORE numeric
// coercion. Without this `z.coerce.number("")` is 0, so `?locMin=`/`?locMax=`
// (an empty bound) would activate a spurious 0 filter instead of leaving the
// bound unset. Non-string values pass through for Zod to coerce/validate.
function blankToUndefined(value: unknown): unknown {
  if (typeof value === "string" && value.trim() === "") {
    return;
  }
  return value;
}

// A single optional non-negative-integer LOC bound (min/max share this shape).
const locBoundSchema = z.preprocess(
  blankToUndefined,
  z.coerce.number().int().min(0).max(BRANCH_LOC_MAX_VALUE).optional()
);

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
    [BRANCH_CONTRIBUTOR_USER_ID_PARAM]: z.string().trim().uuid().optional(),
    // FEA-3826 — accept the legacy has/none literals for old URLs and clients,
    // but intentionally ignore the parsed value when building Branch candidates.
    // Unknown literals still fail validation rather than widening compatibility.
    [BRANCH_SESSION_PRESENCE_PARAM]: z
      .enum([BranchSessionPresence.Has, BranchSessionPresence.None])
      .optional(),
    // FEA-4003 — LOC-change range over `additions + deletions`. Non-negative
    // integer bounds (min floored at 0 by `.min(0)`); the predicate excludes
    // LOC-unavailable branches once either bound is present. A blank/whitespace
    // value (e.g. `?locMax=`) normalizes to `undefined` so the bound stays UNSET
    // rather than coercing to a max-0 filter (see `blankToUndefined`).
    [BRANCH_LOC_MIN_PARAM]: locBoundSchema,
    [BRANCH_LOC_MAX_PARAM]: locBoundSchema,
  })
  .strict()
  // Reject an inverted range up front (min > max) so the service never receives
  // an empty-by-construction window it would silently return nothing for.
  .refine(
    (query) =>
      query[BRANCH_LOC_MIN_PARAM] === undefined ||
      query[BRANCH_LOC_MAX_PARAM] === undefined ||
      query[BRANCH_LOC_MIN_PARAM] <= query[BRANCH_LOC_MAX_PARAM],
    {
      message: `${BRANCH_LOC_MIN_PARAM} must be less than or equal to ${BRANCH_LOC_MAX_PARAM}`,
      path: [BRANCH_LOC_MIN_PARAM],
    }
  );

export const branchTraceQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(BRANCH_TRACE_MAX_LIMIT)
      .default(BRANCH_TRACE_DEFAULT_LIMIT),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(BRANCH_LIST_MAX_OFFSET)
      .default(0),
  })
  .strict();

export type BranchListQuery = z.infer<typeof branchListQuerySchema>;
export type BranchTraceQuery = z.infer<typeof branchTraceQuerySchema>;

type RefreshActor = {
  userId: string;
  authMethod: string;
  tagPermissions?: BranchTagPermissions;
};

export const branchReadService = {
  listBranches(
    organizationId: string,
    query: BranchListQuery,
    tagPermissions?: BranchTagPermissions
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
      const pageRows = await getBranchRowsById(
        db,
        organizationId,
        page.ids,
        page.candidates
      );
      // FEA-4270: per-branch spend and the `sessionCostUsd` map the client uses
      // to re-derive filtered spend/KLOC-per-$ must honor the same date window as
      // the branch selection, or a windowed list re-counts lifetime session cost.
      const {
        windowed: sessionUsageByBranch,
        lifetime: lifetimeUsageByBranch,
        identityByBranch,
      } = await resolveBranchListIdentityData(
        db,
        organizationId,
        pageRows,
        sessionUsageDateWindow(query)
      );
      // FEA-3695 — authoritative per-session cost for this page's rows, each
      // session once (deduped on the non-nullable session id). Windowed (FEA-4270):
      // feeds the client's filtered AI-spend re-derivation.
      const sessionCostMap = distinctSessionCostMap(sessionUsageByBranch);
      const pageSessionCost =
        Object.keys(sessionCostMap).length > 0 ? sessionCostMap : undefined;
      // ISS-4632 — the LIFETIME per-session cost map (same shape, no window) the
      // client uses for the Value-per-$ ratio denominator, so the ratio divides
      // lifetime churn by lifetime spend, removing the SPEND axis's
      // window-sensitivity. `lifetimeUsageByBranch` comes from the SAME one-scan
      // read as the windowed map above (wongk/shafty023 review — no second
      // artifactLink scan, no independent failure domain).
      const lifetimeSessionCostMap = distinctSessionCostMap(
        lifetimeUsageByBranch
      );
      const pageLifetimeSessionCost =
        Object.keys(lifetimeSessionCostMap).length > 0
          ? lifetimeSessionCostMap
          : undefined;
      // FEA-4331 — each session's GLOBAL active-write branch count (the even-split
      // divisor), fetched once for every distinct session on the page. Each list
      // row's ADDITIVE `attributedCostUsd` is then that session's cost ÷ its branch
      // count, so a session shared across N branches contributes only each branch's
      // 1/N share instead of its full cost to all N. (`estimatedCostUsd` stays the
      // stable raw replicated total for pre-FEA-4331 clients — see `toBranchRow`.)
      // `getSessionBranchCounts` mirrors the branch-detail divisor exactly (same
      // links, same unfiltered global scope), so the row's `attributedCostUsd` and
      // the detail header agree per branch.
      // ISS-4689 — the ids come from the LIFETIME usage map, the same map that
      // sources `lifetimeSessionCostUsd` above, so the divisor and the cost it
      // divides are always read off ONE map.
      //
      // To be precise about what this is and is not (review of this PR): today it
      // is a NO-OP, not a fix. `usage.sessionIds` is IDENTITY, not spend —
      // `accumulateSessionLink` pushes the id after the valid-session and
      // participation gates but BEFORE any window gating — and the windowed and
      // lifetime folds run over the same `allLinks` with the same participation
      // option, differing only in `windowedSpend`. So the two id sets are equal by
      // construction and either source yields the same wire map. It reads off the
      // lifetime map for source-alignment, so a future divergence between the two
      // folds cannot leave a session priced in `lifetimeSessionCostUsd` yet
      // missing a divisor. That equality is not self-evident from these two lines,
      // so it is pinned by `branch-read-service.date-window.test.ts` →
      // "carries the SAME session-id set in the windowed and lifetime usage maps".
      const sessionIds = collectDistinctSessionIds(lifetimeUsageByBranch);
      const branchCounts =
        sessionIds.length > 0
          ? await getSessionBranchCounts(db, organizationId, sessionIds)
          : new Map<string, number>();
      // A global count BELOW the in-set count means the two scans disagree about
      // corpus scope. The kernel's floor keeps the rendered ratio honest, but the
      // disagreement itself is a corrupt-source signal — raise it here, where both
      // numbers are in hand, instead of letting the floor absorb it silently.
      warnOnDivisorBelowInSetCount(branchCounts, sessionUsageByBranch, {
        organizationId,
      });
      // ISS-4689 — surface those GLOBAL divisors on the wire so the client's
      // re-derived Value-per-$ card (`deriveFilteredBranchAnalytics`, which always
      // overrides the server's `locPerDollar`) divides by the same corpus-wide
      // count this producer does instead of the count of branches that survived
      // the window/facets/pagination. Omitted when the page links no session, so
      // an unpriced page's wire shape is unchanged.
      const pageSessionBranchCount =
        branchCounts.size > 0 ? Object.fromEntries(branchCounts) : undefined;
      const evenSplitCostByBranch = evenSplitBranchCostByBranch(
        sessionUsageByBranch,
        branchCounts
      );
      return {
        items: pageRows.map((row) =>
          projectCanonicalCloudBranchRow(
            row,
            organizationId,
            tagPermissions,
            sessionUsageByBranch.get(row.id),
            identityByBranch.get(row.id),
            evenSplitCostByBranch.get(row.id) ?? null
          )
        ),
        total: page.total,
        viewerScope: BranchViewerScope.Organization,
        hasMore: page.hasMore,
        // FEA-3695 — authoritative per-session cost, deduped once across the page
        // so the client's filtered spend/KLOC-per-$ re-derivation never re-counts
        // a session shared by multiple branches. Omitted when the page has no
        // linked-session usage, so the wire carries no empty-object noise.
        ...(pageSessionCost ? { sessionCostUsd: pageSessionCost } : {}),
        // ISS-4632 — lifetime (un-windowed) per-session cost for the client's
        // Value-per-$ denominator. Omitted (→ client falls back to the windowed
        // map) when the page has no linked-session usage.
        ...(pageLifetimeSessionCost
          ? { lifetimeSessionCostUsd: pageLifetimeSessionCost }
          : {}),
        // ISS-4689 — each session's GLOBAL branch count, the window-independent
        // even-split divisor for the client's Value-per-$ denominator.
        ...(pageSessionBranchCount
          ? { sessionBranchCount: pageSessionBranchCount }
          : {}),
      };
    });
  },

  getBranchDetail(
    organizationId: string,
    branchId: string,
    tagPermissions?: BranchTagPermissions,
    requestedPullRequest?: BranchSelectedPullRequestIdentity
  ): Promise<BranchPageDetail | null> {
    if (!isValidCloudBranchId(branchId)) {
      return Promise.resolve(null);
    }
    return withDb(async (db) => {
      const row = await findBranchArtifact(db, organizationId, branchId);
      if (!row) {
        return null;
      }
      const associatedPullRequests =
        projectCloudBranchAssociatedPullRequests(row);
      const resolvedAssociatedPullRequests =
        resolveCloudBranchAssociatedPullRequest(
          row,
          associatedPullRequests,
          requestedPullRequest
        );
      if (!resolvedAssociatedPullRequests) {
        return null;
      }
      const selected = resolvedAssociatedPullRequests.selected;
      // Resolve independent identity, commit, and selected-PR reads together.
      const [identityData, commits, selectedPullRequestDetail] =
        await Promise.all([
          resolveBranchDetailIdentityData(db, organizationId, row),
          getBranchCommits(db, branchId),
          selected
            ? db.pullRequestDetail.findUnique({
                where: {
                  id_branchArtifactId: {
                    id: selected.source.id,
                    branchArtifactId: row.id,
                  },
                },
                select: selectedBranchPullRequestDetailSelect,
              })
            : Promise.resolve(null),
        ]);
      const {
        usageByBranch: sessionUsageByBranch,
        identityByBranch,
        nameById,
      } = identityData;
      const usage = sessionUsageByBranch.get(branchId);
      const detail = projectCanonicalCloudBranchDetail(
        row,
        organizationId,
        tagPermissions,
        usage,
        commits,
        identityByBranch.get(branchId),
        selectedPullRequestDetail,
        resolvedAssociatedPullRequests
      );
      // Reuse the org-scoped identity map; unresolved owners remain unattributed.
      if (usage) {
        attachSessionOwnerNames(usage, detail, nameById);
      }
      if (usage && usage.sessionIds.length > 0) {
        // Detail uses the same global session/branch even-split divisor as list.
        // its own scoped read because it only loads THIS branch's usage.
        const branchCounts = await getSessionBranchCounts(
          db,
          organizationId,
          usage.sessionIds
        );
        attachCanonicalCloudDetailCost(detail, usage, branchCounts);
        const phaseCoverageReasons = await attachBranchActivitySegments(
          db,
          organizationId,
          detail.sessions
        );
        const phaseAttribution = buildBranchPhaseAttribution({
          sessions: detail.sessions,
          lifecycleEventsBySession: usage.lifecycleEventsBySession ?? new Map(),
          associatedPullRequests: detail.associatedPullRequests,
          coverageReasons: phaseCoverageReasons,
        });
        detail.phaseAttribution = phaseAttribution;
        attachCanonicalDetailMetrics(
          detail,
          phaseAttribution,
          selectedPullRequestLoc(selected?.source),
          selectedCyclePushAt(detail, usage, row.branch.firstPushedAt)
        );
        const lifecyclePhaseStacks =
          lifecycleStacksFromPhaseAttribution(phaseAttribution);
        if (lifecyclePhaseStacks.length > 0) {
          detail.lifecyclePhaseStacks = lifecyclePhaseStacks;
        }
      }
      finalizeCanonicalCloudBranchDetail(detail);
      synchronizeCanonicalCloudDetailCost(detail);
      return detail;
    });
  },

  async getBranchTrace(
    organizationId: string,
    branchId: string,
    query: BranchTraceQuery,
    signal?: AbortSignal
  ): Promise<BranchTraceResponse | null> {
    if (!isValidCloudBranchId(branchId)) {
      return null;
    }
    const limit = clamp(query.limit, 1, BRANCH_TRACE_MAX_LIMIT);
    const offset = Math.max(0, query.offset);
    // Resolve the branch and its linked session ids under one connection, then
    // release it before hydrating each session: findSessionDetail opens its own
    // connection, so a fan-out must not contend with a held outer connection.
    const qualifyingSessions = await withDb(async (db) => {
      const row = await findBranchArtifact(db, organizationId, branchId);
      if (!row) {
        return null;
      }
      return branchTraceService.findQualifyingBranchTraceSessions(
        db,
        organizationId,
        branchId
      );
    });
    if (qualifyingSessions === null) {
      return null;
    }
    // The cross-session merge interleaves every linked session chronologically,
    // so build the full trace and page the resulting items — not the sessions.
    const trace = await branchTraceService.buildCompleteBranchTrace(
      organizationId,
      qualifyingSessions,
      signal
    );
    const items = trace.items.slice(offset, offset + limit);
    return {
      branchId,
      viewerScope: BranchViewerScope.Organization,
      items,
      hasMore: offset + limit < trace.items.length,
      traceState: {
        sessions: trace.sessions,
        qualifyingSessionCount: trace.qualifyingSessionCount,
        completeness: trace.completeness,
        aggregateCompleteness: trace.aggregateCompleteness,
      },
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
      const { usageByBranch, costCompleteness } =
        await getSessionUsageWithCostCompleteness(
          db,
          organizationId,
          rows.map((row) => row.id),
          sessionUsageDateWindow(query)
        );
      const totals = sumDistinctSessionUsage(usageByBranch);
      const byActor = await buildBranchByActor(
        db,
        organizationId,
        usageByBranch
      );
      return {
        viewerScope: BranchViewerScope.Organization,
        totalBranches: rows.length,
        totalInputTokens: totals.inputTokens,
        totalOutputTokens: totals.outputTokens,
        totalCacheReadTokens: totals.cacheReadTokens,
        totalCacheWriteTokens: totals.cacheWriteTokens,
        totalEstimatedCost: totals.estimatedCostUsd,
        subscriptionEstimatedCost: totals.subscriptionEstimatedCostUsd,
        apiEstimatedCost: totals.apiEstimatedCostUsd,
        costCompleteness,
        hourBuckets: [],
        phaseStacks: [],
        byActor,
      };
    });
  },

  getBranchAnalytics(
    organizationId: string,
    query: BranchListQuery
  ): Promise<BranchAnalytics> {
    return withDb(async (db) => {
      const candidates = await getBranchCandidateSnapshots(
        db,
        organizationId,
        query
      );
      const rows = await getBranchAnalyticsRows(
        db,
        organizationId,
        candidates.map((candidate) => candidate.id),
        candidates
      );
      const canonicalRows = await resolveCanonicalMetricCohort(
        query,
        rows,
        async (cohortQuery) => {
          const cohortCandidates = await getBranchCandidateSnapshots(
            db,
            organizationId,
            cohortQuery
          );
          return getBranchAnalyticsRows(
            db,
            organizationId,
            cohortCandidates.map((candidate) => candidate.id),
            cohortCandidates
          );
        }
      );
      const { windowed: usageByBranch, lifetime: lifetimeUsageByBranch } =
        await getBranchLifetimeUsage(
          db,
          organizationId,
          canonicalRows.map((row) => row.id),
          sessionUsageDateWindow(query)
        );
      const metrics = rows.map(toBranchAnalyticsMetrics);
      const analytics = buildBranchAnalytics({
        organizationId,
        metrics,
        usageByBranch,
        lifetimeUsageByBranch,
      });
      const canonicalUsage = await prepareCanonicalMetricUsage(
        db,
        organizationId,
        lifetimeUsageByBranch
      );
      const phaseCoverageReasons = [
        ...canonicalUsage.coverageReasons,
        ...(await attachBranchActivitySegments(
          db,
          organizationId,
          [...canonicalUsage.usageByBranch.values()].flatMap(
            (usage) => usage.sessions
          )
        )),
      ];
      analytics.canonicalMetrics = projectCloudCanonicalMetrics(
        canonicalRows,
        query,
        new Date(),
        canonicalUsage.usageByBranch,
        phaseCoverageReasons
      );
      return analytics;
    });
  },

  /** Project canonical metrics for an exact authenticated-org Branch cohort. */
  getBranchCohortAnalytics(
    organizationId: string,
    rawRequest: BranchAnalyticsCohortRequest
  ): Promise<BranchAnalyticsCohortResponse> {
    const request = cloudBranchAnalyticsCohortRequestSchema.parse(rawRequest);
    const query = branchListQuerySchema.parse({
      startDate: request.startDate,
      endDate: request.endDate,
    });
    return withDb(async (db) => {
      const authorizedCandidates = await getBranchCandidateSnapshots(
        db,
        organizationId,
        { ...query, startDate: undefined, endDate: undefined },
        request.branchIds
      );
      const authorizedIdSet = new Set(
        authorizedCandidates.map((candidate) => candidate.id)
      );
      const candidateBranchIds = request.branchIds.filter((branchId) =>
        authorizedIdSet.has(branchId)
      );
      const rows = await getBranchAnalyticsRows(
        db,
        organizationId,
        candidateBranchIds,
        authorizedCandidates
      );
      const projectedIdSet = new Set(rows.map((row) => row.id));
      const matchedBranchIds = candidateBranchIds.filter((branchId) =>
        projectedIdSet.has(branchId)
      );
      const { lifetime: lifetimeUsageByBranch } = await getBranchLifetimeUsage(
        db,
        organizationId,
        matchedBranchIds,
        sessionUsageDateWindow(query)
      );
      const canonicalUsage = await prepareCanonicalMetricUsage(
        db,
        organizationId,
        lifetimeUsageByBranch
      );
      const phaseCoverageReasons = [
        ...canonicalUsage.coverageReasons,
        ...(await attachBranchActivitySegments(
          db,
          organizationId,
          [...canonicalUsage.usageByBranch.values()].flatMap(
            (usage) => usage.sessions
          )
        )),
      ];
      return {
        matchedBranchIds,
        canonicalMetrics: projectCloudCanonicalMetrics(
          rows,
          query,
          new Date(),
          canonicalUsage.usageByBranch,
          phaseCoverageReasons
        ),
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
        branch: projectCloudBranchRefreshDetail(
          target,
          organizationId,
          actor.tagPermissions
        ),
        status: BranchRefreshStatus.NotApplicable,
        reason: BranchRefreshReason.NoCurrentPullRequest,
      };
    }

    const budget = await consumeRefreshBudget(organizationId, actor, now);
    if (!budget.ok) {
      return {
        branch: projectCloudBranchRefreshDetail(
          target,
          organizationId,
          actor.tagPermissions
        ),
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
        branch: projectCloudBranchRefreshDetail(
          target,
          organizationId,
          actor.tagPermissions
        ),
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.AlreadyRefreshing,
        retryAfterSeconds: Math.ceil(BRANCH_REFRESH_WINDOW_MS / 1000),
      };
    }

    const authorityProvenance = createPullRequestRestAuthorityProvenance({
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observedAt: now,
    });
    const providerResult = await readWithInstallationClient(
      target.branch.repository.installation.installationId,
      (octokit) =>
        getSinglePullRequestWithProviderResult(
          octokit,
          target.branch.repository.owner,
          target.branch.repository.name,
          currentPr.number,
          toPullRequestRestAuthorityObservation(authorityProvenance)
        )
    );
    if (
      providerResult.status === GitHubProviderResultStatus.ProviderRateLimit
    ) {
      await withDb((db) =>
        persistPullRequestProviderFailure(
          db,
          { organizationId, pullRequestDetailId: currentPr.id },
          providerResult,
          authorityProvenance
        )
      );
      const branch = await branchReadService.getBranchDetail(
        organizationId,
        branchId,
        actor.tagPermissions
      );
      return {
        branch,
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.ProviderRateLimited,
        retryAfterSeconds: providerResult.retryAfterSeconds ?? undefined,
      };
    }
    if (providerResult.status !== GitHubProviderResultStatus.Success) {
      await withDb((db) =>
        persistPullRequestProviderFailure(
          db,
          { organizationId, pullRequestDetailId: currentPr.id },
          providerResult,
          authorityProvenance
        )
      );
      const branch = await branchReadService.getBranchDetail(
        organizationId,
        branchId,
        actor.tagPermissions
      );
      return {
        branch,
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.ProviderUnavailable,
      };
    }

    const repositoryId = target.branch.repositoryId;
    const settled = repositoryId
      ? await settleActiveBranchPullRequestRefresh({
          organizationId,
          branchArtifactId: target.id,
          repositoryId,
          pullRequestDetailId: currentPr.id,
          freshPr: providerResult.value,
          now,
        })
      : false;
    if (!settled) {
      return {
        branch: projectCloudBranchRefreshDetail(
          target,
          organizationId,
          actor.tagPermissions
        ),
        status: BranchRefreshStatus.Failed,
        reason: BranchRefreshReason.GuardedWriteFailed,
      };
    }
    const branch = await branchReadService.getBranchDetail(
      organizationId,
      branchId,
      actor.tagPermissions
    );
    return {
      branch,
      status: BranchRefreshStatus.Refreshed,
    };
  },
};

// The branch-read subsystem's shared Prisma client: the ten delegates fanned out
// across this file's read/refresh helpers. Owned here (its composition root)
// rather than in `branch-read-service/session-usage-window.ts`, which needs
// only the narrow two-delegate `SessionUsageClient` (wongk review, #4207).
type BranchReadClient = Pick<
  PrismaClient,
  | "$queryRaw"
  | "agentSessionActivitySegment"
  | "agentSessionTokenEvent"
  | "artifact"
  | "artifactLink"
  | "comment"
  | "commentThread"
  | "commitDetail"
  | "gitHubCommentProjection"
  | "gitHubUserConnection"
  | "oAuthRateLimit"
  | "pullRequestDetail"
  | "user"
>;

async function refreshTombstonedBranchPullRequest(
  organizationId: string,
  branchId: string,
  actor: RefreshActor,
  target: BranchDetailArtifactRow
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
      branch: await branchReadService.getBranchDetail(
        organizationId,
        branchId,
        actor.tagPermissions
      ),
      status: BranchRefreshStatus.Refreshed,
    };
  }
  if (syncResult.status === GitHubServerSyncStatus.Retryable) {
    return {
      branch: projectCloudBranchRefreshDetail(
        target,
        organizationId,
        actor.tagPermissions
      ),
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
    branch: projectCloudBranchRefreshDetail(
      target,
      organizationId,
      actor.tagPermissions
    ),
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

function toBranchAnalyticsMetrics(
  row: BranchAnalyticsArtifactRow
): BranchAnalyticsMetrics {
  const associatedPullRequests = projectCloudBranchAssociatedPullRequests(row);
  const pr = associatedPullRequests.selected?.source ?? null;
  const status = statusForSelectedCloudPullRequest(row.status, pr);
  const fileTotals = currentFileTotals(
    row.branch.fileChanges,
    row.branch.fileCacheHeadSha,
    row.branch.headSha
  );
  return {
    id: row.id,
    status,
    prState: pr?.prState ?? null,
    mergedAt: pr?.mergedAt ?? null,
    additions: fileTotals.additions,
    deletions: fileTotals.deletions,
    prSize: analyticsPullRequestSize(status, fileTotals),
  };
}

/**
 * The branch's real git commits for the PRD-486 activity rail, read from the
 * persisted CommitDetail SSOT (PRD-510 D7) — the SAME data the desktop producer
 * captures event-time — mapped oldest-first to the wire `BranchCommit`. Scoped by
 * `branchArtifactId` alone, per the CommitDetail D4 rule that reads reach the row
 * through its (already org-verified) branch, not via `organizationId` (which the
 * schema documents as a dedup-only, non-query-scoping column). The sole caller
 * resolves the branch through the `findBranchArtifact` org-scope seam first, so
 * the branch id is already proven org-owned before this read runs. A row with no
 * `committedAt` cannot be positioned on the rail, so it is dropped rather than
 * shipped with a fabricated instant. Sorted defensively (the read already orders
 * by committedAt) to mirror the desktop producer's explicit rail sort
 * (shared-branches-api.ts).
 */
async function getBranchCommits(
  db: BranchReadClient,
  branchArtifactId: string
): Promise<BranchCommit[]> {
  const rows = await db.commitDetail.findMany({
    where: { branchArtifactId },
    orderBy: { committedAt: "asc" },
    select: { sha: true, committedAt: true, message: true },
  });
  return rows
    .filter(
      (row): row is typeof row & { committedAt: Date } =>
        row.committedAt !== null
    )
    .sort((a, b) => a.committedAt.getTime() - b.committedAt.getTime())
    .map((row) => ({
      sha: row.sha,
      committedAt: toIso(row.committedAt),
      message: row.message ?? "",
    }));
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
