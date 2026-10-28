// ISS-9476: what the cloud and desktop Sessions list reads can serve today,
// each row citing the code that proves it. A declaration states the host as it
// is, not as it should be: a gap here is a real refusal a caller must handle.
//
// Cloud paths are under `apps/api/app/agent-sessions/`; desktop paths under
// `apps/desktop/src/main/session/` unless written in full.
import {
  DEFAULT_SESSION_QUALITY,
  SESSION_COST_FILTER_OPTIONS,
  SESSION_QUALITY_VALUES,
  SESSION_STATUS_FILTER_VALUES,
  SessionChangePresenceId,
  SessionPrAssociationId,
  type SessionQuality,
} from "../agent-session-filters.ts";
import { SESSION_AUTONOMY_TIER_FILTER_OPTIONS } from "../session-autonomy-tiers.ts";
import {
  SESSION_LIST_MAX_FILTER_VALUES,
  SESSION_LIST_MAX_LIMIT,
  SESSION_LIST_MAX_OFFSET,
} from "./agent-session-list-limits.ts";
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
import { SessionListField } from "./list-query-fields.ts";
import { PRIORITY_FILTER_VALUES } from "./priority-filter.ts";
import { TABLE_PAGE_SIZE_MAX } from "./table-page-size-limits.ts";

type FilterCapability = Pick<
  ListFieldCapability,
  "operators" | "includeEmpty" | "values" | "valueFormat"
>;

/**
 * Every Sessions registry default is `includeEmpty: false`
 * (`session-list-query-registry.ts`), so an explicit `false` asks for the
 * default — served wherever the host really drops empty rows, which desktop
 * does not on model and lastActivity (see `DESKTOP_MODEL` below). An explicit
 * `true` is served only where the legacy vocabulary has a no-value token to
 * lower it to.
 */
const EXCLUDE_EMPTY = [false] as const;
const EITHER_EMPTINESS = [false, true] as const;

const ANY_OF: FilterCapability = {
  operators: [ListFilterOperator.IsAnyOf],
  includeEmpty: { [ListFilterOperator.IsAnyOf]: EXCLUDE_EMPTY },
};
/** `isAnyOf` plus `isEmpty` through the field's registry empty token. */
const ANY_OF_OR_EMPTY: FilterCapability = {
  operators: [ListFilterOperator.IsAnyOf, ListFilterOperator.IsEmpty],
  includeEmpty: { [ListFilterOperator.IsAnyOf]: EITHER_EMPTINESS },
};
/**
 * Priority alone also serves `isNotEmpty`: its members are a closed set that
 * excludes the unset arm (`splitPriorityFilter`, priority-filter.ts:28-39), so
 * selecting every member is exactly "has a priority".
 */
const PRIORITY: FilterCapability = {
  operators: [
    ListFilterOperator.IsAnyOf,
    ListFilterOperator.IsEmpty,
    ListFilterOperator.IsNotEmpty,
  ],
  includeEmpty: { [ListFilterOperator.IsAnyOf]: EITHER_EMPTINESS },
  // Both hosts refuse a value outside it: cloud `z.enum` (validators.ts:170),
  // desktop `coercePriorityFilterValues` (shared-agent-sessions-query.ts:387-397).
  values: PRIORITY_FILTER_VALUES,
};
const BETWEEN: FilterCapability = {
  operators: [ListFilterOperator.IsBetween],
  includeEmpty: { [ListFilterOperator.IsBetween]: EXCLUDE_EMPTY },
};
const NO_FILTER: FilterCapability = { operators: [] };

/**
 * Cloud reads `userIds` and `projectIds` as `z.string().uuid()`
 * (validators.ts:63-65) and refuses the whole request on anything else.
 */
const CLOUD_UUID: FilterCapability = {
  ...ANY_OF,
  valueFormat: ListFieldValueFormat.Uuid,
};
/**
 * `startDate`/`endDate` must `Date.parse` and sit at or after
 * `PG_TIMESTAMP_MIN_MS` (validators.ts:35-41).
 */
const CLOUD_LAST_ACTIVITY: FilterCapability = {
  ...BETWEEN,
  valueFormat: ListFieldValueFormat.PgTimestamp,
};
/**
 * `repositories`, `harnesses` and `models` read each entry as
 * `z.string().trim().min(1)` (validators.ts:62) and refuse the whole request on
 * a number or a blank string.
 */
const CLOUD_TEXT: FilterCapability = {
  ...ANY_OF,
  valueFormat: ListFieldValueFormat.NonBlankString,
};

