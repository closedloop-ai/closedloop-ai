import { LinkType } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { DocumentStatus } from "@repo/api/src/types/document";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import {
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { generateSlug } from "@/app/documents/document-utils";
import { projectArtifactPlacementService } from "@/app/documents/project-artifact-placement-service";

/** A two-project tenant with one Document root and its Document child. */
export type Tenant = {
  organizationId: string;
  sourceProjectId: string;
  destinationProjectId: string;
  userId: string;
  rootId: string;
  childId: string;
};

export async function seedTenant(organizations: {
  create: () => Promise<string>;
}): Promise<Tenant> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const sourceProjectId = await createTestProject(organizationId, user.id, {
    name: "Placement Source",
  });
  const destinationProjectId = await createTestProject(
    organizationId,
    user.id,
    { name: "Placement Destination" }
  );
  const rootId = await createArtifact(
    organizationId,
    user.id,
    sourceProjectId,
    "Placement Root",
    0
  );
  const childId = await createArtifact(
    organizationId,
    user.id,
    sourceProjectId,
    "Placement Child",
    1024
  );
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId: rootId,
        targetId: childId,
        linkType: LinkType.Produces,
        sortOrder: 1024,
      },
    })
  );
  return {
    organizationId,
    sourceProjectId,
    destinationProjectId,
    userId: user.id,
    rootId,
    childId,
  };
}

export async function createArtifact(
  organizationId: string,
  createdById: string,
  projectId: string,
  name: string,
  sortOrder: number
): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        createdById,
        projectId,
        name,
        slug: generateSlug(),
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.PRD,
        status: DocumentStatus.Draft,
        sortOrder,
      },
      select: { id: true },
    })
  );
  return artifact.id;
}

export async function createLineageArtifact(
  organizationId: string,
  createdById: string,
  projectId: string,
  type: typeof ArtifactType.BRANCH | typeof ArtifactType.SESSION
): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        createdById,
        projectId,
        name: `Placement ${type} parent`,
        slug: generateSlug(),
        type,
        status:
          type === ArtifactType.BRANCH
            ? BranchStatus.Open
            : SESSION_STATUS.ACTIVE,
      },
      select: { id: true },
    })
  );
  return artifact.id;
}

export async function versions(
  tenant: Tenant
): Promise<Record<string, string>> {
  const actor = { userId: tenant.userId, authMethod: "session" as const };
  const source = await projectArtifactPlacementService.getProjectPlacementState(
    tenant.sourceProjectId,
    tenant.organizationId,
    actor
  );
  const destination =
    await projectArtifactPlacementService.getProjectPlacementState(
      tenant.destinationProjectId,
      tenant.organizationId,
      actor
    );
  if (!(source && destination)) {
    throw new Error("expected project versions");
  }
  return {
    [tenant.sourceProjectId]: source.projectVersion,
    [tenant.destinationProjectId]: destination.projectVersion,
  };
}
