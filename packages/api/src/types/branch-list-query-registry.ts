// ISS-9476: how each Branches list field lowers to the `BranchServerPageQuery`
// params (`branch-list-contract.ts`), what it does with rows holding no value,
// and how it sorts. The cloud and desktop capability declarations are in
// `branch-list-query-capabilities.ts` and the compiler in
// `branch-list-query-lowering.ts` (PRD-721).
//
// Every `includeEmptyByDefault` reproduces today's CLOUD behavior. F is
// `apps/api/app/branches/branch-list-sql/branch-list-filter-sql.ts`, D its
// sibling `branch-list-dimension-sql.ts`; K is the JS kernel desktop runs,
// `packages/lib/branches/branch-list-page.ts`. Both hosts agree on every entry.
import type { BranchQueryFilters } from "./branch.ts";
import {
  BranchListPullRequestPresence,
  type BranchServerPageQuery,
} from "./branch-list-contract.ts";
import {
  type ListFieldSpec,
  ListNonFieldParamReason,
  ListSortRank,
} from "./list-query-expression.ts";
import { BranchListField } from "./list-query-fields.ts";
import {
  type ListQueryLegacyVocabulary,
  listQueryCompanionParams,
  listQueryFieldByLegacyParam,
} from "./list-query-legacy-params.ts";
import { PRIORITY_UNSET_VALUE, PRIORITY_VALUES } from "./search-query.ts";

/**
 * The Branches list params that are not fields: the `BranchServerPageQuery`
 * paging and sort params, and the legacy (non-server) page's scope, search
 * and unmodeled params (`BranchQueryFilters`), none of which a column, facet
 * or sort key renders.
 */
export const BRANCH_LIST_NON_FIELD_PARAMS = {
  pageMode: ListNonFieldParamReason.Paging,
  limit: ListNonFieldParamReason.Paging,
  offset: ListNonFieldParamReason.Paging,
  sortKey: ListNonFieldParamReason.LegacySort,
  sortDir: ListNonFieldParamReason.LegacySort,
  search: ListNonFieldParamReason.Search,
  userId: ListNonFieldParamReason.Scope,
  teamId: ListNonFieldParamReason.Scope,
  contributorUserId: ListNonFieldParamReason.Scope,
  projectId: ListNonFieldParamReason.Scope,
  // FEA-3826: deprecated, and canonical reads ignore it.
  sessionPresence: ListNonFieldParamReason.Unmodeled,
} as const satisfies Partial<
  Record<keyof BranchQueryFilters, ListNonFieldParamReason>
>;

/** Every `BranchServerPageQuery` param a Branches field lowers to. */
export type BranchListLegacyFilterParam = Exclude<
  keyof BranchServerPageQuery,
  keyof typeof BRANCH_LIST_NON_FIELD_PARAMS
>;

type BranchFieldSpec = ListFieldSpec<BranchListLegacyFilterParam>;

/**
 * The Branches field registry. Exhaustive over {@link BranchListField}, which
 * derives from `BranchListSortKey`, so a new sort key fails `tsc` here.
 */
export const BRANCH_LIST_QUERY_FIELDS: Readonly<
  Record<BranchListField, BranchFieldSpec>
