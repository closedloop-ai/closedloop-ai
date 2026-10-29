import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import { DocumentFieldMutationErrorCode } from "@repo/api/src/types/document-field-mutation";
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
import { documentStatusMutationService } from "../document-status-mutation-service";

const USER_ID = "00000000-0000-0000-0000-000000000014";
const OTHER_USER_ID = "00000000-0000-0000-0000-000000000015";

// ISS-11198: the title and assignee guards, which ride the same compare-and-set
// as status and priority.
describe("documentStatusMutationService title and assignee guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.tx.mockImplementation((handler: (tx: unknown) => unknown) =>
      handler(makeTx(mocks))
    );
    mocks.withDb.mockImplementation((handler: (db: unknown) => unknown) =>
      handler(makeTx(mocks))
    );
    // A write that should have been refused must reach the assertion that
    // says so, not crash on an unset mock.
    mocks.artifactUpdate.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress })
    );
  });

  it("refuses a stale title before writing", async () => {
    mocks.artifactFindUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, name: "Ticket" })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { expectedTitle: "Old ticket", title: "Renamed" }
    );

    expect(mocks.artifactUpdate).not.toHaveBeenCalled();
    expect(result.ok ? null : result.error).toEqual({
      status: Status.Conflict,
      code: DocumentFieldMutationErrorCode.StaleTitle,
      message: "One or more documents changed before the title update",
      details: {
        staleTitles: [
          {
            documentId: DOC_ID,
            currentTitle: "Ticket",
            expectedTitle: "Old ticket",
          },
        ],
      },
    });
  });

  it("puts the title guard in the org-scoped compare-and-set, under the row lock", async () => {
    mocks.artifactFindUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, name: "Ticket" })
    );
    mocks.artifactUpdate.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, name: "Renamed" })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { expectedTitle: "Ticket", title: "Renamed" }
    );

    expect(result.ok).toBe(true);
    const { where, data } = mocks.artifactUpdate.mock.calls[0][0];
    // Ruling 2: the stored title OR the one being written, so a retry of a
    // committed rename is not refused by its own result.
    expect(where).toEqual({
      id: DOC_ID,
      organizationId: ORG_ID,
      name: { in: ["Ticket", "Renamed"] },
      type: "DOCUMENT",
    });
    expect(data).toEqual({ name: "Renamed" });
    expect(mocks.queryRaw.mock.calls[0][0].sql).toContain("FOR NO KEY UPDATE");
  });

  it("adds no field predicate or row lock without a guard or audited field", async () => {
    mocks.artifactFindUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, name: "Moved on" })
    );
    mocks.artifactUpdate.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, name: "Renamed" })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { title: "Renamed", assigneeId: USER_ID }
    );

    expect(result.ok).toBe(true);
    expect(mocks.artifactUpdate.mock.calls[0][0].where).toEqual({
      id: DOC_ID,
      organizationId: ORG_ID,
      type: "DOCUMENT",
    });
    expect(mocks.withDb.tx).not.toHaveBeenCalled();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("reads a null assignee guard as 'unassigned', and refuses when someone is", async () => {
    mocks.artifactFindUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, assigneeId: null })
    );
    mocks.artifactUpdate.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, assigneeId: USER_ID })
    );

    const honored = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { expectedAssigneeId: null, assigneeId: USER_ID }
    );

    expect(honored.ok).toBe(true);
    expect(mocks.artifactUpdate.mock.calls[0][0].where).toEqual({
      id: DOC_ID,
      organizationId: ORG_ID,
      AND: [{ OR: [{ assigneeId: null }, { assigneeId: USER_ID }] }],
      type: "DOCUMENT",
    });

    vi.clearAllMocks();
    mocks.withDb.tx.mockImplementation((handler: (tx: unknown) => unknown) =>
      handler(makeTx(mocks))
    );
    mocks.withDb.mockImplementation((handler: (db: unknown) => unknown) =>
      handler(makeTx(mocks))
    );
    mocks.artifactFindUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, assigneeId: OTHER_USER_ID })
    );

    const refused = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { expectedAssigneeId: null, assigneeId: USER_ID }
    );

    expect(mocks.artifactUpdate).not.toHaveBeenCalled();
    expect(refused.ok ? null : refused.error).toMatchObject({
      status: Status.Conflict,
      code: DocumentFieldMutationErrorCode.StaleAssigneeId,
      details: {
        staleAssigneeIds: [
          {
            documentId: DOC_ID,
            currentAssigneeId: OTHER_USER_ID,
            expectedAssigneeId: null,
          },
        ],
      },
    });
  });

  it("keeps the priority predicate when an assignee guard rides the same write", async () => {
    mocks.artifactFindUnique.mockResolvedValue(
      artifactRow({
        status: IssueStatus.InProgress,
        priority: Priority.Low,
        assigneeId: USER_ID,
      })
    );
    mocks.artifactUpdate.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress })
    );

    await documentStatusMutationService.updateDocument(DOC_ID, ORG_ID, {
      expectedPriority: Priority.Low,
      priority: Priority.High,
      expectedAssigneeId: USER_ID,
      assigneeId: null,
    });

    expect(mocks.artifactUpdate.mock.calls[0][0].where).toEqual({
      id: DOC_ID,
      organizationId: ORG_ID,
      OR: [{ priority: Priority.Low }, { priority: Priority.High }],
      AND: [{ OR: [{ assigneeId: USER_ID }, { assigneeId: null }] }],
      type: "DOCUMENT",
    });
  });

  it("accepts a retried rename and reassignment already stored, and writes nothing", async () => {
    mocks.artifactFindUnique.mockResolvedValue(
      artifactRow({
        status: IssueStatus.InProgress,
        name: "Renamed",
        assigneeId: USER_ID,
      })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      {
        expectedTitle: "Ticket",
        title: "Renamed",
        expectedAssigneeId: null,
        assigneeId: USER_ID,
      }
    );

    expect(result.ok ? result.value.written : null).toBe(false);
    expect(mocks.artifactUpdate).not.toHaveBeenCalled();
  });

  it("locks the row for an assignee-only guard, and writes nothing on its retry", async () => {
    mocks.artifactFindUnique.mockResolvedValue(
      artifactRow({ status: IssueStatus.InProgress, assigneeId: USER_ID })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { expectedAssigneeId: null, assigneeId: USER_ID }
    );

    expect(result.ok ? result.value.written : null).toBe(false);
    expect(mocks.artifactUpdate).not.toHaveBeenCalled();
    expect(mocks.queryRaw.mock.calls[0][0].sql).toContain("FOR NO KEY UPDATE");
  });

  it("maps a compare-and-set miss on the title to stale_title", async () => {
    mocks.artifactFindUnique
      .mockResolvedValueOnce(
        artifactRow({ status: IssueStatus.InProgress, name: "Ticket" })
      )
      .mockResolvedValueOnce({
        id: DOC_ID,
        status: IssueStatus.InProgress,
        priority: Priority.Medium,
        name: "Renamed elsewhere",
        assigneeId: null,
      });
    mocks.artifactUpdate.mockRejectedValueOnce(
      Object.assign(new Error("stale write"), { code: "P2025" })
    );

    const result = await documentStatusMutationService.updateDocument(
      DOC_ID,
      ORG_ID,
      { expectedTitle: "Ticket", title: "Renamed" }
    );

    expect(result.ok ? null : result.error).toMatchObject({
      status: Status.Conflict,
      code: DocumentFieldMutationErrorCode.StaleTitle,
      details: {
        staleTitles: [
          {
            documentId: DOC_ID,
            currentTitle: "Renamed elsewhere",
            expectedTitle: "Ticket",
          },
        ],
      },
    });
  });
});
