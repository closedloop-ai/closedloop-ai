import { parseNeighborhoodKey } from "@/app/documents/project-artifact-placement-helpers";
import type { PlacementPlan } from "@/app/documents/project-artifact-placement-persistence";
import {
  type PlacementRootFieldSnapshot,
  type PlacementState,
  siblingsFor,
} from "@/app/documents/project-artifact-placement-service-support";

/** A semantic no-op must not create a receipt or activity event. */
export function isUnchangedHierarchyPlacement(
  plan: PlacementPlan,
  current: PlacementState,
  rootFields: {
    before: PlacementRootFieldSnapshot[];
    after: PlacementRootFieldSnapshot[];
  } | null
): boolean {
  if (
    rootFields &&
    JSON.stringify(rootFields.before) !== JSON.stringify(rootFields.after)
  ) {
    return false;
  }
  for (const [key, orderedIds] of plan.rankOrders) {
    const [projectId, parentId] = parseNeighborhoodKey(key);
    if (
      JSON.stringify(siblingsFor(current, projectId, parentId)) !==
      JSON.stringify(orderedIds)
    ) {
      return false;
    }
  }
  return (
    plan.movedArtifactIds.every(
      (artifactId) =>
        current.artifactsById.get(artifactId)?.projectId ===
        plan.placement.destinationProjectId
    ) &&
    plan.sourceArtifactIds.every(
      (artifactId) =>
        (plan.currentParentIds.get(artifactId) ?? null) ===
        plan.destinationParentId
    )
  );
}
