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
import {
  documentStatusMutationService,
  lockDocumentRows,
} from "../document-status-mutation-service";

describe("documentStatusMutationService branch coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.tx.mockImplementation((handler: (tx: unknown) => unknown) =>
      handler(makeTx(mocks))
    );
    mocks.withDb.mockImplementation((handler: (db: unknown) => unknown) =>
      handler(makeTx(mocks))
    );
  });

  it("returns not-found when the single document does not exist", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(null);

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { status: IssueStatus.Done }
    );

    expect(result.ok).toBe(false);
    expect(tx.artifact.update).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: Status.NotFound,
        code: DocumentStatusMutationErrorCode.ArtifactsNotFound,
        details: { missingDocuments: [{ documentId: DOC_ID }] },
      });
    }
  });

  it("rethrows an unguarded write failure whose Prisma code is not P2025", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress })
    );
    const unrelatedError = Object.assign(new Error("unique violation"), {
      code: "P2002",
    });
    tx.artifact.update.mockRejectedValueOnce(unrelatedError);

    await expect(
      documentStatusMutationService.updateDocument(DOC_ID, ORG_ID, {
        status: IssueStatus.Done,
      })
    ).rejects.toThrow(unrelatedError);
    // A non-P2025 failure is not a compare-and-set miss, so classification
    // never re-reads the row to look for a stale guard.
    expect(tx.artifact.findUnique).toHaveBeenCalledTimes(1);
  });

  it("classifies a P2025 failure as not-found when the document has since been deleted", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique
      .mockResolvedValueOnce(artifactRow({ status: IssueStatus.InProgress }))
      .mockResolvedValueOnce(null);
    const staleWrite = Object.assign(new Error("stale write"), {
      code: "P2025",
    });
    tx.artifact.update.mockRejectedValueOnce(staleWrite);

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { status: IssueStatus.Done }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: Status.NotFound,
        code: DocumentStatusMutationErrorCode.ArtifactsNotFound,
        details: { missingDocuments: [{ documentId: DOC_ID }] },
      });
    }
  });

  it("resolves an empty document id list without querying the database", async () => {
    const tx = makeTx(mocks);

    const rows = await lockDocumentRows(
      tx as unknown as Parameters<typeof lockDocumentRows>[0],
      [],
      ORG_ID
    );

    expect(rows).toEqual([]);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects a single-document update whose status is invalid for the subtype", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({
        status: IssueStatus.InProgress,
        subtype: DocumentType.Feature,
      })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { status: DocumentStatus.Approved }
    );

    expect(result.ok).toBe(false);
    expect(tx.artifact.update).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: Status.BadRequest,
        code: DocumentStatusMutationErrorCode.InvalidStatusForSubtype,
        details: {
          invalidStatuses: [
            {
              documentId: DOC_ID,
              targetStatus: DocumentStatus.Approved,
              subtype: DocumentType.Feature,
            },
          ],
        },
      });
    }
  });

  it("rejects a single-document update naming an assigneeId outside the organization", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress })
    );
    tx.user.findFirst.mockResolvedValue(null);

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { assigneeId: "00000000-0000-0000-0000-000000000099" }
    );

    expect(result.ok).toBe(false);
    expect(tx.artifact.update).not.toHaveBeenCalled();
    // The membership check is scoped to THIS organization, not a global user
    // lookup — a different org's assigneeId must not resolve here either.
    expect(tx.user.findFirst).toHaveBeenCalledWith({
      where: {
        id: "00000000-0000-0000-0000-000000000099",
        organizationId: ORG_ID,
      },
      select: { id: true },
    });
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: Status.BadRequest,
        code: DocumentStatusMutationErrorCode.InvalidReference,
        details: {
          field: "assigneeId",
          id: "00000000-0000-0000-0000-000000000099",
        },
      });
    }
  });

  it("rejects a single-document update naming an approverId outside the organization", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress })
    );
    tx.user.findFirst.mockResolvedValue(null);

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { approverId: "00000000-0000-0000-0000-000000000098" }
    );

    expect(result.ok).toBe(false);
    expect(tx.artifact.update).not.toHaveBeenCalled();
    expect(tx.user.findFirst).toHaveBeenCalledWith({
      where: {
        id: "00000000-0000-0000-0000-000000000098",
        organizationId: ORG_ID,
      },
      select: { id: true },
    });
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: Status.BadRequest,
        code: DocumentStatusMutationErrorCode.InvalidReference,
        details: {
          field: "approverId",
          id: "00000000-0000-0000-0000-000000000098",
        },
      });
    }
  });

  it("rejects a single-document update naming a projectId that does not resolve", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress })
    );
    tx.project.findUnique.mockResolvedValue(null);

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { projectId: "00000000-0000-0000-0000-000000000097" }
    );

    expect(result.ok).toBe(false);
    expect(tx.artifact.update).not.toHaveBeenCalled();
    expect(tx.project.findUnique).toHaveBeenCalledWith({
      where: {
        id: "00000000-0000-0000-0000-000000000097",
        organizationId: ORG_ID,
      },
      select: { id: true },
    });
    if (!result.ok) {
      expect(result.error).toMatchObject({
        status: Status.BadRequest,
        code: DocumentStatusMutationErrorCode.InvalidReference,
        details: {
          field: "projectId",
          id: "00000000-0000-0000-0000-000000000097",
        },
      });
    }
  });

  it("accepts a single-document update naming a projectId that resolves in the organization", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    tx.artifact.findUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress })
    );
    tx.project.findUnique.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000096",
    });
    tx.artifact.update.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { projectId: "00000000-0000-0000-0000-000000000096" }
    );

    expect(result.ok).toBe(true);
    expect(tx.project.findUnique).toHaveBeenCalledWith({
      where: {
        id: "00000000-0000-0000-0000-000000000096",
        organizationId: ORG_ID,
      },
      select: { id: true },
    });
    expect(tx.artifact.update).toHaveBeenCalled();
  });

  // Every per-field compare-and-set guard admits "no change requested" as well
  // as "already the target" (ISS-9486 ruling 2, ISS-9440, ISS-11198). This
  // pins the simple `{field: expected}` shape each guard returns on that path,
  // as opposed to the two-value OR/AND shape asserted by the sibling tests
  // above where the requested value actually differs from the guard.
  it("emits the plain compare-and-set predicate for every guard whose requested value is unchanged", async () => {
    const tx = makeTx(mocks);
    mocks.withDb.mockImplementation((handler: (db: typeof tx) => unknown) =>
      handler(tx)
    );
    const previous = artifactRow({
      name: "Stable title",
      status: IssueStatus.InProgress,
      priority: Priority.Medium,
      assigneeId: null,
    });
    tx.artifact.findUnique.mockResolvedValue(previous);
    tx.artifact.update.mockResolvedValue(
      artifactRow({
        name: "Stable title",
        status: IssueStatus.InProgress,
        priority: Priority.Medium,
        assigneeId: null,
      })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      {
        expectedStatus: IssueStatus.InProgress,
        expectedPriority: Priority.Medium,
        expectedTitle: "Stable title",
        expectedAssigneeId: null,
        // fileName is not one of the four guarded fields, so this is a real
        // change and the write proceeds instead of short-circuiting as a
        // guarded retry.
        fileName: "changed.md",
      }
    );

    // `written` is what PUT /documents/[id] gates indexDocumentProjection on.
    expect(result).toMatchObject({ ok: true, value: { written: true } });
    expect(tx.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: DOC_ID,
          organizationId: ORG_ID,
          status: IssueStatus.InProgress,
          priority: Priority.Medium,
          name: "Stable title",
          assigneeId: null,
          type: "DOCUMENT",
        }),
      })
    );
    const where = tx.artifact.update.mock.calls[0][0].where;
    // The unchanged-value path never introduces the two-sided OR/AND shape.
    expect(where).not.toHaveProperty("OR");
    expect(where).not.toHaveProperty("AND");
  });
});
