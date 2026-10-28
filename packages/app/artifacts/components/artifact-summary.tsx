"use client";

import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import type {
  DocumentWithProject,
  FindDocumentsOptions,
} from "@repo/api/src/types/document";
import type { DocumentListSummary } from "@repo/api/src/types/document-list-summary";
import type { DocumentsCosts } from "@repo/app/documents/hooks/use-documents-costs";
import {
  buildDocumentsSummaryCardsFromRows,
  DOCUMENTS_SUMMARY_PROVENANCE_ABSENT_DETAIL,
  DocumentsSummaryCardId,
} from "@repo/app/documents/lib/documents-summary-cards";
import type { ArtifactListShellController } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import { ArtifactKind } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { getStartIsoForDays } from "@repo/app/shared/lib/format-utils";
import { useMemo } from "react";
import { ArtifactBar } from "./artifact-bar";
import {
  ArtifactCostCardKey,
  ArtifactCostReadPhase,
  artifactCostCards,
  artifactCostWindowLine,
} from "./artifact-cost-cards";
import { artifactMetricDefinitions } from "./artifact-list-model";
import { artifactSummaryScope } from "./artifact-summary-scope";
import { useArtifactSummaryReads } from "./use-artifact-summary-reads";

export function ArtifactSummary({
  artifactKind = ArtifactKind.Document,
  controller,
  currentUserId,
  customFields,
  documents,
  complete,
  readLoading,
  readError,
  isUnsettled,
  filterText,
  searchParams,
}: {
  artifactKind?: typeof ArtifactKind.Document | typeof ArtifactKind.Issue;
  controller: ArtifactListShellController;
  currentUserId: string;
  /** Visible custom-field definitions, whose filters map to server facets. */
  customFields?: readonly CustomFieldWithOptions[];
  documents: readonly DocumentWithProject[];
  complete: boolean;
  readLoading: boolean;
  readError: boolean;
  isUnsettled: boolean;
  filterText: string;
  searchParams: FindDocumentsOptions;
}) {
  const documentIds = useMemo(
    () => documents.map((document) => document.id),
    [documents]
  );
  const { window, lookbackDays } = useCostWindow(controller.dateDimension);
  const requested = artifactSummaryScope(
    controller,
    currentUserId,
    filterText,
    searchParams,
    artifactKind,
    complete ? documentIds : undefined,
    customFields
  );
  const { scope, summary, costs } = useArtifactSummaryReads({
    scope: requested,
    searchParams,
    cohortIds: complete ? documentIds : undefined,
    documentIds,
    window,
    summaryEnabled: requested.canSummarize && !isUnsettled && !readLoading,
    costsEnabled:
      (complete || requested.canSummarize) &&
      !isUnsettled &&
      !readLoading &&
      !readError,
  });
  const fallback = buildDocumentsSummaryCardsFromRows({
    filterText: "",
    rows: documents,
  });
  const count =
    fallback.find((card) => card.id === DocumentsSummaryCardId.Total)?.value ??
    null;
  const updated =
    fallback.find((card) => card.id === DocumentsSummaryCardId.UpdatedInWindow)
      ?.value ?? null;
  const withheld = isUnsettled || readLoading || readError;
  const values: Record<string, number | null> = {
    documents: null,
    issues: null,
    "metric-four": null,
    "metric-five": null,
  };
  const costCards = artifactCostCards(
    artifactCostReadPhase({ isUnsettled, readLoading, readError, costs }),
    costs.data
  );
  const costWindowLine = artifactCostWindowLine(lookbackDays);
  if (!withheld) {
    if (complete) {
      values.documents = count;
      values["metric-five"] = updated;
    }
    if (
      scope.canSummarize &&
      summary.data &&
      !summary.isError &&
      !summary.isLoading
    ) {
      values.documents = summary.data.total;
      values["metric-four"] = summary.data.producedByAgentSessions;
      values["metric-five"] = summary.data.updatedInWindow;
    }
  }
  values.issues = values.documents;
  const trends = artifactMetricTrendlines(
    settledMetricRead(withheld, scope.canSummarize, summary),
    settledMetricRead(withheld, true, costs)
  );
  const metrics = artifactMetricDefinitions(artifactKind);
  return (
    <ArtifactBar
      metrics={metrics.map((metric) => {
        const base = { ...metric, sparkline: trends[metric.key] };
        if (isCostCardKey(metric.key)) {
          return {
            ...base,
            ...costCards[metric.key],
            // ISS-12599 decision 4: the cost-event window, in the info text.
            info: {
              what: metric.info.what,
              how: [metric.info.how, costWindowLine].filter(Boolean).join(" "),
            },
          };
        }
        return {
          ...base,
          detail:
            metric.key === "metric-four" && !scope.canSummarize
              ? DOCUMENTS_SUMMARY_PROVENANCE_ABSENT_DETAIL
              : undefined,
          value: values[metric.key] ?? null,
        };
      })}
      visibleMetricKeys={controller.visibleMetricKeys}
    />
  );
}

export function artifactMetricTrendlines(
  summary?: DocumentListSummary,
  costs?: DocumentsCosts
): Record<string, readonly (number | null)[] | undefined> {
  return {
    documents: summary?.trendlines?.total,
    issues: summary?.trendlines?.total,
    "total-cost": costs?.trendlines?.totalEstimatedCost,
    "median-cost": costs?.trendlines?.medianEstimatedCost,
    "metric-four": summary?.trendlines?.producedByAgentSessions,
    "metric-five": summary?.trendlines?.updatedInWindow,
  };
}

function settledMetricRead<T>(
  withheld: boolean,
  enabled: boolean,
  read: { data?: T; isError: boolean; isLoading: boolean }
): T | undefined {
  return !withheld && enabled && !read.isError && !read.isLoading
    ? read.data
    : undefined;
}

/** The token-incurrence window the cost cards read, from the date dimension. */
function useCostWindow(
  dateDimension: ArtifactListShellController["dateDimension"]
) {
  const costRange = dateDimension.present ? dateDimension.range : "all";
  const lookbackDays =
    costRange === "all" ? undefined : Number(costRange.slice(0, -1));
  const window = useMemo(() => {
    const startDate = getStartIsoForDays(lookbackDays);
    return startDate ? { startDate } : {};
  }, [lookbackDays]);
  return { window, lookbackDays };
}

function isCostCardKey(key: string): key is ArtifactCostCardKey {
  return COST_CARD_KEYS.has(key);
}

const COST_CARD_KEYS: ReadonlySet<string> = new Set(
  Object.values(ArtifactCostCardKey)
);

/**
 * A pending listing read is loading; a failed listing read, or a cost read
 * that failed with nothing cached, is failed.
 * A disabled cost read is neither and settles with no data (the dash).
 */
function artifactCostReadPhase({
  isUnsettled,
  readLoading,
  readError,
  costs,
}: {
  isUnsettled: boolean;
  readLoading: boolean;
  readError: boolean;
  costs: { data?: unknown; isLoading: boolean; isError: boolean };
}): ArtifactCostReadPhase {
  if (isUnsettled || readLoading) {
    return ArtifactCostReadPhase.Loading;
  }
  // A failed background refetch keeps the last good figures TanStack holds.
  if (readError || (costs.isError && costs.data === undefined)) {
    return ArtifactCostReadPhase.Failed;
  }
  return costs.isLoading
    ? ArtifactCostReadPhase.Loading
    : ArtifactCostReadPhase.Settled;
}
