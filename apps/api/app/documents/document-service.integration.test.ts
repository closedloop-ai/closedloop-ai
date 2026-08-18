import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { MovePosition } from "@repo/api/src/types/project-artifact-move";
import { Status } from "@repo/api/src/types/result";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { documentService } from "@/app/documents/document-service";

/**
 * DB-backed coverage for the document store's stack-rank move and its
 * repository-snapshot resolution. Real Postgres via `withDb` (self-skips when
 * DATABASE_URL is unset), each case in an auto-rollback transaction.
 *
 * `moveArtifact` is worth this much attention because every one of its failure
 * modes is a DISTINCT 4xx the route maps — a caller that asks to move a
 * document before a reference that does not exist must get a 404 naming the
 * reference, not a silent no-op or a 500 — and because the ordering it produces
 * is what the Documents list renders.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

type Seeded = {
  organizationId: string;
  userId: string;
  projectId: string;
  ids: string[];
};

/** Seed `count` sibling documents in one project, in stack-rank order. */
async function seedProjectWithDocuments(count: number): Promise<Seeded> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);

  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const doc = await documentService.create(organizationId, user.id, {
      projectId,
      title: `Doc ${i}`,
      type: DocumentType.Prd,
      status: DocumentStatus.Draft,
    } as Parameters<typeof documentService.create>[2]);
    if (!doc) {
      throw new Error("seed failed: documentService.create returned null");
    }
    ids.push(doc.id);
  }
  // Read the ids back in RENDERED order rather than assuming creation order is
  // it: the store tiebreaks equal sortOrders on `createdAt: desc`, so the two
  // are not the same. A test that assumed otherwise would be asserting the
  // fixture, not the move.
  const seeded = { organizationId, userId: user.id, projectId, ids };
  return { ...seeded, ids: await orderedIds(seeded) };
}

/**
 * The project's documents in STACK-RANK order.
 *
 * `findAll` returns rows ordered by `createdAt desc` and carries each row's
 * `sortOrder` on the wire; the client is what orders by stack rank (see
 * `packages/app/projects/hooks/use-project-tree.ts` — "the canonical sortOrder
 * values from the server win"). So the rank `moveArtifact` writes is asserted by
 * sorting on that field, not by trusting the list's own row order.
 */
async function orderedIds(seeded: Seeded): Promise<string[]> {
  const docs = await documentService.findAll({
    organizationId: seeded.organizationId,
    projectId: seeded.projectId,
  });
  return [...docs]
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((d) => d.id);
}

describeIfDb("documentService.moveArtifact — placement", () => {
  it("moves a document to the top", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedProjectWithDocuments(3);
      const [first, , third] = seeded.ids;

      const result = await documentService.moveArtifact(
        seeded.projectId,
        seeded.organizationId,
        { artifactId: third, position: MovePosition.Top }
      );

      expect(result.ok).toBe(true);
      expect((await orderedIds(seeded))[0]).toBe(third);
      expect(await orderedIds(seeded)).toHaveLength(3);
      expect((await orderedIds(seeded))[1]).toBe(first);
    });
  });

  it("moves a document to the bottom", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedProjectWithDocuments(3);
      const [first] = seeded.ids;

      const result = await documentService.moveArtifact(
        seeded.projectId,
        seeded.organizationId,
        { artifactId: first, position: MovePosition.Bottom }
      );

      expect(result.ok).toBe(true);
      expect((await orderedIds(seeded)).at(-1)).toBe(first);
    });
  });

  it("inserts BEFORE the reference", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedProjectWithDocuments(3);
      const [first, second, third] = seeded.ids;

      await documentService.moveArtifact(
        seeded.projectId,
        seeded.organizationId,
        {
          artifactId: third,
          position: MovePosition.Before,
          referenceArtifactId: second,
        }
      );

      expect(await orderedIds(seeded)).toEqual([first, third, second]);
    });
  });

  it("inserts AFTER the reference", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedProjectWithDocuments(3);
      const [first, second, third] = seeded.ids;

      await documentService.moveArtifact(
        seeded.projectId,
        seeded.organizationId,
        {
          artifactId: first,
          position: MovePosition.After,
          referenceArtifactId: second,
        }
      );

      expect(await orderedIds(seeded)).toEqual([second, first, third]);
    });
  });

  it("is a no-op placement when a document is moved onto its own position", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedProjectWithDocuments(3);
      const before = await orderedIds(seeded);

      const result = await documentService.moveArtifact(
        seeded.projectId,
        seeded.organizationId,
        { artifactId: seeded.ids[0], position: MovePosition.Top }
      );

      expect(result.ok).toBe(true);
      expect(await orderedIds(seeded)).toEqual(before);
    });
  });
});

