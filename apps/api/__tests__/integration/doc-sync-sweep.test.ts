/**
 * PLN-2200 T-6.6: the doc-sync sweep against a real app database. The
 * existence check is one `OR` over `(organizationId, slug, type)`; a unit
 * test can only pin the shape handed to Prisma, so this proves Postgres
 * answers it: a seeded document is kept and a deleted one is swept.
 */
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { describe, expect, it, vi } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";

const mocks = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  deleteDocument: vi.fn(),
}));

vi.mock("@/app/doc-sync/internal/internal-client", () => ({
  docSyncInternalClient: () => ({
    listDocuments: mocks.listDocuments,
    deleteDocument: mocks.deleteDocument,
  }),
}));

const { docSyncSweepService } = await import(
  "@/app/doc-sync/internal/sweep-service"
);

const hasDatabase = Boolean(keys().DATABASE_URL);

describe.skipIf(!hasDatabase)("doc-sync sweep against real Postgres", () => {
  it("deletes the doc-sync state of the deleted document only", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      await seedDocument(organizationId, user.id, "PRD-9001");
      const removed = await seedDocument(organizationId, user.id, "PRD-9002");
      await withDb((db) => db.artifact.delete({ where: { id: removed } }));
      const keptRoom = generateDocumentRoomId(organizationId, "PRD-9001");
      const removedRoom = generateDocumentRoomId(organizationId, "PRD-9002");
      mocks.listDocuments.mockResolvedValue({
        ok: true,
        value: { names: [keptRoom, removedRoom], nextAfter: null },
      });
      mocks.deleteDocument.mockResolvedValue({
        ok: true,
        value: { deleted: true, wasLoaded: false },
      });

      const summary = await docSyncSweepService.run({ deadlineMs: 60_000 });

      expect(mocks.deleteDocument.mock.calls).toEqual([[removedRoom]]);
      expect(summary).toMatchObject({ scanned: 2, deleted: 1, kept: 1 });
    });
  });
});

async function seedDocument(
  organizationId: string,
  createdById: string,
  slug: string
): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        createdById,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.PRD,
        name: `doc-sync sweep ${slug}`,
        slug,
        status: DocumentStatus.Draft,
      },
      select: { id: true },
    })
  );
  return artifact.id;
}
