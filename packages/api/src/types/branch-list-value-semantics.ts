/**
 * ISS-9482 (PRD-706 R10-S07) — the Branches list's declaration of what it does
 * with a value it cannot judge, in the vocabulary of
 * `./list-query-value-semantics.ts`.
 *
 * The declarations below are the behavior `apps/api`'s Branch list kernel
 * already produces; this module is where that behavior is STATED, and the
 * kernel derives the three predicates that can express a different answer from
 * these constants rather than writing the answer out a second time.
 *
 * Adding a facet, a sort key, or an operand case fails `tsc` here until it
 * declares. A query PARAMETER the schema grows is caught by the conformance test
 * over {@link BRANCH_LIST_BLANK_OPERAND_SEMANTICS} rather than by `tsc`, because
 * the schema that decides it lives in `apps/api` and cannot be imported here.
 */

import {
  BranchListFilterFacet,
  BranchListSortKey,
} from "./branch-list-contract.ts";
import {
  type ListQueryFieldValueSemantics,
  ListQueryFilterDisposition,
  ListQueryOperandCase,
  ListQueryOperandDisposition,
  ListQuerySortDisposition,
} from "./list-query-value-semantics.ts";

/**
 * The request-operand situations the Branch list parse boundary decides the SAME
 * way for every parameter. `Blank` is not one of them and is declared per
 * parameter by {@link BRANCH_LIST_BLANK_OPERAND_SEMANTICS}.
 *
 * `Malformed` and `Unknown` refuse, so `?locMin=abc` is a 400 and not an
 * unbounded page. `Retired` is `Ignore` because refusing would answer an
 * already-shipped client's whole Branches read with a 400 on a parameter this
 * release merely stopped honoring (ISS-10350, `evaluationNow`).
 *
 * Keyed on `Exclude<…, Blank>` rather than on three written-out members, so a
 * fifth operand case still fails `tsc` here until it declares.
 */
export const BRANCH_LIST_OPERAND_SEMANTICS: Readonly<
  Record<
    Exclude<ListQueryOperandCase, typeof ListQueryOperandCase.Blank>,
    ListQueryOperandDisposition
  >
> = {
  [ListQueryOperandCase.Malformed]: ListQueryOperandDisposition.Refuse,
  [ListQueryOperandCase.Unknown]: ListQueryOperandDisposition.Refuse,
  [ListQueryOperandCase.Retired]: ListQueryOperandDisposition.Ignore,
};

/** Every parameter `branchListQuerySchema` admits a value for. */
export type BranchListBlankOperand =
  | "limit"
  | "offset"
  | "pageMode"
  | "names"
  | "owners"
  | "collaborators"
  | "statuses"
  | "pullRequests"
  | "lastActiveRanges"
  | "repositories"
  | "tags"
  | "priorities"
  | "sortKey"
  | "sortDir"
  | "repo"
  | "repository"
  | "status"
  | "search"
  | "startDate"
  | "endDate"
  | "projectId"
  | "contributorUserId"
  | "sessionPresence"
  | "locMin"
  | "locMax";

/**
 * What a BLANK value of each parameter means — `?search=` rather than no
 * `search` at all.
 *
 * DECLARED PER PARAMETER because it is not uniform, and a single list-wide
 * `Blank` entry got it wrong for 22 of these 25 (tamsinb, #7893). Blank is what
 * a CLEARED control serializes to, so reading it as absent is what the caller
 * means — but only the change bounds actually do that, through
 * `blankOperandValue`. Every `Refuse` below is the parameter's OWN schema
 * rejecting `""`: a string bound (`trim().min(1)`, `string().min(1)`), closed-set
 * non-membership (`z.enum`), or `z.coerce.date()` producing an Invalid Date.
 *
 * `offset` is the one entry that reads as absent without being routed through
 * `blankOperandValue`: `z.coerce.number()` turns `""` into a measured `0`, which
 * is also this parameter's default, so the parse outcome is indistinguishable
 * from omitting it. `limit` takes the same coercion and still refuses, because
 * its floor is 1.
 *
 * Nothing here is held by prose. `branch-list-operand-semantics.test.ts` drives
 * the real schema with `""` for every key in this record and fails on any
 * declaration the parse boundary does not actually produce, in either direction,
 * including a parameter the schema grows and this record does not.
 */
