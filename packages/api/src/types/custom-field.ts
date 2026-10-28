// Custom Field types for API contract
// These are explicitly defined to keep packages/api independent of database

import type { ArtifactSubtype, ArtifactType } from "./artifact.js";
import type { CustomFieldFilterOperator } from "./custom-field-list-query.js";
import type { BasicUser } from "./user.js";

/**
 * The types of values a custom field can hold.
 * Mirrors the Prisma CustomFieldType enum.
 */
export const CustomFieldType = {
  Text: "TEXT",
  Number: "NUMBER",
  Enum: "ENUM",
  MultiEnum: "MULTI_ENUM",
  Date: "DATE",
  People: "PEOPLE",
  Reference: "REFERENCE",
  ReferenceMulti: "REFERENCE_MULTI",
} as const;
export type CustomFieldType =
  (typeof CustomFieldType)[keyof typeof CustomFieldType];

/**
 * The populations a REFERENCE / REFERENCE_MULTI field may point at.
 * Mirrors the Prisma ReferenceTargetSource enum.
 */
export const ReferenceTargetSource = {
  Artifact: "ARTIFACT",
  Session: "SESSION",
  Issue: "ISSUE",
  Branch: "BRANCH",
} as const;
export type ReferenceTargetSource =
  (typeof ReferenceTargetSource)[keyof typeof ReferenceTargetSource];

/**
 * How a field type's `displayValue` is produced.
 *
 * `CachedOnWrite` denormalizes the string into `custom_field_values.display_value`
 * when the VALUE changes and a read returns that column. `ResolvedOnRead` derives
 * the string from the live rows on every read and never returns the column.
 *
 * This is a statement about the READ, not about persistence. A `ResolvedOnRead`
 * type MAY still write the column for another purpose — PEOPLE does, because it
 * is the sort key (see {@link DISPLAY_VALUE_STRATEGY}) — so do not read this as
 * licence to blank it.
 */
export const DisplayValueStrategy = {
  CachedOnWrite: "CACHED_ON_WRITE",
  ResolvedOnRead: "RESOLVED_ON_READ",
} as const;
export type DisplayValueStrategy =
  (typeof DisplayValueStrategy)[keyof typeof DisplayValueStrategy];

/**
 * THE caching rule (ISS-7214). Both the write path and the read path in
 * `apps/api/app/custom-fields/values-service.ts` consult this table and nothing
 * else, so the rule is declared once rather than re-decided per call site.
 *
 * The distinction is whether the display string is derivable from data the
 * custom-field services own. TEXT/NUMBER/DATE are self-contained, and
 * ENUM/MULTI_ENUM resolve against `CustomFieldEnumOption` rows the same service
 * writes, so it can cascade a rename transactionally — caching is sound. A
 * REFERENCE points at an artifact whose name changes with no write to the
 * referencing row, so a cached string is stale the moment the target is renamed
 * and outlives the target when it is deleted.
 *
 * The Record is exhaustive over `CustomFieldType` so a new field type cannot
 * compile until someone decides which side it falls on.
 *
 * PEOPLE joined REFERENCE on `ResolvedOnRead` in ISS-7215, for the same reason:
 * a user's display name changes with no write to the referencing row.
 *
 * It took only HALF of REFERENCE's treatment, and the difference is load-bearing.
 * REFERENCE also has `computeDisplayValue` return `""`, so its column is provably
 * empty. PEOPLE keeps writing its column, because
 * `documents/custom-field-list-query.ts` orders both MULTI_ENUM and PEOPLE by
 * `display_value` — a set-valued field has no other scalar — and an empty column
 * would send every PEOPLE row through `NULLIF(…,'')` into one `NULLS LAST`
 * bucket, serving creation order under the reader's chosen column.
 *
 * So this table governs the RENDER, not persistence: for PEOPLE the stored
 * string survives purely as a SORT KEY and is never what a read returns. Do not
 * "restore consistency" by blanking it.
 */
export const DISPLAY_VALUE_STRATEGY: Record<
  CustomFieldType,
  DisplayValueStrategy
> = {
  [CustomFieldType.Text]: DisplayValueStrategy.CachedOnWrite,
  [CustomFieldType.Number]: DisplayValueStrategy.CachedOnWrite,
  [CustomFieldType.Enum]: DisplayValueStrategy.CachedOnWrite,
  [CustomFieldType.MultiEnum]: DisplayValueStrategy.CachedOnWrite,
  [CustomFieldType.Date]: DisplayValueStrategy.CachedOnWrite,
  [CustomFieldType.People]: DisplayValueStrategy.ResolvedOnRead,
  [CustomFieldType.Reference]: DisplayValueStrategy.ResolvedOnRead,
  [CustomFieldType.ReferenceMulti]: DisplayValueStrategy.ResolvedOnRead,
};

