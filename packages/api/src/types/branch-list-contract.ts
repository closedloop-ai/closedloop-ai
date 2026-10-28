/** Lightweight cross-surface contract for bounded Branches List reads. */

import type { PriorityFilterValue } from "./priority-filter.ts";

export const BRANCH_LIST_SERVER_PAGE_SIZE = 20;
/**
 * Every `limit` a Branches list read may ask for: this module's own default,
 * plus every rung the rows-per-page control offers.
 *
 * ISS-9225: the second half used to be spelled here as
 * `BRANCH_LIST_GRID_TABLE_V2_PAGE_SIZE_OPTIONS`, a literal `[25, 50, 100]` that
 * was the UI's ladder written a second time — the Branches footer read it while
 * Sessions' read `TABLE_PAGE_SIZE_OPTIONS`, so the two lists could offer
 * different choices and nothing would fail. The offer now has ONE home, in the
 * design system beside the control that renders it. It cannot be imported here:
 * `apps/api` routes and `apps/desktop`'s main process consume this module, and
 * `packages/design-system` is gated from importing `@repo/api` in the other
 * direction, so this stays an ACCEPTANCE set that must merely admit every
 * offered rung — which `branch-list-page-size-agreement.test.ts` is what fails
 * when it stops doing.
 *
 * ISS-9692 added 250 and 500, the two rungs the `table-page-size-ladder` flag
 * offers. Widened UNCONDITIONALLY even though the UI gates the offer: a flag-off
 * client never sends them, and a server that refused them would 400 the very
 * requests the flag exists to allow. `BRANCH_LIST_MAX_LIMIT` — the bound the
 * route and the service actually enforce — is `BRANCH_LIST_SERVER_PAGE_SIZE_MAX`
 * below, so accepting a rung here and rejecting it there is no longer possible.
 */
export const BRANCH_LIST_SERVER_PAGE_SIZE_OPTIONS = [
  BRANCH_LIST_SERVER_PAGE_SIZE,
  25,
  50,
  100,
  250,
  500,
] as const;
export const BRANCH_LIST_SERVER_PAGE_SIZE_MAX = Math.max(
  ...BRANCH_LIST_SERVER_PAGE_SIZE_OPTIONS
);
export type BranchListServerPageSize =
  (typeof BRANCH_LIST_SERVER_PAGE_SIZE_OPTIONS)[number];
export const BRANCH_LIST_MAX_FILTER_VALUES = 100;
/**
 * Longest single filter value either Branch-list query schema accepts. Lives
 * here, beside the count bound, because the two together are what bound the
 * serialized `cohortKey` — `apps/api`'s legacy `repeatedStringSchema` and this
 * package's `stringValuesSchema` had the same `200` written out separately, so
 * lowering one silently left the other admitting values the first no longer did.
 */
export const BRANCH_LIST_MAX_FILTER_VALUE_LENGTH = 200;
export const BRANCH_LIST_MAX_OFFSET = Number.MAX_SAFE_INTEGER;
export const BRANCH_LIST_INVALID_PAGE_RESPONSE_CODE =
  "BRANCHES_INVALID_SERVER_PAGE_RESPONSE";

export const BranchListPageMode = {
  Server: "server",
} as const;
export type BranchListPageMode =
  (typeof BranchListPageMode)[keyof typeof BranchListPageMode];

export const BranchListCapability = {
  ServerPaginationV1: "server_pagination_v1",
} as const;
export type BranchListCapability =
  (typeof BranchListCapability)[keyof typeof BranchListCapability];

export const BranchListSortKey = {
  Name: "name",
  Owner: "owner",
  Sessions: "sessions",
  Changes: "changes",
  Status: "status",
  PullRequest: "pr",
  LastActivity: "lastActivity",
  Repo: "repo",
  Priority: "priority",
} as const;
export type BranchListSortKey =
  (typeof BranchListSortKey)[keyof typeof BranchListSortKey];

export const BranchListSortDirection = {
  Asc: "asc",
  Desc: "desc",
} as const;
export type BranchListSortDirection =
  (typeof BranchListSortDirection)[keyof typeof BranchListSortDirection];

export const BranchListFilterFacet = {
  Name: "name",
  Owner: "owner",
  Collaborators: "collaborators",
  Changes: "changes",
  Status: "status",
  PullRequest: "pullRequest",
  LastActive: "lastActive",
  Repository: "repository",
  Tags: "tags",
  Priority: "priority",
} as const;
export type BranchListFilterFacet =
  (typeof BranchListFilterFacet)[keyof typeof BranchListFilterFacet];