export const BRANCH_LIST_BLANK_OPERAND_SEMANTICS: Readonly<
  Record<BranchListBlankOperand, ListQueryOperandDisposition>
> = {
  limit: ListQueryOperandDisposition.Refuse,
  offset: ListQueryOperandDisposition.TreatAsAbsent,
  pageMode: ListQueryOperandDisposition.Refuse,
  names: ListQueryOperandDisposition.Refuse,
  owners: ListQueryOperandDisposition.Refuse,
  collaborators: ListQueryOperandDisposition.Refuse,
  statuses: ListQueryOperandDisposition.Refuse,
  pullRequests: ListQueryOperandDisposition.Refuse,
  lastActiveRanges: ListQueryOperandDisposition.Refuse,
  repositories: ListQueryOperandDisposition.Refuse,
  tags: ListQueryOperandDisposition.Refuse,
  priorities: ListQueryOperandDisposition.Refuse,
  sortKey: ListQueryOperandDisposition.Refuse,
  sortDir: ListQueryOperandDisposition.Refuse,
  repo: ListQueryOperandDisposition.Refuse,
  repository: ListQueryOperandDisposition.Refuse,
  status: ListQueryOperandDisposition.Refuse,
  search: ListQueryOperandDisposition.Refuse,
  startDate: ListQueryOperandDisposition.Refuse,
  endDate: ListQueryOperandDisposition.Refuse,
  projectId: ListQueryOperandDisposition.Refuse,
  contributorUserId: ListQueryOperandDisposition.Refuse,
  sessionPresence: ListQueryOperandDisposition.Refuse,
  locMin: ListQueryOperandDisposition.TreatAsAbsent,
  locMax: ListQueryOperandDisposition.TreatAsAbsent,
};

/**
 * Every Branch list facet, for both row-side cases.
 *
 * The two columns are identical for all ten facets, and that is the contract
 * rather than an accident: the Branch list dimension folds a value it could not
 * LOAD into the same shape as a value that is genuinely absent, so no facet can
 * tell its reader which of the two it is looking at. The facet's own
 * `BranchListFacetAvailability` is where that distinction is reported.
 *
 * Because the fold is the contract, a facet predicate reads BOTH columns through
 * `listQueryFoldedRowDisposition` rather than picking `.missing` and ignoring the
 * other. That is what stops the equality above from being a claim nothing tests:
 * declaring two different answers for a facet whose predicate cannot distinguish
 * them now fails the read instead of silently applying one of them.
 */
export const BRANCH_LIST_FILTER_VALUE_SEMANTICS: Readonly<
  Record<BranchListFilterFacet, ListQueryFieldValueSemantics>
