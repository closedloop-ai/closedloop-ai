/**
 * Real-Postgres integration proof for the document-delete audit entry
 * (ISS-10029). The unit route suite
 * (`app/documents/[id]/route.delete-audit.test.ts`) pins the route wiring
 * against a fake Prisma; this suite pins what only a real database decides:
 *
 *   - the delete and its outbox row commit TOGETHER;
 *   - the delete FAILS CLOSED — when the audit enqueue cannot be made, the
 *     transaction aborts and the artifact is still in `artifacts`;
 *   - a `document.deleted` entry drained onto the chain carries the destroyed
 *     artifact's slug/title/subtype/status/project;
 *   - AC4: `auditLedgerService.verifyChain` still verifies a chain that
 *     contains a delete entry linked behind a status-changed entry;
 *   - the OTHER two paths that destroy a document leave the same record: a
 *     batch delete writes one entry per document, and a merge writes one for
 *     the secondary it consumes. Both previously bypassed the outbox entirely.
 *
 * Self-skips when DATABASE_URL is unset, matching the other integration
 * suites. Every row is namespaced under a freshly-created org and cleaned up
 * in afterAll (the org delete cascades to audit_entries and audit_outbox).
 */
import {
  AuditAction,
  AuditActorType,
  AuditObjectType,
} from "@repo/api/src/types/audit";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../../__tests__/utils/db-helpers";

const failEnqueue = vi.hoisted(() => ({ value: false }));

vi.mock("@/app/documents/room-utils", () => ({
  createDocumentRoom: vi.fn(),
  deleteDocumentRoom: vi.fn(async () => undefined),
}));

vi.mock("@/app/search/search-index-service", () => ({
  documentProjection: vi.fn(),
  searchIndexService: { removeAfterCommit: vi.fn() },
}));

/**
 * The merge case exercises the DB half of `documentMergeService.merge` — the
 * transaction that saves the merged version and destroys the secondary. The
 * model call in front of it is stubbed; what this suite decides is whether that
 * transaction leaves an audit record, not what the model wrote.
 */
vi.mock("@repo/ai/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/ai/server")>();
  return {
    ...actual,
    generateText: vi.fn(() =>
      Promise.resolve({ text: "# Merged body", finishReason: "stop" })
    ),
  };
});

/**
 * Fault injection for the fail-closed case: only `enqueueAuditEvent` is
 * wrapped, and only while `failEnqueue.value` is set. Everything else in the
 * module — including the real drain used by the AC4 case — stays real, and
 * real Postgres decides whether the artifact survives the aborted transaction.
 */
vi.mock("@/app/audit/audit-emit-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/audit/audit-emit-service")>();
  return {
    ...actual,
    enqueueAuditEvent: (
      input: Parameters<typeof actual.enqueueAuditEvent>[0]
    ) => {
      if (failEnqueue.value) {
        return Promise.reject(new Error("audit_outbox insert failed"));
      }
      return actual.enqueueAuditEvent(input);
    },
  };
});

import {
  drainAuditOutbox,
  userAuditActor,
} from "@/app/audit/audit-emit-service";
import { auditLedgerService } from "@/app/audit/audit-ledger-service";
import { documentService } from "./document-service";
import { documentMergeService } from "./merge-service";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

const createdOrgIds: string[] = [];

type SeedOverrides = { slug?: string; title?: string };

async function seedDocument(
  organizationId: string,
  overrides: SeedOverrides = {}
): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.DOCUMENT,
        subtype: "ISSUE",
        slug: overrides.slug ?? "ISS-0000",
        name: overrides.title ?? "Seeded document",
        status: IssueStatus.Todo,
      },
      select: { id: true },
    })
  );
  return artifact.id;
}

/**
 * A document complete enough for `documentMergeService.merge` to run against:
 * the artifact plus the `document_detail` row and version-1 body its
 * transaction reads. `seedDocument` deliberately stays bare — the delete paths
 * need nothing more, and every extra row is one more thing a delete case would
 * be silently asserting about.
 */
