"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { resolveCompletionDisplay } from "@repo/design-system/lib/completion-percentage";
import { ArtifactBar } from "../../artifacts/components/artifact-bar";
import { artifactMetricDefinitions } from "../../artifacts/components/artifact-list-model";
import { useDocumentsCosts } from "../../documents/hooks/use-documents-costs";
import { GenericArtifactKind } from "../../shared/components/generic-artifact-surface/generic-artifact-status";
import type { GenericArtifact } from "../../shared/components/generic-artifact-surface/preview/fixtures";
import { formatCostPreciseOrDash } from "../../shared/lib/format-utils";
import type { ProjectArtifactReadModel } from "../lib/project-artifact-read-model";
import {
  formatProjectCompletionSummary,
  PROJECT_COMPLETION_EMPTY_SUMMARY,
} from "../lib/project-constants";

const issuesMetrics = artifactMetricDefinitions(GenericArtifactKind.Issue);
export const PROJECT_ARTIFACT_METRICS = [
  {
    key: "project-completion",
    label: "Project completion",
    info: {
      what: "Project completion",
      how: "",
    },
  },
  {
    key: "artifact-count",
    label: "Artifacts",
    info: {
      what: "Artifacts currently included in this project view.",
      how: "Counted from project artifacts matching the active collection filters.",
    },
  },
  {
    ...issuesMetrics[1],
    key: "estimated-total-cost",
    label: "Est. total",
    info: {
      what: "Estimated total token cost for the current project view.",
      how: "Adds attributed creation and revision session costs for matching artifacts.",
    },
  },
  {
    ...issuesMetrics[2],
    key: "median-token-cost",
    label: "Median token cost",
    info: {
      what: "Typical token cost per matching project artifact.",
      how: "Uses the median attributed cost to reduce the effect of outliers.",
    },
  },
  { ...issuesMetrics[4], key: "metric-five" },
] as const;

export function ProjectArtifactSummary({
  project,
  model,
  matchingArtifacts,
  visibleMetricKeys,
  loading,
  failed,
}: {
  project: ProjectWithDetails;
  model: ProjectArtifactReadModel;
  matchingArtifacts: readonly GenericArtifact[];
  visibleMetricKeys: ReadonlySet<string>;
  loading: boolean;
  failed: boolean;
}) {
  const documentIds = matchingArtifacts
    .filter(
      (row) => model.artifactsById.get(row.id)?.type === ArtifactType.Document
    )
    .map((row) => row.id);
  const incomplete = Boolean(model.truncation) || loading || failed;
  const costsUnavailable =
    incomplete || documentIds.length !== matchingArtifacts.length;
  const costs = useDocumentsCosts(
    documentIds,
    {},
    {
      enabled:
        !costsUnavailable &&
        (visibleMetricKeys.has("estimated-total-cost") ||
          visibleMetricKeys.has("median-token-cost")),
    }
  );
  const values: Record<string, string | number | null> = {
    "project-completion": project.completionPopulationEmpty
      ? null
      : `${resolveCompletionDisplay(project.completionPercentage).percentage}%`,
    "artifact-count": incomplete ? null : matchingArtifacts.length,
    "estimated-total-cost": formatCostPreciseOrDash(
      costsUnavailable || costs.isError || costs.isLoading
        ? null
        : costs.data?.totalEstimatedCost
    ),
    "median-token-cost": formatCostPreciseOrDash(
      costsUnavailable || costs.isError || costs.isLoading
        ? null
        : costs.data?.medianEstimatedCost
    ),
    "metric-five": null,
  };
  return (
    <ArtifactBar
      metrics={PROJECT_ARTIFACT_METRICS.map((metric) => ({
        ...metric,
        ...(metric.key === "project-completion"
          ? {
              info: {
                ...metric.info,
                how: project.completionPopulationEmpty
                  ? PROJECT_COMPLETION_EMPTY_SUMMARY
                  : formatProjectCompletionSummary(
                      project.completionPercentage
                    ),
              },
            }
          : {}),
        value: values[metric.key] ?? null,
      }))}
      visibleMetricKeys={visibleMetricKeys}
    />
  );
}
