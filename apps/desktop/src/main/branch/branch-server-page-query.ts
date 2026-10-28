import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
  type BranchServerPageQuery,
  normalizeBranchListSearch,
} from "@repo/api/src/types/branch-list-contract";
import { branchServerPageQuerySchema } from "@repo/api/src/types/branch-list-contract-schema";
import type { SharedBranchesListRequest } from "../../shared/shared-branches-contract.js";

/** Validate the clone-safe IPC value against the exact shared page contract. */
export function toDesktopBranchServerPageQuery(
  request: SharedBranchesListRequest
): BranchServerPageQuery {
  const normalizedSearch = normalizeBranchListSearch(request.search);
  return branchServerPageQuerySchema.parse({
    pageMode: BranchListPageMode.Server,
    limit: request.limit ?? BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: request.offset ?? 0,
    ...(request.startDate ? { startDate: request.startDate } : {}),
    ...(request.endDate ? { endDate: request.endDate } : {}),
    ...(request.names ? { names: request.names } : {}),
    ...(request.owners ? { owners: request.owners } : {}),
    ...(request.collaborators ? { collaborators: request.collaborators } : {}),
    ...(request.statuses ? { statuses: request.statuses } : {}),
    ...(request.pullRequests ? { pullRequests: request.pullRequests } : {}),
    ...(request.lastActiveRanges
      ? { lastActiveRanges: request.lastActiveRanges }
      : {}),
    ...(request.repositories ? { repositories: request.repositories } : {}),
    ...(request.tags ? { tags: request.tags } : {}),
    // ISS-10332: without this the local page silently ignored a priority
    // selection — one saved in cloud mode included — and served every row.
    ...(request.priorities ? { priorities: request.priorities } : {}),
    ...(request.locMin === undefined ? {} : { locMin: request.locMin }),
    ...(request.locMax === undefined ? {} : { locMax: request.locMax }),
    ...(normalizedSearch ? { search: normalizedSearch } : {}),
    sortKey: request.sortKey ?? BranchListSortKey.LastActivity,
    sortDir: request.sortDir ?? BranchListSortDirection.Desc,
  });
}
