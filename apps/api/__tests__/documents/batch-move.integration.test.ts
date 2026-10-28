/**
 * Integration tests for batch move artifacts service method.
 * Tests cross-project artifact moves with atomicity.
 */
import { DocumentStatus } from "@repo/api/src/types/document";
import { Result, Status } from "@repo/api/src/types/result";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { documentBatchMoveService } from "@/app/documents/document-batch-move-service";
import { generateSlug } from "@/app/documents/document-utils";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)("batchMove artifacts", () => {
  it("valid batch move updates projectId for all artifacts", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectAId = await createTestProject(orgId, user.id, {
        name: "Project A",
      });
      const projectBId = await createTestProject(orgId, user.id, {
        name: "Project B",
      });

      // Create 3 artifacts in project A
      const artifact1 = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Artifact 1",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId: projectAId,
          },
        })
      );

      const artifact2 = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Artifact 2",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId: projectAId,
          },
        })
      );

      const artifact3 = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Artifact 3",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId: projectAId,
          },
        })
      );

      // Move all 3 to project B
      const result = await documentBatchMoveService.batchMove(
        [artifact1.id, artifact2.id, artifact3.id],
        projectBId,
        orgId
      );

      // ISS-9158: the service hands the route each row's project transition,
      // read in the same transaction as the write, so the activity feed can
      // record where the document came FROM. Matched by artifact id: the
      // locking read orders by id, not by request order.
      if (!result.ok) {
        throw new Error(`expected ok, got ${result.error}`);
      }
      expect(result.value.movedIds).toEqual([
        artifact1.id,
        artifact2.id,
        artifact3.id,
      ]);
      expect(
        [...result.value.projectChanges].sort((a, b) =>
          a.artifactId.localeCompare(b.artifactId)
        )
      ).toEqual(
        [artifact1.id, artifact2.id, artifact3.id]
          .sort((a, b) => a.localeCompare(b))
          .map((artifactId) => ({
            artifactId,
            before: projectAId,
            after: projectBId,
          }))
      );

      // Verify all artifacts now have projectId: projectBId
      const artifacts = await withDb((db) =>
        db.artifact.findMany({
          where: {
            id: { in: [artifact1.id, artifact2.id, artifact3.id] },
          },
        })
      );

      expect(artifacts).toHaveLength(3);
      for (const artifact of artifacts) {
        expect(artifact.projectId).toBe(projectBId);
      }
    });
  });

  it("target project not found returns BadRequest", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectAId = await createTestProject(orgId, user.id, {
        name: "Project A",
      });
      const fakeProjectId = "99999999-9999-4999-8999-999999999999";

      const artifact = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Artifact",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId: projectAId,
          },
        })
      );

      await expect(
        documentBatchMoveService.batchMove([artifact.id], fakeProjectId, orgId)
      ).resolves.toEqual(Result.err(Status.BadRequest));
    });
  });

  it("a document outside the organization returns NotFound and moves nothing", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const otherOrgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const otherUser = await createTestUser(otherOrgId);
      const projectBId = await createTestProject(orgId, user.id, {
        name: "Project B",
      });
      const otherProjectId = await createTestProject(otherOrgId, otherUser.id, {
        name: "Other Org Project",
      });

      const foreignArtifact = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Foreign",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId: otherOrgId,
            createdById: otherUser.id,
            projectId: otherProjectId,
          },
        })
      );

      await expect(
        documentBatchMoveService.batchMove(
          [foreignArtifact.id],
          projectBId,
          orgId
        )
      ).resolves.toEqual(Result.err(Status.NotFound));

      const untouched = await withDb((db) =>
        db.artifact.findUniqueOrThrow({
          where: { id: foreignArtifact.id },
          select: { projectId: true },
        })
      );
      expect(untouched.projectId).toBe(otherProjectId);
    });
  });

  it("rejects moving documents to another organization's project", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const otherOrgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const otherUser = await createTestUser(otherOrgId);
      const projectInOrg = await createTestProject(orgId, user.id, {
        name: "Source Project",
      });
      const projectInOtherOrg = await createTestProject(
        otherOrgId,
        otherUser.id,
        { name: "Other Org Project" }
      );

      const artifact = await withDb((db) =>
        db.artifact.create({
          data: {
            name: "Artifact",
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: user.id,
            projectId: projectInOrg,
          },
        })
      );

      await expect(
        documentBatchMoveService.batchMove(
          [artifact.id],
          projectInOtherOrg,
          orgId
        )
      ).resolves.toEqual(Result.err(Status.BadRequest));
    });
  });

  it("empty artifactIds array returns without error", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectBId = await createTestProject(orgId, user.id, {
        name: "Project B",
      });
      await expect(
        documentBatchMoveService.batchMove([], projectBId, orgId)
      ).resolves.toEqual(Result.ok({ movedIds: [], projectChanges: [] }));
    });
  });
});