/**
 * True when a READ must derive this field type's display string from live rows
 * rather than return the stored column.
 *
 * This is not the same as "never persisted", which is what it used to say: that
 * held while REFERENCE was the only such type and its column was deliberately
 * empty. PEOPLE resolves on read AND still persists a string, because that
 * column is its sort key (see {@link DISPLAY_VALUE_STRATEGY}). Ask this before
 * trusting a stored `displayValue`; do not read it as a claim about what the
 * column contains.
 */
export function resolvesDisplayValueOnRead(
  fieldType: CustomFieldType
): boolean {
  return (
    DISPLAY_VALUE_STRATEGY[fieldType] === DisplayValueStrategy.ResolvedOnRead
  );
}

/**
 * The entity types that custom fields can be attached to.
 *
 * NOTE: This is intentionally distinct from `EntityType` in `entity-link.ts`.
 * `EntityType` (DOCUMENT, EXTERNAL_LINK) models polymorphic *link* relationships
 * between entities. `CustomFieldEntityType` models which domain entities can have custom
 * field definitions attached — it includes PROJECT (which is not a link target)
 * and omits EXTERNAL_LINK (which cannot hold custom field values).
 *
 * DOCUMENT, SESSION and BRANCH all address the SAME `artifacts` table by
 * `Artifact.id`; only `Artifact.type` tells them apart. The entity type is
 * therefore load-bearing, not decorative — `verifyEntityExists` filters on the
 * matching `ArtifactType` so one artifact kind cannot be addressed as another
 * (ISS-7209). DEPLOYMENT is the fourth `ArtifactType` and is deliberately
 * absent: no surface asks for custom columns on it yet.
 */
export const CustomFieldEntityType = {
  Project: "PROJECT",
  Document: "DOCUMENT",
  Session: "SESSION",
  Branch: "BRANCH",
} as const;
export type CustomFieldEntityType =
  (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType];

/**
 * The REST path segment each entity type's custom-field sub-resources hang off.
 *
 * Exhaustive, and deliberately a table rather than a derivation: clients used to
 * build this as `` `${entityType.toLowerCase()}s` ``, which silently produced
 * `/sessions/…` (the route is `/agent-sessions/…`) and `/branchs/…` for the two
 * types ISS-7209 added. A wrong path is a 404 at runtime, not a compile error,
 * so the mapping is stated once here and a new entity type cannot be added
 * without choosing its segment.
 */
export const CUSTOM_FIELD_ENTITY_API_SEGMENT: Record<
  CustomFieldEntityType,
  string
> = {
  [CustomFieldEntityType.Project]: "projects",
  [CustomFieldEntityType.Document]: "documents",
  [CustomFieldEntityType.Session]: "agent-sessions",
  [CustomFieldEntityType.Branch]: "branches",
};

/**
 * Display format for NUMBER type custom fields.
 * Mirrors the Prisma NumberFormat enum.
 *
 * `Duration` (ISS-7210) renders the stored number as an elapsed span. **Its
 * canonical storage unit is MILLISECONDS** — `CustomFieldValue.numberValue`
 * holds whole milliseconds, matching every other elapsed span in this package
 * (`durationMs`) and in the telemetry schema (`duration_ms`), so a cycle-time
 * column can be fed from those sources without a conversion step. Formatting
 * and parsing both live in `./custom-field-duration.js`; nothing else may
 * assume a different unit.
 *
 * A duration is a NUMBER field with this format rather than its own
 * `CustomFieldType` because the storage genuinely is a number and the
 * per-field formatting machinery already exists. Revisit if duration
 * arithmetic (sums, averages, over-SLA filters) becomes a requirement — that
 * is what would justify a first-class type.
 */
export const NumberFormat = {
  None: "NONE",
  Currency: "CURRENCY",
  Percentage: "PERCENTAGE",
  Custom: "CUSTOM",
  Duration: "DURATION",
} as const;
export type NumberFormat = (typeof NumberFormat)[keyof typeof NumberFormat];

/**
 * Position of a custom label relative to the number value for CUSTOM number format.
 * Mirrors the Prisma LabelPosition enum.
 */
export const LabelPosition = {
  Prefix: "PREFIX",
  Suffix: "SUFFIX",
} as const;
export type LabelPosition = (typeof LabelPosition)[keyof typeof LabelPosition];

// Enum option types

export type CustomFieldEnumOption = {
  id: string;
  customFieldId: string;
  name: string;
  color: string;
  enabled: boolean;
  sortOrder: number;
};