> = {
  // `branch_name` is NOT NULL (D:58; F:193-194, K:164-165).
  [BranchListField.Name]: {
    anyOf: { param: "names", aliases: [], includeEmptyByDefault: false },
    between: null,
    sortRank: ListSortRank.Value,
  },
  // A branch with no owner folds to the selectable `unattributed` id, so no
  // row is empty (D:119-121; F:195-196, K:166-167).
  [BranchListField.Owner]: {
    anyOf: { param: "owners", aliases: [], includeEmptyByDefault: false },
    between: null,
    sortRank: ListSortRank.Value,
  },
  // Session count: a COUNT, never NULL. Sort only.
  [BranchListField.Sessions]: {
    anyOf: null,
    between: null,
    sortRank: ListSortRank.Value,
  },
  // A NULL `loc_change` is excluded from any LOC range (F:239; K:469-483).
  [BranchListField.Changes]: {
    anyOf: null,
    between: {
      minParam: "locMin",
      maxParam: "locMax",
      includeEmptyByDefault: false,
    },
    sortRank: ListSortRank.Value,
  },
  // The status CASE always emits a value (D:159-178; F:202-203, K:173-174).
  // Sorted by the flag-resolved `branchStatusOrderingFor` ordering (F:180-186).
  [BranchListField.Status]: {
    anyOf: { param: "statuses", aliases: [], includeEmptyByDefault: false },
    between: null,
    sortRank: ListSortRank.BranchStatusOrdering,
  },
  // Presence is `linked` or `none`, never NULL (D:320-327; F:204-208,
  // K:175-181). `none` is the no-pull-request bucket.
  [BranchListField.PullRequest]: {
    anyOf: {
      param: "pullRequests",
      aliases: [],
      includeEmptyByDefault: false,
      emptyToken: BranchListPullRequestPresence.None,
    },
    between: null,
    sortRank: ListSortRank.Value,
  },
  // Two lowerings with OPPOSITE null defaults, both today's behavior on both
  // hosts. A recency bucket skips a row with no activity instant
  // (F:209-215, K:182-186). The date window KEEPS it (F:45-48, K:432-434).
  [BranchListField.LastActivity]: {
    anyOf: {
      param: "lastActiveRanges",
      aliases: [],
      includeEmptyByDefault: false,
    },
    between: {
      minParam: "startDate",
      maxParam: "endDate",
      includeEmptyByDefault: true,
    },
    sortRank: ListSortRank.Value,
  },
  // A branch with no repository folds to the selectable `—` id, so no row is
  // empty (D:141-147; F:216-217, K:187-188).
  [BranchListField.Repo]: {
    anyOf: { param: "repositories", aliases: [], includeEmptyByDefault: false },
    between: null,
    sortRank: ListSortRank.Value,
  },
  // Members skip NULL; NONE adds an `IS NULL` arm (F:253-267; K via
  // `matchesPriorityFilter`, priority-filter.ts:47-58).
  [BranchListField.Priority]: {
    anyOf: {
      param: "priorities",
      aliases: [],
      includeEmptyByDefault: false,
      emptyToken: PRIORITY_UNSET_VALUE,
      nonEmptyValues: PRIORITY_VALUES,
    },
    between: null,
    sortRank: ListSortRank.PriorityOrdinal,
  },
  // An empty collaborator array never overlaps a selection (F:197-201,
  // K:168-172).
  [BranchListField.Collaborators]: {
    anyOf: {
      param: "collaborators",
      aliases: [],
      includeEmptyByDefault: false,
    },
    between: null,
    sortRank: null,
  },
  // Same for tags (F:218-219, K:189-193).
  [BranchListField.Tags]: {
    anyOf: { param: "tags", aliases: [], includeEmptyByDefault: false },
    between: null,
    sortRank: null,
  },
};

/**
 * The legacy (non-server) page's single-value spellings of a field's axis.
 * No lowering writes them: the cloud refuses them beside the server-page
 * params (`apps/api/app/branches/branch-list-query.ts`), so a request that
 * carries one beside `listQuery` is refused as Malformed naming the field, and
 * the client builder leaves such a request on its legacy params.
 */
export const BRANCH_LIST_LEGACY_MODE_FIELD_ALIASES: Readonly<
  Record<string, BranchListField>
> = {
  repo: BranchListField.Repo,
  repository: BranchListField.Repo,
  owner: BranchListField.Owner,
  status: BranchListField.Status,
};

/** The field each Branches legacy param is an axis of, aliases included. */
export const BRANCH_LIST_FIELD_BY_LEGACY_PARAM: ReadonlyMap<
  string,
  BranchListField
> = listQueryFieldByLegacyParam(
  Object.values(BranchListField),
  BRANCH_LIST_QUERY_FIELDS,
  BRANCH_LIST_LEGACY_MODE_FIELD_ALIASES
);

/**
 * The non-field Branches params that may travel beside `listQuery`: paging,
 * scope and `search`, the Sessions rule (ISS-9477 ruling). Each still meets
 * the host's own page-mode rules once the expression is lowered.
 */
export const BRANCH_LIST_QUERY_COMPANION_PARAMS: ReadonlySet<string> =
  listQueryCompanionParams(BRANCH_LIST_NON_FIELD_PARAMS);

/** The Branches legacy vocabulary, for the compilers and the client builder. */
export const BRANCH_LIST_QUERY_VOCABULARY: ListQueryLegacyVocabulary<BranchListField> =
  {
    fields: BRANCH_LIST_QUERY_FIELDS,
    fieldByLegacyParam: BRANCH_LIST_FIELD_BY_LEGACY_PARAM,
    nonFieldParams: BRANCH_LIST_NON_FIELD_PARAMS,
    companionParams: BRANCH_LIST_QUERY_COMPANION_PARAMS,
  };

/**
 * Every param a Branches set field lowers to. Each is a list on both hosts:
 * a repeated query param on the cloud, an array on the desktop IPC request.
 */
export const BRANCH_LIST_SET_PARAMS: ReadonlySet<string> = new Set(
  Object.values(BRANCH_LIST_QUERY_FIELDS).flatMap((spec) =>
    spec.anyOf ? [spec.anyOf.param] : []
  )
);
