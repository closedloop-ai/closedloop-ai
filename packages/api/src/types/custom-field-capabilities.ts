// `.ts`, not `.js`, and load-bearing: this is a VALUE import of a runtime const,
// so the specifier survives into the bundle, where Turbopack resolves it against
// a directory holding `custom-field.ts` and no `custom-field.js`. The `.js` form
// some siblings use is only safe there because those are `import type` and are
// erased before a bundler ever sees them. `rewriteRelativeImportExtensions`
// rewrites this to `.js` on emit, so the dist build stays loadable by a plain
// Node ESM consumer too — the same reason `scripts/smoke-dist-imports.mjs`
// exists.
import { CustomFieldType } from "./custom-field.ts";
// `.ts` for the reason the import above gives: a VALUE import of a runtime const.
import { CustomFieldFilterOperator } from "./custom-field-list-query.ts";

/**
 * What a custom-field column may be ASKED to do, derived from the field's type
 * (ISS-7213).
 *
 * Lives in this lightweight, dependency-free `@repo/api` module — no Zod, no
 * heavy transitive graph — so a bundle-sensitive client can import it. The
 * `apps/api`-local sort table it supersedes as the authority could not be
 * imported by a client at all, which is how a toolbar and a server come to
 * disagree.
 *
 * **Wired today: sort admission only**, in `custom-field-list-service.ts`.
 * `groupable` and `filter` are decided here but have no consumer yet — there is
 * no group-by endpoint, and the Grid Table v2 column projection that will read
 * the facet shape is ISS-7051/7052. Read this as the table those will consult,
 * not as a claim that they already do.
 */

/**
 * Which facet the v2 filter popover renders for a column.
 *
 * A boolean would not be actionable: `FilterFacetGroup` (an option list with
 * per-option counts) and `FilterRangeGroup` (a min/max) are structurally
 * different components backed by different aggregate queries, and which one a
 * field gets is a property of its type.
 */
export const CustomFieldFilterFacet = {
  /**
   * No popover facet — NOT "unfilterable". Unbounded text has neither a bounded
   * option list nor a range to render, but the server still serves exact-match
   * and emptiness facets on it, gated by the admin's `isSearchable`. A
   * projection that reads this as "hide the column from filtering entirely"
   * would withdraw a working capability. It is also what an unrecognized field
   * type falls back to, so `None` alone does not distinguish "decided" from
   * "unknown"; a consumer needing that distinction must check the type against
   * `CUSTOM_FIELD_CAPABILITIES` rather than infer it from the facet.
   */
  None: "none",
  Options: "options",
  /**
   * **Declared, not yet requestable.** `CustomFieldFilterOperator` carries only
   * `isAnyOf` / `isEmpty` / `isNotEmpty`, all of which resolve to an exact-match
   * `IN` set — so a min/max control that sends its two bounds as `isAnyOf`
   * asks for "equals min or max", drops every row between them, and returns 200
   * with a confidently wrong page. Do NOT build the range control until
   * ISS-7211 adds a bounded operator and a predicate to match; the pin in
   * `custom-field-capabilities.test.ts` fails when one appears.
   */
  Range: "range",
} as const;
export type CustomFieldFilterFacet =
  (typeof CustomFieldFilterFacet)[keyof typeof CustomFieldFilterFacet];

/**
 * What a group band holding rows with NO value for the field actually MEANS
 * (ISS-8296).
 *
 * The distinction is only interesting because a drop WRITES. Both spellings
 * render the same em dash, so a reader cannot tell them apart and a drop handler
 * must not have to guess: one names a state a host can genuinely set, the other
 * names the absence of an answer.
 */
export const GroupEmptyBand = {
  /**
   * The empty band IS a value a host can set — an explicitly unassigned owner,
   * an enum with no option chosen. A drop here means "clear it", which is a
   * legitimate write.
   */
  Settable: "settable",
  /**
   * The empty band only means the value could not be determined. Not a
   * destination: there is no write that would move a row into it.
   */
  Undetermined: "undetermined",
} as const;
export type GroupEmptyBand =
  (typeof GroupEmptyBand)[keyof typeof GroupEmptyBand];