/**
 * Closed vocabularies. On autonomy, cost, change presence and PR association
 * cloud IGNORES an unknown id (validators.ts:155-166), and a selection of only
 * unknown ids applies no clause at all — the host would answer with every row.
 * An unknown status matches nothing (service/query-builder.ts:864-867) and desktop fails an unknown
 * quality open to "all". Declaring each set lets the resolver refuse such a
 * value rather than pass it to a host that misreads it.
 */
const STATUS: FilterCapability = {
  ...ANY_OF,
  values: SESSION_STATUS_FILTER_VALUES,
};
const AUTONOMY: FilterCapability = {
  ...ANY_OF_OR_EMPTY,
  values: SESSION_AUTONOMY_TIER_FILTER_OPTIONS.map((option) => option.value),
};
const COST: FilterCapability = {
  ...ANY_OF_OR_EMPTY,
  values: SESSION_COST_FILTER_OPTIONS.map((option) => option.id),
};
const CHANGE_PRESENCE: FilterCapability = {
  ...ANY_OF,
  values: Object.values(SessionChangePresenceId),
};
const PR_ASSOCIATION: FilterCapability = {
  ...ANY_OF,
  values: Object.values(SessionPrAssociationId),
};

/**
 * `quality` takes one value from `SESSION_QUALITY_VALUES` on both hosts: it is
 * a segment, not a facet. The closed set matters most on desktop, whose
 * `coerceSessionQuality` fails open to "all" on an unknown value
 * (session-quality-query.ts); cloud refuses it (validators.ts:178).
 */
const QUALITY: FilterCapability & Pick<ListFieldCapability, "maxValues"> = {
  ...ANY_OF,
  maxValues: 1,
  values: SESSION_QUALITY_VALUES,
};

/**
 * Desktop cannot serve an EXPLICIT `includeEmpty: false` on these, because its
 * read does not drop the empty rows cloud drops: a null model folds to
 * "unknown" and matches that value (session-local-facet-filters.ts:56-69), and
 * a row with no last-activity instant is windowed by its start time
 * (shared-agent-sessions-api.ts:952-964). An omitted `includeEmpty` is still
 * served; that divergence is ISS-9585's.
 */
const DESKTOP_MODEL: FilterCapability = {
  operators: [ListFilterOperator.IsAnyOf],
  includeEmpty: { [ListFilterOperator.IsAnyOf]: [] },
  valueFormat: ListFieldValueFormat.NonBlankString,
};
const DESKTOP_LAST_ACTIVITY: FilterCapability = {
  operators: [ListFilterOperator.IsBetween],
  includeEmpty: { [ListFilterOperator.IsBetween]: [] },
  // `parseOptionalDate` drops a non-string bound, which widens the window, and
  // throws on an unparseable one (shared-agent-sessions-query.ts:185-199).
  valueFormat: ListFieldValueFormat.Timestamp,
};
/**
 * The IPC schema drops a non-string facet entry (`optionalStringArray`,
 * apps/desktop/src/shared/shared-agent-sessions-contract-schema.ts:88-94),
 * `coerceStringArray` drops a blank one
 * (shared-agent-sessions-query.ts:146-160), and a facet left empty applies no
 * constraint, so a numeric or blank value widens the read.
 */
const DESKTOP_TEXT: FilterCapability = {
  ...ANY_OF,
  valueFormat: ListFieldValueFormat.NonBlankString,
};

/**
 * `GET /agent-sessions`. Sort columns: `AGENT_SESSION_SORT_COLUMNS`
 * (validators.ts:68-83); facets: `baseAgentSessionQueryShape`
 * (validators.ts:137-198), each lowered in `service/query-builder.ts`.
 */
const CLOUD_SESSION_FIELDS: Readonly<
  Record<SessionListField, ListFieldCapability>
