import { ArtifactPriorityMutationErrorCode } from "@repo/api/src/types/artifact-priority-mutation";
import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { DocumentStatusMutationErrorCode } from "@repo/api/src/types/document-status-mutation";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  artifactFindUnique: vi.fn(),
  artifactUpdate: vi.fn(),
  artifactUpdateMany: vi.fn(),
  indexDocumentProjection: vi.fn(),
  projectFindUnique: vi.fn(),
  queryRaw: vi.fn(),
  userFindFirst: vi.fn(),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  ArtifactType: { DOCUMENT: "DOCUMENT" },
  Prisma: {
    join: (values: unknown[], separator = ",") => ({
      sql: values.map(() => "?").join(separator),
      values,
    }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      sql: strings.join("?"),
      values,
    }),
  },
  withDb: mocks.withDb,
}));

vi.mock("@/app/documents/document-service", () => ({
  indexDocumentProjection: mocks.indexDocumentProjection,
}));

import {
  artifactRow,
  DOC_ID,
  makeTx,
  ORG_ID,
} from "@/__tests__/support/documents/document-single-update.test-fixtures";
import { buildDocumentStatusMutation } from "../document-status-mutation-capability";
import { documentStatusMutationService } from "../document-status-mutation-service";

const OTHER_DOC_ID = "00000000-0000-0000-0000-000000000012";
const TARGET_PROJECT_ID = "00000000-0000-0000-0000-000000000014";

