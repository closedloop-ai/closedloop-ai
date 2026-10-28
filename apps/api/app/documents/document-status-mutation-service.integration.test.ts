import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { DocumentStatusMutationErrorCode } from "@repo/api/src/types/document-status-mutation";
import { withDb } from "@repo/database";
import { afterEach, describe, expect, it } from "vitest";
import { holdRowLock } from "@/__tests__/support/row-lock-holder";
import {
  autoRollbackTransaction,
  createCommittedTestOrganizationTracker,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { documentStatusMutationService } from "@/app/documents/document-status-mutation-service";
import {
  hasDatabase,
  readStatus,
  seedArtifact,
} from "./__tests__/blocked-dependent-fixtures";

const describeIfDb = hasDatabase ? describe : describe.skip;
const organizations = createCommittedTestOrganizationTracker();

describeIfDb("documentStatusMutationService integration", () => {
  afterEach(async () => {
    await organizations.cleanup();
  });

  it("rolls back the whole batch when one selected document has a stale status", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const firstId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const secondId = await seedArtifact({
        organizationId,
        status: IssueStatus.Todo,
      });

      const result = await documentStatusMutationService.batchUpdateStatus(
        [firstId, secondId],
        IssueStatus.Done,
        organizationId,
        {
          [firstId]: IssueStatus.InProgress,
          [secondId]: IssueStatus.InProgress,
        }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          code: DocumentStatusMutationErrorCode.StaleStatus,
        });
      }
      expect(await readStatus(firstId)).toBe(IssueStatus.InProgress);
      expect(await readStatus(secondId)).toBe(IssueStatus.Todo);
    });
  });

  it("rolls back the whole batch when one selected subtype rejects the target status", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const issueId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      const prdId = await seedArtifact({
        organizationId,
        status: DocumentStatus.Draft,
        subtype: DocumentType.Prd,
      });

      const result = await documentStatusMutationService.batchUpdateStatus(
        [issueId, prdId],
        IssueStatus.Done,
        organizationId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          code: DocumentStatusMutationErrorCode.InvalidStatusForSubtype,
        });
      }
      expect(await readStatus(issueId)).toBe(IssueStatus.InProgress);
      expect(await readStatus(prdId)).toBe(DocumentStatus.Draft);
    });
  });

  it("serializes unguarded priority writes and returns ordered transition facts", async () => {
    const organizationId = await organizations.create();
    const documentId = await seedArtifact({
      organizationId,
      status: IssueStatus.Todo,
    });
    await withDb((db) =>
      db.artifact.update({
        where: { id: documentId, organizationId },
        data: { priority: Priority.Medium },
      })
    );

    let firstResult:
      | Awaited<ReturnType<typeof documentStatusMutationService.updateDocument>>
      | undefined;
    const holder = await holdRowLock(async () => {
      firstResult = await documentStatusMutationService.updateDocument(
        documentId,
        organizationId,
        { priority: Priority.High }
      );
    });

    const reverting = documentStatusMutationService.updateDocument(
      documentId,
      organizationId,
      { priority: Priority.Medium }
    );
    const waitedForFirstCommit = await holder.waitForWaiters(1);
    await holder.release();
    const secondResult = await reverting;

    expect(waitedForFirstCommit).toBe(true);
    expect(firstResult).toMatchObject({
      ok: true,
      value: {
        written: true,
        previous: { priority: Priority.Medium },
        document: { priority: Priority.High },
      },
    });
    expect(secondResult).toMatchObject({
      ok: true,
      value: {
        written: true,
        previous: { priority: Priority.High },
        document: { priority: Priority.Medium },
      },
    });
    await expect(
      withDb((db) =>
        db.artifact.findUniqueOrThrow({
          where: { id: documentId },
          select: { priority: true },
        })
      )
    ).resolves.toEqual({ priority: Priority.Medium });
  }, 20_000);
});
