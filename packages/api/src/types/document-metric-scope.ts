import { z } from "zod";
import {
  CUSTOM_FIELD_FILTER_MAX_FACETS,
  CUSTOM_FIELD_FILTER_MAX_VALUES,
  type CustomFieldFilter,
  CustomFieldFilterOperator,
} from "./custom-field-list-query.ts";
import type { FindDocumentsOptions } from "./document.ts";

/**
 * ISS-12600: the listing filters the Documents index applies beside the
 * `FindDocumentsOptions` vocabulary, spelled so `GET /documents/summary` and
 * `POST /documents/costs` can compute every card over the full filtered
 * population instead of over loaded row ids.
 *
 * Accepted only by those two metric endpoints. `GET /documents` and the batch
 * selection descriptor do not honor them, so they are deliberately absent from
 * the list filter shape (`apps/api` rejects a filter a route cannot honor).
 */
export type DocumentMetricScopeFilters = {
  /** Any-of owner ids; OR-ed with {@link includeUnassigned}. */
  assigneeIds?: string[];
  /** Also match artifacts with no owner (the list's Unassigned facet). */
  includeUnassigned?: boolean;
  /** Any-of tag ids. */
  tagIds?: string[];
  /** Only the requesting user's favorites; the server supplies the user. */
  favoritesOnly?: boolean;
  /** The list query's own custom-field facet vocabulary (ISS-7211). */
  customFieldFilters?: CustomFieldFilter[];
};

/** The summary read's parameters: the list filters plus the metric scope. */
export type DocumentSummaryParams = FindDocumentsOptions &
  DocumentMetricScopeFilters;

/** Bounds each repeated id filter so its `IN` list stays a bounded bind set. */
export const DOCUMENT_METRIC_SCOPE_MAX_IDS = 500;

/**
 * One custom-field facet (ISS-7211). `values` is deliberately not required here:
 * it is required only for `isAnyOf`, and that dependency is enforced where the
 * field's TYPE is known and the operand is parsed
 * (`buildCustomFieldFacetPredicate`). Encoding it twice would let them disagree.
 */
export const customFieldFilterSchema = z
  .object({
    fieldId: z.uuid(),
    operator: z.enum([
      CustomFieldFilterOperator.IsAnyOf,
      CustomFieldFilterOperator.IsEmpty,
      CustomFieldFilterOperator.IsNotEmpty,
    ]),
    values: z.array(z.string()).max(CUSTOM_FIELD_FILTER_MAX_VALUES).optional(),
  })
  .strict();

/** The facet set, capped so one list call cannot fan out into many reads. */
export const customFieldFilterSetSchema = z
  .array(customFieldFilterSchema)
  .max(CUSTOM_FIELD_FILTER_MAX_FACETS);

/** A repeated id filter: present means at least one, never an unbounded set. */
export const documentMetricScopeIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(DOCUMENT_METRIC_SCOPE_MAX_IDS);

/**
 * The longest summary query string the client sends. A scope that would
 * serialize past it reads the complete-cohort ids instead, well inside the
 * 8 KB request-line limit common to proxies and servers.
 */
export const DOCUMENT_SUMMARY_MAX_QUERY_LENGTH = 6000;