/**
 * The canonical value of a band that is empty because nothing is set.
 *
 * PRESENT-AND-EMPTY, and that is the whole point: it is distinct from a band
 * with NO canonical value, and a consumer must test `!== undefined` rather than
 * truthiness or it will read "explicitly unassigned" as "unmappable".
 *
 * Lives here rather than beside the Sessions owner sentinel it coincides with,
 * because that module imports React and this one is reachable from every
 * surface.
 */
export const GROUP_EMPTY_VALUE = "";

/**
 * The grouping half of {@link CustomFieldCapabilities}, as a discriminated pair
 * rather than two independent fields.
 *
 * A type that cannot be grouped has no band, so it has no empty band either —
 * pinning it to `Undetermined` makes that a compile error instead of a row
 * someone fills in by coin flip. The pairing is also what makes ISS-8296's
 * ruling structural: a new `CustomFieldType` cannot be added without deciding
 * whether its empty band is a legal drop target.
 */
type GroupCapability =
  | { groupable: false; emptyBand: typeof GroupEmptyBand.Undetermined }
  | { groupable: true; emptyBand: GroupEmptyBand };

/** The operations a column of a given field type may offer. */
export type CustomFieldCapabilities = {
  sortable: boolean;
  filter: CustomFieldFilterFacet;
} & GroupCapability;

/** Whether one entity's value for a field is one value or a list of them. */
export const CustomFieldCardinality = {
  Single: "single",
  Multi: "multi",
} as const;
export type CustomFieldCardinality =
  (typeof CustomFieldCardinality)[keyof typeof CustomFieldCardinality];

/**
 * How many values one row may hold, read off the storage in
 * `packages/database/prisma/schema.prisma` rather than off the type's name.
 *
 * `Multi` is exactly the three columns that are lists: `multi_enum_value_ids`
 * and `people_value_ids` (both `String[]` under a GIN index, because array
 * overlap is not a btree query), and REFERENCE_MULTI's many
 * `custom_field_value_references` rows. REFERENCE addresses that same child
 * table but is `Single` by enforcement, not by convention: `validateReferenceShape`
 * in `apps/api/app/custom-fields/utils.ts` rejects an array outright with "Use
 * REFERENCE_MULTI for multiple targets", so a REFERENCE row cannot reach storage
 * holding two targets.
 *
 * `as const satisfies` on purpose: `satisfies` keeps the keys exhaustive over
 * `CustomFieldType`, and `as const` keeps each value a literal so the capability
 * table below can constrain itself against these entries at compile time. A
 * plain `Record<CustomFieldType, CustomFieldCardinality>` annotation would widen
 * every entry to the union and silently defeat that constraint.
 */
export const CUSTOM_FIELD_CARDINALITY = {
  [CustomFieldType.Text]: CustomFieldCardinality.Single,
  [CustomFieldType.Number]: CustomFieldCardinality.Single,
  [CustomFieldType.Enum]: CustomFieldCardinality.Single,
  [CustomFieldType.MultiEnum]: CustomFieldCardinality.Multi,
  [CustomFieldType.Date]: CustomFieldCardinality.Single,
  [CustomFieldType.People]: CustomFieldCardinality.Multi,
  [CustomFieldType.Reference]: CustomFieldCardinality.Single,
  [CustomFieldType.ReferenceMulti]: CustomFieldCardinality.Multi,
} as const satisfies Record<CustomFieldType, CustomFieldCardinality>;

/**
 * The capabilities a single field type may declare — identical to
 * {@link CustomFieldCapabilities} except that a `Multi` type is pinned to
 * `groupable: false`.
 *
 * This is what makes the partition rule a compile error instead of a paragraph
 * someone has to have read. Re-admitting a multi-valued type to grouping now
 * fails `tsc` at the offending row.
 */
type CapabilitiesFor<T extends CustomFieldType> =
  (typeof CUSTOM_FIELD_CARDINALITY)[T] extends typeof CustomFieldCardinality.Multi
    ? CustomFieldCapabilities & { groupable: false }
    : CustomFieldCapabilities;

