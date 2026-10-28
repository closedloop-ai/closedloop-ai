import {
  type CustomFieldType,
  CustomFieldType as CustomFieldTypeValues,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldFilterSupport,
  resolveCustomFieldFilterSupport,
} from "@repo/api/src/types/custom-field-capabilities";
import {
  type CustomFieldFilter,
  CustomFieldFilterOperator,
  CustomFieldQueryRejection,
  type CustomFieldSortDirection,
} from "@repo/api/src/types/custom-field-list-query";
import {
  type Result,
  Result as ResultHelpers,
} from "@repo/api/src/types/result";
import { parseFiniteNumberInput } from "@repo/lib/custom-fields/finite-number-input";

/**
 * Pure query-shaping for custom-field filter and sort (ISS-7211). No I/O, so the
 * rules that are easiest to get silently wrong — which column a type sorts on,
 * where NULLs land, what "empty" means for an array-valued field — are testable
 * without a database.
 */

/**
 * The physical value the list is ordered by, chosen from the field's type.
 *
 * The wrong column still returns rows, which is why this is explicit: ordering
 * NUMBER by `text_value` sorts 10 before 9, and ordering ENUM by `enum_value_id`
 * sorts by UUID, which is insertion noise from the user's point of view.
 */
export const CustomFieldSortSource = {
  TextValue: "textValue",
  NumberValue: "numberValue",
  DateValue: "dateValue",
  /**
   * The option's declared `sort_order`, which is why the sort needs a second
   * join: `enum_value_id` is a `uuid(7)` and carries only insertion time.
   */
  EnumOptionSortOrder: "enumOptionSortOrder",
  /**
   * MULTI_ENUM and PEOPLE hold a SET with no scalar to order by, so they sort on
   * the cached `display_value` string. Any other choice (first element,
   * cardinality) would order by something with no relation to the cell at all.
   *
   * For PEOPLE that string is no longer what the cell renders: ISS-7215 made
   * PEOPLE `ResolvedOnRead`, so a read derives the label from live users while
   * this column keeps the value cached at write time. A user rename re-derives
   * it through `refreshPeopleDisplayValuesForUser` (ISS-8970) on every
   * Clerk-driven name writer in `usersService`, which is the reason it keeps being
   * written: deriving the key live inside this paginated ORDER BY measured
   * 10–160x the cost at the candidate cap.
   */
  DisplayValue: "displayValue",
} as const;
export type CustomFieldSortSource =
  (typeof CustomFieldSortSource)[keyof typeof CustomFieldSortSource];

const SORT_SOURCE_BY_FIELD_TYPE: Record<
  CustomFieldType,
  CustomFieldSortSource | null
> = {
  [CustomFieldTypeValues.Text]: CustomFieldSortSource.TextValue,
  [CustomFieldTypeValues.Number]: CustomFieldSortSource.NumberValue,
  [CustomFieldTypeValues.Date]: CustomFieldSortSource.DateValue,
  [CustomFieldTypeValues.Enum]: CustomFieldSortSource.EnumOptionSortOrder,
  [CustomFieldTypeValues.MultiEnum]: CustomFieldSortSource.DisplayValue,
  [CustomFieldTypeValues.People]: CustomFieldSortSource.DisplayValue,
  /**
   * The reference types have NO sort source, and `DisplayValue` is specifically
   * the wrong answer for them despite being the precedent for the other two
   * multi-valued types.
   *
   * MULTI_ENUM and PEOPLE both WRITE `display_value`, so the column holds a real
   * string to order by. REFERENCE and REFERENCE_MULTI are `ResolvedOnRead`
   * (ISS-7214) — `computeDisplayValue` returns `""` for them by
   * design so a stale target name can never be read back, which means
   * `v.display_value` is empty for EVERY reference row. Sorting on it would send
   * all of them through `NULLIF(…, '')` into one `NULLS LAST` bucket and hand
   * the reader creation order under the heading of their chosen column: a wrong
   * answer that still returns rows, which is the exact failure this table exists
   * to prevent.
   *
   * PEOPLE is ALSO `ResolvedOnRead` (ISS-7215) and is deliberately NOT `null`
   * here: unlike a reference it still writes its column, so the ordering is
   * real. `ResolvedOnRead` is a statement about the RENDER, not about whether
   * the column is populated — do not read this entry as an inconsistency and
   * blank the column to "fix" it, which is exactly what would collapse every
   * PEOPLE row into the one bucket described above.
   *
   * `null` rather than a stand-in column because a reference has no scalar to
   * order by at all: the targets live in `custom_field_value_references`, and
   * ordering by them would require choosing a target attribute AND, for
   * REFERENCE_MULTI, a reduction over the set. Neither is decided, so
   * {@link resolveSort} refuses the request with `NotSortable` instead of
   * inventing one.
   */
  [CustomFieldTypeValues.Reference]: null,
  [CustomFieldTypeValues.ReferenceMulti]: null,
};

