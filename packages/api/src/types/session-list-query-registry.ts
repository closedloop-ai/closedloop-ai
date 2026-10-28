// ISS-9476: how each Sessions list field lowers to the legacy
// `AgentSessionListQuery` params (`apps/api/app/agent-sessions/validators.ts`),
// what it does with rows holding no value, and how it sorts.
//
// Every `includeEmptyByDefault` reproduces today's CLOUD behavior and cites the
// line that sets it on both hosts. Where desktop differs the entry says so and
// cloud's answer stands; what the policy SHOULD be is ISS-9482 / ISS-9585.
//
// Cloud paths are under `apps/api/app/agent-sessions/service/`; desktop paths
// are under `apps/desktop/src/main/session/` unless written in full. QB is
// `query-builder.ts`, LF `session-local-facet-filters.ts`.
import { SESSION_UNKNOWN_COST_BUCKET_ID } from "../agent-session-filters.ts";
import type { AutonomyTier } from "../session-autonomy-tiers.ts";
import {
  type ListFieldSpec,
  ListNonFieldParamReason,
  ListSortRank,
} from "./list-query-expression.ts";
import { SessionListField } from "./list-query-fields.ts";
import {
  type ListQueryLegacyVocabulary,
  listQueryCompanionParams,
  listQueryFieldByLegacyParam,
} from "./list-query-legacy-params.ts";
import { PRIORITY_UNSET_VALUE, PRIORITY_VALUES } from "./search-query.ts";

/**
 * Every `AgentSessionListQuery` param a Sessions field lowers to. Written out
 * because `apps/api` owns the schema and cannot be imported here;
 * `apps/api/app/agent-sessions/__tests__/list-query-session-registry.test.ts`
 * holds this union and {@link SESSION_LIST_NON_FIELD_PARAMS} equal to that
 * schema's keys at compile time, in both directions.
 */
export type SessionListLegacyFilterParam =
  | "statuses"
  | "status"
  | "userIds"
  | "repositories"
  | "harnesses"
  | "harness"
  | "models"
  | "autonomyTiers"
  | "costBuckets"
  | "changePresence"
  | "prAssociation"
  | "priorities"
  | "quality"
  | "projectIds"
  | "startDate"
  | "endDate";

/**
 * The `AgentSessionListQuery` params that are NOT fields and never appear in an
 * expression, each with the reason. The reason decides which may travel
 * beside the expression: see {@link SESSION_LIST_QUERY_COMPANION_PARAMS}.
 */
export const SESSION_LIST_NON_FIELD_PARAMS = {
  limit: ListNonFieldParamReason.Paging,
  offset: ListNonFieldParamReason.Paging,
  viewerScope: ListNonFieldParamReason.Scope,
  teamId: ListNonFieldParamReason.Scope,
  componentSlug: ListNonFieldParamReason.Scope,
  /**
   * A pinned cohort, not a spelling of the Owner facet: cloud matches it
   * against Created by and ANDs it with `userIds` (the assignee), so the facet
   * can never widen past it (ISS-12251; facet-count-where.ts, the FEA-4304
   * cross-user leak).
   */
  userId: ListNonFieldParamReason.Scope,
  /**
   * The session's OWN artifact parent (QB:614-615), a scope used by analytics
   * callers — distinct from the `projectIds` facet (ISS-9477 ruling).
   */
  projectId: ListNonFieldParamReason.Scope,
  search: ListNonFieldParamReason.Search,
  sortBy: ListNonFieldParamReason.LegacySort,
  sortDir: ListNonFieldParamReason.LegacySort,
  sorts: ListNonFieldParamReason.LegacySort,
  /**
   * FEA-3009's "completed since I last looked" badge bound on
   * `sessionEndedAt` (QB:705-719). No column, facet, or sort key renders it.
   */
  completedAfter: ListNonFieldParamReason.Unmodeled,
} as const satisfies Record<string, ListNonFieldParamReason>;
export type SessionListNonFieldParam =
  keyof typeof SESSION_LIST_NON_FIELD_PARAMS;

const AUTONOMY_UNKNOWN_TIER = "unknown" satisfies AutonomyTier;

