import { ArtifactType } from "@repo/api/src/types/artifact";
import type { ArtifactCollaboratorEntry } from "@repo/api/src/types/artifact-collaborators";
import type { CustomFieldFilter } from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import type { ArtifactListShellController } from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import type { ProjectArtifactReadModel } from "./project-artifact-read-model";

/** Unknown optional evidence cannot answer an active field filter. */
export function projectArtifactFilterEvidenceUnavailable(
  model: ProjectArtifactReadModel,
  ids: readonly string[],
  controller: Pick<
    ArtifactListShellController,
    "filters" | "extensionFilters" | "customFieldFilters"
  >,
  people: ReadonlyMap<string, ArtifactCollaboratorEntry>
) {
  const activeExtensions = new Set(
    Object.entries(controller.extensionFilters)
      .filter(([, filter]) => activeFilter(filter))
      .map(([id]) => id)
  );
  const customActive =
    Object.values(controller.customFieldFilters).some(activeFilter) ||
    [...activeExtensions].some((id) => id.startsWith("custom-"));
  return ids.some((id) => {
    const artifact = model.artifactsById.get(id);
    if (!artifact) {
      return true;
    }
    if (controller.filters.tags.length > 0 && artifact.tags === undefined) {
      return true;
    }
    if (
      activeExtensions.has("comments") &&
      people.get(id)?.commentCount === undefined
    ) {
      return true;
    }
    if (artifact.type !== ArtifactType.Document) {
      return false;
    }
    return (
      (activeExtensions.has("currentVersion") &&
        artifact.currentVersion === undefined) ||
      (customActive && artifact.customFieldValues === undefined)
    );
  });
}
function activeFilter(filter: CustomFieldFilter) {
  return (
    Boolean(filter.selectedValues?.length) ||
    filter.min !== undefined ||
    filter.max !== undefined
  );
}
