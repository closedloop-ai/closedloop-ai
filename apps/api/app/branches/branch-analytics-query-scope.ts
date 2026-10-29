import {
  BRANCH_CONTRIBUTOR_USER_ID_PARAM,
  BRANCH_LOC_MAX_PARAM,
  BRANCH_LOC_MIN_PARAM,
  BRANCH_SESSION_PRESENCE_PARAM,
} from "@repo/api/src/types/branch";
import type { BranchListQuery } from "./branch-list-query";

const BranchAnalyticsQueryFieldScope = {
  CandidateSqlFilter: "candidate_sql_filter",
  DateWindow: "date_window",
  NonScope: "non_scope",
  ProjectionFilter: "projection_filter",
  RowDerivedProjectionFilter: "row_derived_projection_filter",
} as const;
type BranchAnalyticsQueryFieldScope =
  (typeof BranchAnalyticsQueryFieldScope)[keyof typeof BranchAnalyticsQueryFieldScope];

const BRANCH_ANALYTICS_QUERY_FIELD_SCOPES = {
  limit: BranchAnalyticsQueryFieldScope.NonScope,
  offset: BranchAnalyticsQueryFieldScope.NonScope,
  pageMode: BranchAnalyticsQueryFieldScope.NonScope,
  startDate: BranchAnalyticsQueryFieldScope.DateWindow,
  endDate: BranchAnalyticsQueryFieldScope.DateWindow,
  repo: BranchAnalyticsQueryFieldScope.CandidateSqlFilter,
  repository: BranchAnalyticsQueryFieldScope.CandidateSqlFilter,
  status: BranchAnalyticsQueryFieldScope.CandidateSqlFilter,
  search: BranchAnalyticsQueryFieldScope.CandidateSqlFilter,
  projectId: BranchAnalyticsQueryFieldScope.CandidateSqlFilter,
  [BRANCH_CONTRIBUTOR_USER_ID_PARAM]:
    BranchAnalyticsQueryFieldScope.CandidateSqlFilter,
  [BRANCH_SESSION_PRESENCE_PARAM]: BranchAnalyticsQueryFieldScope.NonScope,
  names: BranchAnalyticsQueryFieldScope.ProjectionFilter,
  owners: BranchAnalyticsQueryFieldScope.ProjectionFilter,
  collaborators: BranchAnalyticsQueryFieldScope.ProjectionFilter,
  statuses: BranchAnalyticsQueryFieldScope.ProjectionFilter,
  pullRequests: BranchAnalyticsQueryFieldScope.ProjectionFilter,
  lastActiveRanges: BranchAnalyticsQueryFieldScope.ProjectionFilter,
  repositories: BranchAnalyticsQueryFieldScope.ProjectionFilter,
  tags: BranchAnalyticsQueryFieldScope.ProjectionFilter,
  priorities: BranchAnalyticsQueryFieldScope.ProjectionFilter,
  [BRANCH_LOC_MIN_PARAM]:
    BranchAnalyticsQueryFieldScope.RowDerivedProjectionFilter,
  [BRANCH_LOC_MAX_PARAM]:
    BranchAnalyticsQueryFieldScope.RowDerivedProjectionFilter,
  // Summary-card analytics is order-insensitive; sort must not force row projection.
  sortKey: BranchAnalyticsQueryFieldScope.NonScope,
  sortDir: BranchAnalyticsQueryFieldScope.NonScope,
} satisfies Record<keyof BranchListQuery, BranchAnalyticsQueryFieldScope>;

const SERVER_ANALYTICS_DIRECT_BLOCKING_SCOPES: ReadonlySet<BranchAnalyticsQueryFieldScope> =
  new Set([
    BranchAnalyticsQueryFieldScope.ProjectionFilter,
    BranchAnalyticsQueryFieldScope.RowDerivedProjectionFilter,
  ]);

const branchAnalyticsQueryFields = Object.keys(
  BRANCH_ANALYTICS_QUERY_FIELD_SCOPES
) as (keyof BranchListQuery)[];

/** True when server analytics can use candidate order without row projection. */
export function canUseCandidateOrderForServerAnalytics(
  query: BranchListQuery
): boolean {
  return !hasDefinedFieldInScopes(
    query,
    SERVER_ANALYTICS_DIRECT_BLOCKING_SCOPES
  );
}

function hasDefinedFieldInScopes(
  query: BranchListQuery,
  scopes: ReadonlySet<BranchAnalyticsQueryFieldScope>
): boolean {
  return branchAnalyticsQueryFields.some(
    (field) =>
      query[field] !== undefined &&
      scopes.has(BRANCH_ANALYTICS_QUERY_FIELD_SCOPES[field])
  );
}
