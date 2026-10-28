// ISS-9476: the canonical filter and sort expression every list grid speaks
// (PRD-721). Zod-free so a bundle-sensitive client can build and serialize a
// request without pulling in a validator; the strict schema and the parser live
// in the sibling `list-query-expression-schema.ts` (PLN-1938 K1a, the
// `branch-list-contract.ts` + `branch-list-contract-schema.ts` precedent).
//
// The model owns capability and serialization only. Which legacy params a
// field lowers to lives in the per-list registries, and executing a query is
// the host adapters' job (ISS-9477 cloud, ISS-9479 desktop).
//
// `.ts` extensions: see "Relative Imports in Emitted Helpers" in
// `packages/api/AGENTS.md`.
import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import {
  CUSTOM_FIELD_FILTER_MAX_FACETS,
  CUSTOM_FIELD_FILTER_MAX_VALUES,
  CustomFieldFilterOperator,
  CustomFieldSortDirection,
} from "./custom-field-list-query.ts";

/**
 * The only expression version this build reads. A parser meeting any other
 * number refuses it with {@link ListQueryRefusal.UnsupportedVersion} rather
 * than guessing at a shape it has never seen.
 */
export const LIST_QUERY_EXPRESSION_VERSION = 1;

/**
 * The ONE query param the expression travels in, beside the legacy list params
 * (PLN-1938 §8 decisions 2 and 3). Its value is the JSON from
 * {@link serializeListQueryExpression}; `URLSearchParams` does the URL-encoding.
 *
 * Read off the Sessions (ISS-9477) and Branches (PRD-721) list routes, and
 * written by the grid clients' builder (`list-query-legacy-params.ts`).
 */
export const LIST_QUERY_EXPRESSION_PARAM = "listQuery";

/**
 * Longest {@link LIST_QUERY_EXPRESSION_PARAM} value a parser reads, in UTF-16
 * code units of the DECODED string (`string.length`), before it refuses the
 * request. It bounds the URL param only: a host that receives the expression as
 * a structured value (desktop IPC) validates it with the schema directly, where
 * the clause and value caps bound it and no length cap applies.
 *
 * The Sessions legacy repeated params carry no length ceiling of their own:
 * each facet caps its value COUNT and nothing caps a value's length. The only
 * bound on a legacy URL is the transport's: Node's default
 * `--max-http-header-size`, 16 KiB, caps the whole request head, request line
 * included, nothing in this repo raises it, and a proxy in front of the API can
 * only lower it. Percent-decoding never lengthens a string and a UTF-8 byte
 * sequence never decodes to more code units than bytes, so a request the
 * transport admits never trips this cap — it is level with the legacy ceiling,
 * not tighter.
 */
export const LIST_QUERY_EXPRESSION_MAX_LENGTH = 16_384;

/**
 * What one clause asks of a field.
 *
 * Extends {@link CustomFieldFilterOperator} rather than re-spelling it, so the
 * three wire strings custom-field facets already send stay byte-identical.
 * `isBetween` is the design system's range filter kind (`FilterRangeGroup`);
 * `isAnyOf` is its options kind (`FilterFacetGroup`). There is no `isNoneOf`
 * and no `contains`: nothing produces or compiles either, and search stays a
 * cross-field legacy param on both hosts.
 */
export const ListFilterOperator = {
  ...CustomFieldFilterOperator,
  /** Inclusive on both bounds; either bound may be absent, never both. */
  IsBetween: "isBetween",
} as const;
export type ListFilterOperator =
  (typeof ListFilterOperator)[keyof typeof ListFilterOperator];

/** Sort direction. The custom-field spelling, reused so asc/desc exist once. */
export const ListSortDirection = CustomFieldSortDirection;
export type ListSortDirection = CustomFieldSortDirection;

/**
 * One operand. Dates travel as ISO-8601 strings. Never an array or object: a
 * clause's values are a flat list, which is what keeps expression depth fixed.
 */
export type ListFilterScalar = string | number;

/** OR within the clause: a row matches when its value is any of `values`. */
export type ListIsAnyOfClause = {
  field: string;
  operator: typeof ListFilterOperator.IsAnyOf;
  values: ListFilterScalar[];
  /**
   * Also admit rows holding no value. Absent means the field's registry
   * default, which reproduces today's cloud behavior for that field.
   */
  includeEmpty?: boolean;
};

export type ListIsBetweenClause = {
  field: string;
  operator: typeof ListFilterOperator.IsBetween;
  min?: ListFilterScalar;
  max?: ListFilterScalar;
  /** As on {@link ListIsAnyOfClause}. */
  includeEmpty?: boolean;
};

export type ListEmptinessClause = {
  field: string;
  operator:
    | typeof ListFilterOperator.IsEmpty
    | typeof ListFilterOperator.IsNotEmpty;
};

