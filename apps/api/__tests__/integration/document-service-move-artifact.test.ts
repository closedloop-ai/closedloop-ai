/**
 * Integration tests for `documentService.moveArtifact` — single-item stack
 * rank primitive backing drag-drop, keyboard reorder, and the row-menu
 * Move-to-top / Move-to-bottom actions (PRD-421).
 *
 * Runs against a real Postgres because `moveArtifact` delegates into
 * `reorder` which executes raw SQL via `tx.$executeRaw`.
 */
import { DocumentStatus } from "@repo/api/src/types/document";
import { MovePosition } from "@repo/api/src/types/project-artifact-move";
import { Status } from "@repo/api/src/types/result";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  documentService,
  STACK_RANK_GAP,
} from "@/app/documents/document-service";
import { generateSlug } from "@/app/documents/document-utils";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

type ArtifactSeed = { name: string; sortOrder: number | null };

function seedArtifacts(
  orgId: string,
  projectId: string,
  userId: string,
  seeds: ArtifactSeed[]
): Promise<{ id: string; name: string }[]> {
  return Promise.all(
    seeds.map((seed) =>
      withDb((db) =>
        db.artifact.create({
          data: {
            name: seed.name,
            slug: generateSlug(),
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.PRD,
            status: DocumentStatus.Draft,
            organizationId: orgId,
            createdById: userId,
            projectId,
            sortOrder: seed.sortOrder,
          },
          select: { id: true, name: true },
        })
      )
    )
  );
}

function readOrdering(
  projectId: string
): Promise<{ name: string; sortOrder: number | null }[]> {
  return withDb((db) =>
    db.artifact.findMany({
      where: { projectId, type: ArtifactType.DOCUMENT },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      select: { name: true, sortOrder: true },
    })
  );
}

/** Seed a deterministic three-row fixture used by most tests in this suite. */
function seedArtifactsAbc(
  orgId: string,
  projectId: string,
  userId: string
): Promise<{ id: string; name: string }[]> {
  return seedArtifacts(orgId, projectId, userId, [
    { name: "A", sortOrder: 1000 },
    { name: "B", sortOrder: 2000 },
    { name: "C", sortOrder: 3000 },
  ]);
}

describe.skipIf(!hasDatabase)("documentService.moveArtifact", () => {
  it("moves a middle item to the top", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const [_a, b, _c] = await seedArtifactsAbc(orgId, projectId, user.id);

      const result = await documentService.moveArtifact(projectId, orgId, {
        artifactId: b!.id,
        position: MovePosition.Top,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.newSortOrder).toBe(0);
      }
      expect(await readOrdering(projectId)).toEqual([
        { name: "B", sortOrder: 0 },
        { name: "A", sortOrder: STACK_RANK_GAP },
        { name: "C", sortOrder: STACK_RANK_GAP * 2 },
      ]);
    });
  });

  it("moves an item to the bottom", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const [a, _b, _c] = await seedArtifactsAbc(orgId, projectId, user.id);

      const result = await documentService.moveArtifact(projectId, orgId, {
        artifactId: a!.id,
        position: MovePosition.Bottom,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.newSortOrder).toBe(STACK_RANK_GAP * 2);
      }
      expect(await readOrdering(projectId)).toEqual([
        { name: "B", sortOrder: 0 },
        { name: "C", sortOrder: STACK_RANK_GAP },
        { name: "A", sortOrder: STACK_RANK_GAP * 2 },
      ]);
    });
  });

  it("inserts before a reference", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const [a, _b, c] = await seedArtifactsAbc(orgId, projectId, user.id);

      // Move C to position immediately before A → C, A, B
      const result = await documentService.moveArtifact(projectId, orgId, {
        artifactId: c!.id,
        position: MovePosition.Before,
        referenceArtifactId: a!.id,
      });
      expect(result.ok).toBe(true);

      expect(await readOrdering(projectId)).toEqual([
        { name: "C", sortOrder: 0 },
        { name: "A", sortOrder: STACK_RANK_GAP },
        { name: "B", sortOrder: STACK_RANK_GAP * 2 },
      ]);
    });
  });

  it("inserts after a reference", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const [a, b, _c] = await seedArtifactsAbc(orgId, projectId, user.id);

      // Move A to position immediately after B → B, A, C
      const result = await documentService.moveArtifact(projectId, orgId, {
        artifactId: a!.id,
        position: MovePosition.After,
        referenceArtifactId: b!.id,
      });
      expect(result.ok).toBe(true);

      expect(await readOrdering(projectId)).toEqual([
        { name: "B", sortOrder: 0 },
        { name: "A", sortOrder: STACK_RANK_GAP },
        { name: "C", sortOrder: STACK_RANK_GAP * 2 },
      ]);
    });
  });

  it("returns NotFound when artifact does not belong to the project", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectA = await createTestProject(orgId, user.id);
      const projectB = await createTestProject(orgId, user.id);

      const [strayA] = await seedArtifacts(orgId, projectB, user.id, [
        { name: "A in B", sortOrder: 1000 },
      ]);

      const result = await documentService.moveArtifact(projectA, orgId, {
        artifactId: strayA!.id,
        position: MovePosition.Top,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.status).toBe(Status.NotFound);
        expect(result.error.message).toContain("not found in project");
      }
    });
  });

  it("returns NotFound when reference does not belong to the project", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectA = await createTestProject(orgId, user.id);
      const projectB = await createTestProject(orgId, user.id);

      const [a] = await seedArtifacts(orgId, projectA, user.id, [
        { name: "A", sortOrder: 1000 },
      ]);
      const [strayRef] = await seedArtifacts(orgId, projectB, user.id, [
        { name: "Ref in B", sortOrder: 1000 },
      ]);

      const result = await documentService.moveArtifact(projectA, orgId, {
        artifactId: a!.id,
        position: MovePosition.Before,
        referenceArtifactId: strayRef!.id,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.status).toBe(Status.NotFound);
        expect(result.error.message).toContain("Reference artifact");
      }
    });
  });

  it("returns BadRequest for Before/After without referenceArtifactId", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const [a] = await seedArtifacts(orgId, projectId, user.id, [
        { name: "A", sortOrder: 1000 },
      ]);

      const result = await documentService.moveArtifact(projectId, orgId, {
        artifactId: a!.id,
        position: MovePosition.Before,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.status).toBe(Status.BadRequest);
        expect(result.error.message).toContain(
          "referenceArtifactId is required"
        );
      }
    });
  });

  it("returns BadRequest when reference equals the moved artifact", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const [a] = await seedArtifacts(orgId, projectId, user.id, [
        { name: "A", sortOrder: 1000 },
      ]);

      const result = await documentService.moveArtifact(projectId, orgId, {
        artifactId: a!.id,
        position: MovePosition.After,
        referenceArtifactId: a!.id,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.status).toBe(Status.BadRequest);
        expect(result.error.message).toContain("must differ from artifactId");
      }
    });
  });

  it("idempotent move (same position) is a no-op for ordering", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id);

      const [a, _b, _c] = await seedArtifactsAbc(orgId, projectId, user.id);

      // Move A to top — already at top.
      const result = await documentService.moveArtifact(projectId, orgId, {
        artifactId: a!.id,
        position: MovePosition.Top,
      });
      expect(result.ok).toBe(true);

      const ordering = await readOrdering(projectId);
      expect(ordering.map((row) => row.name)).toEqual(["A", "B", "C"]);
    });
  });
});