export const BranchListPullRequestPresence = {
  Linked: "linked",
  None: "none",
} as const;
export type BranchListPullRequestPresence =
  (typeof BranchListPullRequestPresence)[keyof typeof BranchListPullRequestPresence];

export const BranchListLastActiveRange = {
  WithinLastHour: "within-last-hour",
  OneToSixHours: "one-to-six-hours",
  SevenToTwentyFourHours: "seven-to-twenty-four-hours",
  OneDayOrMore: "one-day-or-more",
} as const;
export type BranchListLastActiveRange =
  (typeof BranchListLastActiveRange)[keyof typeof BranchListLastActiveRange];

export const BranchListFacetAvailability = {
  Complete: "complete",
  Incomplete: "incomplete",
  Unavailable: "unavailable",
} as const;
export type BranchListFacetAvailability =
  (typeof BranchListFacetAvailability)[keyof typeof BranchListFacetAvailability];

export type BranchListFacetOption = {
  id: string;
  label: string;
  count: number;
};

export type BranchListFacetResult = {
  availability: BranchListFacetAvailability;
  options: BranchListFacetOption[];
};

export type BranchListFacets = {
  names: BranchListFacetResult;
  owners: BranchListFacetResult;
  collaborators: BranchListFacetResult;
  statuses: BranchListFacetResult;
  pullRequests: BranchListFacetResult;
  lastActiveRanges: BranchListFacetResult;
  repositories: BranchListFacetResult;
  tags: BranchListFacetResult;
};

/** Metadata proving rows, total, sort, and facets came from one read snapshot. */
export type BranchListPageInfo = {
  capability: typeof BranchListCapability.ServerPaginationV1;
  limit: BranchListServerPageSize;
  offset: number;
  requestedOffset: number;
  now: string;
};

/**
 * Legacy producer-issued clock endpoint response.
 *
 * Retained so already-deployed clients that still read
 * `/branches/evaluation-clock` during the rollout window receive the response
 * shape they require. New clients use `BranchListStatusOrderingResponse`
 * instead, and the list query no longer accepts this value back on the wire.
 */
export type BranchListEvaluationClockResponse = {
  evaluationNow: string;
  /**
   * ISS-9437 — the name of the status ordering this producer will build its
   * pages with (`BranchStatusOrderingName` in `./branch-status-order.ts`).
   *
   * ADDITIVE AND OPTIONAL, and absent means today's behavior. It is read BEFORE
   * the list because the client keys its LIST query on it, and that key is built
   * before the list is fetched.
   *
   * It is stated on a RESPONSE and never accepted on a request. The client
   * cannot choose the order: the producer resolves the flag for the signed-in
   * principal, and this field only reports which order the rows it is about to
   * serve were sorted in, so the reader's page membership and its query key
   * cannot describe two different orders.
   */
  statusOrdering?: string;
};

/** What ordering the producer says it built the pages it is about to serve with. */
export type BranchListStatusOrderingResponse = Pick<
  BranchListEvaluationClockResponse,
  "statusOrdering"
>;

export type BranchServerPageQuery = {
  pageMode: typeof BranchListPageMode.Server;
  limit: BranchListServerPageSize;
  offset: number;
  startDate?: string;
  endDate?: string;
  names?: string[];
  owners?: string[];
  collaborators?: string[];
  statuses?: string[];
  pullRequests?: BranchListPullRequestPresence[];
  lastActiveRanges?: BranchListLastActiveRange[];
  repositories?: string[];
  tags?: string[];
  priorities?: PriorityFilterValue[];
  locMin?: number;
  locMax?: number;
  /** PRD-721: the toolbar's free-text term, scoped before the facets count. */
  search?: string;
  sortKey: BranchListSortKey;
  sortDir: BranchListSortDirection;
};

export function isBranchListServerPageSize(
  value: number
): value is BranchListServerPageSize {
  return BRANCH_LIST_SERVER_PAGE_SIZE_OPTIONS.includes(
    value as BranchListServerPageSize
  );
}

/** The longest search term the Branches list contract accepts. */
export const BRANCH_LIST_MAX_SEARCH_LENGTH = 200;

/**
 * The search term a request may carry: trimmed and capped, or absent. The
 * contract rejects a blank or over-long term, so a host that sent the raw input
 * turned a single typed space into a 400.
 */
export function normalizeBranchListSearch(
  raw: string | undefined
): string | undefined {
  const term = raw?.slice(0, BRANCH_LIST_MAX_SEARCH_LENGTH).trim();
  return term ? term : undefined;
}
