import {
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";

/** One project issue row, for real-database hierarchy suites. */
export function createDbIssue(input: {
  organizationId: string;
  projectId: string;
  name: string;
  status: string;
  sortOrder: number;
}): Promise<{ id: string }> {
  return withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        type: ArtifactType.Document,
        subtype: ArtifactSubtype.Feature,
        name: input.name,
        status: input.status,
        sortOrder: input.sortOrder,
      },
      select: { id: true },
    })
  );
}

/** One PRODUCES link making `targetId` a child of `sourceId`. */
export function createDbProducesLink(
  organizationId: string,
  sourceId: string,
  targetId: string
): Promise<{ id: string }> {
  return withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId,
        targetId,
        linkType: LinkType.Produces,
      },
      select: { id: true },
    })
  );
}
