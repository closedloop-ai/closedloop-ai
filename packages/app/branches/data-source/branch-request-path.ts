import type { BranchQueryFilters } from "@repo/api/src/types/branch";
import { buildBranchListQueryUrlParams } from "@repo/api/src/types/list-query-client-requests";
import { buildSearchParams } from "../../shared/lib/format-utils";

/** Branch read filters plus the transport-local refresh hint. */
type BranchRequestFilters = BranchQueryFilters & { forceRefresh?: boolean };

const BRANCH_LIST_PATH = "/branches";

/**
 * ISS-7127: `forceRefresh` is transport-local; only a caching source (the
 * desktop-local one) consumes it, and the cloud Branch routes parse with a
 * `.strict()` validator, so serializing it is a 400 on the required list read
 * rather than a silently ignored param. Stripped here so no filter-carrying
 * caller can leak it; `selectedPullRequestPath` builds the detail routes' params
 * by hand and must keep hand-picking fields for the same reason.
 */
export function withQuery(path: string, filters: BranchRequestFilters): string {
  const { forceRefresh: _forceRefresh, ...queryFilters } = filters;
  const qs = buildSearchParams(queryFilters).toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * The `GET /branches` URL. PRD-721 / ISS-9346: the filter and sort travel as
 * the canonical `listQuery` expression, which the route lowers back to these
 * same params. The legacy params are sent when `canonicalListQuery` is
 * `false` or when no expression says the same thing
 * (`buildBranchListQueryUrlParams` returns `null`). `forceRefresh` is stripped
 * as {@link withQuery} strips it.
 */
export function branchListPath(
  filters: BranchRequestFilters,
  canonicalListQuery: boolean | undefined
): string {
  const { forceRefresh: _forceRefresh, ...queryFilters } = filters;
  const params =
    canonicalListQuery === false
      ? null
      : buildBranchListQueryUrlParams(queryFilters);
  if (params === null) {
    return withQuery(BRANCH_LIST_PATH, queryFilters);
  }
  const qs = buildSearchParams(params).toString();
  return qs ? `${BRANCH_LIST_PATH}?${qs}` : BRANCH_LIST_PATH;
}