/**
 * Which physical value a field of this type sorts on, or `null` when the type
 * has none. Exhaustive `Record` rather than a `switch` so a new
 * `CustomFieldType` (ISS-7210's Duration) fails `tsc` here instead of falling
 * through to a column that would sort it wrongly.
 *
 * This table answers HOW a sortable type is ordered. WHETHER it may be ordered
 * at all is `CUSTOM_FIELD_CAPABILITIES` in `@repo/api` (ISS-7213), which the
 * toolbar reads too — a `null` here and a `sortable: true` there would admit a
 * request this module then serves with no ORDER BY term, handing the reader
 * creation order under their chosen column. `custom-field-list-query.test.ts`
 * pins the two in agreement.
 */
export function resolveCustomFieldSortSource(
  fieldType: CustomFieldType
): CustomFieldSortSource | null {
  return SORT_SOURCE_BY_FIELD_TYPE[fieldType];
}

/**
 * Where NULLs go for a custom-field sort: **always last, in both directions.**
 *
 * Postgres defaults to NULLS LAST for ASC but NULLS FIRST for DESC, so an
 * unpinned ordering flips whether unset values lead the list the moment the user
 * flips the direction. A custom field is sparse by nature, so that is the
 * difference between "sorted by priority" and a screen of blanks.
 */
export const CUSTOM_FIELD_SORT_NULLS = "LAST" as const;

/** Module-level per Ultracite's `useTopLevelRegex`. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `CustomFieldValue` rows that actually HOLD a value for a field of this type.
 *
 * Row presence is not value presence: clearing a field leaves the row and empties
 * its column. TEXT also treats `""` as empty, because a cleared text box
 * round-trips as an empty string. The array columns are non-nullable `String[]`,
 * so they test emptiness rather than NULL.
 */
export function buildCustomFieldPresencePredicate(
  fieldType: CustomFieldType
): Record<string, unknown> {
  return PRESENCE_PREDICATE_BY_FIELD_TYPE[fieldType];
}

/**
 * Rows whose value is any of `values` — OR within the facet.
 *
 * NUMBER and DATE operands arrive as strings off the query string. One that will
 * not parse is REFUSED rather than dropped: dropping it would evaluate a
 * narrower facet than the caller asked for and report that total as the answer.
 */
export function buildCustomFieldValuePredicate(
  fieldType: CustomFieldType,
  values: string[]
): Result<Record<string, unknown>, CustomFieldQueryRejection> {
  return VALUE_PREDICATE_BY_FIELD_TYPE[fieldType](values);
}

/**
 * The predicate for one facet, or the reason it is refused.
 *
 * `IsEmpty` deliberately returns the PRESENCE predicate, not its negation: the
 * caller resolves the ids that DO hold a value and excludes them. Negating
 * inside this table would miss every entity that never had a row at all.
 */
