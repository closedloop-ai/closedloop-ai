import type { CustomFieldQueryRejection } from "@repo/api/src/types/custom-field-list-query";
import {
  DocumentType,
  type FindDocumentsOptions,
} from "@repo/api/src/types/document";
import type { DocumentMetricScopeFilters } from "@repo/api/src/types/document-metric-scope";
import {
  type Result,
  Result as ResultHelpers,
} from "@repo/api/src/types/result";
import type { CustomFieldEntityIdConstraint } from "./custom-field-list-service";
import { resolveCustomFieldQueryContext } from "./custom-field-route-helpers";
import { createScopedPopulationReader } from "./custom-field-scoped-population";
import {
  buildDocumentListWhere,
  type DocumentListScopeConstraints,
} from "./document-list-query";

/**
 * ISS-12600: one Documents-index card scope as the metric endpoints receive it —
 * the list filters plus the owner, tag, favorite and custom-field filters that
 * used to force a loaded-row-id cohort.
 */
export type DocumentMetricScopeQuery = Omit<
  FindDocumentsOptions,
  "limit" | "offset"
> &
  DocumentMetricScopeFilters & { organizationId: string };

/** {@link DocumentMetricScopeQuery} resolved to `buildDocumentListWhere` input. */
export type DocumentMetricWhereOptions = Omit<
  DocumentMetricScopeQuery,
  "favoritesOnly" | "customFieldFilters"
> &
  Pick<DocumentListScopeConstraints, "favoritedByUserId"> & {
    customFieldEntityIds?: CustomFieldEntityIdConstraint;
  };

/**
 * Resolve a metric scope to the list predicate's input.
 *
 * Favorites are the CALLER's (`userId` comes from auth, never the wire), and a
 * custom-field facet resolves to entity ids through the same
 * `resolveCustomFieldQueryContext` the list read uses, bounded by the same
 * scoped population, so the cards and the list share one predicate. Run inside
 * the caller's snapshot when it has one; `withDb` joins it.
 */
export async function resolveDocumentMetricScope(
  query: DocumentMetricScopeQuery,
  userId: string,
  now: Date
): Promise<Result<DocumentMetricWhereOptions, CustomFieldQueryRejection>> {
  const base = documentMetricWhereBase(query, userId);
  const filters = query.customFieldFilters;
  if (!filters || filters.length === 0) {
    return ResultHelpers.ok(base);
  }
  const context = await resolveCustomFieldQueryContext(
    { customFieldFilters: filters },
    query.organizationId,
    (entityIds) =>
      createScopedPopulationReader(
        buildDocumentListWhere(
          { ...base, customFieldEntityIds: entityIds },
          now
        )
      )
  );
  if (!context.ok) {
    return context;
  }
  return ResultHelpers.ok({ ...base, ...context.value });
}

function documentMetricWhereBase(
  query: DocumentMetricScopeQuery,
  userId: string
): DocumentMetricWhereOptions {
  const { favoritesOnly, customFieldFilters: _fields, ...rest } = query;
  return favoritesOnly ? { ...rest, favoritedByUserId: userId } : rest;
}

/**
 * The subtypes a scoped cost read covers when the scope names none. Facet
 * resolution is bounded on this same population, so a facet within bound for
 * what costs read is not refused for subtypes costs never read.
 */
export const DOCUMENT_COST_DEFAULT_TYPES = [
  DocumentType.Prd,
  DocumentType.ImplementationPlan,
  DocumentType.Doc,
] as const;
