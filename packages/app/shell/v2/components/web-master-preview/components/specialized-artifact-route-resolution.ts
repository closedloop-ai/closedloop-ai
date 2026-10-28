import type { GenericArtifact } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import {
  findProjectArtifact,
  projectArtifactRouteSegment,
} from "../projects/project-artifacts";
import { artifactsForKind } from "./specialized-artifact-fixtures";
import type { SpecializedArtifactKind } from "./specialized-artifact-kinds";

/**
 * The artifact a specialized collection route should open for a route key.
 *
 * A project collection hands off to the artifact's own type route by slug, and
 * a project artifact is a project-scoped copy carrying a replacement lineage
 * identity that the destination's own fixture set does not contain. Resolving
 * the project fixture here is what makes that link land on the detail view
 * instead of dropping the reader back on the collection.
 */
export function resolveSpecializedArtifactForRoute({
  kind,
  projectId,
  routeKey,
}: {
  kind: SpecializedArtifactKind;
  projectId?: string | null;
  routeKey: string;
}): GenericArtifact | undefined {
  const ownFixture = findSpecializedArtifactFixture(kind, routeKey);
  if (ownFixture) {
    return ownFixture;
  }
  const projectArtifact = findProjectArtifact(projectId, routeKey);
  if (!projectArtifact) {
    return undefined;
  }
  // Only an artifact whose own kind routes to THIS collection resolves here, so
  // a key from another collection cannot render an Issue inside Documents.
  return projectArtifactRouteSegment(projectArtifact) === kind
    ? projectArtifact
    : undefined;
}

/** The artifact this collection's own fixture set holds under `routeKey`. */
export function findSpecializedArtifactFixture(
  kind: SpecializedArtifactKind,
  routeKey: string
): GenericArtifact | undefined {
  return artifactsForKind(kind).find(
    (artifact) => artifact.id === routeKey || artifact.slug === routeKey
  );
}
