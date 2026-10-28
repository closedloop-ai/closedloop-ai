"use client";

import {
  DOCUMENT_COST_BATCH_SIZE,
  type DocumentCost,
  type DocumentCostScope,
  type DocumentCostsResponse,
  type DocumentCostWindow,
  documentCostsResponseSchema,
} from "@repo/api/src/types/document-costs";
import { DOCUMENT_METRIC_TREND_DAYS } from "@repo/api/src/types/document-list-summary";
import { median } from "@repo/api/src/utils/math";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import { documentKeys } from "./document-keys";

/** Uses the caller's full filtered population; each request is bounded. */
export function useDocumentsCosts(
  artifactIds: readonly string[],
  window: DocumentCostWindow,
  options?: { enabled?: boolean },
  scope?: DocumentCostScope
) {
  const apiClient = useApiClient();
  const ids = [...new Set(scope?.artifactIds ?? artifactIds)].sort();
  return useQuery({
    queryKey: [
      ...documentKeys.summaries(),
      "costs",
      scope && scope.artifactIds === undefined ? [] : ids,
      window,
      scope,
    ],
    enabled: options?.enabled,
    queryFn: async (): Promise<DocumentsCosts> => {
      if (canReadCostScope(scope, ids.length)) {
        return documentCostsResponseSchema.parse(
          await apiClient.post<unknown>("/documents/costs", {
            artifactIds: [],
            scope,
            ...window,
          })
        );
      }
      const sessions = new Map<string, number | undefined>();
      const trendResponses: DocumentCostsResponse[] = [];
      let hasSessionCosts = true;
      const artifacts: DocumentCost[] = [];
      // Serial requests bound API/DB load without truncating a large selection.
      for (
        let offset = 0;
        offset < ids.length;
        offset += DOCUMENT_COST_BATCH_SIZE
      ) {
        const batch = ids.slice(offset, offset + DOCUMENT_COST_BATCH_SIZE);
        const response = documentCostsResponseSchema.parse(
          await apiClient.post<unknown>("/documents/costs", {
            artifactIds: scope ? [] : batch,
            ...(scope ? { scope: { ...scope, artifactIds: batch } } : {}),
            ...window,
          })
        );
        trendResponses.push(response);
        hasSessionCosts =
          collectSessionCosts(response, sessions) && hasSessionCosts;
        const received = new Map(
          response.artifacts.map((artifact) => [artifact.artifactId, artifact])
        );
        artifacts.push(
          ...batch.map(
            (artifactId) => received.get(artifactId) ?? { artifactId }
          )
        );
      }
      const singleSummary = singleResponseCostSummary(
        trendResponses,
        artifacts
      );
      if (singleSummary) {
        return singleSummary;
      }
      const result = {
        ...summarizeDocumentCosts(artifacts),
        ...mergeCostTrendlines(trendResponses, artifacts),
      };
      if (
        !hasSessionCosts ||
        [...sessions.values()].some((cost) => cost === undefined)
      ) {
        const { totalEstimatedCost: _total, ...unavailableTotal } = result;
        return unavailableTotal;
      }
      if (result.totalEstimatedCost !== undefined) {
        result.totalEstimatedCost = [...sessions.values()].reduce<number>(
          (sum, cost) => sum + (cost ?? 0),
          0
        );
      }
      return result;
    },
  });
}

export type DocumentsCosts = {
  artifacts: DocumentCost[];
} & Pick<
  DocumentCostsResponse,
  | "totalEstimatedCost"
  | "medianEstimatedCost"
  | "measuredSubsetTotalEstimatedCost"
  | "measuredSubsetMedianEstimatedCost"
  | "coverage"
  | "trendlines"
>;

export function summarizeDocumentCosts(
  artifacts: DocumentCost[]
): DocumentsCosts {
  const costs: number[] = [];
  for (const artifact of artifacts) {
    if (artifact.totalEstimatedCost === undefined) {
      return { artifacts };
    }
    costs.push(artifact.totalEstimatedCost);
  }
  return {
    artifacts,
    totalEstimatedCost: costs.reduce((total, cost) => total + cost, 0),
    ...(costs.length === 0
      ? {}
      : { medianEstimatedCost: median(costs) ?? undefined }),
  };
}

/** Deduplicate sessions across bounded reads, retaining per-artifact medians. */
function mergeCostTrendlines(
  responses: DocumentCostsResponse[],
  artifacts: DocumentCost[]
): Pick<DocumentsCosts, "trendlines"> {
  const first = responses[0]?.trendlines;
  if (first && responses.length === 1) {
    return { trendlines: first };
  }
  if (
    !first ||
    responses.some(
      (response) =>
        !response.trendlines ||
        response.trendlines.startDate !== first.startDate ||
        !response.sessionCosts
    )
  ) {
    return {};
  }
  const sessions = new Map<string, (number | null)[] | undefined>();
  for (const response of responses) {
    for (const session of response.sessionCosts ?? []) {
      sessions.set(session.sessionId, session.trendline);
    }
  }
  const lines = [...sessions.values()];
  return {
    trendlines: {
      startDate: first.startDate,
      endDate: responses.reduce(
        (end, response) =>
          response.trendlines && response.trendlines.endDate > end
            ? response.trendlines.endDate
            : end,
        first.endDate
      ),
      totalEstimatedCost: Array.from(
        { length: DOCUMENT_METRIC_TREND_DAYS },
        (_, day) => {
          if (
            artifacts.some((artifact) => artifact.trendline === undefined) ||
            lines.some((line) => !line || line[day] === null)
          ) {
            return null;
          }
          return lines.reduce((sum, line) => sum + (line?.[day] ?? 0), 0);
        }
      ),
      medianEstimatedCost: Array.from(
        { length: DOCUMENT_METRIC_TREND_DAYS },
        (_, day) => {
          const values = artifacts.map((artifact) => artifact.trendline?.[day]);
          if (values.some((value) => value === undefined || value === null)) {
            return null;
          }
          return median(
            values.filter((value): value is number => typeof value === "number")
          );
        }
      ),
    },
  };
}

function canReadCostScope(
  scope: DocumentCostScope | undefined,
  count: number
): boolean {
  return (
    scope !== undefined &&
    (scope.artifactIds === undefined || count <= DOCUMENT_COST_BATCH_SIZE)
  );
}

function collectSessionCosts(
  response: DocumentCostsResponse,
  sessions: Map<string, number | undefined>
) {
  if (!response.sessionCosts) {
    return false;
  }
  for (const session of response.sessionCosts) {
    sessions.set(session.sessionId, session.totalEstimatedCost);
  }
  return true;
}

/**
 * One server response already summarizes the exact cohort without a client
 * union. A response carrying only trendlines (an unscoped batch read) has not
 * summarized it, so the caller derives totals and attaches the trendlines.
 */
function singleResponseCostSummary(
  responses: readonly DocumentCostsResponse[],
  artifacts: DocumentCost[]
): DocumentsCosts | undefined {
  if (responses.length !== 1) {
    return undefined;
  }
  const response = responses[0];
  if (
    response.totalEstimatedCost === undefined &&
    response.medianEstimatedCost === undefined
  ) {
    return undefined;
  }
  return {
    artifacts,
    ...(response.totalEstimatedCost === undefined
      ? {}
      : { totalEstimatedCost: response.totalEstimatedCost }),
    ...(response.medianEstimatedCost === undefined
      ? {}
      : { medianEstimatedCost: response.medianEstimatedCost }),
    ...(response.trendlines === undefined
      ? {}
      : { trendlines: response.trendlines }),
  };
}
