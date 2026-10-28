import { LinkType } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, type TransactionClient, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { DeploymentState } from "@/app/deployments/deployment-state";
import { readBoundedProjectHierarchy } from "./project-hierarchy-read";

const organizations = createCommittedTestOrganizationTracker();

describe.skipIf(!keys().DATABASE_URL)(
  "bounded project hierarchy (Postgres)",
  () => {
    afterEach(async () => {
      await organizations.cleanup();
    });

    it("elects canonical links and orders mixed-kind children by link rank", async () => {
      const organizationId = await organizations.create();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);
      const [firstRoot, secondRoot, firstChild, secondChild] = await withDb.tx(
        async (tx) =>
          Promise.all([
            createArtifact(
              tx,
              organizationId,
              projectId,
              ArtifactType.BRANCH,
              "First root",
              10,
              BranchStatus.Open
            ),
            createArtifact(
              tx,
              organizationId,
              projectId,
              ArtifactType.DEPLOYMENT,
              "Second root",
              20,
              DeploymentState.Success
            ),
            createArtifact(
              tx,
              organizationId,
              projectId,
              ArtifactType.SESSION,
              "First child",
              999,
              SESSION_STATUS.ACTIVE
            ),
            createArtifact(
              tx,
              organizationId,
              projectId,
              ArtifactType.DEPLOYMENT,
              "Second child",
              0,
              DeploymentState.Success
            ),
          ])
      );
      await withDb((db) =>
        db.artifactLink.createMany({
          data: [
            {
              organizationId,
              sourceId: firstRoot.id,
              targetId: firstChild.id,
              linkType: LinkType.Produces,
              sortOrder: 90,
              createdAt: new Date("2026-10-20T00:00:00.000Z"),
            },
            {
              organizationId,
              sourceId: secondRoot.id,
              targetId: firstChild.id,
              linkType: LinkType.Produces,
              sortOrder: 5,
              createdAt: new Date("2026-10-20T00:00:01.000Z"),
              metadata: {
                hierarchy: { canonical: true, managed: true, version: 1 },
              },
            },
            {
              organizationId,
              sourceId: secondRoot.id,
              targetId: secondChild.id,
              linkType: LinkType.Produces,
              sortOrder: 1,
              createdAt: new Date("2026-10-20T00:00:02.000Z"),
            },
          ],
        })
      );

      const result = await withDb.tx((tx) =>
        readBoundedProjectHierarchy(tx, projectId, organizationId, {
          hierarchy: true,
          limit: 2,
        })
      );

      expect(result.window.rootIds).toEqual([firstRoot.id, secondRoot.id]);
      expect(result.state.canonicalParents.get(firstChild.id)?.parentId).toBe(
        secondRoot.id
      );
      expect(result.state.childrenByParent.get(secondRoot.id)).toEqual([
        secondChild.id,
        firstChild.id,
      ]);
      expect(result.state.artifactsById.get(firstChild.id)?.sortOrder).toBe(5);
      expect(result.state.artifactsById.get(secondChild.id)?.sortOrder).toBe(1);

      const firstPage = await withDb.tx((tx) =>
        readBoundedProjectHierarchy(tx, projectId, organizationId, {
          childLimit: 1,
          hierarchy: true,
          parentArtifactId: secondRoot.id,
        })
      );
      expect(firstPage.window.rootIds).toEqual([secondChild.id]);
      expect(firstPage.window.nextCursor).toEqual(expect.any(String));

      const secondPage = await withDb.tx((tx) =>
        readBoundedProjectHierarchy(tx, projectId, organizationId, {
          childCursor: firstPage.window.nextCursor,
          childLimit: 1,
          hierarchy: true,
          parentArtifactId: secondRoot.id,
        })
      );
      expect(secondPage.window.rootIds).toEqual([firstChild.id]);
      expect(secondPage.state.artifactsById.get(firstChild.id)?.sortOrder).toBe(
        5
      );
    });
  }
);

function createArtifact(
  tx: TransactionClient,
  organizationId: string,
  projectId: string,
  type: ArtifactType,
  name: string,
  sortOrder: number,
  status: string
) {
  return tx.artifact.create({
    data: {
      organizationId,
      projectId,
      type,
      name,
      status,
      sortOrder,
    },
  });
}
