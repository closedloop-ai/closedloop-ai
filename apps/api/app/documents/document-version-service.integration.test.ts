/**
 * DB-backed coverage for the version-read queries. The route suites mock this
 * service, so the `where` and `select` clauses below are only actually executed
 * here: without this file, dropping `documentId` from `getByVersionId`'s filter
 * (a cross-artifact content read), dropping its `organizationId` predicate (a
 * cross-TENANT content read), or adding `content` back to the `listVersions`
 * select (an unbounded bulk body fetch) leaves every other suite green.
 */
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { generateSlug } from "@/app/documents/document-utils";
import { documentVersionService } from "@/app/documents/document-version-service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../../__tests__/utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)("documentVersionService version reads", () => {
  it("does not return a version belonging to a different artifact", async () => {
    await autoRollbackTransaction(async () => {
      const { userId, projectId, organizationId } = await seedContext();
      const artifactA = await createArtifactWithVersions(
        { userId, projectId, organizationId },
        ["A version one"]
      );
      const artifactB = await createArtifactWithVersions(
        { userId, projectId, organizationId },
        ["B version one"]
      );

      const foreign = await documentVersionService.getByVersionId(
        artifactA.artifactId,
        organizationId,
        artifactB.versionIds[0]
      );
      expect(foreign).toBeNull();

      // Paired positive: the same locator resolves against its own artifact,
      // so the null above is the scope filter and not a broken fixture.
      const own = await documentVersionService.getByVersionId(
        artifactB.artifactId,
        organizationId,
        artifactB.versionIds[0]
      );
      expect(own?.content).toBe("B version one");
    });
  });

  it("does not return a version belonging to a different organization", async () => {
    await autoRollbackTransaction(async () => {
      const owner = await seedContext();
      const intruder = await seedContext();
      const artifact = await createArtifactWithVersions(owner, [
        "Owner org body",
      ]);

      // The version's own ids are correct; only the ORG differs. Decidable only
      // against a real DB — the route suites mock this service, so the org
      // predicate below is executed nowhere else.
      const crossOrg = await documentVersionService.getByVersionId(
        artifact.artifactId,
        intruder.organizationId,
        artifact.versionIds[0]
      );
      expect(crossOrg).toBeNull();

      // Paired positive: same locator, owning org, so the null above is the org
      // filter rather than a fixture that never resolved in the first place.
      const sameOrg = await documentVersionService.getByVersionId(
        artifact.artifactId,
        owner.organizationId,
        artifact.versionIds[0]
      );
      expect(sameOrg?.content).toBe("Owner org body");
    });
  });

  it("lists versions newest-first and never selects their bodies", async () => {
    await autoRollbackTransaction(async () => {
      const { userId, projectId, organizationId } = await seedContext();
      const artifact = await createArtifactWithVersions(
        { userId, projectId, organizationId },
        ["ORIGINAL body", "SWEEP NOTE", "CURRENT body"]
      );

      const rows = await documentVersionService.listVersions(
        artifact.artifactId
      );

      expect(rows.map((row) => row.version)).toEqual([3, 2, 1]);
      // The rows exist and carry real bodies in the table, so an added
      // `content: true` in the select would surface them here. `not.toHaveProperty`
      // rather than `=== undefined`: ABSENT is the property that bounds the
      // response, and an undefined-valued key would not be absent.
      for (const row of rows) {
        expect(row).not.toHaveProperty("content");
      }
    });
  });
});

async function seedContext() {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id, {
    name: "Version reads",
  });
  return { organizationId, projectId, userId: user.id };
}

async function createArtifactWithVersions(
  context: { organizationId: string; projectId: string; userId: string },
  contents: string[]
): Promise<{ artifactId: string; versionIds: string[] }> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        name: "Versioned artifact",
        slug: generateSlug(),
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.PRD,
        status: DocumentStatus.Draft,
        organizationId: context.organizationId,
        createdById: context.userId,
        projectId: context.projectId,
        document: {
          create: {
            latestVersion: contents.length,
            repositorySnapshot: {},
          },
        },
      },
      select: { id: true },
    })
  );

  const versionIds: string[] = [];
  for (const [index, content] of contents.entries()) {
    const row = await withDb((db) =>
      db.documentVersion.create({
        data: {
          documentId: artifact.id,
          version: index + 1,
          content,
          createdById: context.userId,
        },
        select: { id: true },
      })
    );
    versionIds.push(row.id);
  }

  return { artifactId: artifact.id, versionIds };
}
