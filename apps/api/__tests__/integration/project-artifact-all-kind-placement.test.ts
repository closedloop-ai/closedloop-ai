import {
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
  ProjectArtifactPlacementVerificationStatus,
} from "@repo/api/src/types/project-artifact-placement";
import { ArtifactType } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLineageArtifact,
  seedTenant,
  versions,
} from "@/__tests__/support/integration/project-artifact-placement-tenant.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { placeProjectArtifactsWithLanePatch } from "@/app/artifacts/project-artifact-board-placement";
import { projectTreeService } from "@/app/artifacts/project-tree-service";
import { projectArtifactPlacementVerificationService } from "@/app/documents/project-artifact-placement-verification-service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizations = createCommittedTestOrganizationTracker();

/** ISS-12929 (725-F4): flag-on placement, its receipts and its fence cover every kind. */
describe.skipIf(!hasDatabase)("all-kind project placement (Postgres)", () => {
  afterEach(async () => {
    await organizations.cleanup();
  });

  it("ISS-12929 verifies an all-kind board placement beside a Branch root as consistent", async () => {
    const tenant = await seedTenant(organizations);
    const branchId = await createLineageArtifact(
      tenant.organizationId,
      tenant.userId,
      tenant.sourceProjectId,
      ArtifactType.BRANCH
    );
    const actor = { userId: tenant.userId, authMethod: "session" as const };
    const sourceVersions = await versions(tenant);
    const committed = await placeProjectArtifactsWithLanePatch(
      tenant.sourceProjectId,
      tenant.organizationId,
      {
        kind: ProjectArtifactPlacementKind.Place,
        sourceArtifactIds: [tenant.rootId],
        destinationProjectId: tenant.sourceProjectId,
        position: ProjectArtifactPlacementPosition.After,
        targetArtifactId: branchId,
        expectedProjectVersions: {
          [tenant.sourceProjectId]:
            sourceVersions[tenant.sourceProjectId] ?? "",
        },
        idempotencyKey: "all-kind-verification",
        source: ProjectArtifactPlacementSource.Pointer,
      },
      actor
    );
    if (!committed.ok) {
      throw new Error(committed.error.message);
    }

    const verification =
      await projectArtifactPlacementVerificationService.verifyProjectArtifactPlacement(
        {
          routeProjectId: tenant.sourceProjectId,
          organizationId: tenant.organizationId,
          transactionId: committed.value.transactionId,
          actor,
        }
      );
    expect(verification).toMatchObject({
      ok: true,
      value: {
        status: ProjectArtifactPlacementVerificationStatus.Consistent,
        driftedArtifactIds: [],
      },
    });
  });

  it("ISS-12929 reports the placement fence from the manually ordered tree read", async () => {
    const tenant = await seedTenant(organizations);
    await createLineageArtifact(
      tenant.organizationId,
      tenant.userId,
      tenant.sourceProjectId,
      ArtifactType.SESSION
    );
    const tree = await projectTreeService.getManuallyOrderedProjectTree(
      tenant.sourceProjectId,
      tenant.organizationId
    );

    expect(tree.projectVersion).toBe(
      (await versions(tenant))[tenant.sourceProjectId]
    );
  });
});