> = {
  [SessionListField.User]: { ...CLOUD_UUID, sortable: true },
  [SessionListField.Status]: { ...STATUS, sortable: true },
  [SessionListField.Repo]: { ...CLOUD_TEXT, sortable: true },
  [SessionListField.Harness]: { ...CLOUD_TEXT, sortable: true },
  [SessionListField.Model]: { ...CLOUD_TEXT, sortable: true },
  // The "unknown" tier selects `autonomy IS NULL` (query-builder.ts:415-425).
  [SessionListField.Autonomy]: { ...AUTONOMY, sortable: true },
  [SessionListField.Duration]: { ...NO_FILTER, sortable: true },
  // The "unknown" bucket selects the unknown-cost rows (query-builder.ts:485-495).
  [SessionListField.Cost]: { ...COST, sortable: true },
  [SessionListField.Started]: { ...NO_FILTER, sortable: true },
  // NONE adds the `priority IS NULL` arm (service/priority-facet-where.ts:24-29).
  [SessionListField.Priority]: { ...PRIORITY, sortable: true },
  [SessionListField.Updated]: { ...NO_FILTER, sortable: true },
  // startDate/endDate, inclusive (query-builder.ts:676-692).
  [SessionListField.LastActivity]: { ...CLOUD_LAST_ACTIVITY, sortable: true },
  [SessionListField.ChangePresence]: { ...CHANGE_PRESENCE, sortable: false },
  [SessionListField.PrAssociation]: { ...PR_ASSOCIATION, sortable: false },
  // `z.enum(SESSION_QUALITY_VALUES).optional()` (validators.ts:178).
  [SessionListField.Quality]: { ...QUALITY, sortable: false },
  [SessionListField.ProjectIds]: { ...CLOUD_UUID, sortable: false },
  // ISS-12251: the Owner sort's own name; `User` sorts identically.
  [SessionListField.Assignee]: { ...NO_FILTER, sortable: true },
};

/** Read by the ISS-9477 cloud compiler, the ISS-9584 parity harness and the web grid's builder. */
export const CLOUD_SESSION_LIST_QUERY_CAPABILITY: ListQueryCapability = {
  version: LIST_QUERY_EXPRESSION_VERSION,
  fields: CLOUD_SESSION_FIELDS,
  // Facets are independent params with no count of their own; the wire cap
  // binds.
  maxClauses: LIST_QUERY_MAX_CLAUSES,
  // Every repeatable facet (validators.ts:56-59, ISS-9073).
  maxValuesPerClause: SESSION_LIST_MAX_FILTER_VALUES,
  // `resolveSessionSortRules` keeps one rule per column and folds `assignee`
  // into its `user` alias (service/session-sort-rules.ts), so one per sortable
  // field, the alias not counted.
  maxSortRules: countSortable(CLOUD_SESSION_FIELDS) - 1,
};

/**
 * The desktop local Sessions read (`shared-agent-sessions-api.ts`), as the
 * renderer reaches it over IPC (`SharedAgentSessionsQuery`,
 * `apps/desktop/src/shared/shared-agent-sessions-contract.ts`).
 */
const DESKTOP_SESSION_FIELDS = {
  // shared-agent-sessions-api.ts:912-924.
  [SessionListField.User]: { ...DESKTOP_TEXT, sortable: true },
  // shared-agent-sessions-api.ts:893-905.
  [SessionListField.Status]: { ...STATUS, sortable: true },
  // session-repository-facet.ts:100-108.
  [SessionListField.Repo]: { ...DESKTOP_TEXT, sortable: true },
  // session-local-facet-filters.ts:47-55.
  [SessionListField.Harness]: { ...DESKTOP_TEXT, sortable: true },
  // session-local-facet-filters.ts:56-69.
  [SessionListField.Model]: { ...DESKTOP_MODEL, sortable: true },
  // Filters (session-local-facet-filters.ts:70-77) but cannot sort:
  // `LocalSessionSortColumn` has no autonomy (session-sort-columns.ts:34-46),
  // and `parseSortRules` refuses it (shared-agent-sessions-query.ts:357-366).
  [SessionListField.Autonomy]: { ...AUTONOMY, sortable: false },
  [SessionListField.Duration]: { ...NO_FILTER, sortable: true },
  // session-local-facet-filters.ts:78-93.
  [SessionListField.Cost]: { ...COST, sortable: true },
  [SessionListField.Started]: { ...NO_FILTER, sortable: true },
  // `matchesPriorityFilter` (session-local-facet-filters.ts:36-39).
  [SessionListField.Priority]: { ...PRIORITY, sortable: true },
  [SessionListField.Updated]: { ...NO_FILTER, sortable: true },
  // `matchesDateBounds` (shared-agent-sessions-api.ts:952-964).
  [SessionListField.LastActivity]: { ...DESKTOP_LAST_ACTIVITY, sortable: true },
  // session-local-facet-filters.ts:106-115.
  [SessionListField.ChangePresence]: { ...CHANGE_PRESENCE, sortable: false },
  // session-local-facet-filters.ts:116-123.
  [SessionListField.PrAssociation]: { ...PR_ASSOCIATION, sortable: false },
  // `coerceSessionQuality` (shared-agent-sessions-query.ts:122-127).
  [SessionListField.Quality]: { ...QUALITY, sortable: false },
  // `projectIds` is absent: `SharedAgentSessionsQuery` has no such key and the
  // IPC schema strips it
  // (apps/desktop/src/shared/shared-agent-sessions-contract-schema.ts:107-162).
  // `assignee` is absent: `LocalSessionSortColumn` has no such key; the local
  // Owner sort is `user` (ISS-12251 D-7).
} as const satisfies Partial<Record<SessionListField, ListFieldCapability>>;

