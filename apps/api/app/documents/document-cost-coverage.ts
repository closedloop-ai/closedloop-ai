import type { DocumentCostCoverage } from "@repo/api/src/types/document-costs";
import {
  DOCUMENT_METRIC_TREND_DAYS,
  documentMetricTrendStart,
} from "@repo/api/src/types/document-list-summary";
import { median } from "@repo/api/src/utils/math";

/** Linked sessions per document, in population order. */
export type DocumentCostPopulation = {
  artifactIds: string[];
  sessionsByArtifact: Map<string, Set<string>>;
};

/** `reason` on the "[document-cost] Invalid token-event cost" log event. */
export const InvalidCostEvidenceReason = {
  WindowCost: "window_cost",
  NegativeTokenCounter: "negative_token_counter",
} as const;
export type InvalidCostEvidenceReason =
  (typeof InvalidCostEvidenceReason)[keyof typeof InvalidCostEvidenceReason];

type CostLookup = (id: string) => number | null | undefined;

export type DocumentCostCoverageSummary = {
  coverage: DocumentCostCoverage;
  /** Legacy all-or-nothing total: set only when every document is measured. */
  total: number | null;
  /** Legacy all-or-nothing median: set only when every document is measured. */
  median: number | null;
  /** Set only when coverage is partial and some document is measured (ISS-12598). */
  measuredSubsetTotal: number | null;
  measuredSubsetMedian: number | null;
};

/**
 * Summarizes a population from folded per-document costs. A document is
 * measured only when every linked session is measured; the subset total is the
 * distinct-session sum over measured documents, so a shared session counts once.
 */
export function summarizeCostCoverage(
  population: DocumentCostPopulation,
  documentCost: CostLookup,
  sessionCost: CostLookup
): DocumentCostCoverageSummary {
  const measuredCosts: number[] = [];
  const measuredSessions = new Set<string>();
  for (const artifactId of population.artifactIds) {
    const cost = documentCost(artifactId);
    if (cost === null || cost === undefined) {
      continue;
    }
    measuredCosts.push(cost);
    for (const sessionId of population.sessionsByArtifact.get(artifactId) ??
      []) {
      measuredSessions.add(sessionId);
    }
  }
  const documentCount = population.artifactIds.length;
  const measuredDocumentCount = measuredCosts.length;
  const complete = measuredDocumentCount === documentCount;
  const partial = !complete && measuredDocumentCount > 0;
  // Every measured session belongs to a fully measured document, so this fold
  // is always defined; `?? null` only narrows the type.
  const measuredTotal =
    complete || partial
      ? (foldDocumentCost(measuredSessions, sessionCost) ?? null)
      : null;
  return {
    coverage: {
      documentCount,
      measuredDocumentCount,
      unknownDocumentCount: documentCount - measuredDocumentCount,
    },
    total: complete ? measuredTotal : null,
    median: complete ? median(measuredCosts) : null,
    measuredSubsetTotal: partial ? measuredTotal : null,
    measuredSubsetMedian: partial ? median(measuredCosts) : null,
  };
}

/** One document's cost; undefined unless every linked session is measured. */
export function foldDocumentCost(
  sessionIds: Iterable<string>,
  sessionCost: CostLookup
): number | undefined {
  let total = 0;
  for (const sessionId of sessionIds) {
    const cost = sessionCost(sessionId);
    if (cost === null || cost === undefined) {
      return;
    }
    total += cost;
  }
  return total;
}

/** One document's daily spend; a day is null unless every session is measured. */
export function foldDocumentTrendline(
  sessionIds: Iterable<string>,
  sessionTrends: Map<string, (number | null)[]>
): (number | null)[] {
  const sessions = [...sessionIds];
  return Array.from(
    { length: DOCUMENT_METRIC_TREND_DAYS },
    (_, day) =>
      foldDocumentCost(
        sessions,
        (sessionId) => sessionTrends.get(sessionId)?.[day]
      ) ?? null
  );
}

/** Applies the same measured-document rule to each sparkline day. */
export function aggregateCostTrendlines(
  now: Date,
  population: DocumentCostPopulation,
  sessionTrends: Map<string, (number | null)[]>,
  documentTrends: Map<string, (number | null)[]>
) {
  const days = Array.from({ length: DOCUMENT_METRIC_TREND_DAYS }, (_, day) =>
    summarizeCostCoverage(
      population,
      (artifactId) => documentTrends.get(artifactId)?.[day],
      (sessionId) => sessionTrends.get(sessionId)?.[day]
    )
  );
  return {
    startDate: documentMetricTrendStart(now).toISOString(),
    endDate: now.toISOString(),
    totalEstimatedCost: days.map((day) => day.total),
    medianEstimatedCost: days.map((day) => day.median),
    measuredSubsetTotalEstimatedCost: days.map(
      (day) => day.measuredSubsetTotal
    ),
    measuredSubsetMedianEstimatedCost: days.map(
      (day) => day.measuredSubsetMedian
    ),
    coverage: days.map((day) => day.coverage),
  };
}
