/**
 * The per-item priority batch behind `POST /documents/batch-update-priority/v2`
 * (ISS-9464).
 *
 * The v1 method's own suite (`__tests__/unit/artifact-bulk-priority-service.test.ts`)
 * drives a fake that evaluates the locked read's bind values, so the org and
 * type predicates are load-bearing there; this one stubs the read and pins what
 * is new: one result per requested id instead of a whole-batch refusal, and a
 * single `updateMany` over the rows that move. That the read is still the
 * canonical lock is pinned by `batch-write-preconditions.test.ts`, which reads
 * the SQL this method sends.
 *
 * Request order is the route's contract, restored by `orderBatchResults` and
 * pinned in that helper's own suite, so it is not asserted here.
 */
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  BatchItemFailureStatus,
} from "@repo/api/src/types/batch-mutation-result";
import { Priority } from "@repo/api/src/types/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  artifactUpdateMany: vi.fn(),
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

import { artifactBulkPriorityService } from "../artifact-bulk-priority-service";

const ORG_ID = "00000000-0000-4000-8000-000000000020";
const MISSING_ID = "00000000-0000-4000-8000-000000000021";
const STALE_ID = "00000000-0000-4000-8000-000000000022";
const ALREADY_AT_TARGET_ID = "00000000-0000-4000-8000-000000000023";
const ELIGIBLE_ID = "00000000-0000-4000-8000-000000000024";
const UNSET_GUARDED_ID = "00000000-0000-4000-8000-000000000025";
const SET_GUARDED_ID = "00000000-0000-4000-8000-000000000026";

const TARGET = Priority.Urgent;

function makeTx() {
  return {
    $queryRaw: mocks.queryRaw,
    artifact: { updateMany: mocks.artifactUpdateMany },
  };
}

/** The locked read answers in id order, which is never the request order. */
function lockedRows(rows: Array<{ id: string; priority: Priority | null }>) {
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

describe("artifactBulkPriorityService.batchUpdatePriorityPerItem", () => {
  it("classifies every requested id and writes only the eligible rows that move", async () => {
    lockedRows([
      { id: STALE_ID, priority: Priority.High },
      { id: ALREADY_AT_TARGET_ID, priority: TARGET },
      { id: ELIGIBLE_ID, priority: Priority.Medium },
    ]);

    const result = await artifactBulkPriorityService.batchUpdatePriorityPerItem(
      [ELIGIBLE_ID, MISSING_ID, STALE_ID, ALREADY_AT_TARGET_ID, ELIGIBLE_ID],
      TARGET,
      ORG_ID,
      { [STALE_ID]: Priority.Low }
    );

    expect([...result.resultsById.keys()].sort()).toEqual(
      [MISSING_ID, STALE_ID, ALREADY_AT_TARGET_ID, ELIGIBLE_ID].sort()
    );
    expect(result.resultsById.get(MISSING_ID)).toEqual({
      id: MISSING_ID,
      status: BatchItemFailureStatus.NotFound,
      code: BatchItemFailureCode.ArtifactsNotFound,
      message: expect.any(String),
    });
    expect(result.resultsById.get(STALE_ID)).toMatchObject({
      status: BatchItemFailureStatus.Conflict,
      code: BatchItemFailureCode.StalePriority,
      details: {
        documentId: STALE_ID,
        currentPriority: Priority.High,
        expectedPriority: Priority.Low,
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
    expect([...result.beforePriorities.entries()]).toEqual([
      [ELIGIBLE_ID, Priority.Medium],
    ]);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith({
      data: { priority: TARGET },
      where: {
        id: { in: [ELIGIBLE_ID] },
        organizationId: ORG_ID,
        type: "DOCUMENT",
      },
    });
  });

  it("treats a null guard as an assertion about the row, not as an absent one", async () => {
    lockedRows([
      { id: UNSET_GUARDED_ID, priority: null },
      { id: SET_GUARDED_ID, priority: Priority.High },
    ]);

    const result = await artifactBulkPriorityService.batchUpdatePriorityPerItem(
      [UNSET_GUARDED_ID, SET_GUARDED_ID],
      TARGET,
      ORG_ID,
      { [UNSET_GUARDED_ID]: null, [SET_GUARDED_ID]: null }
    );

    expect(result.resultsById.get(UNSET_GUARDED_ID)).toEqual({
      id: UNSET_GUARDED_ID,
      status: BATCH_ITEM_APPLIED_STATUS,
    });
    expect(result.resultsById.get(SET_GUARDED_ID)).toMatchObject({
      code: BatchItemFailureCode.StalePriority,
      details: {
        currentPriority: Priority.High,
        expectedPriority: null,
      },
    });
    // unset -> URGENT is a real transition the feed must be able to state.
    expect(result.changedIds).toEqual([UNSET_GUARDED_ID]);
    expect(result.beforePriorities.get(UNSET_GUARDED_ID)).toBeNull();
  });

  it("writes nothing when every applied row already holds the target priority", async () => {
    lockedRows([{ id: ALREADY_AT_TARGET_ID, priority: TARGET }]);

    const result = await artifactBulkPriorityService.batchUpdatePriorityPerItem(
      [ALREADY_AT_TARGET_ID, MISSING_ID],
      TARGET,
      ORG_ID
    );

    expect(result.changedIds).toEqual([]);
    expect(result.beforePriorities.size).toBe(0);
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
  });
});

describe("ISS-9486 ruling 2 — a row already at the target is never stale", () => {
  it("applies an item whose stale expectation meets a row that already holds the target", async () => {
    lockedRows([
      { id: ALREADY_AT_TARGET_ID, priority: TARGET },
      { id: STALE_ID, priority: Priority.High },
    ]);

    const result = await artifactBulkPriorityService.batchUpdatePriorityPerItem(
      [ALREADY_AT_TARGET_ID, STALE_ID],
      TARGET,
      ORG_ID,
      { [ALREADY_AT_TARGET_ID]: Priority.Low, [STALE_ID]: Priority.Low }
    );

    expect(result.resultsById.get(ALREADY_AT_TARGET_ID)).toEqual({
      id: ALREADY_AT_TARGET_ID,
      status: BATCH_ITEM_APPLIED_STATUS,
    });
    expect(result.resultsById.get(STALE_ID)).toMatchObject({
      code: BatchItemFailureCode.StalePriority,
    });
    expect(result.changedIds).toEqual([]);
  });
});
