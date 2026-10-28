import {
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
  type BranchServerPageQuery,
} from "@repo/api/src/types/branch-list-contract";
import { branchServerPageQuerySchema } from "@repo/api/src/types/branch-list-contract-schema";
import type { BranchListQuery } from "./branch-list-query";

/** Normalize one validated REST request into the strict shared page query. */
export function toBranchServerPageQuery(
  query: BranchListQuery
): BranchServerPageQuery {
  return branchServerPageQuerySchema.parse({
    pageMode: BranchListPageMode.Server,
    limit: query.limit,
    offset: query.offset,
    ...(query.startDate ? { startDate: query.startDate.toISOString() } : {}),
    ...(query.endDate ? { endDate: query.endDate.toISOString() } : {}),
    ...(query.names ? { names: query.names } : {}),
    ...(query.owners ? { owners: query.owners } : {}),
    ...(query.collaborators ? { collaborators: query.collaborators } : {}),
    ...(query.statuses ? { statuses: query.statuses } : {}),
    ...(query.pullRequests ? { pullRequests: query.pullRequests } : {}),
    ...(query.lastActiveRanges
      ? { lastActiveRanges: query.lastActiveRanges }
      : {}),
    ...(query.repositories ? { repositories: query.repositories } : {}),
    ...(query.tags ? { tags: query.tags } : {}),
    ...(query.priorities ? { priorities: query.priorities } : {}),
    ...(query.locMin === undefined ? {} : { locMin: query.locMin }),
    ...(query.locMax === undefined ? {} : { locMax: query.locMax }),
    ...(query.search ? { search: query.search } : {}),
    sortKey: query.sortKey ?? BranchListSortKey.LastActivity,
    sortDir: query.sortDir ?? BranchListSortDirection.Desc,
  });
}
