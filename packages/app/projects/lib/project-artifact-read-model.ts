import type { Artifact } from "@repo/api/src/types/artifact";
import type {
  ArtifactHierarchyState,
  DetailedArtifact,
  ExternalParentLink,
  ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";

/** Source records and relationships stay separate from the four-level viewport. */
export type ProjectArtifactReadModel = {
  artifactsById: ReadonlyMap<string, DetailedArtifact>;
  orderedArtifactIds: readonly string[];
  parentByArtifactId: ReadonlyMap<string, string>;
  parentContextByArtifactId: ReadonlyMap<string, readonly ExternalParentLink[]>;
  hierarchyByArtifactId: ReadonlyMap<string, ArtifactHierarchyState>;
  truncation: ProjectTreeDetailsResponse["truncation"];
};

/**
 * Keep the complete source graph. The shared hierarchy renderer limits visible
 * depth; pruning here would lose descendants during filtering and selection.
 */
export function projectArtifactReadModel(
  tree: ProjectTreeDetailsResponse | undefined
): ProjectArtifactReadModel {
  const artifactsById = new Map<string, DetailedArtifact>();
  const orderedArtifactIds: string[] = [];
  const parentByArtifactId = new Map<string, string>();
  const parentContextByArtifactId = new Map<string, ExternalParentLink[]>();
  const hierarchyByArtifactId = new Map<string, ArtifactHierarchyState>();
  const addArtifact = (artifact: DetailedArtifact) => {
    if (!artifactsById.has(artifact.id)) {
      artifactsById.set(artifact.id, artifact);
      orderedArtifactIds.push(artifact.id);
    }
  };
  for (const node of tree?.nodes ?? []) {
    addArtifact(node.root);
    if (node.hierarchy) {
      hierarchyByArtifactId.set(node.root.id, node.hierarchy);
    }
    for (const child of node.children) {
      addArtifact(child);
      parentByArtifactId.set(child.id, child.parentId);
      if (child.hierarchy) {
        hierarchyByArtifactId.set(child.id, child.hierarchy);
      }
    }
  }
  for (const link of [
    ...(tree?.externalParents ?? []),
    ...(tree?.flatParents ?? []),
  ]) {
    const existing = parentContextByArtifactId.get(link.childId) ?? [];
    parentContextByArtifactId.set(link.childId, [...existing, link]);
  }
  return {
    artifactsById,
    orderedArtifactIds,
    parentByArtifactId,
    parentContextByArtifactId,
    hierarchyByArtifactId,
    truncation: tree?.truncation,
  };
}

/** The metadata cohort is the visible page, never the whole project graph. */
export function visibleProjectArtifacts(
  model: ProjectArtifactReadModel,
  visibleArtifactIds: readonly string[]
): Artifact[] {
  return [...new Set(visibleArtifactIds)].flatMap((id) => {
    const artifact = model.artifactsById.get(id);
    return artifact ? [artifact] : [];
  });
}