type SessionFieldSpec = ListFieldSpec<SessionListLegacyFilterParam>;

const SORT_ONLY_BY_VALUE: SessionFieldSpec = {
  anyOf: null,
  between: null,
  sortRank: ListSortRank.Value,
};

/**
 * The Sessions field registry. Exhaustive over {@link SessionListField}, so a
 * new field fails `tsc` here until it is specified.
 *
 * Reserved for the ISS-9477 cloud compiler, the ISS-9479 desktop compiler and the ISS-9584 parity harness.
 */
export const SESSION_LIST_QUERY_FIELDS: Readonly<
  Record<SessionListField, SessionFieldSpec>
> = {
  // Cloud: `artifacts.assignee_id` (ISS-12251 D-1) is nullable and `in` skips
  // NULL. Desktop: its local Owner is the creator (D-7); null folds to "" and
  // never matches
  // (shared-agent-sessions-api.ts:912-917). `userId` is a scope, not an alias.
  [SessionListField.User]: {
    anyOf: {
      param: "userIds",
      aliases: [],
      includeEmptyByDefault: false,
    },
    between: null,
    sortRank: ListSortRank.Value,
  },
  // Raw-string order, no semantic rank (session-sort-order.ts:286). The column
  // is NOT NULL on cloud; desktop compares the stored status
  // (shared-agent-sessions-api.ts:893-905).
  [SessionListField.Status]: {
    anyOf: {
      param: "statuses",
      aliases: ["status"],
      includeEmptyByDefault: false,
    },
    between: null,
    sortRank: ListSortRank.Value,
  },
  // Cloud: `repositoryFullName in` skips NULL (QB:305-306). Desktop: a row
  // with no repository never matches (session-repository-facet.ts:100-108).
  [SessionListField.Repo]: {
    anyOf: { param: "repositories", aliases: [], includeEmptyByDefault: false },
    between: null,
    sortRank: ListSortRank.Value,
  },
  // Cloud: `harness` is NOT NULL and defaults to the literal "unknown", so
  // there is no empty row (QB:309-314). Desktop folds a null harness to
  // "unknown" (LF:47-55); both select those rows by that value.
  [SessionListField.Harness]: {
    anyOf: {
      param: "harnesses",
      aliases: ["harness"],
      includeEmptyByDefault: false,
    },
    between: null,
    sortRank: ListSortRank.Value,
  },
  // Cloud: `model in` skips NULL (QB:323-325). Desktop DIFFERS: a null model
  // folds to "unknown" and a selected "unknown" matches it (LF:56-69).
  [SessionListField.Model]: {
    anyOf: { param: "models", aliases: [], includeEmptyByDefault: false },
    between: null,
    sortRank: ListSortRank.Value,
  },
  // Numeric tiers skip NULL; the "unknown" tier selects `autonomy IS NULL` on
  // cloud (QB:415-425) and classifies null as "unknown" on desktop
  // (session-autonomy-tiers.ts:73-78, LF:70-77).
  [SessionListField.Autonomy]: {
    anyOf: {
      param: "autonomyTiers",
      aliases: [],
      includeEmptyByDefault: false,
      emptyToken: AUTONOMY_UNKNOWN_TIER,
    },
    between: null,
    sortRank: ListSortRank.Value,
  },
  [SessionListField.Duration]: SORT_ONLY_BY_VALUE,
  // Numeric buckets AND `SESSION_COST_KNOWN_WHERE`, so an unknown cost never
  // matches one (QB:551-556); the "unknown" bucket selects it (QB:485-495).
  // Desktop matches unknown cost only to that token (LF:78-93,
  // agent-session-filters.ts:308-316).
  [SessionListField.Cost]: {
    anyOf: {
      param: "costBuckets",
      aliases: [],
      includeEmptyByDefault: false,
      emptyToken: SESSION_UNKNOWN_COST_BUCKET_ID,
    },
    between: null,
    sortRank: ListSortRank.Value,
  },
  [SessionListField.Started]: SORT_ONLY_BY_VALUE,
  // Members use `in`, which skips NULL; the NONE token adds a separate
  // `priority IS NULL` arm (priority-facet-where.ts:24-29). Desktop uses the
  // same `matchesPriorityFilter` (priority-filter.ts:47-58, LF:39).
  [SessionListField.Priority]: {
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
  [SessionListField.Updated]: SORT_ONLY_BY_VALUE,
  // Inclusive window on `lastActivityAt`, which is NOT NULL on cloud
  // (QB:676-692). Desktop DIFFERS: a row with no lastActivity is windowed by
  // its start time (shared-agent-sessions-api.ts:952-964). Cloud analytics
  // DIFFERS too: it reads `startDate`/`endDate` on `sessionStartedAt`, so this
  // clause windows by start time there (ISS-9477).
  [SessionListField.LastActivity]: {
    anyOf: null,
    between: {
      minParam: "startDate",
      maxParam: "endDate",
      includeEmptyByDefault: false,
    },
    sortRank: ListSortRank.Value,
  },
  // `has_changes` skips rows whose LOC columns are all NULL (QB:44-53); those
  // rows are `no_changes` (QB:63-72). Desktop reads NULL counts as 0, the same
  // answer (LF:106-115).
  [SessionListField.ChangePresence]: {
    anyOf: {
      param: "changePresence",
      aliases: [],
      includeEmptyByDefault: false,
    },
    between: null,
    sortRank: null,
  },
  // `no_pr` is the complement of `has_pr` (QB:600-606); desktop the same
  // (LF:116-123). Every row is one or the other.
  [SessionListField.PrAssociation]: {
    anyOf: {
      param: "prAssociation",
      aliases: [],
      includeEmptyByDefault: false,
    },
    between: null,
    sortRank: null,
  },
  // One value from `SESSION_QUALITY_VALUES`; a classification every row has,
  // never an empty value (validators.ts:171-178, shared-agent-sessions-query.ts:122-127).
  [SessionListField.Quality]: {
    anyOf: { param: "quality", aliases: [], includeEmptyByDefault: false },
    between: null,
    sortRank: null,
  },
  // A session with no linked document in the project is excluded (QB:626-631).
  // Desktop does not serve this field (see its capability declaration).
  [SessionListField.ProjectIds]: {
    anyOf: { param: "projectIds", aliases: [], includeEmptyByDefault: false },
    between: null,
    sortRank: null,
  },
  // Sort-only: the Owner FILTER is the `userIds` param, an axis of `User`.
  [SessionListField.Assignee]: SORT_ONLY_BY_VALUE,
};

/**
 * The field each legacy filter param is an axis of, aliases included. What a
 * compiler names in the Malformed refusal for a request that sends both an
 * expression and a legacy spelling of one of its axes (ISS-9477 ruling), on
 * the cloud route and the desktop IPC boundary alike.
 */
export const SESSION_LIST_FIELD_BY_LEGACY_PARAM: ReadonlyMap<
  string,
  SessionListField
> = listQueryFieldByLegacyParam(
  Object.values(SessionListField),
  SESSION_LIST_QUERY_FIELDS
);

/**
 * The non-field params that may travel beside `listQuery`, on the cloud route
 * and the desktop IPC boundary alike (ISS-9477 ruling): paging, scope, and
 * `search`. Every other list param spells an axis the expression already
 * speaks, so sending both is refused rather than merged. `userId` is scope on
 * both hosts and intersects with the expression's User clause (ISS-12271).
 */
export const SESSION_LIST_QUERY_COMPANION_PARAMS: ReadonlySet<string> =
  listQueryCompanionParams(SESSION_LIST_NON_FIELD_PARAMS);

/** The Sessions legacy vocabulary, for the PRD-721 client builder. */
export const SESSION_LIST_QUERY_VOCABULARY: ListQueryLegacyVocabulary<SessionListField> =
  {
    fields: SESSION_LIST_QUERY_FIELDS,
    fieldByLegacyParam: SESSION_LIST_FIELD_BY_LEGACY_PARAM,
    nonFieldParams: SESSION_LIST_NON_FIELD_PARAMS,
    companionParams: SESSION_LIST_QUERY_COMPANION_PARAMS,
  };
