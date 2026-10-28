/**
 * The per-item status batch behind `POST /documents/batch-update-status/v2`
 * (ISS-9464), with the database faked the way the v1 service suite fakes it.
 *
 * What is proved here is the half v1 cannot have: that one bad id no longer
 * refuses the good ones, that each id is classified by the SAME collectors and
 * in the same precedence v1 applies its sets, and that the single `updateMany`
 * covers the eligible rows that actually move and nothing else. The row lock's
 * own statement is stubbed here, so it is pinned by
 * `batch-write-preconditions.test.ts`, which reads the SQL this service sends
 * alongside v1's.
 *
 * Request order is deliberately not asserted here — it is the route's contract,
 * restored by `orderBatchResults`, and pinned in that helper's own suite.
 */
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  BatchItemFailureStatus,
} from "@repo/api/src/types/batch-mutation-result";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
  statusOptionsForSubtype,
} from "@repo/api/src/types/document";
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

import { documentStatusBatchItemService } from "../document-status-batch-item-service";

const ORG_ID = "00000000-0000-4000-8000-000000000010";
const MISSING_ID = "00000000-0000-4000-8000-000000000011";
const INVALID_AND_STALE_ID = "00000000-0000-4000-8000-000000000012";
const STALE_ID = "00000000-0000-4000-8000-000000000013";
const ALREADY_AT_TARGET_ID = "00000000-0000-4000-8000-000000000014";
const ELIGIBLE_ID = "00000000-0000-4000-8000-000000000015";

const TARGET = IssueStatus.Done;

function makeTx() {
  return {
    $queryRaw: mocks.queryRaw,
    artifact: { updateMany: mocks.artifactUpdateMany },
  };
}

/** The locked read answers in id order, which is never the request order. */
function lockedRows(
  rows: Array<{ id: string; status: string; subtype: string }>
) {
  mocks.queryRaw.mockResolvedValue(
    [...rows].sort((left, right) => left.id.localeCompare(right.id))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  const tx = makeTx();
  mocks.withDb.tx.mockImplementation((handler: (db: typeof tx) => unknown) =>
    handler(tx)
  );
  mocks.artifactUpdateMany.mockResolvedValue({ count: 0 });
});

describe("documentStatusBatchItemService.batchUpdateStatus", () => {
  it("classifies every requested id and writes only the eligible rows that move", async () => {
    lockedRows([
      {
        id: INVALID_AND_STALE_ID,
        status: DocumentStatus.Draft,
        subtype: DocumentType.Prd,
      },
      {
        id: STALE_ID,
        status: IssueStatus.InProgress,
        subtype: DocumentType.Feature,
      },
      {
        id: ALREADY_AT_TARGET_ID,
        status: IssueStatus.Done,
        subtype: DocumentType.Feature,
      },
      {
        id: ELIGIBLE_ID,
        status: IssueStatus.InProgress,
        subtype: DocumentType.Feature,
      },
    ]);

    const result = await documentStatusBatchItemService.batchUpdateStatus(
      [
        ELIGIBLE_ID,
        MISSING_ID,
        INVALID_AND_STALE_ID,
        STALE_ID,
        ALREADY_AT_TARGET_ID,
        ELIGIBLE_ID,
      ],
      TARGET,
      ORG_ID,
      {
        // The row that is BOTH invalid for its subtype and stale: v1 reports
        // its invalid set first, and so must this.
        [INVALID_AND_STALE_ID]: DocumentStatus.Approved,
        [STALE_ID]: IssueStatus.Todo,
      }
    );

    expect([...result.resultsById.keys()].sort()).toEqual(
      [
        MISSING_ID,
        INVALID_AND_STALE_ID,
        STALE_ID,
        ALREADY_AT_TARGET_ID,
        ELIGIBLE_ID,
      ].sort()
    );
    expect(result.resultsById.get(MISSING_ID)).toEqual({
      id: MISSING_ID,
      status: BatchItemFailureStatus.NotFound,
      code: BatchItemFailureCode.ArtifactsNotFound,
      message: expect.any(String),
    });
    expect(result.resultsById.get(INVALID_AND_STALE_ID)).toMatchObject({
      status: BatchItemFailureStatus.BadRequest,
      code: BatchItemFailureCode.InvalidStatusForSubtype,
      details: {
        documentId: INVALID_AND_STALE_ID,
        currentStatus: DocumentStatus.Draft,
        targetStatus: TARGET,
        subtype: DocumentType.Prd,
        allowedStatuses: [...statusOptionsForSubtype(DocumentType.Prd)],
      },
    });
    expect(result.resultsById.get(STALE_ID)).toMatchObject({
      status: BatchItemFailureStatus.Conflict,
      code: BatchItemFailureCode.StaleStatus,
      details: {
        documentId: STALE_ID,
        currentStatus: IssueStatus.InProgress,
        expectedStatus: IssueStatus.Todo,
      },
    });
    expect(result.resultsById.get(ALREADY_AT_TARGET_ID)).toEqual({
      id: ALREADY_AT_TARGET_ID,
      status: BATCH_ITEM_APPLIED_STATUS,
    });
    expect(result.resultsById.get(ELIGIBLE_ID)).toEqual({
      id: ELIGIBLE_ID,
      status: BATCH_ITEM_APPLIED_STATUS,
    });

    expect(result.changedIds).toEqual([ELIGIBLE_ID]);
    expect(result.transitions).toEqual([
      {
        documentId: ELIGIBLE_ID,
        before: IssueStatus.InProgress,
        after: TARGET,
      },
    ]);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith({
      data: { status: TARGET },
      where: {
        id: { in: [ELIGIBLE_ID] },
        organizationId: ORG_ID,
        type: "DOCUMENT",
      },
    });
  });

  it("writes nothing when every applied row already holds the target status", async () => {
    lockedRows([
      {
        id: ALREADY_AT_TARGET_ID,
        status: IssueStatus.Done,
        subtype: DocumentType.Feature,
      },
    ]);

    const result = await documentStatusBatchItemService.batchUpdateStatus(
      [ALREADY_AT_TARGET_ID, MISSING_ID],
      TARGET,
      ORG_ID
    );

    expect(result.resultsById.get(ALREADY_AT_TARGET_ID)).toEqual({
      id: ALREADY_AT_TARGET_ID,
      status: BATCH_ITEM_APPLIED_STATUS,
    });
    expect(result.changedIds).toEqual([]);
    expect(result.transitions).toEqual([]);
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
  });
});

describe("ISS-9486 ruling 2 — a row already at the target is never stale", () => {
  it("applies an item whose stale expectation meets a row that already holds the target", async () => {
    lockedRows([
      {
        id: ALREADY_AT_TARGET_ID,
        status: TARGET,
        subtype: DocumentType.Feature,
      },
      {
        id: STALE_ID,
        status: IssueStatus.InProgress,
        subtype: DocumentType.Feature,
      },
    ]);

    const result = await documentStatusBatchItemService.batchUpdateStatus(
      [ALREADY_AT_TARGET_ID, STALE_ID],
      TARGET,
      ORG_ID,
      {
        [ALREADY_AT_TARGET_ID]: IssueStatus.Todo,
        [STALE_ID]: IssueStatus.Todo,
      }
    );

    expect(result.resultsById.get(ALREADY_AT_TARGET_ID)).toEqual({
      id: ALREADY_AT_TARGET_ID,
      status: BATCH_ITEM_APPLIED_STATUS,
    });
    expect(result.resultsById.get(STALE_ID)).toMatchObject({
      code: BatchItemFailureCode.StaleStatus,
    });
    expect(result.changedIds).toEqual([]);
  });
});
