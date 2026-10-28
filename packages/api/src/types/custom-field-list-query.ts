// Wire contract for custom-field filtering and sorting in list queries
// (ISS-7211). Shared because both sides read it: `apps/api` validates and
// executes the query, and the Grid Table v2 toolbar builds the request from the
// same constants.

/**
 * How a custom-field facet narrows a list. `IsAnyOf` is OR *within* one facet;
 * several facets AND together. Emptiness is its own operator rather than a magic
 * value in {@link CustomFieldFilter.values} because the EAV shape makes "has no
 * value" a row-absence question, not a comparison.
 */
export const CustomFieldFilterOperator = {
  IsAnyOf: "isAnyOf",
  IsEmpty: "isEmpty",
  IsNotEmpty: "isNotEmpty",
} as const;
export type CustomFieldFilterOperator =
  (typeof CustomFieldFilterOperator)[keyof typeof CustomFieldFilterOperator];

export const CustomFieldSortDirection = {
  Asc: "asc",
  Desc: "desc",
} as const;
export type CustomFieldSortDirection =
  (typeof CustomFieldSortDirection)[keyof typeof CustomFieldSortDirection];

/** One facet of a custom-field filter set. */
export type CustomFieldFilter = {
  fieldId: string;
  operator: CustomFieldFilterOperator;
  /** OR-ed candidates. Required for `IsAnyOf`; the emptiness operators take none. */
  values?: string[];
};

/** A request to order a list by one custom field. */
export type CustomFieldSort = {
  fieldId: string;
  direction: CustomFieldSortDirection;
};

/**
 * Why a custom-field query was refused. Wire-visible reason codes the client
 * maps to copy; a client meeting an unrecognized one falls back to the generic
 * message rather than crashing.
 */
export const CustomFieldQueryRejection = {
  /** No such field in this organization, or it is not eligible for this entity type. */
  UnknownField: "unknown_custom_field",
  /** The field exists but its `isSortable` capability flag is false. */
  NotSortable: "custom_field_not_sortable",
  /** The field exists but its `isSearchable` capability flag is false. */
  NotFilterable: "custom_field_not_filterable",
  /** `isAnyOf` was sent with no candidate values. */
  MissingFilterValues: "custom_field_filter_values_required",
  /**
   * A candidate value could not be read as the field's type. Refused rather than
   * dropped, which would narrow the page by fewer facets than the caller asked
   * for with no way for them to tell.
   */
  InvalidFilterValue: "custom_field_filter_value_invalid",
  /**
   * The facet names an operator this build cannot serve (ISS-9481).
   *
   * Refused rather than approximated, because the two approximations both lie
   * — falling back to the presence predicate answers a question nobody asked,
   * and dropping the facet reports a broader page as though it were the
   * filtered one. Not what a list request sees today: its validator rejects an
   * unknown operator first. A client avoids both by reading the operators a
   * server serves off `CustomField.filterOperators`.
   */
  UnsupportedOperator: "custom_field_operator_unsupported",
  /**
   * The field exists, but its definition holds an enum value this build cannot
   * read (ISS-9481) — a rolling deploy where the schema shipped a new
   * `CustomFieldType` ahead of the code that reads it. Returned for a sort and
   * a filter alike.
   *
   * Distinct from {@link CustomFieldQueryRejection.UnknownField}, which means no
   * such field in this organization at all.
   */
  UnsupportedFieldType: "custom_field_type_unsupported",
  /**
   * The request's SCOPED population is larger than one query can carry. The
   * client should narrow it (add a project, a type, an assignee, or a recency
   * window) and retry.
   *
   * Measured against the population the request actually describes, never
   * against the org. A facet matching 25,000 entities org-wide but five inside
   * `projectId=X` is answered, not refused — otherwise this code's own guidance
   * would be unfollowable, since narrowing cannot change an org-wide count
   * (whitlockk review).
   */
  FilterTooBroad: "custom_field_filter_too_broad",
} as const;
export type CustomFieldQueryRejection =
  (typeof CustomFieldQueryRejection)[keyof typeof CustomFieldQueryRejection];

/**
 * Facet cap. Each facet costs one indexed read against `custom_field_values`, so
 * this is what stops a crafted request fanning one list call into many.
 */
export const CUSTOM_FIELD_FILTER_MAX_FACETS = 12;

/** The maximum number of OR-ed candidate values one facet may carry. */
export const CUSTOM_FIELD_FILTER_MAX_VALUES = 100;

/**
 * The most entity ids one resolved query may carry, **in aggregate** — not per
 * facet.
 *
 * A resolved id set becomes an `IN`/`NOT IN` list, and every element is one
 * bound parameter. The ceiling is NOT Postgres' documented 65535, but the reason
 * is not the one this docstring used to give. It claimed Prisma's Postgres
 * driver encodes the parameter count as a SIGNED 16-bit integer, making 32767
 * "half the documented figure". That rationale is refuted (ISS-8239): the wire's
 * `Bind` message counts parameters in a UINT16, and a statement passed through
 * VERBATIM (`$queryRaw` / `$executeRaw` / `Prisma.join`) really does reach 65535.
 * 32767 is PRISMA CLIENT'S OWN per-statement budget, which applies here only
 * because Prisma BUILDS this statement. It surfaces as the opaque "query
 * parameter limit supported by your database is exceeded" rather than as
 * anything a caller can act on. Measured on this schema (ISS-7211 review): 20001
 * ids succeed, 32766 already fail.
 *
 * **Per-facet was the wrong scope.** `isEmpty` facets UNION into one exclusion
 * set, so a per-facet bound of 20000 let two disjoint facets present 40000
 * parameters and three present 60000 — past the cliff the bound existed to
 * prevent (whitlockk and tamsinb, independently). The bound is therefore applied to
 * the aggregate constraint that actually reaches the database.
 */
export const CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES = 20_000;
