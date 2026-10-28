import type { ProjectSummaryRow } from "@repo/app/projects/lib/project-summary-row"; // Cross-slice: project pages render the shipped project list (ISS-12938).
import type { GridInteractionArtifactListSurfaceProps } from "@repo/app/shared/components/generic-artifact-surface/preview/components/grid-interaction-artifact-list-surface";
import { creationConfigForKind } from "../components/specialized-artifact-list-config";
import {
  artifactsForProject,
  buildProjectSummaryMetrics,
  projectArtifactHref,
  projectSummaryMetricDefinitions,
} from "./project-artifacts";
import { projectArtifactHierarchySpec } from "./project-hierarchy-spec";
import { webMasterProjects } from "./project-model";

export type ProjectArtifactListFixture = Omit<
  Extract<
    GridInteractionArtifactListSurfaceProps,
    {
      hierarchy: NonNullable<
        GridInteractionArtifactListSurfaceProps["hierarchy"]
      >;
    }
  >,
  "addArtifactOpen" | "onAddArtifactOpenChange" | "onOpenArtifact"
>;

/** Builds the typed mock inputs shared by the preserved and focused review hosts. */
export function buildProjectArtifactListFixture(
  project: ProjectSummaryRow
): ProjectArtifactListFixture {
  return {
    artifacts: artifactsForProject(project),
    buildSummaryMetrics: (visibleArtifacts) =>
      buildProjectSummaryMetrics(project, visibleArtifacts),
    creationConfig: {
      ...creationConfigForKind("issues"),
      defaultProject: project.name,
    },
    defaultGroupBy: "status",
    hierarchy: projectArtifactHierarchySpec,
    inlineCreate: { enabled: true, label: "Add issue" },
    manualOrdering: true,
    onOpenArtifactHref: (artifact) => projectArtifactHref(project, artifact),
    openCreatedArtifactAfterCreate: false,
    projectMove: {
      currentProject: { id: project.id, label: project.name },
      destinations: webMasterProjects
        .filter((candidate) => candidate.id !== project.id)
        .map((candidate) => ({
          id: candidate.id,
          label: candidate.name,
        })),
    },
    selectionNoun: { plural: "artifacts", singular: "artifact" },
    showAddArtifactButton: false,
    showBoardAddButton: false,
    showDateRangeControl: false,
    summaryMetricDefinitions: projectSummaryMetricDefinitions,
  };
}