export type CreateEnumOptionInput = {
  name: string;
  color?: string;
  enabled?: boolean;
  sortOrder?: number;
};

export type UpdateEnumOptionInput = {
  name?: string;
  color?: string;
  enabled?: boolean;
};

// Custom field definition types

export type CustomField = {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  fieldType: CustomFieldType;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  // Number-specific fields
  precision: number | null;
  numberFormat: NumberFormat | null;
  currencyCode: string | null;
  customLabel: string | null;
  customLabelPosition: LabelPosition | null;
  // Behavior
  isGlobalToOrg: boolean;
  // Entity type applicability
  entityTypes: CustomFieldEntityType[];
  /** Permitted target populations. Empty for non-reference field types. */
  referenceTargetSources: ReferenceTargetSource[];
  // Display configuration
  showInTable: boolean;
  isSearchable: boolean;
  isSortable: boolean;
  /**
   * The filter operators the SERVER can serve on this field (ISS-9481), so a
   * client built against a different `@repo/api` disables a control rather
   * than submitting a facet this server refuses. Absent from a server that
   * predates it, which serves `isAnyOf`, `isEmpty` and `isNotEmpty` on every
   * type it has.
   */
  filterOperators?: CustomFieldFilterOperator[];
};

/** Custom field definition with its enum options included. */
export type CustomFieldWithOptions = CustomField & {
  enumOptions: CustomFieldEnumOption[];
};

export type CreateCustomFieldInput = {
  name: string;
  description?: string;
  fieldType: CustomFieldType;
  // Number-specific
  precision?: number;
  numberFormat?: NumberFormat;
  currencyCode?: string;
  customLabel?: string;
  customLabelPosition?: LabelPosition;
  // Initial enum options (only valid for ENUM/MULTI_ENUM fields)
  enumOptions?: CreateEnumOptionInput[];
  // Entity type applicability
  entityTypes?: CustomFieldEntityType[];
  /** Permitted target populations (only valid for REFERENCE/REFERENCE_MULTI). */
  referenceTargetSources?: ReferenceTargetSource[];
  // Display configuration
  showInTable?: boolean;
  isSearchable?: boolean;
  isSortable?: boolean;
};

export type UpdateCustomFieldInput = {
  id: string;
  name?: string;
  description?: string;
  // Number-specific (fieldType itself is immutable after creation)
  precision?: number;
  numberFormat?: NumberFormat;
  currencyCode?: string;
  customLabel?: string;
  customLabelPosition?: LabelPosition;
  // Entity type applicability
  entityTypes?: CustomFieldEntityType[];
  /** Permitted target populations (only valid for REFERENCE/REFERENCE_MULTI). */
  referenceTargetSources?: ReferenceTargetSource[];
  // Display configuration
  showInTable?: boolean;
  isSearchable?: boolean;
  isSortable?: boolean;
};

// Custom field settings (field-to-entity-type attachment) types

export type CustomFieldSetting = {
  id: string;
  customFieldId: string;
  entityType: CustomFieldEntityType;
  entityId: string;
  isImportant: boolean;
  isRequired: boolean;
  sortOrder: number;
  createdAt: Date;
  customField: CustomField;
};

export type CustomFieldSettingWithOptions = Omit<
  CustomFieldSetting,
  "customField"
> & {
  customField: CustomFieldWithOptions;
};

export type AttachCustomFieldInput = {
  customFieldId: string;
  isImportant?: boolean;
  isRequired?: boolean;
  sortOrder?: number;
};

// Custom field value types

/**
 * A resolved custom field value for a specific entity instance.
 * Returned inline on entity GET responses (e.g., ProjectWithDetails.customFields).
 * Contains the field definition metadata plus the typed value and a pre-computed display string.
 */
export type CustomFieldValueDetail = {
  id: string;
  /** The custom field definition ID. */
  customFieldId: string;
  /** The entity instance this value belongs to. Used for grouping in batch list responses. */
  entityId: string;
  /** The custom field name (denormalized for convenience). */
  name: string;
  /** The custom field type (denormalized for rendering without extra fetches). */
  fieldType: CustomFieldType;
  /**
   * Safe-to-render string representation of the current value. Empty string
   * when no value is set.
   *
   * NOT pre-computed for every type: {@link DISPLAY_VALUE_STRATEGY} decides
   * per type whether this carries the stored column or a string derived from
   * the live rows on this same response. For PEOPLE and the reference types it
   * is derived, so it cannot go stale when a user or target is renamed — and
   * for those types it goes empty, rather than stale, once the rows it names
   * are gone.
   */
  displayValue: string | null;
  /** Whether this field should appear as a column in table views (from field definition). */
  showInTable: boolean;
  // Type-specific value fields — only one is populated per instance
  textValue: string | null;
  numberValue: number | null;
  dateValue: Date | null;
  /** Resolved enum option for ENUM fields. */
  enumValue: CustomFieldEnumOption | null;
  /** Resolved enum options for MULTI_ENUM fields. */
  multiEnumValues: CustomFieldEnumOption[];
  /** Resolved users for PEOPLE fields. */
  peopleValues: BasicUser[];
  /**
   * Resolved target artifacts for REFERENCE / REFERENCE_MULTI fields.
   *
   * Read live from the target rows on every read, never from a cached string
   * (see {@link DISPLAY_VALUE_STRATEGY}). A renamed target is reflected on the
   * next read; a deleted target is absent rather than rendered as a stale title.
   */
  referenceValues: CustomFieldReferenceTarget[];
};