/** Read by the ISS-9479 desktop compiler, the ISS-9584 parity harness and the desktop grid's builder. */
export const DESKTOP_SESSION_LIST_QUERY_CAPABILITY: ListQueryCapability = {
  version: LIST_QUERY_EXPRESSION_VERSION,
  fields: DESKTOP_SESSION_FIELDS,
  maxClauses: LIST_QUERY_MAX_CLAUSES,
  // The IPC schema does not bound facet arrays; the wire cap binds.
  maxValuesPerClause: LIST_QUERY_MAX_VALUES_PER_CLAUSE,
  // A second rule throws `SharedAgentSessionsInputError`
  // (shared-agent-sessions-query.ts:263-269); the renderer passes
  // `maxSortRules={1}` (apps/desktop/src/renderer/components/sessions/sessions-v2-view.tsx:384).
  maxSortRules: 1,
};

function countSortable(
  fields: Readonly<Record<string, ListFieldCapability>>
): number {
  return Object.values(fields).filter((field) => field.sortable).length;
}

/** What a host does with a `limit` above its maximum. */
export const SessionListOverLimit = {
  Clamp: "clamp",
  Refuse: "refuse",
} as const;
export type SessionListOverLimit =
  (typeof SessionListOverLimit)[keyof typeof SessionListOverLimit];

/**
 * ISS-9584: what each host does with a legacy param the expression model
 * cannot state. These are host capability and version skew, DECLARED here and
 * not changed (PLN-1938 K4, K7, C4; §8 decisions 1 and 8 are open). The parity
 * runners assert each value against the live read, so a declaration that stops
 * describing its host fails a test.
 */
export type SessionListLegacyParamBehavior = {
  /** The column a read with no sort rule orders by, descending. */
  unsortedOrder: SessionListField;
  /**
   * The column an unrecognized scalar `sortBy` orders by, descending; `null`
   * when the host refuses the request.
   */
  unknownSortBy: SessionListField | null;
  /** The quality an unrecognized `quality` reads as; `null` when refused. */
  unknownQuality: SessionQuality | null;
  maxLimit: number;
  overLimit: SessionListOverLimit;
  /** The largest `offset` served; `null` when there is no ceiling. */
  maxOffset: number | null;
};

/**
 * `SESSION_DEFAULT_ORDER_BY` (service/session-sort-order.ts); `sortBy` and
 * `quality` are `z.enum` (validators.ts); `limit` and `offset` are bounded by
 * `SESSION_LIST_MAX_LIMIT` / `SESSION_LIST_MAX_OFFSET` (validators.ts).
 */
export const CLOUD_SESSION_LIST_LEGACY_PARAM_BEHAVIOR: SessionListLegacyParamBehavior =
  {
    unsortedOrder: SessionListField.LastActivity,
    unknownSortBy: null,
    unknownQuality: null,
    maxLimit: SESSION_LIST_MAX_LIMIT,
    overLimit: SessionListOverLimit.Refuse,
    maxOffset: SESSION_LIST_MAX_OFFSET,
  };

/**
 * An unsorted read keeps the `updated_at DESC` cursor fast path
 * (`listCursorSortFromQuery`, session-read-fast-paths.ts) — the one row here
 * the ISS-9584 brief did not name, declared rather than conformed because the
 * fast path and the repository read's capped "most recent N" both depend on
 * that order; an unknown `sortBy` falls to `sessionSortKey`'s started-at arm
 * (session-working-set-sort.ts);
 * `coerceSessionQuality` fails open to `DEFAULT_SESSION_QUALITY`; the list
 * bounds clamp `limit` and floor `offset` at 0 with no ceiling
 * (shared-agent-sessions-list-bounds.ts). The single sort rule and the missing
 * autonomy sort are already in {@link DESKTOP_SESSION_LIST_QUERY_CAPABILITY}.
 */
export const DESKTOP_SESSION_LIST_LEGACY_PARAM_BEHAVIOR: SessionListLegacyParamBehavior =
  {
    unsortedOrder: SessionListField.Updated,
    unknownSortBy: SessionListField.Started,
    unknownQuality: DEFAULT_SESSION_QUALITY,
    maxLimit: TABLE_PAGE_SIZE_MAX,
    overLimit: SessionListOverLimit.Clamp,
    maxOffset: null,
  };