> = {
  [BranchListFilterFacet.Name]: {
    missing: ListQueryFilterDisposition.Total,
    unavailable: ListQueryFilterDisposition.Total,
    evidence: "branch_detail.branch_name is NOT NULL",
  },
  [BranchListFilterFacet.Owner]: {
    missing: ListQueryFilterDisposition.Selectable,
    unavailable: ListQueryFilterDisposition.Selectable,
    evidence: "branchListIdentityColumnsSql coalesces to the unattributed key",
  },
  [BranchListFilterFacet.Collaborators]: {
    missing: ListQueryFilterDisposition.Exclude,
    unavailable: ListQueryFilterDisposition.Exclude,
    evidence:
      "collaborator_keys coalesces to an empty array, which overlaps nothing",
  },
  [BranchListFilterFacet.Changes]: {
    missing: ListQueryFilterDisposition.Exclude,
    unavailable: ListQueryFilterDisposition.Exclude,
    evidence: "branchListLocRangeSql requires loc_change IS NOT NULL",
  },
  [BranchListFilterFacet.Status]: {
    missing: ListQueryFilterDisposition.Total,
    unavailable: ListQueryFilterDisposition.Total,
    evidence: "branchListStatusSql ends in an ELSE arm",
  },
  [BranchListFilterFacet.PullRequest]: {
    missing: ListQueryFilterDisposition.Selectable,
    unavailable: ListQueryFilterDisposition.Selectable,
    evidence: "branchListPullRequestPresenceSql emits the none member",
  },
  [BranchListFilterFacet.LastActive]: {
    missing: ListQueryFilterDisposition.Exclude,
    unavailable: ListQueryFilterDisposition.Exclude,
    evidence: "last_active_range is NULL and no offered option matches it",
  },
  [BranchListFilterFacet.Repository]: {
    missing: ListQueryFilterDisposition.Selectable,
    unavailable: ListQueryFilterDisposition.Selectable,
    evidence:
      "branchListRepositorySql coalesces to the unknown-repository label",
  },
  [BranchListFilterFacet.Tags]: {
    missing: ListQueryFilterDisposition.Exclude,
    unavailable: ListQueryFilterDisposition.Exclude,
    evidence: "tag_ids coalesces to an empty array, which overlaps nothing",
  },
  [BranchListFilterFacet.Priority]: {
    missing: ListQueryFilterDisposition.Selectable,
    unavailable: ListQueryFilterDisposition.Selectable,
    evidence: "splitPriorityFilter offers the unset token as its own member",
  },
};

/**
 * The date window is a bounded predicate over `last_active_at` rather than a
 * facet, and it is the one Branch list predicate that RETAINS what it cannot
 * judge: a branch whose last-active instant is absent is not evidence that the
 * branch falls outside the window, so the window does not cut it.
 *
 * It is also the one field whose two columns are read SEPARATELY, because the
 * kernel can tell the cases apart: `resolveLastActive` holds the metric's own
 * `BranchMetricAvailability`, so a window declaring different answers here
 * selects different rows. The SQL mirror cannot — `branchListLastActiveAtSql`
 * folds both into one NULL before the predicate runs — so it reads the folded
 * disposition and refuses a split declaration rather than honouring half of it.
 */
export const BRANCH_LIST_DATE_WINDOW_VALUE_SEMANTICS: ListQueryFieldValueSemantics =
  {
    missing: ListQueryFilterDisposition.Retain,
    unavailable: ListQueryFilterDisposition.Retain,
    evidence: "branchListDateWindowSql ORs last_active_at IS NULL",
  };

/**
 * Where a branch the sort key cannot rank lands.
 *
 * `Last` in both directions, for every key: reversing the direction must not
 * promote rows the reader has the least information about to the top of the
 * first page.
 */
export const BRANCH_LIST_SORT_VALUE_SEMANTICS: Readonly<
  Record<BranchListSortKey, ListQuerySortDisposition>
> = {
  [BranchListSortKey.Name]: ListQuerySortDisposition.Last,
  [BranchListSortKey.Owner]: ListQuerySortDisposition.Last,
  [BranchListSortKey.Sessions]: ListQuerySortDisposition.Last,
  [BranchListSortKey.Changes]: ListQuerySortDisposition.Last,
  [BranchListSortKey.Status]: ListQuerySortDisposition.Last,
  [BranchListSortKey.PullRequest]: ListQuerySortDisposition.Last,
  [BranchListSortKey.LastActivity]: ListQuerySortDisposition.Last,
  [BranchListSortKey.Repo]: ListQuerySortDisposition.Last,
  [BranchListSortKey.Priority]: ListQuerySortDisposition.Last,
};
