/**
 * ISS-11198 on real Postgres: the title guard on `PUT /documents/{id}` and the
 * name guard on `PUT /projects/{id}`.
 *
 * Two renames that both expect "Seed" race behind a held lock: the row lock
 * serializes them, so the second reads the first's result and is refused as
 * stale while exactly one lands. The org cases use two organizations, since
 * one cannot tell a scoped guard from an unscoped one.
 */
import { IssueStatus } from "@repo/api/src/types/document";
import { DocumentFieldMutationErrorCode } from "@repo/api/src/types/document-field-mutation";
import { DocumentStatusMutationErrorCode } from "@repo/api/src/types/document-status-mutation";
import { ProjectFieldMutationErrorCode } from "@repo/api/src/types/project-field-mutation";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/search/search-index-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/search/search-index-service")
  >("@/app/search/search-index-service");
  return {
    ...actual,
    searchIndexService: {
      indexAfterCommit: vi.fn(() => Promise.resolve()),
      removeAfterCommit: vi.fn(() => Promise.resolve()),
    },
  };
});

import { documentStatusMutationService } from "@/app/documents/document-status-mutation-service";
import { projectsService } from "@/app/projects/service";
import { holdRowLock } from "../support/row-lock-holder";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizations = createCommittedTestOrganizationTracker();
const SEED = "Seed";

describe.skipIf(!hasDatabase)(
  "ISS-11198 inline field guards against real Postgres",
  () => {
    afterEach(async () => {
      await organizations.cleanup();
    });

    it("lets one of two racing document renames land and refuses the other", async () => {
      const { organizationId, documentId } = await seedDocument();
      const holder = await holdRowLock((tx) =>
        tx.artifact.update({
          where: { id: documentId },
          data: { priority: null },
          select: { id: true },
        })
      );

      const renames = ["Apollo", "Artemis"].map((title) =>
        documentStatusMutationService.updateDocument(
          documentId,
          organizationId,
          { expectedTitle: SEED, title }
        )
      );
      const blocked = await holder.waitForWaiters(renames.length);
      await holder.release();
      const results = await Promise.all(renames);

      expect(blocked).toBe(true);
      const landed = results.flatMap((r) => (r.ok ? [r.value.document] : []));
      const refused = results.flatMap((r) => (r.ok ? [] : [r.error.code]));
      expect(landed).toHaveLength(1);
      expect(refused).toEqual([DocumentFieldMutationErrorCode.StaleTitle]);
      await expect(readDocumentTitle(documentId)).resolves.toBe(
        landed[0]?.title
      );
    }, 20_000);

    it("refuses a guarded document rename from another organization", async () => {
      const own = await seedDocument();
      const other = await seedDocument();

      const crossOrg = await documentStatusMutationService.updateDocument(
        own.documentId,
        other.organizationId,
        { expectedTitle: SEED, title: "Hijacked" }
      );
      const sameOrg = await documentStatusMutationService.updateDocument(
        other.documentId,
        other.organizationId,
        { expectedTitle: SEED, title: "Renamed" }
      );

      expect(crossOrg.ok ? null : crossOrg.error.code).toBe(
        DocumentStatusMutationErrorCode.ArtifactsNotFound
      );
      expect(sameOrg.ok).toBe(true);
      await expect(readDocumentTitle(own.documentId)).resolves.toBe(SEED);
    });

    it("lets one of two racing project renames land and refuses the other", async () => {
      const { organizationId, projectId } = await seedProject();
      const holder = await holdRowLock((tx) =>
        tx.project.update({
          where: { id: projectId },
          data: { priority: null },
          select: { id: true },
        })
      );

      const renames = ["Apollo", "Artemis"].map((name) =>
        projectsService.update(projectId, organizationId, {
          expectedName: SEED,
          name,
        })
      );
      const blocked = await holder.waitForWaiters(renames.length);
      await holder.release();
      const results = await Promise.all(renames);

      expect(blocked).toBe(true);
      const landed = results.flatMap((r) => (r.ok ? [r.value.project] : []));
      const refused = results.flatMap((r) =>
        r.ok || !("code" in r.error) ? [] : [r.error.code]
      );
      expect(landed).toHaveLength(1);
      expect(refused).toEqual([ProjectFieldMutationErrorCode.StaleName]);
      await expect(readProjectName(projectId)).resolves.toBe(landed[0]?.name);
    }, 20_000);

    it("does not rename a project through another organization's guarded write", async () => {
      const own = await seedProject();
      const other = await seedProject();

      // The org-scoped update matches no row. The route 404s before reaching
      // the service, on its own org-scoped read.
      await expect(
        projectsService.update(own.projectId, other.organizationId, {
          expectedName: SEED,
          name: "Hijacked",
        })
      ).rejects.toMatchObject({ code: "P2025" });
      const sameOrg = await projectsService.update(
        other.projectId,
        other.organizationId,
        { expectedName: SEED, name: "Renamed" }
      );

      expect(sameOrg.ok).toBe(true);
      await expect(readProjectName(own.projectId)).resolves.toBe(SEED);
    });
  }
);

async function seedDocument(): Promise<{
  organizationId: string;
  documentId: string;
}> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        createdById: user.id,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.FEATURE,
        name: SEED,
        slug: null,
        status: IssueStatus.Todo,
      },
      select: { id: true },
    })
  );
  return { organizationId, documentId: artifact.id };
}

async function seedProject(): Promise<{
  organizationId: string;
  projectId: string;
}> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id, {
    name: SEED,
  });
  return { organizationId, projectId };
}

async function readDocumentTitle(id: string): Promise<string> {
  const row = await withDb((db) =>
    db.artifact.findUniqueOrThrow({ where: { id }, select: { name: true } })
  );
  return row.name;
}

async function readProjectName(id: string): Promise<string> {
  const row = await withDb((db) =>
    db.project.findUniqueOrThrow({ where: { id }, select: { name: true } })
  );
  return row.name;
}