/** One clause. Clauses AND together; a field carries at most one clause. */
export type ListFilterClause =
  | ListIsAnyOfClause
  | ListIsBetweenClause
  | ListEmptinessClause;

/** One sort rule. Rules apply in array order; a field carries at most one. */
export type ListSortRule = {
  field: string;
  direction: ListSortDirection;
};

/**
 * The whole v1 expression: AND across `filters`, OR within one clause's
 * values, no nesting, no OR groups, no negation groups. Absent `filters` or
 * `sorts` means none. Paging, scope (`viewerScope`, `teamId`) and `search` are
 * NOT here; they stay legacy params beside it.
 */
export type ListQueryExpression = {
  version: typeof LIST_QUERY_EXPRESSION_VERSION;
  filters?: ListFilterClause[];
  sorts?: ListSortRule[];
};

/**
 * Wire ceilings every parser enforces before any host looks at the expression.
 * A host's capability may declare lower ones, never higher.
 *
 * One clause per field, so the clause ceiling is the widest filterable
 * built-in field set a list has (cloud Sessions filters on 13) plus room for
 * every `customField:` facet on top. A lower cap would leave a legal legacy
 * request with no expression that says the same thing, and raising it later
 * means every older parser refuses the wider request.
 * `session-list-query-capabilities.test.ts` and `list-query-registries.test.ts`
 * fail when a list outgrows it. The value cap IS the custom-field facet value
 * cap: a clause's values are the OR-ed candidates of one facet.
 */
const WIDEST_BUILT_IN_FILTER_FIELD_SET = 13;
export const LIST_QUERY_MAX_CLAUSES =
  WIDEST_BUILT_IN_FILTER_FIELD_SET + CUSTOM_FIELD_FILTER_MAX_FACETS;
export const LIST_QUERY_MAX_VALUES_PER_CLAUSE = CUSTOM_FIELD_FILTER_MAX_VALUES;
/**
 * One rule per field at most, so the ceiling is the widest sortable field set a
 * list has: Sessions sorts on 12 distinct columns (`AGENT_SESSION_SORT_COLUMNS`
 * lists 13, but `assignee` is an alias of `user`).
 */
export const LIST_QUERY_MAX_SORT_RULES = 12;

/**
 * Why an expression was refused. Wire-visible reason codes a client maps to
 * copy; a client meeting an unrecognized one falls back to its generic error
 * rather than crashing. Named after `CustomFieldQueryRejection` (ISS-9481).
 */
export const ListQueryRefusal = {
  /** `version` is a number this build does not read (the caller is newer). */
  UnsupportedVersion: "list_query_version_unsupported",
  /** The host has no such field, or cannot sort by it. */
  UnsupportedField: "list_query_field_unsupported",
  /** The host cannot serve this operator on this field. */
  UnsupportedOperator: "list_query_operator_unsupported",
  TooManyClauses: "list_query_too_many_clauses",
  TooManyValues: "list_query_too_many_values",
  TooManySortRules: "list_query_too_many_sort_rules",
  /** Not a v1 expression at all: bad JSON, wrong shape, unknown key, nesting. */
  Malformed: "list_query_malformed",
} as const;
export type ListQueryRefusal =
  (typeof ListQueryRefusal)[keyof typeof ListQueryRefusal];

/** What a refusal names. Both optional: a malformed envelope names neither. */
export type ListQueryRefusalDetails = {
  field?: string;
  operator?: string;
};

/** A refusal as a route returns it (`ApiResult` `code` + `details`). */
export type ListQueryRefused = {
  code: ListQueryRefusal;
  details: ListQueryRefusalDetails;
};

/**
 * How a sortable field orders its values. A semantic rank is one of the
 * canonical rank consts, never a new ranking — the sources are
 * `LIST_QUERY_SEMANTIC_SORT_RANKS` in `list-query-fields.ts`.
 */
export const ListSortRank = {
  /** The stored value's own order. Session status sorts this way, raw string. */
  Value: "value",
  /** `PRIORITY_ORDINAL` (`search-query.ts`), LOW < MEDIUM < HIGH < URGENT. */
  PriorityOrdinal: "priorityOrdinal",
  /** `branchStatusOrderingFor` (`branch-status-order.ts`). */
  BranchStatusOrdering: "branchStatusOrdering",
} as const;
export type ListSortRank = (typeof ListSortRank)[keyof typeof ListSortRank];

/**
 * Why a legacy list param is not a field and never appears in an expression.
 * Each list's registry classifies its own non-field params with it.
 */
export const ListNonFieldParamReason = {
  /** `limit` / `offset`: stays beside the expression (PLN-1938 §8). */
  Paging: "paging",
  /** Comes from the principal or a pinned cohort, never a field (PLN-1938 A1). */
  Scope: "scope",
  /** Cross-field text match, not a field operator. */
  Search: "search",
  /** The legacy spelling of the expression's own `sorts`. */
  LegacySort: "legacySort",
  /** A bound no column, facet, or sort key renders. */
  Unmodeled: "unmodeled",
} as const;
export type ListNonFieldParamReason =
  (typeof ListNonFieldParamReason)[keyof typeof ListNonFieldParamReason];