export function buildCustomFieldFacetPredicate(
  fieldType: CustomFieldType,
  filter: CustomFieldFilter
): Result<Record<string, unknown>, CustomFieldQueryRejection> {
  // ISS-9481. Both halves of this guard are defense in depth; neither is how
  // production reaches the refusal today.
  //
  // `fieldType` comes off the `customField` DEFINITION row `describeField`
  // reads. A rolling deploy that stored a `CustomFieldType` this build lacks
  // fails that read (Prisma P2023), which `describeField` answers with this
  // same rejection, so no unknown type arrives here from that path. Unguarded,
  // one that did would fail invisibly — the presence lookup is `undefined`,
  // which Prisma reads as an unconstrained `where` matching every row, and the
  // value lookup is `undefined` too, which throws on call.
  //
  // The OPERATOR arrives through `customFieldFilterSchema`, whose
  // `operator` is a `z.enum` of the three known members inside `.strict()`,
  // so an unknown operator is a 400 before any predicate is built. It is
  // guarded anyway because this function is exported and the enum is not the
  // only way in. A client learns which operators this server serves from
  // `CustomField.filterOperators`, not from this refusal.
  const support = resolveCustomFieldFilterSupport(fieldType, filter.operator);
  if (support === CustomFieldFilterSupport.UnsupportedFieldType) {
    return ResultHelpers.err(CustomFieldQueryRejection.UnsupportedFieldType);
  }
  if (support === CustomFieldFilterSupport.UnsupportedOperator) {
    return ResultHelpers.err(CustomFieldQueryRejection.UnsupportedOperator);
  }
  if (filter.operator === CustomFieldFilterOperator.IsAnyOf) {
    if (!filter.values || filter.values.length === 0) {
      return ResultHelpers.err(CustomFieldQueryRejection.MissingFilterValues);
    }
    return buildCustomFieldValuePredicate(fieldType, filter.values);
  }
  if (
    filter.operator === CustomFieldFilterOperator.IsEmpty ||
    filter.operator === CustomFieldFilterOperator.IsNotEmpty
  ) {
    return ResultHelpers.ok(buildCustomFieldPresencePredicate(fieldType));
  }
  // The emptiness pair is NAMED rather than left as a trailing `else`, because
  // the support table this function trusts is a separate declaration: a
  // `satisfies Record<CustomFieldFilterOperator, boolean>` forces a ROW when the
  // union grows, never a BRANCH here. A fourth operator marked supported would
  // otherwise reach this line and be served the presence predicate under its own
  // name — "has any value" returned as though it were the filter asked for,
  // which is the wrong-page outcome the guard above exists to stop. Named, it
  // makes `_exhaustive` non-`never` and fails `tsc` until someone decides.
  const _exhaustive: never = filter.operator;
  return ResultHelpers.err(CustomFieldQueryRejection.UnsupportedOperator);
}

/** Whether a facet's resolved id set is the set to KEEP or the set to EXCLUDE. */
export function isExcludingFacet(filter: CustomFieldFilter): boolean {
  return filter.operator === CustomFieldFilterOperator.IsEmpty;
}

/**
 * Whether this sort source is a STRING column, and therefore carries the write
 * path's empty-string spelling of "no value".
 *
 * `NULLS LAST` orders NULLs, and `""` is not NULL. But `computeDisplayValue`
 * returns `""` for a null raw value, for an empty MULTI_ENUM or PEOPLE array,
 * and for an ENUM whose option was deleted, and a cleared text box round-trips
 * as `""` in `text_value` — which
 * {@link buildCustomFieldPresencePredicate} already treats as empty. So the
 * string columns hold two spellings of "unset" while only one of them obeys the
 * null placement, and ascending order puts every blank cell AHEAD of every real
 * value (whitlockk review).
 *
 * The numeric, date, and enum-sort-order sources cannot hold `""` — they are
 * `Float?`, `DateTime?`, and an `Int` reached through a join — so normalizing
 * them would be noise.
 */
export function sortSourceCarriesEmptyString(
  source: CustomFieldSortSource
): boolean {
  return (
    source === CustomFieldSortSource.TextValue ||
    source === CustomFieldSortSource.DisplayValue
  );
}

/** Normalize a sort direction to the SQL keyword, defaulting to ascending. */
export function resolveSortKeyword(
  direction: CustomFieldSortDirection
): "ASC" | "DESC" {
  return direction === "desc" ? "DESC" : "ASC";
}

/**
 * The presence predicate per field type.
 *
 * Exhaustive `Record` rather than an if-chain with a trailing fallthrough: a new
 * `CustomFieldType` (ISS-7210's Duration) must fail `tsc` here, not silently
 * inherit the PEOPLE columns and report every Duration value as absent.
 */
const PRESENCE_PREDICATE_BY_FIELD_TYPE: Record<
  CustomFieldType,
  Record<string, unknown>
> = {
  [CustomFieldTypeValues.Text]: {
    AND: [{ textValue: { not: null } }, { textValue: { not: "" } }],
  },
  [CustomFieldTypeValues.Number]: { numberValue: { not: null } },
  [CustomFieldTypeValues.Date]: { dateValue: { not: null } },
  [CustomFieldTypeValues.Enum]: { enumValueId: { not: null } },
  [CustomFieldTypeValues.MultiEnum]: { multiEnumValueIds: { isEmpty: false } },
  [CustomFieldTypeValues.People]: { peopleValueIds: { isEmpty: false } },
  /**
   * A reference holds no value COLUMN — its targets are rows in
   * `custom_field_value_references` — so presence is the existence of at least
   * one such row, not a null or emptiness test on `v`.
   *
   * `display_value` cannot stand in here for the same reason it cannot stand in
   * for the sort source: it is `""` for every reference row by design, so a
   * column test would report every reference value as absent and quietly hand
   * `isNotEmpty` an empty page.
   *
   * REFERENCE and REFERENCE_MULTI share the shape because they share the
   * storage; the cardinality difference is enforced on write (REFERENCE is
   * capped at one row), not re-litigated by this read.
   */
  [CustomFieldTypeValues.Reference]: { references: { some: {} } },
  [CustomFieldTypeValues.ReferenceMulti]: { references: { some: {} } },
};