/**
 * THE capability table. Exhaustive over `CustomFieldType`, so adding a field
 * type is a compile error here until someone decides its capabilities rather
 * than silently defaulting it to "no" — the same reason `DISPLAY_VALUE_STRATEGY`
 * next door is a `Record` and not a `switch`.
 *
 * Three rows the ticket flagged as arguable, decided here:
 *
 * - **Multi-value grouping is excluded.** A row holding two values belongs to
 *   two groups, which breaks the partition the grid's section counts rest on:
 *   the per-group counts stop summing to the row total. A table whose counts do
 *   not add up erodes trust in every number on the surface, so the excluded set
 *   is exactly what {@link CUSTOM_FIELD_CARDINALITY} calls `Multi` — MULTI_ENUM,
 *   PEOPLE and REFERENCE_MULTI — and {@link CapabilitiesFor} enforces that
 *   rather than trusting this paragraph to be read.
 *
 *   PEOPLE is why the rule is typed and no longer merely written down. It was
 *   admitted to grouping here until review caught it: the exclusion had been
 *   reasoned about as the types with "MULTI" in the NAME, and PEOPLE is the one
 *   multi-valued type whose name does not say so. Its storage is
 *   `people_value_ids String[]` under a GIN index — the same shape and the same
 *   index as `multi_enum_value_ids` — so a row assigned to two people belongs to
 *   both groups and lands in the count twice.
 * - **DATE is not groupable.** Grouping raw timestamps yields one group per row.
 *   Useful date grouping is by day/week/month, which is a bucketing feature, not
 *   a capability flag, and no bucketing exists yet.
 * - **Multi-value sorting is ALLOWED for MULTI_ENUM, departing from the
 *   ticket's proposal.** The ambiguity it cited (first option? count? joined
 *   string?) was already resolved by ISS-7211, which orders MULTI_ENUM and
 *   PEOPLE by the cached `display_value`. Declaring it unsortable here would
 *   withdraw a shipped, tested ordering.
 *
 *   For PEOPLE that column is NOT the string the cell renders: the cell has
 *   always drawn live users, and ISS-7215 made the API-level `displayValue`
 *   resolve on read too, so the cached column lags a rename until the row is
 *   next written. PEOPLE stays sortable — the column is still populated and
 *   still orders by name — but the guarantee here is "ordered by name", not
 *   "ordered by exactly what is on screen".
 *
 * The reference types are unsortable for a storage reason, not an ambiguity
 * one: their targets live in `custom_field_value_references` and they are
 * `ResolvedOnRead`, so `display_value` is empty for every such row and an
 * ORDER BY over it would serve creation order under the reader's chosen column.
 */
export const CUSTOM_FIELD_CAPABILITIES: {
  [T in CustomFieldType]: CapabilitiesFor<T>;
} = {
  [CustomFieldType.Text]: {
    sortable: true,
    groupable: false,
    emptyBand: GroupEmptyBand.Undetermined,
    filter: CustomFieldFilterFacet.None,
  },
  [CustomFieldType.Number]: {
    sortable: true,
    groupable: false,
    emptyBand: GroupEmptyBand.Undetermined,
    filter: CustomFieldFilterFacet.Range,
  },
  [CustomFieldType.Enum]: {
    sortable: true,
    groupable: true,
    emptyBand: GroupEmptyBand.Settable,
    filter: CustomFieldFilterFacet.Options,
  },
  [CustomFieldType.MultiEnum]: {
    sortable: true,
    groupable: false,
    emptyBand: GroupEmptyBand.Undetermined,
    filter: CustomFieldFilterFacet.Options,
  },
  [CustomFieldType.Date]: {
    sortable: true,
    groupable: false,
    emptyBand: GroupEmptyBand.Undetermined,
    filter: CustomFieldFilterFacet.Range,
  },
  [CustomFieldType.People]: {
    sortable: true,
    groupable: false,
    emptyBand: GroupEmptyBand.Undetermined,
    filter: CustomFieldFilterFacet.Options,
  },
  [CustomFieldType.Reference]: {
    sortable: false,
    groupable: true,
    emptyBand: GroupEmptyBand.Settable,
    filter: CustomFieldFilterFacet.Options,
  },
  [CustomFieldType.ReferenceMulti]: {
    sortable: false,
    groupable: false,
    emptyBand: GroupEmptyBand.Undetermined,
    filter: CustomFieldFilterFacet.Options,
  },
};

