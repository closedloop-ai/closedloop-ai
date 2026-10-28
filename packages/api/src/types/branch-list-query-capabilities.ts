// PRD-721: what the cloud and desktop Branches list reads can serve today,
// each row citing the code that proves it. A declaration states the host as it
// is, not as it should be: a gap here is a real refusal a caller must handle.
// Same shape and rules as the Sessions declarations
// (`session-list-query-capabilities.ts`).
//
// Cloud: `branchListQuerySchema` (`apps/api/app/branches/branch-list-query.ts`).
// Desktop: `branchServerPageQueryShape` (`./branch-list-contract-schema.ts`),
// which the Branches IPC boundary validates a server page with
// (`apps/desktop/src/main/dashboard/agent-dashboard-ipc-coercion.ts`).
//
// `.ts` extensions: see "Relative Imports in Emitted Helpers" in
// `packages/api/AGENTS.md`.
import { BranchStatus } from "./branch.ts";
import {
  BRANCH_LIST_MAX_FILTER_VALUES,
  BranchListLastActiveRange,
  BranchListPullRequestPresence,
} from "./branch-list-contract.ts";
import {
  type ListFieldCapability,
  ListFieldValueFormat,
  type ListQueryCapability,
} from "./list-query-capability.ts";
import {
  LIST_QUERY_EXPRESSION_VERSION,
  LIST_QUERY_MAX_CLAUSES,
  LIST_QUERY_MAX_VALUES_PER_CLAUSE,
  ListFilterOperator,
} from "./list-query-expression.ts";
import { BranchListField } from "./list-query-fields.ts";
import { PRIORITY_FILTER_VALUES } from "./priority-filter.ts";

type FilterCapability = Omit<ListFieldCapability, "sortable">;

/**
 * An explicit `includeEmpty` is served only where it asks for the field's
 * registry default (`branch-list-query-registry.ts`): no Branches param spells
 * the opposite choice. Set facets and the LOC range drop empty rows; the date
 * window keeps them.
 */
const EXCLUDE_EMPTY = [false] as const;
const KEEP_EMPTY = [true] as const;
const EITHER_EMPTINESS = [false, true] as const;

/**
 * Free-text facets. Both hosts read each entry as a non-empty string capped at
 * `BRANCH_LIST_MAX_FILTER_VALUE_LENGTH`; the cap stays the schema's, so an
 * over-long value meets the same 400 a legacy request meets.
 */
const TEXT: FilterCapability = {
  operators: [ListFilterOperator.IsAnyOf],
  includeEmpty: { [ListFilterOperator.IsAnyOf]: EXCLUDE_EMPTY },
  valueFormat: ListFieldValueFormat.NonBlankString,
};

/** Both hosts read `statuses` as `BranchStatus` members and nothing else. */
const STATUS: FilterCapability = {
  operators: [ListFilterOperator.IsAnyOf],
  includeEmpty: { [ListFilterOperator.IsAnyOf]: EXCLUDE_EMPTY },
  values: Object.values(BranchStatus),
};

/** `none` is the no-pull-request bucket, so `isEmpty` lowers to it. */
const PULL_REQUEST: FilterCapability = {
  operators: [ListFilterOperator.IsAnyOf, ListFilterOperator.IsEmpty],
  includeEmpty: { [ListFilterOperator.IsAnyOf]: EITHER_EMPTINESS },
  values: Object.values(BranchListPullRequestPresence),
};

/**
 * Recency buckets (`lastActiveRanges`) or a date window (`startDate` /
 * `endDate`), one per request because a field carries one clause. No value
 * format: it would bind the bucket ids and the window bounds alike, and each
 * host's own schema already refuses an unreadable bound.
 */
const LAST_ACTIVITY: FilterCapability = {
  operators: [ListFilterOperator.IsAnyOf, ListFilterOperator.IsBetween],
  includeEmpty: {
    [ListFilterOperator.IsAnyOf]: EXCLUDE_EMPTY,
    [ListFilterOperator.IsBetween]: KEEP_EMPTY,
  },
  values: Object.values(BranchListLastActiveRange),
};

/** `locMin` / `locMax`; a branch with no LOC is outside every range. */
const CHANGES: FilterCapability = {
  operators: [ListFilterOperator.IsBetween],
  includeEmpty: { [ListFilterOperator.IsBetween]: EXCLUDE_EMPTY },
};

/** Members plus the unset token; selecting every member is "has a priority". */
const PRIORITY: FilterCapability = {
  operators: [
    ListFilterOperator.IsAnyOf,
    ListFilterOperator.IsEmpty,
    ListFilterOperator.IsNotEmpty,
  ],
  includeEmpty: { [ListFilterOperator.IsAnyOf]: EITHER_EMPTINESS },
  values: PRIORITY_FILTER_VALUES,
};

const NO_FILTER: FilterCapability = { operators: [] };

/**
 * The fields both hosts serve identically. Sort: every `BranchListSortKey`
 * (cloud `sortKey: z.enum(...)`, desktop the same enum); collaborators and
 * tags have no sort key.
 */
const BRANCH_FIELDS: Readonly<Record<BranchListField, ListFieldCapability>> = {
  [BranchListField.Name]: { ...TEXT, sortable: true },
  [BranchListField.Owner]: { ...TEXT, sortable: true },
  [BranchListField.Sessions]: { ...NO_FILTER, sortable: true },
  [BranchListField.Changes]: { ...CHANGES, sortable: true },
  [BranchListField.Status]: { ...STATUS, sortable: true },
  [BranchListField.PullRequest]: { ...PULL_REQUEST, sortable: true },
  [BranchListField.LastActivity]: { ...LAST_ACTIVITY, sortable: true },
  [BranchListField.Repo]: { ...TEXT, sortable: true },
  [BranchListField.Priority]: { ...PRIORITY, sortable: true },
  [BranchListField.Collaborators]: { ...TEXT, sortable: false },
  [BranchListField.Tags]: { ...TEXT, sortable: false },
};

/**
 * One rule: the server page carries a single `sortKey` / `sortDir` pair on
 * both hosts. Every facet is bounded at `BRANCH_LIST_MAX_FILTER_VALUES`.
 */
const BRANCH_LIST_CAPS = {
  version: LIST_QUERY_EXPRESSION_VERSION,
  maxClauses: LIST_QUERY_MAX_CLAUSES,
  maxValuesPerClause: Math.min(
    BRANCH_LIST_MAX_FILTER_VALUES,
    LIST_QUERY_MAX_VALUES_PER_CLAUSE
  ),
  maxSortRules: 1,
} as const;

/** `GET /branches`, `/branches/usage` and `/branches/analytics`. */
export const CLOUD_BRANCH_LIST_QUERY_CAPABILITY: ListQueryCapability = {
  ...BRANCH_LIST_CAPS,
  fields: BRANCH_FIELDS,
};

/**
 * The desktop local Branches read, as the renderer reaches it over IPC
 * (`SharedBranchesListRequest`). Declared separately from the cloud so a host
 * that drifts can be declared as it is; the conformance tests hold the two
 * equal while they are.
 */
export const DESKTOP_BRANCH_LIST_QUERY_CAPABILITY: ListQueryCapability = {
  ...BRANCH_LIST_CAPS,
  fields: BRANCH_FIELDS,
};