/**
 * A reference target resolved for rendering. Carries the fields the reference
 * chip needs — slug, name, kind and status — which a single `displayValue`
 * string structurally cannot.
 */
export type CustomFieldReferenceTarget = {
  id: string;
  slug: string | null;
  name: string;
  artifactType: ArtifactType;
  subtype: ArtifactSubtype | null;
  status: string;
};

/** Candidates returned when the picker opens with no query typed yet. */
export const REFERENCE_SEARCH_DEFAULT_LIMIT = 20;

/**
 * Hard cap on one page of candidates.
 *
 * The server's decision, not the caller's: a reference picker is a search over
 * the org's whole artifact table, so an unbounded `limit` would turn a typeahead
 * into a full export of every artifact title.
 */
export const REFERENCE_SEARCH_MAX_LIMIT = 50;

/**
 * Ids one batch resolution may name.
 *
 * Sized for the worst realistic page rather than the worst possible value: a
 * 50-row page whose reference column holds ten targets per row is 500 ids, while
 * {@link CustomFieldReferenceTarget} values themselves cap at 100 targets each.
 */
export const REFERENCE_RESOLVE_MAX_IDS = 500;

/**
 * One page of reference-picker candidates.
 *
 * `hasMore` exists so the picker can say "keep typing" instead of implying the
 * list is exhaustive. A bounded typeahead that silently truncates renders an
 * absent artifact and a filtered-out one identically, which is the same lie as
 * a blank chip.
 */
export type CustomFieldReferenceSearchResponse = {
  targets: CustomFieldReferenceTarget[];
  hasMore: boolean;
};

/**
 * One batch resolution of target ids the caller already holds.
 *
 * `targets` keeps the caller's id order so a multi-value cell renders its chips
 * as stored. `unresolvable` carries the ids that produced no row — the honest
 * rendering contract for a reference whose target was deleted or belongs to
 * another organization.
 *
 * Those two causes are deliberately COLLAPSED into one bucket. Distinguishing
 * "deleted" from "not yours" would confirm that an id exists somewhere in the
 * system, which is precisely the cross-organization leak the org scoping exists
 * to prevent. The client renders an unresolvable id as an explicit unavailable
 * chip: never blank, and never a title it was not allowed to read.
 */
export type CustomFieldReferenceResolveResponse = {
  targets: CustomFieldReferenceTarget[];
  unresolvable: string[];
};

/**
 * The order one page of reference-picker candidates is read in, declared once.
 *
 * `updatedAt` alone ties freely across artifacts touched in the same write, and
 * an unstable order makes `hasMore` mean nothing — the same query could drop a
 * different row from the tail on every keystroke. `id` is the tiebreak.
 *
 * SHARED BECAUSE AN INDEX DEPENDS ON IT. The ISS-7804 `artifacts` indexes are
 * built as `(organization_id, [type,] updated_at DESC, id)` precisely so this
 * order is servable without a sort node, and
 * `packages/database/__tests__/integration/iss7804-artifact-reference-search-indexes.integration.test.ts`
 * builds the SQL it EXPLAINs from this constant. Re-spelling the order at the
 * `findMany` call site is what would let the endpoint quietly reorder itself
 * back onto a top-N sort of the whole tenant partition while that suite stayed
 * green against the order it used to have.
 *
 * Plain data rather than a Prisma type so `@repo/database`'s suites can read it
 * without this module taking a load-time dependency on the generated client.
 */
export const REFERENCE_TARGET_SEARCH_ORDER_BY = [
  { updatedAt: "desc" },
  { id: "asc" },
] as const;

/**
 * Maximum number of custom field definitions per organization (AC-017).
 *
 * Shared rather than API-only: the Sessions saved view holds one width per
 * custom-field column and sizes its cap to this (ISS-10356).
 */
export const MAX_CUSTOM_FIELDS_PER_ORG = 500;