/**
 * Parse NUMBER operands, refusing the whole facet if any will not parse.
 *
 * `parseFiniteNumberInput` owns the rule (blank and non-finite both rejected);
 * a facet sent an operand it refuses would otherwise become a confident, wrong
 * filter rather than a rejection.
 */
function numberValuePredicate(
  values: string[]
): Result<Record<string, unknown>, CustomFieldQueryRejection> {
  const numbers: number[] = [];
  for (const value of values) {
    const parsed = parseFiniteNumberInput(value);
    if (parsed === null) {
      return ResultHelpers.err(CustomFieldQueryRejection.InvalidFilterValue);
    }
    numbers.push(parsed);
  }
  return ResultHelpers.ok({ numberValue: { in: numbers } });
}

/**
 * Validate ENUM operands as UUIDs before they reach the query.
 *
 * `custom_field_values.enum_value_id` is `@db.Uuid`, so a non-UUID operand is not
 * a filter that matches nothing — it is a Postgres cast error thrown mid-query,
 * which surfaces as a 500 on what is really a malformed request. Rejecting here
 * makes it the 400 it always was.
 */
function enumValuePredicate(
  values: string[]
): Result<Record<string, unknown>, CustomFieldQueryRejection> {
  if (values.some((value) => !UUID_RE.test(value))) {
    return ResultHelpers.err(CustomFieldQueryRejection.InvalidFilterValue);
  }
  return ResultHelpers.ok({ enumValueId: { in: values } });
}

/**
 * Match rows referencing any of the requested target artifacts.
 *
 * The operands are `Artifact.id`s — the same ids the reference chip already
 * renders — so "field X points at artifact Y" is the only meaning this facet
 * can carry, and the relation answers it exactly via
 * `custom_field_value_references(target_artifact_id)`.
 *
 * UUID-validated for the same reason as {@link enumValuePredicate}:
 * `target_artifact_id` is `@db.Uuid`, so a non-UUID operand is not a filter that
 * matches nothing — it is a Postgres cast error thrown mid-query, surfacing as a
 * 500 on what is really a malformed request.
 */
function referenceValuePredicate(
  values: string[]
): Result<Record<string, unknown>, CustomFieldQueryRejection> {
  if (values.some((value) => !UUID_RE.test(value))) {
    return ResultHelpers.err(CustomFieldQueryRejection.InvalidFilterValue);
  }
  return ResultHelpers.ok({
    references: { some: { targetArtifactId: { in: values } } },
  });
}

/** Parse DATE operands, refusing the whole facet if any will not parse. */
function dateValuePredicate(
  values: string[]
): Result<Record<string, unknown>, CustomFieldQueryRejection> {
  const dates = values.map((value) => new Date(value));
  if (dates.some((date) => Number.isNaN(date.getTime()))) {
    return ResultHelpers.err(CustomFieldQueryRejection.InvalidFilterValue);
  }
  return ResultHelpers.ok({ dateValue: { in: dates } });
}

/**
 * The value predicate per field type. Exhaustive for the same reason as
 * {@link PRESENCE_PREDICATE_BY_FIELD_TYPE}.
 */
const VALUE_PREDICATE_BY_FIELD_TYPE: Record<
  CustomFieldType,
  (
    values: string[]
  ) => Result<Record<string, unknown>, CustomFieldQueryRejection>
> = {
  [CustomFieldTypeValues.Text]: (values) =>
    ResultHelpers.ok({ textValue: { in: values } }),
  [CustomFieldTypeValues.Number]: numberValuePredicate,
  [CustomFieldTypeValues.Date]: dateValuePredicate,
  [CustomFieldTypeValues.Enum]: enumValuePredicate,
  [CustomFieldTypeValues.MultiEnum]: (values) =>
    ResultHelpers.ok({ multiEnumValueIds: { hasSome: values } }),
  [CustomFieldTypeValues.People]: (values) =>
    ResultHelpers.ok({ peopleValueIds: { hasSome: values } }),
  [CustomFieldTypeValues.Reference]: referenceValuePredicate,
  [CustomFieldTypeValues.ReferenceMulti]: referenceValuePredicate,
};