/**
 * Everything denied. The safe default for a field type this build does not know.
 */
const UNKNOWN_FIELD_TYPE_CAPABILITIES: CustomFieldCapabilities = {
  sortable: false,
  groupable: false,
  emptyBand: GroupEmptyBand.Undetermined,
  filter: CustomFieldFilterFacet.None,
};

/**
 * Prototype-free view of {@link CUSTOM_FIELD_CAPABILITIES} for lookups keyed by
 * request text. Built once from the exhaustive table so the two cannot drift.
 */
const CAPABILITIES_BY_FIELD_TYPE: Record<string, CustomFieldCapabilities> =
  Object.assign(Object.create(null), CUSTOM_FIELD_CAPABILITIES);

/**
 * The capabilities of a field of this type.
 *
 * The `fieldType` is widened to `string` because it does not always arrive from
 * inside the type boundary: a desktop build older or newer than the server can
 * present a `CustomFieldType` this build has no row for, and a `Record` lookup
 * on it would hand back `undefined` and throw on the first property read — a
 * crashed render, on a column, because a peer shipped a field type first.
 * Denying everything instead degrades to a plain, inert column.
 *
 * Null-prototype lookup because the key is untrusted: `"constructor"` off a
 * plain object literal is a truthy non-capabilities value.
 *
 * The unknown case is deliberately NOT logged here. This module is imported by
 * browser-bundled code, where `scripts/lint/rules/no-client-debug-logging.ts`
 * bans it outright; a server-side counter belongs at the admission call site,
 * which knows the organization and the request.
 */
export function resolveCustomFieldCapabilities(
  fieldType: string
): CustomFieldCapabilities {
  return (
    CAPABILITIES_BY_FIELD_TYPE[fieldType] ?? UNKNOWN_FIELD_TYPE_CAPABILITIES
  );
}

/** Whether a field of this type may be used as a list ordering. */
export function isCustomFieldTypeSortable(fieldType: string): boolean {
  return resolveCustomFieldCapabilities(fieldType).sortable;
}

/** Whether a field of this type may be used as a grouping key. */
export function isCustomFieldTypeGroupable(fieldType: string): boolean {
  return resolveCustomFieldCapabilities(fieldType).groupable;
}

/**
 * Whether a sort request for this field may be SERVED — the whole admission
 * rule, in one place, so the toolbar deciding whether to OFFER the control and
 * the route deciding whether to honour it cannot answer it differently.
 *
 * The two inputs narrow in one direction only. The type capability is the
 * ceiling: what the storage can honestly order by. The admin's stored
 * `isSortable` can take away from it and can never grant past it, which is what
 * keeps that settings toggle meaningful without letting it promise an ordering
 * the data cannot produce.
 */
export function isCustomFieldSortAdmitted(
  fieldType: string,
  isSortable: boolean
): boolean {
  return isSortable && isCustomFieldTypeSortable(fieldType);
}

/**
 * Whether one (field type, operator) pair can be SERVED, or the reason it
 * cannot (ISS-9481).
 *
 * Three answers rather than a boolean because the two refusals reach a
 * version-skewed caller differently: an operator this build does not know means
 * the CALLER is newer, and a field type it does not know means the SCHEMA is.
 * A client that can tell them apart can disable one control without disabling
 * the column.
 */
export const CustomFieldFilterSupport = {
  Supported: "supported",
  /** The operator is not one this build can serve. */
  UnsupportedOperator: "unsupported_operator",
  /** The field's type is not one this build has a predicate for. */
  UnsupportedFieldType: "unsupported_field_type",
} as const;
export type CustomFieldFilterSupport =
  (typeof CustomFieldFilterSupport)[keyof typeof CustomFieldFilterSupport];

