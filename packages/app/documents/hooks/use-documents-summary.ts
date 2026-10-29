"use client";

import { documentTypeInputSchema } from "@repo/api/src/types/document";
import {
  DOCUMENT_METRIC_TREND_DAYS,
  type DocumentListSummary,
} from "@repo/api/src/types/document-list-summary";
import type { DocumentSummaryParams } from "@repo/api/src/types/document-metric-scope";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useApiClient } from "../../shared/api/use-api-client";
import { readDocumentSummaryWithSubtypeUnion } from "../lib/document-union-read";
import { documentKeys } from "./document-keys";

/**
 * ISS-8936 — the Documents index summary band's read.
 *
 * Takes the SAME `FindDocumentsOptions` the list readers take (plus ISS-12600's
 * owner, tag, favorite and custom-field scope) and serializes it
 * with the SAME {@link buildDocumentListSearchParams}, so the band and the table
 * narrow to one population by construction rather than by two call sites
 * agreeing. A filter spelled differently here would be the whole defect: a band
 * describing documents the list is not showing.
 *
 * Paging keys are deliberately absent from what a caller should pass — the
 * endpoint refuses them (`documentSummaryQueryValidator` is `.strict()`), because
 * a summary of one page is not a summary. Callers hand it the FILTERS and never
 * the window.
 *
 * `enabled` defers the request until the gate has resolved open, so a reader on
 * the closed default issues no request at all.
 */
export function useDocumentsSummary(
  searchParams: DocumentSummaryParams,
  options?: Omit<UseQueryOptions<DocumentListSummary>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: documentsSummaryQueryKey(searchParams),
    queryFn: () => {
      // PARSED, not cast. A version-skewed or regressed API can answer 2xx with a
      // field missing, non-numeric, or `NaN`; a bare generic would cache that
      // object as settled data and the band would state `undefined`/`NaN` as a
      // measurement instead of taking its implemented unavailable arm. A parse
      // failure throws, which is what puts the query in `isError` and the band in
      // that arm (review thread on #8000).
      return readDocumentSummaryWithSubtypeUnion(
        apiClient,
        searchParams,
        (body) => documentListSummarySchema.parse(body)
      );
    },
    ...options,
  });
}

/**
 * The cache key {@link useDocumentsSummary} registers for a filter set.
 *
 * Built on `documentKeys.summaries()`, which `invalidateArtifactCaches` names
 * alongside `documentKeys.lists()` — a created, deleted or updated document
 * changes these counts, and the summary prefix is a SIBLING of the list prefix
 * rather than a child, so it does not come along for free.
 *
 * A distinct prefix rather than reusing `documentKeys.list`: the two reads answer
 * different questions over the same filters, and sharing a key would have each
 * overwrite the other's payload.
 */
export function documentsSummaryQueryKey(
  searchParams: DocumentSummaryParams
): readonly unknown[] {
  return [...documentKeys.summaries(), searchParams] as const;
}

/**
 * The response shape, validated at the boundary.
 *
 * `.int().nonnegative()` on every count rather than a bare `number`, because the
 * whole impossible set is what reaches a column: a fraction, a negative, and a
 * non-finite all render as a confident measurement. `windowDays` is floored at 1
 * for the same reason its server-side owner floors it — a `0` there captions a
 * count over a window that cannot have been measured.
 *
 * The shape is held to `DocumentListSummary`'s own keys by
 * {@link documentListSummaryShape}, so a field added to that type fails `tsc`
 * here rather than arriving unvalidated.
 */
const documentListSummaryShape = {
  trendlines: z
    .object({
      startDate: z.iso.datetime(),
      endDate: z.iso.datetime(),
      total: z
        .array(z.number().int().nonnegative())
        .length(DOCUMENT_METRIC_TREND_DAYS),
      producedByAgentSessions: z
        .array(z.number().int().nonnegative())
        .length(DOCUMENT_METRIC_TREND_DAYS),
      updatedInWindow: z
        .array(z.number().int().nonnegative())
        .length(DOCUMENT_METRIC_TREND_DAYS),
    })
    .optional(),
  appliedArtifactIds: z.array(z.uuid()).optional(),
  appliedTypes: z.array(documentTypeInputSchema).optional(),
  total: z.number().int().nonnegative(),
  producedByAgentSessions: z.number().int().nonnegative(),
  updatedInWindow: z.number().int().nonnegative(),
  neverEdited: z.number().int().nonnegative(),
  windowDays: z.number().int().min(1),
} satisfies Record<keyof DocumentListSummary, z.ZodTypeAny>;

const documentListSummarySchema = z.object(documentListSummaryShape);
