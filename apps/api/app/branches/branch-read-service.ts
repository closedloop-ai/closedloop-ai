import {
  type BranchAnalytics,
  type BranchListResponse,
  type BranchPageDetail,
  BranchRefreshReason,
  type BranchRefreshResponse,
  BranchRefreshStatus,
  type BranchTagPermissions,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import type {
  BranchAnalyticsCohortRequest,
  BranchAnalyticsCohortResponse,
} from "@repo/api/src/types/branch-analytics-cohort";
import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import { isValidCloudBranchId } from "@repo/api/src/types/branch-id";
import {
  BranchListCohortScope,
  branchListCohortKey,
} from "@repo/api/src/types/branch-list-cohort";
import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import type { BranchStatusOrdering } from "@repo/api/src/types/branch-status-order";
import type { BranchTraceResponse } from "@repo/api/src/types/branch-trace";
import type { BranchUsageSummary } from "@repo/api/src/types/branch-usage";
import {
  GitHubFetchCredentialType,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import { clamp } from "@repo/api/src/utils/math";
import { withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import { compactBranchDetailPayload } from "@repo/lib/branches/branch-detail-payload";
import {
  collectDistinctSessionIds,
  evenSplitBranchCostByBranch,
} from "@/app/branches/branch-cost-attribution";
import { readWithInstallationClient } from "@/lib/github/installation-client";
import {
  type CohortPenseroPointsReader,
  readBranchAnalytics,
  readBranchCohortAnalytics,
} from "./branch-analytics-read";
import {
  projectCloudOwnedBranchAssociatedPullRequests,
  resolveCloudBranchAssociatedPullRequest,
} from "./branch-associated-pull-request-projection";
import {
  getBranchCandidateIds,
  getBranchCandidatePage,
} from "./branch-candidate-read";
import {
  attachCanonicalDetailMetrics,
  selectedCyclePushAt,
} from "./branch-canonical-metric-projection";
import { selectedPullRequestLoc } from "./branch-canonical-metric-usage";
import { buildBranchLastActiveCohort } from "./branch-last-active-cohort";
import {
  BranchLastActiveScanScope,
  reportImpossibleBranchLastActiveInstants,
} from "./branch-last-active-instant-report";
import {
  buildBranchPhaseAttribution,
  lifecycleStacksFromPhaseAttribution,
} from "./branch-lifecycle-phase-rollup";
import { withBranchListCustomFieldValues } from "./branch-list-custom-field-values";
import { readBranchListFailingOpen } from "./branch-list-enrichment";
import {
  attributedCostForRow,
  resolveBranchListIdentityDataBestEffort,
  resolveGlobalSessionBranchCountsBestEffort,
} from "./branch-list-projection";
import {
  BRANCH_LIST_MAX_LIMIT,
  type BranchListQuery,
  type BranchTraceQuery,
  branchListQuerySchema,
} from "./branch-list-query";
import { withBranchFailedAcquisitionDay } from "./branch-pensero-failed-day";
import {
  BranchProductReadWorkload,
  withBranchProductReadSnapshot,
} from "./branch-product-read-snapshot";
import { cloudPublicationLocEvidence } from "./branch-publication-loc-projection";
import { settleActiveBranchPullRequestRefresh } from "./branch-pull-request-authority-refresh";
import {
  loadBranchPushLocAtomsFailingOpen,
  withBranchPushLocEvidence,
} from "./branch-push-loc-read";
import {
  BRANCH_REVIEWED_PARTICIPANTS_LIMIT as branchReviewedParticipantsLimit,
  selectedBranchPullRequestDetailSelect,
} from "./branch-read-selects";
import { attachBranchActivitySegments } from "./branch-read-service/activity-segments";
import { readCloudBranchTrace } from "./branch-read-service/branch-trace-read";
import {
  createGlobalDivisorCandidateMemo,
  loadCanonicalDetailDivisor,
  loadOrgMergedPullRequestAdmissionForRows,
} from "./branch-read-service/canonical-metric-populations";
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
import { resolveBranchDetailIdentityData } from "./branch-read-service/identity-attribution";
import {
  type BranchDetailReadOptions,
  refreshBranchDetailPullRequest,
} from "./branch-read-service/on-read-refresh";
import {
  attachSessionOwnerNames,
  buildBranchByActor,
} from "./branch-read-service/owner-attribution";
import {
  findBranchArtifact,
  getBranchCommits,
  getBranchRowsById,
} from "./branch-read-service/persisted-row-read";
import { listServerPageBranches } from "./branch-read-service/server-page-list";
import {
  distinctSessionCostMap,
  getSessionUsageWithCostCompleteness,
  sessionUsageDateWindow,
  sumDistinctSessionUsage,
} from "./branch-read-service/session-usage-window";
import {
  BRANCH_REFRESH_RETRY_AFTER_SECONDS,
  claimPullRequestRefresh,
  consumeRefreshBudget,
  finalizeBranchRefreshResponse,
  hasActiveRepository,
  type RecordRefreshBudgetConsumed,
  type RefreshActor,
  refreshTombstonedBranchPullRequest,
} from "./branch-refresh-support";
import { getOwnedCurrentPullRequestDetail } from "./branch-remote-evidence";
import { branchHasCloudEligibility } from "./cloud-branch-eligibility";
import {
  createPullRequestRestAuthorityProvenance,
  persistPullRequestProviderFailure,
  toPullRequestRestAuthorityObservation,
} from "./pull-request-authority-producer";
import { warnOnDivisorBelowInSetCount } from "./session-branch-divisor";
import {
  isTier2BranchPullRequestRefreshInFlight,
  refreshResponseFromTier2Outcome,
  refreshTier2TargetedBranchPullRequest,
  shouldRefreshTier2BranchPullRequestOnRead,
} from "./tier2-targeted-branch-refresh";

// Inline review participants are a branch-detail summary, not a paginated review
// history. Keep the relation bounded so one noisy PR cannot make every detail
// read shape unbounded provider data.
export const BRANCH_REVIEWED_PARTICIPANTS_LIMIT =
  branchReviewedParticipantsLimit;
export const branchReadService = {
  /**
   * ISS-9437: `statusOrdering` arrives ALREADY RESOLVED, from the route. The
   * flag read is a PostHog round trip and everything below runs inside
   * `withBranchProductReadSnapshot`'s RepeatableRead transaction (2s maxWait,
   * and an execution budget that depends on the page mode below — ISS-10295,
   * ISS-10300), so resolving it here would spend that budget on the network.
   * Omitted means today's ordering.
   */
  async listBranches(
    organizationId: string,
    query: BranchListQuery,
    tagPermissions?: BranchTagPermissions,
    statusOrdering?: BranchStatusOrdering
  ): Promise<BranchListResponse> {
    const limit = clamp(query.limit, 1, BRANCH_LIST_MAX_LIMIT);
    const offset = Math.max(0, query.offset);
    // The first page captures an actual operation instant. The complete-list
    // adapter reuses the returned instant for continuation pages, keeping SQL
    // membership, ordering, counts, and the envelope on one snapshot clock.
    const evaluationNow = new Date();
    // Server pagination still scans the corpus for ordering and facets, so it
    // keeps ISS-10300's full-corpus budget. ISS-10298 limits the subsequent
    // hydration and projection to page IDs. The legacy arm stays page-bounded.
    const listWorkload =
      query.pageMode === BranchListPageMode.Server
        ? BranchProductReadWorkload.FullCorpus
        : BranchProductReadWorkload.Bounded;
    const response = await readBranchListFailingOpen(
      organizationId,
      async (db, enrichment) => {
        const globalDivisorMemo = createGlobalDivisorCandidateMemo();
        if (query.pageMode === BranchListPageMode.Server) {
          return listServerPageBranches(
            db,
            organizationId,
            tagPermissions,
            query,
            evaluationNow,
            enrichment,
            statusOrdering
          );
        }
        const page = await getBranchCandidatePage(
          db,
          organizationId,
          query,
          limit,
          offset,
          evaluationNow
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
        } = await resolveBranchListIdentityDataBestEffort(
          db,
          organizationId,
          pageRows,
          sessionUsageDateWindow(query),
          enrichment
        );
        // Windowed, deduplicated Session cost for client-side spend re-derivation.
        const sessionCostMap = distinctSessionCostMap(sessionUsageByBranch);
        const pageSessionCost =
          Object.keys(sessionCostMap).length > 0 ? sessionCostMap : undefined;
        // Lifetime cost comes from the same scan so LOC/$ never inherits the
        // selected List window or a second failure domain.
        const lifetimeSessionCostMap = distinctSessionCostMap(
          lifetimeUsageByBranch
        );
        const pageLifetimeSessionCost =
          Object.keys(lifetimeSessionCostMap).length > 0
            ? lifetimeSessionCostMap
            : undefined;
        // Resolve lifetime divisors against one bounded, filter-independent,
        // pre-publication authority snapshot; a capped read stays unavailable.
        const sessionIds = collectDistinctSessionIds(lifetimeUsageByBranch);
        const branchCounts = await resolveGlobalSessionBranchCountsBestEffort({
          db,
          organizationId,
          sessionIds,
          globalQuery: branchListQuerySchema.parse({}),
          memo: globalDivisorMemo,
          enrichment,
        });
        // A global count below the in-set count is corrupt-source evidence; warn
        // here instead of letting the kernel's safety floor hide it.
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
        const items = pageRows.map((row) =>
          projectCanonicalCloudBranchRow(
            row,
            organizationId,
            tagPermissions,
            sessionUsageByBranch.get(row.id),
            identityByBranch.get(row.id),
            attributedCostForRow(evenSplitCostByBranch, row.id, enrichment)
          )
        );
        // ISS-9482: a stored Last-active instant that cannot be true is retained
        // by the window under the same shape as one that is simply absent, so
        // without this the two are indistinguishable on every poll.
        reportImpossibleBranchLastActiveInstants({
          rows: items,
          nowIso: page.evaluationNow.toISOString(),
          organizationId,
          scanScope: BranchLastActiveScanScope.Page,
        });
        return {
          items,
          total: page.total,
          viewerScope: BranchViewerScope.Organization,
          hasMore: page.hasMore,
          lastActiveCohort: buildBranchLastActiveCohort(
            {
              scope: BranchListCohortScope.RequestFilters,
              cohortKey: branchListCohortKey(query),
              evaluationNow: page.evaluationNow,
              total: page.total,
              retainedUnavailable: page.retainedUnavailableCount,
            },
            { organizationId }
          ),
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
      },
      listWorkload
    );
    // ISS-12663: outside the snapshot, so it can never abort the list read.
    return withBranchListCustomFieldValues(organizationId, response);
  },

  getBranchDetail(
    organizationId: string,
    branchId: string,
    tagPermissions?: BranchTagPermissions,
    requestedPullRequest?: BranchSelectedPullRequestIdentity,
    options: BranchDetailReadOptions = {}
  ): Promise<BranchPageDetail | null> {
    if (!isValidCloudBranchId(branchId)) {
      return Promise.resolve(null);
    }
    return withDb(async (db) => {
      const globalDivisorMemo = createGlobalDivisorCandidateMemo();
      const row = await findBranchArtifact(db, organizationId, branchId);
      if (!row) {
        return null;
      }
      const associatedPullRequests =
        projectCloudOwnedBranchAssociatedPullRequests(row);
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
      // ISS-7140 — the Product gate depends only on (organizationId, branchId),
      // so it rides along free here and lets an ineligible Branch skip the
      // divisor pager, activity read, and projection below. ISS-12278: no
      // provider work follows it on the detail read, so it is that read's
      // fail-closed edge too.
      const [
        identityData,
        commits,
        selectedPullRequestDetail,
        orgMergedPullRequestAdmissionByBranchId,
        remainsEligible,
        pushLocEvidence,
      ] = await Promise.all([
        // ISS-11767: stored PR comments and their lane proof are separate
        // statements. One snapshot keeps a reconcile that commits between them
        // from reporting the PR-comment source complete over a stale author
        // set, matching the list's single statement and the batch route's tx.
        withBranchProductReadSnapshot(organizationId, (snapshot) =>
          resolveBranchDetailIdentityData(snapshot, organizationId, row)
        ),
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
        loadOrgMergedPullRequestAdmissionForRows(db, organizationId, [row]),
        branchHasCloudEligibility(db, organizationId, branchId),
        loadBranchPushLocAtomsFailingOpen(db, organizationId, [row.id]),
      ]);
      if (!remainsEligible) {
        return null;
      }
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
        const detailDivisor = await loadCanonicalDetailDivisor(
          db,
          organizationId,
          usage.sessionIds,
          branchListQuerySchema.parse({}),
          globalDivisorMemo
        );
        attachCanonicalCloudDetailCost(
          detail,
          usage,
          detailDivisor.branchCounts
        );
        const phaseCoverageReasons = [
          ...(await attachBranchActivitySegments(
            db,
            organizationId,
            detail.sessions
          )),
          ...detailDivisor.coverageReasons,
        ];
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
          selectedCyclePushAt(detail, usage, row.branch.firstPushedAt),
          cloudPublicationLocEvidence(
            withBranchPushLocEvidence([row], pushLocEvidence),
            orgMergedPullRequestAdmissionByBranchId
          ),
          usage.sessionIds.length,
          await withBranchFailedAcquisitionDay(
            await options.penseroPoints,
            organizationId,
            detail.leadTime
          )
        );
        const lifecyclePhaseStacks =
          lifecycleStacksFromPhaseAttribution(phaseAttribution);
        if (lifecyclePhaseStacks.length > 0) {
          detail.lifecyclePhaseStacks = lifecyclePhaseStacks;
        }
      }
      finalizeCanonicalCloudBranchDetail(detail);
      synchronizeCanonicalCloudDetailCost(detail);
      // ISS-12278 (Marisol Ashgrove ruling, 2026-10-08, PRD-792 thread): the
      // route schedules a due refresh after responding. The flag also stays up
      // while a claimed refresh has not landed, so the client's bounded
      // follow-up refetch does not stop before the refreshed row exists.
      flagPullRequestRefresh(detail, row, selected?.source, options);
      return compactBranchDetailPayload(detail);
    });
  },

  /** ISS-12278: the detail read's stale-PR refresh, scheduled after its response. */
  refreshBranchDetailPullRequest,

  getBranchTrace(
    organizationId: string,
    branchId: string,
    query: BranchTraceQuery,
    signal?: AbortSignal
  ): Promise<BranchTraceResponse | null> {
    return readCloudBranchTrace(organizationId, branchId, query, signal);
  },

  getBranchUsage(
    organizationId: string,
    query: BranchListQuery
  ): Promise<BranchUsageSummary> {
    return withBranchProductReadSnapshot(
      organizationId,
      async (db) => {
        // A usage summary aggregates over the entire filtered branch set, not a
        // single list page: applying skip/take here would undercount the token
        // and cost totals (and totalBranches) for orgs with more than one page
        // of branches. Use the same full-corpus candidate path as
        // getBranchAnalytics so the filter predicates stay consistent.
        const branchIds = await getBranchCandidateIds(
          db,
          organizationId,
          query
        );
        const { usageByBranch, costCompleteness } =
          await getSessionUsageWithCostCompleteness(
            db,
            organizationId,
            branchIds,
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
          totalBranches: branchIds.length,
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
      },
      BranchProductReadWorkload.FullCorpus
    );
  },

  getBranchAnalytics(
    organizationId: string,
    query: BranchListQuery,
    /** ISS-11117. See {@link readBranchAnalytics}. */
    readCohortPenseroPoints?: CohortPenseroPointsReader
  ): Promise<BranchAnalytics> {
    return readBranchAnalytics(organizationId, query, readCohortPenseroPoints);
  },

  /** Project canonical metrics for an exact authenticated-org Branch cohort. */
  getBranchCohortAnalytics(
    organizationId: string,
    rawRequest: BranchAnalyticsCohortRequest,
    /** ISS-11117. See {@link readBranchCohortAnalytics}. */
    readCohortPenseroPoints?: CohortPenseroPointsReader
  ): Promise<BranchAnalyticsCohortResponse> {
    return readBranchCohortAnalytics(
      organizationId,
      rawRequest,
      readCohortPenseroPoints
    );
  },

  /**
   * `recordBudgetConsumed` runs on the transaction that spends the caller's
   * refresh budget (ISS-12552); the GitHub projections that follow are a sync
   * of GitHub state and record nothing.
   */
  async refreshBranch(
    organizationId: string,
    branchId: string,
    actor: RefreshActor,
    recordBudgetConsumed?: RecordRefreshBudgetConsumed
  ): Promise<BranchRefreshResponse> {
    const finalize = (response: BranchRefreshResponse) =>
      finalizeBranchRefreshResponse(organizationId, branchId, response);
    if (!isValidCloudBranchId(branchId)) {
      return finalize({
        branch: null,
        status: BranchRefreshStatus.Failed,
        reason: BranchRefreshReason.InvalidBranchId,
      });
    }
    const now = new Date();
    const target = await withDb((db) =>
      findBranchArtifact(db, organizationId, branchId)
    );
    if (!target) {
      return finalize({
        branch: null,
        status: BranchRefreshStatus.Failed,
        reason: BranchRefreshReason.NotFound,
      });
    }
    const currentPr = getOwnedCurrentPullRequestDetail(target);
    if (!currentPr?.number) {
      return finalize({
        branch: projectCloudBranchRefreshDetail(
          target,
          organizationId,
          actor.tagPermissions
        ),
        status: BranchRefreshStatus.NotApplicable,
        reason: BranchRefreshReason.NoCurrentPullRequest,
      });
    }

    const budget = await consumeRefreshBudget(
      organizationId,
      actor,
      now,
      recordBudgetConsumed
    );
    if (!budget.ok) {
      return finalize({
        branch: projectCloudBranchRefreshDetail(
          target,
          organizationId,
          actor.tagPermissions
        ),
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.BudgetExhausted,
        retryAfterSeconds: budget.retryAfterSeconds,
      });
    }

    if (!hasActiveRepository(target)) {
      if (target.branch.repositoryId === null) {
        const tier2Refresh = await refreshTier2TargetedBranchPullRequest({
          organizationId,
          target,
          pullRequestDetailId: currentPr.id,
          pullRequestNumber: currentPr.number,
          now,
          trigger: GitHubFetchTrigger.UserAction,
        });
        const branch = tier2Refresh.shouldReloadBranch
          ? await branchReadService.getBranchDetail(
              organizationId,
              branchId,
              actor.tagPermissions
            )
          : projectCloudBranchRefreshDetail(
              target,
              organizationId,
              actor.tagPermissions
            );
        return finalize(refreshResponseFromTier2Outcome(tier2Refresh, branch));
      }
      const tombstonedRefresh = await refreshTombstonedBranchPullRequest(
        organizationId,
        branchId,
        actor,
        target,
        branchReadService.getBranchDetail
      );
      return finalize(tombstonedRefresh);
    }

    const claimed = await claimPullRequestRefresh(
      organizationId,
      target,
      currentPr.id,
      now
    );
    if (!claimed) {
      return finalize({
        branch: projectCloudBranchRefreshDetail(
          target,
          organizationId,
          actor.tagPermissions
        ),
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.AlreadyRefreshing,
        retryAfterSeconds: BRANCH_REFRESH_RETRY_AFTER_SECONDS,
      });
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
      return finalize({
        branch,
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.ProviderRateLimited,
        retryAfterSeconds: providerResult.retryAfterSeconds ?? undefined,
      });
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
      return finalize({
        branch,
        status: BranchRefreshStatus.Retryable,
        reason: BranchRefreshReason.ProviderUnavailable,
      });
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
      return finalize({
        branch: projectCloudBranchRefreshDetail(
          target,
          organizationId,
          actor.tagPermissions
        ),
        status: BranchRefreshStatus.Failed,
        reason: BranchRefreshReason.GuardedWriteFailed,
      });
    }
    const branch = await branchReadService.getBranchDetail(
      organizationId,
      branchId,
      actor.tagPermissions
    );
    return finalize({
      branch,
      status: BranchRefreshStatus.Refreshed,
    });
  },
};

/**
 * ISS-12278: report a due stale-PR refresh to the route, and flag the detail
 * while one is due or claimed but not landed.
 */
function flagPullRequestRefresh(
  detail: BranchPageDetail,
  row: Parameters<typeof shouldRefreshTier2BranchPullRequestOnRead>[0],
  pullRequestDetail: Parameters<
    typeof shouldRefreshTier2BranchPullRequestOnRead
  >[2],
  options: BranchDetailReadOptions
): void {
  const now = new Date();
  const refreshDue = shouldRefreshTier2BranchPullRequestOnRead(
    row,
    now,
    pullRequestDetail
  );
  if (refreshDue) {
    options.onPullRequestRefreshDue?.();
  }
  if (
    refreshDue ||
    isTier2BranchPullRequestRefreshInFlight(row, now, pullRequestDetail)
  ) {
    detail.pullRequestRefreshPending = true;
  }
}