async function seedMergeableDocument(
  organizationId: string,
  userId: string,
  projectId: string,
  slug: string
): Promise<string> {
  return await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        projectId,
        type: ArtifactType.DOCUMENT,
        subtype: "PRD",
        slug,
        name: `Document ${slug}`,
        status: DocumentStatus.Draft,
      },
      select: { id: true },
    });
    await db.documentDetail.create({
      data: {
        artifactId: artifact.id,
        latestVersion: 1,
        repositorySnapshot: Prisma.JsonNull,
      },
      select: { artifactId: true },
    });
    await db.documentVersion.create({
      data: {
        documentId: artifact.id,
        version: 1,
        content: `# ${slug} body`,
        createdById: userId,
      },
      select: { id: true },
    });
    return artifact.id;
  });
}

function artifactExists(id: string, organizationId: string): Promise<boolean> {
  return withDb(async (db) => {
    const row = await db.artifact.findUnique({
      where: { id, organizationId },
      select: { id: true },
    });
    return row !== null;
  });
}

afterAll(async () => {
  for (const id of createdOrgIds) {
    await withDb((db) => db.organization.deleteMany({ where: { id } })).catch(
      () => undefined
    );
  }
});

describe.skipIf(!hasDatabase)(
  "document delete audit entry (real Postgres)",
  () => {
    let organizationId: string;
    let actorUserId: string;

    beforeEach(async () => {
      failEnqueue.value = false;
      organizationId = await createTestOrganization();
      createdOrgIds.push(organizationId);
      const user = await createTestUser(organizationId);
      actorUserId = user.id;
    });

    it("commits the outbox row together with the artifact delete", async () => {
      const documentId = await seedDocument(organizationId, {
        slug: "ISS-9080",
        title: "Google Ads remarketing audiences",
      });

      await documentService.delete(
        documentId,
        organizationId,
        userAuditActor(actorUserId)
      );

      expect(await artifactExists(documentId, organizationId)).toBe(false);

      const rows = await withDb((db) =>
        db.auditOutbox.findMany({
          where: { organizationId },
          select: {
            action: true,
            actorType: true,
            actorId: true,
            objectType: true,
            objectId: true,
            detail: true,
          },
        })
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe(AuditAction.DocumentDeleted);
      expect(rows[0].actorType).toBe(AuditActorType.User);
      expect(rows[0].actorId).toBe(actorUserId);
      expect(rows[0].objectType).toBe(AuditObjectType.Document);
      expect(rows[0].objectId).toBe(documentId);
      expect(rows[0].detail).toMatchObject({
        slug: "ISS-9080",
        title: "Google Ads remarketing audiences",
        subtype: "ISSUE",
        status: IssueStatus.Todo,
        projectId: null,
      });
    });

    it("fails closed: an unwritable audit enqueue leaves the artifact in the table", async () => {
      const documentId = await seedDocument(organizationId);
      failEnqueue.value = true;

      await expect(
        documentService.delete(
          documentId,
          organizationId,
          userAuditActor(actorUserId)
        )
      ).rejects.toThrow();

      // The load-bearing assertion: the row the delete would have destroyed is
      // still there, so the delete rolled back with its unwritable audit entry.
      expect(await artifactExists(documentId, organizationId)).toBe(true);
      const rows = await withDb((db) =>
        db.auditOutbox.findMany({
          where: { organizationId },
          select: { id: true },
        })
      );
      expect(rows).toHaveLength(0);
    });

    it("verifies the chain once a drained delete entry is on it", async () => {
      const documentId = await seedDocument(organizationId, {
        slug: "ISS-9081",
      });

      // A pre-existing action, so the delete entry is verified as a LINK in a
      // chain rather than as a lone genesis row.
      await auditLedgerService.append({
        organizationId,
        action: AuditAction.DocumentStatusChanged,
        actorType: AuditActorType.User,
        actorId: actorUserId,
        objectType: AuditObjectType.Document,
        objectId: documentId,
        detail: { from: IssueStatus.Todo, to: IssueStatus.InReview },
      });

      await documentService.delete(
        documentId,
        organizationId,
        userAuditActor(actorUserId)
      );
      await drainAuditOutbox();

      const entries = await withDb((db) =>
        db.auditEntry.findMany({
          where: { organizationId },
          orderBy: { seq: "asc" },
          select: { action: true, objectId: true, detail: true },
        })
      );
      expect(entries.map((entry) => entry.action)).toEqual([
        AuditAction.DocumentStatusChanged,
        AuditAction.DocumentDeleted,
      ]);
      expect(entries[1].objectId).toBe(documentId);
      expect(entries[1].detail).toMatchObject({ slug: "ISS-9081" });

      expect(await auditLedgerService.verifyChain(organizationId)).toEqual({
        ok: true,
      });
    });

    it("writes one entry per document for a batch delete", async () => {
      const first = await seedDocument(organizationId, {
        slug: "ISS-9082",
        title: "First batched document",
      });
      const second = await seedDocument(organizationId, {
        slug: "ISS-9083",
        title: "Second batched document",
      });
      const missing = "00000000-0000-4000-8000-0000000000ff";

      // A literal, not `newBulkTransactionId()`: a fixture built from the
      // production minter agrees with the production minter's own mistake.
      const transactionId = "6f1f0f2a-0a1e-4a6f-9d2b-8a7c1e4f0d33";

      const result = await documentService.batchDelete(
        [first, second, missing],
        organizationId,
        userAuditActor(actorUserId),
        transactionId
      );

      expect([...result.deletedIds].sort()).toEqual([first, second].sort());
      expect(result.failedIds).toEqual([missing]);
      expect(await artifactExists(first, organizationId)).toBe(false);
      expect(await artifactExists(second, organizationId)).toBe(false);

      const rows = await withDb((db) =>
        db.auditOutbox.findMany({
          where: { organizationId },
          orderBy: { objectId: "asc" },
          select: {
            action: true,
            actorType: true,
            actorId: true,
            objectType: true,
            objectId: true,
            detail: true,
          },
        })
      );

      // Per document, not one entry for the batch: the ledger has to be able to
      // answer "who deleted THIS document", and an id the batch never matched
      // must not produce a record of a delete that did not happen.
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.objectId).sort()).toEqual(
        [first, second].sort()
      );
      for (const row of rows) {
        expect(row.action).toBe(AuditAction.DocumentDeleted);
        expect(row.actorType).toBe(AuditActorType.User);
        expect(row.actorId).toBe(actorUserId);
        expect(row.objectType).toBe(AuditObjectType.Document);
      }
      const byId = new Map(rows.map((row) => [row.objectId, row.detail]));
      expect(byId.get(first)).toMatchObject({
        slug: "ISS-9082",
        title: "First batched document",
        status: IssueStatus.Todo,
      });
      expect(byId.get(second)).toMatchObject({
        slug: "ISS-9083",
        title: "Second batched document",
        status: IssueStatus.Todo,
      });
      // ISS-9465 ruling 6: both entries of ONE batch carry ONE transaction id,
      // which is what makes them recoverable as a group from an append-only
      // table that has no other way to say they were one action.
      for (const row of rows) {
        expect(row.detail).toMatchObject({ transactionId });
      }
    });

    it("writes an entry for the secondary document a merge destroys", async () => {
      const projectId = await createTestProject(organizationId, actorUserId);
      const primaryId = await seedMergeableDocument(
        organizationId,
        actorUserId,
        projectId,
        "PRD-9090"
      );
      const secondaryId = await seedMergeableDocument(
        organizationId,
        actorUserId,
        projectId,
        "PRD-9091"
      );

      const merged = await documentMergeService.merge(
        primaryId,
        secondaryId,
        organizationId,
        actorUserId
      );

      expect(merged.ok).toBe(true);
      // A merge destroys the secondary as hard as a delete does.
      expect(await artifactExists(secondaryId, organizationId)).toBe(false);
      expect(await artifactExists(primaryId, organizationId)).toBe(true);

      const rows = await withDb((db) =>
        db.auditOutbox.findMany({
          where: { organizationId },
          select: {
            action: true,
            actorType: true,
            actorId: true,
            objectType: true,
            objectId: true,
            detail: true,
          },
        })
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe(AuditAction.DocumentDeleted);
      expect(rows[0].actorType).toBe(AuditActorType.User);
      expect(rows[0].actorId).toBe(actorUserId);
      expect(rows[0].objectType).toBe(AuditObjectType.Document);
      expect(rows[0].objectId).toBe(secondaryId);
      expect(rows[0].detail).toMatchObject({
        slug: "PRD-9091",
        title: "Document PRD-9091",
        subtype: "PRD",
        status: DocumentStatus.Draft,
        projectId,
        // The one field a plain delete has no use for: without it the entry
        // says the document vanished and nothing says where its content went.
        mergedIntoId: primaryId,
      });
    });
  }
);
