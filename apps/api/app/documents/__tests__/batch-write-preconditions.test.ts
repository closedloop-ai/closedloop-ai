/**
 * The ISS-9440 write-precondition layer shared by the status and priority batch
 * routes, pinned where the per-service suites leave it open.
 *
 * Both batches lock their target rows before deciding. They must lock in the
 * same order and mode: two batches over an overlapping selection that disagree
 * can deadlock (`40P01`), which the routes render as an unclassified 500 rather
 * than the retryable 409 the guard exists to give. `Prisma.sql` is mocked to
 * render its template, so the assertion reads the statement each service
 * actually sends.
 *
 * The v2 per-item siblings (ISS-9464) are held to the same clause here, because
 * their own suites stub the locked read and so can never see the statement it
 * sends: a v2 path that read the rows without locking them would leave every one
 * of those suites green.
 */
import { Priority } from "@repo/api/src/types/common";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import { DocumentStatusMutationErrorCode } from "@repo/api/src/types/document-status-mutation";
import { Status } from "@repo/api/src/types/result";
import { ArtifactType } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  artifactUpdateMany: vi.fn(),
  indexDocumentProjection: vi.fn(),
  queryRaw: vi.fn(),
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

import { artifactBulkPriorityService } from "../artifact-bulk-priority-service";
import { documentStatusBatchItemService } from "../document-status-batch-item-service";
import { documentStatusMutationService } from "../document-status-mutation-service";

const WHITESPACE = /\s+/g;
const CANONICAL_LOCK_TAIL = /ORDER BY "id" ASC FOR NO KEY UPDATE$/;

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const DOC_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_DOC_ID = "20000000-0000-4000-8000-000000000002";

const LOCKING_BATCHES = [
  {
    batch: "status batch",
    act: () =>
      documentStatusMutationService.batchUpdateStatus(
        [DOC_ID],
        IssueStatus.Done,
        ORG_ID
      ),
  },
  {
    batch: "priority batch",
    act: () =>
      artifactBulkPriorityService.batchUpdatePriority(
        [DOC_ID],
        Priority.High,
        ORG_ID
      ),
  },
];

const PER_ITEM_LOCKING_BATCHES = [
  {
    batch: "per-item status batch",
    act: () =>
      documentStatusBatchItemService.batchUpdateStatus(
        [DOC_ID],
        IssueStatus.Done,
        ORG_ID
      ),
  },
  {
    batch: "per-item priority batch",
    act: () =>
      artifactBulkPriorityService.batchUpdatePriorityPerItem(
        [DOC_ID],
        Priority.High,
        ORG_ID
      ),
  },
];

describe("batch write preconditions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.tx.mockImplementation((handler: (tx: unknown) => unknown) =>
      handler({
        $queryRaw: mocks.queryRaw,
        artifact: { updateMany: mocks.artifactUpdateMany },
      })
    );
  });

  it.each(LOCKING_BATCHES)(
    "$batch locks target rows with the canonical id-ordered clause shared by both batch services",
    async ({ act }) => {
      mocks.queryRaw.mockResolvedValue([]);

      await act();

      expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
      const normalized = mocks.queryRaw.mock.calls[0][0].sql
        .replace(WHITESPACE, " ")
        .trim();
      expect(normalized).toMatch(CANONICAL_LOCK_TAIL);
    }
  );

  it.each(PER_ITEM_LOCKING_BATCHES)(
    "$batch takes that same clause, so a v2 route cannot deadlock against its v1 sibling",
    async ({ act }) => {
      mocks.queryRaw.mockResolvedValue([]);

      await act();

      expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
      const normalized = mocks.queryRaw.mock.calls[0][0].sql
        .replace(WHITESPACE, " ")
        .trim();
      expect(normalized).toMatch(CANONICAL_LOCK_TAIL);
    }
  );

  it("guards only the ids a partial expectedStatusById map names", async () => {
    mocks.queryRaw.mockResolvedValue([
      {
        id: DOC_ID,
        status: IssueStatus.InProgress,
        subtype: DocumentType.Feature,
      },
      {
        id: OTHER_DOC_ID,
        status: IssueStatus.Backlog,
        subtype: DocumentType.Feature,
      },
    ]);

    const unguardedOmission =
      await documentStatusMutationService.batchUpdateStatus(
        [DOC_ID, OTHER_DOC_ID],
        IssueStatus.Done,
        ORG_ID,
        { [DOC_ID]: IssueStatus.InProgress }
      );

    expect(unguardedOmission).toMatchObject({
      ok: true,
      value: { changedIds: [DOC_ID, OTHER_DOC_ID] },
    });
    expect(mocks.artifactUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith({
      data: { status: IssueStatus.Done },
      where: {
        id: { in: [DOC_ID, OTHER_DOC_ID] },
        organizationId: ORG_ID,
        type: ArtifactType.DOCUMENT,
      },
    });

    mocks.artifactUpdateMany.mockClear();

    const guardedNamedId =
      await documentStatusMutationService.batchUpdateStatus(
        [DOC_ID, OTHER_DOC_ID],
        IssueStatus.Done,
        ORG_ID,
        { [DOC_ID]: IssueStatus.Todo }
      );

    expect(guardedNamedId).toMatchObject({
      ok: false,
      error: {
        status: Status.Conflict,
        code: DocumentStatusMutationErrorCode.StaleStatus,
        details: {
          staleStatuses: [
            {
              documentId: DOC_ID,
              currentStatus: IssueStatus.InProgress,
              expectedStatus: IssueStatus.Todo,
            },
          ],
        },
      },
    });
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
  });
});