/**
 * Whether this build can serve each filter operator — **the declaration
 * ISS-9481 asks an adapter to publish**, so a newer client can disable a
 * control instead of submitting a query its peer will refuse.
 *
 * Published by the SERVER, per field, as `CustomField.filterOperators`
 * ({@link resolveServedCustomFieldFilterOperators}). A client must read it off
 * that response rather than import this table: every client bundles its own
 * `@repo/api`, so importing it answers what the CLIENT's build serves and says
 * nothing about the server it is talking to (tamsinb, #7808).
 *
 * An exhaustive `Record` the requestable set is DERIVED from, never a
 * hand-listed array beside the union. A side inventory widened to `string`
 * compiles when an operator is added and silently leaves the new member out of
 * the set, which is the failure this ticket is about; written this way the
 * missing key fails `tsc` (root `AGENTS.md`, "Adding a variant to a union").
 *
 * Every current operator is served, and that is a measurement rather than a
 * placeholder: `IsAnyOf` resolves to an exact-match `IN` on every type, and the
 * emptiness pair resolves to that type's presence predicate. Declaring any of
 * them unsupported for a facet would withdraw a shipped capability — notably
 * exact-match on a `Range` facet, which the range CONTROL must not use (see
 * {@link CustomFieldFilterFacet.Range}) but which is a working filter in its
 * own right.
 */
const CUSTOM_FIELD_FILTER_OPERATOR_SUPPORT = {
  [CustomFieldFilterOperator.IsAnyOf]: true,
  [CustomFieldFilterOperator.IsEmpty]: true,
  [CustomFieldFilterOperator.IsNotEmpty]: true,
} as const satisfies Record<CustomFieldFilterOperator, boolean>;

/**
 * The operators a client may offer, derived from
 * {@link CUSTOM_FIELD_FILTER_OPERATOR_SUPPORT} so the two cannot drift.
 *
 * Typed as the operator union, not `string[]`: a consumer that narrows against
 * it keeps the compile-time link back to the table.
 */
export const SUPPORTED_CUSTOM_FIELD_FILTER_OPERATORS: readonly CustomFieldFilterOperator[] =
  Object.entries(CUSTOM_FIELD_FILTER_OPERATOR_SUPPORT)
    .filter(([, supported]) => supported)
    .map(([operator]) => operator as CustomFieldFilterOperator);

/** Prototype-free view of the operator table, for lookups keyed by request text. */
const OPERATOR_SUPPORTED_BY_NAME: Record<string, boolean> = Object.assign(
  Object.create(null),
  CUSTOM_FIELD_FILTER_OPERATOR_SUPPORT
);

/**
 * Whether a filter facet naming this field type and operator can be served.
 *
 * Both arguments are widened to `string` for the reason
 * {@link resolveCustomFieldCapabilities} gives: neither arrives from inside the
 * type boundary. The operator comes off a query string, and the field type off
 * a stored row that a rolling deploy can have written with an enum member this
 * build has no row for. Answering `Supported` by omission in either case is how
 * an unserveable facet reaches a predicate table that has no entry for it — and
 * an absent entry is not an error there, it is `undefined`, which becomes an
 * unconstrained `where` that matches every row.
 *
 * The FIELD TYPE is checked first, deliberately: a build that cannot serve the
 * type cannot serve any operator on it, so reporting the operator would send a
 * client off disabling controls that are not the problem.
 */
export function resolveCustomFieldFilterSupport(
  fieldType: string,
  operator: string
): CustomFieldFilterSupport {
  if (!Object.hasOwn(CAPABILITIES_BY_FIELD_TYPE, fieldType)) {
    return CustomFieldFilterSupport.UnsupportedFieldType;
  }
  return OPERATOR_SUPPORTED_BY_NAME[operator]
    ? CustomFieldFilterSupport.Supported
    : CustomFieldFilterSupport.UnsupportedOperator;
}

/**
 * The operators this build serves on a field of this type — what
 * `GET /custom-fields` publishes as `CustomField.filterOperators`. Empty for a
 * type this build does not know, because it can serve no facet on it.
 */
export function resolveServedCustomFieldFilterOperators(
  fieldType: string
): CustomFieldFilterOperator[] {
  return SUPPORTED_CUSTOM_FIELD_FILTER_OPERATORS.filter(
    (operator) =>
      resolveCustomFieldFilterSupport(fieldType, operator) ===
      CustomFieldFilterSupport.Supported
  );
}
