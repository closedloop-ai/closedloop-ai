import {
  type ArtifactCollaboratorEntry,
  CollaboratorArtifactType,
} from "@repo/api/src/types/artifact-collaborators";
import type { BranchRow } from "./branch-row";

/** Preserve canonical branch people and fill only a measured direct-artifact count. */
export function branchRowsWithArtifactInteractions(
  rows: readonly BranchRow[],
  entries: ReadonlyMap<string, ArtifactCollaboratorEntry> | undefined
): BranchRow[] {
  return rows.map((row) => {
    const entry = entries?.get(row.id);
    if (
      entry?.artifactType !== CollaboratorArtifactType.Branch ||
      entry.commentCount === undefined
    ) {
      return row;
    }
    return { ...row, commentCount: entry.commentCount };
  });
}
