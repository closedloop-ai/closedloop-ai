import { ArtifactType } from "@repo/api/src/types/artifact";
import type { DetailedArtifact } from "@repo/api/src/types/project-tree";
import { getArtifactRoute } from "../../documents/lib/document-navigation";

/** Type-specific destinations stay owned by their established detail routes. */
export function projectArtifactRoute(
  artifact: DetailedArtifact
): string | null {
  if (artifact.type === ArtifactType.Document) {
    return getArtifactRoute(artifact);
  }
  if (artifact.type === ArtifactType.Branch) {
    return `/branches/${encodeURIComponent(artifact.id)}`;
  }
  if (artifact.type === ArtifactType.Session) {
    return `/sessions/${encodeURIComponent(artifact.id)}`;
  }
  return artifact.externalUrl;
}
