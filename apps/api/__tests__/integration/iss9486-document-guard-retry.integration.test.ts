/**
 * ISS-9486 ruling 2 on `PUT /documents/{id}` against a real Postgres.
 *
 * The single-document write guards through a compare-and-set `where`. Ruling 2
 * widened that predicate to `status IN (expected, requested)` and
 * `(priority = expected OR priority = requested)`; a unit test can only pin the
 * shape handed to Prisma, so this proves Postgres answers it the way the rule
 * says: a retry of a committed write succeeds, and a stale guard still refuses.
 * The racing case commits for real: under an outer test transaction the row
 * lock the guarded write takes would be held by the harness and prove nothing.
 */
import { ArtifactPriorityMutationErrorCode } from "@repo/api/src/types/artifact-priority-mutation";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import { DocumentStatusMutationErrorCode } from "@repo/api/src/types/document-status-mutation";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { documentStatusMutationService } from "@/app/documents/document-status-mutation-service";
import { holdRowLock } from "../support/row-lock-holder";
import {
  autoRollbackTransaction,
  createCommittedTestOrganizationTracker,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizations = createCommittedTestOrganizationTracker();
const BACKDATED_AT = new Date("2026-01-01T00:00:00.000Z");

describe.skipIf(!hasDatabase)(
  "ISS-9486 PUT /documents same-value retry against real Postgres",
  () => {
    it("accepts a retried status write whose expectation the first attempt moved off", async () => {
      await autoRollbackTransaction(async () => {
        const { organizationId, documentId } = await seedIssue();
        const write = {
          expectedStatus: IssueStatus.InProgress,
          status: IssueStatus.Done,
        };

        const first = await documentStatusMutationService.updateDocument(
          documentId,
          organizationId,
          write
        );
        await backdateUpdatedAt(documentId);
        const retry = await documentStatusMutationService.updateDocument(
          documentId,
          organizationId,
          write
        );
        const afterRetry = await readRow(documentId);
        const moved = await documentStatusMutationService.updateDocument(
          documentId,
          organizationId,
          { ...write, status: IssueStatus.Blocked }
        );

        expect([first.ok, retry.ok]).toEqual([true, true]);
        // The retry wrote nothing, so `@updatedAt` did not move.
        expect(afterRetry.updatedAt).toEqual(BACKDATED_AT);
        expect(moved.ok ? null : moved.error.code).toBe(
          DocumentStatusMutationErrorCode.StaleStatus
        );
        await expect(readRow(documentId)).resolves.toMatchObject({
          status: IssueStatus.Done,
        });
      });
    });

    it("accepts a retried priority write under a null expectation, and still refuses a different value", async () => {
      await autoRollbackTransaction(async () => {
        const { organizationId, documentId } = await seedIssue();
        const write = { expectedPriority: null, priority: Priority.High };

        const first = await documentStatusMutationService.updateDocument(
          documentId,
          organizationId,
          write
        );
        await backdateUpdatedAt(documentId);
        const retry = await documentStatusMutationService.updateDocument(
          documentId,
          organizationId,
          write
        );
        const afterRetry = await readRow(documentId);
        const moved = await documentStatusMutationService.updateDocument(
          documentId,
          organizationId,
          { ...write, priority: Priority.Low }
        );

        expect([first.ok, retry.ok]).toEqual([true, true]);
        // The retry wrote nothing, so `@updatedAt` did not move.
        expect(afterRetry.updatedAt).toEqual(BACKDATED_AT);
        expect(moved.ok ? null : moved.error.code).toBe(
          ArtifactPriorityMutationErrorCode.StalePriority
        );
        await expect(readRow(documentId)).resolves.toMatchObject({
          priority: Priority.High,
        });
      });
    });

    describe("racing copies of one guarded write", () => {
      afterEach(async () => {
        await organizations.cleanup();
      });

      it("reports the transition once, so the route's side effects fire once", async () => {
        const { organizationId, documentId } = await seedIssue(
          await organizations.create()
        );
        const write = {
          expectedStatus: IssueStatus.InProgress,
          status: IssueStatus.Done,
        };
        const holder = await holdRowLock((tx) =>
          tx.artifact.update({
            where: { id: documentId },
            data: { name: "iss-9486 held row" },
            select: { id: true },
          })
        );

        const copies = [1, 2].map(() =>
          documentStatusMutationService.updateDocument(
            documentId,
            organizationId,
            write
          )
        );
        const blocked = await holder.waitForWaiters(copies.length);
        await holder.release();
        const results = await Promise.all(copies);

        expect(blocked).toBe(true);
        expect(results.map((result) => result.ok)).toEqual([true, true]);
        const transitions = results.filter(
          (result) =>
            result.ok &&
            result.value.previous.status !== result.value.document.status
        );
        expect(transitions).toHaveLength(1);
        await expect(readRow(documentId)).resolves.toMatchObject({
          status: IssueStatus.Done,
        });
      }, 20_000);
    });
  }
);

async function seedIssue(existingOrganizationId?: string): Promise<{
  organizationId: string;
  documentId: string;
}> {
  const organizationId =
    existingOrganizationId ?? (await createTestOrganization());
  const user = await createTestUser(organizationId);
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        createdById: user.id,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.FEATURE,
        name: "iss-9486 retried issue",
        slug: null,
        status: IssueStatus.InProgress,
        priority: null,
      },
      select: { id: true },
    })
  );
  return { organizationId, documentId: artifact.id };
}

function readRow(id: string) {
  return withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id },
      select: { status: true, priority: true, updatedAt: true },
    })
  );
}

function backdateUpdatedAt(id: string) {
  return withDb((db) =>
    db.artifact.update({
      where: { id },
      data: { updatedAt: BACKDATED_AT },
      select: { id: true },
    })
  );
}