/**
 * How an `isAnyOf` clause (and, through `emptyToken`, the emptiness operators)
 * lowers to a list's legacy params.
 */
export type ListFieldSetLowering<TParam extends string> = {
  /** The param a compiler writes the clause's values to. */
  param: TParam;
  /**
   * Older single-value spellings of the same axis that the host still reads,
   * and that `param` takes precedence over (e.g. `status` beside `statuses`).
   * A compiler never writes them; they are recorded so a request carrying
   * both an expression and an alias can be recognised as one axis.
   */
  aliases: readonly TParam[];
  /**
   * Whether rows holding no value match when a clause omits `includeEmpty`.
   * Reproduces today's CLOUD behavior; where desktop differs, the registry
   * entry says so and cloud wins (ISS-9482 / ISS-9585 own the policy).
   */
  includeEmptyByDefault: boolean;
  /**
   * The legacy vocabulary's own id for the no-value bucket, when it has one.
   * What `isEmpty` and `includeEmpty: true` lower to. A clause that names this
   * token in its values AND sets `includeEmpty: false` contradicts itself; the
   * resolver cannot see the registry, so a compiler refuses it as Malformed.
   */
  emptyToken?: string;
  /**
   * Every value that means "has a value", when that set is closed. What
   * `isNotEmpty` lowers to; a field without it cannot serve `isNotEmpty`.
   */
  nonEmptyValues?: readonly string[];
};

/** How an `isBetween` clause lowers: one param per bound, both inclusive. */
export type ListFieldRangeLowering<TParam extends string> = {
  minParam: TParam;
  maxParam: TParam;
  /** As on {@link ListFieldSetLowering}. */
  includeEmptyByDefault: boolean;
};

/** One registry entry: how a field filters and sorts on its list. */
export type ListFieldSpec<TParam extends string> = {
  anyOf: ListFieldSetLowering<TParam> | null;
  between: ListFieldRangeLowering<TParam> | null;
  /** `null` when the list cannot sort by this field on any host. */
  sortRank: ListSortRank | null;
};

/**
 * The expression as its one param value. Absent optional keys and empty lists
 * are dropped and `stableStringify` orders the keys, so one expression always
 * serializes to one string — a client can key a cache on it.
 *
 * Called by the grid clients' builder (`list-query-legacy-params.ts`).
 */
export function serializeListQueryExpression(
  expression: ListQueryExpression
): string {
  const canonical: ListQueryExpression = {
    version: expression.version,
  };
  if (expression.filters && expression.filters.length > 0) {
    canonical.filters = expression.filters.map(canonicalClause);
  }
  if (expression.sorts && expression.sorts.length > 0) {
    canonical.sorts = expression.sorts.map((rule) => ({
      field: rule.field,
      direction: rule.direction,
    }));
  }
  return stableStringify(canonical);
}

function canonicalClause(clause: ListFilterClause): ListFilterClause {
  switch (clause.operator) {
    case ListFilterOperator.IsAnyOf:
      return {
        field: clause.field,
        operator: clause.operator,
        values: [...clause.values],
        ...(clause.includeEmpty === undefined
          ? {}
          : { includeEmpty: clause.includeEmpty }),
      };
    case ListFilterOperator.IsBetween:
      return {
        field: clause.field,
        operator: clause.operator,
        ...(clause.min === undefined ? {} : { min: clause.min }),
        ...(clause.max === undefined ? {} : { max: clause.max }),
        ...(clause.includeEmpty === undefined
          ? {}
          : { includeEmpty: clause.includeEmpty }),
      };
    case ListFilterOperator.IsEmpty:
    case ListFilterOperator.IsNotEmpty:
      return { field: clause.field, operator: clause.operator };
    default:
      return assertNeverClause(clause);
  }
}

function assertNeverClause(clause: never): never {
  throw new Error(`unhandled list filter clause: ${JSON.stringify(clause)}`);
}

/**
 * Every legacy param a field's lowerings read, written param first. What a
 * compiler checks when a request carries both an expression and legacy params:
 * a param listed here for any field is that field's axis.
 *
 * Read by the registries' legacy-param maps (`listQueryFieldByLegacyParam`),
 * which every compiler and the grid clients' builder consult.
 */
export function listFieldLegacyParams<TParam extends string>(
  spec: ListFieldSpec<TParam>
): TParam[] {
  const params: TParam[] = [];
  if (spec.anyOf) {
    params.push(spec.anyOf.param, ...spec.anyOf.aliases);
  }
  if (spec.between) {
    params.push(spec.between.minParam, spec.between.maxParam);
  }
  return params;
}