describeIfDb("documentService.moveArtifact — rejections", () => {
  it("404s when the artifact is not in the project", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedProjectWithDocuments(2);
      const other = await seedProjectWithDocuments(1);

      const result = await documentService.moveArtifact(
        seeded.projectId,
        seeded.organizationId,
        { artifactId: other.ids[0], position: MovePosition.Top }
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.status).toBe(Status.NotFound);
    });
  });

  it("400s when a relative position omits the reference", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedProjectWithDocuments(2);

      for (const position of [MovePosition.Before, MovePosition.After]) {
        const result = await documentService.moveArtifact(
          seeded.projectId,
          seeded.organizationId,
          { artifactId: seeded.ids[0], position }
        );

        expect(result.ok).toBe(false);
        expect(!result.ok && result.error.status).toBe(Status.BadRequest);
      }
    });
  });

  it("400s when the reference is the artifact itself", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedProjectWithDocuments(2);
      const [first] = seeded.ids;

      const result = await documentService.moveArtifact(
        seeded.projectId,
        seeded.organizationId,
        {
          artifactId: first,
          position: MovePosition.Before,
          referenceArtifactId: first,
        }
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.status).toBe(Status.BadRequest);
    });
  });

  it("404s when the reference is not in the project, naming the reference", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedProjectWithDocuments(2);
      const other = await seedProjectWithDocuments(1);

      const result = await documentService.moveArtifact(
        seeded.projectId,
        seeded.organizationId,
        {
          artifactId: seeded.ids[0],
          position: MovePosition.Before,
          referenceArtifactId: other.ids[0],
        }
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.status).toBe(Status.NotFound);
      // The message must name the REFERENCE, not the artifact being moved —
      // otherwise the caller cannot tell which id was the bad one.
      expect(!result.ok && result.error.message).toContain(other.ids[0]);
    });
  });

  it("leaves the existing order untouched when a move is rejected", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedProjectWithDocuments(3);
      const before = await orderedIds(seeded);

      await documentService.moveArtifact(
        seeded.projectId,
        seeded.organizationId,
        {
          artifactId: seeded.ids[0],
          position: MovePosition.Before,
          referenceArtifactId: seeded.ids[0],
        }
      );

      expect(await orderedIds(seeded)).toEqual(before);
    });
  });

  it("does not move an artifact across organizations", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedProjectWithDocuments(2);
      const foreignOrg = await createTestOrganization();

      const result = await documentService.moveArtifact(
        seeded.projectId,
        foreignOrg,
        { artifactId: seeded.ids[0], position: MovePosition.Top }
      );

      // Org scoping is in the query, so the artifact simply is not visible.
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.status).toBe(Status.NotFound);
    });
  });
});

describeIfDb("documentService.create — repository snapshot resolution", () => {
  it("gives an org-level template an empty snapshot", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);

      const doc = await documentService.create(organizationId, user.id, {
        title: "A template",
        type: DocumentType.Template,
        status: DocumentStatus.Draft,
      } as Parameters<typeof documentService.create>[2]);

      expect(doc).not.toBeNull();
      const stored = await documentService.findById(
        doc?.id ?? "",
        organizationId
      );
      expect(stored?.repositorySnapshot?.repositories ?? []).toEqual([]);
    });
  });

  it("refuses to attach a template to a project", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);

      // Templates are organization-level; being handed a project is a caller
      // error, and the store raises rather than silently dropping the project.
      await expect(
        documentService.create(organizationId, user.id, {
          projectId,
          title: "Bad template",
          type: DocumentType.Template,
          status: DocumentStatus.Draft,
        } as Parameters<typeof documentService.create>[2])
      ).rejects.toThrow();
    });
  });

  it("inherits a non-empty snapshot from the source document", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);

      const parent = await documentService.create(organizationId, user.id, {
        projectId,
        title: "Parent",
        type: DocumentType.Prd,
        status: DocumentStatus.Draft,
        repositorySelection: {
          primary: { fullName: "acme/web", branch: "main" },
        },
      } as Parameters<typeof documentService.create>[2]);

      const child = await documentService.create(organizationId, user.id, {
        projectId,
        sourceId: parent?.id,
        title: "Child",
        type: DocumentType.ImplementationPlan,
        status: DocumentStatus.Draft,
      } as Parameters<typeof documentService.create>[2]);

      const stored = await documentService.findById(
        child?.id ?? "",
        organizationId
      );
      expect(
        stored?.repositorySnapshot?.repositories.map((r) => r.fullName)
      ).toEqual(["acme/web"]);
    });
  });

  it("takes an explicit repositorySelection over everything else", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);

      const doc = await documentService.create(organizationId, user.id, {
        projectId,
        title: "Explicit",
        type: DocumentType.Prd,
        status: DocumentStatus.Draft,
        repositorySelection: {
          primary: { fullName: "acme/api", branch: "dev" },
        },
      } as Parameters<typeof documentService.create>[2]);

      const stored = await documentService.findById(
        doc?.id ?? "",
        organizationId
      );
      expect(
        stored?.repositorySnapshot?.repositories.map((r) => r.fullName)
      ).toEqual(["acme/api"]);
    });
  });
});

describeIfDb("documentService — org scoping on reads and delete", () => {
  it("does not return a document to a foreign organization", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedProjectWithDocuments(1);
      const foreignOrg = await createTestOrganization();

      expect(
        await documentService.findById(seeded.ids[0], foreignOrg)
      ).toBeNull();
    });
  });

  it("deletes within the owning organization", async () => {
    await autoRollbackTransaction(async () => {
      const seeded = await seedProjectWithDocuments(2);

      await documentService.delete(seeded.ids[0], seeded.organizationId);

      expect(
        await documentService.findById(seeded.ids[0], seeded.organizationId)
      ).toBeNull();
      // The sibling survives — a delete must not take the project with it.
      expect(
        await documentService.findById(seeded.ids[1], seeded.organizationId)
      ).not.toBeNull();
    });
  });
});
