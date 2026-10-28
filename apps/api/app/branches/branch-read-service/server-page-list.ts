import type {
  BranchListResponse,
  BranchTagPermissions,
} from "@repo/api/src/types/branch";
import { BranchViewerScope } from "@repo/api/src/types/branch";
import {
  BranchListCohortScope,
  branchListCohortKey,
} from "@repo/api/src/types/branch-list-cohort";
import { BranchListCapability } from "@repo/api/src/types/branch-list-contract";
import {
  type BranchStatusOrdering,
  DEFAULT_BRANCH_STATUS_ORDERING,
} from "@repo/api/src/types/branch-status-order";
import type { PrismaClient } from "@repo/database";
import { getBranchCandidateSnapshots } from "../branch-candidate-read";
import { buildBranchLastActiveCohort } from "../branch-last-active-cohort";
import {
  BranchLastActiveScanScope,
  reportImpossibleBranchLastActiveInstants,
} from "../branch-last-active-instant-report";
import type { BranchListEnrichmentDomain } from "../branch-list-enrichment";
import {
  attachBranchListPageCostMetadata,
  projectBranchListRows,
  sliceBranchListMetadata,
} from "../branch-list-projection";
import type { BranchListQuery } from "../branch-list-query";
import { readBranchServerPageFromSql } from "../branch-list-sql/branch-server-page-read";
import { toBranchServerPageQuery } from "../branch-server-page-query";
import { getBranchRowsById } from "./persisted-row-read";

/**
 * The delegates the server-page list read fans out across. Narrower than the
 * whole branch-read subsystem's client, and owned beside the one function that
 * uses it (whitlockk review, #4207 — the composition root owns its client).
 */
export type BranchReadClient = Pick<
  PrismaClient,
  | "$queryRaw"
  | "agentSessionActivitySegment"
  | "agentSessionTokenEvent"
  | "artifact"
  | "artifactLink"
  | "branchDetail"
  | "branchFileChange"
  | "branchPushContribution"
  | "comment"
  | "commentThread"
  | "commitDetail"
  | "gitHubCommentProjection"
  | "gitHubUserConnection"
  | "externalCommentAuthor"
  | "pullRequestDetail"
  | "user"
>;

/** One Branch list page, its totals and its corpus-wide facets. */
export async function listServerPageBranches(
  db: BranchReadClient,
  organizationId: string,
  tagPermissions: BranchTagPermissions | undefined,
  query: BranchListQuery,
  evaluationNow: Date,
  enrichment: BranchListEnrichmentDomain,
  statusOrdering: BranchStatusOrdering = DEFAULT_BRANCH_STATUS_ORDERING
): Promise<BranchListResponse> {
  const snapshotQuery = { ...query, evaluationNow };
  const serverQuery = toBranchServerPageQuery(snapshotQuery);
  // ISS-10298: ordering, pagination and all eight cross-filtered facet counts
  // are resolved by ONE statement over the eligible corpus, so the hydration and
  // projection below are page-sized. They used to run over every eligible branch
  // because the JavaScript fold could only read the facet dimensions off fully
  // projected rows -- 781 branches hydrated to serve 25.
  const snapshot = await readBranchServerPageFromSql(
    db,
    organizationId,
    snapshotQuery,
    serverQuery,
    evaluationNow,
    statusOrdering,
    enrichment
  );
  const candidates = await getBranchCandidateSnapshots(
    db,
    organizationId,
    snapshotQuery,
    snapshot.pageIds
  );
  const rows = await getBranchRowsById(
    db,
    organizationId,
    snapshot.pageIds,
    candidates
  );
  const projected = await projectBranchListRows(
    db,
    organizationId,
    rows,
    snapshotQuery,
    tagPermissions,
    { includeAttributedCost: false, enrichment }
  );
  const pageCostMetadata = await attachBranchListPageCostMetadata(
    db,
    organizationId,
    projected,
    projected.items,
    enrichment
  );
  // ISS-9482: PAGE-scoped, not cohort-scoped. `snapshot.retainedUnavailableCount`
  // is cohort-wide because SQL counts it, but `branchListLastActiveAtSql` folds an
  // impossible instant to NULL inside the dimension CTE, so the cohort-wide count
  // of THIS condition is not available without carrying the raw activity atom
  // through `flagged` and `cohort`. These are the projected rows this read already
  // holds, and one affected row on any page is the signal.
  reportImpossibleBranchLastActiveInstants({
    rows: pageCostMetadata.items,
    nowIso: evaluationNow.toISOString(),
    organizationId,
    scanScope: BranchLastActiveScanScope.Page,
  });
  return {
    items: pageCostMetadata.items,
    total: snapshot.total,
    facets: snapshot.facets,
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit: serverQuery.limit,
      offset: snapshot.repairedOffset,
      requestedOffset: serverQuery.offset,
      now: evaluationNow.toISOString(),
    },
    viewerScope: BranchViewerScope.Organization,
    hasMore:
      snapshot.repairedOffset + pageCostMetadata.items.length < snapshot.total,
    lastActiveCohort: buildBranchLastActiveCohort(
      {
        scope: BranchListCohortScope.RequestFilters,
        cohortKey: branchListCohortKey(snapshotQuery),
        evaluationNow,
        total: snapshot.total,
        retainedUnavailable: snapshot.retainedUnavailableCount,
      },
      { organizationId }
    ),
    ...sliceBranchListMetadata(projected, pageCostMetadata.items),
    ...(pageCostMetadata.sessionBranchCount
      ? { sessionBranchCount: pageCostMetadata.sessionBranchCount }
      : {}),
  };
}
