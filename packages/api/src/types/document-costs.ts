import { z } from "zod";
import {
  DOCUMENT_LIST_MAX_RECENCY_DAYS,
  DOCUMENT_LIST_MAX_SEARCH_LENGTH,
  DOCUMENT_LIST_MIN_RECENCY_DAYS,
  DocumentStatus,
  DocumentType,
  DocumentTypeInput,
  IssueStatus,
  normalizeDocumentType,
} from "./document";
import { DOCUMENT_METRIC_TREND_DAYS } from "./document-list-summary.ts";
import {
  customFieldFilterSetSchema,
  documentMetricScopeIdsSchema,
} from "./document-metric-scope.ts";

/** Clients batch complete selections; this bounds each statement, not the list. */
export const DOCUMENT_COST_BATCH_SIZE = 500;

export const documentCostWindowSchema = z.object({
  startDate: z.iso.datetime().optional(),
  endDate: z.iso.datetime().optional(),
});
export type DocumentCostWindow = z.infer<typeof documentCostWindowSchema>;

export const documentCostScopeSchema = z
  .object({
    artifactIds: z.array(z.uuid()).max(DOCUMENT_COST_BATCH_SIZE).optional(),
    types: z
      .array(
        z.enum([
          DocumentType.Doc,
          DocumentType.Prd,
          DocumentType.ImplementationPlan,
          DocumentType.Feature,
          DocumentTypeInput.Issue,
        ])
      )
      .min(1)
      .max(5)
      .transform((types) => [...new Set(types.map(normalizeDocumentType))])
      .optional(),
    search: z.string().max(DOCUMENT_LIST_MAX_SEARCH_LENGTH).optional(),
    assigneeId: z.string().optional(),
    status: z.array(z.enum({ ...DocumentStatus, ...IssueStatus })).optional(),
    recencyDays: z
      .number()
      .min(DOCUMENT_LIST_MIN_RECENCY_DAYS)
      .max(DOCUMENT_LIST_MAX_RECENCY_DAYS)
      .optional(),
    // ISS-12600: the listing filters that otherwise forced a loaded-id cohort.
    assigneeIds: documentMetricScopeIdsSchema.optional(),
    includeUnassigned: z.boolean().optional(),
    tagIds: documentMetricScopeIdsSchema.optional(),
    favoritesOnly: z.boolean().optional(),
    customFieldFilters: customFieldFilterSetSchema.optional(),
  })
  .strict();
export type DocumentCostScope = z.infer<typeof documentCostScopeSchema>;

export const documentCostsRequestSchema = documentCostWindowSchema
  .extend({
    artifactIds: z.array(z.uuid()).max(DOCUMENT_COST_BATCH_SIZE),
    scope: documentCostScopeSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      !(value.startDate && value.endDate) ||
      Date.parse(value.startDate) < Date.parse(value.endDate),
    { message: "startDate must precede endDate" }
  );
export type DocumentCostsRequest = z.infer<typeof documentCostsRequestSchema>;

export const documentCostTrendlineSchema = z
  .array(z.number().finite().nonnegative().nullable())
  .length(DOCUMENT_METRIC_TREND_DAYS);

/**
 * How much of a document population a cost aggregate covers (ISS-12598). A
 * document is measured only when every linked session's cost is measured;
 * `documentCount` is the population denominator.
 */
export const documentCostCoverageSchema = z
  .object({
    documentCount: z.number().int().nonnegative(),
    measuredDocumentCount: z.number().int().nonnegative(),
    unknownDocumentCount: z.number().int().nonnegative(),
  })
  .refine(
    (coverage) =>
      coverage.measuredDocumentCount + coverage.unknownDocumentCount ===
      coverage.documentCount,
    { message: "measured and unknown documents must partition the population" }
  );
export type DocumentCostCoverage = z.infer<typeof documentCostCoverageSchema>;

export const documentCostTrendlinesSchema = z.object({
  startDate: z.iso.datetime(),
  endDate: z.iso.datetime(),
  /** Per day: full-population spend; null unless every document is measured. */
  totalEstimatedCost: documentCostTrendlineSchema,
  /** Per day: full-population median; null unless every document is measured. */
  medianEstimatedCost: documentCostTrendlineSchema,
  /**
   * Per day: distinct-session spend of the documents measured that day. The
   * array is always emitted by current servers; a day's value is non-null only
   * when that day's coverage is partial and some document is measured. Read
   * the covered documents from that day's `coverage`.
   */
  measuredSubsetTotalEstimatedCost: documentCostTrendlineSchema.optional(),
  /**
   * Per day: median over the documents measured that day, non-null under the
   * same condition; its denominator is that day's `measuredDocumentCount`.
   */
  measuredSubsetMedianEstimatedCost: documentCostTrendlineSchema.optional(),
  /** Per-day coverage, aligned with the series above. */
  coverage: z
    .array(documentCostCoverageSchema)
    .length(DOCUMENT_METRIC_TREND_DAYS)
    .optional(),
});

export const documentCostSchema = z.object({
  artifactId: z.uuid(),
  /** Daily attributed event spend; null is incomplete evidence. */
  trendline: documentCostTrendlineSchema.optional(),
  /** Omitted when event coverage or complete pricing is unavailable. */
  totalEstimatedCost: z.number().finite().nonnegative().optional(),
});
export type DocumentCost = z.infer<typeof documentCostSchema>;

export const documentCostsResponseSchema = z.object({
  artifacts: z.array(documentCostSchema),
  trendlines: documentCostTrendlinesSchema.optional(),
  /** Full-population spend; omitted unless every document is measured. */
  totalEstimatedCost: z.number().finite().nonnegative().optional(),
  /** Full-population median; omitted unless every document is measured. */
  medianEstimatedCost: z.number().finite().nonnegative().optional(),
  /**
   * Distinct-session spend of the measured documents, set only when coverage
   * is partial and some document is measured; `coverage` says which share of
   * the population it covers.
   */
  measuredSubsetTotalEstimatedCost: z
    .number()
    .finite()
    .nonnegative()
    .optional(),
  /** Median over the same measured subset, set only when coverage is partial. */
  measuredSubsetMedianEstimatedCost: z
    .number()
    .finite()
    .nonnegative()
    .optional(),
  /** Population coverage of the summary fields; set on scoped reads. */
  coverage: documentCostCoverageSchema.optional(),
  sessionCosts: z
    .array(
      z.object({
        sessionId: z.uuid(),
        trendline: documentCostTrendlineSchema.optional(),
        totalEstimatedCost: z.number().finite().nonnegative().optional(),
      })
    )
    .optional(),
});
export type DocumentCostsResponse = z.infer<typeof documentCostsResponseSchema>;
