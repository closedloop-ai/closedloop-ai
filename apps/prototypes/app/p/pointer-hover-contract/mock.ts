import type { GenericArtifact } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { buildProjectArtifactListFixture } from "@repo/app/shell/v2/components/web-master-preview/projects/project-artifact-list-fixture";
import { projectArtifactHref } from "@repo/app/shell/v2/components/web-master-preview/projects/project-artifacts";
import { findProject } from "@repo/app/shell/v2/components/web-master-preview/projects/project-model";

const project = requirePointerHoverContractProject();

export const pointerHoverContractSurfaceFixture =
  buildProjectArtifactListFixture(project);

/** Preserves the project-detail destination used by the source prototype. */
export function pointerHoverContractArtifactHref(
  artifact: GenericArtifact
): string {
  return projectArtifactHref(project, artifact);
}

function requirePointerHoverContractProject() {
  const fixtureProject = findProject("sprint-0810");
  if (!fixtureProject) {
    throw new Error("The pointer-hover review fixture requires sprint-0810");
  }
  return fixtureProject;
}
