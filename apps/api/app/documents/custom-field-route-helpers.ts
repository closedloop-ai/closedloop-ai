import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  type CustomFieldFilter,
  type CustomFieldQueryRejection,
  CustomFieldSortDirection,
} from "@repo/api/src/types/custom-field-list-query";
import {
  type Result,
  Result as ResultHelpers,
} from "@repo/api/src/types/result";
import { customFieldListService } from "./custom-field-list-service";
import type { DocumentListCustomFieldContext } from "./custom-field-ordered-read";
import type { ScopedPopulationFactory } from "./custom-field-scoped-population";

/**
 * Boundary between the validated query string and the custom-field query context
 * the document-list services consume (ISS-7211). Kept out of `route.ts` so the
 * route stays a thin parse-auth-delegate handler, per `apps/api/AGENTS.md`.
 */

/** The validated slice of `findDocumentsQueryValidator` this helper reads. */
export type CustomFieldQueryParams = {
  customFieldSortId?: string;
  customFieldSortDir?: CustomFieldSortDirection;
  customFieldFilters?: CustomFieldFilter[];
};

/**
 * Resolve and AUTHORIZE the custom-field dimensions of a list query.
 *
 * The request supplies only a field id and a direction; whether that field
 * exists in this organization, applies to this entity type, and carries
 * `isSortable`/`isSearchable` is read from the database, never asserted by the
 * caller. Filters resolve first so a request wrong in both dimensions gets the
 * more specific refusal.
 */
export async function resolveCustomFieldQueryContext(
  params: CustomFieldQueryParams,
  organizationId: string,
  scopedPopulationFor?: ScopedPopulationFactory,
  entityType: CustomFieldEntityType = CustomFieldEntityType.Document
): Promise<Result<DocumentListCustomFieldContext, CustomFieldQueryRejection>> {
  const context: DocumentListCustomFieldContext = {};

  if (params.customFieldFilters && params.customFieldFilters.length > 0) {
    const filters = await customFieldListService.resolveFilters(
      params.customFieldFilters,
      organizationId,
      entityType,
      // No entity ids: this is the one read that CANNOT count the custom-field
      // narrowing, because that narrowing is what it is resolving. Built once
      // so the several reads inside `resolveFilters` share its memoized result.
      scopedPopulationFor?.()
    );
    if (!filters.ok) {
      return filters;
    }
    context.customFieldEntityIds = filters.value;
  }

  if (params.customFieldSortId) {
    const sort = {
      fieldId: params.customFieldSortId,
      // A sort with no stated direction ascends, matching the toolbar's first
      // click on a column header.
      direction: params.customFieldSortDir ?? CustomFieldSortDirection.Asc,
    };
    const resolved = await customFieldListService.resolveSort(
      sort,
      organizationId,
      entityType
    );
    if (!resolved.ok) {
      return resolved;
    }
    // The sort ADMISSION check, and the reason `findArtifactsOrderedByCustomField`
    // can bound its candidate scan. Ranking by a column Prisma cannot reach means
    // the whole population must be compared before a page exists, so a `limit=1`
    // request would otherwise scan the org (whitlockk). Refuse here, where the caller
    // gets a reason code and followable guidance, instead of scanning and hoping.
    //
    // **Measured on the population INCLUDING the filters resolved just above.**
    // Those ids are known by now, so folding them in is no longer circular — and
    // not folding them in re-created the very defect this feature fixed, one
    // scope over: a request that narrowed with a custom-field filter (to 50
    // entities, say) was still refused for an unfiltered population of 20001,
    // told to "narrow your request", having already narrowed. It is also the set
    // `findArtifactsOrderedByCustomField` actually scans, so the bound now
    // describes the read it guards rather than a superset of it.
    if (scopedPopulationFor) {
      const withinBound = await scopedPopulationFor(
        context.customFieldEntityIds
      ).ensureWithinBound();
      if (!withinBound.ok) {
        return withinBound;
      }
    }
    context.customFieldSort = { field: resolved.value, sort, entityType };
  }

  return ResultHelpers.ok(context);
}
