import {
  DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
  DocumentListRecency,
  DocumentStatus,
} from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { documentListService } from "@/app/documents/document-list-service";
import { documentService } from "@/app/documents/document-service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const env = keys();
const hasDatabase = !!env.DATABASE_URL;

const DAY_MS = 86_400_000;
const WELL_OUTSIDE_WINDOW_DAYS = DOCUMENT_LIST_DEFAULT_RECENCY_DAYS * 2;

/**
 * FEA-1626 (epic FEA-908) against a REAL database.
 *
 * The unit suites prove the predicate's SHAPE; only Postgres can settle the
 * claim the whole archived-project filter rests on — that a Prisma filter on the
 * NULLABLE `project` relation matches solely rows that have a related row, so a
 * bare `project: { status: { not: ARCHIVED } }` would silently delete every
 * org-level Document and Template from the result. These tests seed the three
 * lifecycle shapes and one aged row, then read them back through the real
 * service.
 */
describe.skipIf(!hasDatabase)(
  "Document list lifecycle filters (FEA-1626)",
  () => {
    it("excludes archived-project rows, keeps project-less rows, and windows by updatedAt", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const activeProjectId = await createTestProject(
          organizationId,
          user.id
        );
        const archivedProjectId = await createTestProject(
          organizationId,
          user.id,
          { status: ProjectStatus.Archived }
        );

        const inActive = await seedAssignedDocument({
          organizationId,
          assigneeId: user.id,
          projectId: activeProjectId,
          name: "In an active project",
        });
        const inArchived = await seedAssignedDocument({
          organizationId,
          assigneeId: user.id,
          projectId: archivedProjectId,
          name: "In an archived project",
        });
        const projectLess = await seedAssignedDocument({
          organizationId,
          assigneeId: user.id,
          projectId: null,
          name: "Org-level, no project at all",
        });
        const stale = await seedAssignedDocument({
          organizationId,
          assigneeId: user.id,
          projectId: activeProjectId,
          name: "Untouched for months",
        });
        await ageArtifact(stale, WELL_OUTSIDE_WINDOW_DAYS);

        // The page read, not the `findPageWithCustomFields` envelope: that one
        // opens its own `RepeatableRead` transaction, which cannot nest inside the
        // rollback transaction wrapping this test. `countAll` alongside it proves
        // the page and its total are still drawn from the one predicate.
        // The narrowing is OPT-IN, so the request states it — the server applies
        // nothing on its own (see `resolveDocumentListRecencyDays`). Omitting
        // these params is the legacy full-history read, covered below.
        const listOptions = {
          organizationId,
          assigneeId: user.id,
          limit: 50,
          recencyDays: DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
          includeArchivedProjects: false,
        };
        const defaulted =
          await documentService.findAllWithCustomFields(listOptions);
        const defaultedIds = defaulted.map((item) => item.id);

        // The project-less row is the regression this OR exists for: a naive
        // relation filter returns zero of them.
        expect(defaultedIds).toContain(projectLess);
        expect(defaultedIds).toContain(inActive);
        expect(defaultedIds).not.toContain(inArchived);
        expect(defaultedIds).not.toContain(stale);
        expect(await documentListService.countAll(listOptions)).toBe(
          defaulted.length
        );

        const everythingOptions = {
          ...listOptions,
          recencyDays: DocumentListRecency.All,
          includeArchivedProjects: true,
        };
        const everythingIds = (
          await documentService.findAllWithCustomFields(everythingOptions)
        ).map((item) => item.id);

        expect(everythingIds).toContain(inArchived);
        expect(everythingIds).toContain(stale);
        expect(everythingIds).toContain(projectLess);
        expect(await documentListService.countAll(everythingOptions)).toBe(4);
      });
    });

    it("leaves a request that omits the new params reading every row", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const archivedProjectId = await createTestProject(
          organizationId,
          user.id,
          { status: ProjectStatus.Archived }
        );

        const inArchived = await seedAssignedDocument({
          organizationId,
          assigneeId: user.id,
          projectId: archivedProjectId,
          name: "In an archived project",
        });
        const stale = await seedAssignedDocument({
          organizationId,
          assigneeId: user.id,
          projectId: archivedProjectId,
          name: "Untouched for months",
        });
        await ageArtifact(stale, WELL_OUTSIDE_WINDOW_DAYS);

        // The Documents index, plan/document pickers, the MCP `list-documents`
        // tool, and version-skewed API-key clients all read without the new
        // params, and FEA-1626 must not remove a single row from them.
        const unbounded = await documentListService.countAll({
          organizationId,
          assigneeId: user.id,
        });
        // The SAME shape an already-deployed `apps/app` sends, and what a new
        // build sends with the flag off. Both must still see every row — that is
        // the whole reason omission does not mean "windowed" (wongk).
        const legacyPaged = await documentListService.countAll({
          organizationId,
          assigneeId: user.id,
          limit: 50,
        });

        expect(unbounded).toBe(2);
        expect(legacyPaged).toBe(2);
        expect(inArchived).toBeTruthy();
      });
    });
  }
);

/** Insert one DOCUMENT artifact assigned to the given user; returns its id. */
async function seedAssignedDocument(input: {
  organizationId: string;
  assigneeId: string;
  projectId: string | null;
  name: string;
}): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.PRD,
        name: input.name,
        status: DocumentStatus.Draft,
        assigneeId: input.assigneeId,
      },
    })
  );
  return artifact.id;
}

/**
 * Push an artifact's `updated_at` back by `days`. Raw SQL because Prisma's
 * `@updatedAt` stamps the current time on every `update`, so the column cannot
 * be aged through the client.
 */
async function ageArtifact(artifactId: string, days: number): Promise<void> {
  const agedAt = new Date(Date.now() - days * DAY_MS);
  await withDb(
    (db) =>
      db.$executeRaw`UPDATE artifacts SET updated_at = ${agedAt} WHERE id = ${artifactId}::uuid`
  );
}