describe("documentStatusMutationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.tx.mockImplementation((handler: (tx: unknown) => unknown) =>
      handler(makeTx(mocks))
    );
    mocks.withDb.mockImplementation((handler: (db: unknown) => unknown) =>
      handler(makeTx(mocks))
    );
  });

  it("describes the allowed status vocabulary for a document subtype", () => {
    expect(buildDocumentStatusMutation(DocumentType.Feature)).toEqual({
      allowedStatuses: [
        IssueStatus.Triage,
        IssueStatus.Backlog,
        IssueStatus.Todo,
        IssueStatus.InProgress,
        IssueStatus.InReview,
        IssueStatus.Blocked,
        IssueStatus.Done,
        IssueStatus.Canceled,
      ],
      expectedStatusField: "expectedStatus",
      expectedStatusByIdField: "expectedStatusById",
    });
  });

  it("locks batch rows and updates only rows that transition", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.tx.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.$queryRaw.mockResolvedValue([
      {
        id: DOC_ID,
        status: IssueStatus.InProgress,
        subtype: DocumentType.Feature,
      },
      {
        id: OTHER_DOC_ID,
        status: IssueStatus.Done,
        subtype: DocumentType.Feature,
      },
    ]);

    const result = await documentStatusMutationService.batchUpdateStatus(
      [DOC_ID, OTHER_DOC_ID],
      IssueStatus.Done,
      ORG_ID
    );

    expect(result.ok).toBe(true);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][0].sql).toContain("FOR NO KEY UPDATE");
    expect(tx.artifact.updateMany).toHaveBeenCalledWith({
      data: { status: IssueStatus.Done },
      where: {
        id: { in: [DOC_ID] },
        organizationId: ORG_ID,
        type: "DOCUMENT",
      },
    });
    if (result.ok) {
      expect(result.value).toEqual({
        updatedIds: [DOC_ID, OTHER_DOC_ID],
        changedIds: [DOC_ID],
        transitions: [
          {
            documentId: DOC_ID,
            before: IssueStatus.InProgress,
            after: IssueStatus.Done,
          },
        ],
      });
    }
  });

  it("writes nothing when every requested row already holds the target status", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.tx.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.$queryRaw.mockResolvedValue([
      {
        id: DOC_ID,
        status: IssueStatus.Done,
        subtype: DocumentType.Feature,
      },
      {
        id: OTHER_DOC_ID,
        status: IssueStatus.Done,
        subtype: DocumentType.Feature,
      },
    ]);

    const result = await documentStatusMutationService.batchUpdateStatus(
      [DOC_ID, OTHER_DOC_ID],
      IssueStatus.Done,
      ORG_ID
    );

    expect(result.ok).toBe(true);
    // Guarded, not merely empty: without the guard this path sends
    // `updateMany` with `id: { in: [] }`. The per-item sibling pins the same
    // guard from the other caller.
    expect(tx.artifact.updateMany).not.toHaveBeenCalled();
    if (result.ok) {
      expect(result.value).toEqual({
        updatedIds: [DOC_ID, OTHER_DOC_ID],
        changedIds: [],
        transitions: [],
      });
    }
  });

  it("rejects a batch when any target subtype cannot accept the requested status", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.tx.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.$queryRaw.mockResolvedValue([
      {
        id: DOC_ID,
        status: IssueStatus.InProgress,
        subtype: DocumentType.Feature,
      },
    ]);

    const result = await documentStatusMutationService.batchUpdateStatus(
      [DOC_ID],
      DocumentStatus.Approved,
      ORG_ID
    );

    expect(result.ok).toBe(false);
    expect(tx.artifact.updateMany).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: Status.BadRequest,
        code: DocumentStatusMutationErrorCode.InvalidStatusForSubtype,
      });
    }
  });

  it("returns a batch missing-selection result as a 400 before writing", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.tx.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.$queryRaw.mockResolvedValue([]);

    const result = await documentStatusMutationService.batchUpdateStatus(
      [DOC_ID],
      IssueStatus.Done,
      ORG_ID
    );

    expect(result.ok).toBe(false);
    expect(tx.artifact.updateMany).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: Status.BadRequest,
        code: DocumentStatusMutationErrorCode.ArtifactsNotFound,
        details: { missingDocuments: [{ documentId: DOC_ID }] },
      });
    }
  });

  it("rejects a stale batch before writing", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.tx.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.$queryRaw.mockResolvedValue([
      {
        id: DOC_ID,
        status: IssueStatus.InReview,
        subtype: DocumentType.Feature,
      },
    ]);

    const result = await documentStatusMutationService.batchUpdateStatus(
      [DOC_ID],
      IssueStatus.Done,
      ORG_ID,
      { [DOC_ID]: IssueStatus.InProgress }
    );

    expect(result.ok).toBe(false);
    expect(tx.artifact.updateMany).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: Status.Conflict,
        code: DocumentStatusMutationErrorCode.StaleStatus,
        details: {
          staleStatuses: [
            {
              documentId: DOC_ID,
              currentStatus: IssueStatus.InReview,
              expectedStatus: IssueStatus.InProgress,
            },
          ],
        },
      });
    }
  });

  it("rejects a stale single-document update before writing", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InReview })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      {
        expectedStatus: IssueStatus.InProgress,
        status: IssueStatus.Done,
      }
    );

    expect(result.ok).toBe(false);
    expect(tx.artifact.update).not.toHaveBeenCalled();
    // ISS-9486: a guarded write reads and writes under the row lock, so two
    // racing copies of one write cannot both see the old value.
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw.mock.calls[0][0].sql).toContain("FOR NO KEY UPDATE");
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: Status.Conflict,
        code: DocumentStatusMutationErrorCode.StaleStatus,
      });
    }
  });

  it("strips the expectedStatus guard before writing a valid single-document update", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress })
    );
    tx.artifact.update.mockResolvedValue(
      artifactRow({ name: "Done ticket", status: IssueStatus.Done })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      {
        expectedStatus: IssueStatus.InProgress,
        status: IssueStatus.Done,
        title: "Done ticket",
      }
    );

    expect(result.ok).toBe(true);
    expect(tx.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Done ticket",
          status: IssueStatus.Done,
        }),
        // ISS-9486 ruling 2: the guard also admits the target, so a retry of
        // a committed write is not refused by its own result.
        where: expect.objectContaining({
          id: DOC_ID,
          organizationId: ORG_ID,
          status: { in: [IssueStatus.InProgress, IssueStatus.Done] },
          type: "DOCUMENT",
        }),
      })
    );
    expect(tx.artifact.update.mock.calls[0][0].data).not.toHaveProperty(
      "expectedStatus"
    );
    // ISS-9486: a guarded write reads and writes under the row lock, so two
    // racing copies of one write cannot both see the old value.
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw.mock.calls[0][0].sql).toContain("FOR NO KEY UPDATE");
    expect(mocks.indexDocumentProjection).not.toHaveBeenCalled();
  });

  it("still writes a guarded retry that also changes another field", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.Done })
    );
    tx.artifact.update.mockResolvedValue(
      artifactRow({ name: "Renamed", status: IssueStatus.Done })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      {
        expectedStatus: IssueStatus.InProgress,
        status: IssueStatus.Done,
        title: "Renamed",
      }
    );

    expect(result.ok).toBe(true);
    expect(tx.artifact.update).toHaveBeenCalledTimes(1);
    expect(mocks.indexDocumentProjection).not.toHaveBeenCalled();
  });

  it("leaves the search projection to its caller, indexing nothing itself", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress })
    );
    tx.artifact.update.mockResolvedValue(
      artifactRow({ status: IssueStatus.Done })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      {
        status: IssueStatus.Done,
      }
    );

    expect(result.ok).toBe(true);
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw.mock.calls[0][0].sql).toContain("FOR NO KEY UPDATE");
    // ISS-10993: the mutation service owns the row lock and transaction facts,
    // while `PUT /documents/[id]` still owns post-commit projection ordering.
    // Indexing from this service again is the regression this case guards.
    expect(mocks.indexDocumentProjection).not.toHaveBeenCalled();
  });

  it("maps a compare-and-set miss during a single-document update to stale_status", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique
      .mockResolvedValueOnce(artifactRow({ status: IssueStatus.InProgress }))
      .mockResolvedValueOnce({ id: DOC_ID, status: IssueStatus.InReview });
    tx.artifact.update.mockRejectedValueOnce(
      Object.assign(new Error("stale write"), { code: "P2025" })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      {
        expectedStatus: IssueStatus.InProgress,
        status: IssueStatus.Done,
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: Status.Conflict,
        code: DocumentStatusMutationErrorCode.StaleStatus,
        details: {
          staleStatuses: [
            {
              documentId: DOC_ID,
              currentStatus: IssueStatus.InReview,
              expectedStatus: IssueStatus.InProgress,
            },
          ],
        },
      });
    }
  });

  it("does not map a missing detail row to stale_status when the guarded status still matches", async () => {
    const tx = makeTx(mocks);
    const detailMissingError = Object.assign(
      new Error("missing document detail"),
      { code: "P2025" }
    );
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique
      .mockResolvedValueOnce(artifactRow({ status: IssueStatus.InProgress }))
      .mockResolvedValueOnce({ id: DOC_ID, status: IssueStatus.InProgress });
    tx.artifact.update.mockRejectedValueOnce(detailMissingError);

    await expect(
      documentStatusMutationService.updateDocument(DOC_ID, ORG_ID, {
        expectedStatus: IssueStatus.InProgress,
        fileName: "missing-detail.md",
        status: IssueStatus.Done,
      })
    ).rejects.toThrow(detailMissingError);

    expect(tx.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          document: { update: { fileName: "missing-detail.md" } },
        }),
        // ISS-9486 ruling 2: the guard also admits the target, so a retry of
        // a committed write is not refused by its own result.
        where: expect.objectContaining({
          id: DOC_ID,
          organizationId: ORG_ID,
          status: { in: [IssueStatus.InProgress, IssueStatus.Done] },
          type: "DOCUMENT",
        }),
      })
    );
    // ISS-9486: a guarded write reads and writes under the row lock, so two
    // racing copies of one write cannot both see the old value.
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw.mock.calls[0][0].sql).toContain("FOR NO KEY UPDATE");
    expect(mocks.indexDocumentProjection).not.toHaveBeenCalled();
  });

  // ISS-9440. The status guard already existed; this is the priority twin, and
  // the two report separately so a caller that sent both is told which moved.
  it("rejects a stale single-document priority update before writing", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, priority: Priority.High })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { expectedPriority: Priority.Low, priority: Priority.Urgent }
    );

    expect(result.ok).toBe(false);
    expect(tx.artifact.update).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: Status.Conflict,
        code: ArtifactPriorityMutationErrorCode.StalePriority,
        details: {
          stalePriorities: [
            {
              documentId: DOC_ID,
              currentPriority: Priority.High,
              expectedPriority: Priority.Low,
            },
          ],
        },
      });
    }
  });

  // `null` is an assertion about the stored value, not an absent guard: it must
  // reach the predicate as `priority: null` (SQL `IS NULL`), and an artifact
  // that DOES hold a priority must fail it.
  it("guards an expectation of no priority, and refuses when one is set", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, priority: null })
    );
    tx.artifact.update.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, priority: Priority.High })
    );

    const honored = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { expectedPriority: null, priority: Priority.High }
    );

    expect(honored.ok).toBe(true);
    expect(tx.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        // ISS-9486 ruling 2: unset OR already the target.
        where: expect.objectContaining({
          id: DOC_ID,
          organizationId: ORG_ID,
          OR: [{ priority: null }, { priority: Priority.High }],
          type: "DOCUMENT",
        }),
      })
    );
    // The guard is a predicate, never a column write.
    expect(tx.artifact.update.mock.calls[0][0].data).not.toHaveProperty(
      "expectedPriority"
    );

    vi.clearAllMocks();
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, priority: Priority.Low })
    );

    const refused = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { expectedPriority: null, priority: Priority.High }
    );

    expect(refused.ok).toBe(false);
    expect(tx.artifact.update).not.toHaveBeenCalled();
  });

  // The pre-write comparison reports a row that had ALREADY moved; only the
  // predicate catches one that moves between that read and the write. This is
  // that second case, and it is why the guard is in the `where` at all.
  it("maps a compare-and-set miss on priority to stale_priority", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique
      .mockResolvedValueOnce(
        artifactRow({ status: IssueStatus.InProgress, priority: Priority.Low })
      )
      .mockResolvedValueOnce({
        id: DOC_ID,
        status: IssueStatus.InProgress,
        priority: Priority.Urgent,
      });
    tx.artifact.update.mockRejectedValueOnce(
      Object.assign(new Error("stale write"), { code: "P2025" })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { expectedPriority: Priority.Low, priority: Priority.High }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: Status.Conflict,
        code: ArtifactPriorityMutationErrorCode.StalePriority,
        details: {
          stalePriorities: [
            {
              documentId: DOC_ID,
              currentPriority: Priority.Urgent,
              expectedPriority: Priority.Low,
            },
          ],
        },
      });
    }
  });

  // Version skew, old client -> new server: no guard key at all leaves the
  // predicate exactly as it was before ISS-9440, so an unguarded write still
  // lands. Asserting the ABSENCE of the key, because a `priority: undefined`
  // spread into a Prisma `where` is not the same statement.
  it("adds no priority predicate when the caller sends no expectation", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, priority: Priority.Low })
    );
    tx.artifact.update.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, priority: Priority.High })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { priority: Priority.High }
    );

    expect(result.ok).toBe(true);
    expect(tx.artifact.update.mock.calls[0][0].where).not.toHaveProperty(
      "priority"
    );
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw.mock.calls[0][0].sql).toContain("FOR NO KEY UPDATE");
  });

  it("locks a project-only write before deriving its transition facts", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    mocks.projectFindUnique.mockResolvedValue({ id: TARGET_PROJECT_ID });
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress })
    );
    tx.artifact.update.mockResolvedValue({
      ...artifactRow({ status: IssueStatus.InProgress }),
      projectId: TARGET_PROJECT_ID,
    });

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { projectId: TARGET_PROJECT_ID }
    );

    expect(result.ok).toBe(true);
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw.mock.calls[0][0].sql).toContain("FOR NO KEY UPDATE");
  });

  // ISS-9486 ruling 2: a write whose target is already stored is never stale,
  // so a retry of a committed write does not refuse its own result.
  it("accepts a batch row that already holds the target despite a stale expectation", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.tx.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.$queryRaw.mockResolvedValue([
      { id: DOC_ID, status: IssueStatus.Done, subtype: DocumentType.Feature },
    ]);

    const result = await documentStatusMutationService.batchUpdateStatus(
      [DOC_ID],
      IssueStatus.Done,
      ORG_ID,
      { [DOC_ID]: IssueStatus.InProgress }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.changedIds).toEqual([]);
    }
  });

  it("accepts a single-document retry whose status and priority are already stored, and writes nothing", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.Done, priority: Priority.High })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      {
        expectedStatus: IssueStatus.InProgress,
        status: IssueStatus.Done,
        expectedPriority: null,
        priority: Priority.High,
      }
    );

    expect(result.ok ? Object.keys(result.value).sort() : null).toEqual([
      "document",
      "previous",
      "written",
    ]);
    // `written` travels to `PUT /documents/[id]`, which owns the indexing since
    // ISS-10993, so the no-op is what the ROUTE gates its reindex on.
    expect(result.ok ? result.value.written : null).toBe(false);
    // No `updatedAt` bump and no reindex: the retry is a no-op.
    expect(tx.artifact.update).not.toHaveBeenCalled();
    expect(mocks.indexDocumentProjection).not.toHaveBeenCalled();
  });

  it("does not map a compare-and-set miss to stale_status when the row already holds the target", async () => {
    const tx = makeTx(mocks);
    const unrelated = Object.assign(new Error("missing document detail"), {
      code: "P2025",
    });
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique
      .mockResolvedValueOnce(artifactRow({ status: IssueStatus.InProgress }))
      .mockResolvedValueOnce({ id: DOC_ID, status: IssueStatus.Done });
    tx.artifact.update.mockRejectedValueOnce(unrelated);

    await expect(
      documentStatusMutationService.updateDocument(DOC_ID, ORG_ID, {
        expectedStatus: IssueStatus.InProgress,
        status: IssueStatus.Done,
      })
    ).rejects.toThrow(unrelated);
  });
});
