import {
  CustomFieldEntityType,
  type CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { isCustomFieldSortAdmitted } from "@repo/api/src/types/custom-field-capabilities";
import {
  CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES,
  type CustomFieldFilter,
  CustomFieldQueryRejection,
  type CustomFieldSort,
} from "@repo/api/src/types/custom-field-list-query";
import {
  type Result,
  Result as ResultHelpers,
} from "@repo/api/src/types/result";
import { Prisma, withDb } from "@repo/database";
import { isUnknownEnumValueError } from "@/lib/db-utils";
import {
  buildCustomFieldFacetPredicate,
  CUSTOM_FIELD_SORT_NULLS,
  CustomFieldSortSource,
  isExcludingFacet,
  resolveCustomFieldSortSource,
  resolveSortKeyword,
  sortSourceCarriesEmptyString,
} from "./custom-field-list-query";
import type { ScopedPopulationReader } from "./custom-field-scoped-population";

/**
 * Database-facing half of custom-field filter and sort (ISS-7211): capability
 * enforcement, and turning an allowed request into an entity-id set.
 *
 * `CustomFieldValue` is polymorphic with no Prisma relation back to `Artifact`,
 * so `where: { values: { some: … } }` does not exist and everything resolves to
 * an **id set** AND-ed in as `id: { in … }` / `id: { notIn … }`. That is what
 * keeps totals honest: a constraint on the artifact's own primary key selects
 * each artifact at most once, so `artifact.count()` over it is an ENTITY count,
 * where a join against the tall value table would report an entity carrying
 * three values as three rows.
 */

/** The subset of a `CustomField` the query path needs to make its decisions. */
export type CustomFieldQueryDescriptor = {
  id: string;
  fieldType: CustomFieldType;
  isSortable: boolean;
  isSearchable: boolean;
};

/**
 * The entity-id constraint a resolved filter set imposes on the artifact query.
 *
 * `include` absent means "no facet narrowed the set"; `include: []` means a facet
 * matched nothing and the result is legitimately empty — a distinction the
 * caller must preserve, since collapsing them turns "no matches" into "no
 * filter" and returns the whole list.
 */
export type CustomFieldEntityIdConstraint = {
  include?: string[];
  exclude: string[];
};

export const customFieldListService = {
  /**
   * Load a field for use in a list query, refusing anything the caller may not ask for.
   *
   * Org-scoped in the lookup itself, so a field id from another organization is
   * indistinguishable from one that does not exist. A field that does not
   * declare this entity type cannot hold values for it and is refused the same way.
   */
  async describeField(
    fieldId: string,
    organizationId: string,
    entityType: CustomFieldEntityType = CustomFieldEntityType.Document
  ): Promise<Result<CustomFieldQueryDescriptor, CustomFieldQueryRejection>> {
    let field:
      | (CustomFieldQueryDescriptor & { entityTypes: CustomFieldEntityType[] })
      | null;
    try {
      field = await withDb((db) =>
        db.customField.findFirst({
          where: { id: fieldId, organizationId },
          select: {
            id: true,
            fieldType: true,
            isSortable: true,
            isSearchable: true,
            entityTypes: true,
          },
        })
      );
    } catch (error) {
      // ISS-9481 (tamsinb, #7808). A rolling deploy whose migration added an
      // enum value (`field_type` or `entity_types`) ahead of this build's
      // generated client never reaches the predicate guard: Prisma 7's data
      // mapper throws P2023 "Value 'X' not found in enum" on the READ, which was
      // a 500 for both sort and filter. Matched on the message too because
      // P2023 also covers a malformed UUID, which this must not relabel.
      if (isUnknownEnumValueError(error)) {
        return ResultHelpers.err(
          CustomFieldQueryRejection.UnsupportedFieldType
        );
      }
      throw error;
    }
    if (!field?.entityTypes.includes(entityType)) {
      return ResultHelpers.err(CustomFieldQueryRejection.UnknownField);
    }
    return ResultHelpers.ok({
      id: field.id,
      fieldType: field.fieldType,
      isSortable: field.isSortable,
      isSearchable: field.isSearchable,
    });
  },

  /**
   * Resolve a sort request, enforcing BOTH capability layers **server-side**.
   *
   * Neither is a UI hint: the toolbar only offers sortable columns, but a
   * crafted request reaches this path directly. Refused with a distinct reason
   * code so "you may not sort by this" is not "no such field".
   *
   * The two layers narrow in one direction only (ISS-7213). The type
   * capability is the ceiling — what the storage can honestly answer — and the
   * admin's `isSortable` can only take away from it, never grant past it. That
   * is what keeps the settings toggle meaningful without letting it promise an
   * ordering the data cannot produce.
   */
  async resolveSort(
    sort: CustomFieldSort,
    organizationId: string,
    entityType: CustomFieldEntityType = CustomFieldEntityType.Document
  ): Promise<Result<CustomFieldQueryDescriptor, CustomFieldQueryRejection>> {
    const described = await customFieldListService.describeField(
      sort.fieldId,
      organizationId,
      entityType
    );
    if (!described.ok) {
      return described;
    }
    // One reason code for both layers, because it is one answer to the caller
    // ("you may not sort by this"). The type half is what a flag-only gate lets
    // through: an admin can grant `isSortable` on a REFERENCE, whose targets
    // live in a side table and whose display string is never written
    // (ISS-7214), and the alternative to refusing is an ORDER BY over a column
    // that is empty for every such row.
    if (
      !isCustomFieldSortAdmitted(
        described.value.fieldType,
        described.value.isSortable
      )
    ) {
      return ResultHelpers.err(CustomFieldQueryRejection.NotSortable);
    }
    return described;
  },

  /**
   * Resolve a filter set to the entity-id constraint it imposes, enforcing
   * `isSearchable` server-side for every facet.
   *
   * Facets AND together, so include sets INTERSECT and exclude sets UNION.
   * `isEmpty` contributes to the exclude side against the entities that DO hold
   * a value, because a "column is null" query would miss every entity that never
   * had a row — for a sparse custom field, nearly all of them.
   *
   * **The type-level facet gate is deliberately absent, pending a human
   * decision, not overlooked.** ISS-7213 asks that a field whose capability
   * facet is `none` be refused here, and TEXT is the only type that carries
   * `none`. But TEXT filtering ships and is covered end to end by the
   * `multi-facet semantics` cases in `custom-field-list.integration.test.ts`, so
   * enforcing it literally would withdraw a working capability — a product call,
   * not an implementation one. Nothing is unsafe meanwhile: the predicate is
   * dispatched on the server-resolved `fieldType`, never on caller-supplied
   * text, so no request can construct a facet shape the type does not have.
   */
  async resolveFilters(
    filters: CustomFieldFilter[],
    organizationId: string,
    entityType: CustomFieldEntityType = CustomFieldEntityType.Document,
    scopedPopulation?: ScopedPopulationReader
  ): Promise<Result<CustomFieldEntityIdConstraint, CustomFieldQueryRejection>> {
    let include: string[] | undefined;
    const exclude = new Set<string>();

    for (const filter of filters) {
      const described = await customFieldListService.describeField(
        filter.fieldId,
        organizationId,
        entityType
      );
      if (!described.ok) {
        return described;
      }
      if (!described.value.isSearchable) {
        return ResultHelpers.err(CustomFieldQueryRejection.NotFilterable);
      }
      const predicate = buildCustomFieldFacetPredicate(
        described.value.fieldType,
        filter
      );
      if (!predicate.ok) {
        return predicate;
      }
      const matched = await customFieldListService.findMatchingEntityIds(
        filter.fieldId,
        organizationId,
        entityType,
        predicate.value,
        scopedPopulation
      );
      if (!matched.ok) {
        return matched;
      }
      if (isExcludingFacet(filter)) {
        for (const id of matched.value) {
          exclude.add(id);
        }
        continue;
      }
      include =
        include === undefined
          ? matched.value
          : intersectIds(include, matched.value);
    }

    return await boundIdConstraint(include, exclude, scopedPopulation);
  },

  /**
   * Entity ids whose value row for `fieldId` satisfies `predicate`, or the
   * reason the facet is too broad to answer.
   *
   * `@@unique([customFieldId, entityType, entityId])` guarantees at most one row
   * per (field, entity), so this projection is already distinct — no entity can
   * appear twice and inflate a downstream count.
   *
   * Reads ONE row past the cap to tell "exactly at the cap" from "over it", and
   * refuses rather than truncating. Truncating would be the worse failure: the
   * page AND the total would both be computed from a silently shortened id set,
   * so the endpoint would report a confident total for a population it never
   * actually matched — the exact defect the entity-id design exists to prevent.
   */
  async findMatchingEntityIds(
    fieldId: string,
    organizationId: string,
    entityType: CustomFieldEntityType,
    predicate: Record<string, unknown>,
    scopedPopulation?: ScopedPopulationReader
  ): Promise<Result<string[], CustomFieldQueryRejection>> {
    const facetWhere = {
      organizationId,
      entityType,
      customFieldId: fieldId,
      ...predicate,
    };
    const rows = await withDb((db) =>
      db.customFieldValue.findMany({
        where: facetWhere,
        select: { entityId: true },
        take: CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES + 1,
      })
    );
    if (rows.length <= CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES) {
      return ResultHelpers.ok(rows.map((row) => row.entityId));
    }
    // Broad ORG-WIDE is not broad AS ASKED. Re-read the facet against just the
    // population the request describes before refusing it, so a popular value
    // stops rejecting a five-row project query (whitlockk). Only this path pays for
    // the scoped read, so a facet already inside the bound is unaffected.
    if (!scopedPopulation) {
      return ResultHelpers.err(CustomFieldQueryRejection.FilterTooBroad);
    }
    const scoped = await scopedPopulation.ids();
    if (!scoped.ok) {
      return scoped;
    }
    if (scoped.value.length === 0) {
      return ResultHelpers.ok([]);
    }
    const scopedRows = await withDb((db) =>
      db.customFieldValue.findMany({
        where: { ...facetWhere, entityId: { in: scoped.value } },
        select: { entityId: true },
      })
    );
    return ResultHelpers.ok(scopedRows.map((row) => row.entityId));
  },

  /**
   * Order an already-filtered set of artifact ids by a custom field, and page it.
   *
   * The ONLY raw SQL in the feature, because Prisma cannot order by a column of a
   * polymorphic table nor reach an ENUM option's `sort_order`. The population is
   * decided entirely by the Prisma predicate that produced `candidateIds`, so
   * there is no SQL twin of the built-in filters to drift from them.
   *
   * **The joins cannot multiply rows.** `custom_field_values` is UNIQUE on
   * (custom_field_id, entity_type, entity_id) and all three are pinned here, so
   * at most one value row joins each artifact however many other fields it
   * carries; the options join is on a primary key. Both are LEFT joins so an
   * artifact with no value still appears, sorted into the NULL group.
   *
   * **Org-scoped in its own right.** `candidateIds` and `field` were both
   * resolved from org-scoped reads, so the scoping is already correct — but this
   * read states it anyway, on both tables, because `apps/api/AGENTS.md` requires
   * org scoping AT every DB layer rather than inherited from a caller. Raw SQL is
   * exactly where an inherited-only guarantee stops being checkable.
   */
  async orderIdsByCustomField(
    candidateIds: string[],
    field: CustomFieldQueryDescriptor,
    sort: CustomFieldSort,
    entityType: CustomFieldEntityType,
    organizationId: string,
    take: number | undefined,
    skip: number
  ): Promise<string[]> {
    if (candidateIds.length === 0) {
      return [];
    }
    const direction = Prisma.raw(resolveSortKeyword(sort.direction));
    // Safe as raw: both operands come from closed sets in this module, never
    // from request text — `resolveSortKeyword` returns only ASC/DESC and the
    // null placement is a module constant.
    const nulls = Prisma.raw(CUSTOM_FIELD_SORT_NULLS);
    const sortExpression = buildSortExpression(field.fieldType);
    const customFieldOrdering =
      sortExpression === null
        ? Prisma.empty
        : Prisma.sql`${sortExpression} ${direction} NULLS ${nulls},`;
    const rows = await withDb((db) =>
      db.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT a.id
          FROM artifacts a
          LEFT JOIN custom_field_values v
            ON v.entity_id = a.id
           AND v.entity_type = ${entityType}::"CustomFieldEntityType"
           AND v.custom_field_id = ${field.id}::uuid
           AND v.organization_id = ${organizationId}::uuid
          LEFT JOIN custom_field_enum_options o
            ON o.id = v.enum_value_id
         WHERE a.id = ANY(${candidateIds}::uuid[])
           AND a.organization_id = ${organizationId}::uuid
         ORDER BY ${customFieldOrdering}
                  a.created_at DESC,
                  a.id DESC
         ${take === undefined ? Prisma.empty : Prisma.sql`LIMIT ${take}`}
         OFFSET ${skip}
      `)
    );
    return rows.map((row) => row.id);
  },
};

/**
 * Ids present in both lists. Set-backed so intersecting N facets stays linear —
 * these lists are the size of an org's artifact count, not of a page.
 */
function intersectIds(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((id) => rightSet.has(id));
}

/**
 * Turn the resolved facet sets into a constraint that fits in ONE statement.
 *
 * The per-facet bound alone never did. `isEmpty` facets UNION, so two disjoint
 * ones each inside the 20000 bound presented 40000 bound parameters and blew
 * Prisma's 32767 ceiling — an opaque driver error, not a stated refusal (whitlockk
 * and tamsinb, independently; measured in
 * `custom-field-list-bounds.integration.test.ts`).
 *
 * Two shapes come out of here, and the first is why the aggregate is usually a
 * non-question:
 *
 * 1. **A keep-set exists.** Then exclusion is a set DIFFERENCE taken here, in
 *    Node, against a list the per-facet bound already sized. The constraint
 *    reaching Prisma is a single `in` of at most that many ids and NEVER a
 *    `notIn`, however many `isEmpty` facets the request carried.
 * 2. **Only `isEmpty` facets.** There is no keep-set to subtract from, so the
 *    union really must travel as `notIn` — and it is bounded here. Over the
 *    bound, the union is re-expressed as the KEPT ids within the scoped
 *    population, which turns an unanswerable request into an answerable one
 *    whenever the caller's own project/type/recency narrowing made it small.
 *    Only when that population is itself over the bound is the request refused,
 *    and then the refusal's guidance is followable.
 */
async function boundIdConstraint(
  include: string[] | undefined,
  exclude: Set<string>,
  scopedPopulation: ScopedPopulationReader | undefined
): Promise<Result<CustomFieldEntityIdConstraint, CustomFieldQueryRejection>> {
  if (include !== undefined) {
    return ResultHelpers.ok({
      include:
        exclude.size === 0 ? include : include.filter((id) => !exclude.has(id)),
      exclude: [],
    });
  }
  if (exclude.size <= CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES) {
    return ResultHelpers.ok({ include, exclude: [...exclude] });
  }
  if (!scopedPopulation) {
    return ResultHelpers.err(CustomFieldQueryRejection.FilterTooBroad);
  }
  const scoped = await scopedPopulation.ids();
  if (!scoped.ok) {
    return scoped;
  }
  return ResultHelpers.ok({
    include: scoped.value.filter((id) => !exclude.has(id)),
    exclude: [],
  });
}

/**
 * The ORDER BY expression for a field of this type.
 *
 * A string source is wrapped in `NULLIF(…, '')` so the write path's OTHER
 * spelling of "no value" folds into the one `NULLS LAST` actually orders — see
 * {@link sortSourceCarriesEmptyString}. Without it an ascending sort leads with
 * every blank cell, which is precisely the rows a reader expects last.
 */
function buildSortExpression(fieldType: CustomFieldType): Prisma.Sql | null {
  const source = resolveCustomFieldSortSource(fieldType);
  // A type with no sort source contributes no ORDER BY term; `resolveSort`
  // already refused the request, so this is the belt to that gate's braces
  // rather than a second, quieter way to serve an unsortable field.
  if (source === null) {
    return null;
  }
  const column = SORT_COLUMN_BY_SOURCE[source]();
  if (sortSourceCarriesEmptyString(source)) {
    return Prisma.sql`NULLIF(${column}, '')`;
  }
  return column;
}

/**
 * The physical column each sort source reads. Exhaustive `Record` for the same
 * reason as its siblings in `custom-field-list-query.ts`: a new
 * {@link CustomFieldSortSource} must fail `tsc` here rather than fall through to
 * a column that would order it wrongly.
 *
 * The `NULLIF` wrapper is applied by {@link buildSortExpression} from
 * {@link sortSourceCarriesEmptyString}, not spelled into the entries, so which
 * sources need it is decided in exactly one place.
 *
 * The entries are THUNKS rather than values because `Prisma.sql` would otherwise
 * run at module load: this module is imported transitively by suites that mock
 * `@repo/database` without a `Prisma` export, and an eager table would crash
 * them on import rather than when a sort is actually built.
 */
const SORT_COLUMN_BY_SOURCE: Record<CustomFieldSortSource, () => Prisma.Sql> = {
  [CustomFieldSortSource.TextValue]: () => Prisma.sql`v.text_value`,
  [CustomFieldSortSource.NumberValue]: () => Prisma.sql`v.number_value`,
  [CustomFieldSortSource.DateValue]: () => Prisma.sql`v.date_value`,
  [CustomFieldSortSource.EnumOptionSortOrder]: () => Prisma.sql`o.sort_order`,
  [CustomFieldSortSource.DisplayValue]: () => Prisma.sql`v.display_value`,
};
